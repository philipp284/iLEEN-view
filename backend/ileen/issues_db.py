"""
Themen (BCF-Issues) mit Verlauf — in einer SQLite-Datei.

Warum überhaupt eine Datenbank
==============================
Notizen, Tags und Messungen lagen bisher im `localStorage` des Browsers. Das
reicht, solange eine Person an einem Rechner arbeitet, und endet genau dort:
kein zweiter Browser sieht sie, ein geleerter Zwischenspeicher löscht sie, und
„wer hat das wann geändert" lässt sich nicht beantworten.

**Diese Ablage ist ausdrücklich vorläufig.** Die Datenhaltung soll später in
gaeco liegen, angebunden über Kafka. Deshalb ist die Schnittstelle nach außen
schmal und frei von SQL: `anlegen`, `liste`, `holen`, `aendern`, `loeschen`,
`kommentieren`, `ansicht_anlegen`, `zuruecksetzen`, `als_themen`, `aus_themen`.
Wer diese elf Funktionen gegen einen Kafka-Erzeuger und eine gaeco-Abfrage
austauscht, hat die Umstellung hinter sich, ohne einen einzigen Aufrufer
anzufassen. Alles, was SQL kennt, steht in dieser Datei.

Der Verlauf
===========
Jede Schreibhandlung legt eine Version an, und zwar als **vollständiges
Abbild**, nicht als Differenz. Das kostet ein paar Kilobyte je Änderung und
kauft dafür die Eigenschaft, die einen Verlauf erst brauchbar macht: jeder
Stand ist für sich lesbar, ohne die ganze Kette davor abzuspielen. Die
Differenz zum Vorgänger wird trotzdem mitgeschrieben (`aenderung`), weil „was
hat sich geändert" die Frage ist, die man in der Oberfläche stellt.

**Zurücksetzen löscht nichts.** Es schreibt den alten Inhalt als *neue*
Version obendrauf. Ein Verlauf, aus dem man Stände entfernen kann, ist als
Nachweis wertlos — und genau als Nachweis wird er in einem Bauvorhaben
gebraucht.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path

from ileen import bcf

# Der Ort der Datei. Im Container liegt `/data/issues` auf einem Volume (siehe
# docker-compose.yml) — ohne das wäre der Verlauf nach jedem `--build` weg.
DB_PFAD = Path(os.environ.get("ILEEN_ISSUES_DB", "/data/issues/issues.db"))

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS thema (
  guid         TEXT PRIMARY KEY,
  stand        INTEGER NOT NULL DEFAULT 1,
  titel        TEXT NOT NULL,
  beschreibung TEXT    DEFAULT '',
  typ          TEXT    DEFAULT 'Issue',
  status       TEXT    DEFAULT 'Open',
  prioritaet   TEXT    DEFAULT 'Normal',
  autor        TEXT    DEFAULT 'iLEEN',
  bearbeiter   TEXT,
  zugewiesen   TEXT,
  faellig      TEXT,
  marken       TEXT    DEFAULT '[]',
  erstellt     TEXT    NOT NULL,
  geaendert    TEXT    NOT NULL,
  quelle       TEXT    DEFAULT 'viewer',
  geloescht    INTEGER NOT NULL DEFAULT 0,
  daten        TEXT    DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS version (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thema_guid TEXT NOT NULL,
  stand      INTEGER NOT NULL,
  zeit       TEXT NOT NULL,
  autor      TEXT,
  grund      TEXT,
  aenderung  TEXT NOT NULL DEFAULT '{}',
  abbild     TEXT NOT NULL,
  UNIQUE (thema_guid, stand)
);

CREATE TABLE IF NOT EXISTS kommentar (
  guid         TEXT PRIMARY KEY,
  thema_guid   TEXT NOT NULL,
  zeit         TEXT NOT NULL,
  autor        TEXT,
  text         TEXT NOT NULL,
  ansicht_guid TEXT,
  stand        INTEGER,
  geloescht    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ansicht (
  guid        TEXT PRIMARY KEY,
  thema_guid  TEXT NOT NULL,
  zeit        TEXT NOT NULL,
  kamera      TEXT,
  komponenten TEXT DEFAULT '[]',
  bild        BLOB,
  bild_typ    TEXT
);

CREATE INDEX IF NOT EXISTS idx_version_thema   ON version   (thema_guid, stand);
CREATE INDEX IF NOT EXISTS idx_kommentar_thema ON kommentar (thema_guid);
CREATE INDEX IF NOT EXISTS idx_ansicht_thema   ON ansicht   (thema_guid);
CREATE INDEX IF NOT EXISTS idx_thema_status    ON thema     (status, geloescht);
"""

