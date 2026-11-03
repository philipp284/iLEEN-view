"""
Themenbericht als HTML — eine Datei, die man verschicken oder drucken kann.

Warum HTML und nicht PDF
========================
Ein Bericht über offene Punkte wird gelesen, weitergeleitet und kommentiert,
selten archiviert. HTML kommt ohne Zusatzpakete aus, öffnet sich überall, und
der Druckdialog des Browsers macht daraus ein PDF, wenn wirklich eines
gebraucht wird. Ein `weasyprint` im Container wäre fünfzig Megabyte für einen
Knopf, den man einmal im Monat drückt.

Die Bilder stehen als Data-URI **in** der Datei. Eine Seite, die ihre
Schnappschüsse vom Server nachlädt, ist genau so lange vollständig, wie dieser
Server läuft — als Anlage einer E-Mail wäre sie leer.
"""

from __future__ import annotations

import base64
import html
from datetime import datetime

STATUS_FARBE = {
    "Open": "#E8A33D", "InProgress": "#4DA6FF", "Closed": "#97BF0D", "ReOpened": "#FF6B6B",
}
STATUS_TEXT = {
    "Open": "offen", "InProgress": "in Arbeit", "Closed": "erledigt", "ReOpened": "wieder offen",
}
PRIO_TEXT = {"Low": "niedrig", "Normal": "normal", "High": "hoch", "Critical": "kritisch"}


def _e(text) -> str:
    return html.escape(str(text if text is not None else ""))


def _datum(wert) -> str:
    if not wert:
        return "—"
    try:
        d = datetime.fromisoformat(str(wert).replace("Z", "+00:00"))
        return d.strftime("%d.%m.%Y %H:%M")
    except ValueError:
        return _e(wert)


def _absatz(text: str) -> str:
    """Zeilen und Listenpunkte der Notiz erhalten — mehr Auszeichnung braucht es nicht."""
    zeilen = []
    liste_offen = False
    for roh in (text or "").split("\n"):
        zeile = roh.strip()
        if zeile.startswith(("- ", "* ")):
            if not liste_offen:
                zeilen.append("<ul>")
                liste_offen = True
            zeilen.append(f"<li>{_fett(zeile[2:])}</li>")
            continue
        if liste_offen:
            zeilen.append("</ul>")
            liste_offen = False
        if zeile:
            zeilen.append(f"<p>{_fett(zeile)}</p>")
    if liste_offen:
        zeilen.append("</ul>")
    return "".join(zeilen)


def _fett(text: str) -> str:
    aus = _e(text)
    # **fett** und *kursiv* wie in der Notiz selbst (annotations.js kann dasselbe).
    while "**" in aus:
        aus = aus.replace("**", "<strong>", 1)
        if "**" in aus:
            aus = aus.replace("**", "</strong>", 1)
        else:
            aus += "</strong>"
    return aus


def _bild(ansicht: dict) -> str:
    daten = ansicht.get("bild")
    if not daten:
        return ""
    b64 = base64.b64encode(daten).decode("ascii")
    typ = ansicht.get("bild_typ") or "image/png"
    return f'<img class="bild" src="data:{typ};base64,{b64}" alt="Ansicht">'


def _bauteile(thema: dict) -> str:
    teile = []
    for a in thema.get("ansichten") or []:
        for k in a.get("komponenten") or []:
            if k.get("ifc_guid"):
                teile.append((k["ifc_guid"], k.get("modell") or ""))
    ziel = (thema.get("daten") or {}).get("target") or {}
    if ziel.get("ifcGuid"):
        eigenschaften = ziel.get("featureProps") or {}
        teile.append((ziel["ifcGuid"],
                      " · ".join(str(v) for v in (eigenschaften.get("IfcType"),
                                                  eigenschaften.get("Name")) if v)))
    if not teile:
        return ""
    zeilen = "".join(
        f'<li><code>{_e(g)}</code>{" — " + _e(n) if n else ""}</li>'
        for g, n in dict.fromkeys(teile))
    return f'<div class="block"><h4>Bauteile</h4><ul class="guids">{zeilen}</ul></div>'


