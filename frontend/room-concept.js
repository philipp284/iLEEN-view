/**
 * iLEEN — Raumkonzept
 *
 * Räume nach Nutzung trennen, ihr Anforderungsprofil zeigen und ein
 * `raumkonzept.json` (Version 1) schreiben, das das Baustellen-Navi
 * (BIMLP/Dijkstra, `notebooks/Baustellen-Navi-Raumkonzept.ipynb`) einliest.
 *
 * Drei Schritte, die aufeinander aufbauen:
 *
 *   1. SAMMELN      — IfcSpace aus den geladenen Kacheln, optional ergänzt
 *                     über die Cesium-ion-Elements-API (vollständig statt nur
 *                     das, was gerade im Bild ist).
 *   2. EINORDNEN    — Raumname → Raumklasse über dieselben Regex-Muster wie
 *                     `raumklassen.csv`. Mit der Klasse hängt das komplette
 *                     Anforderungsprofil am Raum: Lux, Luftrate, Nutzlast,
 *                     Feuerwiderstand, Schallschutz, Anschlussleistung.
 *   3. AUSGEBEN     — Hüllquader je Raum, Türen daraus, Datei schreiben.
 *
 * Warum Hüllquader und nicht die IFC-Geometrie: Der Rechenweg im Navi stellt
 * drei Fragen — wer grenzt an wen, was steht auf was, wie groß ist die Hülle.
 * Ein achsparalleles Raster beantwortet alle drei. Die Feature-Geometrie eines
 * 3D-Tiles ist im Browser gar nicht abfragbar; die Elements-API liefert nur
 * Schwerpunkt und Radius. Deshalb wird das Raster gerechnet, nicht gemessen —
 * und die Räume werden im Viewer als genau diese Quader dargestellt. Was man
 * sieht, ist was exportiert wird.
 *
 * Seit Oktober 2026 ist das Panel zugleich die **Raumansicht**: Räume als ihre
 * eigenen Körper im Bau (Grundrissfigur aus dem Backend, nicht der Hüllquader),
 * anklickbar mit Steckbrief in der Eigenschaftsanzeige, nach Geschoss
 * gegliedert und gefiltert, eingefärbt nach Nutzung oder nach einem anderen
 * Kriterium — Nutzlast der Statik, Anschlussleistung, Außenluft, Schallschutz,
 * Brandschutz, DIN 277 … Was an einem Raum gilt und woher es kommt, rechnet
 * `raum-merkmale.js`; hier wird gesammelt, gezeichnet und bedient.
 *
 * Ladereihenfolge: nach core.js, features.js, ui.js und raum-merkmale.js
 */

'use strict';