# Felder, die im Verlauf verglichen werden. `daten` ist bewusst dabei: dort
# stehen Ort und getroffenes Bauteil, und deren Änderung ist so berichtenswert
# wie die des Titels.
VERGLEICH = ("titel", "beschreibung", "typ", "status", "prioritaet", "zugewiesen",
             "faellig", "marken", "daten", "geloescht")


# ── Verbindung ───────────────────────────────────────────────────────────────

def verbindung() -> sqlite3.Connection:
    """
    Eine Verbindung je Aufruf, nicht eine je Prozess.

    FastAPI führt synchrone Endpunkte in einem Threadpool aus; eine geteilte
    Verbindung müsste `check_same_thread=False` tragen und wäre damit eine
    Verabredung, die niemand einhält. WAL erlaubt Lesen während des
    Schreibens — bei einer Oberfläche, die im Sekundentakt die Liste holt,
    ist das der Unterschied zwischen flüssig und „database is locked".
    """
    DB_PFAD.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PFAD, timeout=10.0)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def init() -> None:
    with _lock, verbindung() as con:
        con.executescript(SCHEMA)


def _j(wert, standard):
    if wert in (None, ""):
        return standard
    if isinstance(wert, (dict, list)):
        return wert
    try:
        return json.loads(wert)
    except (ValueError, TypeError):
        return standard


def _thema_aus_zeile(z: sqlite3.Row) -> dict:
    return {
        "guid": z["guid"], "stand": z["stand"], "titel": z["titel"],
        "beschreibung": z["beschreibung"] or "", "typ": z["typ"], "status": z["status"],
        "prioritaet": z["prioritaet"], "autor": z["autor"], "bearbeiter": z["bearbeiter"],
        "zugewiesen": z["zugewiesen"], "faellig": z["faellig"],
        "marken": _j(z["marken"], []), "erstellt": z["erstellt"], "geaendert": z["geaendert"],
        "quelle": z["quelle"], "geloescht": bool(z["geloescht"]), "daten": _j(z["daten"], {}),
    }


# ── Lesen ────────────────────────────────────────────────────────────────────

def liste(status=None, typ=None, ifc_guid=None, modell=None, suche=None,
          quelle=None, mit_geloeschten=False, grenze=1000) -> list[dict]:
    """
    Themen, neueste Änderung zuerst.

    `ifc_guid` und `modell` filtern über die Ansichten **und** über `daten`:
    ein Thema kann ein Bauteil über seine BCF-Ansicht betreffen (so kommen
    importierte Pakete) oder über den Anker der Notiz (so entstehen sie im
    Viewer). Wer nach einem Bauteil sucht, meint beides.
    """
    wo, werte = ["1=1"], []
    if not mit_geloeschten:
        wo.append("t.geloescht = 0")
    if status:
        wo.append("t.status = ?"); werte.append(status)
    if typ:
        wo.append("t.typ = ?"); werte.append(typ)
    if quelle:
        wo.append("t.quelle = ?"); werte.append(quelle)
    if suche:
        wo.append("(t.titel LIKE ? OR t.beschreibung LIKE ?)")
        werte += [f"%{suche}%", f"%{suche}%"]
    if ifc_guid:
        wo.append("(t.daten LIKE ? OR EXISTS (SELECT 1 FROM ansicht a "
                  "WHERE a.thema_guid = t.guid AND a.komponenten LIKE ?))")
        werte += [f'%{ifc_guid}%', f'%{ifc_guid}%']
    if modell:
        wo.append("t.daten LIKE ?"); werte.append(f'%{modell}%')

    with verbindung() as con:
        zeilen = con.execute(
            f"SELECT * FROM thema t WHERE {' AND '.join(wo)} "
            f"ORDER BY datetime(t.geaendert) DESC LIMIT ?", (*werte, int(grenze))).fetchall()
        themen = [_thema_aus_zeile(z) for z in zeilen]
        for t in themen:
            t["kommentare"] = _kommentare(con, t["guid"])
            t["ansichten"] = _ansichten(con, t["guid"], mit_bild=False)
    return themen


