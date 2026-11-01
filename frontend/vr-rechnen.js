// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Die Rechnungen der VR-Seite (vr.js), ohne three.js und ohne Browser.
//
// Was hier steht, entscheidet über das Gefühl in der Brille: wie weit man vom
// Gebäude entfernt anfängt, worauf man springen darf, wie groß das Tischmodell
// wird, wann ein Stick als „gedrückt" gilt. Es steht für sich, damit der
// Prüfstein tests/vr/test-vr-rechnen.mjs es ohne Brille nachrechnen kann.

// Wie ein Bauteil heißt, wenn die Batch Table nur den IFC-Typ kennt. Bewusst
// kurz: auf einer Tafel in der Hand ist Platz für ein Wort.
const IFC_NAMEN = {
  ifcwall: 'Wand', ifcwallstandardcase: 'Wand', ifccurtainwall: 'Vorhangfassade',
  ifcslab: 'Decke', ifcroof: 'Dach', ifcbeam: 'Träger', ifccolumn: 'Stütze',
  ifcmember: 'Stab', ifcplate: 'Platte', ifcfooting: 'Fundament', ifcpile: 'Pfahl',
  ifcdoor: 'Tür', ifcwindow: 'Fenster', ifcstair: 'Treppe', ifcstairflight: 'Treppenlauf',
  ifcramp: 'Rampe', ifcrampflight: 'Rampenlauf', ifcrailing: 'Geländer',
  ifccovering: 'Bekleidung', ifcspace: 'Raum', ifcopeningelement: 'Öffnung',
  ifcbuildingelementproxy: 'Bauteil', ifcfurnishingelement: 'Einrichtung',
  ifcfurniture: 'Möbel', ifcductsegment: 'Kanal', ifcductfitting: 'Kanalformteil',
  ifcpipesegment: 'Rohr', ifcpipefitting: 'Rohrformteil', ifcflowterminal: 'Auslass',
  ifcairterminal: 'Luftauslass', ifcflowsegment: 'Leitung', ifcflowfitting: 'Formteil',
  ifccablecarriersegment: 'Kabeltrasse', ifclightfixture: 'Leuchte',
  ifcsanitaryterminal: 'Sanitärobjekt', ifcreinforcingbar: 'Bewehrung',
  ifcsite: 'Gelände', ifcgeographicelement: 'Gelände',
};

/** Inhalte, die die Brille zeigen kann. Splats gehen über Spark (vr-splat.js),
 *  weil `3d-tiles-renderer` `KHR_gaussian_splatting` nicht kennt. */
export const VR_FAEHIG = new Set(['ifc', 'mesh', 'pointcloud', 'splat']);

const LOKAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Die Adresse des Backends, wie die Brille sie braucht.
 *
 * `config.js` sagt `http://localhost:8100`. Am Mac und über `adb reverse` ist
 * das richtig. Öffnet die Brille die Seite dagegen über das WLAN, wäre
 * `localhost` die Brille selbst:
 *
 *   https://192.168.0.9:5443  (tools/quest-wlan.sh) → https://192.168.0.9:5443/backend
 *       Eine HTTPS-Seite darf nichts über http laden (Mixed Content). Der
 *       Dev-Server reicht /backend an localhost:8100 durch
 *       (tools/vite-quest.config.js).
 *   http://192.168.0.9:5181   → http://192.168.0.9:8100
 *       Der Rechner, von dem die Seite kam.
 *
 * `seite` = { host, protokoll, ursprung } aus `location`.
 */
export function backendBasis(gespeichert, konfiguriert, seite = {}) {
  const { host, protokoll, ursprung } = seite;
  const roh = String(gespeichert || konfiguriert || '').trim().replace(/\/+$/, '');
  if (!roh) return '';
  let url;
  try { url = new URL(roh); } catch { return roh; }
  if (LOKAL.has(url.hostname) && host && !LOKAL.has(host)) {
    if (protokoll === 'https:' && url.protocol === 'http:' && ursprung) return `${ursprung}/backend`;
    url.hostname = host;
  }
  return url.toString().replace(/\/+$/, '');
}

