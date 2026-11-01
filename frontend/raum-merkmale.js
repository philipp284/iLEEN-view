/**
 * iLEEN — Raummerkmale: was an einem Raum gilt, und woher es kommt
 *
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Die Raumansicht färbt Räume nach einem Kriterium ein — Nutzung, Nutzlast,
 * Anschlussleistung, Schallschutz — und zeigt je Raum einen Steckbrief. Jede
 * Zahl darin kann aus einer von vier Quellen kommen, und **die Quelle steht an
 * der Zahl**, nicht irgendwo in einer Fußnote:
 *
 *   IFC       was der Planer ins Modell geschrieben hat (Psets, gedeutet in
 *             backend/ileen/raumdaten.py) — sticht alles andere
 *   Statik    die Nutzlastkategorie, mit der der Lastabtrag rechnet
 *             (`raumlasten.kategorie_von()` im Backend, dieselbe Funktion)
 *   Katalog   das Anforderungsprofil der Raumklasse (raumklassen.csv, Spiegel
 *             in room-concept.js) — ein Richtwert, kein Planungsstand
 *   abgel.    aus den anderen gerechnet: kW = W/m² × Fläche
 *
 * Ein Richtwert, der aussieht wie eine Planungsangabe, ist gefährlicher als
 * eine Lücke. Deshalb bleibt eine Angabe, die nur das IFC liefern kann
 * (Bodenbelag, Kühllast, IfcZone), leer, wenn das IFC sie nicht führt — sie
 * wird nicht aus der Raumklasse erfunden. Raumtemperatur und Heizlast stehen
 * seit 2026-10-18 im Katalog (`temp_C` nach DIN/TS 12831-1, `heizlast_W_m2`)
 * und kommen ohne IFC-Angabe von dort — als „Katalog" bzw. „abgel." markiert.
 *
 * Reines Modul ohne Cesium und ohne DOM: läuft unter Node
 * (tests/room-concept/test-ansicht.js). Den Katalog bekommt es bei jedem Aufruf
 * übergeben (`kat = { KLASSE_INDEX, ZONEN_META }`), damit die Ladereihenfolge
 * gegenüber room-concept.js keine Rolle spielt.
 */

'use strict';