def holen(guid: str, mit_verlauf: bool = True, mit_bild: bool = False) -> dict | None:
    with verbindung() as con:
        z = con.execute("SELECT * FROM thema WHERE guid = ?", (guid,)).fetchone()
        if not z:
            return None
        t = _thema_aus_zeile(z)
        t["kommentare"] = _kommentare(con, guid)
        t["ansichten"] = _ansichten(con, guid, mit_bild=mit_bild)
        if mit_verlauf:
            t["verlauf"] = [
                {"stand": v["stand"], "zeit": v["zeit"], "autor": v["autor"],
                 "grund": v["grund"], "aenderung": _j(v["aenderung"], {})}
                for v in con.execute(
                    "SELECT stand, zeit, autor, grund, aenderung FROM version "
                    "WHERE thema_guid = ? ORDER BY stand DESC", (guid,)).fetchall()
            ]
    return t


def _kommentare(con, guid) -> list[dict]:
    return [
        {"guid": k["guid"], "zeit": k["zeit"], "autor": k["autor"], "text": k["text"],
         "ansicht_guid": k["ansicht_guid"], "stand": k["stand"]}
        for k in con.execute(
            "SELECT * FROM kommentar WHERE thema_guid = ? AND geloescht = 0 "
            "ORDER BY datetime(zeit)", (guid,)).fetchall()
    ]


def _ansichten(con, guid, mit_bild=False) -> list[dict]:
    zeilen = con.execute("SELECT * FROM ansicht WHERE thema_guid = ? ORDER BY datetime(zeit)",
                         (guid,)).fetchall()
    aus = []
    for a in zeilen:
        eintrag = {"guid": a["guid"], "zeit": a["zeit"], "kamera": _j(a["kamera"], None),
                   "komponenten": _j(a["komponenten"], []),
                   "hat_bild": a["bild"] is not None, "bild_typ": a["bild_typ"]}
        if mit_bild and a["bild"] is not None:
            eintrag["bild"] = a["bild"]
        aus.append(eintrag)
    return aus


def version(guid: str, stand: int) -> dict | None:
    with verbindung() as con:
        v = con.execute("SELECT * FROM version WHERE thema_guid = ? AND stand = ?",
                        (guid, int(stand))).fetchone()
    if not v:
        return None
    return {"stand": v["stand"], "zeit": v["zeit"], "autor": v["autor"], "grund": v["grund"],
            "aenderung": _j(v["aenderung"], {}), "abbild": _j(v["abbild"], {})}


# ── Schreiben ────────────────────────────────────────────────────────────────

def _diff(alt: dict, neu: dict) -> dict:
    aenderung = {}
    for feld in VERGLEICH:
        a, b = alt.get(feld), neu.get(feld)
        if a != b:
            aenderung[feld] = [a, b]
    return aenderung