/** Wo man im 1:1-Modus anfängt: vor der Südseite, mit Blick nach Norden auf
 *  das Gebäude. Der Abstand wächst mit dem Bauwerk, damit man es ganz sieht,
 *  bleibt aber begehbar. */
export function startAbstand(breite, tiefe) {
  const groesste = Math.max(Number(breite) || 0, Number(tiefe) || 0);
  return Math.min(80, Math.max(4, 0.6 * groesste));
}

/** Maßstab des Tischmodells: die längste Seite wird `ziel` Meter lang. */
export function tischMassstab(breite, hoehe, tiefe, ziel = 0.7) {
  const groesste = Math.max(Number(breite) || 0, Number(hoehe) || 0, Number(tiefe) || 0);
  if (!(groesste > 0)) return 1;
  return Math.min(1, Math.max(1 / 5000, ziel / groesste));
}

/** Auf eine Fläche springt man, wenn sie nach oben zeigt — Decken, Treppen,
 *  Gelände. Wände und Untersichten sind keine Landeplätze. */
export function begehbar(normaleY) {
  return Number(normaleY) > 0.7;
}

/** Punktwolken haben keine Flächennormale. Dort gilt: was deutlich unter dem
 *  Kopf liegt, ist Boden — wer auf eine Wand in Augenhöhe zeigt, will nicht
 *  in die Wand springen. */
export function punktBegehbar(punktY, kopfY) {
  return Number(punktY) < Number(kopfY) - 0.8;
}

/** Stickwert mit Totzone: kleine Ausschläge aus dem Ruhezustand des Sticks
 *  bewegen nichts, darüber wird linear auf 0…1 gestreckt. */
export function totzone(wert, schwelle = 0.15) {
  const v = Number(wert) || 0;
  const betrag = Math.abs(v);
  if (betrag <= schwelle) return 0;
  return Math.sign(v) * Math.min(1, (betrag - schwelle) / (1 - schwelle));
}

/**
 * Drehen in festen Schritten statt stufenlos — stufenloses Drehen ist das,
 * was in der Brille am schnellsten übel macht.
 *
 * Ein Schritt pro Ausschlag: erst wenn der Stick wieder fast in der Mitte war,
 * ist der nächste Schritt „gespannt". Liefert den Drehwinkel (Bogenmaß,
 * positiv = nach links) und den neuen Spannzustand.
 */
export function schrittDrehung(x, gespannt, schritt = Math.PI / 6) {
  const v = Number(x) || 0;
  if (gespannt && Math.abs(v) > 0.7) return { winkel: -Math.sign(v) * schritt, gespannt: false };
  if (!gespannt && Math.abs(v) < 0.3) return { winkel: 0, gespannt: true };
  return { winkel: 0, gespannt };
}

/**
 * Das schwebende Tablet (Brille ohne Controller) folgt dem Blick erst, wenn
 * man sich weiter als `ab` (Bogenmaß) weggedreht hat — dann weich, bis es
 * wieder vorn steht. Sonst liefe es jedem Blick nach und man käme nie daran
 * vorbei. `stand` = { gier, folgt }, Rückgabe ebenso.
 */
export function schwebeFolgen(stand, ziel, dt, ab = 0.8, zeit = 0.35) {
  const voll = 2 * Math.PI;
  const d = ((((ziel - stand.gier + Math.PI) % voll) + voll) % voll) - Math.PI;
  if (!stand.folgt && Math.abs(d) <= ab) return { gier: stand.gier, folgt: false };
  const gier = stand.gier + d * Math.min(1, Math.max(0, dt) / zeit);
  return { gier, folgt: Math.abs(d) > 0.03 };
}

function feld(daten, ...namen) {
  if (!daten) return '';
  const schluessel = Object.keys(daten);
  for (const name of namen) {
    const k = schluessel.find(s => s.toLowerCase() === name.toLowerCase());
    if (k !== undefined && daten[k] !== null && daten[k] !== undefined && String(daten[k]).trim() !== '') {
      return String(daten[k]).trim();
    }
  }
  return '';
}