(function (global) {

  // =====================================================
  // 1 · RAUMKLASSEN — Spiegel von data/raumklassen.csv
  // =====================================================
  //
  // Bewusst eine zweite Fassung derselben Tabelle: Der Viewer soll das
  // Anforderungsprofil zeigen können, ohne dass das Dijkstra-Repo daneben
  // liegt. `quelle` trägt den Normbezug mit, damit im Panel nicht nur eine
  // Zahl steht, sondern woher sie kommt.
  //
  // Bindend ist allein der Schlüssel `klasse` — er muss in raumklassen.csv
  // existieren, sonst bricht das Notebook beim Import ab. Zwei gewollte
  // Abweichungen gibt es:
  //
  //   • Die Muster sind an drei Stellen erweitert (`diele|entree|halle` beim
  //     Flur, `hauswirtschaft` bei der Technikzentrale). Realmodelle benennen
  //     das so; die Klasse dahinter bleibt dieselbe.
  //   • `fassade`, `rohbau` und `geruest` fehlen. Das sind keine Räume — sie
  //     entstehen im Navi je Geschoss aus NGF und Umfang, nicht aus IfcSpace.
  const RAUMKLASSEN = [
    { klasse: 'wohnen', bezeichnung: 'Wohnen und Schlafen (Wohnung)', zone: 'office', farbe: '#5FB878',
      muster: 'wohnen|wohnzimmer|wohnküche|wohnkueche|wohnraum|schlafen|schlafzimmer|schlafraum|kinderzimmer|gästezimmer|gaestezimmer|\\bessen\\b|esszimmer|essbereich|ankleide|living|bedroom|dining',
      lux: 200, luft: 1.3, abluft: 0, nutzlast: 2.0, feuchtraum: 0, rutsch: 'R9', brand: 0, fluchtweg: 0,
      schall: 37, elektro: 15, wasser: 0, personen_m2: 30, heizlast: 40, temp: 20,
      quelle: 'DIN 1946-6 / EC1 NA Kat A2 / DIN/TS 12831-1 · Licht: Empfehlung (EN 12464-1 gilt nicht für Wohnungen) · Schall: kein DIN-4109-Mindestwert innerhalb der Wohnung' },
    { klasse: 'buero', bezeichnung: 'Büro- und Arbeitsraum', zone: 'office', farbe: '#4A90D9',
      muster: 'buero|bÜro|arbeitszimmer|zimmer|sekr|kfm|controlling|marketing|vertrieb|verwaltung|leitung|chef|professor(?!.*(wc|toilet|küche|kueche|umkleide|dusch|pause|aufenthalt|besprech|lager|archiv|labor))|mitarbeiter(?!.*(wc|toilet|küche|kueche|umkleide|dusch|pause|aufenthalt|besprech|lager|archiv|labor))|hilfskr(?!.*(wc|toilet|küche|kueche|umkleide|dusch|pause|aufenthalt|besprech|lager|archiv|labor))|lehrbeauftr(?!.*(wc|toilet|küche|kueche|umkleide|dusch|pause|aufenthalt|besprech|lager|archiv|labor))|arbeitspl|drittmittel|open space|think ?t[ha]{1,2}nk|atelier|zeichensaal|\\boffice\\b|projektraum|büro',
      lux: 500, luft: 6, abluft: 0, nutzlast: 3.0, feuchtraum: 0, rutsch: 'R9', brand: 0, fluchtweg: 0,
      schall: 37, elektro: 25, wasser: 0, personen_m2: 10, heizlast: 45, temp: 20,
      quelle: 'EN 12464-1 T5.26 / EC1 NA Kat B1 / DIN 4109-1' },
    { klasse: 'besprechung', bezeichnung: 'Besprechung und Beratung', zone: 'office', farbe: '#3A7BC8',
      muster: 'besprech|meeting|beratung|konferenz|sitzung|schulung|seminar',
      lux: 500, luft: 12, abluft: 0, nutzlast: 3.0, feuchtraum: 0, rutsch: 'R9', brand: 0, fluchtweg: 0,
      schall: 45, elektro: 20, wasser: 0, personen_m2: 3, heizlast: 45, temp: 20,
      quelle: 'EN 12464-1 T5.26 / EN 16798-1 Kat II' },
    { klasse: 'versammlung', bezeichnung: 'Saal und Versammlungsfläche', zone: 'office', farbe: '#2E6BB8',
      muster: 'saal|aula|veranstalt|foyer gross|kantine|mensa|ausstellung|austellung|fitnessraum',
      lux: 300, luft: 15, abluft: 0, nutzlast: 5.0, feuchtraum: 0, rutsch: 'R9', brand: 30, fluchtweg: 1,
      schall: 45, elektro: 25, wasser: 0, personen_m2: 1.5, heizlast: 40, temp: 20,
      quelle: 'EC1 NA Kat C1 / MBO Versammlungsstätte' },
    { klasse: 'lounge', bezeichnung: 'Aufenthalt und Warten', zone: 'office', farbe: '#6BA8E5',
      muster: 'lounge|warten|aufenthalt|pause|ruheraum|empfang|rezeption|personal(?!.*(wc|toilet|küche|kueche|umkleide|dusch|pause|aufenthalt|besprech|lager|archiv|labor))',
      lux: 300, luft: 8, abluft: 0, nutzlast: 3.0, feuchtraum: 0, rutsch: 'R9', brand: 0, fluchtweg: 0,
      schall: 37, elektro: 15, wasser: 0, personen_m2: 4, heizlast: 45, temp: 20,
      quelle: 'EN 12464-1 T5.26.1 / EN 12831' },
    { klasse: 'teekueche', bezeichnung: 'Teeküche und Kaffeepunkt', zone: 'wet', farbe: '#17A2A2',
      muster: 'teekueche|teekÜche|kueche|kÜche|kaffee|kaffeepunkt|pantry|kitchen|teeküche|küche',
      lux: 300, luft: 20, abluft: 1, nutzlast: 3.0, feuchtraum: 0, rutsch: 'R10', brand: 0, fluchtweg: 0,
      schall: 37, elektro: 100, wasser: 1, personen_m2: 5, heizlast: 45, temp: 20,
      quelle: 'ASR A4.2 / EN 12464-1 T5.13 / DIN 1988-200' },
    { klasse: 'sanitaer', bezeichnung: 'Sanitärraum WC', zone: 'wet', farbe: '#14B8C4',
      muster: 'wc|toilet|sanit|urinal|waschraum',
      lux: 200, luft: 15, abluft: 1, nutzlast: 2.0, feuchtraum: 1, rutsch: 'R10', brand: 0, fluchtweg: 0,
      schall: 37, elektro: 15, wasser: 2, personen_m2: 5, heizlast: 55, temp: 20,
      quelle: 'ASR A4.1 / DIN 18534 / DIN 1988-200' },
    { klasse: 'bad', bezeichnung: 'Bad und Dusche', zone: 'wet', farbe: '#38D0E0',
      muster: 'badezimmer|bad\\b|dusch|du /|bathroom|shower',
      lux: 200, luft: 7, abluft: 1, nutzlast: 2.0, feuchtraum: 1, rutsch: 'R10', brand: 0, fluchtweg: 0,
      schall: 37, elektro: 30, wasser: 2, personen_m2: 99, heizlast: 60, temp: 24,
      quelle: 'DIN 18017-3 / DIN 18534 / EC1 NA Kat A2 / DIN/TS 12831-1 (Bäder 24 °C)' },
    { klasse: 'sanitaer_b', bezeichnung: 'Barrierefreies WC', zone: 'wet', farbe: '#0E9AA7',
      muster: 'beh.-wc|beh-wc|behinderten|barrierefrei|bf-wc',
      lux: 200, luft: 15, abluft: 1, nutzlast: 2.0, feuchtraum: 1, rutsch: 'R10', brand: 0, fluchtweg: 0,
      schall: 37, elektro: 15, wasser: 2, personen_m2: 7, heizlast: 55, temp: 20,
      quelle: 'DIN 18040-1 / ASR A4.1 / DIN 1988-200' },
    { klasse: 'putzraum', bezeichnung: 'Putz- und Reinigungsraum', zone: 'wet', farbe: '#2BC4B4',
      muster: 'putzr|reinigung|hausmeister|hauswart|pumi|putzmittel|\\bputz\\b',
      lux: 200, luft: 12, abluft: 1, nutzlast: 3.0, feuchtraum: 1, rutsch: 'R11', brand: 0, fluchtweg: 0,
      schall: 37, elektro: 15, wasser: 1, personen_m2: 10, heizlast: 40, temp: 15,
      quelle: 'ASR A4.1 / DIN 1988-200' },
    { klasse: 'garderobe', bezeichnung: 'Garderobe und Umkleide', zone: 'office', farbe: '#7FB8D9',
      muster: 'garderobe|umkleide|spind',
      lux: 200, luft: 8, abluft: 0, nutzlast: 3.0, feuchtraum: 0, rutsch: 'R9', brand: 0, fluchtweg: 0,
      schall: 37, elektro: 10, wasser: 0, personen_m2: 3, heizlast: 45, temp: 24,
      quelle: 'EN 12464-1 T5.11 / ASR A4.1 / DIN/TS 12831-1 (Umkleide 24 °C)' },
    { klasse: 'flur', bezeichnung: 'Notwendiger Flur', zone: 'core', farbe: '#E8A33D',
      muster: 'flur|korridor|gang|erschliess|erschließ|verkehrsflaeche|vorraum|windfang|vorzone|schleuse|foyer|entrance|corridor|hallway|\\bhall\\b|diele|entree|halle',
      lux: 100, luft: 4, abluft: 0, nutzlast: 5.0, feuchtraum: 0, rutsch: 'R9', brand: 30, fluchtweg: 1,
      schall: 32, elektro: 8, wasser: 0, personen_m2: 5, heizlast: 35, temp: 15,
      quelle: 'EN 12464-1 T5.1 / EC1 NA Kat B2 / MBO §36' },
    { klasse: 'treppenraum', bezeichnung: 'Notwendiger Treppenraum', zone: 'core', farbe: '#E0604A',
      muster: 'treppenr|treppenh|treppe|stiegenh|\\btrh\\b|staircase|stair',
      lux: 150, luft: 4, abluft: 0, nutzlast: 5.0, feuchtraum: 0, rutsch: 'R10', brand: 90, fluchtweg: 1,
      schall: 32, elektro: 8, wasser: 0, personen_m2: 5, heizlast: 30, temp: 15,
      quelle: 'EN 12464-1 T5.2 / EC1 NA Kat T2 / MBO §35' },
    { klasse: 'aufzug', bezeichnung: 'Aufzugsschacht und Vorraum', zone: 'core', farbe: '#C94F3D',
      muster: 'aufzug|lift|fahrstuhl',
      lux: 100, luft: 2, abluft: 0, nutzlast: 5.0, feuchtraum: 0, rutsch: 'R9', brand: 90, fluchtweg: 0,
      schall: 32, elektro: 10, wasser: 0, personen_m2: 20, heizlast: 0, temp: 0,
      quelle: 'MBO §39 / EN 81-20' },
    { klasse: 'lager', bezeichnung: 'Lager und Abstellraum', zone: 'office', farbe: '#9B8B7A',
      muster: 'lager|abstell|stuhllager|magazin|vorrat|geräteraum für|geräteraum|geraeteraum|kinderwagen|storage',
      lux: 200, luft: 3, abluft: 0, nutzlast: 5.0, feuchtraum: 0, rutsch: 'R9', brand: 0, fluchtweg: 0,
      schall: 32, elektro: 5, wasser: 0, personen_m2: 25, heizlast: 25, temp: 15,
      quelle: 'EN 12464-1 T5.22 / EC1 NA Kat E1.1' },
    { klasse: 'kita', bezeichnung: 'Gruppen- und Spielraum (Kita)', zone: 'office', farbe: '#E57BA8',
      muster: 'gruppenraum|krippe|kindergarten|kinderhort|bewegungsraum|spielraum|mehrzweckraum|nebenraum [uü]\\d|elternecke',
      lux: 300, luft: 8, abluft: 0, nutzlast: 3.0, feuchtraum: 0, rutsch: 'R9', brand: 0, fluchtweg: 0,
      schall: 47, elektro: 15, wasser: 1, personen_m2: 3, heizlast: 45, temp: 20,
      quelle: 'EN 12464-1 T5.36 / EC1 NA Kat C1 / DIN 4109-1 (wie Unterrichtsräume) / DIN 18041 / DGUV 102-602 / DIN/TS 12831-1' },
    { klasse: 'archiv', bezeichnung: 'Archiv Registratur und Tresor', zone: 'special', farbe: '#8B7355',
      muster: 'archiv|akten|registrat|tresor|dokument',
      lux: 300, luft: 3, abluft: 0, nutzlast: 10.0, feuchtraum: 0, rutsch: 'R9', brand: 90, fluchtweg: 0,
      schall: 37, elektro: 10, wasser: 0, personen_m2: 25, heizlast: 25, temp: 15,
      quelle: 'EC1 NA Kat E2.1 / EN 12464-1 T5.22' },
    { klasse: 'kopie', bezeichnung: 'Kopier- und Druckraum', zone: 'office', farbe: '#A88B6A',
      muster: 'kopie|druck|repro|plott',
      lux: 500, luft: 25, abluft: 1, nutzlast: 3.0, feuchtraum: 0, rutsch: 'R9', brand: 0, fluchtweg: 0,
      schall: 37, elektro: 60, wasser: 0, personen_m2: 15, heizlast: 40, temp: 20,
      quelle: 'EN 12464-1 T5.26.4 / RAL-UZ 205' },
    { klasse: 'server', bezeichnung: 'Serverraum und EDV-Zentrale', zone: 'special', farbe: '#8B5CF6',
      muster: 'server|edv|rechenz|datenverarb|it-raum|usv|netzwerkr|\\bhvt\\b|\\bisp\\b',
      lux: 300, luft: 60, abluft: 0, nutzlast: 10.0, feuchtraum: 0, rutsch: 'R9', brand: 90, fluchtweg: 0,
      schall: 45, elektro: 800, wasser: 0, personen_m2: 40, heizlast: 0, temp: 0,
      quelle: 'EN 50600-2-1 / EC1 NA Kat E2.1 / MBO §40' },
    { klasse: 'labor', bezeichnung: 'Labor und Versuchsfläche', zone: 'special', farbe: '#A855F7',
      muster: 'labor|versuch|prueff|prÜff|analytik|chemie|physik|schneideraum|prüff',
      lux: 500, luft: 50, abluft: 1, nutzlast: 10.0, feuchtraum: 1, rutsch: 'R11', brand: 90, fluchtweg: 0,
      schall: 45, elektro: 150, wasser: 2, personen_m2: 10, heizlast: 50, temp: 20,
      quelle: 'EN 12464-1 T5.24 / DGUV 213-850 / EC1 NA Kat E2.2' },
    { klasse: 'werkstatt', bezeichnung: 'Werkstatt und Technikerraum', zone: 'special', farbe: '#7C3AED',
      muster: 'werkstatt|techniker|montage|instandhalt|schlosser|laser|cnc|modellbau|fotostudio|photo',
      lux: 500, luft: 30, abluft: 1, nutzlast: 7.5, feuchtraum: 0, rutsch: 'R11', brand: 90, fluchtweg: 0,
      schall: 45, elektro: 120, wasser: 1, personen_m2: 15, heizlast: 45, temp: 17,
      quelle: 'EN 12464-1 T5.16 / EC1 NA Kat E2.1 / ASR A3.5 (17 °C)' },
    { klasse: 'technik_elt', bezeichnung: 'Elektro Hausanschluss und Verteilung', zone: 'plant', farbe: '#EF4444',
      muster: 'ha-elt|hausanschl|elt|niederspann|trafo|verteiler|zaehler|zÄhler|\\bhar\\b|\\bbma\\b|\\bsili\\b|sicherheitsbel|brandmelde|\\bbos\\b|nshv|zähler',
      lux: 300, luft: 10, abluft: 0, nutzlast: 7.5, feuchtraum: 0, rutsch: 'R9', brand: 90, fluchtweg: 0,
      schall: 45, elektro: 50, wasser: 0, personen_m2: 50, heizlast: 0, temp: 0,
      quelle: 'DIN VDE 0100-731 / MBO §40' },
    { klasse: 'technik_hzg', bezeichnung: 'Heizung Lüftung Sanitär Zentrale', zone: 'plant', farbe: '#F97316',
      muster: 'technikzentr|heizung|hzg|lueftung|lÜftung|rlt|hast|waermeueberg|haustechnik|technikr|\\btechnik\\b(?!.*(server|edv|elektro|\\belt\\b|usv))|technikfl|\\bhwr\\b|lüftung|hauswirtschaft',
      lux: 300, luft: 15, abluft: 0, nutzlast: 7.5, feuchtraum: 1, rutsch: 'R11', brand: 90, fluchtweg: 0,
      schall: 45, elektro: 60, wasser: 2, personen_m2: 50, heizlast: 20, temp: 15,
      quelle: 'DIN 18380 / EC1 NA Kat E2.1 / MBO §40' },
    { klasse: 'schacht', bezeichnung: 'Installationsschacht Steigstrang', zone: 'riser', farbe: '#78716C',
      muster: 'schacht|steigstrang|strang|installationssch|steigzone',
      lux: 100, luft: 0, abluft: 0, nutzlast: 0.0, feuchtraum: 0, rutsch: 'R9', brand: 90, fluchtweg: 0,
      schall: 0, elektro: 5, wasser: 1, personen_m2: 99, heizlast: 0, temp: 0,
      quelle: 'MBO §40 / DIN 18017' },
    { klasse: 'garage', bezeichnung: 'Tiefgarage und Stellplatzfläche', zone: 'special', farbe: '#6B7280',
      muster: 'garage|tiefgarage|stellplatz|parkdeck|parken|einstellplatz|stellfl',
      lux: 75, luft: 12, abluft: 1, nutzlast: 2.5, feuchtraum: 1, rutsch: 'R11', brand: 90, fluchtweg: 1,
      schall: 52, elektro: 8, wasser: 0, personen_m2: 99, heizlast: 0, temp: 0,
      quelle: 'EN 12464-1 T5.12 / EC1 NA Kat F / GaVO' },
  ];

  // Zonentypen — bestimmen im Navi die Schichtenfolge des Ausbaus (`ABLAUF`).
  const ZONEN_META = {
    office:  { label: 'Nutzfläche',    farbe: '#4A90D9' },
    wet:     { label: 'Nassbereich',   farbe: '#17A2A2' },
    core:    { label: 'Erschließung',  farbe: '#E8A33D' },
    special: { label: 'Sondernutzung', farbe: '#8B5CF6' },
    plant:   { label: 'Technik',       farbe: '#F97316' },
    riser:   { label: 'Steigstrang',   farbe: '#78716C' },
  };

  const KLASSE_INDEX = Object.fromEntries(RAUMKLASSEN.map((k) => [k.klasse, k]));

  // Vorkompiliert — die Muster laufen über jeden Raumnamen.
  const MUSTER = RAUMKLASSEN.map((k) => ({ klasse: k.klasse, re: new RegExp(k.muster, 'i') }));

  // Erschließung: diese Klassen tragen im Raster den Flurstreifen.
  const ERSCHLIESSUNG = new Set(['flur', 'treppenraum', 'aufzug']);

  /**
   * Raumname → Raumklasse.
   *
   * Die Reihenfolge in `RAUMKLASSEN` entscheidet bei Mehrdeutigkeit, und sie
   * ist nicht zufällig: `sanitaer_b` steht nach `sanitaer`, würde „Beh.-WC"
   * aber über das spezifischere Muster zuerst greifen — deshalb wird nicht der
   * erste Treffer genommen, sondern der mit dem längsten passenden Teilstring.
   * „Behinderten-WC" trifft `wc` (2 Zeichen) und `behinderten` (11); gewinnt
   * das längere, ist das barrierefreie WC erkannt.
   */
  function klassifiziere(name) {
    const text = String(name || '').trim();
    if (!text) return { klasse: null, treffer: '' };

    let beste = null;
    let laenge = 0;
    for (const m of MUSTER) {
      const treffer = text.match(m.re);
      if (treffer && treffer[0].length > laenge) {
        laenge = treffer[0].length;
        beste = { klasse: m.klasse, treffer: treffer[0] };
      }
    }
    return beste || { klasse: null, treffer: '' };
  }

  // =====================================================
  // 2 · EIGENSCHAFTEN AUS DEN KACHELN LESEN
  // =====================================================
  //
  // Revit, Allplan, ArchiCAD und der ion-Tiler benennen dieselbe Angabe
  // verschieden. Statt exakt zu vergleichen wird über Kandidatenlisten und
  // normalisierte Teilstrings gesucht — dieselbe Logik wie in
  // ifc-role-properties.js, aus demselben Grund.
  const FELD = {
    guid:     ['GlobalId', 'globalId', 'guid', 'GUID', 'ifcGuid', 'IfcGUID', 'elementId', 'id'],
    name:     ['LongName', 'longName', 'userLabel', 'Name', 'name', 'IfcName', 'Bezeichnung'],
    nummer:   ['Reference', 'reference', 'Nummer', 'number', 'roomNumber', 'RoomNumber', 'Raumnummer', 'nr'],
    flaeche:  ['footprintArea', 'NetFloorArea', 'netFloorArea', 'GrossFloorArea', 'grossFloorArea',
               'Area', 'area', 'Flaeche', 'Fläche', 'NetArea'],
    hoehe:    ['FinishCeilingHeight', 'ClearHeight', 'Height', 'height', 'NetHeight', 'Hoehe', 'Höhe'],
    geschoss: ['storey', 'Storey', 'BuildingStorey', 'Level', 'level', 'levelName', 'Geschoss', 'Ebene'],
    klasse:   ['className', 'iFCClassName', 'IfcEntity', 'element_type', 'IfcType', 'IFC_Type', 'ifcType'],
  };

  function normalisiere(s) {
    return String(s).toLowerCase()
      .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]/g, '');
  }

  /** Erster Kandidat, der in `props` einen nicht-leeren Wert hat. */
  function hole(props, kandidaten) {
    for (const key of kandidaten) {
      const v = props[key];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    // Zweiter Durchgang: normalisierter Teilstring — fängt `Qto_SpaceBase-
    // Quantities.NetFloorArea` und `Pset_SpaceCommon.Reference` mit ein.
    const ziele = kandidaten.map(normalisiere);
    for (const [key, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === '') continue;
      const nk = normalisiere(key);
      if (ziele.some((z) => nk.endsWith(z))) return v;
    }
    return null;
  }

  function zahl(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  // =====================================================
  // 3 · ZUSTAND
  // =====================================================
  const RC = {
    raeume: [],          // gesammelte und eingeordnete Räume
    geschosse: [],       // {key, z, hoehe, laenge, breite, bgf}
    entities: [],        // dargestellte Quader
    quelle: '—',         // woher die Räume stammen (für die Anzeige)
    unvollstaendig: false,
    // Voreinstellung ist die Lage im Bau: „wo liegt welche Nutzung" ist die
    // Frage, die sich beim Öffnen stellt. Das Raster ist der Sonderfall für
    // den Export ins Baustellen-Navi und wird gezielt eingeschaltet.
    layout: 'modell',    // 'modell' (Lage im Bau) | 'raster' (Export-Zweibund)
    projektname: 'Raumkonzept',
    sichtbar: false,
    nurRaeume: false,
    // Geschosse, die gezeigt werden — leer heißt alle. Eine Menge und kein
    // einzelner Schlüssel, weil man zwei übereinanderliegende Geschosse
    // zusammen sehen will, wenn es um Steigstränge geht.
    geschossWahl: new Set(),
    klassenFilter: new Set(),    // Raumklassen; '' steht für „ohne Klasse"
    kriterium: 'klasse',         // wonach eingefärbt wird (raum-merkmale.js)
    legendenFilter: new Set(),   // Legendenzeilen des Kriteriums, die gezeigt werden
    suchText: '',
    auswahl: null,               // GlobalId des gewählten Raums
    hover: null,
    stempel: true,               // Raumstempel im Bild
    freischnitt: true,           // Modell über dem Geschoss wegschneiden
    hoehenOffset: 0,
    _origin: null,       // Cesium.Cartographic — Ursprung des lokalen Systems
  };

  // =====================================================
  // 4 · SAMMELN
  // =====================================================

  /**
   * Räume aus den geladenen Kacheln.
   *
   * Grenze, die im Panel auch so benannt wird: Cesium hält nur die Kacheln
   * im Speicher, die für die aktuelle Ansicht gebraucht werden. Wer aus der
   * Ferne auf das Gebäude schaut, sieht grobe Kacheln — und findet damit
   * weniger Räume als das Modell hat. Vollständig wird es erst über die
   * Elements-API oder nachdem man einmal durch alle Geschosse gefahren ist.
   */
  function sammleAusKacheln(tileset) {
    const gefunden = new Map();
    if (!tileset || !tileset.root) return gefunden;

    // features.js merkt sich das erkannte Klassenfeld am **Asset**, nicht am
    // Viewer — `BimViewer.ifcPropertyName` gibt es nicht und war immer leer.
    const klasseFeld = aktivesAsset()?.ifcPropertyName || null;

    const ausContent = (content) => {
      if (!content) return;
      if (content.innerContents) {
        content.innerContents.forEach(ausContent);
        return;
      }
      const n = content.featuresLength || 0;
      for (let i = 0; i < n; i++) {
        let feature;
        try { feature = content.getFeature(i); } catch (_) { continue; }
        if (!feature) continue;

        let props;
        try {
          props = {};
          for (const id of feature.getPropertyIds()) props[id] = feature.getProperty(id);
        } catch (_) { continue; }

        const typ = String(hole(props, klasseFeld ? [klasseFeld, ...FELD.klasse] : FELD.klasse) || '');
        if (normalisiere(typ) !== 'ifcspace') continue;

        const guid = String(hole(props, FELD.guid) || `tile-${gefunden.size}`);
        if (gefunden.has(guid)) continue;
        gefunden.set(guid, { guid, props, feature });
      }
    };

    const durchlaufe = (tile, tiefe) => {
      if (!tile || tiefe > 24) return;
      ausContent(tile.content);
      (tile.children || []).forEach((k) => durchlaufe(k, tiefe + 1));
    };

    durchlaufe(tileset.root, 0);
    // `_selectedTiles` sind die gerade gezeichneten — bei Modellen mit
    // Sprung-LOD hängt deren Inhalt nicht am Wurzelbaum.
    (tileset._selectedTiles || []).forEach((t) => ausContent(t.content));
    return gefunden;
  }

  /**
   * Räume aus dem eigenen Backend — der einzige Weg bei Backend-Modellen.
   *
   * Über die Kacheln ist hier nichts zu holen, und das ist kein Fehler,
   * sondern Absicht: Der Tiler hält `IfcSpace` über `IFC_EXCLUDE_TYPES`
   * heraus, weil der Raumkörper sonst als massiver Quader jede Wand darunter
   * zudeckt (`tiling/formats/ifc.py`). Das Raumverzeichnis entsteht trotzdem —
   * `tiling/section.py::_room_index` braucht es für die Raumstempel im
   * Grundriss — und `GET /assets/{job_id}/rooms` reicht es heraus.
   *
   * Mitgeliefert wird der Hüllquader im tile-lokalen System. Damit stehen die
   * Räume an ihrer Stelle im Bau, ohne dass ein Bezugspunkt geschätzt werden
   * müsste.
   */
  async function sammleAusBackend(jobId) {
    const basis = global.BimViewer?.getBackendUrl?.();
    if (!basis) throw new Error('Keine Backend-Adresse bekannt.');

    // Mit Grundrissfigur: die Räume erscheinen dann als ihr eigener Körper.
    // Als Hüllquader überdeckte ein L-förmiger Raum seine Kerbe, und zwei
    // Nachbarn ragten ineinander.
    const resp = await fetch(`${basis}/assets/${encodeURIComponent(jobId)}/rooms?grundriss=true`);
    if (!resp.ok) {
      // 422 wirft `build_index` bei einer Datei ohne verwertbare Geometrie —
      // eine andere Aussage als „keine Räume", und sie gehört auch anders
      // gemeldet.
      const text = await resp.text().catch(() => '');
      const fehler = new Error(`HTTP ${resp.status}${text ? ' — ' + text.slice(0, 200) : ''}`);
      fehler.status = resp.status;
      throw fehler;
    }

    const liste = await resp.json();
    const gefunden = new Map();
    for (const r of liste || []) {
      const guid = String(r.global_id || `bk-${gefunden.size}`);
      gefunden.set(guid, {
        guid,
        // In die Form bringen, die `bereiteAuf` ohnehin liest: `Name` ist im
        // IFC die Raumnummer und `LongName` die Nutzung — genau andersherum,
        // als die Namen vermuten lassen.
        props: {
          GlobalId: guid,
          LongName: r.long_name,
          Reference: r.name,
          storey: r.storey,
          NetFloorArea: r.flaeche_m2,
          Height: r.hoehe_m,
          className: 'IfcSpace',
        },
        box: (Array.isArray(r.lo) && Array.isArray(r.hi)) ? { lo: r.lo, hi: r.hi } : null,
        // Was nur das Backend weiß: die Grundrissfigur, was die Psets über den
        // Raum sagen (je Angabe mit Fundstelle) und die Nutzlastkategorie, mit
        // der der Lastabtrag rechnet.
        extra: {
          grundriss: Array.isArray(r.grundriss) ? r.grundriss : null,
          merkmale: r.merkmale || {},
          ifc: r.ifc || {},
          nutzlast: r.nutzlast || null,
          flaecheQuelle: r.flaeche_quelle || null,
          volumen: Number.isFinite(r.volumen_m3) ? r.volumen_m3 : null,
          volumenQuelle: r.volumen_quelle || null,
        },
      });
    }
    return gefunden;
  }

  /**
   * Räume über die Cesium-ion-Elements-API — vollständig, mit Lage.
   *
   * Nur Assets aus der neuen ion-Ingestion tragen diese Daten; bei allen
   * anderen antwortet die API mit 400, und wir bleiben bei den Kacheln.
   */
  async function sammleAusElementsAPI(assetId, token) {
    const gefunden = new Map();
    const params = new URLSearchParams({
      where: "iFCClassName = 'ifcspace'",
      limit: '1000',
    });
    let url = `https://api.cesium.com/assets/${assetId}/elements?${params}`;

    while (url) {
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error(`Elements-API: HTTP ${resp.status}`);
      const data = await resp.json();

      for (const item of data.items || []) {
        const props = { ...(item.properties || item), ...(item.metadata || {}) };
        const guid = String(item.id ?? hole(props, FELD.guid) ?? `el-${gefunden.size}`);
        gefunden.set(guid, { guid, props, location: item.location || null });
      }

      const link = resp.headers.get('Link');
      const m = link?.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
    return gefunden;
  }

  /**
   * Rohdaten → Räume mit Klasse und Anforderungsprofil.
   *
   * Was hier passiert, ist die eigentliche fachliche Arbeit: Ein Raum ohne
   * Klasse ist für das Navi wertlos, weil daran das gesamte Anforderungsprofil
   * hängt. Deshalb wird nicht geraten — was das Muster nicht erkennt, bekommt
   * `klasse: null` und steht im Panel oben unter „ungeklärt". Ein Mensch
   * entscheidet dort, und erst dann geht der Raum in den Export.
   */
  function bereiteAuf(roh) {
    const raeume = [];
    let i = 0;

    for (const [guid, eintrag] of roh) {
      const props = eintrag.props || {};
      const name = String(hole(props, FELD.name) || '').trim() || `Raum ${++i}`;
      const nummerRoh = hole(props, FELD.nummer);
      const geschoss = String(hole(props, FELD.geschoss) || 'ohne Geschoss').trim();

      const flaeche = zahl(hole(props, FELD.flaeche));
      const hoehe = zahl(hole(props, FELD.hoehe));
      const extra = eintrag.extra || {};
      let { klasse, treffer } = klassifiziere(`${name} ${nummerRoh || ''}`);
      let erkannt = klasse ? 'regel' : null;
      // Eine Raumklasse, die iLEEN selbst ins IFC geschrieben hat
      // (`Pset_iLEEN_Raum.Raumklasse`), sticht den Namen: sie ist die
      // Entscheidung, die beim letzten Mal galt — oft von Hand getroffen.
      const ileen = extra.merkmale && extra.merkmale.ileen_klasse;
      if (ileen && KLASSE_INDEX[ileen.wert]) {
        klasse = ileen.wert;
        treffer = '';
        erkannt = ileen.herkunft === 'hand' ? 'hand' : 'ifc';
      }
      // Trifft der Name nichts, darf die Nutzung aus den Psets helfen —
      // ArchiCAD schreibt „Büroarbeit" in `Pset_SpaceCommon.Category`, auch
      // wenn der Raum „0.08" heißt. Sie kommt erst an zweiter Stelle, damit
      // sich an Räumen, die schon am Namen erkannt wurden, nichts ändert.
      const ifcNutzung = extra.merkmale && extra.merkmale.nutzung && extra.merkmale.nutzung.wert;
      if (!klasse && ifcNutzung) {
        const ausIfc = klassifiziere(String(ifcNutzung));
        if (ausIfc.klasse) {
          klasse = ausIfc.klasse;
          treffer = ausIfc.treffer;
          erkannt = 'ifc';
        }
      }

      raeume.push({
        guid,
        nr: String(nummerRoh ?? '').trim(),
        name,
        geschoss,
        flaeche: flaeche && flaeche > 0 ? Math.round(flaeche * 10) / 10 : null,
        hoehe: hoehe && hoehe > 0.5 ? Math.round(hoehe * 100) / 100 : null,
        klasse,
        klasseAuto: klasse,          // was das Muster vorschlug
        treffer,                     // welcher Teilstring — im Panel nachvollziehbar
        // Woher die Klasse kommt: 'regel' (Raumname), 'ifc' (Nutzung aus den
        // Psets), 'hand'. Die beiden Zieldateien führen dafür unterschiedliche
        // Vokabulare, deshalb steht hier die Sache selbst und nicht schon der
        // Ausgabewert — siehe `herkunftFuer`.
        erkannt,
        location: eintrag.location || null,
        // Der Hüllquader im tile-lokalen System, wenn er vom Backend kommt.
        // Damit lässt sich der Raum an seiner Stelle zeichnen, statt ihn ins
        // gerechnete Raster zu setzen — siehe `KOERPER`.
        box: eintrag.box || null,
        grundriss: extra.grundriss || null,
        merkmale: extra.merkmale || {},
        ifc: extra.ifc || {},
        nutzlast: extra.nutzlast || null,
        flaecheQuelle: extra.flaecheQuelle || null,
        volumen: extra.volumen || null,
        volumenQuelle: extra.volumenQuelle || null,
        props,
      });
    }

    // Stabile Reihenfolge: Geschoss, dann Nummer, dann Name.
    raeume.sort((a, b) =>
      a.geschoss.localeCompare(b.geschoss, 'de', { numeric: true }) ||
      String(a.nr).localeCompare(String(b.nr), 'de', { numeric: true }) ||
      a.name.localeCompare(b.name, 'de'));

    return raeume;
  }

  /**
   * Geschosse ordnen — von unten nach oben.
   *
   * Das Notebook prüft die Reihenfolge (`EBENEN == sorted(EBENEN)`). Liegen
   * Höhen aus der Elements-API vor, entscheiden sie; sonst wird nach dem
   * üblichen deutschen Schema sortiert: UG unter EG unter OG unter DG.
   */
  /** Geschossname → Rang nach dem üblichen deutschen Schema, UG unter EG unter OG unter DG. */
  function geschossRang(key) {
    const k = String(key).toLowerCase();
    let m = k.match(/(\d+)\.?\s*(og|obergeschoss)/);
    if (m) return 100 + parseInt(m[1], 10);
    m = k.match(/(\d+)\.?\s*(ug|untergeschoss|kg|keller)/);
    if (m) return -100 - parseInt(m[1], 10);
    if (/\b(ug|untergeschoss|keller|kg|tiefgarage|tg)\b/.test(k)) return -100;
    if (/\b(eg|erdgeschoss|ground)\b/.test(k)) return 0;
    if (/\b(og|obergeschoss)\b/.test(k)) return 100;
    if (/\b(dg|dach|attika|staffel)\b/.test(k)) return 900;
    m = k.match(/-?\d+/);
    return m ? parseInt(m[0], 10) : 500;
  }

  function ordneGeschosse(raeume) {
    const rang = geschossRang;

    const gruppen = new Map();
    for (const r of raeume) {
      if (!gruppen.has(r.geschoss)) gruppen.set(r.geschoss, []);
      gruppen.get(r.geschoss).push(r);
    }

    // Mittlere Lage aus der Elements-API, falls vorhanden — sie schlägt das
    // Namensschema, weil sie gemessen ist und nicht geraten.
    const hoeheAus = (rs) => {
      const werte = rs.map((r) => r.location?.center?.height).filter(Number.isFinite);
      return werte.length ? werte.reduce((a, b) => a + b, 0) / werte.length : null;
    };

    const liste = [...gruppen.entries()].map(([key, rs]) => ({
      key, raeume: rs, gemessen: hoeheAus(rs), rang: rang(key),
    }));

    const alleGemessen = liste.every((g) => g.gemessen !== null);
    liste.sort((a, b) => (alleGemessen ? a.gemessen - b.gemessen : a.rang - b.rang)
      || a.key.localeCompare(b.key, 'de', { numeric: true }));

    // Höhen auf ein lokales System ziehen: unterstes Geschoss auf z = 0.
    const basis = alleGemessen ? Math.min(...liste.map((g) => g.gemessen)) : 0;
    let z = 0;
    return liste.map((g) => {
      const raumhoehen = g.raeume.map((r) => r.hoehe).filter((h) => h && h > 0.5);
      const lichteHoehe = raumhoehen.length
        ? Math.round((raumhoehen.reduce((a, b) => a + b, 0) / raumhoehen.length) * 100) / 100
        : 2.75;
      const zEbene = alleGemessen ? Math.round((g.gemessen - basis) * 100) / 100 : z;
      z += Math.round((lichteHoehe + 0.38) * 100) / 100;   // + Deckenpaket
      return { key: g.key, z: zEbene, hoehe: lichteHoehe, raeume: g.raeume };
    });
  }

  // =====================================================
  // 5 · RASTERLAYOUT — Zweibund am Mittelflur
  // =====================================================
  //
  // Jeder Raum bekommt einen achsparallelen Hüllquader. Die Regel, die alles
  // andere bestimmt: **jeder Nutzraum muss an den Flurstreifen grenzen.** Nur
  // dann findet der geometrische Weg im Notebook dieselben Türverbindungen,
  // die hier erklärt werden — und genau das prüft es mit einer Assertion.
  //
  // Aufbau je Geschoss:
  //
  //      ┌──────────────────────────────────┐  y = B
  //      │  Nordbund: Nutzräume nebeneinander│
  //      ├──────────────────────────────────┤  y = tSued + bFlur
  //      │  Flurstreifen (Segment 1 … n)     │
  //      ├──────────────────────────────────┤  y = tSued
  //      │  Südbund: Nutzräume nebeneinander │
  //      └──────────────────────────────────┘  y = 0
  //      x = 0                            x = L
  //
  // Die Breite eines Raums folgt aus seiner Fläche: w = A / Bundtiefe. Weil
  // die Bundtiefe je Seite aus der Seitensumme gerechnet wird, füllen die
  // Räume ihre Seite exakt aus und die Quaderfläche stimmt mit der Raumfläche
  // überein — das Raster erfindet keine Fläche und verliert keine.

  const STANDARDFLAECHE = 15.0;    // Raum ohne Flächenangabe — sichtbar markiert

  // ASR A2.3 für Flure mit bis zu 20 Personen. Ein schmalerer Streifen wird
  // aufgeweitet — der Quader deckt dann mehr Fläche ab, als der Flur laut
  // Modell hat. Das ist hingenommen: Gerechnet wird im Navi mit `flaeche`,
  // der Quader trägt nur die Topologie. Ein 60 cm breiter „Flur" wäre dagegen
  // im Bild wie in der Sache falsch.
  const MIN_FLURBREITE = 1.4;

  function baueRaster(geschosse) {
    const A = (r) => r.flaeche || STANDARDFLAECHE;
    const flaecheJeGeschoss = geschosse.map((g) => g.raeume.reduce((s, r) => s + A(r), 0));

    // Eine Gebäudelänge für alle Geschosse — sonst verjüngt sich der Bau nach
    // oben und der Lastpfad, den das Navi daraus ableitet („was steht auf
    // was"), stimmt nicht mehr. Die Länge folgt dem größten Geschoss bei
    // einem Seitenverhältnis von ~1.4, der üblichen Proportion eines
    // Zweibunds; die Gebäudetiefe darf je Geschoss schwanken, weil sie das
    // Übereinanderstehen in x nicht antastet.
    const L = Math.max(6, Math.round(Math.sqrt(Math.max(...flaecheJeGeschoss, 1) * 1.4) * 100) / 100);

    for (const g of geschosse) {
      const raeume = g.raeume;
      for (const r of raeume) if (!r.flaeche) r.flaecheGeschaetzt = true;

      // Den Streifen bildet der Flur — und nur er. Läge der Treppenraum
      // ebenfalls darin, hinge die Hälfte der Nutzräume an ihm statt am Flur,
      // und die Türgradverteilung, aus der das Navi die Erschließung liest,
      // zeigte auf den falschen Raum. Ein Treppenraum hat zwei Türen, keine
      // sechs. Er wird deshalb wie ein Nutzraum in den Bund gesetzt und
      // schließt von dort an den Flur an. Nur wenn ein Geschoss gar keinen
      // Flur führt, übernehmen Treppenraum und Aufzug diese Rolle.
      let flure = raeume.filter((r) => r.klasse === 'flur');
      if (!flure.length) flure = raeume.filter((r) => ERSCHLIESSUNG.has(r.klasse));
      const imStreifen = new Set(flure);
      const nutz = raeume.filter((r) => !imStreifen.has(r));
      raeume.forEach((r) => { r.imStreifen = imStreifen.has(r); });

      const aNutz = nutz.reduce((s, r) => s + A(r), 0);
      const aFlur = flure.reduce((s, r) => s + A(r), 0);
      const aGes = aNutz + aFlur;
      if (aGes <= 0) { g.laenge = 0; g.breite = 0; g.bgf = 0; continue; }

      // Nutzräume auf zwei Seiten verteilen (LPT: größter Raum zur leereren
      // Seite). Das hält die Bundtiefen ähnlich und den Grundriss plausibel.
      const nord = [], sued = [];
      let aN = 0, aS = 0;
      for (const r of [...nutz].sort((a, b) => A(b) - A(a))) {
        if (aN <= aS) { nord.push(r); aN += A(r); } else { sued.push(r); aS += A(r); }
      }

      const tN = aN > 0 ? aN / L : 0;
      const tS = aS > 0 ? aS / L : 0;
      const bFlur = Math.max(MIN_FLURBREITE, aFlur > 0 ? aFlur / L : MIN_FLURBREITE);
      const B = tN + tS + bFlur;

      const yFlurLo = tS;
      const yFlurHi = tS + bFlur;
      const zLo = g.z;
      const zHi = g.z + g.hoehe;

      // Flurstreifen längs aufteilen — jedes Flursegment ein eigener Raum.
      // Ohne Flurraum im Modell bleibt der Streifen leer: Die Nutzräume
      // grenzen dann über den Streifen hinweg nicht aneinander, und die
      // Türlogik unten verbindet stattdessen die Nachbarn im selben Bund.
      let x = 0;
      for (const r of flure) {
        const w = aFlur > 0 ? (A(r) / aFlur) * L : L / Math.max(flure.length, 1);
        setzeQuader(r, x, yFlurLo, zLo, x + w, yFlurHi, zHi);
        x += w;
      }
      if (flure.length) {
        // Rundungsreste auf das letzte Segment — der Streifen soll bündig
        // abschließen, sonst entsteht am Ende eine Lücke ohne Anschluss.
        const letzte = flure[flure.length - 1];
        letzte.hi[0] = L;
      }

      const bundSetzen = (liste, yLo, tiefe) => {
        if (!tiefe) return;
        // Wieder in Lesereihenfolge bringen — die LPT-Verteilung oben hat
        // nach Fläche sortiert, im Grundriss soll die Nummer laufen.
        liste.sort((a, b) => String(a.nr).localeCompare(String(b.nr), 'de', { numeric: true })
          || a.name.localeCompare(b.name, 'de'));
        let xi = 0;
        liste.forEach((r, idx) => {
          const w = A(r) / tiefe;
          const xEnde = idx === liste.length - 1 ? L : xi + w;
          setzeQuader(r, xi, yLo, zLo, xEnde, yLo + tiefe, zHi);
          xi = xEnde;
        });
      };

      bundSetzen(sued, 0, tS);
      bundSetzen(nord, yFlurHi, tN);

      g.laenge = Math.round(L * 100) / 100;
      g.breite = Math.round(B * 100) / 100;
      g.bgf = Math.round(L * B * 10) / 10;
    }
    return geschosse;
  }

  function setzeQuader(r, x0, y0, z0, x1, y1, z1) {
    const r3 = (v) => Math.round(v * 1000) / 1000;
    // Entartete Quader lehnt das Notebook ab (`hi - lo > 0`). Ein Raum mit
    // 0.2 m² Fläche darf nicht zu einer Nullbreite gerundet werden.
    const eps = 0.01;
    r.lo = [r3(x0), r3(y0), r3(z0)];
    r.hi = [r3(Math.max(x1, x0 + eps)), r3(Math.max(y1, y0 + eps)), r3(Math.max(z1, z0 + eps))];
  }

  // =====================================================
  // 6 · TÜREN AUS DER GEOMETRIE
  // =====================================================
  //
  // Die Türen werden nicht aus dem Modell übernommen, sondern aus den fertigen
  // Quadern gerechnet. Der Grund steht im Notebook: Es prüft jede erklärte
  // Türverbindung gegen die Lage — der Türschwerpunkt muss im (leicht
  // aufgeweiteten) Quader **beider** Räume liegen. Eine Tür aus dem IFC träfe
  // das Raster nicht, und der Import bräche mit einer Assertion ab.
  //
  // Umgekehrt herum ist es fehlerfrei: Wer die Tür in die gemeinsame Fläche
  // zweier aneinandergrenzender Quader setzt, erfüllt die Prüfung immer.

  const BERUEHRUNG = 0.05;   // zwei Quader gelten als benachbart, wenn ihr
                             // Abstand darunter liegt (Rundungsreste)

  function baueTueren(geschosse) {
    const tueren = [];

    for (const g of geschosse) {
      const rs = g.raeume.filter((r) => r.lo && r.hi);
      const flure = rs.filter((r) => r.imStreifen);
      let n = 0;

      const verbinde = (a, b) => {
        const punkt = beruehrpunkt(a, b);
        if (!punkt) return false;
        tueren.push({
          id: `${g.key}#T${++n}`,
          raeume: [a.exportId, b.exportId],
          lo: punkt.map((v, i) => Math.round((v - (i === 2 ? 0.0 : 0.05)) * 1000) / 1000),
          hi: punkt.map((v, i) => Math.round((v + (i === 2 ? 0.0 : 0.05)) * 1000) / 1000),
        });
        return true;
      };

      // 1. Flursegmente untereinander — der Streifen muss durchgängig sein.
      for (let i = 0; i < flure.length; i++) {
        for (let j = i + 1; j < flure.length; j++) verbinde(flure[i], flure[j]);
      }

      // 2. Jeder Nutzraum an den Flur, an den er tatsächlich grenzt.
      const ohneAnschluss = [];
      for (const r of rs) {
        if (r.imStreifen) continue;
        const angrenzend = flure.filter((f) => beruehrpunkt(r, f));
        if (!angrenzend.length) { ohneAnschluss.push(r); continue; }
        // Der Flur mit der größten gemeinsamen Kante — bei einem Raum über
        // zwei Segmenten ist das der, an dem die Tür sinnvoll sitzt.
        angrenzend.sort((a, b) => kantenlaenge(r, b) - kantenlaenge(r, a));
        verbinde(r, angrenzend[0]);
      }

      // 3. Räume ohne Flur — im Modell gibt es keinen. Dann grenzen sie
      //    aneinander, und die Reihe wird als Raumfolge verbunden. Das ist
      //    fachlich schlechter (keine Erschließung), aber ehrlich: Es
      //    behauptet keine Flure, die das Modell nicht hat.
      for (const r of ohneAnschluss) {
        for (const s of rs) {
          if (s === r || !beruehrpunkt(r, s)) continue;
          if (tueren.some((t) => t.raeume.includes(r.exportId) && t.raeume.includes(s.exportId))) continue;
          if (verbinde(r, s)) break;
        }
      }
    }
    return tueren;
  }

  /** Mittelpunkt der gemeinsamen Fläche zweier Quader — oder null. */
  function beruehrpunkt(a, b) {
    const mitte = [];
    for (let i = 0; i < 3; i++) {
      const lo = Math.max(a.lo[i], b.lo[i]);
      const hi = Math.min(a.hi[i], b.hi[i]);
      // Überlappung: Mitte. Berührung: die gemeinsame Ebene. Alles darüber
      // hinaus sind zwei Quader, die nichts miteinander zu tun haben.
      if (hi >= lo) mitte.push((lo + hi) / 2);
      else if (lo - hi <= BERUEHRUNG) mitte.push((lo + hi) / 2);
      else return null;
    }
    return mitte;
  }

  /** Länge der gemeinsamen Kante in der Ebene — zum Vergleich zweier Anschlüsse. */
  function kantenlaenge(a, b) {
    let laenge = 0;
    for (let i = 0; i < 2; i++) {
      laenge = Math.max(laenge, Math.min(a.hi[i], b.hi[i]) - Math.max(a.lo[i], b.lo[i]));
    }
    return laenge;
  }

  // =====================================================
  // 7 · DAS KONZEPT BAUEN
  // =====================================================

  /**
   * Aus den gesammelten Räumen die vollständige Konzeptstruktur.
   *
   * Räume ohne Klasse bleiben draußen — im Navi hängt an der Klasse das
   * Anforderungsprofil, und ein geratener Wert wäre dort nicht als geraten
   * erkennbar. Sie werden gezählt und im Panel benannt.
   */
  function baueKonzept() {
    const brauchbar = RC.raeume.filter((r) => r.klasse && KLASSE_INDEX[r.klasse]);
    const geschosse = ordneGeschosse(brauchbar);

    // Export-Ids: eindeutig und lesbar. Das Notebook prüft die Eindeutigkeit;
    // Raumnummern taugen dafür nicht — im Testmodell heißen Flur und
    // Behinderten-WC im Erdgeschoss beide `0.14`.
    geschosse.forEach((g) => {
      g.raeume.forEach((r, i) => {
        r.exportId = `${g.key}-${String(i + 1).padStart(2, '0')}`;
      });
    });

    baueRaster(geschosse);
    const tueren = baueTueren(geschosse);

    RC.geschosse = geschosse;
    return { geschosse, tueren, verworfen: RC.raeume.length - brauchbar.length };
  }

  /**
   * Woher die Klasse stammt — je Zieldatei im dortigen Vokabular.
   *
   * `raumbuch.csv` kennt `regel` für „vom Muster erkannt". `raumkonzept.json`
   * kennt das nicht: Sein Notebook lässt nur `konzept` und `hand` zu und
   * begründet das damit, dass auf dem Konzeptweg nichts geraten sein darf.
   * Ein Regex-Muster rät nicht — es ist dieselbe deterministische Regel, die
   * auch der IFC-Weg anwendet —, also ist `konzept` dort die richtige
   * Einordnung. Damit die Unterscheidung trotzdem nicht verlorengeht, trägt
   * jeder Raum im JSON zusätzlich `erkannt` und `muster`. Beide Felder liest
   * das Notebook nicht; sie stehen für den Menschen da, der die Datei prüft.
   */
  function herkunftFuer(r, ziel) {
    if (r.erkannt === 'hand') return 'hand';
    return ziel === 'csv' ? 'regel' : 'konzept';
  }

  /** Die Datei, so wie `lies_konzept` sie erwartet. */
  function konzeptDaten() {
    const { geschosse, tueren } = baueKonzept();
    const jetzt = new Date();
    const stempel = jetzt.toISOString().slice(0, 19).replace('T', ' ');

    const raeume = [];
    for (const g of geschosse) {
      for (const r of g.raeume) {
        const kl = KLASSE_INDEX[r.klasse];
        const flaeche = Math.round((r.flaeche || STANDARDFLAECHE) * 10) / 10;
        raeume.push({
          id: r.exportId,
          nr: r.nr || r.exportId,
          name: r.name,
          nutzung: r.name,
          geschoss: g.key,
          klasse: r.klasse,
          herkunft: herkunftFuer(r, 'json'),
          flaeche,
          sollFlaeche: flaeche,
          anzahl: 1,
          hoehe: Math.round((r.hoehe || g.hoehe) * 100) / 100,
          personen: kl.personen_m2 >= 90 ? 0 : Math.round((flaeche / kl.personen_m2) * 10) / 10,
          einheit: null,
          lo: r.lo,
          hi: r.hi,
          teile: [{ lo: r.lo, hi: r.hi }],
          // Zusatz gegenüber dem Studio, vom Notebook nicht gelesen: der
          // Rückweg ins Fachmodell und die Spur, wie die Klasse zustande kam.
          // Wer die Datei prüft, sieht damit ohne den Viewer, welcher
          // Namensbestandteil die Einordnung ausgelöst hat.
          ifcGuid: r.guid,
          erkannt: r.erkannt,
          muster: r.treffer || null,
        });
      }
    }

    return {
      version: 1,
      erzeugt: stempel,
      werkzeug: 'iLEEN · Raumkonzept aus dem Fachmodell',
      name: RC.projektname,
      profil: 'ifc',
      detail: 'modell',
      grundriss: {
        laenge: geschosse.length ? Math.max(...geschosse.map((g) => g.laenge || 0)) : 0,
        breite: geschosse.length ? Math.max(...geschosse.map((g) => g.breite || 0)) : 0,
      },
      raster: 'nutzung',
      geschosse: geschosse.map((g) => ({
        key: g.key,
        z: Math.round(g.z * 100) / 100,
        hoehe: Math.round(g.hoehe * 100) / 100,
        laenge: g.laenge,
        breite: g.breite,
        bgf: g.bgf,
      })),
      einheiten: [],
      raeume,
      tueren,
    };
  }

  /** Dieselben Räume als `raumbuch.csv` — der Weg über das Fachmodell. */
  function raumbuchCSV() {
    const { geschosse, tueren } = baueKonzept();
    const kopf = ['raum_nr', 'bezeichnung', 'geschoss', 'flaeche_m2', 'hoehe_m', 'klasse',
      'herkunft', 'zone', 'lux', 'luft_m3_hm2', 'nutzlast_kN_m2', 'brand_F', 'schall_dB',
      'elektro_W_m2', 'tueren', 'liegt_ueber', 'varianten', 'ifc_guid'];

    const grad = {};
    for (const t of tueren) for (const id of t.raeume) grad[id] = (grad[id] || 0) + 1;

    const zeilen = [kopf.join(';')];
    for (const g of geschosse) {
      for (const r of g.raeume) {
        const kl = KLASSE_INDEX[r.klasse];
        zeilen.push([
          r.nr || r.exportId, r.name, g.key,
          Math.round((r.flaeche || STANDARDFLAECHE) * 10) / 10,
          Math.round((r.hoehe || g.hoehe) * 100) / 100,
          r.klasse, herkunftFuer(r, 'csv'), kl.zone, kl.lux, kl.luft, kl.nutzlast,
          kl.brand, kl.schall, kl.elektro, grad[r.exportId] || 0, '', '', r.guid,
        ].map((v) => String(v).replace(/;/g, ',')).join(';'));
      }
    }
    return zeilen.join('\n');
  }

  // =====================================================
  // 8 · DARSTELLUNG ALS RASTER
  // =====================================================
  //
  // Die Räume werden als die Quader gezeigt, die auch exportiert werden. Das
  // ist keine Bequemlichkeit, sondern der Punkt: Ein Raster, das im Bild
  // plausibel aussieht, ist auch als Eingabe plausibel — und eines, das
  // auseinanderfällt, sieht man sofort, statt es drei Rechenschritte später
  // im Terminplan zu suchen.

  function ursprung() {
    if (RC._origin) return RC._origin;
    const tileset = aktivesTileset();
    if (!tileset || !tileset.boundingSphere) return null;
    const carto = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);
    // Das Raster wächst von seiner Ecke nach Ost und Nord. Damit es mittig
    // über dem Modell liegt, wird der Ursprung um die halbe Ausdehnung
    // zurückgesetzt; die Sohle sitzt am unteren Rand der Hüllkugel.
    const halbeL = (RC.geschosse[0]?.laenge || 0) / 2;
    const halbeB = (RC.geschosse[0]?.breite || 0) / 2;
    RC._origin = {
      carto,
      hoehe: carto.height - tileset.boundingSphere.radius * 0.5,
      versatz: [-halbeL, -halbeB],
    };
    return RC._origin;
  }

  function zeichne() {
    loesche();
    const viewer = global.BimViewer?.viewer;
    if (!viewer) return;
    if (!RC.geschosse.length) baueKonzept();

    const o = ursprung();
    if (!o) { melde('Kein Modell geladen — die Räume brauchen einen Bezugspunkt.', true); return; }

    const basis = Cesium.Cartesian3.fromRadians(o.carto.longitude, o.carto.latitude,
      o.hoehe + RC.hoehenOffset);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(basis);

    for (const g of RC.geschosse) {
      for (const r of g.raeume) {
        if (!r.lo || !r.hi) continue;
        // Dieselben Filter und dieselbe Farbe wie im Modell — die beiden
        // Ansichten zeigen dieselben Räume, nur an verschiedenem Ort.
        if (!sichtbar(r)) continue;

        const mitte = [0, 1, 2].map((i) => (r.lo[i] + r.hi[i]) / 2);
        const groesse = [0, 1, 2].map((i) => r.hi[i] - r.lo[i]);
        const lokal = new Cesium.Cartesian3(
          mitte[0] + o.versatz[0], mitte[1] + o.versatz[1], mitte[2]);
        const welt = Cesium.Matrix4.multiplyByPoint(enu, lokal, new Cesium.Cartesian3());
        const farbe = Cesium.Color.fromCssColorString(farbeVon(r));

        RC.entities.push(viewer.entities.add({
          name: `${r.nr || r.exportId} · ${r.name}`,
          position: welt,
          box: {
            dimensions: new Cesium.Cartesian3(groesse[0], groesse[1], groesse[2] * 0.92),
            material: farbe.withAlpha(0.42),
            outline: true,
            outlineColor: farbe.withAlpha(0.95),
          },
          description: beschreibung(r, g),
          properties: { raumkonzept: true, exportId: r.exportId, guid: r.guid },
        }));
      }
    }

    RC.sichtbar = true;
    if (RC.nurRaeume) blendeModellAus(true);
  }

  function loesche() {
    const viewer = global.BimViewer?.viewer;
    if (viewer) RC.entities.forEach((e) => { try { viewer.entities.remove(e); } catch (_) {} });
    RC.entities = [];
    RC.sichtbar = false;
  }

  /**
   * Das Fachmodell zurücknehmen, damit die Raumquader lesbar bleiben.
   *
   * Nicht ausblenden, sondern durchscheinend: Ohne das Gebäude ringsum ist
   * nicht zu erkennen, ob das Raster am richtigen Ort liegt.
   */
  function blendeModellAus(an) {
    RC.nurRaeume = an;
    for (const asset of (global.BimViewer?.loadedAssets?.values() || [])) {
      const ts = asset.tileset;
      if (!ts) continue;
      try {
        if (an) {
          // Den vorhandenen Stil aufheben, statt ihn beim Zurückschalten auf
          // `undefined` zu setzen: Sonst verliert der Benutzer seinen
          // IFC-Filter und seine Einfärbung, nur weil er die Räume einmal
          // freigestellt hat.
          if (!('__rkStil' in ts)) ts.__rkStil = ts.style;
          ts.style = new Cesium.Cesium3DTileStyle({ color: "color('white', 0.08)" });
        } else if ('__rkStil' in ts) {
          ts.style = ts.__rkStil;
          delete ts.__rkStil;
        }
      } catch (_) { /* Tileset ohne Style-Unterstützung */ }
    }
    kloneZuruecknehmen();
  }

  /**
   * Dasselbe an den Geschossklonen der Explosion. Ein Klon übernimmt den Stil
   * seines Originals nur beim Entstehen: lief die Explosion schon, als die
   * Räume kamen, stünden die Räume sonst in undurchsichtigen Klonen — und
   * entstand der Klon während der Raumansicht, bliebe er nach ihr blass.
   * Deshalb wird sein Stil hier jedes Mal aus dem eben gesetzten Stil des
   * Originals neu abgeleitet (`Explosion._stilFuer`, derselbe Weg wie beim
   * Aufbau): blass oder nicht übernimmt er von dort, seinen Geschossfilter
   * (`show`) behält er.
   */
  function kloneZuruecknehmen() {
    const E = global.BimViewer?.Explosion;
    if (!E || typeof E._stilFuer !== 'function') return;
    for (const ziel of E.klonZiele || []) {
      const original = ziel.asset && ziel.asset.tileset;
      for (const k of ziel.klone || []) {
        try { k.tileset.style = E._stilFuer(ziel.gruppen, k.rang, original && original.style); }
        catch (_) { /* Klon schon entladen */ }
      }
    }
  }

  function beschreibung(r, g) {
    const kl = KLASSE_INDEX[r.klasse];
    const zeile = (a, b) => `<tr><td style="padding:3px 10px 3px 0;color:#8A8F98">${a}</td><td style="padding:3px 0"><b>${b}</b></td></tr>`;
    return `
      <table style="font-family:system-ui;font-size:13px;border-collapse:collapse">
        ${zeile('Raum', `${esc(r.nr) || '—'} · ${esc(r.name)}`)}
        ${zeile('Geschoss', esc(g.key))}
        ${zeile('Klasse', `${kl.bezeichnung} <span style="color:#8A8F98">(${kl.klasse})</span>`)}
        ${zeile('Zone', ZONEN_META[kl.zone]?.label || kl.zone)}
        ${zeile('Fläche', `${r.flaeche || STANDARDFLAECHE} m²${r.flaecheGeschaetzt ? ' (geschätzt)' : ''}`)}
        ${zeile('Beleuchtung', `${kl.lux} lx`)}
        ${zeile('Außenluft', `${kl.luft} m³/(h·m²)${kl.abluft ? ' · mech. Abluft' : ''}`)}
        ${zeile('Nutzlast', `${kl.nutzlast} kN/m²`)}
        ${zeile('Feuerwiderstand', kl.brand ? `F ${kl.brand}` : '—')}
        ${zeile('Schallschutz', `${kl.schall} dB`)}
        ${zeile('Anschlussleistung', `${kl.elektro} W/m²`)}
        ${zeile('Rutschhemmung', kl.rutsch)}
        ${zeile('GlobalId', `<code style="font-size:11px">${esc(r.guid)}</code>`)}
      </table>
      <div style="margin-top:8px;font-size:11px;color:#8A8F98">${kl.quelle}</div>`;
  }

  // =====================================================
  // 9 · DIE RÄUME IM MODELL — echte Lage, eingefärbt
  // =====================================================
  //
  // Das Raster oben beantwortet die Frage des Navis: wer grenzt an wen, was
  // steht auf was. Es beantwortet nicht die Frage des Planers — liegen die
  // Nutzungen im Gebäude dort, wo sie hingehören, wie verteilen sie sich über
  // die Geschosse, wo liegt ein Sanitärraum ohne Steigstrang darüber. Dafür
  // müssen die IfcSpace-Körper an ihrer eigenen Stelle stehen, nicht in einem
  // gerechneten Zweibund an einem geschätzten Bezugspunkt.
  //
  // Zwei Wege, und welcher gilt, entscheidet die Herkunft der Räume:
  //
  //   • Backend-Modelle: IfcSpace steckt nicht in den Kacheln. Die Räume kommen
  //     mit Grundrissfigur aus `/rooms` und werden als eigene Körper gezeichnet
  //     (`KOERPER`, Abschnitt 10).
  //   • ion-Modelle, deren Kacheln IfcSpace führen: die Features werden
  //     eingefärbt (`MODELL`, hier).
  //
  // **Warum `tileVisible` und kein `Cesium3DTileStyle`** — derselbe Grund wie
  // in geg-huelle.js, hier sogar zwingend: Die Nutzung eines Raums steht in
  // keiner Eigenschaft der Kachel. Sie entsteht erst aus dem Muster über den
  // Raumnamen — und bei von Hand zugeordneten Räumen aus einer Entscheidung,
  // die es im Modell überhaupt nicht gibt. Ein Style müsste die fertige
  // Zuordnung als Oder-Verknüpfung über alle GlobalIds mitführen und würde sie
  // je Bild neu auswerten. Über das Ereignis wird jedes Tile genau einmal
  // gefärbt, und nachgeladene Kacheln ziehen von selbst mit — bei einem
  // Gebäudemodell mit LOD ist Nachschub die Regel, nicht die Ausnahme.

  /** Wie weit das übrige Gebäude zurücktritt, damit die Räume darin lesbar sind. */
  const REST_FARBE = '#5a5a5a';
  const REST_ALPHA = 0.07;

  // Räume sind Volumenkörper und füllen das Gebäude lückenlos aus. Opak
  // eingefärbt verdeckte die vorderste Raumschale alle übrigen; halbdurch-
  // sichtig bleibt die Schichtung über die Geschosse lesbar.
  const RAUM_ALPHA = 0.55;
  /** Ist ein Raum gewählt, treten die übrigen zurück — aber nicht ganz. */
  const RAUM_ALPHA_GEDAEMPFT = 0.22;
  const RAUM_ALPHA_GEWAEHLT = 0.85;
  const RAUM_ALPHA_UNTER_ZEIGER = 0.78;

  /** Räume, deren Nutzung am Namen nicht zu erkennen war — sichtbar, aber grau. */
  const FARBE_OHNE_KLASSE = '#9aa0a6';

  const MODELL = {
    tileset: null,
    listener: null,
    stilVorher: undefined,
    stempel: 0,
    farben: new Map(),   // GlobalId → CSS-Farbe nach dem gewählten Kriterium
    getroffen: 0,        // wie viele Räume im Modell wirklich gefunden wurden
    guidFeld: null,
    klasseFeld: null,

    /**
     * Die Zuordnung GlobalId → Farbe, wie die Filter sie gerade zulassen.
     *
     * Räume ohne Klasse kommen grau mit hinein, statt zu verschwinden: Im
     * Panel stehen sie als Liste, im Modell zeigt das Grau, *wo* sie liegen —
     * und das ist meist die Erklärung dafür, wie sie heißen. Sobald aber
     * gezielt nach Klassen gefiltert wird, gehören sie nicht mehr dazu.
     */
    karteBauen() {
      this.farben = new Map();
      for (const r of RC.raeume) {
        if (!sichtbar(r)) continue;
        this.farben.set(String(r.guid), farbeVon(r));
      }
    },

    /**
     * Einfärbung einschalten oder — bei geänderten Filtern — erneuern.
     *
     * Der vorhandene Stil wird beiseitegelegt und entfernt: Ein aktiver
     * `Cesium3DTileStyle` überschreibt `feature.color` bei jedem Bild, und die
     * Einfärbung wäre wirkungslos. Das ist zugleich der Grund, warum die Räume
     * hier überhaupt sichtbar werden — der IFC-Filter in features.js blendet
     * IfcSpace in aller Regel aus.
     */
    an() {
      const tileset = aktivesTileset();
      if (!tileset) {
        melde('Kein Modell geladen — im Modell einfärben geht nur mit Modell.', true);
        return false;
      }

      // Zwischenzeitlich entladen: der gemerkte Verweis zeigt auf ein
      // zerstörtes Objekt, an dem `tileVisible` nicht mehr existiert.
      if (this.tileset && this.tileset.isDestroyed && this.tileset.isDestroyed()) {
        this.vergessen();
      }
      if (this.tileset && this.tileset !== tileset) this.aus();

      this.karteBauen();
      this.getroffen = 0;
      this.stempel += 1;

      if (this.tileset !== tileset) {
        this.tileset = tileset;
        this.stilVorher = tileset.style;
        tileset.style = undefined;
        this.listener = (tile) => this.tileFaerben(tile);
        tileset.tileVisible.addEventListener(this.listener);
      }

      // Die bereits geladenen Tiles bekommen `tileVisible` erst beim nächsten
      // Bild — ohne diesen Durchlauf bliebe das Modell einen Moment unverändert
      // und der Knopf wirkte wirkungslos.
      this.alleTiles((tile) => this.tileFaerben(tile));
      global.BimViewer?.viewer?.scene?.requestRender();

      RC.sichtbar = true;
      return true;
    },

    /** Einfärbung aufheben und den vorherigen Zustand des Tilesets herstellen. */
    aus() {
      if (!this.tileset) return;
      if (this.tileset.isDestroyed && this.tileset.isDestroyed()) {
        this.vergessen();
        return;
      }

      this.tileset.tileVisible.removeEventListener(this.listener);
      this.alleTiles((tile) => {
        jedesFeature(tile, (feature) => {
          feature.color = Cesium.Color.WHITE;
          feature.show = true;
        });
        tile._rkStempel = 0;
      });

      this.tileset.style = this.stilVorher;
      this.vergessen();
      global.BimViewer?.viewer?.scene?.requestRender();
    },

    vergessen() {
      this.tileset = null;
      this.listener = null;
      this.stilVorher = undefined;
      this.farben = new Map();
    },

    /** Ob gerade eingefärbt wird. */
    aktiv() { return !!this.tileset; },

    tileFaerben(tile) {
      if (tile._rkStempel === this.stempel) return;
      tile._rkStempel = this.stempel;

      jedesFeature(tile, (feature) => {
        const gid = this.guidVon(feature);
        const farbe = gid ? this.farben.get(gid) : null;

        if (farbe) {
          const alpha = gid === RC.auswahl ? RAUM_ALPHA_GEWAEHLT : RAUM_ALPHA;
          feature.color = Cesium.Color.fromCssColorString(farbe).withAlpha(alpha);
          feature.show = true;
          this.getroffen += 1;
          return;
        }

        // Ein weggefilterter Raum verschwindet ganz. Bliebe er blass stehen,
        // stünde eine Raumschale vor genau den Räumen, die man sehen wollte —
        // beim übrigen Gebäude ist das hinnehmbar, bei Raumkörpern nicht.
        if (this.istRaum(feature)) {
          feature.show = false;
          return;
        }

        feature.color = Cesium.Color.fromCssColorString(REST_FARBE).withAlpha(REST_ALPHA);
        feature.show = true;
      });
    },

    /**
     * Das Feld einmal suchen und behalten.
     *
     * Welches Feld die Batch Table führt, hängt am Erzeuger der Tiles. Die
     * Kandidatenliste je Feature und Bild durchzugehen wäre bei zehntausend
     * Bauteilen spürbar — dieselbe Vorsichtsmaßnahme wie in geg-huelle.js.
     */
    guidVon(feature) {
      if (this.guidFeld) {
        const wert = feature.getProperty(this.guidFeld);
        return wert === undefined || wert === null ? null : String(wert);
      }
      for (const kandidat of FELD.guid) {
        const wert = feature.getProperty(kandidat);
        if (wert !== undefined && wert !== null && wert !== '') {
          this.guidFeld = kandidat;
          return String(wert);
        }
      }
      return null;
    },

    istRaum(feature) {
      if (this.klasseFeld) {
        return normalisiere(feature.getProperty(this.klasseFeld) || '') === 'ifcspace';
      }
      const erkannt = aktivesAsset()?.ifcPropertyName;
      const kandidaten = erkannt ? [erkannt, ...FELD.klasse] : FELD.klasse;
      for (const kandidat of kandidaten) {
        const wert = feature.getProperty(kandidat);
        if (wert !== undefined && wert !== null && wert !== '') {
          this.klasseFeld = kandidat;
          return normalisiere(wert) === 'ifcspace';
        }
      }
      return false;
    },

    /**
     * Alle Tiles, auch die außerhalb des Wurzelbaums.
     *
     * `_selectedTiles` sind die gerade gezeichneten; bei Modellen mit
     * Sprung-LOD hängt deren Inhalt nicht am Baum — dieselbe Ergänzung wie in
     * `sammleAusKacheln`.
     */
    alleTiles(tun) {
      if (!this.tileset) return;
      const gesehen = new Set();

      const durchlaufe = (tile, tiefe) => {
        if (!tile || tiefe > 24 || gesehen.has(tile)) return;
        gesehen.add(tile);
        tun(tile);
        (tile.children || []).forEach((kind) => durchlaufe(kind, tiefe + 1));
      };

      durchlaufe(this.tileset.root, 0);
      (this.tileset._selectedTiles || []).forEach((tile) => {
        if (!gesehen.has(tile)) { gesehen.add(tile); tun(tile); }
      });
    },
  };

  /** Über alle Features eines Tiles, innere Inhalte eingeschlossen. */
  function jedesFeature(tile, tun) {
    const content = tile && tile.content;
    if (!content) return;
    if (content.innerContents) {
      content.innerContents.forEach((inner) => jedesFeature({ content: inner }, tun));
      return;
    }
    const n = content.featuresLength || 0;
    for (let i = 0; i < n; i++) {
      let feature;
      try { feature = content.getFeature(i); } catch (_) { continue; }
      if (feature) tun(feature);
    }
  }

  // =====================================================
  // 9b · EINTEILUNG UND FILTER
  // =====================================================
  //
  // Eine Stelle, an der entschieden wird, welche Räume zu sehen sind und in
  // welcher Farbe — für Körper, Kacheln, Raster, Liste und Stempel. Hätte
  // jede Darstellung ihren eigenen Filter, zeigte die Liste irgendwann andere
  // Räume als das Bild.

  /** Was raum-merkmale.js zum Einteilen braucht. */
  function katalog() {
    const p = pruefung();
    return { KLASSE_INDEX, ZONEN_META, geschossFolge: geschossFolge(),
             befunde: p ? p.jeRaum : null, geprueft: p ? p.geprueft : null };
  }

  /**
   * Die Prüfungen über die Räume (Steigstrang, Außenluft, Rettungsweg),
   * zwischengespeichert wie die Einteilung: neu, wenn neue Räume kommen oder
   * eine Klasse oder Nutzlast von Hand gesetzt wird.
   */
  function pruefung() {
    const RM = global.RaumMerkmale;
    if (!RM || !RM.pruefungen || !RC.raeume.length) return null;
    const stand = RC._klassenStand || 0;
    if (!RC._pruefung || RC._pruefungVon !== RC.raeume || RC._pruefungStand !== stand) {
      RC._pruefung = RM.pruefungen(RC.raeume, { KLASSE_INDEX, ZONEN_META, geschossFolge: geschossFolge() });
      RC._pruefungVon = RC.raeume;
      RC._pruefungStand = stand;
    }
    return RC._pruefung;
  }

  function merkmale() {
    const RM = global.RaumMerkmale;
    if (!RM) throw new Error('raum-merkmale.js ist nicht geladen — es gehört vor room-concept.js.');
    return RM;
  }

  /**
   * Die Einteilung nach dem gewählten Kriterium, zwischengespeichert.
   *
   * Neu gerechnet wird, wenn sich die Räume (neu eingelesen), eine Klasse
   * (von Hand gesetzt) oder das Kriterium ändern — nicht bei jedem Filter
   * und nicht bei jedem Zeigerschritt über das Bild.
   */
  function einteilung() {
    // Live-Kriterien gelten für den Stand der Messwerte, nicht nur für die Räume.
    const live = String(RC.kriterium).startsWith('live_') && global.RaumSensorik ? global.RaumSensorik.version : 0;
    const stand = `${RC.kriterium}|${RC._klassenStand || 0}|${live}`;
    if (!RC._einteilung || RC._einteilungVon !== RC.raeume || RC._einteilungStand !== stand) {
      RC._einteilung = merkmale().einteilen(RC.raeume, RC.kriterium, katalog());
      RC._einteilungVon = RC.raeume;
      RC._einteilungStand = stand;
    }
    return RC._einteilung;
  }

  function farbeVon(r) {
    return einteilung().farbe.get(r.guid) || FARBE_OHNE_KLASSE;
  }

  function raumVon(guid) {
    if (RC._indexVon !== RC.raeume) {
      RC._index = new Map(RC.raeume.map((r) => [String(r.guid), r]));
      RC._indexVon = RC.raeume;
    }
    return guid === null || guid === undefined ? null : RC._index.get(String(guid)) || null;
  }

  const geschossPasst = (r) => !RC.geschossWahl.size || RC.geschossWahl.has(r.geschoss);
  const klassePasst = (r) => !RC.klassenFilter.size || RC.klassenFilter.has(r.klasse || '');
  const legendePasst = (r) => !RC.legendenFilter.size ||
    RC.legendenFilter.has(einteilung().schluessel.get(r.guid));

  /** Ob ein Raum nach Geschoss, Nutzung und Legende zu sehen ist. */
  function sichtbar(r) {
    return geschossPasst(r) && klassePasst(r) && legendePasst(r);
  }

  /** Die Suche wirkt nur auf die Liste — im Bild soll der Zusammenhang bleiben. */
  function suchePasst(r) {
    const s = normalisiere(RC.suchText || '');
    if (!s) return true;
    return normalisiere(`${r.nr} ${r.name} ${r.guid}`).includes(s);
  }

  /**
   * Geschosse von unten nach oben.
   *
   * Gemessen, wo es geht: die mittlere Unterkante der Räume eines Geschosses
   * aus dem Backend. Das Namensschema (UG < EG < OG < DG) ist nur der Rückfall
   * — „Ebene 3" und „Galerie" sagen nichts über ihre Lage.
   */
  function geschossFolge() {
    if (RC._folgeVon === RC.raeume && RC._folge) return RC._folge;
    const gruppen = new Map();
    for (const r of RC.raeume) {
      if (!gruppen.has(r.geschoss)) gruppen.set(r.geschoss, []);
      if (r.box && r.box.lo) gruppen.get(r.geschoss).push(r.box.lo[2]);
    }
    const median = (z) => {
      if (!z.length) return null;
      const s = [...z].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const liste = [...gruppen.entries()].map(([key, z]) => ({ key, z: median(z), rang: geschossRang(key) }));
    const gemessen = liste.every((g) => g.z !== null);
    liste.sort((a, b) => (gemessen ? a.z - b.z : a.rang - b.rang) ||
      String(a.key).localeCompare(String(b.key), 'de', { numeric: true }));
    RC._folge = liste.map((g) => g.key);
    RC._folgeVon = RC.raeume;
    return RC._folge;
  }

  // =====================================================
  // 10 · DIE RÄUME ALS KÖRPER — Backend-Modelle
  // =====================================================
  //
  // Bis Oktober 2026 standen die Räume hier als Hüllquader-Entities. Zwei
  // Dinge daran trugen nicht:
  //
  //   • **Die Form.** Ein L-förmiger Raum überdeckte als Quader seine Kerbe,
  //     ein Flur um die Ecke fast den halben Grundriss, und Nachbarn ragten
  //     ineinander. Das Backend kennt die Grundrissfigur je Raum
  //     (`_raum_grundriss`, die Lastflächen des Lastabtrags), also wird sie
  //     hochgezogen — von der Unter- bis zur Oberkante des Raums.
  //   • **Das Umfärben.** Cesium fasst gleichartige Entities zu einem
  //     Primitive zusammen und baut es bei jeder Farbänderung neu — dieselbe
  //     Falle wie beim 4D-Hänger im Bauplaner (bauplaner-darstellung.js).
  //     Hier ist es ein Primitive je Geschoss mit Farbe und Sichtbarkeit als
  //     **Attribut je Instanz**: Filtern, Umfärben und das Hervorheben unter
  //     dem Zeiger schreiben ein paar Bytes, gebaut wird nur, wenn neue Räume
  //     kommen.
  //
  // Die Geometrie liegt tile-lokal vor, die Höhe aber ab der Modellunterkante;
  // `raumNachWelt()` bringt sie nach ECEF, samt der Drehung des Hauses und
  // einer Verschiebung aus dem ✥-Flyout. Unter- und Oberkante werden als Ellipsoidhöhe über der
  // Raummitte gemessen: über die Ausdehnung eines Raums liegt die Lotrichtung
  // um weniger als einen Millimeter neben der Hochachse des Hauses.

  /** Luft zu Boden und Decke, damit der Raumkörper nicht mit der Rohdecke flimmert. */
  const SPALT = 0.03;
  /** Raumstempel nur, wenn so wenige Räume zu sehen sind — sonst ist es ein Schriftteppich. */
  const STEMPEL_HOECHSTENS = 60;

  function welt(M, x, y, z) {
    return Cesium.Matrix4.multiplyByPoint(M, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
  }

  /** Ring ohne doppelte Punkte und ohne Schlusspunkt. */
  function ringBereinigt(ring) {
    const aus = [];
    for (const p of ring || []) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      const l = aus[aus.length - 1];
      if (l && Math.abs(l[0] - p[0]) < 1e-4 && Math.abs(l[1] - p[1]) < 1e-4) continue;
      aus.push([p[0], p[1]]);
    }
    if (aus.length > 1) {
      const a = aus[0], e = aus[aus.length - 1];
      if (Math.abs(a[0] - e[0]) < 1e-4 && Math.abs(a[1] - e[1]) < 1e-4) aus.pop();
    }
    return aus;
  }

  function imRing(x, y, ring) {
    let drin = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) drin = !drin;
    }
    return drin;
  }

  function randabstand(x, y, ring) {
    let d = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j], [bx, by] = ring[i];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return d;
  }

  /**
   * Wo der Stempel eines Raums steht: innen und möglichst weit vom Rand.
   *
   * Der Flächenschwerpunkt genügt beim Rechteck. Bei einem L-förmigen Raum
   * liegt er in der Kerbe, also im Nachbarraum — dann wird ein grobes Raster
   * über den Raum gelegt und der Punkt mit dem größten Randabstand genommen
   * (die Idee von polylabel, ohne dessen Verfeinerung; für einen Stempel
   * genügt das).
   */
  function innenpunkt(ring) {
    let A = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const k = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      A += k; cx += (ring[j][0] + ring[i][0]) * k; cy += (ring[j][1] + ring[i][1]) * k;
    }
    if (Math.abs(A) > 1e-9) {
      cx /= 3 * A; cy /= 3 * A;
      if (imRing(cx, cy, ring)) return [cx, cy];
    }
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    let beste = [(x0 + x1) / 2, (y0 + y1) / 2], abstand = -1;
    const N = 9;
    for (let i = 1; i < N; i++) {
      for (let j = 1; j < N; j++) {
        const x = x0 + (x1 - x0) * i / N, y = y0 + (y1 - y0) * j / N;
        if (!imRing(x, y, ring)) continue;
        const d = randabstand(x, y, ring);
        if (d > abstand) { abstand = d; beste = [x, y]; }
      }
    }
    return beste;
  }

  /** Linienstücke als eine Geometrie — ein Raum, eine Instanz, eine Farbe. */
  function linienGeometrie(paare) {
    const werte = new Float64Array(paare.length * 6);
    paare.forEach(([a, b], i) => {
      werte.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    });
    return new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: werte,
        }),
      },
      primitiveType: Cesium.PrimitiveType.LINES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(werte),
    });
  }

  /**
   * Der Körper eines Raums: Fläche (hochgezogene Grundrissfigur), Kanten,
   * Stempelort, Mitte und Radius zum Anfliegen.
   *
   * Die Polygongeometrie wird hier erzeugt und nicht erst im Primitive: Ein
   * Grundriss, aus dem Cesium kein Dreiecksnetz bilden kann (ein Splitter vom
   * Schnitt, ein selbstberührender Ring), wirft dort beim Zeichnen — und
   * nähme alle anderen Räume mit. Hier fällt er auf den Hüllquader zurück.
   */
  function raumKoerper(r, M) {
    const { lo, hi } = r.box;
    const spalt = Math.min(SPALT, (hi[2] - lo[2]) * 0.05);
    const z0 = lo[2] + spalt, z1 = hi[2] - spalt;
    const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
    const hUnten = Cesium.Cartographic.fromCartesian(welt(M, cx, cy, z0)).height;
    const hOben = Cesium.Cartographic.fromCartesian(welt(M, cx, cy, z1)).height;
    const rechteck = [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]];

    const versuche = [];
    if (Array.isArray(r.grundriss) && r.grundriss.length) {
      const ringe = r.grundriss.map(ringBereinigt).filter((g) => g.length >= 3);
      if (ringe.length) {
        versuche.push(ringe);
        if (ringe.length > 1) versuche.push([ringe[0]]);   // ohne Löcher
      }
    }
    versuche.push([rechteck]);

    for (const ringe of versuche) {
      const zuWelt = (ring) => ring.map(([x, y]) => welt(M, x, y, z0));
      let flaeche;
      try {
        flaeche = Cesium.PolygonGeometry.createGeometry(new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            zuWelt(ringe[0]), ringe.slice(1).map((l) => new Cesium.PolygonHierarchy(zuWelt(l)))),
          height: hUnten,
          extrudedHeight: hOben,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }));
      } catch (_) {
        flaeche = undefined;
      }
      if (!flaeche) continue;

      // Kanten: Boden- und Deckenumriss, dazu die senkrechten Kanten an den
      // Ecken. An einer gerundeten Wand stünde sonst ein Lattenzaun.
      const paare = [];
      for (const ring of ringe) {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const a = ring[i], b = ring[(i + 1) % n];
          paare.push([welt(M, a[0], a[1], z0), welt(M, b[0], b[1], z0)]);
          paare.push([welt(M, a[0], a[1], z1), welt(M, b[0], b[1], z1)]);
          const v = ring[(i + n - 1) % n];
          const w1 = Math.atan2(a[1] - v[1], a[0] - v[0]), w2 = Math.atan2(b[1] - a[1], b[0] - a[0]);
          let knick = Math.abs(w2 - w1);
          if (knick > Math.PI) knick = 2 * Math.PI - knick;
          if (knick > 0.45) paare.push([welt(M, a[0], a[1], z0), welt(M, a[0], a[1], z1)]);
        }
      }

      const [sx, sy] = innenpunkt(ringe[0]);
      const stempelZ = z0 + Math.min(1.2, (z1 - z0) / 2);
      return {
        flaeche,
        kanten: linienGeometrie(paare),
        stempel: welt(M, sx, sy, stempelZ),
        mitte: welt(M, cx, cy, (z0 + z1) / 2),
        radius: 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]),
        rueckfall: ringe.length === 1 && ringe[0] === rechteck && !!r.grundriss,
      };
    }
    return null;
  }

  // ── Raumkoordinaten → Welt ───────────────────────────────────────────────
  //
  // Das Backend zählt die Höhe eines Raums ab der **Modellunterkante** — wie
  // `/storeys` und `element_box`. Der Tile-Ursprung liegt aber in der
  // **Mitte** der Wurzelbox: der IFC-Tiler zentriert den Octree auf seinen
  // Wurzelknoten und verliert dessen Translation, wenn er `root.transform` mit
  // der Platzierung überschreibt (backend/tiling/georef.py `build_tileset`).
  // Ohne Ausgleich standen die Räume um eine halbe Gebäudehöhe zu hoch — beim
  // HSM-Campus 16,28 m über dem Bau, gemeldet am 2026-10-19.
  //
  // Explosion, Geschosspläne und Schnitt rechnen denselben Versatz heraus, und
  // er kommt hier aus derselben Funktion (`Explosion.hoehenspanne().unten`).
  // Bliebe der Tiler eines Tages bei seiner Translation, stimmte die Rechnung
  // weiter: die Wurzelbox stünde dann in deren System, `unten` ebenso.

  function hoehenVersatz(tileset) {
    const E = global.BimViewer && global.BimViewer.Explosion;
    if (!E || typeof E.hoehenspanne !== 'function' || !tileset) return 0;
    let spanne = null;
    try { spanne = E.hoehenspanne(tileset); } catch (_) { spanne = null; }
    return spanne && Number.isFinite(spanne.unten) ? spanne.unten : 0;
  }

  /** Die Matrix, die Raumkoordinaten aus dem Backend nach ECEF bringt. */
  function raumNachWelt(tileset) {
    const M = tileset.root.computedTransform;
    const dz = hoehenVersatz(tileset);
    if (!dz) return M;
    return Cesium.Matrix4.multiply(
      M, Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(0, 0, dz)), new Cesium.Matrix4());
  }

  // ── Die Körper: je Geschoss ein Primitive, das dem Modell folgt ──────────
  //
  // Räume und Modell sollen immer deckungsgleich sein — auch wenn das Modell
  // im ✥-Flyout verschoben oder gedreht wird, wenn terrain-align.js es aufs
  // Gelände setzt und wenn die Explosion die Geschosse auseinanderzieht.
  //
  // Gebaut wird einmal, in Weltkoordinaten zur Lage des Modells beim Bau (C₀).
  // Danach trägt jedes Geschoss eine `modelMatrix`, die je Bild nachgeführt
  // wird:
  //
  //     M = C · X · C₀⁻¹
  //
  // C ist die heutige Lage des Modells (`root.computedTransform`), X die
  // Explosion dieses Geschosses in Tile-Koordinaten — Hub und Stauchung aus
  // `Explosion.lageFuer()`, derselben Rechnung, die Shader und Klone
  // anwenden. Eine Matrix je Geschoss, weil die Explosion je Geschoss hebt:
  // ein Primitive für alle Räume könnte nur alle zugleich bewegen.
  //
  // Neu gebaut wird dabei nichts, und das ist der Grund für den Umweg: Der
  // Regler der Explosion wird gezogen, und je Bild 500 Polygone neu zu
  // triangulieren hieße, ihn ruckeln zu lassen. Eine `modelMatrix` zu setzen
  // kostet Cesium eine Hüllkugel.

  const KOERPER = {
    ebenen: new Map(),     // Geschossname → { name, flaechen, kanten, stempel, hoehe, matrix }
    daten: new Map(),      // GlobalId → { mitte, radius, stempel, label, ebene }
    raeumeVon: null,       // für welche Raumliste gebaut wurde
    tileset: null,
    basisInv: null,        // C₀⁻¹ — die Lage des Modells beim Bau, umgekehrt
    ausstehend: false,
    nachBild: null,
    vorBild: null,

    aktiv() { return this.ebenen.size > 0; },

    /** Ein Primitive, das Cesium inzwischen zerstört hat — dann neu bauen. */
    zerstoert() {
      for (const e of this.ebenen.values()) {
        if (e.flaechen && e.flaechen.isDestroyed && e.flaechen.isDestroyed()) return true;
      }
      return false;
    },

    /**
     * Zeigen: bauen, wenn es neue Räume oder ein anderes Modell gibt, sonst
     * nur umfärben. @returns Zahl der Räume oder null ohne Modell.
     */
    zeigen() {
      const tileset = aktivesTileset();
      if (!this.aktiv() || this.raeumeVon !== RC.raeume || this.tileset !== tileset || this.zerstoert()) {
        return this.bauen();
      }
      this.faerben();
      return this.daten.size;
    },

    bauen() {
      this.entfernen();
      const viewer = global.BimViewer?.viewer;
      const tileset = aktivesTileset();
      if (!viewer || !tileset || !tileset.root) {
        melde('Kein Modell geladen — die Räume brauchen ihr Tileset als Bezug.', true);
        return null;
      }
      const dz = hoehenVersatz(tileset);
      const M = raumNachWelt(tileset);
      const gruppen = new Map();   // Geschossname → { flaechen, kanten, hoehen }
      let rueckfall = 0;
      for (const r of RC.raeume) {
        if (!r.box || !r.box.lo || !r.box.hi) continue;
        const k = raumKoerper(r, M);
        if (!k) continue;
        if (k.rueckfall) rueckfall += 1;
        const ebene = r.geschoss === null || r.geschoss === undefined ? '' : String(r.geschoss);
        let g = gruppen.get(ebene);
        if (!g) gruppen.set(ebene, (g = { flaechen: [], kanten: [], hoehen: [] }));
        const farbe = Cesium.Color.fromCssColorString(farbeVon(r));
        const zeigen = sichtbar(r);
        g.flaechen.push(new Cesium.GeometryInstance({
          geometry: k.flaeche,
          id: `raum:${r.guid}`,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(farbe.withAlpha(RAUM_ALPHA)),
            show: new Cesium.ShowGeometryInstanceAttribute(zeigen),
          },
        }));
        g.kanten.push(new Cesium.GeometryInstance({
          geometry: k.kanten,
          id: `raumkante:${r.guid}`,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(farbe.withAlpha(0.95)),
            show: new Cesium.ShowGeometryInstanceAttribute(zeigen),
          },
        }));
        // Bezugshöhe für die Explosion, in Tile-Koordinaten: einen Meter über
        // dem Fußboden. Die Trennebene liegt um das Fugenmaß über der
        // Geschosshöhe; der Fußboden selbst fiele noch ins Geschoss darunter.
        const { lo, hi } = r.box;
        g.hoehen.push(lo[2] + Math.min(1.0, (hi[2] - lo[2]) / 2) + dz);
        this.daten.set(String(r.guid), { mitte: k.mitte, radius: k.radius, stempel: k.stempel,
                                         label: null, ebene });
      }

      const primitives = viewer.scene.primitives;
      for (const [name, g] of gruppen) {
        g.hoehen.sort((a, b) => a - b);
        this.ebenen.set(name, {
          name,
          // `asynchronous: false`: die Räume stehen im nächsten Bild, und die
          // Attribute sind danach sofort beschreibbar — beim asynchronen Bau
          // liefe ein Umfärben in der Zwischenzeit ins Leere.
          flaechen: primitives.add(new Cesium.Primitive({
            geometryInstances: g.flaechen,
            appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }),
            asynchronous: false,
          })),
          kanten: primitives.add(new Cesium.Primitive({
            geometryInstances: g.kanten,
            appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
            asynchronous: false,
          })),
          stempel: primitives.add(new Cesium.LabelCollection()),
          hoehe: g.hoehen[g.hoehen.length >> 1],
          matrix: null,
        });
      }
      this.raeumeVon = RC.raeume;
      this.tileset = tileset;
      this.basisInv = typeof Cesium.Matrix4.inverseTransformation === 'function'
        ? Cesium.Matrix4.inverseTransformation(tileset.root.computedTransform, new Cesium.Matrix4())
        : null;

      // Attribute lassen sich erst nach dem ersten Bild schreiben. Was bis
      // dahin geändert wurde, holt dieser Hörer nach.
      this.nachBild = () => {
        if (this.ausstehend && this.bereit()) { this.ausstehend = false; this.faerben(); }
      };
      viewer.scene.postRender?.addEventListener?.(this.nachBild);
      // Lage je Bild nachführen — in `preRender`, wo auch die Explosion ihre
      // Uniforms setzt; sonst hinge der Raum ein Bild hinter seinem Geschoss.
      this.vorBild = () => this.nachfuehren();
      viewer.scene.preRender?.addEventListener?.(this.vorBild);
      this.nachfuehren();

      this.stempelSetzen();
      RC.sichtbar = true;
      RC._rueckfall = rueckfall;
      klickAnmelden();
      viewer.scene.requestRender?.();
      return this.daten.size;
    },

    /**
     * Die Lage jedes Geschosses an Modell und Explosion angleichen.
     * Schreibt nur, wenn sich etwas geändert hat.
     */
    nachfuehren() {
      const tileset = this.tileset;
      if (!tileset || !tileset.root || !this.basisInv || !this.ebenen.size) return;
      if (tileset.isDestroyed && tileset.isDestroyed()) return;
      const C = tileset.root.computedTransform;
      if (!C) return;
      const E = global.BimViewer && global.BimViewer.Explosion;
      const M4 = Cesium.Matrix4;
      let geaendert = false;
      for (const eb of this.ebenen.values()) {
        const lage = E && typeof E.lageFuer === 'function' ? E.lageFuer(tileset, eb.name, eb.hoehe) : null;
        let M = M4.multiply(C, this.basisInv, new M4());
        if (lage && (lage.hub || lage.flach)) {
          // z' = z·(1 − flach) + basis·flach + hub — entlang der Hochachse des
          // Hauses, in Tile-Koordinaten. Spalte 3, Zeile 2 ist die
          // z-Verschiebung (Cesium speichert spaltenweise).
          const X = M4.fromScale(new Cesium.Cartesian3(1, 1, 1 - lage.flach), new M4());
          X[14] = lage.basis * lage.flach + lage.hub;
          M = M4.multiply(M4.multiply(C, X, new M4()), this.basisInv, M);
        }
        if (eb.matrix && M4.equalsEpsilon(M, eb.matrix, 1e-9)) continue;
        eb.matrix = M;
        eb.flaechen.modelMatrix = M4.clone(M);
        eb.kanten.modelMatrix = M4.clone(M);
        if (eb.stempel) eb.stempel.modelMatrix = M4.clone(M);
        geaendert = true;
      }
      if (geaendert) global.BimViewer?.viewer?.scene?.requestRender?.();
    },

    /** Ein beim Bau gerechneter Punkt eines Raums, so wie er jetzt in der Welt steht. */
    weltpunkt(guid, p) {
      const d = this.daten.get(String(guid));
      const eb = d && this.ebenen.get(d.ebene);
      if (!p || !eb || !eb.matrix) return p;
      return Cesium.Matrix4.multiplyByPoint(eb.matrix, p, new Cesium.Cartesian3());
    },

    bereit() {
      if (!this.ebenen.size) return false;
      for (const e of this.ebenen.values()) {
        if (!(e.flaechen && e.flaechen.ready && e.kanten && e.kanten.ready)) return false;
      }
      return true;
    },

    /** Die Attribute eines Raums in seinem Geschoss-Primitive. */
    attribute(guid) {
      const d = this.daten.get(guid);
      const eb = d && this.ebenen.get(d.ebene);
      if (!eb) return null;
      try {
        return {
          fl: eb.flaechen.getGeometryInstanceAttributes(`raum:${guid}`),
          ka: eb.kanten.getGeometryInstanceAttributes(`raumkante:${guid}`),
        };
      } catch (_) { return null; }
    },

    /** Farbe und Sichtbarkeit je Raum neu setzen — ohne Neubau. */
    faerben() {
      if (!this.aktiv()) return;
      if (!this.bereit()) {
        this.ausstehend = true;
        global.BimViewer?.viewer?.scene?.requestRender?.();
        return;
      }
      const gewaehlt = RC.auswahl;
      for (const r of RC.raeume) {
        const guid = String(r.guid);
        if (!this.daten.has(guid)) continue;
        const a = this.attribute(guid);
        if (!a || !a.fl || !a.ka) continue;
        const { fl, ka } = a;
        const zeigen = sichtbar(r);
        const basis = Cesium.Color.fromCssColorString(farbeVon(r));
        let alpha = RAUM_ALPHA, kante = basis.withAlpha(0.95);
        if (guid === gewaehlt) { alpha = RAUM_ALPHA_GEWAEHLT; kante = Cesium.Color.WHITE; }
        else if (guid === RC.hover) alpha = RAUM_ALPHA_UNTER_ZEIGER;
        else if (gewaehlt) { alpha = RAUM_ALPHA_GEDAEMPFT; kante = basis.withAlpha(0.45); }
        fl.color = Cesium.ColorGeometryInstanceAttribute.toValue(basis.withAlpha(alpha), fl.color);
        fl.show = Cesium.ShowGeometryInstanceAttribute.toValue(zeigen, fl.show);
        ka.color = Cesium.ColorGeometryInstanceAttribute.toValue(kante, ka.color);
        ka.show = Cesium.ShowGeometryInstanceAttribute.toValue(zeigen, ka.show);
      }
      this.stempelSetzen();
      global.BimViewer?.viewer?.scene?.requestRender?.();
    },

    /**
     * Raumstempel: Nummer, Name und der Wert des Kriteriums.
     *
     * Nur, wenn ein Geschoss gewählt ist oder alles Sichtbare in einem
     * Geschoss liegt (und es nicht zu viele sind) — über die Geschosse
     * gestapelt stehen die Stempel übereinander, und aus dreihundert wird
     * eine Wand aus Schrift vor dem Modell.
     *
     * Jedes Geschoss hat seine eigene `LabelCollection`: sie trägt dieselbe
     * `modelMatrix` wie die Körper und fliegt in der Explosion mit.
     */
    stempelSetzen() {
      if (!this.aktiv()) return;
      const zuSehen = RC.raeume.filter((r) => this.daten.has(String(r.guid)) && sichtbar(r));
      const einGeschoss = new Set(zuSehen.map((r) => r.geschoss)).size <= 1;
      const an = RC.stempel && (RC.geschossWahl.size > 0 ||
                                (einGeschoss && zuSehen.length <= STEMPEL_HOECHSTENS));
      const ein = einteilung();
      const mitWert = RC.kriterium !== 'klasse';
      for (const r of RC.raeume) {
        const d = this.daten.get(String(r.guid));
        if (!d) continue;
        const zeigen = an && sichtbar(r);
        if (!zeigen) { if (d.label) d.label.show = false; continue; }
        const sammlung = this.ebenen.get(d.ebene)?.stempel;
        if (!sammlung) continue;
        const w = ein.werte.get(r.guid);
        const text = [r.nr, r.name, mitWert ? (w ? w.text : '—') : null].filter(Boolean).join('\n');
        if (!d.label) {
          d.label = sammlung.add({
            id: `raum:${r.guid}`,
            position: d.stempel,
            text,
            font: '600 12px Inter, system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: true,
            backgroundColor: new Cesium.Color(0.06, 0.07, 0.09, 0.72),
            backgroundPadding: new Cesium.Cartesian2(6, 4),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            // Der Stempel steht im Raum und damit hinter Wänden. Ohne diese
            // Angabe wäre er genau dann verdeckt, wenn man ihn braucht.
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            // Kleine Räume erst aus der Nähe: Aus der Ferne lägen die Stempel
            // von WC, Schacht und Abstellraum übereinander, und keiner wäre
            // zu lesen. Die Sichtweite wächst mit der Größe des Raums.
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0, Math.max(40, Math.min(300, d.radius * 26))),
            scaleByDistance: new Cesium.NearFarScalar(15, 1.0, 250, 0.5),
          });
        } else if (d.label.text !== text) {
          d.label.text = text;
        }
        d.label.show = true;
      }
    },

    entfernen() {
      const viewer = global.BimViewer?.viewer;
      const primitives = viewer?.scene?.primitives;
      for (const e of this.ebenen.values()) {
        for (const p of [e.flaechen, e.kanten, e.stempel]) {
          if (!p) continue;
          try { primitives?.remove(p); } catch (_) { /* schon weg */ }
        }
      }
      if (this.nachBild) viewer?.scene?.postRender?.removeEventListener?.(this.nachBild);
      if (this.vorBild) viewer?.scene?.preRender?.removeEventListener?.(this.vorBild);
      this.ebenen = new Map();
      this.nachBild = this.vorBild = null;
      this.ausstehend = false;
      this.daten = new Map();
      this.raeumeVon = null;
      this.tileset = null;
      this.basisInv = null;
      viewer?.scene?.requestRender?.();
    },
  };

  /** Ob die Räume ihre echte Lage mitbringen — dann werden Körper gezeichnet. */
  function hatBoxen() {
    return RC.raeume.some((r) => r.box && r.box.lo && r.box.hi);
  }

  // =====================================================
  // 11 · ANKLICKEN, ZEIGEN, STECKBRIEF
  // =====================================================
  //
  // Der allgemeine Klick-Handler in features.js kennt nur Kachel-Features;
  // ein Klick auf einen Raumkörper endete dort in `closeInfoBox()`. Die
  // Raumansicht hört deshalb selbst auf den Klick und schreibt den
  // Steckbrief **danach** in dieselbe Eigenschaftsanzeige — dieselbe
  // Reihenfolge wie bei den LoD2-Gebäuden (layerManager.js) und den
  // Vektorkacheln.
  //
  // **Solange Räume zu sehen sind, gehört ein Klick dem Raum,** auch wenn eine
  // zurückgenommene Wand davor liegt: gesucht wird mit `drillPick` durch die
  // Treffer hindurch. Sonst träfe man bei halbdurchsichtigem Modell fast
  // immer die Wand und nie den Raum, um den es geht.

  function guidAusTreffer(t) {
    if (!t) return null;
    const id = t.id;
    if (typeof id === 'string') {
      if (id.startsWith('raum:')) return id.slice(5);
      if (id.startsWith('raumkante:')) return id.slice(10);
      return null;
    }
    // Rasterquader: Entities mit PropertyBag
    const p = id && id.properties;
    if (p && p.raumkonzept) {
      const g = p.guid;
      const wert = g && typeof g.getValue === 'function' ? g.getValue() : g;
      return wert ? String(wert) : null;
    }
    // Kachelweg: IfcSpace-Features
    if (typeof Cesium !== 'undefined' && Cesium.Cesium3DTileFeature && t instanceof Cesium.Cesium3DTileFeature) {
      const g = MODELL.guidVon(t);
      return g && raumVon(g) ? g : null;
    }
    return null;
  }

  function raumUnter(position, tief) {
    const scene = global.BimViewer?.viewer?.scene;
    if (!scene || !position) return null;
    let treffer = [];
    try {
      treffer = tief ? scene.drillPick(position, 6) : [scene.pick(position)];
    } catch (_) { return null; }
    for (const t of treffer || []) {
      const g = guidAusTreffer(t);
      if (g) return g;
    }
    return null;
  }

  /** Andere Werkzeuge, die den Klick gerade für sich brauchen. */
  function klickGehoertAnderen() {
    const B = global.BimViewer || {};
    if (B.hiddenFeatures && B.hiddenFeatures.isHideMode) return true;
    if (B.SectionBox && typeof B.SectionBox.faengtKlick === 'function' && B.SectionBox.faengtKlick()) return true;
    if (B.Bildebenen && typeof B.Bildebenen.faengtKlick === 'function' && B.Bildebenen.faengtKlick()) return true;
    if (typeof global.WalkMode !== 'undefined' && global.WalkMode.isEnabled && global.WalkMode.isEnabled()) return true;
    return false;
  }

  let zeigerPos = null;
  let zeigerGeplant = false;

  function klickAnmelden() {
    const viewer = global.BimViewer?.viewer;
    if (RC._klick || !viewer || typeof Cesium.ScreenSpaceEventHandler !== 'function') return;
    const h = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    h.setInputAction((e) => {
      if (!RC.sichtbar || klickGehoertAnderen()) return;
      const guid = raumUnter(e.position, true);
      if (!guid) return;
      // Nach dem allgemeinen Handler, der im selben Klick die Anzeige
      // schließt oder ein Bauteil hineinschreibt.
      setTimeout(() => RC.waehle(guid, { quelle: 'bild' }), 0);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction((e) => {
      if (!RC.sichtbar) { tooltip(null); return; }
      zeigerPos = e.endPosition;
      if (zeigerGeplant) return;
      zeigerGeplant = true;
      // `pick` zeichnet die Szene einmal eigens; bei jeder Mausbewegung
      // bräche die Bildrate ein. Höchstens alle 70 ms.
      setTimeout(() => {
        zeigerGeplant = false;
        const guid = raumUnter(zeigerPos, RC.nurRaeume);
        if (guid !== RC.hover) {
          RC.hover = guid;
          if (KOERPER.aktiv()) KOERPER.faerben();
        }
        tooltip(guid, zeigerPos);
      }, 70);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    RC._klick = h;
  }

  function klickAbmelden() {
    if (RC._klick) { try { RC._klick.destroy(); } catch (_) {} }
    RC._klick = null;
    RC.hover = null;
    tooltip(null);
  }

  /** Das kleine Schild am Zeiger: Nummer, Name, Wert des Kriteriums. */
  function tooltip(guid, pos) {
    if (typeof document === 'undefined' || !document.body) return;
    let tip = document.getElementById('rk-tip');
    const r = guid ? raumVon(guid) : null;
    if (!r) { if (tip) tip.style.display = 'none'; return; }
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'rk-tip';
      tip.className = 'rk-tip';
      document.body.appendChild(tip);
    }
    const w = einteilung().werte.get(r.guid);
    const kr = einteilung().kriterium;
    tip.innerHTML = `<b>${esc(r.nr ? r.nr + ' · ' : '')}${esc(r.name)}</b>` +
      `<span>${esc(r.geschoss)}${r.flaeche ? ' · ' + esc(merkmale().zahl(r.flaeche)) + ' m²' : ''}</span>` +
      (RC.kriterium !== 'klasse' || w ? `<span><i style="background:${farbeVon(r)}"></i>${esc(kr.label)}: ${esc(w ? w.text : 'keine Angabe')}</span>` : '');
    const canvas = global.BimViewer?.viewer?.scene?.canvas;
    const rect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    tip.style.left = `${rect.left + pos.x + 14}px`;
    tip.style.top = `${rect.top + pos.y + 14}px`;
    tip.style.display = 'block';
  }

  // ── Steckbrief in der Eigenschaftsanzeige ─────────────────

  const KARTE = {
    titelVorher: null,

    zeigen(r) {
      if (typeof document === 'undefined') return;
      const ziel = document.getElementById('infoBoxCustom');
      const panel = document.getElementById('infoBoxPanel');
      if (!ziel || !panel) return;
      const titel = document.getElementById('infoBoxPanelTitle');
      if (titel) {
        if (this.titelVorher === null) this.titelVorher = titel.textContent;
        titel.textContent = 'RAUM';
      }
      // Ein vorher angeklicktes Bauteil behielte sonst seine grüne Tönung,
      // und eine Rollenumschaltung zeichnete dessen Eigenschaften über den
      // Steckbrief.
      const B = global.BimViewer;
      if (B) {
        if (typeof B._auswahlZuruecksetzen === 'function') B._auswahlZuruecksetzen();
        B.lastExtractedProperties = null;
      }
      ziel.innerHTML = karteHTML(r);
      if (panel.classList) panel.classList.add('visible');
      this.psetsNachladen(r);
      this.melden(r);
    },

    /** Die Auswahl nach außen melden — die gaeco-Brücke hört darauf. */
    melden(r) {
      const B = global.BimViewer;
      if (!B || typeof B._auswahlMelden !== 'function') return;
      const asset = aktivesAsset();
      RC._eigeneMeldung = true;
      try {
        B._auswahlMelden({
          globalId: r.guid, ifcType: 'IfcSpace', name: r.name, geschoss: r.geschoss,
          eigenschaften: { Raumnummer: r.nr, Name: r.name, Geschoss: r.geschoss, Klasse: r.klasse },
          modell: asset ? { schluessel: String(asset.id), jobId: asset.jobId || null, name: asset.name, typ: asset.type } : null,
        });
      } finally {
        RC._eigeneMeldung = false;
      }
    },

    titelZurueck() {
      if (this.titelVorher === null || typeof document === 'undefined') return;
      const titel = document.getElementById('infoBoxPanelTitle');
      if (titel && titel.textContent === 'RAUM') titel.textContent = this.titelVorher;
      this.titelVorher = null;
    },

    schliessen() {
      const B = global.BimViewer;
      if (B && typeof B.closeInfoBox === 'function') B.closeInfoBox();
      this.titelZurueck();
    },

    /** Die vollständigen Psets — nicht in der Raumliste, sie wöge sonst ein Vielfaches. */
    async psetsNachladen(r) {
      const ziel = typeof document !== 'undefined' && document.getElementById('rk-karte-psets');
      if (!ziel) return;
      const asset = backendAsset();
      const basis = global.BimViewer?.getBackendUrl?.();
      if (!asset || !basis) {
        ziel.innerHTML = '<div class="props-empty">Vollständige Psets gibt es bei Backend-Modellen.</div>';
        return;
      }
      try {
        const resp = await fetch(`${basis}/assets/${encodeURIComponent(asset.jobId)}/rooms/${encodeURIComponent(r.guid)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const daten = await resp.json();
        const jetzt = document.getElementById('rk-karte-psets');
        if (!jetzt || RC.auswahl !== r.guid) return;   // inzwischen ein anderer Raum
        jetzt.innerHTML = psetsHTML(daten);
        const zahl = document.getElementById('rk-karte-psets-zahl');
        if (zahl) zahl.textContent = String(Object.values(daten.psets || {}).reduce((s, p) => s + Object.keys(p).length, 0));
      } catch (err) {
        const jetzt = document.getElementById('rk-karte-psets');
        if (jetzt) jetzt.innerHTML = `<div class="props-empty">Psets nicht abrufbar: ${esc(err.message)}</div>`;
      }
    },
  };

  function quelleHTML(quelle) {
    if (!quelle) return '';
    const Q = merkmale().QUELLEN[quelle.art] || { kurz: quelle.art, titel: '' };
    return `<span class="rk-q rk-q--${esc(quelle.art)}" title="${esc(Q.titel + (quelle.text ? ': ' + quelle.text : ''))}">${esc(Q.kurz)}</span>`;
  }

  /**
   * Die Nutzlastkategorie für die Statik setzen — als Eingriff am System.
   *
   * Nur bei Backend-Modellen und erst, wenn die Kategorien geladen sind
   * (`GET …/tragwerk/eingriffe/arten`): dieselbe Liste, gegen die der
   * Lastabtrag rechnet und die `eingriffe.pruefe()` annimmt.
   */
  function nutzlastWahlHTML(r) {
    if (!backendAsset() || !RC._nutzlastKat || !RC._nutzlastKat.length) return '';
    const n = r.nutzlast || {};
    const gedeutet = n.gedeutet ? `${n.gedeutet.kategorie} aus der Nutzung` : (n.vorgabe ? `Vorgabe ${n.kategorie}` : 'Vorgabe');
    return `
        <div class="rk-karte-nutzlast">
          <label>Nutzlast für den Lastabtrag</label>
          <select data-guid="${esc(r.guid)}" onchange="RoomConcept.setzeNutzlast(this.dataset.guid, this.value)"
                  title="Setzt einen Eingriff am System (FE-Browser) — gilt ab dem nächsten Lastabtrag und macht betroffene Geschosse veraltet">
            <option value="">— ${esc(gedeutet)} —</option>
            ${RC._nutzlastKat.map((k) => `<option value="${esc(k.kategorie)}"${n.eingriff && n.kategorie === k.kategorie ? ' selected' : ''}>${esc(k.kategorie)} · ${esc(merkmale().zahl(k.q_k_kNm2))} kN/m² — ${esc(k.beschreibung)}</option>`).join('')}
          </select>
        </div>`;
  }

  function karteHTML(r) {
    const RM = merkmale();
    const kat = katalog();
    const ein = einteilung();
    const w = ein.werte.get(r.guid);
    const abschnitte = RM.steckbrief(r, kat);
    const hinweise = abschnitte.flatMap((a) => a.zeilen.filter((z) => z.hinweis).map((z) => z.hinweis));
    const befunde = (kat.befunde && kat.befunde.get(r.guid)) || [];
    const kl = r.klasse ? KLASSE_INDEX[r.klasse] : null;
    const zeile = (z) => `
      <div class="props-row rk-kzeile">
        <div class="props-key" title="${esc(z.label)}">${esc(z.label)}</div>
        <div class="props-value" title="${esc(z.text)}">${esc(z.text)}${quelleHTML(z.quelle)}</div>
      </div>`;

    const ifcInfo = r.ifc || {};
    const ifcZeilen = [
      ['GlobalId', r.guid],
      ['PredefinedType', ifcInfo.predefined_type],
      ['ObjectType', ifcInfo.object_type],
      ['Beschreibung', ifcInfo.description],
      ...(ifcInfo.klassifikation || []).map((k) => [`Klassifikation${k.system ? ' ' + k.system : ''}`,
        [k.kennung, k.name].filter(Boolean).join(' · ')]),
      ...(ifcInfo.zonen || []).map((z) => [`Zone${z.art ? ' ' + z.art : ''}`, z.name]),
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');

    return `
      <div class="props-container rk-karte" data-guid="${esc(r.guid)}">
        <div class="rk-karte-kopf">
          <span class="rk-dot rk-dot--gross" style="background:${farbeVon(r)}"></span>
          <div class="rk-karte-titel">
            <b>${esc(r.nr || '—')}</b> ${esc(r.name)}
            <small>${esc(r.geschoss)}${r.flaeche ? ' · ' + esc(RM.zahl(r.flaeche)) + ' m²' : ''}${kl ? ' · ' + esc(kl.bezeichnung) : ''}</small>
          </div>
        </div>
        <div class="rk-karte-wert">
          <span>${esc(ein.kriterium.label)}</span>
          <b>${esc(w ? w.text : 'keine Angabe')}</b>${w ? quelleHTML(w.quelle) : ''}
        </div>
        ${befunde.map((b) => `<div class="rk-karte-hinweis rk-karte-hinweis--${esc(b.schwere)}">${esc(b.text)}</div>`).join('')}
        ${hinweise.map((h) => `<div class="rk-karte-hinweis">${esc(h)}</div>`).join('')}
        ${nutzlastWahlHTML(r)}
        <div class="rk-karte-aktionen">
          <button class="btn btn--ghost btn--sm" onclick="RoomConcept.anfliegen(this.dataset.guid)"
                  data-guid="${esc(r.guid)}" title="Den Raum ins Bild holen">⌖ Anfliegen</button>
          <button class="btn btn--ghost btn--sm" onclick="RoomConcept.setzeGeschoss(this.dataset.g)"
                  data-g="${esc(r.geschoss)}" title="Nur dieses Geschoss zeigen">Nur ${esc(r.geschoss)}</button>
          <select class="rk-karte-klasse" data-guid="${esc(r.guid)}"
                  onchange="RoomConcept.setzeKlasse(this.dataset.guid, this.value)"
                  title="Raumklasse — an ihr hängt das Anforderungsprofil aus dem Katalog">
            <option value="">— Klasse wählen —</option>
            ${RAUMKLASSEN.map((k) => `<option value="${k.klasse}"${k.klasse === r.klasse ? ' selected' : ''}>${esc(k.bezeichnung)}</option>`).join('')}
          </select>
        </div>
        ${abschnitte.map((a) => `
          <details class="props-group"${a.offen ? ' open' : ''}>
            <summary class="props-group-header"><span>${esc(a.titel)}</span><span class="props-group-count">${a.zeilen.length}</span></summary>
            <div class="props-group-body">${a.zeilen.map(zeile).join('')}</div>
          </details>`).join('')}
        <details class="props-group">
          <summary class="props-group-header"><span>IFC</span><span class="props-group-count">${ifcZeilen.length}</span></summary>
          <div class="props-group-body">
            ${ifcZeilen.map(([k, v]) => `<div class="props-row"><div class="props-key" title="${esc(k)}">${esc(k)}</div><div class="props-value" title="${esc(v)}">${esc(v)}</div></div>`).join('')}
          </div>
        </details>
        <details class="props-group">
          <summary class="props-group-header"><span>Property-Sets</span><span class="props-group-count" id="rk-karte-psets-zahl">…</span></summary>
          <div class="props-group-body" id="rk-karte-psets"><div class="props-empty">lädt …</div></div>
        </details>
        <div class="rk-karte-fuss">
          <span class="rk-q rk-q--ifc">IFC</span> aus dem Modell ·
          <span class="rk-q rk-q--statik">Statik</span> wie der Lastabtrag rechnet ·
          <span class="rk-q rk-q--katalog">Katalog</span> Richtwert der Raumklasse ·
          <span class="rk-q rk-q--abgeleitet">abgel.</span> gerechnet
        </div>
      </div>`;
  }

  function psetsHTML(daten) {
    const saetze = Object.entries(daten.psets || {}).sort(([a], [b]) => {
      // Normsätze zuerst — dort steht, was der Austausch meint.
      const na = /^(pset|qto)_/i.test(a) ? 0 : 1, nb = /^(pset|qto)_/i.test(b) ? 0 : 1;
      return na - nb || a.localeCompare(b, 'de');
    });
    if (!saetze.length) return '<div class="props-empty">Das IFC führt für diesen Raum keine Property-Sets.</div>';
    return saetze.map(([satz, werte]) => `
      <details class="props-group rk-pset">
        <summary class="props-group-header"><span>${esc(satz)}</span><span class="props-group-count">${Object.keys(werte).length}</span></summary>
        <div class="props-group-body">
          ${Object.entries(werte).map(([k, v]) => `
            <div class="props-row"><div class="props-key" title="${esc(k)}">${esc(k)}</div>
            <div class="props-value" title="${esc(Array.isArray(v) ? v.join(', ') : v)}">${esc(Array.isArray(v) ? v.join(', ') : (typeof v === 'number' ? merkmale().zahl(v, 3) : v))}</div></div>`).join('')}
        </div>
      </details>`).join('');
  }

  // Wird anderswo ein Bauteil gewählt oder die Anzeige geschlossen, endet
  // die Raumauswahl — sonst stünde der Raum hervorgehoben im Bild, während
  // die Anzeige längst etwas anderes zeigt.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('ileen:auswahl', (e) => {
      if (RC._eigeneMeldung) return;
      const d = e && e.detail;
      if (d && d.ifcType === 'IfcSpace' && d.globalId === RC.auswahl) return;
      KARTE.titelZurueck();
      if (RC.auswahl) {
        RC.auswahl = null;
        if (KOERPER.aktiv()) KOERPER.faerben();
        listeMarkieren();
      }
    });
  }

  // =====================================================
  // 12 · GESCHOSS FREISCHNEIDEN
  // =====================================================
  //
  // Ein gewähltes Geschoss zeigt seine Räume — aber das Modell darüber liegt
  // weiter davor. Das Schnittwerkzeug (schnitt.js) kann genau das: die Box
  // von unter der Rohdecke bis zur Oberkante der Räume. Die Raumansicht
  // leiht es sich aus, statt eigene Clipping-Ebenen zu setzen — zwei
  // Werkzeuge, die am selben Tileset schneiden, vertrügen sich nicht, und
  // schnitt.js schließt die Schnittflächen sogar.
  //
  // Was vorher war, wird gemerkt und zurückgegeben: Lief der Schnitt schon,
  // bekommt er seine Box zurück; lief er nicht, wird er wieder beendet.

  /** Wie weit unter dem Fußboden geschnitten wird — die Rohdecke soll im Bild bleiben. */
  const UNTER_FUSSBODEN = 0.45;

  const SCHNITT = {
    vorher: null,
    aktiv: false,

    anwenden() {
      const S = global.BimViewer && global.BimViewer.Schnitt;
      if (!S || typeof S.starten !== 'function') return;
      const soll = RC.sichtbar && RC.layout === 'modell' && RC.freischnitt &&
        RC.geschossWahl.size > 0 && hatBoxen();
      if (!soll) { this.aus(); return; }

      const raeume = RC.raeume.filter((r) => r.box && RC.geschossWahl.has(r.geschoss));
      const tileset = aktivesTileset();
      if (!raeume.length || !tileset || !tileset.root) return;
      const zMin = Math.min(...raeume.map((r) => r.box.lo[2]));
      const zMax = Math.max(...raeume.map((r) => r.box.hi[2]));
      const cx = raeume.reduce((s, r) => s + (r.box.lo[0] + r.box.hi[0]) / 2, 0) / raeume.length;
      const cy = raeume.reduce((s, r) => s + (r.box.lo[1] + r.box.hi[1]) / 2, 0) / raeume.length;

      if (!this.aktiv) {
        const Z = S.zustand || {};
        this.vorher = { an: !!S.an, box: Z.box ? { min: Z.box.min.slice(), max: Z.box.max.slice() } : null };
        if (!S.an && !S.starten()) { this.vorher = null; return; }
        this.aktiv = true;
      }
      const Z = S.zustand || {};
      const inRahmen = S._intern && S._intern.inRahmen;
      if (!inRahmen || !Z.szene) return;
      // Dieselbe Umrechnung wie bei den Körpern — sonst schnitte die Box eine
      // halbe Gebäudehöhe über dem Geschoss, das sie freilegen soll.
      const M = raumNachWelt(tileset);
      const unten = inRahmen(welt(M, cx, cy, zMin - UNTER_FUSSBODEN))[2];
      const oben = inRahmen(welt(M, cx, cy, zMax))[2];
      S.setBox([Z.szene.min[0], Z.szene.min[1], unten], [Z.szene.max[0], Z.szene.max[1], oben]);
    },

    aus() {
      if (!this.aktiv) return;
      this.aktiv = false;
      const S = global.BimViewer && global.BimViewer.Schnitt;
      const vorher = this.vorher;
      this.vorher = null;
      if (!S) return;
      if (vorher && vorher.box) S.setBox(vorher.box.min, vorher.box.max);
      else if (typeof S.ganz === 'function') S.ganz();
      if (vorher && !vorher.an && typeof S.beenden === 'function') S.beenden();
    },
  };

  /**
   * Die eine Stelle, an der entschieden wird, wie die Räume erscheinen.
   *
   * Alle Ansichten zeigen dieselben Räume mit denselben Farben und denselben
   * Filtern — als Körper an ihrer Stelle, als eingefärbte Kacheln oder im
   * gerechneten Raster. Deshalb schaltet jeder Filterwechsel über diese
   * Funktion, statt dass jede Ansicht ihren eigenen Weg zurück ins Bild hätte.
   */
  function darstellen() {
    if (RC.layout === 'modell') {
      // Welcher Weg gilt, entscheidet die Herkunft der Räume, nicht der
      // Benutzer: Wo es Hüllquader gibt, werden Körper gezeichnet; wo
      // IfcSpace in den Kacheln steckt, wird eingefärbt.
      if (hatBoxen()) {
        MODELL.aus();
        loesche();
        const n = KOERPER.zeigen();
        if (n === null) return false;
        RC.sichtbar = true;
        SCHNITT.anwenden();
        return true;
      }
      KOERPER.entfernen();
      loesche();
      if (RC.nurRaeume) blendeModellAus(false);
      const ok = MODELL.an();
      if (ok) klickAnmelden();
      return ok;
    }
    MODELL.aus();
    KOERPER.entfernen();
    SCHNITT.aus();
    zeichne();
    klickAnmelden();
    return true;
  }

  /** Nach einem Filter- oder Kriterienwechsel: Bild, Liste, Steckbrief nachziehen. */
  function nachziehen() {
    tooltip(null);
    if (RC.sichtbar) darstellen();
    zeichnePanel();
    const r = raumVon(RC.auswahl);
    if (r && kartOffen()) KARTE.zeigen(r);
  }

  function kartOffen() {
    if (typeof document === 'undefined') return false;
    const k = document.querySelector && document.querySelector('#infoBoxCustom .rk-karte');
    return !!k;
  }

  // =====================================================
  // 13 · PANEL
  // =====================================================

  /**
   * Raumnamen kommen aus dem Modell und gehen ins Markup — ein Name wie
   * `Büro "Nord" & Lager` oder ein Anführungszeichen in der GlobalId würde
   * das Attribut sonst vorzeitig schließen.
   */
  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function melde(text, fehler, knopf) {
    const el = document.getElementById('rk-status');
    if (!el) return;
    el.textContent = text;
    el.className = fehler ? 'rk-status rk-status--fehler' : 'rk-status';
    if (knopf && typeof document.createElement === 'function') {
      const b = document.createElement('button');
      b.className = 'btn btn--primary btn--block btn--sm rk-status-knopf';
      b.textContent = knopf.text;
      b.addEventListener('click', knopf.tun);
      el.appendChild(b);
    }
  }

  /**
   * Das Modell, auf das sich das Panel bezieht.
   *
   * `BimViewer.loadedAssets` ist eine **Map** assetId → assetData — nicht
   * `assets` und nicht `tilesets`; die gibt es nicht, und das Panel meldete
   * deshalb bei jedem Klick „Kein Modell geladen".
   *
   * Ein GLB-Asset führt statt `tileset` ein `model` und hat keine Features,
   * also auch keine Räume — solche werden übersprungen. Genommen wird das
   * erste sichtbare Tileset: mehrere gleichzeitig einzulesen mischte Räume
   * aus verschiedenen Bauwerken in ein Raumbuch.
   */
  function aktivesAsset() {
    const geladen = global.BimViewer?.loadedAssets;
    if (!geladen || typeof geladen.values !== 'function') return null;

    let verborgen = null;
    for (const asset of geladen.values()) {
      if (!asset || !asset.tileset) continue;
      if (asset.visible !== false && asset.tileset.show !== false) return asset;
      verborgen ??= asset;
    }
    // Ist alles ausgeblendet, wird das versteckte Modell eingelesen. Die
    // Räume stehen in der Batch Table und nicht im Bild — zu behaupten, es
    // sei keines geladen, wäre schlicht falsch.
    return verborgen;
  }

  function aktivesTileset() {
    return aktivesAsset()?.tileset || null;
  }

  /**
   * Ein Cesium-ion-Asset — nur solche tragen eine Asset-ID, unter der die
   * Elements-API antwortet. Backend-, iTwin- und GLB-Modelle haben keine.
   */
  function ionAsset() {
    const geladen = global.BimViewer?.loadedAssets;
    if (!geladen || typeof geladen.values !== 'function') return null;
    for (const asset of geladen.values()) {
      if (asset && asset.tileset && asset.type === '3DTILES') return asset;
    }
    return null;
  }

  /**
   * Das Backend-Modell, auf das sich die Raumansicht bezieht: das, aus dem
   * eingelesen wurde, sonst das sichtbare, sonst das erste. Mit zwei geladenen
   * Fassungen desselben Modells nähme „das erste" sonst immer die ältere —
   * auch dann, wenn es sie im Backend nicht mehr gibt.
   */
  function backendAsset() {
    const geladen = global.BimViewer?.loadedAssets;
    if (!geladen || typeof geladen.values !== 'function') return null;
    const alle = [...geladen.values()].filter((a) => a?.jobId);
    return alle.find((a) => a.jobId === RC._jobId) ||
      alle.find((a) => a.visible !== false && a.tileset?.show !== false) || alle[0] || null;
  }

  /**
   * Gibt es das Modell im Backend noch? Und wenn nicht: die neueste Fassung
   * gleichen Namens. Ein gelöschtes Modell bleibt im Bild stehen (die Kacheln
   * liegen im Zwischenspeicher des Browsers), aber jede Anfrage dazu endet in
   * 404 — und die Meldung des Backends sagt dann „keine IFC-Quelldatei".
   */
  async function nachfolger(asset) {
    const basis = global.BimViewer?.getBackendUrl?.();
    if (!basis || !asset) return null;
    let liste;
    try {
      const resp = await fetch(`${basis}/assets/`);
      if (!resp.ok) return null;
      liste = await resp.json();
    } catch (_) { return null; }
    liste = Array.isArray(liste) ? liste : (liste.assets || []);
    if (liste.some((a) => a.job_id === asset.jobId)) return null;   // gibt es — der 404 hat einen anderen Grund
    const ifcs = liste.filter((a) => a.content_type === 'ifc')
      .sort((a, b) => String(b.last_modified).localeCompare(String(a.last_modified)));

    // Erst der Name. Ohne Namen geladen (Zustand wiederhergestellt, Kennung
    // eingetippt) heißt das Modell im Viewer nur „Backend: <Kennung>".
    const stamm = (n) => String(n || '').replace(/\.[^.]+$/, '').toLowerCase();
    const benannt = asset.name && !/^Backend: /.test(asset.name);
    let neu = benannt ? ifcs.find((a) => stamm(a.name) === stamm(asset.name)) || null : null;
    let woran = neu ? 'name' : null;

    // Dann der Ort: die alte Fassung trägt ihre Verortung noch im geladenen
    // Tileset. Eine neuere IFC-Fassung, die auf 50 m am selben Fleck steht,
    // ist mit großer Wahrscheinlichkeit dasselbe Gebäude. Nur die zwölf
    // jüngsten werden gefragt — ein Nachfolger ist neu.
    const ort = asset.tileset?.root?.extras?.ileen;
    if (!neu && ort && Number.isFinite(ort.lon) && Number.isFinite(ort.lat)) {
      const abstand = (p) => {
        const dy = (p.lat - ort.lat) * 111320;
        const dx = (p.lon - ort.lon) * 111320 * Math.cos((ort.lat * Math.PI) / 180);
        return Math.hypot(dx, dy);
      };
      for (const a of ifcs.slice(0, 12)) {
        try {
          const resp = await fetch(`${basis}/assets/${encodeURIComponent(a.job_id)}/placement`);
          if (!resp.ok) continue;
          const p = await resp.json();
          if (Number.isFinite(p.lon) && Number.isFinite(p.lat) && abstand(p) < 50) { neu = a; woran = 'ort'; break; }
        } catch (_) { /* nächster */ }
      }
    }
    return { fehlt: true, neu, woran };
  }

  /** Die gelöschte Fassung aus der Szene nehmen, die neue laden und einlesen. */
  RC.fassungTauschen = async function (altJob, neuJob, neuName) {
    const V = global.BimViewer;
    if (!V) return;
    melde(`Lade ${neuName || neuJob} …`);
    const altKey = [...V.loadedAssets.entries()].find(([, a]) => a?.jobId === altJob)?.[0];
    if (altKey !== undefined) V.unloadAsset(altKey);
    if (![...V.loadedAssets.values()].some((a) => a?.jobId === neuJob)) await V.loadBackendAsset(neuJob, neuName);
    RC._jobId = neuJob;
    await RC.scanBackend();
  };

  RC.getPanelHTML = function () {
    return `
      <div class="rk-panel">
        <div class="rk-intro">
          Räume nach Geschoss und Nutzung, eingefärbt nach Nutzung, Nutzlast,
          TGA-Kennwerten oder Brandschutz. Ein Klick auf einen Raum zeigt
          seinen Steckbrief — jede Angabe mit ihrer Quelle.
        </div>

        <div class="rk-actions">
          <button class="btn btn--primary btn--sm" onclick="RoomConcept.einlesen()"
                  title="Räume des geladenen Modells holen und zeigen — bei Backend-Modellen mit Grundriss und IFC-Merkmalen">
            Räume einlesen</button>
          <button class="btn btn--ghost btn--sm" onclick="RoomConcept.scan()"
                  title="IfcSpace aus den geladenen Kacheln — nur bei Modellen, die Räume mittilen">
            Aus den Kacheln</button>
          <button class="btn btn--ghost btn--sm" onclick="RoomConcept.scanElementsAPI()"
                  title="Vollständig statt nur die geladenen Kacheln — braucht ein ion-Design-Modell">
            + Elements-API</button>
        </div>

        <div id="rk-status" class="rk-status">Noch nichts eingelesen.</div>
        <div id="rk-body"></div>
      </div>`;
  };

  function flaecheVon(rs) {
    return rs.reduce((s, r) => s + (r.flaeche || STANDARDFLAECHE), 0);
  }

  function offenHTML(offen) {
    if (!offen.length) return '';
    return `
      <details class="rk-offen"${offen.length <= 12 ? ' open' : ''}>
        <summary><b>${offen.length}</b> Räume ohne Klasse — sie gehen nicht in den Export</summary>
        <div class="rk-offen-hinweis">
          Weder am Namen noch an der Nutzung im IFC war eine Raumklasse zu
          erkennen. Die Klasse entscheidet über das Anforderungsprofil aus dem
          Katalog, deshalb wird hier nicht geraten. Im Modell stehen sie grau —
          wo ein Raum liegt, erklärt meist, wie er heißt.
        </div>
        ${offen.map((r) => `
          <div class="rk-offen-zeile">
            <span class="rk-offen-name" title="${esc(r.geschoss)}"
                  onclick="RoomConcept.waehle(this.dataset.guid, { fliegen: true })"
                  data-guid="${esc(r.guid)}">${r.nr ? esc(r.nr) + ' · ' : ''}${esc(r.name)}</span>
            <select onchange="RoomConcept.setzeKlasse(this.dataset.guid, this.value)"
                    data-guid="${esc(r.guid)}">
              <option value="">— wählen —</option>
              ${RAUMKLASSEN.map((k) => `<option value="${k.klasse}">${k.bezeichnung}</option>`).join('')}
            </select>
          </div>`).join('')}
      </details>`;
  }

  function geschossChipsHTML() {
    const folge = [...geschossFolge()].reverse();   // von oben nach unten, wie im Schnitt
    const zahl = new Map();
    for (const r of RC.raeume) zahl.set(r.geschoss, (zahl.get(r.geschoss) || 0) + 1);
    const schnittDa = !!(global.BimViewer && global.BimViewer.Schnitt);
    return `
      <div class="rk-abschnitt">
        <div class="rk-abschnitt-kopf">
          <span>Geschoss</span>
          <span class="rk-werkzeuge">
            <button class="rk-icon" onclick="RoomConcept.geschossSchritt(1)" title="Ein Geschoss höher">▲</button>
            <button class="rk-icon" onclick="RoomConcept.geschossSchritt(-1)" title="Ein Geschoss tiefer">▼</button>
            ${schnittDa ? `<button class="rk-icon${RC.freischnitt ? ' rk-icon--an' : ''}" onclick="RoomConcept.setzeFreischnitt(${!RC.freischnitt})"
                    title="Modell über dem gewählten Geschoss wegschneiden (Schnittwerkzeug)">✂</button>` : ''}
            <button class="rk-icon${RC.stempel ? ' rk-icon--an' : ''}" onclick="RoomConcept.setzeStempel(${!RC.stempel})"
                    title="Raumstempel im Bild — erscheinen, sobald ein Geschoss gewählt ist">🏷</button>
          </span>
        </div>
        <div class="rk-chips" role="group" aria-label="Geschosse">
          <button class="rk-chip${RC.geschossWahl.size ? '' : ' rk-chip--an'}" onclick="RoomConcept.setzeGeschoss('')">Alle</button>
          ${folge.map((g) => `
            <button class="rk-chip${RC.geschossWahl.has(g) ? ' rk-chip--an' : ''}" data-g="${esc(g)}"
                    onclick="RoomConcept.toggleGeschoss(this.dataset.g, event)"
                    title="${esc(g)} — ${zahl.get(g) || 0} Räume. Umschalt- oder Strg-Klick wählt mehrere.">
              ${esc(g)}<small>${zahl.get(g) || 0}</small></button>`).join('')}
        </div>
      </div>`;
  }

  /**
   * Kurznamen für die Chips. Das erste Wort der Bezeichnung taugt nicht:
   * „Notwendiger" stünde für Flur und Treppenraum zugleich.
   */
  const KURZ = {
    buero: 'Büro', besprechung: 'Besprechung', versammlung: 'Saal', lounge: 'Aufenthalt',
    teekueche: 'Teeküche', sanitaer: 'WC', sanitaer_b: 'WC barrierefrei', putzraum: 'Putzraum',
    garderobe: 'Garderobe', flur: 'Flur', treppenraum: 'Treppenraum', aufzug: 'Aufzug',
    lager: 'Lager', archiv: 'Archiv', kopie: 'Kopierraum', server: 'Server', labor: 'Labor',
    werkstatt: 'Werkstatt', technik_elt: 'Elektro', technik_hzg: 'HLS-Zentrale',
    schacht: 'Schacht', garage: 'Garage',
  };

  /** Nutzungsfilter, wenn nach etwas anderem eingefärbt wird — sonst ist die Legende der Filter. */
  function nutzungChipsHTML() {
    const zahl = new Map();
    for (const r of RC.raeume) zahl.set(r.klasse || '', (zahl.get(r.klasse || '') || 0) + 1);
    const zonen = Object.keys(ZONEN_META);
    const klassen = [...zahl.keys()].sort((a, b) => {
      const za = a ? zonen.indexOf(KLASSE_INDEX[a].zone) : 99, zb = b ? zonen.indexOf(KLASSE_INDEX[b].zone) : 99;
      return za - zb || zahl.get(b) - zahl.get(a);
    });
    return `
      <div class="rk-chips rk-chips--nutzung" role="group" aria-label="Nutzung">
        <span class="rk-chips-titel">Nutzung</span>
        <button class="rk-chip${RC.klassenFilter.size ? '' : ' rk-chip--an'}" onclick="RoomConcept.alleKlassen()">alle</button>
        ${klassen.map((k) => {
          const kl = k ? KLASSE_INDEX[k] : null;
          return `<button class="rk-chip${RC.klassenFilter.has(k) ? ' rk-chip--an' : ''}" data-k="${esc(k)}"
                    onclick="RoomConcept.toggleKlasse(this.dataset.k)" title="${esc(kl ? kl.bezeichnung : 'ohne Klasse')}">
                    <i style="background:${kl ? kl.farbe : FARBE_OHNE_KLASSE}"></i>${esc(kl ? (KURZ[k] || kl.bezeichnung) : 'ohne Klasse')}<small>${zahl.get(k)}</small></button>`;
        }).join('')}
      </div>`;
  }

  function kriteriumHTML() {
    const RM = merkmale();
    return `
      <select class="rk-kriterium" onchange="RoomConcept.setzeKriterium(this.value)"
              title="Wonach die Räume eingefärbt werden — Liste, Stempel und Steckbrief zeigen denselben Wert">
        ${RM.auswahl().map((g) => `
          <optgroup label="${esc(g.gruppe)}">
            ${g.kriterien.map((k) => `<option value="${k.key}"${k.key === RC.kriterium ? ' selected' : ''}>${esc(k.label)}${k.einheit ? ' (' + esc(k.einheit) + ')' : ''}</option>`).join('')}
          </optgroup>`).join('')}
      </select>`;
  }

  function legendeHTML() {
    const RM = merkmale();
    const ein = einteilung();
    const k = ein.kriterium;
    const nachKlasse = k.key === 'klasse';
    const filter = nachKlasse ? RC.klassenFilter : RC.legendenFilter;
    const maxFlaeche = Math.max(1, ...ein.legende.map((z) => z.flaeche));
    // „Vorgabe der Annahmen" ist ein Zustand, keine Angabe — er zählt nicht mit.
    const anteil = [...ein.werte.values()].filter((w) => w && w.wert !== null && w.wert !== undefined).length;
    const quellen = new Map();
    for (const w of ein.werte.values()) if (w && w.quelle) quellen.set(w.quelle.art, (quellen.get(w.quelle.art) || 0) + 1);

    return `
      <div class="rk-legende">
        ${ein.legende.map((z) => {
          const schluessel = nachKlasse && z.key === RM.OHNE ? '' : z.key;
          const aktiv = !filter.size || filter.has(schluessel);
          const kl = nachKlasse ? KLASSE_INDEX[z.key] : null;
          const profil = kl ? `${kl.lux} lx · ${kl.luft} m³/(h·m²) · ${kl.nutzlast} kN/m²` +
            `${kl.brand ? ' · F ' + kl.brand : ''} · ${kl.schall} dB · ${kl.elektro} W/m²` +
            `${kl.feuchtraum ? ' · Abdichtung' : ''}${kl.abluft ? ' · Abluft' : ''}` : '';
          return `
          <div class="rk-klasse ${aktiv ? '' : 'rk-klasse--aus'}" data-k="${esc(schluessel)}"
               onclick="RoomConcept.toggleLegende(this.dataset.k)"
               title="${esc((profil ? kl.bezeichnung + ' — Katalog: ' + profil + '\n' : '') + 'Klicken: nur diese zeigen bzw. wieder dazunehmen')}">
            <span class="rk-dot" style="background:${z.farbe}"></span>
            <span class="rk-klasse-name">${esc(z.label)}</span>
            <span class="rk-klasse-zahl">${z.anzahl} · ${RM.zahl(z.flaeche, 0)} m²${k.summe && z.summe ? ' · Σ ' + RM.zahl(z.summe, z.summe < 10 ? 1 : 0) + ' ' + esc(k.einheit) : ''}</span>
            <span class="rk-balken"><i style="width:${(100 * z.flaeche / maxFlaeche).toFixed(1)}%;background:${z.farbe}"></i></span>
            ${kl && filter.has(schluessel) ? `<div class="rk-anf">${profil}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
      <div class="rk-legende-fuss">
        ${anteil} von ${RC.raeume.length} Räumen mit Angabe${quellen.size ? ' · ' + [...quellen.entries()].map(([art, n]) => `${quelleHTML({ art, text: '' })} ${n}`).join(' ') : ''}
      </div>`;
  }

  /** Die Raumliste, nach Geschoss gegliedert — von oben nach unten wie im Schnitt. */
  function listeHTML() {
    const RM = merkmale();
    const ein = einteilung();
    const k = ein.kriterium;
    const treffer = RC.raeume.filter((r) => sichtbar(r) && suchePasst(r));
    const gruppen = new Map();
    for (const g of [...geschossFolge()].reverse()) gruppen.set(g, []);
    for (const r of treffer) {
      if (!gruppen.has(r.geschoss)) gruppen.set(r.geschoss, []);
      gruppen.get(r.geschoss).push(r);
    }
    const offen = RC._offen || (RC._offen = new Set());
    const alleOffen = !!RC.suchText || RC.geschossWahl.size === 1 || gruppen.size <= 2;

    const zeilen = [...gruppen.entries()].filter(([, rs]) => rs.length).map(([g, rs]) => {
      rs.sort((a, b) => String(a.nr).localeCompare(String(b.nr), 'de', { numeric: true }) ||
        a.name.localeCompare(b.name, 'de'));
      const summe = k.summe ? rs.reduce((s, r) => { const w = ein.werte.get(r.guid); return s + (w && Number.isFinite(w.wert) ? w.wert : 0); }, 0) : null;
      return `
        <details class="rk-gs"${alleOffen || offen.has(g) || rs.some((r) => r.guid === RC.auswahl) ? ' open' : ''}
                 data-g="${esc(g)}" ontoggle="RoomConcept._geschossAufgeklappt(this.dataset.g, this.open)">
          <summary>
            <span class="rk-gs-name">${esc(g)}</span>
            <span class="rk-gs-zahl">${rs.length} · ${RM.zahl(flaecheVon(rs), 0)} m²${summe !== null ? ' · Σ ' + RM.zahl(summe, summe < 10 ? 1 : 0) + ' ' + esc(k.einheit) : ''}</span>
          </summary>
          ${rs.map((r) => {
            const w = ein.werte.get(r.guid);
            const wertText = k.key === 'klasse' ? (r.flaeche ? RM.zahl(r.flaeche) + ' m²' : '') : (w ? w.text : '—');
            return `
            <div class="rk-raum${r.guid === RC.auswahl ? ' rk-raum--an' : ''}" data-guid="${esc(r.guid)}"
                 onclick="RoomConcept.waehle(this.dataset.guid, { fliegen: true })"
                 onmouseenter="RoomConcept.vorschau(this.dataset.guid)" onmouseleave="RoomConcept.vorschau(null)"
                 title="${esc((r.nr ? r.nr + ' · ' : '') + r.name)}">
              <span class="rk-dot" style="background:${farbeVon(r)}"></span>
              <span class="rk-raum-nr">${esc(r.nr || '—')}</span>
              <span class="rk-raum-name">${esc(r.name)}</span>
              <span class="rk-raum-wert" title="${esc(wertText)}">${esc(wertText)}</span>
            </div>`;
          }).join('')}
        </details>`;
    }).join('');
    return zeilen || '<div class="rk-leer">Kein Raum passt zu Filter und Suche.</div>';
  }

  function pruefungenHTML() {
    const P = pruefung();
    if (!P) return '';
    const auffaellig = P.befunde.length;
    return `
      <details class="rk-abschnitt rk-pruefungen"${auffaellig ? ' open' : ''}>
        <summary class="rk-abschnitt-kopf">
          <span>Prüfungen</span>
          <span class="rk-abschnitt-zahl">${auffaellig ? auffaellig + ' Befunde' : 'ohne Befund'}</span>
        </summary>
        ${P.uebersicht.map((u) => {
          const liste = P.befunde.filter((b) => b.pruefung === u.pruefung);
          return `
          <div class="rk-pruefung">
            <div class="rk-pruefung-kopf">
              <span class="rk-ampel rk-ampel--${u.warnung ? 'warnung' : u.hinweis ? 'hinweis' : u.geprueft ? 'ok' : 'leer'}"></span>
              <b>${esc(u.titel)}</b>
              <span>${u.geprueft} geprüft${u.warnung ? ' · ' + u.warnung + ' Warnungen' : ''}${u.hinweis ? ' · ' + u.hinweis + ' Hinweise' : ''}</span>
            </div>
            <div class="rk-pruefung-grundlage">${esc(u.grundlage)}${u.ohne ? ' — ' + esc(u.ohne) : ''}</div>
            ${liste.slice(0, 40).map((b) => {
              const raum = raumVon(b.guid);
              return `<div class="rk-befund rk-befund--${esc(b.schwere)}" data-guid="${esc(b.guid)}"
                           onclick="RoomConcept.waehle(this.dataset.guid, { fliegen: true })" title="${esc(b.text)}">
                        <span class="rk-raum-nr">${esc(raum ? raum.nr || '—' : '')}</span>
                        <span class="rk-raum-name">${esc(raum ? raum.name : b.guid)}</span>
                        <span class="rk-raum-wert">${esc(raum ? raum.geschoss : '')}</span>
                      </div>`;
            }).join('')}
            ${liste.length > 40 ? `<div class="rk-leer">… und ${liste.length - 40} weitere — Einfärben nach „Prüfbefund“ zeigt alle.</div>` : ''}
          </div>`;
        }).join('')}
        <div class="rk-export-hinweis">Geprüft wird in der Grundrissebene am Modell — eine Vorprüfung,
          kein Brandschutz- oder TGA-Nachweis. Einfärben nach „Prüfbefund" zeigt das Ergebnis im Bild.</div>
      </details>`;
  }

  /** Kennwerte je IfcZone — nur, wenn das Modell Zonen führt. */
  function zonenHTML() {
    const RM = merkmale();
    if (!RM.kennwerteJeZone) return '';
    const zonen = RM.kennwerteJeZone(RC.raeume);
    if (!zonen.length) return '';
    return `
      <details class="rk-abschnitt rk-kennwerte">
        <summary class="rk-abschnitt-kopf"><span>Zonen im IFC (IfcZone)</span><span class="rk-abschnitt-zahl">${zonen.length}</span></summary>
        <table class="rk-tabelle">
          <thead><tr><th>Zone</th><th>Räume</th><th>m²</th><th>Geschosse</th></tr></thead>
          <tbody>${zonen.map((z) => `<tr><td class="rk-t-name">${esc(z.zone)}</td><td>${z.anzahl}</td>
            <td>${RM.zahl(z.flaeche, 0)}</td><td>${esc(z.geschosse.join(', '))}</td></tr>`).join('')}</tbody>
        </table>
        <div class="rk-export-hinweis">Brandabschnitte, Wohnungen oder Mietbereiche, wie das Modell sie
          gruppiert (IfcRelAssignsToGroup). Einfärben nach „Zone im IFC“ zeigt sie im Bild.</div>
      </details>`;
  }

  /** Was die Ansicht weiß, als Pset_iLEEN_Raum zurück ins IFC. */
  function ifcHTML() {
    if (!backendAsset() || !RC.raeume.some((r) => r.box)) return '';
    return `
      <details class="rk-abschnitt rk-ifc">
        <summary class="rk-abschnitt-kopf"><span>Ins IFC schreiben</span></summary>
        <div class="rk-export-hinweis">
          Eine Kopie des Modells mit <code>Pset_iLEEN_Raum</code> je Raum: Raumklasse, Nutzlast der
          Statik, TGA-Kennwerte, Befunde — und je Wert die Herkunft in
          <code>Pset_iLEEN_RaumHerkunft</code>. Wieder hochgeladen, bringt die Datei ihre Zuordnungen
          mit; Richtwerte aus dem Katalog kommen dabei nicht als Planungsangabe zurück.
        </div>
        <label class="rk-haken">
          <input type="checkbox" id="rk-normsaetze"${RC._normsaetze ? ' checked' : ''}
                 onchange="RoomConcept._normsaetze = this.checked">
          Auch leere IFC-Normsätze füllen (Pset_Space…, DIN-277-Klassifikation) — nie überschreiben
        </label>
        <button class="btn btn--primary btn--block btn--sm" onclick="RoomConcept.ifcSchreiben()">
          IFC mit Raumdaten herunterladen</button>
      </details>`;
  }

  function kennwerteHTML() {
    const RM = merkmale();
    const raeume = RC.raeume.filter((r) => klassePasst(r) && legendePasst(r));
    const { zeilen, gesamt } = RM.kennwerteJeGeschoss(raeume, katalog(), geschossFolge());
    const gefiltert = raeume.length !== RC.raeume.length;
    const z = (row, tag = 'td') => `
      <tr>
        <${tag} class="rk-t-name">${esc(row.geschoss)}<small>${row.anzahl}</small></${tag}>
        <${tag}>${RM.zahl(row.flaeche, 0)}</${tag}>
        <${tag}>${RM.zahl(row.personen, 0)}</${tag}>
        <${tag}>${RM.zahl(row.luft, 0)}</${tag}>
        <${tag}>${RM.zahl(row.elektro, 1)}</${tag}>
        <${tag}>${row.nutzlast === null ? '—' : RM.zahl(row.nutzlast, 2)}</${tag}>
      </tr>`;
    return `
      <details class="rk-abschnitt rk-kennwerte">
        <summary class="rk-abschnitt-kopf"><span>Kennwerte je Geschoss${gefiltert ? ' (gefiltert)' : ''}</span></summary>
        <table class="rk-tabelle">
          <thead><tr><th>Geschoss</th><th title="Netto-Raumfläche">m²</th><th title="Personen">Pers.</th>
            <th title="Außenluftvolumenstrom">Luft m³/h</th><th title="Elektrische Anschlussleistung">Elt kW</th>
            <th title="Nutzlast, flächengewichtet über die Räume mit bekannter Kategorie">q̄ kN/m²</th></tr></thead>
          <tbody>${zeilen.map((row) => z(row)).join('')}</tbody>
          <tfoot>${z(gesamt, 'th')}</tfoot>
        </table>
        <div class="rk-export-hinweis">
          Je Raum dieselben Werte wie im Steckbrief: IFC vor Katalog. Die Nutzlast
          ist die Kategorie des Lastabtrags, gemittelt über die Fläche der Räume,
          deren Nutzung erkannt ist.
        </div>
      </details>`;
  }

  /** Panelinhalt neu zeichnen — nach jedem Schritt, der die Räume ändert. */
  function zeichnePanel() {
    const body = document.getElementById('rk-body');
    if (!body) return;
    if (!RC.raeume.length) { body.innerHTML = ''; return; }

    const offen = RC.raeume.filter((r) => !r.klasse);
    const geklaert = RC.raeume.filter((r) => r.klasse);
    const geschosse = geschossFolge();
    const nutzungen = new Set(geklaert.map((r) => r.klasse));
    const zuSehen = RC.raeume.filter(sichtbar).length;

    body.innerHTML = `
      ${offenHTML(offen)}

      <div class="rk-kennzahlen">
        <div><b>${RC.raeume.length}</b><span>Räume</span></div>
        <div><b>${flaecheVon(RC.raeume).toFixed(0)}</b><span>m² NGF</span></div>
        <div><b>${nutzungen.size}</b><span>Nutzungen</span></div>
        <div><b>${geschosse.length}</b><span>Geschosse</span></div>
      </div>

      <!-- Zwei Ansichten derselben Räume, mit denselben Farben und Filtern:
           an ihrer Stelle im Bau, oder im gerechneten Raster, das exportiert
           wird. Der Umschalter steht über den Filtern, weil er bestimmt,
           worauf diese wirken. -->
      <div class="rk-layout" role="group" aria-label="Ansicht">
        <button class="rk-layout-btn${RC.layout === 'modell' ? ' rk-layout-btn--an' : ''}"
                onclick="RoomConcept.setzeLayout('modell')"
                title="Die Räume an ihrer Stelle im Gebäude">
          Im Modell</button>
        <button class="rk-layout-btn${RC.layout === 'raster' ? ' rk-layout-btn--an' : ''}"
                onclick="RoomConcept.setzeLayout('raster')"
                title="Der gerechnete Zweibund am Mittelflur — das, was exportiert wird">
          Raster</button>
      </div>

      ${RC.layout === 'raster' ? `
      <!-- Der Bezugspunkt wird aus der Hüllkugel des Tilesets geschätzt; die
           trifft die Sohle des Gebäudes nur ungefähr. Ein Regler ist hier
           ehrlicher als eine Formel, die vorgibt, es genau zu wissen. Im
           Modell liegen die Räume an ihrer eigenen Stelle — dort gibt es
           nichts zu schätzen und deshalb auch nichts zu schieben. -->
      <div class="rk-zeile">
        <label>Höhe ${RC.hoehenOffset >= 0 ? '+' : ''}${RC.hoehenOffset.toFixed(1)} m</label>
        <input type="range" class="slider" min="-30" max="30" step="0.5"
               value="${RC.hoehenOffset}"
               oninput="RoomConcept.setzeHoehe(this.value)">
      </div>` : ''}

      <div class="rk-actions">
        <button class="btn btn--primary btn--sm" onclick="RoomConcept.anzeigen()">
          ${RC.sichtbar ? 'Neu zeichnen' : 'Räume anzeigen'}</button>
        <button class="btn btn--ghost btn--sm" onclick="RoomConcept.ausblenden()">Ausblenden</button>
        ${RC.layout === 'raster' || hatBoxen() ? `
        <!-- Beim Einfärben tritt das Gebäude von selbst zurück; Raumkörper
             und Rasterquader stehen dagegen im Bau und wären sonst verdeckt. -->
        <button class="btn btn--ghost btn--sm" onclick="RoomConcept.modellZuruecknehmen()">
          ${RC.nurRaeume ? 'Modell zeigen' : 'Modell zurücknehmen'}</button>` : ''}
      </div>

      ${geschossChipsHTML()}

      <div class="rk-abschnitt">
        <div class="rk-abschnitt-kopf"><span>Einfärben nach</span></div>
        ${kriteriumHTML()}
        ${RC.kriterium !== 'klasse' ? nutzungChipsHTML() : ''}
        ${legendeHTML()}
      </div>

      <div class="rk-abschnitt">
        <div class="rk-abschnitt-kopf">
          <span>Räume</span><span class="rk-abschnitt-zahl">${zuSehen} von ${RC.raeume.length}</span>
        </div>
        <input class="rk-suche" type="search" placeholder="Nummer oder Name …" value="${esc(RC.suchText)}"
               oninput="RoomConcept.suche(this.value)"
               onkeydown="if (event.key === 'Enter') RoomConcept.ersterTreffer()">
        <div id="rk-liste" class="rk-liste">${listeHTML()}</div>
      </div>

      ${pruefungenHTML()}

      ${kennwerteHTML()}

      ${zonenHTML()}

      ${ifcHTML()}

      <details class="rk-export">
        <summary class="rk-abschnitt-kopf"><span>Ausgabe für das Baustellen-Navi</span></summary>
        <button class="btn btn--primary btn--block" onclick="RoomConcept.exportKonzept()">
          raumkonzept.json schreiben</button>
        <button class="btn btn--ghost btn--block btn--sm" onclick="RoomConcept.exportRaumbuch()">
          raumbuch.csv schreiben</button>
        <div class="rk-export-hinweis">
          Ablegen unter <code>BIMLP/Dijkstra/data/</code>, dann
          <code>Baustellen-Navi-Raumkonzept.ipynb</code> ausführen.
        </div>
      </details>`;
  }

  /** Nur die Liste — die Suche soll beim Tippen ihren Fokus behalten. */
  function zeichneListe() {
    const el = typeof document !== 'undefined' && document.getElementById('rk-liste');
    if (el) el.innerHTML = listeHTML();
  }

  function listeMarkieren() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    document.querySelectorAll('.rk-raum').forEach((el) => {
      const an = el.dataset && el.dataset.guid === RC.auswahl;
      el.classList.toggle('rk-raum--an', an);
      if (an) {
        const gs = el.closest && el.closest('details');
        if (gs && !gs.open) gs.open = true;
        if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  // =====================================================
  // 14 · ÖFFENTLICHE BEFEHLE
  // =====================================================

  /** Nach jedem Einlesen: was an Auswahl und Filtern an den alten Räumen hing, gilt nicht mehr. */
  function neueRaeume() {
    RC.auswahl = null;
    RC.hover = null;
    RC.legendenFilter.clear();
    RC.geschossWahl.clear();
    RC.klassenFilter.clear();
    RC._offen = new Set();
    KOERPER.entfernen();
  }

  /**
   * Der eine Knopf: Räume holen und zeigen.
   *
   * Woher, entscheidet das Modell — ein Backend-Modell hat die Räume nur im
   * Backend, ein ion-Modell vielleicht über die Elements-API, sonst bleiben
   * die Kacheln. Danach steht die Ansicht sofort im Bild, statt dass man
   * noch einmal „anzeigen" suchen muss.
   */
  RC.einlesen = async function () {
    if (backendAsset()) await RC.scanBackend();
    else if (ionAsset() && global.BimViewer?.getIonToken?.()) {
      await RC.scanElementsAPI();
      if (!RC.raeume.length) RC.scan();
    } else RC.scan();
    if (RC.raeume.length) RC.anzeigen();
  };

  RC.scan = function () {
    const tileset = aktivesTileset();
    if (!tileset) { melde('Kein Modell geladen.', true); return; }

    const roh = sammleAusKacheln(tileset);
    if (!roh.size) {
      // Bei einem Backend-Modell ist das kein Sonderfall, sondern der
      // Normalfall: Der Tiler lässt IfcSpace gar nicht erst in die Kacheln.
      // Den Benutzer hier raten zu lassen, wäre Zeitverschwendung.
      if (aktivesAsset()?.type === 'BACKEND') {
        melde('Backend-Modelle führen keine Räume in den Kacheln — der Tiler lässt ' +
              'IfcSpace bewusst weg, sonst deckte das Raumvolumen jede Wand zu. ' +
              'Nimm „Räume einlesen": dort kommen sie aus dem Backend, mit Grundriss.', true);
      } else {
        melde('Keine IfcSpace-Objekte in den geladenen Kacheln. Viele Modelle führen ' +
              'keine Räume — oder der Tiler hat sie weggelassen. Über das Backend ' +
              'oder die Elements-API ist auch das prüfbar.', true);
      }
      neueRaeume();
      RC.raeume = [];
      zeichnePanel();
      return;
    }

    neueRaeume();
    RC.raeume = bereiteAuf(roh);
    RC.quelle = 'geladene Kacheln';
    RC.unvollstaendig = true;
    RC.projektname = aktivesAsset()?.name || RC.projektname;
    RC._origin = null;
    baueKonzept();

    const offen = RC.raeume.filter((r) => !r.klasse).length;
    melde(`${RC.raeume.length} Räume aus den geladenen Kacheln` +
          (offen ? `, ${offen} ohne erkannte Nutzung.` : '.') +
          ' Kacheln zeigen nur, was gerade im Bild ist — für die vollständige Liste die Elements-API.');
    zeichnePanel();
  };

  /**
   * Räume aus dem eigenen Backend — der Weg für Backend-Modelle.
   *
   * Liefert als einziger Weg die Grundrissfigur mit und damit die echte
   * Lage und Form, dazu die IFC-Merkmale und die Nutzlast der Statik.
   */
  RC.scanBackend = async function () {
    const asset = backendAsset();
    if (!asset) {
      melde('Dafür braucht es ein über das eigene Backend geladenes Modell — ' +
            'ion-Assets haben keine Job-Kennung.', true);
      return;
    }

    melde('Frage die Raumliste im Backend ab — der erste Aufruf je Modell liest ' +
          'Geometrie und Psets der Räume und dauert.');
    try {
      const roh = await sammleAusBackend(asset.jobId);
      if (!roh.size) {
        melde('Das Backend hat das Modell gelesen und darin keinen einzigen ' +
              'IfcSpace gefunden — die Datei führt keine Räume. Daran ändert kein ' +
              'Werkzeug etwas; die Räume müssen im Autorenwerkzeug angelegt werden.', true);
        neueRaeume();
        RC.raeume = [];
        zeichnePanel();
        return;
      }

      neueRaeume();
      RC.raeume = bereiteAuf(roh);
      RC._jobId = asset.jobId;
      RC.quelle = 'Backend';
      RC.unvollstaendig = false;
      RC.projektname = asset.name || RC.projektname;
      RC._origin = null;
      baueKonzept();

      nutzlastKategorienLaden().then(() => {
        const r = RC.auswahl && raumVon(RC.auswahl);
        if (r && kartOffen()) KARTE.zeigen(r);
      });
      const offen = RC.raeume.filter((r) => !r.klasse).length;
      const mitIfc = RC.raeume.filter((r) => Object.keys(r.merkmale || {}).length).length;
      melde(`${RC.raeume.length} Räume aus dem Backend, mit Grundriss` +
            (mitIfc ? `, ${mitIfc} mit Angaben aus den Psets` : '') +
            (offen ? `, ${offen} ohne erkannte Nutzung.` : '.'));
      zeichnePanel();
    } catch (err) {
      const n = err.status === 404 ? await nachfolger(asset) : null;
      if (n && n.fehlt) {
        const kurz = asset.jobId.slice(0, 8);
        if (n.neu) {
          const wann = new Date(n.neu.last_modified).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
          melde(`Das Modell ${kurz} gibt es im Backend nicht mehr — gelöscht oder neu hochgeladen; ` +
                `im Bild steht noch die alte Fassung aus dem Zwischenspeicher. Neuere Fassung ` +
                `${n.woran === 'ort' ? 'am selben Ort' : 'gleichen Namens'}: ${n.neu.name} ` +
                `vom ${wann} (${n.neu.job_id.slice(0, 8)}).`, true,
                { text: 'Neue Fassung laden und Räume einlesen',
                  tun: () => RC.fassungTauschen(asset.jobId, n.neu.job_id, n.neu.name) });
        } else {
          melde(`Das Modell ${kurz} gibt es im Backend nicht mehr — es wurde gelöscht. Im Bild steht ` +
                'noch die Fassung aus dem Zwischenspeicher; eine neuere gleichen Namens oder am selben Ort ' +
                'gibt es nicht.', true);
        }
        return;
      }
      melde(`Backend nicht erreichbar oder Modell ohne verwertbare Geometrie: ${err.message}`, true);
    }
  };

  RC.scanElementsAPI = async function () {
    const token = global.BimViewer?.getIonToken?.();
    const asset = ionAsset();
    if (!token || !asset) {
      melde('Dafür braucht es ein Cesium-ion-Asset und ein Token mit assets:read.', true);
      return;
    }
    melde('Frage die Elements-API ab …');
    try {
      const roh = await sammleAusElementsAPI(asset.id, token);
      if (!roh.size) {
        melde('Die Elements-API kennt für dieses Asset keine IfcSpace-Objekte — ' +
              'das Modell führt keine Räume.', true);
        return;
      }
      neueRaeume();
      RC.raeume = bereiteAuf(roh);
      RC.quelle = 'Elements-API';
      RC.unvollstaendig = false;
      RC.projektname = asset.name || RC.projektname;
      RC._origin = null;
      baueKonzept();
      const offen = RC.raeume.filter((r) => !r.klasse).length;
      melde(`${RC.raeume.length} Räume über die Elements-API — vollständig` +
            (offen ? `, ${offen} ohne erkannte Nutzung.` : '.'));
      zeichnePanel();
    } catch (err) {
      melde(`Elements-API nicht verfügbar: ${err.message}. Der Weg über die Kacheln ` +
            'funktioniert weiterhin.', true);
    }
  };

  RC.setzeKlasse = function (guid, klasse) {
    const r = raumVon(guid);
    if (!r) return;
    r.klasse = klasse || null;
    // Ab hier `hand` — beide Zieldateien kennen den Wert, und er hält fest,
    // dass hier ein Mensch entschieden hat und keine Regel gegriffen hat.
    r.erkannt = klasse ? 'hand' : null;
    r.treffer = '';
    RC._klassenStand = (RC._klassenStand || 0) + 1;
    baueKonzept();
    nachziehen();
  };

  RC.toggleKlasse = function (klasse) {
    const k = klasse || '';
    if (RC.klassenFilter.has(k)) RC.klassenFilter.delete(k);
    else RC.klassenFilter.add(k);
    // Alle wieder an, sobald alles ausgewählt ist — ein voller Filter soll
    // „alles zeigen" heißen, wie ein leerer.
    const vorhanden = new Set(RC.raeume.map((r) => r.klasse || ''));
    if ([...vorhanden].every((x) => RC.klassenFilter.has(x))) RC.klassenFilter.clear();
    nachziehen();
  };

  RC.alleKlassen = function () {
    RC.klassenFilter.clear();
    nachziehen();
  };

  /** Eine Legendenzeile ein- oder ausschalten. Nach Nutzung eingefärbt, ist das der Nutzungsfilter. */
  RC.toggleLegende = function (key) {
    if (RC.kriterium === 'klasse') { RC.toggleKlasse(key); return; }
    if (RC.legendenFilter.has(key)) RC.legendenFilter.delete(key);
    else RC.legendenFilter.add(key);
    if (RC.legendenFilter.size === einteilung().legende.length) RC.legendenFilter.clear();
    nachziehen();
  };

  RC.setzeKriterium = function (key) {
    const RM = merkmale();
    if (!RM.KRITERIUM[key] || key === RC.kriterium) return;
    RC.kriterium = key;
    // Die Legendenzeilen des alten Kriteriums bedeuten im neuen nichts.
    RC.legendenFilter.clear();
    liveAbfrage();
    nachziehen();
  };

  /**
   * Messwerte nur abfragen, solange ein Live-Kriterium gewählt ist — und jede neue
   * Antwort färbt neu. Ohne `RaumSensorik` (raum-sensorik.js nicht geladen) bleibt
   * das Kriterium leer, die Raumansicht läuft unverändert.
   */
  function liveAbfrage() {
    const S = global.RaumSensorik;
    if (!S) return;
    if (String(RC.kriterium).startsWith('live_')) S.start();
    else S.stop();
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('ileen:raumsensorik', () => {
      if (String(RC.kriterium).startsWith('live_') && RC.raeume && RC.raeume.length) nachziehen();
    });
  }

  /** Genau ein Geschoss zeigen — oder mit '' alle. */
  RC.setzeGeschoss = function (key) {
    RC.geschossWahl.clear();
    if (key) RC.geschossWahl.add(key);
    nachziehen();
  };

  /**
   * Klick auf ein Geschoss: nur dieses — ein zweiter Klick wieder alle.
   * Mit Umschalt oder Strg kommen weitere hinzu, etwa zwei übereinander
   * liegende Geschosse, um einen Steigstrang zu verfolgen.
   */
  RC.toggleGeschoss = function (key, ereignis) {
    const mehrere = ereignis && (ereignis.shiftKey || ereignis.ctrlKey || ereignis.metaKey);
    if (mehrere) {
      if (RC.geschossWahl.has(key)) RC.geschossWahl.delete(key);
      else RC.geschossWahl.add(key);
    } else if (RC.geschossWahl.size === 1 && RC.geschossWahl.has(key)) {
      RC.geschossWahl.clear();
    } else {
      RC.geschossWahl.clear();
      RC.geschossWahl.add(key);
    }
    nachziehen();
  };

  /** ▲▼: ein Geschoss weiter. Ohne Wahl beginnt ▲ unten und ▼ oben. */
  RC.geschossSchritt = function (richtung) {
    const folge = geschossFolge();
    if (!folge.length) return;
    let i;
    if (RC.geschossWahl.size !== 1) i = richtung > 0 ? 0 : folge.length - 1;
    else i = Math.max(0, Math.min(folge.length - 1, folge.indexOf([...RC.geschossWahl][0]) + Math.sign(richtung)));
    RC.setzeGeschoss(folge[i]);
  };

  RC.setzeFreischnitt = function (an) {
    RC.freischnitt = !!an;
    if (RC.freischnitt) SCHNITT.anwenden(); else SCHNITT.aus();
    zeichnePanel();
  };

  /** Die Nutzlastkategorien des Lastabtrags — einmal je Sitzung. */
  async function nutzlastKategorienLaden() {
    if (RC._nutzlastKat) return RC._nutzlastKat;
    const asset = backendAsset();
    const basis = global.BimViewer?.getBackendUrl?.();
    if (!asset || !basis) return null;
    try {
      const resp = await fetch(`${basis}/assets/${encodeURIComponent(asset.jobId)}/tragwerk/eingriffe/arten`);
      if (!resp.ok) return null;
      RC._nutzlastKat = (await resp.json()).nutzlastkategorien || [];
    } catch (_) { RC._nutzlastKat = null; }
    return RC._nutzlastKat;
  }

  /**
   * Die Nutzlast eines Raums für die Statik setzen — oder mit '' aufheben.
   *
   * Als Eingriff am System (`nutzlast_raum`), nicht als Wert in der Ansicht:
   * so erscheint er im FE-Browser, geht in den Eingabe-Hash ein und macht
   * genau die Geschosse veraltet, unter deren Decke der Raum liegt. Ein
   * geänderter Eingriff ist ein aufgehobener und ein neuer — dieselbe Regel
   * wie bei allen Eingriffen, damit der Verlauf lesbar bleibt.
   */
  RC.setzeNutzlast = async function (guid, kategorie) {
    const r = raumVon(guid);
    const asset = backendAsset();
    const basis = global.BimViewer?.getBackendUrl?.();
    if (!r || !asset || !basis) return;
    const url = `${basis}/assets/${encodeURIComponent(asset.jobId)}/tragwerk/eingriffe`;
    const vorher = r.nutzlast || {};
    try {
      if (vorher.eingriff) {
        const weg = await fetch(`${url}/${encodeURIComponent(vorher.eingriff)}`, { method: 'DELETE' });
        if (!weg.ok && weg.status !== 404) throw new Error(`Eingriff ${vorher.eingriff} nicht aufhebbar (HTTP ${weg.status})`);
      }
      if (kategorie) {
        const resp = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ art: 'nutzlast_raum', bauteil: r.guid, wert: { kategorie },
                                 notiz: `Raumansicht: ${r.nr ? r.nr + ' ' : ''}${r.name}` }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${(await resp.text()).slice(0, 160)}`);
        const e = await resp.json();
        const k = (RC._nutzlastKat || []).find((x) => x.kategorie === kategorie) || {};
        r.nutzlast = { kategorie, q_k_kNm2: k.q_k_kNm2, beschreibung: k.beschreibung,
                       norm: 'DIN EN 1991-1-1/NA Tab. 6.1DE', eingriff: e.nr, gedeutet: vorher.gedeutet || null,
                       herkunft: `von Hand gesetzt (Eingriff Nr. ${e.nr}) — gilt ab dem nächsten Lastabtrag` };
        melde(`Nutzlast ${kategorie} für ${r.nr || r.name} gesetzt (Eingriff Nr. ${e.nr}). ` +
              'Die Geschosse darunter stehen im FE-Browser jetzt auf „veraltet".');
      } else {
        const g = vorher.gedeutet;
        r.nutzlast = g ? { ...g, norm: 'DIN EN 1991-1-1/NA Tab. 6.1DE', gedeutet: g,
                           herkunft: 'aus der Raumnutzung erkannt (raumlasten.kategorie_von)' }
                       : { kategorie: null, gedeutet: null,
                           herkunft: 'keine Nutzung erkennbar — der Lastabtrag setzt die Vorgabe der Annahmen an' };
        melde(`Eingriff aufgehoben — für ${r.nr || r.name} gilt wieder die Deutung aus der Nutzung.`);
      }
      RC._klassenStand = (RC._klassenStand || 0) + 1;
      nachziehen();
    } catch (err) {
      melde(`Nutzlast nicht gesetzt: ${err.message}`, true);
    }
  };

  /** Der Auftrag an `POST …/rooms/ifc`: je Raum Klasse, Herkunft und die Werte der Ansicht. */
  function ifcAuftrag() {
    const RM = merkmale();
    const kat = katalog();
    const raeume = {};
    for (const r of RC.raeume) {
      const kl = r.klasse ? KLASSE_INDEX[r.klasse] : null;
      raeume[r.guid] = {
        klasse: r.klasse || null, klasse_bezeichnung: kl ? kl.bezeichnung : null,
        klasse_herkunft: r.erkannt || null,
        werte: RM.ifcWerte(r, kat),
      };
    }
    return { raeume, normsaetze: !!RC._normsaetze };
  }

  /** Eine Kopie des IFC mit Pset_iLEEN_Raum je Raum herunterladen. */
  RC.ifcSchreiben = async function () {
    const asset = backendAsset();
    const basis = global.BimViewer?.getBackendUrl?.();
    if (!asset || !basis) { melde('Ins IFC schreiben geht bei Backend-Modellen.', true); return; }
    melde(`Schreibe ${RC.raeume.length} Räume ins IFC — bei großen Modellen dauert das so lange wie das Einlesen …`);
    try {
      const resp = await fetch(`${basis}/assets/${encodeURIComponent(asset.jobId)}/rooms/ifc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ifcAuftrag()),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${(await resp.text()).slice(0, 200)}`);
      const blob = await resp.blob();
      const k = (n) => resp.headers.get(`X-iLEEN-${n}`) || '0';
      const name = ((resp.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'raeume.ifc';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      melde(`${name}: ${k('Raeume')} Räume mit ${k('Werte')} Werten in Pset_iLEEN_Raum` +
            (Number(k('Ersetzt')) ? `, ${k('Ersetzt')} ältere Sätze ersetzt` : '') +
            (RC._normsaetze ? `, ${k('Normsaetze')} Normwerte ergänzt` +
              (Number(k('Normsaetze-Geteilt')) ? ` (${k('Normsaetze-Geteilt')} geteilte Sätze nicht angefasst)` : '') +
              `, ${k('DIN277')} DIN-277-Klassifikationen` : '') + '.');
    } catch (err) {
      melde(`IFC nicht geschrieben: ${err.message}`, true);
    }
  };

  RC.setzeStempel = function (an) {
    RC.stempel = !!an;
    KOERPER.stempelSetzen();
    global.BimViewer?.viewer?.scene?.requestRender?.();
    zeichnePanel();
  };

  /** Suche in der Liste — nur die Liste wird neu gezeichnet, das Feld behält den Fokus. */
  RC.suche = function (text) {
    RC.suchText = String(text || '');
    zeichneListe();
  };

  /** Enter im Suchfeld: den ersten Treffer wählen und anfliegen. */
  RC.ersterTreffer = function () {
    const r = RC.raeume.find((x) => sichtbar(x) && suchePasst(x));
    if (r) RC.waehle(r.guid, { fliegen: true });
  };

  /**
   * Einen Raum wählen: hervorheben, Steckbrief zeigen, in der Liste markieren.
   *
   * `fliegen` holt ihn ins Bild — aus der Liste gewählt, weiß man sonst nicht,
   * wo er liegt; im Bild angeklickt, liegt er schon vor einem.
   */
  RC.waehle = function (guid, optionen) {
    const o = optionen || {};
    const r = raumVon(guid);
    RC.auswahl = r ? String(r.guid) : null;
    if (KOERPER.aktiv()) KOERPER.faerben();
    else if (MODELL.aktiv()) { MODELL.stempel += 1; MODELL.alleTiles((t) => MODELL.tileFaerben(t)); }
    listeMarkieren();
    if (!r) { if (!o.still) KARTE.schliessen(); return; }
    // Ein Raum, den Filter gerade ausblenden, wäre gewählt und unsichtbar.
    if (!sichtbar(r) && RC.geschossWahl.size && !RC.geschossWahl.has(r.geschoss)) {
      RC.geschossWahl.clear();
      RC.geschossWahl.add(r.geschoss);
      nachziehen();
    }
    KARTE.zeigen(r);
    if (o.fliegen) RC.anfliegen(r.guid);
  };

  /** Zeiger über einer Listenzeile: den Raum im Bild aufleuchten lassen. */
  RC.vorschau = function (guid) {
    const g = guid ? String(guid) : null;
    if (g === RC.hover) return;
    RC.hover = g;
    if (KOERPER.aktiv()) KOERPER.faerben();
  };

  /** Den Raum ins Bild holen — schräg von oben, wie man in einen Grundriss schaut. */
  RC.anfliegen = function (guid) {
    const r = raumVon(guid);
    const viewer = global.BimViewer?.viewer;
    if (!r || !viewer) return;
    let mitte = null, radius = 3;
    const d = KOERPER.daten.get(String(r.guid));
    const tileset = aktivesTileset();
    // Dort, wo der Raum jetzt steht — in der Explosion ein paar Geschosse höher.
    if (d) { mitte = KOERPER.weltpunkt(r.guid, d.mitte); radius = d.radius; }
    else if (r.box && tileset && tileset.root) {
      const { lo, hi } = r.box;
      mitte = welt(raumNachWelt(tileset), (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
      radius = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    } else if (RC.layout === 'raster') {
      const e = RC.entities.find((x) => {
        const g = x.properties && x.properties.guid;
        return String(g && typeof g.getValue === 'function' ? g.getValue() : g) === String(r.guid);
      });
      if (e && e.position) mitte = typeof e.position.getValue === 'function' ? e.position.getValue() : e.position;
    }
    if (!mitte) return;
    if (typeof global.BimViewer._disableWalkAndFly === 'function') global.BimViewer._disableWalkAndFly();
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(mitte, Math.max(radius, 2)), {
      duration: 1.0,
      offset: new Cesium.HeadingPitchRange(viewer.camera.heading, Cesium.Math.toRadians(-50),
                                           Math.max(radius * 3.2, 14)),
    });
  };

  /** Aufgeklappte Geschosse der Liste merken — sonst klappt jedes Neuzeichnen sie zu. */
  RC._geschossAufgeklappt = function (g, offen) {
    const menge = RC._offen || (RC._offen = new Set());
    if (offen) menge.add(g); else menge.delete(g);
  };

  /**
   * Zwischen der Lage im Bau und dem gerechneten Raster umschalten.
   *
   * Steht gerade etwas im Bild, wandert es mit — sonst müsste der Benutzer
   * nach dem Umschalten noch einmal auf „anzeigen" drücken, um dasselbe zu
   * sehen, das er schon sah.
   */
  RC.setzeLayout = function (wert) {
    const neu = wert === 'modell' ? 'modell' : 'raster';
    if (neu === RC.layout) return;
    RC.layout = neu;
    if (RC.sichtbar) darstellen();
    zeichnePanel();
  };

  RC.setzeHoehe = function (wert) {
    RC.hoehenOffset = parseFloat(wert) || 0;
    // Nur die Beschriftung nachziehen, nicht das ganze Panel: Ein
    // Neuaufbau des Markups während des Ziehens nähme dem Regler den Fokus.
    const label = document.querySelector('.rk-zeile input[type="range"]')?.previousElementSibling;
    if (label) label.textContent = `Höhe ${RC.hoehenOffset >= 0 ? '+' : ''}${RC.hoehenOffset.toFixed(1)} m`;
    // Der Regler verschiebt den geschätzten Bezugspunkt des Rasters. Die
    // Räume im Modell liegen an ihrer eigenen Stelle und haben keinen.
    if (RC.sichtbar && RC.layout === 'raster') zeichne();
  };

  RC.anzeigen = function () {
    if (!RC.raeume.length) { melde('Erst Räume einlesen.', true); return; }

    // Raumkörper stecken im Gebäude. Beim ersten Zeigen tritt das Modell
    // deshalb von selbst zurück — sonst klickt man „anzeigen", sieht nichts
    // und hält es für kaputt. Danach entscheidet der Knopf.
    const koerper = RC.layout === 'modell' && hatBoxen();
    if (koerper && !RC._schonZurueck) {
      RC._schonZurueck = true;
      blendeModellAus(true);
    }
    if (!darstellen()) { zeichnePanel(); return; }

    if (koerper) {
      const n = KOERPER.daten.size;
      melde(`${n} Räume an ihrer Stelle im Bau` +
            (RC.geschossWahl.size ? ` (${[...RC.geschossWahl].join(', ')})` : '') +
            (RC._rueckfall ? `, ${RC._rueckfall} davon als Hüllquader (Grundriss nicht verwertbar)` : '') +
            '. Ein Klick auf einen Raum zeigt seinen Steckbrief.');
    } else if (RC.layout === 'modell') {
      // Wurde kein einziger Raum getroffen, sind die Räume zwar eingelesen,
      // aber nicht in den Kacheln — der Weg über die Elements-API liest sie
      // aus dem Katalog, das Tileset muss sie deswegen nicht enthalten. Ohne
      // diese Meldung stünde ein blass gefärbtes Gebäude ohne Erklärung da.
      if (!MODELL.getroffen) {
        melde('Keiner der eingelesenen Räume steckt in den geladenen Kacheln. ' +
              'Bei einem Backend-Modell ist das der Normalfall — dort führt ' +
              '„Räume einlesen" über das Backend zu Räumen samt Lage.', true);
      } else {
        melde(`${MODELL.getroffen} Raumkörper im Modell eingefärbt` +
              (RC.geschossWahl.size ? ` (${[...RC.geschossWahl].join(', ')})` : '') + '.');
      }
    }
    zeichnePanel();
  };

  RC.ausblenden = function () {
    loesche();
    KOERPER.entfernen();
    MODELL.aus();
    SCHNITT.aus();
    klickAbmelden();
    if (RC.nurRaeume) blendeModellAus(false);
    RC.sichtbar = false;
    zeichnePanel();
  };

  RC.modellZuruecknehmen = function () {
    blendeModellAus(!RC.nurRaeume);
    zeichnePanel();
  };

  function schreibeDatei(name, inhalt, typ) {
    const blob = new Blob([inhalt], { type: typ });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  RC.exportKonzept = function () {
    if (!RC.raeume.length) { melde('Erst Räume einlesen.', true); return; }
    const daten = konzeptDaten();
    if (!daten.raeume.length) {
      melde('Kein Raum mit Klasse — ohne Nutzung gibt es kein Anforderungsprofil.', true);
      return;
    }
    schreibeDatei('raumkonzept.json', JSON.stringify(daten, null, 1), 'application/json');
    const ohneKlasse = RC.raeume.length - daten.raeume.length;
    melde(`raumkonzept.json geschrieben: ${daten.raeume.length} Räume, ` +
          `${daten.geschosse.length} Geschosse, ${daten.tueren.length} Türen.` +
          (ohneKlasse ? ` ${ohneKlasse} Räume ohne Klasse blieben draußen.` : ''));
  };

  RC.exportRaumbuch = function () {
    if (!RC.raeume.length) { melde('Erst Räume einlesen.', true); return; }
    schreibeDatei('raumbuch.csv', raumbuchCSV(), 'text/csv;charset=utf-8');
    melde('raumbuch.csv geschrieben — der Weg über das Fachmodell, mit GlobalId.');
  };

  // Offengelegt für andere Module und für Prüfungen außerhalb des Browsers:
  // Klassifizierung, Raster, Türen und Export hängen nicht an Cesium und
  // laufen deshalb auch unter Node — `globalThis.RoomConcept` nach dem Laden.
  RC.RAUMKLASSEN = RAUMKLASSEN;
  RC.KLASSE_INDEX = KLASSE_INDEX;
  RC.ZONEN_META = ZONEN_META;
  RC.klassifiziere = klassifiziere;
  RC.konzeptDaten = konzeptDaten;
  RC.raumbuchCSV = raumbuchCSV;
  RC._intern = { bereiteAuf, ordneGeschosse, baueRaster, baueTueren, beruehrpunkt, MODELL,
                 KOERPER, hoehenVersatz, raumNachWelt, KARTE, SCHNITT, einteilung, sichtbar, geschossFolge, raumKoerper,
                 innenpunkt, guidAusTreffer, karteHTML, pruefung, katalog, ifcAuftrag, nutzlastKategorienLaden, raumVon,
                 backendAsset, nachfolger,
                 aktivesAsset, aktivesTileset, ionAsset };

  global.RoomConcept = RC;

  // Die Toolbar wird bei jedem Sprachwechsel neu aufgebaut — das Panel ist
  // dann wieder das leere Grundgerüst aus `getPanelHTML`. Die eingelesenen
  // Räume leben im Modul weiter, also wird der Inhalt danach nachgezogen,
  // statt den Benutzer erneut einlesen zu lassen.
  if (typeof document !== 'undefined') {
    document.addEventListener('ileen:language-changed', () => {
      setTimeout(() => { if (RC.raeume.length) zeichnePanel(); }, 0);
    });
  }

  console.log('✅ Raumkonzept geladen —', RAUMKLASSEN.length, 'Raumklassen');

})(typeof window !== 'undefined' ? window : globalThis);