def _version_schreiben(con, thema: dict, autor: str, grund: str, aenderung: dict) -> None:
    con.execute(
        "INSERT INTO version (thema_guid, stand, zeit, autor, grund, aenderung, abbild) "
        "VALUES (?,?,?,?,?,?,?)",
        (thema["guid"], thema["stand"], thema["geaendert"], autor, grund,
         json.dumps(aenderung, ensure_ascii=False), json.dumps(thema, ensure_ascii=False)))


def anlegen(felder: dict, autor: str = "iLEEN", quelle: str = "viewer") -> dict:
    """
    Ein neues Thema. Eine mitgegebene GUID wird übernommen, sonst vergeben.

    Die GUID darf von außen kommen, weil der Viewer seine Notiz schon kennt,
    bevor das Backend antwortet — und weil ein importiertes BCF-Thema seine
    GUID behalten muss, sonst ist es beim nächsten Import ein zweites Mal da.
    """
    init()
    guid = felder.get("guid") if bcf.ist_guid(felder.get("guid")) else bcf.neue_guid()
    zeit = bcf.jetzt()
    thema = {
        "guid": guid, "stand": 1,
        "titel": (felder.get("titel") or "(ohne Titel)")[:400],
        "beschreibung": felder.get("beschreibung") or "",
        "typ": bcf.in_liste(felder.get("typ"), bcf.TYPEN, "Issue"),
        "status": bcf.in_liste(felder.get("status"), bcf.STATUS, "Open"),
        "prioritaet": bcf.in_liste(felder.get("prioritaet"), bcf.PRIORITAETEN, "Normal"),
        "autor": autor or "iLEEN", "bearbeiter": None,
        "zugewiesen": felder.get("zugewiesen"), "faellig": felder.get("faellig"),
        "marken": felder.get("marken") or [],
        "erstellt": felder.get("erstellt") or zeit, "geaendert": zeit,
        "quelle": quelle, "geloescht": False, "daten": felder.get("daten") or {},
    }

    # Die Prüfung auf eine bekannte GUID steht **vor** dem Sperren: `aendern()`
    # nimmt dieselbe Sperre, und `threading.Lock` ist nicht wiedereintrittsfähig
    # — der Aufruf von dort drinnen hätte den Prozess stehen lassen, nicht
    # abgebrochen. Kein zweiter Datensatz unter derselben GUID: ein erneuter
    # Import desselben Pakets ist eine Änderung, keine Verdopplung.
    with verbindung() as con:
        bekannt = con.execute("SELECT guid FROM thema WHERE guid = ?", (guid,)).fetchone()
    if bekannt:
        return aendern(guid, felder, autor=autor, grund="erneut eingelesen") or {}

    with _lock, verbindung() as con:
        con.execute(
            "INSERT INTO thema (guid, stand, titel, beschreibung, typ, status, prioritaet, "
            "autor, bearbeiter, zugewiesen, faellig, marken, erstellt, geaendert, quelle, "
            "geloescht, daten) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (thema["guid"], 1, thema["titel"], thema["beschreibung"], thema["typ"],
             thema["status"], thema["prioritaet"], thema["autor"], None, thema["zugewiesen"],
             thema["faellig"], json.dumps(thema["marken"], ensure_ascii=False),
             thema["erstellt"], thema["geaendert"], quelle, 0,
             json.dumps(thema["daten"], ensure_ascii=False)))
        _version_schreiben(con, thema, autor, "angelegt", {})

    for a in felder.get("ansichten") or []:
        ansicht_anlegen(guid, a.get("kamera"), a.get("komponenten"), a.get("bild"),
                        a.get("bild_typ"), a.get("guid"))
    for k in felder.get("kommentare") or []:
        kommentieren(guid, k.get("text") or "", k.get("autor") or autor,
                     k.get("ansicht_guid"), k.get("guid"), k.get("zeit"))

    return holen(guid) or thema


AENDERBAR = ("titel", "beschreibung", "typ", "status", "prioritaet", "zugewiesen",
             "faellig", "marken", "daten", "geloescht")