/**
 * Was die Tafel über ein Bauteil sagt, aus einer Zeile der Batch Table.
 *
 * Das Backend schreibt `GlobalId`, `IfcType`, `Name`, `Geschoss`
 * (backend/tiling/formats/ifc.py → `_batch_table`). Ion-Kacheln und fremde
 * Tilesets heißen anders (`className`, `IfcEntity`) — deshalb ohne Rücksicht
 * auf Groß- und Kleinschreibung und mit Ausweichnamen.
 */
export function bauteilZeilen(daten) {
  const typ = feld(daten, 'IfcType', 'className', 'IfcEntity', 'IfcClass', 'type');
  const name = feld(daten, 'Name', 'LongName', 'name');
  const geschoss = feld(daten, 'Geschoss', 'Storey', 'BuildingStorey', 'Level');
  const guid = feld(daten, 'GlobalId', 'GUID', 'globalId');
  const deutsch = IFC_NAMEN[typ.toLowerCase()] || '';
  return {
    titel: deutsch || typ || 'Bauteil',
    typ,
    name,
    geschoss,
    guid,
  };
}

/** Deutscher Kurzname einer IFC-Klasse für Listen und Tafeln. */
export function ifcName(typ) {
  const t = String(typ || '');
  return IFC_NAMEN[t.toLowerCase()] || t || 'ohne Typ';
}

// ─────────────────────────────────────────────────────────────────
// EBENEN — welche Bauteile zu sehen sind
// ─────────────────────────────────────────────────────────────────

/** Ein leerer Filter: alles sichtbar. `nur` ist null oder die Menge der
 *  GlobalIds, die allein stehen bleiben (Isolieren). */
export function filterNeu() {
  return { klassen: new Set(), geschosse: new Set(), guids: new Set(), nur: null };
}

export function filterLeer(f) {
  return !f.nur && !f.klassen.size && !f.geschosse.size && !f.guids.size;
}

/** `b` = { typ, geschoss, guid } aus der Batch Table. Isolieren schlägt alles:
 *  ein isoliertes Bauteil bleibt sichtbar, auch wenn seine Klasse aus ist —
 *  sonst wäre „nur dieses“ oft ein leeres Bild. */
export function bauteilSichtbar(b, f) {
  if (f.nur) return f.nur.has(b.guid);
  if (b.guid && f.guids.has(b.guid)) return false;
  if (f.klassen.has(b.typ || '')) return false;
  if (f.geschosse.has(b.geschoss || '')) return false;
  return true;
}

/**
 * Wo ein Geschoss in der Reihe steht — Namen sind frei vergeben („UG“,
 * „1. OG“, „Halle EG“, „Level 2“, „Dach“). Unten zuerst; was sich nicht
 * deuten lässt, kommt ans Ende und dort nach dem Alphabet.
 */
export function geschossRang(name) {
  const n = String(name || '').toLowerCase();
  if (!n.trim()) return 1000;
  let m;
  if ((m = n.match(/(\d+)\s*\.?\s*(ug|untergeschoss|kg|kellergeschoss)\b/))) return -Number(m[1]);
  if ((m = n.match(/\b(ug|u)\s*-?\s*(\d+)\b/))) return -Number(m[2]);
  if (/\b(ug|untergeschoss|keller|kellergeschoss|kg|basement|tiefgarage|tg)\b/.test(n)) return -1;
  if (/\b(eg|erdgeschoss|ground|gf|00)\b/.test(n)) return 0;
  if ((m = n.match(/(\d+)\s*\.?\s*(og|obergeschoss)\b/))) return Number(m[1]);
  if ((m = n.match(/\b(og|obergeschoss|level|ebene|etage|geschoss|floor|storey)\s*-?\s*(-?\d+)\b/))) return Number(m[2]);
  if (/\b(og|obergeschoss)\b/.test(n)) return 1;
  if (/\b(dg|dach|roof|attika)/.test(n)) return 100;
  if ((m = n.match(/^\s*(-?\d+)\b/))) return Number(m[1]);
  return 500;
}