(function (global) {

  // =====================================================
  // QUELLEN UND FORMAT
  // =====================================================

  const QUELLEN = {
    ifc:        { kurz: 'IFC',     titel: 'aus dem IFC-Modell' },
    statik:     { kurz: 'Statik',  titel: 'wie der Lastabtrag rechnet' },
    katalog:    { kurz: 'Katalog', titel: 'Richtwert der Raumklasse' },
    modell:     { kurz: 'Modell',  titel: 'aus der Modellgeometrie' },
    abgeleitet: { kurz: 'abgel.',  titel: 'aus anderen Angaben gerechnet' },
    hand:       { kurz: 'Hand',    titel: 'von Hand zugeordnet' },
    regel:      { kurz: 'Name',    titel: 'am Raumnamen erkannt' },
    sensor:     { kurz: 'Sensor',  titel: 'Messwert der Raumsensoren (live)' },
  };

  const q = (art, text) => ({ art, text });

  /** Deutsche Zahl, ohne überflüssige Nachkommastellen. */
  function zahl(n, stellen = 1) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    return n.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: stellen });
  }

  /** Ein IFC-Merkmal des Raums, wie das Backend es liefert — oder null. */
  const ifc = (r, key) => (r.merkmale && r.merkmale[key]) || null;

  /**
   * Die Quelle eines IFC-Merkmals. Stammt es aus `Pset_iLEEN_Raum` — also aus
   * einem früheren Export dieser Ansicht —, trägt es seine ursprüngliche
   * Herkunft mit (`statik`, `hand`, `ifc`); Katalogwerte liest das Backend
   * dort gar nicht erst zurück.
   */
  function ifcQuelle(i) {
    const art = i && i.herkunft && QUELLEN[i.herkunft] ? i.herkunft : 'ifc';
    const text = art === 'ifc' ? i.quelle : `${i.quelle} — ${i.herkunft_text || art}`;
    return q(art, text);
  }

  const klasseVon = (r, kat) => (r.klasse && kat && kat.KLASSE_INDEX && kat.KLASSE_INDEX[r.klasse]) || null;

  function katalogQuelle(kl) {
    return q('katalog', `Raumklasse „${kl.bezeichnung}“ · ${kl.quelle}`);
  }

  // =====================================================
  // DIN 277
  // =====================================================

  const DIN277 = {
    'NUF':   'Nutzungsfläche, Gruppe nicht angegeben',
    'NUF 1': 'Wohnen und Aufenthalt',
    'NUF 2': 'Büroarbeit',
    'NUF 3': 'Produktion, Hand- und Maschinenarbeit, Forschung',
    'NUF 4': 'Lagern, Verteilen und Verkaufen',
    'NUF 5': 'Bildung, Unterricht und Kultur',
    'NUF 6': 'Heilen und Pflegen',
    'NUF 7': 'Sonstige Nutzungen',
    'TF 8':  'Technische Anlagen',
    'VF 9':  'Verkehrserschließung und -sicherung',
  };

  // Verkehrsfläche gelb und Technik orange, wie in Flächenplänen üblich; die
  // Nutzungsgruppen in voneinander gut trennbaren Tönen.
  const DIN277_FARBE = {
    'NUF':   '#6B87A8', 'NUF 1': '#5FB878', 'NUF 2': '#4A90D9', 'NUF 3': '#A855F7',
    'NUF 4': '#9B8B7A', 'NUF 5': '#2BB3A8', 'NUF 6': '#E57BA8', 'NUF 7': '#8FA3B8',
    'TF 8':  '#F97316', 'VF 9':  '#E8C547',
  };

  /**
   * Hauptgruppe aus der Raumklasse — nur der Rückfall, wenn das IFC keine
   * Flächenart führt. Untergruppen werden bewusst nicht abgeleitet: ob eine
   * Teeküche 3.8 (Küchen) oder 1.3 (Pausenraum) ist, entscheidet der Planer,
   * nicht ein Muster über den Raumnamen.
   */
  const DIN277_KLASSE = {
    buero: 'NUF 2', besprechung: 'NUF 2', kopie: 'NUF 2', versammlung: 'NUF 5',
    lounge: 'NUF 1', teekueche: 'NUF 3', labor: 'NUF 3', werkstatt: 'NUF 3',
    lager: 'NUF 4', archiv: 'NUF 4',
    sanitaer: 'NUF 7', sanitaer_b: 'NUF 7', putzraum: 'NUF 7', garderobe: 'NUF 7', garage: 'NUF 7',
    server: 'TF 8', technik_elt: 'TF 8', technik_hzg: 'TF 8', schacht: 'TF 8',
    flur: 'VF 9', treppenraum: 'VF 9', aufzug: 'VF 9',
  };

  // =====================================================
  // FARBEN
  // =====================================================

  /** Kein Wert — sichtbar, aber zurückgenommen. Dasselbe Grau wie in room-concept.js. */
  const FARBE_OHNE = '#9aa0a6';
  const FARBE_NEIN = '#5f6670';

  /** Von wenig nach viel: kalt nach warm. Sieben Stufen, im Dunkeln gut trennbar. */
  const RAMPE = ['#2B5DA8', '#2C8FC7', '#2BB3A8', '#8BC34A', '#F2C14E', '#F08A3C', '#D9483B'];

  /** Für Kategorien ohne eigene Farbe — reihum, in der Reihenfolge der Legende. */
  const PALETTE = ['#4E9BE8', '#E8A33D', '#2BB3A8', '#C55FD6', '#E0604A', '#97BF0D',
                   '#F2C94C', '#6B7FD7', '#E57BA8', '#5AC8E8', '#B08B5A', '#8FA3B8'];

  function rampe(anteil, umgekehrt) {
    const a = Math.max(0, Math.min(1, umgekehrt ? 1 - anteil : anteil));
    return RAMPE[Math.round(a * (RAMPE.length - 1))];
  }

  // =====================================================
  // KRITERIEN
  // =====================================================
  //
  // `art` bestimmt die Legende:
  //   kategorie — je Wert eine Zeile, Farbe aus dem Wert oder reihum
  //   stufen    — je Wert eine Zeile, geordnet und gefärbt nach `wert` (Zahl)
  //   zahl      — wenige Werte einzeln, viele in fünf Klassen; Farbe nach Größe
  //   ja_nein   — zwei Zeilen
  // `summe` — die Werte lassen sich je Geschoss addieren (kW, m³/h, Personen).
  // `nurKarte` — erscheint im Steckbrief, nicht im Auswahlfeld „Einfärben nach".
  // `ifcNur` — gibt es nur aus dem IFC; im Steckbrief ohne Wert weggelassen.

  function jaNein(wert, quelle, extra) {
    return Object.assign({ wert: !!wert, text: wert ? 'ja' : 'nein', quelle }, extra || {});
  }

  function flaecheVon(r) {
    return r.flaeche && r.flaeche > 0 ? r.flaeche : null;
  }

  /** W/m² Elektro, aus dem IFC oder aus dem Katalog. */
  function elektroJeM2(r, kat) {
    const i = ifc(r, 'elektro_w_m2');
    if (i) return { wert: i.wert, text: `${zahl(i.wert)} W/m²`, quelle: ifcQuelle(i) };
    const kl = klasseVon(r, kat);
    if (kl) return { wert: kl.elektro, text: `${zahl(kl.elektro)} W/m²`, quelle: katalogQuelle(kl) };
    return null;
  }

  /** Außenluft je m², aus dem IFC (Volumenstrom oder Luftwechsel) oder dem Katalog. */
  function luftJeM2(r, kat) {
    const A = flaecheVon(r);
    const zu = ifc(r, 'zuluft_m3h');
    if (zu && A) {
      return { wert: zu.wert / A, text: `${zahl(zu.wert / A)} m³/(h·m²)`,
               quelle: q('abgeleitet', `${zahl(zu.wert, 0)} m³/h (IFC: ${zu.quelle}) ÷ ${zahl(A)} m²`) };
    }
    const n = ifc(r, 'luftwechsel_1h');
    if (n && r.hoehe) {
      return { wert: n.wert * r.hoehe, text: `${zahl(n.wert * r.hoehe)} m³/(h·m²)`,
               quelle: q('abgeleitet', `Luftwechsel ${zahl(n.wert)} 1/h (IFC) × ${zahl(r.hoehe, 2)} m Raumhöhe`) };
    }
    const kl = klasseVon(r, kat);
    if (kl) return { wert: kl.luft, text: `${zahl(kl.luft)} m³/(h·m²)`, quelle: katalogQuelle(kl) };
    return null;
  }

  // Bänder je Messgröße: Untergrenze (einschließlich), Text, Farbe. Die Farben sind die des
  // gaeco-Moduls (gaeco/modul/assets/raumklima-kern.js) — dasselbe Zimmer soll in beiden gleich aussehen.
  const SENSOR_BAENDER = {
    raumtemperatur: { einheit: '°C', stellen: 1, baender: [
      [-Infinity, 'unter 18 °C — kalt', '#3b4cc0'], [18, '18 – 20 °C — kühl', '#6f9be8'],
      [20, '20 – 22 °C — behaglich', '#7fcf8a'], [22, '22 – 24 °C — warm', '#f4d35e'],
      [24, '24 – 26 °C — sehr warm', '#f08a4b'], [26, 'ab 26 °C — zu heiß', '#c0392b']] },
    co2: { einheit: 'ppm', stellen: 0, baender: [
      [-Infinity, 'unter 700 ppm — gut', '#3fae6a'], [700, '700 – 1000 ppm — mäßig', '#9fd34f'],
      [1000, '1000 – 1400 ppm — verbraucht', '#f4d35e'], [1400, '1400 – 2000 ppm — schlecht', '#f08a4b'],
      [2000, 'ab 2000 ppm — kritisch', '#c0392b']] },
    luftfeuchte: { einheit: '%', stellen: 0, baender: [
      [-Infinity, 'unter 30 % — trocken', '#d9822b'], [30, '30 – 40 % — eher trocken', '#f4d35e'],
      [40, '40 – 60 % — behaglich', '#8fd19e'], [60, '60 – 70 % — eher feucht', '#4cb89b'],
      [70, 'ab 70 % — feucht', '#3b7dd8']] },
    praesenz: { einheit: '', stellen: 0, baender: [
      [-Infinity, 'frei', '#d1d5db'], [0.5, 'belegt', '#30B4E7']] },
  };

  /**
   * Das Band eines Messwerts in einem Raum.
   *
   * `text` ist, was an der Zahl steht (Steckbrief, Zeigerschild); `legende` ist die
   * Zeile in der Legende — das Band, nicht der einzelne Wert, sonst hieße die
   * Zeile nach dem ersten Raum, der in sie fällt.
   */
  function sensorWert(r, groesse) {
    const S = global.RaumSensorik;
    const g = SENSOR_BAENDER[groesse];
    const m = S && g ? S.wert(r.guid, groesse) : null;
    if (!m) return null;
    let i = 0;
    for (let k = 0; k < g.baender.length; k++) if (m.wert >= g.baender[k][0]) i = k;
    const [, band, farbe] = g.baender[i];
    const zeit = m.zeit ? new Date(m.zeit).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
    const text = groesse === 'praesenz' ? band
      : `${zahl(m.wert, g.stellen)} ${g.einheit} — ${band.split('— ')[1] || band}`;
    return { wert: String(i + 1), key: `${i + 1}`, text, legende: band, farbe,
             quelle: q('sensor', `Raumsensor${zeit ? ', Messung ' + zeit + ' Uhr' : ''} — Anker ist die GlobalId des IfcSpace`) };
  }

  const KRITERIEN = [
    // ── Nutzung ──────────────────────────────────────────
    { key: 'klasse', gruppe: 'Nutzung', label: 'Nutzung (Raumklasse)', art: 'kategorie', ordnung: 'zone',
      wert(r, kat) {
        const kl = klasseVon(r, kat);
        if (!kl) return null;
        let quelle;
        const zurueck = ifc(r, 'ileen_klasse');
        if (zurueck && zurueck.wert === r.klasse) {
          // Aus einem früheren Export zurückgelesen (Pset_iLEEN_Raum).
          quelle = q(r.erkannt === 'hand' ? 'hand' : 'ifc',
                     `${zurueck.quelle}${zurueck.herkunft_text ? ' — ' + zurueck.herkunft_text : ''}`);
        } else if (r.erkannt === 'hand') quelle = q('hand', 'im Raumpanel zugeordnet');
        else if (r.erkannt === 'ifc') quelle = q('ifc', `Nutzung im IFC „${(ifc(r, 'nutzung') || {}).wert || ''}“ (${(ifc(r, 'nutzung') || {}).quelle || ''}), Muster „${r.treffer}“`);
        else quelle = q('regel', `Raumname, Muster „${r.treffer}“`);
        return { wert: r.klasse, text: kl.bezeichnung, farbe: kl.farbe, quelle };
      } },
    { key: 'zone', gruppe: 'Nutzung', label: 'Nutzungsbereich', art: 'kategorie',
      wert(r, kat) {
        const kl = klasseVon(r, kat);
        if (!kl) return null;
        const z = (kat.ZONEN_META || {})[kl.zone] || { label: kl.zone, farbe: FARBE_OHNE };
        return { wert: kl.zone, text: z.label, farbe: z.farbe, quelle: katalogQuelle(kl) };
      } },
    { key: 'din277', gruppe: 'Nutzung', label: 'Flächenart DIN 277', art: 'kategorie', ordnung: 'wert',
      wert(r, kat) {
        const g = ifc(r, 'din277_gruppe');
        if (g) return { wert: g.wert, text: `${g.wert} · ${DIN277[g.wert] || ''}`, farbe: DIN277_FARBE[g.wert], quelle: ifcQuelle(g) };
        const ab = r.klasse && DIN277_KLASSE[r.klasse];
        if (ab) {
          return { wert: ab, text: `${ab} · ${DIN277[ab]}`, farbe: DIN277_FARBE[ab],
                   quelle: q('abgeleitet', 'Hauptgruppe aus der Raumklasse — das IFC führt keine Flächenart') };
        }
        return null;
      } },
    { key: 'ifczone', gruppe: 'Nutzung', label: 'Zone im IFC (IfcZone)', art: 'kategorie', ifcNur: true,
      wert(r) {
        const zonen = (r.ifc && r.ifc.zonen) || [];
        if (!zonen.length) return null;
        const text = zonen.map((z) => (z.art ? `${z.art}: ${z.name || '—'}` : (z.name || '—'))).join(' · ');
        return { wert: text, text, quelle: q('ifc', 'IfcRelAssignsToGroup → IfcZone') };
      } },
    { key: 'geschoss', gruppe: 'Nutzung', label: 'Geschoss', art: 'kategorie', ordnung: 'geschoss',
      wert(r) {
        return r.geschoss ? { wert: r.geschoss, text: r.geschoss, quelle: q('modell', 'IfcBuildingStorey') } : null;
      } },

    // ── Statik ───────────────────────────────────────────
    { key: 'nutzlast', gruppe: 'Statik', label: 'Nutzlast nach EC 1', art: 'stufen', einheit: 'kN/m²',
      wert(r, kat) {
        const s = r.nutzlast;
        if (s && s.kategorie) {
          const i = ifc(r, 'nutzlast_knm2');
          const hinweis = i && Math.abs(i.wert - s.q_k_kNm2) > 0.01 && i.herkunft !== 'statik'
            ? `Im IFC stehen ${zahl(i.wert)} kN/m² (${i.quelle}) — der Lastabtrag rechnet mit ${zahl(s.q_k_kNm2)} kN/m². Abweichende Kategorie unten im Steckbrief setzen.`
            : null;
          // Eine Vorgabe ist ein anderer Zustand als eine erkannte Nutzung,
          // auch wenn die Zahl dieselbe ist — eigene Legendenzeile, gleiche Farbe.
          const zusatz = s.eingriff ? ' (von Hand)' : s.vorgabe ? ' (Vorgabe)' : '';
          return { wert: s.q_k_kNm2, key: s.kategorie + zusatz, text: `${s.kategorie} · ${zahl(s.q_k_kNm2)} kN/m²${zusatz}`,
                   kategorie: s.kategorie,
                   quelle: q(s.eingriff ? 'hand' : 'statik', [s.beschreibung, s.norm, s.herkunft].filter(Boolean).join(' · ')), hinweis };
        }
        if (s) {
          // Das Backend hat geantwortet, aber keine Nutzung erkannt: der
          // Lastabtrag setzt dort die Vorgabe seiner Annahmen an. Welche das
          // ist, entscheidet erst ein Lauf — hier keine Zahl zu nennen ist die
          // ehrliche Auskunft.
          return { wert: null, key: 'vorgabe', text: 'Vorgabe der Annahmen', quelle: q('statik', s.herkunft) };
        }
        const kl = klasseVon(r, kat);
        if (kl) return { wert: kl.nutzlast, text: `${zahl(kl.nutzlast)} kN/m²`, quelle: katalogQuelle(kl) };
        return null;
      } },

    // ── TGA ──────────────────────────────────────────────
    { key: 'elektro', gruppe: 'TGA', label: 'Elektro je m²', art: 'zahl', einheit: 'W/m²',
      wert: elektroJeM2 },
    { key: 'elektro_kw', gruppe: 'TGA', label: 'Elektro je Raum', art: 'zahl', einheit: 'kW', summe: true,
      wert(r, kat) {
        const i = ifc(r, 'elektro_kw');
        if (i) return { wert: i.wert, text: `${zahl(i.wert, 2)} kW`, quelle: ifcQuelle(i) };
        const je = elektroJeM2(r, kat);
        const A = flaecheVon(r);
        if (!je || !A) return null;
        const kw = je.wert * A / 1000;
        return { wert: kw, text: `${zahl(kw, 2)} kW`,
                 quelle: q('abgeleitet', `${zahl(je.wert)} W/m² (${QUELLEN[je.quelle.art].kurz}) × ${zahl(A)} m²`) };
      } },
    { key: 'lux', gruppe: 'TGA', label: 'Beleuchtungsstärke', art: 'zahl', einheit: 'lx',
      wert(r, kat) {
        const i = ifc(r, 'beleuchtung_lx');
        if (i) return { wert: i.wert, text: `${zahl(i.wert, 0)} lx`, quelle: ifcQuelle(i) };
        const kl = klasseVon(r, kat);
        return kl ? { wert: kl.lux, text: `${zahl(kl.lux, 0)} lx`, quelle: katalogQuelle(kl) } : null;
      } },
    { key: 'licht', gruppe: 'TGA', label: 'Beleuchtung je m²', art: 'zahl', einheit: 'W/m²', nurKarte: true, ifcNur: true,
      wert(r) {
        const i = ifc(r, 'licht_w_m2');
        return i ? { wert: i.wert, text: `${zahl(i.wert)} W/m²`, quelle: ifcQuelle(i) } : null;
      } },
    { key: 'luft', gruppe: 'TGA', label: 'Außenluft je m²', art: 'zahl', einheit: 'm³/(h·m²)',
      wert: luftJeM2 },
    { key: 'luft_m3h', gruppe: 'TGA', label: 'Außenluft je Raum', art: 'zahl', einheit: 'm³/h', summe: true,
      wert(r, kat) {
        const zu = ifc(r, 'zuluft_m3h');
        if (zu) return { wert: zu.wert, text: `${zahl(zu.wert, 0)} m³/h`,
                         quelle: ifcQuelle({ ...zu, quelle: zu.quelle + (zu.roh !== undefined ? ` (${zu.roh} m³/s)` : '') }) };
        const je = luftJeM2(r, kat);
        const A = flaecheVon(r);
        if (!je || !A) return null;
        return { wert: je.wert * A, text: `${zahl(je.wert * A, 0)} m³/h`,
                 quelle: q('abgeleitet', `${zahl(je.wert)} m³/(h·m²) (${QUELLEN[je.quelle.art].kurz}) × ${zahl(A)} m²`) };
      } },
    { key: 'luftwechsel', gruppe: 'TGA', label: 'Luftwechsel', art: 'zahl', einheit: '1/h', nurKarte: true, ifcNur: true,
      wert(r) {
        const i = ifc(r, 'luftwechsel_1h');
        return i ? { wert: i.wert, text: `${zahl(i.wert)} 1/h`, quelle: ifcQuelle(i) } : null;
      } },
    { key: 'abluft', gruppe: 'TGA', label: 'Mechanische Abluft', art: 'ja_nein', farbe: '#4E9BE8',
      wert(r, kat) {
        const i = ifc(r, 'abluft_m3h');
        if (i) return jaNein(true, ifcQuelle(i), { text: `ja · ${zahl(i.wert, 0)} m³/h` });
        const kl = klasseVon(r, kat);
        return kl ? jaNein(kl.abluft, katalogQuelle(kl)) : null;
      } },
    { key: 'wasser', gruppe: 'TGA', label: 'Wasser und Abwasser', art: 'ja_nein', farbe: '#14B8C4',
      wert(r, kat) {
        const i = ifc(r, 'wasser');
        if (i) return jaNein(i.wert, ifcQuelle(i));
        const kl = klasseVon(r, kat);
        return kl ? jaNein(kl.wasser, katalogQuelle(kl)) : null;
      } },
    { key: 'temperatur', gruppe: 'TGA', label: 'Raumtemperatur', art: 'zahl', einheit: '°C',
      wert(r, kat) {
        const min = ifc(r, 'temp_min_c');
        const max = ifc(r, 'temp_max_c');
        if (min || max) {
          const haupt = min || max;
          const text = min && max ? `${zahl(min.wert)} … ${zahl(max.wert)} °C` : `${zahl(haupt.wert)} °C`;
          return { wert: haupt.wert, text, quelle: q('ifc', [min && min.quelle, max && max.quelle].filter(Boolean).join(' · ')) };
        }
        // Norm-Innentemperatur der Raumklasse; 0 heißt im Katalog „nicht beheizt".
        const kl = klasseVon(r, kat);
        if (!kl || kl.temp === undefined) return null;
        return kl.temp
          ? { wert: kl.temp, text: `${zahl(kl.temp)} °C`, quelle: q('katalog', `Raumklasse „${kl.bezeichnung}“ · Norm-Innentemperatur DIN/TS 12831-1`) }
          : { wert: null, key: 'unbeheizt', text: 'nicht beheizt', quelle: q('katalog', `Raumklasse „${kl.bezeichnung}“`) };
      } },
    { key: 'heizlast', gruppe: 'TGA', label: 'Heizlast', art: 'zahl', einheit: 'W', summe: true,
      wert(r, kat) {
        const i = ifc(r, 'heizlast_w');
        const A = flaecheVon(r);
        if (i) return { wert: i.wert, text: `${zahl(i.wert, 0)} W${A ? ` · ${zahl(i.wert / A, 0)} W/m²` : ''}`, quelle: ifcQuelle(i) };
        const kl = klasseVon(r, kat);
        if (!kl || !kl.heizlast || !A) return null;
        // Ein flächenbezogener Richtwert, keine Heizlastberechnung: er kennt
        // weder Außenflächen noch U-Werte. Deshalb „abgel." und nicht „Katalog".
        return { wert: kl.heizlast * A, text: `${zahl(kl.heizlast * A, 0)} W · ${zahl(kl.heizlast, 0)} W/m²`,
                 quelle: q('abgeleitet', `${zahl(kl.heizlast, 0)} W/m² (Katalog, Raumklasse „${kl.bezeichnung}“) × ${zahl(A)} m² — Richtwert, keine Berechnung nach DIN/TS 12831-1`) };
      } },
    { key: 'kuehllast', gruppe: 'TGA', label: 'Kühllast', art: 'zahl', einheit: 'W', summe: true, nurKarte: true, ifcNur: true,
      wert(r) {
        const i = ifc(r, 'kuehllast_w');
        return i ? { wert: i.wert, text: `${zahl(i.wert, 0)} W`, quelle: ifcQuelle(i) } : null;
      } },

    // ── Bauphysik und Brandschutz ────────────────────────
    { key: 'schall', gruppe: 'Bauphysik und Brandschutz', label: 'Schallschutz', art: 'stufen', einheit: 'dB',
      wert(r, kat) {
        const i = ifc(r, 'schallschutz');
        if (i) {
          const n = parseFloat(String(i.wert).replace(',', '.').replace(/[^0-9.]/g, ''));
          return { wert: Number.isFinite(n) ? n : null, key: String(i.wert), text: String(i.wert), quelle: ifcQuelle(i) };
        }
        const kl = klasseVon(r, kat);
        if (!kl) return null;
        return kl.schall
          ? { wert: kl.schall, text: `${zahl(kl.schall, 0)} dB`, quelle: katalogQuelle(kl) }
          : { wert: 0, text: 'ohne Anforderung', quelle: katalogQuelle(kl) };
      } },
    { key: 'feucht', gruppe: 'Bauphysik und Brandschutz', label: 'Feuchtraum (Abdichtung)', art: 'ja_nein', farbe: '#17A2A2',
      wert(r, kat) {
        const kl = klasseVon(r, kat);
        return kl ? jaNein(kl.feuchtraum, katalogQuelle(kl), kl.feuchtraum ? { text: 'ja · DIN 18534' } : null) : null;
      } },
    { key: 'brand', gruppe: 'Bauphysik und Brandschutz', label: 'Feuerwiderstand', art: 'stufen',
      wert(r, kat) {
        const i = ifc(r, 'brandschutz');
        if (i) {
          const m = String(i.wert).match(/(\d{2,3})/);
          return { wert: m ? parseInt(m[1], 10) : null, key: String(i.wert), text: String(i.wert), quelle: ifcQuelle(i) };
        }
        const kl = klasseVon(r, kat);
        if (!kl) return null;
        return { wert: kl.brand, text: kl.brand ? `F ${kl.brand}` : 'ohne Anforderung', quelle: katalogQuelle(kl) };
      } },
    { key: 'fluchtweg', gruppe: 'Bauphysik und Brandschutz', label: 'Flucht- und Rettungsweg', art: 'ja_nein', farbe: '#3FB950',
      wert(r, kat) {
        const i = ifc(r, 'fluchtweg');
        if (i) return jaNein(i.wert, ifcQuelle(i));
        const kl = klasseVon(r, kat);
        return kl ? jaNein(kl.fluchtweg, katalogQuelle(kl)) : null;
      } },
    { key: 'sprinkler', gruppe: 'Bauphysik und Brandschutz', label: 'Sprinkler', art: 'ja_nein', farbe: '#E0604A', nurKarte: true, ifcNur: true,
      wert(r) {
        const i = ifc(r, 'sprinkler');
        return i ? jaNein(i.wert, ifcQuelle(i)) : null;
      } },

    // ── Ausbau ───────────────────────────────────────────
    { key: 'rutsch', gruppe: 'Ausbau', label: 'Rutschhemmung', art: 'stufen',
      wert(r, kat) {
        const i = ifc(r, 'rutschhemmung');
        const text = i ? String(i.wert) : (klasseVon(r, kat) || {}).rutsch;
        if (!text) return null;
        const m = String(text).match(/R\s*(\d+)/i);
        return { wert: m ? parseInt(m[1], 10) : null, key: text, text,
                 quelle: i ? ifcQuelle(i) : katalogQuelle(klasseVon(r, kat)) };
      } },
    { key: 'bodenbelag', gruppe: 'Ausbau', label: 'Bodenbelag', art: 'kategorie', ifcNur: true,
      wert(r) {
        const i = ifc(r, 'bodenbelag');
        return i ? { wert: String(i.wert), text: String(i.wert), quelle: ifcQuelle(i) } : null;
      } },
    { key: 'decke', gruppe: 'Ausbau', label: 'Decke', art: 'kategorie', nurKarte: true, ifcNur: true,
      wert(r) {
        const i = ifc(r, 'deckenbekleidung');
        return i ? { wert: String(i.wert), text: String(i.wert), quelle: ifcQuelle(i) } : null;
      } },
    { key: 'wand', gruppe: 'Ausbau', label: 'Wandoberfläche', art: 'kategorie', nurKarte: true, ifcNur: true,
      wert(r) {
        const i = ifc(r, 'wandbekleidung');
        return i ? { wert: String(i.wert), text: String(i.wert), quelle: ifcQuelle(i) } : null;
      } },
    { key: 'barrierefrei', gruppe: 'Ausbau', label: 'Barrierefrei', art: 'ja_nein', farbe: '#4A90D9',
      wert(r) {
        const i = ifc(r, 'barrierefrei');
        if (i) return jaNein(i.wert, ifcQuelle(i));
        if (r.klasse === 'sanitaer_b') return jaNein(true, q('katalog', 'Raumklasse „Barrierefreies WC“ · DIN 18040-1'));
        return null;
      } },
    { key: 'aussen', gruppe: 'Ausbau', label: 'Außenraum', art: 'ja_nein', farbe: '#8BC34A', nurKarte: true, ifcNur: true,
      wert(r) {
        const i = ifc(r, 'aussen');
        return i ? jaNein(i.wert, ifcQuelle(i)) : null;
      } },

    // ── Geometrie und Belegung ───────────────────────────
    { key: 'flaeche', gruppe: 'Geometrie und Belegung', label: 'Fläche', art: 'zahl', einheit: 'm²', summe: true,
      wert(r) {
        const A = flaecheVon(r);
        if (!A) return null;
        const quelle = r.flaecheQuelle === 'qto' ? q('ifc', 'Mengensatz (Qto_SpaceBaseQuantities)')
          : r.flaecheQuelle === 'netz' ? q('modell', 'aus dem Raumkörper gerechnet')
          : q('ifc', 'Flächenangabe des Raums');
        return { wert: A, text: `${zahl(A)} m²`, quelle };
      } },
    { key: 'hoehe', gruppe: 'Geometrie und Belegung', label: 'Lichte Höhe', art: 'zahl', einheit: 'm',
      wert(r) {
        return r.hoehe ? { wert: r.hoehe, text: `${zahl(r.hoehe, 2)} m`, quelle: q('modell', 'Raumkörper bzw. Mengensatz') } : null;
      } },
    { key: 'volumen', gruppe: 'Geometrie und Belegung', label: 'Rauminhalt', art: 'zahl', einheit: 'm³', summe: true, nurKarte: true,
      wert(r) {
        return r.volumen ? { wert: r.volumen, text: `${zahl(r.volumen)} m³`, quelle: q('modell', r.volumenQuelle || 'Raumkörper') } : null;
      } },
    { key: 'personen', gruppe: 'Geometrie und Belegung', label: 'Personen', art: 'zahl', einheit: 'Pers.', summe: true,
      wert(r, kat) {
        const i = ifc(r, 'personen');
        if (i) return { wert: i.wert, text: `${zahl(i.wert)} Pers.`, quelle: ifcQuelle(i) };
        const A = flaecheVon(r);
        const fjp = ifc(r, 'flaeche_je_person');
        if (fjp && A) {
          return { wert: A / fjp.wert, text: `${zahl(A / fjp.wert)} Pers.`,
                   quelle: q('abgeleitet', `${zahl(A)} m² ÷ ${zahl(fjp.wert)} m²/Pers. (IFC: ${fjp.quelle})`) };
        }
        const kl = klasseVon(r, kat);
        // 99 m²/Pers. steht im Katalog für „keine Daueraufenthalte" (Schacht, Garage).
        if (kl && A && kl.personen_m2 < 90) {
          return { wert: A / kl.personen_m2, text: `${zahl(A / kl.personen_m2)} Pers.`,
                   quelle: q('abgeleitet', `${zahl(A)} m² ÷ ${zahl(kl.personen_m2)} m²/Pers. (Raumklasse „${kl.bezeichnung}“)`) };
        }
        return null;
      } },

    // ── Datenlage ────────────────────────────────────────
    { key: 'befunde', gruppe: 'Datenlage', label: 'Prüfbefund', art: 'kategorie', ordnung: 'wert',
      wert(r, kat) {
        const alle = kat.befunde && kat.befunde.get(r.guid);
        if (!kat.befunde) return null;
        if (!alle || !alle.length) {
          return kat.geprueft && kat.geprueft.has(r.guid)
            ? { wert: '3', key: '3 ok', text: 'ohne Befund', farbe: '#3FB950', quelle: null }
            : null;
        }
        const warnung = alle.some((b) => b.schwere === 'warnung');
        const text = alle.map((b) => b.kurz).join(' · ');
        return warnung
          ? { wert: '1', key: '1 warnung', text: `Warnung: ${text}`, farbe: '#D9483B', quelle: null }
          : { wert: '2', key: '2 hinweis', text: `Hinweis: ${text}`, farbe: '#F2C14E', quelle: null };
      } },

    { key: 'herkunft', gruppe: 'Datenlage', label: 'Herkunft der Nutzung', art: 'kategorie',
      wert(r) {
        const art = r.erkannt || 'offen';
        const t = { hand: 'von Hand zugeordnet', regel: 'am Raumnamen erkannt', ifc: 'aus der IFC-Nutzung erkannt', offen: 'nicht zugeordnet' }[art];
        const farbe = { hand: '#E0A33E', regel: '#4E9BE8', ifc: '#97BF0D', offen: FARBE_OHNE }[art];
        // Ohne Quellenangabe: der Text *ist* die Herkunft.
        return { wert: art, text: t, farbe, quelle: null };
      } },
    { key: 'ifcdaten', gruppe: 'Datenlage', label: 'Angaben aus dem IFC', art: 'zahl', einheit: 'Merkmale', umgekehrt: true,
      wert(r) {
        // Das rohe `din277` zählt nicht mit: es ist dieselbe Angabe wie die
        // gedeutete Gruppe daneben.
        const n = Object.keys(r.merkmale || {}).filter((k) => k !== 'din277').length;
        return { wert: n, text: n ? `${n} Merkmale` : 'keine', quelle: q('ifc', 'gedeutete Psets des Raums') };
      } },

    // ── Sensorik (live) ──────────────────────────────────
    // Messwerte der Raumsensoren, über die GlobalId des IfcSpace (raum-sensorik.js).
    // Die Legende führt Bänder statt Einzelwerte: ein Messwert hat Nachkommastellen,
    // und „21,34 °C" als eigene Legendenzeile wäre je Raum eine andere.
    { key: 'live_temp', gruppe: 'Sensorik (live)', label: 'Temperatur · live', art: 'kategorie', ordnung: 'wert',
      wert: (r) => sensorWert(r, 'raumtemperatur'), ifcNur: true },
    { key: 'live_co2', gruppe: 'Sensorik (live)', label: 'CO₂ · live', art: 'kategorie', ordnung: 'wert',
      wert: (r) => sensorWert(r, 'co2'), ifcNur: true },
    { key: 'live_rf', gruppe: 'Sensorik (live)', label: 'Luftfeuchte · live', art: 'kategorie', ordnung: 'wert',
      wert: (r) => sensorWert(r, 'luftfeuchte'), ifcNur: true },
    { key: 'live_belegung', gruppe: 'Sensorik (live)', label: 'Belegung · live', art: 'kategorie', ordnung: 'wert',
      wert: (r) => sensorWert(r, 'praesenz'), ifcNur: true },
  ];

  const KRITERIUM = Object.fromEntries(KRITERIEN.map((k) => [k.key, k]));

  /** Wert eines Raums für ein Kriterium — `{wert, text, quelle, …}` oder null. */
  function wert(r, key, kat) {
    const k = KRITERIUM[key];
    if (!k) return null;
    try { return k.wert(r, kat || {}) || null; } catch (_) { return null; }
  }

  // =====================================================
  // EINTEILUNG — Legende, Farbe je Raum
  // =====================================================

  /** Auf zwei geltende Ziffern — Klassengrenzen wie „120–250", nicht „118,37–247,9". */
  function schoen(v) {
    if (!Number.isFinite(v) || v === 0) return v;
    const e = Math.floor(Math.log10(Math.abs(v))) - 1;
    const f = Math.pow(10, e);
    return Math.round(v / f) * f;
  }

  const OHNE = '∅';

  /**
   * Die Räume nach einem Kriterium einteilen.
   *
   * @returns `{ kriterium, legende: [{key, label, farbe, anzahl, flaeche, summe}],
   *             schluessel: Map guid → Legendenschlüssel,
   *             farbe: Map guid → CSS-Farbe, werte: Map guid → Wert }`
   *
   * Wenige verschiedene Zahlen (Katalogwerte: 100, 200, 300, 500 lx) bekommen
   * je eine eigene Zeile — eine Klasse „200–300 lx" wäre dort eine Erfindung.
   * Erst ab acht verschiedenen Werten wird in fünf Klassen gleicher Belegung
   * eingeteilt, mit gerundeten Grenzen.
   */
  function einteilen(raeume, key, kat) {
    const k = KRITERIUM[key] || KRITERIUM.klasse;
    kat = kat || {};
    const werte = new Map();
    for (const r of raeume) werte.set(r.guid, wert(r, k.key, kat));

    const eintraege = new Map();   // Schlüssel → Legendenzeile
    const schluessel = new Map();
    const zeile = (key, label, farbe, extra) => {
      if (!eintraege.has(key)) {
        eintraege.set(key, Object.assign({ key, label, farbe, anzahl: 0, flaeche: 0, summe: 0 }, extra || {}));
      }
      return eintraege.get(key);
    };

    // Legendenschlüssel je Raum
    const zahlen = [];
    for (const w of werte.values()) {
      if (w && k.art === 'zahl' && Number.isFinite(w.wert)) zahlen.push(w.wert);
    }

    let grenzen = null;      // Klassen bei vielen Zahlenwerten
    let einzeln = null;      // die einzelnen Werte bei wenigen
    if (k.art === 'zahl') {
      const verschieden = [...new Set(zahlen.map((v) => +v.toPrecision(4)))].sort((a, b) => a - b);
      if (verschieden.length <= 7) {
        einzeln = verschieden;
      } else {
        const s = [...zahlen].sort((a, b) => a - b);
        const quantil = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
        grenzen = [...new Set([0.2, 0.4, 0.6, 0.8].map((p) => schoen(quantil(p))))]
          .filter((g) => g > s[0] && g <= s[s.length - 1]).sort((a, b) => a - b);
        // Viele gleiche Werte (zwanzig gleich große Büros mit demselben
        // Katalogwert) ziehen zwei Quantile fast zusammen, und es entstünde
        // eine Klasse „0,38 – 0,39 kW". Eine Grenze, die weniger als 15 %
        // über der vorigen liegt, fällt weg. Relativ zum Nachbarn und nicht
        // zur Spanne: ein einzelner Serverraum mit 40 kW machte sonst aus
        // allen Büros eine einzige Klasse.
        grenzen = grenzen.filter((g, i) => !i || g - grenzen[i - 1] >= Math.abs(grenzen[i - 1]) * 0.15);
      }
    }

    const einheit = k.einheit ? ` ${k.einheit}` : '';
    const stellen = (v) => (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);

    for (const r of raeume) {
      const w = werte.get(r.guid);
      let z;
      if (!w || (w.wert === null && !w.key)) {
        z = zeile(OHNE, 'keine Angabe', FARBE_OHNE, { rang: Infinity });
      } else if (k.art === 'ja_nein') {
        z = w.wert ? zeile('ja', 'ja', k.farbe || PALETTE[0], { rang: 0 })
                   : zeile('nein', 'nein', FARBE_NEIN, { rang: 1 });
      } else if (k.art === 'zahl' && einzeln) {
        const v = +w.wert.toPrecision(4);
        const i = einzeln.indexOf(v);
        const anteil = einzeln.length > 1 ? i / (einzeln.length - 1) : 0.5;
        z = zeile(`v:${v}`, `${zahl(v, stellen(v))}${einheit}`, rampe(anteil, k.umgekehrt), { rang: v });
      } else if (k.art === 'zahl') {
        let i = 0;
        while (i < grenzen.length && w.wert >= grenzen[i]) i++;
        const lo = i === 0 ? null : grenzen[i - 1];
        const hi = i === grenzen.length ? null : grenzen[i];
        const label = lo === null ? `unter ${zahl(hi, stellen(hi))}${einheit}`
          : hi === null ? `ab ${zahl(lo, stellen(lo))}${einheit}`
          : `${zahl(lo, stellen(lo))} – ${zahl(hi, stellen(hi))}${einheit}`;
        z = zeile(`b:${i}`, label, rampe(grenzen.length ? i / grenzen.length : 0.5, k.umgekehrt), { rang: i });
      } else if (w.wert === null) {
        // „Vorgabe der Annahmen": ein benannter Zustand ohne Zahl.
        z = zeile(String(w.key), w.text, FARBE_OHNE, { rang: Infinity - 1 });
      } else {
        const key = String(w.key !== undefined ? w.key : w.wert);
        z = zeile(key, w.legende !== undefined ? w.legende : w.text, w.farbe || null, { rang: k.art === 'stufen' ? w.wert : null });
      }
      z.anzahl += 1;
      z.flaeche += flaecheVon(r) || 0;
      if (k.summe && w && Number.isFinite(w.wert)) z.summe += w.wert;
      schluessel.set(r.guid, z.key);
    }

    // Reihenfolge
    let legende = [...eintraege.values()];
    const zoneRang = Object.keys(kat.ZONEN_META || {});
    const geschossRang = kat.geschossFolge || [];
    legende.sort((a, b) => {
      if (a.key === OHNE) return 1;
      if (b.key === OHNE) return -1;
      if (k.art === 'stufen' || k.art === 'zahl' || k.art === 'ja_nein') {
        const ra = Number.isFinite(a.rang) ? a.rang : Infinity;
        const rb = Number.isFinite(b.rang) ? b.rang : Infinity;
        return ra - rb || a.label.localeCompare(b.label, 'de', { numeric: true });
      }
      if (k.ordnung === 'zone') {
        const za = zoneRang.indexOf((kat.KLASSE_INDEX[a.key] || {}).zone);
        const zb = zoneRang.indexOf((kat.KLASSE_INDEX[b.key] || {}).zone);
        return za - zb || b.anzahl - a.anzahl;
      }
      if (k.ordnung === 'geschoss' && geschossRang.length) {
        // Von oben nach unten, wie im Schnitt — dieselbe Ordnung wie in der Raumliste.
        return geschossRang.indexOf(b.key) - geschossRang.indexOf(a.key);
      }
      if (k.ordnung === 'wert') return a.key.localeCompare(b.key, 'de', { numeric: true });
      return b.anzahl - a.anzahl || a.label.localeCompare(b.label, 'de');
    });

    // Stufen: Farbe nach Rang der Zahl, kalt (wenig) bis warm (viel).
    if (k.art === 'stufen') {
      const mitZahl = legende.filter((z) => Number.isFinite(z.rang));
      const verschieden = [...new Set(mitZahl.map((z) => z.rang))].sort((a, b) => a - b);
      for (const z of mitZahl) {
        const i = verschieden.indexOf(z.rang);
        z.farbe = rampe(verschieden.length > 1 ? i / (verschieden.length - 1) : 0.5, k.umgekehrt);
      }
      legende.filter((z) => !z.farbe).forEach((z) => { z.farbe = FARBE_OHNE; });
    }
    // Kategorien ohne eigene Farbe: reihum, in der Reihenfolge der Legende.
    let n = 0;
    for (const z of legende) if (!z.farbe) z.farbe = PALETTE[n++ % PALETTE.length];

    const farbe = new Map();
    for (const [guid, key] of schluessel) farbe.set(guid, eintraege.get(key).farbe);

    return { kriterium: k, legende, schluessel, farbe, werte };
  }

  // =====================================================
  // KENNWERTE JE GESCHOSS
  // =====================================================

  /**
   * Was die TGA und die Statik je Geschoss wissen wollen: Fläche, Personen,
   * Außenluft, Anschlussleistung, mittlere Nutzlast.
   *
   * Die Nutzlast ist **flächengewichtet** gemittelt und nur über die Räume,
   * deren Kategorie bekannt ist — ein Mittel über „Vorgabe" wäre eine Zahl
   * ohne Aussage. Wie viel Fläche dahinter steht, steht dabei.
   */
  function kennwerteJeGeschoss(raeume, kat, folge) {
    const zeilen = new Map();
    const neu = (key) => ({ geschoss: key, anzahl: 0, flaeche: 0, personen: 0, luft: 0, elektro: 0,
                            qA: 0, qFlaeche: 0, wasser: 0 });
    const gesamt = neu('Summe');
    for (const r of raeume) {
      if (!zeilen.has(r.geschoss)) zeilen.set(r.geschoss, neu(r.geschoss));
      for (const z of [zeilen.get(r.geschoss), gesamt]) {
        const A = flaecheVon(r) || 0;
        z.anzahl += 1;
        z.flaeche += A;
        const p = wert(r, 'personen', kat); if (p && Number.isFinite(p.wert)) z.personen += p.wert;
        const l = wert(r, 'luft_m3h', kat); if (l && Number.isFinite(l.wert)) z.luft += l.wert;
        const e = wert(r, 'elektro_kw', kat); if (e && Number.isFinite(e.wert)) z.elektro += e.wert;
        const n = wert(r, 'nutzlast', kat); if (n && Number.isFinite(n.wert) && A) { z.qA += n.wert * A; z.qFlaeche += A; }
        const w = wert(r, 'wasser', kat); if (w && w.wert) z.wasser += 1;
      }
    }
    const fertig = (z) => Object.assign(z, { nutzlast: z.qFlaeche ? z.qA / z.qFlaeche : null });
    const ordnung = folge && folge.length ? folge : [...zeilen.keys()];
    // Von oben nach unten, wie in der Raumliste.
    const liste = [...zeilen.values()].sort((a, b) => ordnung.indexOf(b.geschoss) - ordnung.indexOf(a.geschoss));
    return { zeilen: liste.map(fertig), gesamt: fertig(gesamt) };
  }

  // =====================================================
  // PRÜFUNGEN ÜBER DIE RÄUME HINWEG
  // =====================================================
  //
  // Drei Fragen, die ein einzelner Raum nicht beantwortet, sondern nur seine
  // Lage zu den anderen:
  //
  //   Steigstrang   Liegt ein Nassraum an einem Schacht oder über/unter einem
  //                 anderen Nassraum? Sonst läuft das Abwasser quer durchs Haus.
  //   Außenluft     Reicht die geplante Außenluft für die geplante Belegung
  //                 (DIN EN 16798-1, Kategorie II)?
  //   Rettungsweg   Liegt jede Stelle eines Aufenthaltsraums höchstens 35 m
  //                 von einem notwendigen Treppenraum (MBO § 35 Abs. 2)?
  //
  // Alle drei rechnen in der Grundrissebene, tile-lokal in Metern — dieselben
  // Koordinaten, in denen das Backend Hüllquader und Grundrissfiguren liefert.
  // Ohne Lage (ion-Kacheln) gibt es keine Prüfung, und das steht so da.

  /** Grenzwerte, mit Fundstelle — eine Stelle, damit Text und Rechnung nicht auseinanderlaufen. */
  const GRENZEN = {
    steigstrangUmkreis: 6.0,         // m — üblicher Abstand eines Nassraums zu seinem Strang
    rettungsweg: 35.0,               // m — MBO § 35 Abs. 2, Lauflinie (hier: Luftlinie, also nachsichtig)
    luftJePerson: 25.2,              // m³/h — DIN EN 16798-1 Kat II, 7 l/s je Person
    luftJeM2: 2.52,                  // m³/(h·m²) — Gebäudeemissionen, schadstoffarm, 0,7 l/(s·m²)
    luftToleranz: 0.9,               // 10 % Spielraum, bevor gewarnt wird
  };

  /** Klassen, in denen sich Menschen aufhalten — für die Rettungsweglänge. */
  const AUFENTHALT = new Set(['buero', 'besprechung', 'versammlung', 'lounge', 'teekueche', 'kopie',
                              'labor', 'werkstatt', 'kita', 'wohnen']);

  function umriss(r) {
    const g = Array.isArray(r.grundriss) && r.grundriss[0] && r.grundriss[0].length >= 3 ? r.grundriss[0] : null;
    if (g) return g;
    if (r.box && r.box.lo && r.box.hi) {
      const { lo, hi } = r.box;
      return [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]];
    }
    return null;
  }

  function punktImPolygon(x, y, ring) {
    let drin = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) drin = !drin;
    }
    return drin;
  }

  function punktZuPolygon(x, y, ring) {
    if (punktImPolygon(x, y, ring)) return 0;
    let d = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j], [bx, by] = ring[i];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return d;
  }

  /** Kleinster Abstand zweier Grundrisse (0 bei Berührung oder Überlappung). */
  function polygonAbstand(a, b) {
    let d = Infinity;
    for (const [x, y] of a) d = Math.min(d, punktZuPolygon(x, y, b));
    for (const [x, y] of b) d = Math.min(d, punktZuPolygon(x, y, a));
    return d;
  }

  /** Ob sich zwei Grundrisse überdecken — für „Nassraum darüber". */
  function ueberdecken(a, b) {
    return a.some(([x, y]) => punktImPolygon(x, y, b)) || b.some(([x, y]) => punktImPolygon(x, y, a)) ||
      polygonAbstand(a, b) < 0.05;
  }

  /**
   * Alle Prüfungen über die Räume.
   *
   * @returns `{ befunde: [{pruefung, schwere, guid, kurz, text}], jeRaum: Map,
   *             geprueft: Set (GlobalIds, die mindestens eine Prüfung durchlaufen haben),
   *             uebersicht: [{pruefung, titel, geprueft, warnung, hinweis, grundlage, ohne}] }`
   */
  function pruefungen(raeume, kat) {
    kat = kat || {};
    const folge = kat.geschossFolge || [];
    const nassKlasse = (r) => { const kl = klasseVon(r, kat); return !!kl && kl.zone === 'wet'; };
    const wasser = (r) => { const w = wert(r, 'wasser', kat); return !!(w && w.wert); };
    const befunde = [];
    const geprueft = new Set();
    const uebersicht = [];
    const mitLage = raeume.filter((r) => umriss(r));

    // ── Steigstrang ──
    {
      const schaechte = mitLage.filter((r) => r.klasse === 'schacht');
      // Der Schacht führt im Katalog Wasser — er *ist* der Strang, nicht ein Raum daran.
      const nass = mitLage.filter((r) => r.klasse !== 'schacht' && (nassKlasse(r) || wasser(r)));
      let warnung = 0;
      // Erst, was selbst am Strang liegt: am Schacht oder über/unter einem
      // anderen Nassraum. Dann, was daneben liegt: die Teeküche neben dem
      // WC-Kern hängt an dessen Strang. Ein Schritt, keine Kette — sonst
      // reichte eine Reihe Nassräume im Abstand von 6 m quer durchs Haus.
      const amStrang = new Set();
      for (const r of nass) {
        const u = umriss(r);
        const i = folge.indexOf(r.geschoss);
        const nachbarGeschosse = new Set([folge[i - 1], folge[i + 1]].filter(Boolean));
        const amSchacht = schaechte.some((s) => Math.abs(folge.indexOf(s.geschoss) - i) <= 1 &&
                                               polygonAbstand(u, umriss(s)) <= GRENZEN.steigstrangUmkreis);
        const gestapelt = nass.some((o) => o !== r && nachbarGeschosse.has(o.geschoss) && ueberdecken(u, umriss(o)));
        if (amSchacht || gestapelt) amStrang.add(r);
      }
      for (const r of nass) {
        geprueft.add(r.guid);
        if (amStrang.has(r)) continue;
        const u = umriss(r);
        const daneben = [...amStrang].some((o) => o.geschoss === r.geschoss &&
                                                  polygonAbstand(u, umriss(o)) <= GRENZEN.steigstrangUmkreis);
        if (daneben) continue;
        warnung += 1;
        befunde.push({ pruefung: 'steigstrang', schwere: 'hinweis', guid: r.guid, kurz: 'kein Steigstrang',
                       text: `Kein Schacht und kein Nassraum am Strang im Umkreis von ${zahl(GRENZEN.steigstrangUmkreis)} m, ` +
                             'kein Nassraum direkt darüber oder darunter — Leitungsführung prüfen.' });
      }
      uebersicht.push({ pruefung: 'steigstrang', titel: 'Nassräume am Steigstrang', geprueft: nass.length,
                        warnung: 0, hinweis: warnung,
                        grundlage: `Schacht ≤ ${zahl(GRENZEN.steigstrangUmkreis)} m, Nassraum im Geschoss darüber/darunter ` +
                                   `oder ≤ ${zahl(GRENZEN.steigstrangUmkreis)} m neben einem Nassraum am Strang`,
                        ohne: schaechte.length ? null : 'Das Modell führt keine Schächte als Raum — geprüft wird nur, ob Nassräume übereinander liegen.' });
    }

    // ── Außenluft gegen Belegung ── nur, wo das IFC mitredet: Katalog gegen
    // Katalog wäre eine Prüfung des Katalogs, nicht der Planung.
    {
      let n = 0, warnung = 0;
      for (const r of raeume) {
        const A = flaecheVon(r);
        const p = wert(r, 'personen', kat);
        const l = wert(r, 'luft_m3h', kat);
        if (!A || !p || !l || !Number.isFinite(p.wert) || !Number.isFinite(l.wert)) continue;
        const ausIfc = (x) => x.quelle && (x.quelle.art === 'ifc' || x.quelle.art === 'hand' || /IFC/.test(x.quelle.text || ''));
        if (!ausIfc(p) && !ausIfc(l)) continue;
        n += 1; geprueft.add(r.guid);
        const bedarf = p.wert * GRENZEN.luftJePerson + A * GRENZEN.luftJeM2;
        if (l.wert < GRENZEN.luftToleranz * bedarf) {
          warnung += 1;
          befunde.push({ pruefung: 'aussenluft', schwere: 'warnung', guid: r.guid, kurz: 'Außenluft zu knapp',
                         text: `Außenluft ${zahl(l.wert, 0)} m³/h für ${zahl(p.wert)} Personen auf ${zahl(A)} m² — ` +
                               `DIN EN 16798-1 Kat. II verlangt rund ${zahl(bedarf, 0)} m³/h ` +
                               `(${zahl(GRENZEN.luftJePerson)} m³/h je Person + ${zahl(GRENZEN.luftJeM2)} m³/(h·m²)).` });
        }
      }
      uebersicht.push({ pruefung: 'aussenluft', titel: 'Außenluft für die Belegung', geprueft: n, warnung, hinweis: 0,
                        grundlage: 'DIN EN 16798-1 Kat. II: 7 l/s je Person + 0,7 l/(s·m²)',
                        ohne: n ? null : 'Kein Raum führt Personen oder Außenluft im IFC — Katalog gegen Katalog wird nicht geprüft.' });
    }

    // ── Rettungsweg (Luftlinie) ──
    {
      let n = 0, warnung = 0;
      const ohneTreppe = [];
      const geschosse = [...new Set(mitLage.map((r) => r.geschoss))];
      for (const g of geschosse) {
        // Im Erdgeschoss führt der Weg ins Freie, und wo die Ausgänge liegen,
        // steht nicht in den Räumen. Dort wird nicht geprüft.
        if (/\b(eg|erdgeschoss|ground)\b/i.test(String(g))) continue;
        const hier = mitLage.filter((r) => r.geschoss === g);
        const treppen = hier.filter((r) => r.klasse === 'treppenraum');
        const aufenthalt = hier.filter((r) => AUFENTHALT.has(r.klasse));
        if (!aufenthalt.length) continue;
        if (!treppen.length) { ohneTreppe.push(g); continue; }
        for (const r of aufenthalt) {
          n += 1; geprueft.add(r.guid);
          // Die ungünstigste Stelle des Raums ist eine seiner Ecken.
          let weitest = 0;
          for (const [x, y] of umriss(r)) {
            weitest = Math.max(weitest, Math.min(...treppen.map((t) => punktZuPolygon(x, y, umriss(t)))));
          }
          if (weitest > GRENZEN.rettungsweg) {
            warnung += 1;
            befunde.push({ pruefung: 'rettungsweg', schwere: 'warnung', guid: r.guid, kurz: 'Rettungsweg zu lang',
                           text: `Die fernste Ecke liegt ${zahl(weitest)} m Luftlinie vom nächsten Treppenraum — ` +
                                 `mehr als ${zahl(GRENZEN.rettungsweg, 0)} m (MBO § 35 Abs. 2). Die Lauflinie ist länger.` });
          }
        }
      }
      uebersicht.push({ pruefung: 'rettungsweg', titel: 'Rettungsweg zum Treppenraum', geprueft: n, warnung, hinweis: 0,
                        grundlage: `Luftlinie ≤ ${zahl(GRENZEN.rettungsweg, 0)} m, MBO § 35 Abs. 2 (Erdgeschoss ausgenommen)`,
                        ohne: ohneTreppe.length ? `Ohne Treppenraum als Raum: ${ohneTreppe.join(', ')} — dort nicht geprüft.` : null });
    }

    if (!mitLage.length) {
      // Die Außenluft braucht keine Lage; Steigstrang und Rettungsweg schon.
      uebersicht.filter((u) => u.pruefung !== 'aussenluft')
        .forEach((u) => { u.ohne = 'Die Räume haben keine Lage (Kachelweg) — es gibt nichts zu messen.'; });
    }

    const jeRaum = new Map();
    for (const b of befunde) {
      if (!jeRaum.has(b.guid)) jeRaum.set(b.guid, []);
      jeRaum.get(b.guid).push(b);
    }
    return { befunde, jeRaum, geprueft, uebersicht };
  }

  /** Kennwerte je IfcZone — Brandabschnitte, Wohnungen, Mietbereiche, wie das Modell sie gruppiert. */
  function kennwerteJeZone(raeume) {
    const zonen = new Map();
    for (const r of raeume) {
      for (const z of (r.ifc && r.ifc.zonen) || []) {
        const key = `${z.art || 'Zone'}: ${z.name || '—'}`;
        if (!zonen.has(key)) zonen.set(key, { zone: key, art: z.art || null, anzahl: 0, flaeche: 0, geschosse: new Set() });
        const e = zonen.get(key);
        e.anzahl += 1; e.flaeche += flaecheVon(r) || 0; e.geschosse.add(r.geschoss);
      }
    }
    return [...zonen.values()].map((z) => ({ ...z, geschosse: [...z.geschosse] }))
      .sort((a, b) => String(a.art).localeCompare(String(b.art), 'de') || b.flaeche - a.flaeche);
  }

  /**
   * Was in `Pset_iLEEN_Raum` geschrieben wird — je Kriterium Wert und Herkunft.
   *
   * Die Namen im IFC legt das Backend fest (`raumdaten.ILEEN_FELDER`); hier
   * steht nur, welcher Wert der Ansicht zu welchem Kriterium gehört. Ein
   * Kriterium, das das Backend nicht kennt, ignoriert es.
   */
  const IFC_KRITERIEN = ['zone', 'din277', 'nutzlast', 'elektro', 'elektro_kw', 'lux', 'luft', 'luft_m3h',
                         'abluft', 'wasser', 'temperatur', 'heizlast', 'schall', 'feucht', 'brand',
                         'fluchtweg', 'rutsch', 'barrierefrei', 'personen', 'bodenbelag'];

  function ifcWerte(r, kat) {
    const aus = {};
    const eintrag = (w, wertFeld) => ({
      wert: wertFeld, quelle_art: w.quelle ? w.quelle.art : 'ifc', quelle_text: w.quelle ? w.quelle.text : '',
    });
    for (const key of IFC_KRITERIEN) {
      const w = wert(r, key, kat);
      if (!w || w.wert === null || w.wert === undefined) continue;
      const k = KRITERIUM[key];
      let v = w.wert;
      if (key === 'zone' || key === 'brand' || key === 'rutsch' || key === 'schall' && !Number.isFinite(v)) v = w.text;
      if (key === 'din277') aus.din277 = { ...eintrag(w, w.wert), bezeichnung: DIN277[w.wert] || null };
      else aus[key] = eintrag(w, k.art === 'ja_nein' ? !!v : v);
      if (key === 'nutzlast' && w.kategorie) aus.nutzlast_kat = eintrag(w, w.kategorie);
    }
    const bef = kat.befunde && kat.befunde.get(r.guid);
    if (bef && bef.length) aus.befunde = { wert: bef.map((b) => b.text).join(' | '), quelle_art: 'pruefung', quelle_text: 'Raumansicht' };
    return aus;
  }

  // =====================================================
  // STECKBRIEF
  // =====================================================

  const STECKBRIEF = [
    { titel: 'Kennwerte', offen: true, keys: ['flaeche', 'hoehe', 'volumen', 'personen'] },
    { titel: 'Statik', offen: true, keys: ['nutzlast'] },
    { titel: 'TGA', offen: true, keys: ['elektro', 'elektro_kw', 'lux', 'licht', 'luft', 'luft_m3h', 'luftwechsel',
                                        'abluft', 'wasser', 'temperatur', 'heizlast', 'kuehllast'] },
    { titel: 'Sensorik (live)', offen: true, keys: ['live_temp', 'live_co2', 'live_rf', 'live_belegung'] },
    { titel: 'Bauphysik und Brandschutz', offen: true, keys: ['schall', 'feucht', 'brand', 'fluchtweg', 'sprinkler'] },
    { titel: 'Ausbau', offen: false, keys: ['rutsch', 'bodenbelag', 'decke', 'wand', 'barrierefrei', 'aussen'] },
    { titel: 'Einordnung', offen: false, keys: ['klasse', 'zone', 'din277', 'ifczone', 'herkunft'] },
  ];

  /**
   * Der Steckbrief eines Raums als Daten: Abschnitte mit Zeilen
   * `{key, label, text, quelle, hinweis}`. Eine Angabe, die es nur im IFC gibt,
   * fällt weg, wenn das IFC sie nicht führt — eine Zeile „Heizlast: —" bei
   * jedem Raum eines Architekturmodells wäre Rauschen. Alles andere bleibt
   * stehen, auch leer: dass ein Raum keine Nutzlast hat, ist eine Aussage.
   */
  function steckbrief(r, kat) {
    return STECKBRIEF.map((abschnitt) => ({
      titel: abschnitt.titel,
      offen: abschnitt.offen,
      zeilen: abschnitt.keys.map((key) => {
        const k = KRITERIUM[key];
        const w = wert(r, key, kat);
        if (!w && k.ifcNur) return null;
        return { key, label: k.label, text: w ? w.text : '—', quelle: w ? w.quelle : null,
                 hinweis: w ? w.hinweis || null : null };
      }).filter(Boolean),
    })).filter((a) => a.zeilen.length);
  }

  /** Die Kriterien für das Auswahlfeld, nach Gruppen. */
  function auswahl() {
    const gruppen = new Map();
    for (const k of KRITERIEN) {
      if (k.nurKarte) continue;
      if (!gruppen.has(k.gruppe)) gruppen.set(k.gruppe, []);
      gruppen.get(k.gruppe).push(k);
    }
    return [...gruppen.entries()].map(([gruppe, kriterien]) => ({ gruppe, kriterien }));
  }

  global.RaumMerkmale = {
    QUELLEN, KRITERIEN, KRITERIUM, DIN277, DIN277_FARBE, DIN277_KLASSE, FARBE_OHNE, OHNE,
    wert, einteilen, kennwerteJeGeschoss, steckbrief, auswahl, zahl,
    pruefungen, kennwerteJeZone, ifcWerte, IFC_KRITERIEN, GRENZEN, AUFENTHALT,
    _intern: { polygonAbstand, punktZuPolygon, ueberdecken, umriss },
  };

})(typeof window !== 'undefined' ? window : globalThis);