def aendern(guid: str, felder: dict, autor: str = "iLEEN", grund: str | None = None) -> dict | None:
    """
    Felder ändern und den neuen Stand in den Verlauf schreiben.

    Bleibt nichts übrig, was sich wirklich ändert, entsteht **keine** Version.
    Sonst füllte jeder Klick auf „Speichern" den Verlauf mit Ständen, die
    nichts erzählen, und die eine Änderung, die zählt, wäre darin nicht mehr
    zu finden.
    """
    init()
    with _lock, verbindung() as con:
        z = con.execute("SELECT * FROM thema WHERE guid = ?", (guid,)).fetchone()
        if not z:
            return None
        alt = _thema_aus_zeile(z)
        neu = dict(alt)
        for feld in AENDERBAR:
            if feld in felder and felder[feld] is not None:
                neu[feld] = felder[feld]
        neu["titel"] = (neu["titel"] or "(ohne Titel)")[:400]
        neu["typ"] = bcf.in_liste(neu["typ"], bcf.TYPEN, "Issue")
        neu["status"] = bcf.in_liste(neu["status"], bcf.STATUS, "Open")
        neu["prioritaet"] = bcf.in_liste(neu["prioritaet"], bcf.PRIORITAETEN, "Normal")
        neu["geloescht"] = bool(neu["geloescht"])

        aenderung = _diff(alt, neu)
        if not aenderung:
            return alt

        neu["stand"] = alt["stand"] + 1
        neu["geaendert"] = bcf.jetzt()
        neu["bearbeiter"] = autor
        con.execute(
            "UPDATE thema SET stand=?, titel=?, beschreibung=?, typ=?, status=?, prioritaet=?, "
            "bearbeiter=?, zugewiesen=?, faellig=?, marken=?, geaendert=?, geloescht=?, daten=? "
            "WHERE guid=?",
            (neu["stand"], neu["titel"], neu["beschreibung"], neu["typ"], neu["status"],
             neu["prioritaet"], autor, neu["zugewiesen"], neu["faellig"],
             json.dumps(neu["marken"], ensure_ascii=False), neu["geaendert"],
             1 if neu["geloescht"] else 0, json.dumps(neu["daten"], ensure_ascii=False), guid))
        _version_schreiben(con, neu, autor, grund or "geändert", aenderung)

    return holen(guid)


def loeschen(guid: str, autor: str = "iLEEN", endgueltig: bool = False) -> bool:
    """
    Weich löschen — das Thema bleibt samt Verlauf, ist aber aus der Liste weg.

    `endgueltig` gibt es für den einen Fall, in dem weiches Löschen nicht
    genügt: versehentlich importierte Fremdpakete. Dann fällt der Verlauf mit,
    und das ist der Preis dafür, dass er sonst nie lückenhaft ist.
    """
    init()
    if endgueltig:
        with _lock, verbindung() as con:
            con.execute("DELETE FROM version   WHERE thema_guid = ?", (guid,))
            con.execute("DELETE FROM kommentar WHERE thema_guid = ?", (guid,))
            con.execute("DELETE FROM ansicht   WHERE thema_guid = ?", (guid,))
            weg = con.execute("DELETE FROM thema WHERE guid = ?", (guid,)).rowcount
        return weg > 0
    return aendern(guid, {"geloescht": True}, autor=autor, grund="gelöscht") is not None


def zuruecksetzen(guid: str, stand: int, autor: str = "iLEEN") -> dict | None:
    """Einen früheren Stand als neue Version obendrauf schreiben."""
    alt = version(guid, stand)
    if not alt:
        return None
    a = alt["abbild"]
    return aendern(guid, {f: a.get(f) for f in AENDERBAR}, autor=autor,
                   grund=f"zurückgesetzt auf Stand {stand}")