export function geschosseSortieren(namen) {
  return [...namen].sort((a, b) => geschossRang(a) - geschossRang(b) || String(a).localeCompare(String(b), 'de'));
}

// ─────────────────────────────────────────────────────────────────
// EIGENSCHAFTEN — Property-Sets aus dem Backend für das Tablet
// ─────────────────────────────────────────────────────────────────

/** Ein Wert, wie er auf dem Tablet steht. */
export function wertText(v) {
  if (v === null || v === undefined || v === '') return '–';
  if (v === true) return 'ja';
  if (v === false) return 'nein';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    return Number.isInteger(v) ? String(v) : v.toLocaleString('de-DE', { maximumFractionDigits: 4 });
  }
  if (Array.isArray(v)) return v.map(wertText).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim() || '–';
}

// Verwaltungsfelder einer IfcComplexProperty, die niemand lesen will
const KOMPLEX_INTERN = new Set(['id', 'type']);

function flach(objekt, vorsatz, zeilen) {
  for (const [k, v] of Object.entries(objekt || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const komplex = v.type === 'IfcComplexProperty' || (v.properties && typeof v.properties === 'object');
      if (komplex) {
        for (const [kk, vv] of Object.entries(v)) {
          if (KOMPLEX_INTERN.has(kk) || kk === 'properties') continue;
          if (kk === 'UsageName' && vv === k) continue;
          zeilen.push([`${vorsatz}${k} › ${kk}`, wertText(vv)]);
        }
        flach(v.properties, `${vorsatz}${k} › `, zeilen);
      } else {
        flach(v, `${vorsatz}${k} › `, zeilen);
      }
    } else {
      zeilen.push([`${vorsatz}${k}`, wertText(v)]);
    }
  }
  return zeilen;
}

function psetRang(name) {
  if (/^Pset_.*Common$/i.test(name)) return 0;
  if (/^Pset_/i.test(name)) return 1;
  if (/^Qto_/i.test(name)) return 2;
  if (/^(ArchiCADProperties|AC_Pset|Revit|Allplan|Identity Data|Other)/i.test(name)) return 4;
  return 3;
}

/**
 * Aus `GET /assets/{job}/elements/{guid}` eine Liste von Gruppen für das
 * Tablet: zuerst die Kopfdaten, dann die Property-Sets — die genormten
 * (`Pset_…Common`) vorn, Mengen danach, Herstellerlisten am Ende.
 * Verschachtelte Werte (IfcComplexProperty) werden zu „Teil › Name“.
 */
export function eigenschaftsGruppen(element) {
  if (!element) return [];
  const gruppen = [];
  const kopf = [];
  if (element.object_type) kopf.push(['Objekttyp', wertText(element.object_type)]);
  if (element.description) kopf.push(['Beschreibung', wertText(element.description)]);
  if (kopf.length) gruppen.push({ titel: 'Bauteil', zeilen: kopf });
  const psets = Object.entries(element.psets || {})
    .map(([name, inhalt], i) => ({ name, inhalt, i }))
    .sort((a, b) => psetRang(a.name) - psetRang(b.name) || a.i - b.i);
  for (const { name, inhalt } of psets) {
    const zeilen = (inhalt && typeof inhalt === 'object') ? flach(inhalt, '', []) : [['Wert', wertText(inhalt)]];
    if (zeilen.length) gruppen.push({ titel: name, zeilen });
  }
  return gruppen;
}

// ─────────────────────────────────────────────────────────────────
// MESSEN, BODEN, GRUNDRISS
// ─────────────────────────────────────────────────────────────────