def _thema(thema: dict, nummer: int) -> str:
    status = thema.get("status") or "Open"
    farbe = STATUS_FARBE.get(status, "#8A8F98")
    kommentare = thema.get("kommentare") or []
    verlauf = thema.get("verlauf") or []

    kopf = (
        f'<div class="kopf">'
        f'<span class="nr">{nummer}</span>'
        f'<h3>{_e(thema.get("titel"))}</h3>'
        f'<span class="status" style="--f:{farbe}">{_e(STATUS_TEXT.get(status, status))}</span>'
        f'</div>'
    )

    meta = " · ".join(filter(None, [
        _e(thema.get("typ")),
        "Priorität " + _e(PRIO_TEXT.get(thema.get("prioritaet"), thema.get("prioritaet"))),
        "angelegt " + _datum(thema.get("erstellt")) + " von " + _e(thema.get("autor")),
        ("zugewiesen an " + _e(thema["zugewiesen"])) if thema.get("zugewiesen") else "",
        ("fällig " + _datum(thema["faellig"])) if thema.get("faellig") else "",
        f'Stand {thema.get("stand", 1)}',
    ]))

    teile = [kopf, f'<div class="meta">{meta}</div>']
    if thema.get("beschreibung"):
        teile.append(f'<div class="block body">{_absatz(thema["beschreibung"])}</div>')
    teile.append(_bauteile(thema))

    for a in thema.get("ansichten") or []:
        bild = _bild(a)
        if bild:
            teile.append(f'<div class="block">{bild}</div>')

    if kommentare:
        zeilen = "".join(
            f'<div class="kommentar"><b>{_e(k.get("autor"))}</b> '
            f'<span class="zeit">{_datum(k.get("zeit"))}</span>'
            f'<div>{_absatz(k.get("text"))}</div></div>' for k in kommentare)
        teile.append(f'<div class="block"><h4>Kommentare ({len(kommentare)})</h4>{zeilen}</div>')

    if verlauf:
        zeilen = "".join(
            f'<tr><td>{v.get("stand")}</td><td>{_datum(v.get("zeit"))}</td>'
            f'<td>{_e(v.get("autor"))}</td><td>{_e(v.get("grund"))}</td>'
            f'<td>{_e(", ".join((v.get("aenderung") or {}).keys()) or "—")}</td></tr>'
            for v in verlauf)
        teile.append(
            '<details class="block"><summary>Verlauf ('
            f'{len(verlauf)} Stände)</summary>'
            '<table class="verlauf"><thead><tr><th>Stand</th><th>Zeit</th><th>Wer</th>'
            f'<th>Anlass</th><th>Felder</th></tr></thead><tbody>{zeilen}</tbody></table></details>')

    return f'<article class="thema" style="--f:{farbe}">' + "".join(teile) + "</article>"