def kommentieren(guid: str, text: str, autor: str = "iLEEN", ansicht_guid: str | None = None,
                 kommentar_guid: str | None = None, zeit: str | None = None) -> dict | None:
    init()
    if not text.strip():
        return None
    with _lock, verbindung() as con:
        z = con.execute("SELECT stand FROM thema WHERE guid = ?", (guid,)).fetchone()
        if not z:
            return None
        k = {"guid": kommentar_guid if bcf.ist_guid(kommentar_guid) else bcf.neue_guid(),
             "zeit": zeit or bcf.jetzt(), "autor": autor or "iLEEN", "text": text,
             "ansicht_guid": ansicht_guid, "stand": z["stand"]}
        con.execute("INSERT OR REPLACE INTO kommentar (guid, thema_guid, zeit, autor, text, "
                    "ansicht_guid, stand, geloescht) VALUES (?,?,?,?,?,?,?,0)",
                    (k["guid"], guid, k["zeit"], k["autor"], k["text"], k["ansicht_guid"], k["stand"]))
        # Ein Kommentar ist eine Änderung am Thema — sonst stünde es in der
        # nach Datum sortierten Liste weit unten, obwohl gerade darüber
        # gesprochen wird.
        con.execute("UPDATE thema SET geaendert = ? WHERE guid = ?", (k["zeit"], guid))
    return k


def ansicht_anlegen(guid: str, kamera=None, komponenten=None, bild: bytes | None = None,
                    bild_typ: str | None = None, ansicht_guid: str | None = None) -> dict | None:
    init()
    with _lock, verbindung() as con:
        if not con.execute("SELECT 1 FROM thema WHERE guid = ?", (guid,)).fetchone():
            return None
        a_guid = ansicht_guid if bcf.ist_guid(ansicht_guid) else bcf.neue_guid()
        zeit = bcf.jetzt()
        con.execute("INSERT OR REPLACE INTO ansicht (guid, thema_guid, zeit, kamera, "
                    "komponenten, bild, bild_typ) VALUES (?,?,?,?,?,?,?)",
                    (a_guid, guid, zeit, json.dumps(kamera, ensure_ascii=False) if kamera else None,
                     json.dumps(komponenten or [], ensure_ascii=False), bild,
                     bild_typ or ("image/png" if bild else None)))
    return {"guid": a_guid, "zeit": zeit, "kamera": kamera, "komponenten": komponenten or [],
            "hat_bild": bild is not None}


def ansicht_bild(guid: str, ansicht_guid: str) -> tuple[bytes, str] | None:
    with verbindung() as con:
        a = con.execute("SELECT bild, bild_typ FROM ansicht WHERE guid = ? AND thema_guid = ?",
                        (ansicht_guid, guid)).fetchone()
    if not a or a["bild"] is None:
        return None
    return a["bild"], a["bild_typ"] or "image/png"


# ── Brücke zu BCF ────────────────────────────────────────────────────────────

def als_themen(guids: list[str] | None = None, **filter_) -> list[dict]:
    """Themen im BCF-Zwischenformat (`ileen.bcf`), samt Bildern."""
    init()
    quelle = [holen(g, mit_verlauf=False, mit_bild=True) for g in guids] if guids \
        else [holen(t["guid"], mit_verlauf=False, mit_bild=True) for t in liste(**filter_)]
    themen = []
    for t in quelle:
        if not t:
            continue
        thema = {k: t.get(k) for k in ("guid", "titel", "beschreibung", "typ", "status",
                                       "prioritaet", "autor", "bearbeiter", "zugewiesen",
                                       "faellig", "marken", "erstellt", "geaendert")}
        thema["kommentare"] = t.get("kommentare") or []
        thema["ansichten"] = t.get("ansichten") or []
        # Der Ort der Notiz gehört ins Paket, nicht nur in unsere Datenbank:
        # ohne ihn ist ein Thema in fremder Software nur Text.
        ort = (t.get("daten") or {}).get("position") or {}
        lat, lon, hoehe = ort.get("lat"), ort.get("lon"), ort.get("height")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            thema["beschreibung"] = (thema.get("beschreibung") or "").rstrip()
            thema["beschreibung"] += (
                f"\n\n[iLEEN] Ort: {lat:.7f}° N, {lon:.7f}° E"
                + (f", H {hoehe:.3f} m" if isinstance(hoehe, (int, float)) else ""))
        themen.append(thema)
    return themen