/** Meter mit Komma, kurz: unter 100 m auf Zentimeter. */
export function meterText(m) {
  const v = Number(m) || 0;
  const stellen = Math.abs(v) < 100 ? 2 : 1;
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen })} m`;
}

/** Strecke zwischen zwei Punkten im lokalen Rahmen (y oben, Meter). */
export function messung(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return { abstand: Math.hypot(dx, dy, dz), waagerecht: Math.hypot(dx, dz), hoehe: dy };
}

/** Höchste Stufe, die man beim Gehen hinaufsteigt — Treppenstufe ja, Tisch nein. */
export const STUFE = 0.5;

/**
 * Die Füße beim Gehen dem Boden nachführen. `bodenY` ist der Boden unter dem
 * Kopf (oder null). Hinauf nur bis STUFE und sofort, hinab weich mit
 * `fallTempo` m/s — wer von einer Kante tritt, soll nicht springen.
 */
export function bodenNachfuehren(fussY, bodenY, dt, fallTempo = 8) {
  if (bodenY === null || bodenY === undefined || !Number.isFinite(bodenY)) return fussY;
  if (bodenY > fussY + STUFE) return fussY;
  if (bodenY >= fussY) return bodenY;
  return Math.max(bodenY, fussY - fallTempo * dt);
}

/**
 * Durch die Luft ziehen (Brille ohne Sticks): die kneifende Hand greift die
 * Welt. Zieht sie sich etwas zu, geht man selbst in die Gegenrichtung — ein
 * Stück Hand ist `weite` Stücke Weg. `von`, `nach` sind die Lagen der Finger
 * im Rahmen des Nutzers (m), `zug` = { h, v } der bisher gezogene Weg.
 *
 * Waagerecht ziehen heißt gehen: die Höhe bleibt dem Boden überlassen. Wer
 * überwiegend senkrecht zieht (mehr als `senkrechtAb` m und mehr hoch als
 * quer), will fliegen — von da an gilt die volle Richtung, bis er landet.
 * Ein Tracking-Sprung (> `sprung` m in einem Bild) wird nicht mitgezogen.
 *
 * Rückgabe: `schritt` (im Rahmen des Nutzers), neuer `zug`, `schwebt`.
 */
export function flugSchritt(zug, von, nach, { weite = 6, frei = false, bodenFolgen = true, sprung = 0.4, senkrechtAb = 0.3 } = {}) {
  const d = [von[0] - nach[0], von[1] - nach[1], von[2] - nach[2]];
  if (Math.hypot(d[0], d[1], d[2]) > sprung) return { schritt: [0, 0, 0], zug, schwebt: frei };
  const h = zug.h + Math.hypot(d[0], d[2]) * weite;
  const v = zug.v + Math.abs(d[1]) * weite;
  const schwebt = frei || !bodenFolgen || (v > h && v > senkrechtAb);
  return {
    schritt: [d[0] * weite, schwebt ? d[1] * weite : 0, d[2] * weite],
    zug: { h, v },
    schwebt: frei || (bodenFolgen && schwebt),
  };
}

/**
 * Der Grundriss des Modells als gedrehtes Rechteck in x/z — aus den acht
 * Ecken seines Kastens und dessen Achsen (orientierte Box des Tilesets).
 * Gedreht, weil ein Gebäude schräg zur Nordrichtung sonst einen viel zu
 * großen Kasten bekäme. Die Achse, die am meisten nach oben zeigt, zählt
 * nicht; die nächste gibt die Richtung des Rechtecks.
 *
 * @returns { cx, cz, ux, uz, a, b } Mitte, Einheitsrichtung u, halbe Seiten a (u) und b (v ⟂ u)
 */
export function fussRechteck(ecken, achsen) {
  const cx = ecken.reduce((s, p) => s + p[0], 0) / ecken.length;
  const cz = ecken.reduce((s, p) => s + p[2], 0) / ecken.length;
  let ux = 1;
  let uz = 0;
  const liegend = (achsen || [])
    .map(a => ({ a, waag: Math.hypot(a[0], a[2]) }))
    .filter(e => e.waag > 1e-6)
    .sort((p, q) => q.waag - p.waag);
  if (liegend.length && liegend[0].waag > 0.7) {
    ux = liegend[0].a[0] / liegend[0].waag;
    uz = liegend[0].a[2] / liegend[0].waag;
  }
  let a = 0;
  let b = 0;
  for (const p of ecken) {
    const dx = p[0] - cx;
    const dz = p[2] - cz;
    a = Math.max(a, Math.abs(dx * ux + dz * uz));
    b = Math.max(b, Math.abs(-dx * uz + dz * ux));
  }
  return { cx, cz, ux, uz, a, b };
}

export function imFuss(f, x, z, rand = 0) {
  if (!f) return false;
  const dx = x - f.cx;
  const dz = z - f.cz;
  return Math.abs(dx * f.ux + dz * f.uz) <= f.a + rand && Math.abs(-dx * f.uz + dz * f.ux) <= f.b + rand;
}

// ─────────────────────────────────────────────────────────────────
// WELT — Kartenquellen und Kachelrechnung (Web Mercator)
// ─────────────────────────────────────────────────────────────────

const JAHR = new Date().getFullYear();

/**
 * Amtliche Orthophotos (20 cm) der Länder, frei und mit CORS — dieselbe Liste
 * wie `kartenquellen.js → DOP_LAENDER` (dort für Cesium). Eine neue Quelle
 * gehört in beide; test-vr-rechnen.mjs vergleicht sie. Rechtecke in Grad
 * (West, Süd, Ost, Nord); außerhalb der Landesfläche kommt das Bild
 * transparent, darunter scheint Sentinel-2 durch.
 */
export const DOP_LAENDER = [
  { id: 'rp', land: 'Rheinland-Pfalz', url: 'https://geo4.service24.rlp.de/wms/rp_dop20.fcgi',
    layers: 'rp_dop20', format: 'image/vnd.jpeg-png', rechteck: [6.10, 48.95, 8.52, 50.96],
    credit: `Luftbild RLP: ©GeoBasis-DE / LVermGeoRP ${JAHR}, dl-de/by-2-0, www.lvermgeo.rlp.de` },
  { id: 'he', land: 'Hessen', url: 'https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows',
    layers: 'he_dop_rgb', format: 'image/vnd.jpeg-png', rechteck: [7.76, 49.38, 10.25, 51.67],
    credit: 'Luftbild Hessen: © HVBG' },
  { id: 'nw', land: 'Nordrhein-Westfalen', url: 'https://www.wms.nrw.de/geobasis/wms_nw_dop',
    layers: 'nw_dop_rgb', format: 'image/png', rechteck: [5.85, 50.31, 9.47, 52.54],
    credit: 'Luftbild NRW: © Geobasis NRW, dl-de/zero-2-0' },
  { id: 'by', land: 'Bayern', url: 'https://geoservices.bayern.de/od/wms/dop/v1/dop20',
    layers: 'by_dop20c', format: 'image/vnd.jpeg-png', rechteck: [8.96, 47.26, 13.85, 50.57],
    credit: 'Luftbild Bayern: © Bayerische Vermessungsverwaltung, www.geodaten.bayern.de, CC BY 4.0' },
  { id: 'sl', land: 'Saarland', url: 'https://geoportal.saarland.de/freewms/dop',
    layers: 'sl_dop', format: 'image/vnd.jpeg-png', rechteck: [6.34, 49.10, 7.42, 49.65],
    credit: 'Luftbild Saarland: © LVGL Saarland' },
];

/** Darunter (Kacheln über ~20 km) holt niemand ein 20-cm-Bild ganzer Länder. */
export const DOP_AB_ZOOM = 11;

const SENTINEL = {
  id: 'sentinel', art: 'xyz', maxZoom: 14,
  url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
  credit: 'Sentinel-2 cloudless – s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)',
};
const OSM = {
  id: 'osm', art: 'xyz', maxZoom: 19,
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  credit: '© OpenStreetMap-Mitwirkende (ODbL)',
};
const BASEMAP_DE = {
  id: 'basemapde', art: 'xyz', maxZoom: 18, rechteck: [5.5, 47.0, 15.6, 55.2],
  url: 'https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR/{z}/{y}/{x}.png',
  credit: `© basemap.de / BKG ${JAHR} | Datenquellen: © GeoBasis-DE`,
};

/** Was auf dem Gelände liegt, Schicht für Schicht von unten nach oben. */
export const KARTEN = {
  luftbild: { name: 'Luftbild', schichten: [SENTINEL, ...DOP_LAENDER.map(l => ({ ...l, art: 'wms', abZoom: DOP_AB_ZOOM, maxZoom: 20 }))] },
  karte: { name: 'Karte', schichten: [OSM, BASEMAP_DE] },
  osm: { name: 'OSM', schichten: [OSM] },
};

/**
 * Höhen. Beide Quellen liefern Meter über dem Meer (gemessen 2026-10-21:
 * Feldberg/Taunus 878,7 m, Mainzer Rheinufer 84,6 m) — die Modelle stehen
 * auf dem Ellipsoid, also kommt die Geoidundulation dazu wie in gelaende.js.
 * Mapterhorn führt in Deutschland die DGM der Länder (Meter-Raster), Terrain
 * Tiles nur 30 m (am Rheinufer 94 m statt 85 m).
 */
export const GELAENDE = {
  mapterhorn: {
    url: 'https://terrain.reearth.land/mapterhorn-egm08/mapbox/elevation/{z}/{x}/{y}.png',
    kodierung: 'terrain-rgb', kachel: 512, maxZoom: 14,
    credit: 'Gelände: Mapterhorn (mapterhorn.com, Quellen dort), bereitgestellt von Re:Earth',
  },
  terrarium: {
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    kodierung: 'terrarium', kachel: 256, maxZoom: 15,
    credit: 'Gelände: Terrain Tiles (Mapzen/Tilezen, AWS Open Data)',
  },
};

/** basemap.de 3D LoD2 „Höhe DGM5“ — NHN wie das Gelände, siehe kartenquellen.js. */
export const LOD2 = {
  url: 'https://sgx.geodatenzentrum.de/gdz_basemapde_3d_gebaeude/lod2_4326_dgm5.json',
  rechteck: [5.5, 47.0, 15.6, 55.2],
  credit: `3D-Gebäude: © GeoBasis-DE/BKG ${JAHR} (basemap.de 3D, verändert: Höhen auf das WGS84-Ellipsoid umgerechnet)`,
};

/**
 * So weit um den Standort reichen die LoD2-Zellen, die der Durchlauf überhaupt besucht (Meter).
 * Gebäude sind ab einigen Kilometern unter einer Handvoll Bildpunkten und im Dunst
 * (SICHT.dunstVon 2,5 km); weiter draußen wäre es Rechenzeit für nichts.
 */
export const LOD2_UMKREIS_M = 15000;

/**
 * Aus den Kindern der Wurzel eines Tilesets die, deren Region (`boundingVolume.region`:
 * West, Süd, Ost, Nord in Bogenmaß) im Umkreis von `radiusM` um den Punkt liegt. Zellen
 * ohne Region bleiben — was sich nicht prüfen lässt, wird nicht verworfen.
 *
 * Der Grund: die Wurzel des LoD2-Tilesets der BKG hat 1347 Kinder (überlappende Zellen
 * von wenigen Kilometern bis zu 8° Kantenlänge), und der Kachelbaum besucht sie bei
 * jedem Durchlauf. Das kostet auf dem Mac 4–5 ms (p95 11–15 ms) je Bild, auf der Quest
 * ein Vielfaches. Im Umkreis von 15 km um den Campus liegen davon 38.
 *
 * @param lat, lon  Bogenmaß
 */
export function zellenImUmkreis(kinder, lat, lon, radiusM) {
  const R = 6371008.8;
  return kinder.filter(k => {
    const r = k && k.boundingVolume && k.boundingVolume.region;
    if (!r) return true;
    const [west, sued, ost, nord] = r;
    const la = Math.min(Math.max(lat, sued), nord);
    const lo = Math.min(Math.max(lon, west), ost);
    const dx = (lon - lo) * Math.cos(lat) * R;
    const dy = (lat - la) * R;
    return Math.hypot(dx, dy) <= radiusM;
  });
}

const MERC = 20037508.342789244;

/** Kachel (x, y von oben, z) → Rechteck in EPSG:3857-Metern [minX, minY, maxX, maxY]. */
export function kachelMerc(x, y, z) {
  const w = 2 * MERC / 2 ** z;
  return [-MERC + x * w, MERC - (y + 1) * w, -MERC + (x + 1) * w, MERC - y * w];
}

/** Kachel → Rechteck in Grad [West, Süd, Ost, Nord]. */
export function kachelGrad(x, y, z) {
  const n = 2 ** z;
  const lon = v => v / n * 360 - 180;
  const lat = v => Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))) * 180 / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/** Lage in Grad → Pixel der Weltkarte auf Zoomstufe z (256 px je Kachel). */
export function mercPixel(latGrad, lonGrad, z) {
  const n = 256 * 2 ** z;
  const b = Math.max(-85.05112878, Math.min(85.05112878, latGrad)) * Math.PI / 180;
  return { x: (lonGrad + 180) / 360 * n, y: (1 - Math.log(Math.tan(b) + 1 / Math.cos(b)) / Math.PI) / 2 * n };
}

export function pixelGrad(px, py, z) {
  const n = 256 * 2 ** z;
  return { lon: px / n * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * py / n))) * 180 / Math.PI };
}

export function meterProPixel(latGrad, z) {
  return 2 * MERC / (256 * 2 ** z) * Math.cos(latGrad * Math.PI / 180);
}

function ueberlappt(r, g) {
  return !(g[2] < r[0] || g[0] > r[2] || g[3] < r[1] || g[1] > r[3]);
}

/** Trägt die Schicht etwas zu dieser Kachel bei? */
export function schichtPasst(s, x, y, z) {
  if (s.abZoom !== undefined && z < s.abZoom) return false;
  return !s.rechteck || ueberlappt(s.rechteck, kachelGrad(x, y, z));
}

/**
 * Woher das Bild einer Schicht für Kachel (x, y, z) kommt.
 *
 * XYZ-Dienste enden bei `maxZoom` (Sentinel-2: 14, also rund 10 m je Pixel).
 * Tiefer wird die Vorfahrenkachel geholt und daraus der passende Ausschnitt
 * vergrößert: `ausschnitt` = [sx, sy, seite] in Pixeln der 256er-Vorfahrin.
 * WMS-Dienste rechnen jedes Rechteck selbst und bekommen es in EPSG:3857.
 */
export function schichtQuelle(s, x, y, z) {
  if (s.art === 'wms') {
    const p = new URLSearchParams({
      SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.3.0', LAYERS: s.layers, STYLES: '',
      CRS: 'EPSG:3857', BBOX: kachelMerc(x, y, z).join(','), WIDTH: '256', HEIGHT: '256',
      FORMAT: s.format, TRANSPARENT: 'TRUE',
    });
    return { url: `${s.url}?${p}`, ausschnitt: null };
  }
  const tief = Math.max(0, z - s.maxZoom);
  const z0 = z - tief;
  const x0 = x >> tief;
  const y0 = y >> tief;
  const url = s.url.replace('{z}', z0).replace('{x}', x0).replace('{y}', y0);
  if (!tief) return { url, ausschnitt: null };
  const seite = 256 / 2 ** tief;
  return { url, ausschnitt: [(x - (x0 << tief)) * seite, (y - (y0 << tief)) * seite, seite] };
}

/** Quellenvermerke der Schichten, die um (lat, lon) etwas zeigen. */
export function kartenVermerke(art, latGrad, lonGrad) {
  const karte = KARTEN[art];
  if (!karte) return [];
  const g = [lonGrad - 0.2, latGrad - 0.15, lonGrad + 0.2, latGrad + 0.15];
  return karte.schichten.filter(s => !s.rechteck || ueberlappt(s.rechteck, g)).map(s => s.credit);
}

export function inDeutschland(latGrad, lonGrad) {
  const r = LOD2.rechteck;
  return lonGrad >= r[0] && lonGrad <= r[2] && latGrad >= r[1] && latGrad <= r[3];
}