CSS = """
:root { color-scheme: light dark;
  --bg:#FFFFFF; --fg:#16181A; --dim:#6B7076; --linie:#E3E6E8; --karte:#FBFCFC; --gruen:#7A9A0A; }
@media (prefers-color-scheme: dark) { :root {
  --bg:#0E1113; --fg:#E8EBED; --dim:#9AA0A6; --linie:#23282B; --karte:#161A1D; --gruen:#97BF0D; } }
* { box-sizing: border-box; }
body { margin:0; padding:32px 24px 64px; background:var(--bg); color:var(--fg);
  font:15px/1.55 "Inter", system-ui, -apple-system, sans-serif; }
.blatt { max-width: 900px; margin: 0 auto; }
h1 { font-size:26px; margin:0 0 4px; letter-spacing:-.01em; }
h3 { font-size:17px; margin:0; font-weight:600; }
h4 { font-size:12px; margin:0 0 6px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
.unter { color:var(--dim); margin:0 0 24px; font-size:13px; }
.zahlen { display:flex; flex-wrap:wrap; gap:10px; margin:0 0 28px; padding:0; list-style:none; }
.zahlen li { border:1px solid var(--linie); border-radius:10px; padding:10px 14px; background:var(--karte); }
.zahlen b { display:block; font-size:22px; line-height:1.1; }
.zahlen span { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; }
.thema { border:1px solid var(--linie); border-left:3px solid var(--f,var(--gruen));
  border-radius:10px; padding:16px 18px; margin:0 0 14px; background:var(--karte);
  break-inside: avoid; }
.kopf { display:flex; align-items:baseline; gap:10px; }
.nr { color:var(--dim); font-variant-numeric:tabular-nums; font-size:13px; min-width:2.2em; }
.status { margin-left:auto; font-size:11px; padding:3px 9px; border-radius:99px;
  background:color-mix(in srgb, var(--f) 18%, transparent); color:var(--f); white-space:nowrap; }
.meta { color:var(--dim); font-size:12px; margin:6px 0 0; }
.block { margin-top:12px; }
.body p { margin:0 0 6px; } .body ul { margin:0; padding-left:18px; }
.guids { margin:0; padding-left:18px; font-size:13px; }
code { font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--dim); }
.bild { width:100%; border-radius:8px; border:1px solid var(--linie); display:block; }
.kommentar { border-top:1px solid var(--linie); padding:8px 0 0; margin-top:8px; font-size:14px; }
.kommentar .zeit { color:var(--dim); font-size:12px; margin-left:6px; }
.kommentar p { margin:4px 0 0; }
.verlauf { width:100%; border-collapse:collapse; font-size:12px; margin-top:8px; }
.verlauf th { text-align:left; color:var(--dim); font-weight:500; padding:4px 8px 4px 0; }
.verlauf td { padding:4px 8px 4px 0; border-top:1px solid var(--linie); }
summary { cursor:pointer; color:var(--dim); font-size:12px; }
footer { color:var(--dim); font-size:12px; margin-top:32px; border-top:1px solid var(--linie); padding-top:12px; }
@media print { body { padding:0; } .thema { break-inside:avoid; } summary { display:none; } }
"""


def html_bericht(themen: list[dict], titel: str = "Themen", hinweis: str = "") -> str:
    """Der ganze Bericht als eine Zeichenkette."""
    nach_status: dict[str, int] = {}
    for t in themen:
        nach_status[t.get("status") or "Open"] = nach_status.get(t.get("status") or "Open", 0) + 1

    zahlen = "".join(
        f'<li><b>{anzahl}</b><span>{_e(STATUS_TEXT.get(status, status))}</span></li>'
        for status, anzahl in sorted(nach_status.items()))
    zahlen = f'<li><b>{len(themen)}</b><span>Themen</span></li>' + zahlen

    koerper = "".join(_thema(t, i + 1) for i, t in enumerate(themen)) or \
        '<p class="unter">Keine Themen, die zum Filter passen.</p>'

    return (
        "<!doctype html>\n<html lang=\"de\">\n<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{_e(titel)}</title>\n<style>{CSS}</style>\n</head>\n<body>\n"
        f'<div class="blatt">\n<h1>{_e(titel)}</h1>\n'
        f'<p class="unter">Stand {_datum(datetime.now().isoformat())}'
        f'{" · " + _e(hinweis) if hinweis else ""}</p>\n'
        f'<ul class="zahlen">{zahlen}</ul>\n{koerper}\n'
        '<footer>iLEEN — Tragwerkslabor / BIM-Labor, Hochschule Mainz. '
        'Themen nach BCF 2.1; der Verlauf je Thema steht ausgeklappt in der Datei.</footer>\n'
        "</div>\n</body>\n</html>\n"
    )