def aus_themen(themen: list[dict], autor: str = "BCF-Import",
               quelle: str = "bcf-import") -> dict:
    """
    Gelesene BCF-Themen in die Ablage übernehmen.

    Bekannte GUIDs werden geändert statt verdoppelt — so ist ein zweiter
    Import desselben Pakets ein Abgleich und keine zweite Themenliste.
    """
    init()
    neu, aktualisiert = 0, 0
    for thema in themen:
        vorhanden = holen(thema.get("guid", ""), mit_verlauf=False) if thema.get("guid") else None
        felder = {
            "guid": thema.get("guid"), "titel": thema.get("titel"),
            "beschreibung": thema.get("beschreibung"), "typ": thema.get("typ"),
            "status": thema.get("status"), "prioritaet": thema.get("prioritaet"),
            "zugewiesen": thema.get("zugewiesen"), "faellig": thema.get("faellig"),
            "marken": thema.get("marken") or [], "erstellt": thema.get("erstellt"),
            "daten": {"bcf": {"autor": thema.get("autor"),
                              "bearbeiter": thema.get("bearbeiter")}},
        }
        if vorhanden:
            aendern(thema["guid"], felder, autor=autor, grund="aus BCF eingelesen")
            aktualisiert += 1
        else:
            anlegen(felder, autor=thema.get("autor") or autor, quelle=quelle)
            neu += 1

        guid = thema.get("guid")
        vorhandene_kommentare = {k["guid"] for k in (holen(guid, mit_verlauf=False) or {}).get("kommentare", [])}
        for k in thema.get("kommentare") or []:
            if k.get("guid") in vorhandene_kommentare:
                continue
            kommentieren(guid, k.get("text") or "", k.get("autor") or autor,
                         k.get("ansicht_guid"), k.get("guid"), k.get("zeit"))
        for a in thema.get("ansichten") or []:
            ansicht_anlegen(guid, a.get("kamera"), a.get("komponenten"),
                            a.get("bild"), a.get("bild_typ"), a.get("guid"))

    return {"neu": neu, "aktualisiert": aktualisiert, "gesamt": len(themen)}


def paket_bauen(guids: list[str] | None = None, **filter_) -> bytes:
    """Themen → `.bcfzip`."""
    return bcf.paket_schreiben(als_themen(guids, **filter_))


def paket_einlesen(daten: bytes, autor: str = "BCF-Import") -> dict:
    """`.bcfzip` → Themen in der Ablage."""
    return aus_themen(bcf.paket_lesen(daten), autor=autor)


def zahlen() -> dict:
    """Ein Überblick für die Oberfläche: wie viele, welchen Status, welcher Typ."""
    init()
    with verbindung() as con:
        gesamt = con.execute("SELECT COUNT(*) c FROM thema WHERE geloescht = 0").fetchone()["c"]
        nach_status = {z["status"]: z["c"] for z in con.execute(
            "SELECT status, COUNT(*) c FROM thema WHERE geloescht = 0 GROUP BY status")}
        nach_typ = {z["typ"]: z["c"] for z in con.execute(
            "SELECT typ, COUNT(*) c FROM thema WHERE geloescht = 0 GROUP BY typ")}
        versionen = con.execute("SELECT COUNT(*) c FROM version").fetchone()["c"]
        kommentare = con.execute(
            "SELECT COUNT(*) c FROM kommentar WHERE geloescht = 0").fetchone()["c"]
    return {"gesamt": gesamt, "status": nach_status, "typ": nach_typ,
            "versionen": versionen, "kommentare": kommentare, "datei": str(DB_PFAD)}
