// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Leistung der VR-Ansicht: messen und nachregeln. Ohne three.js und ohne DOM,
// damit es sich ohne Browser prüfen lässt (tests/vr/test-vr-leistung.mjs).
//
// Fünf Teile, jeder beantwortet eine Frage:
//
//   Bildmesser   Wie lange dauern die Bilder, und wie oft hängt es?
//   GueteRegler  Muss der zulässige Bildschirmfehler der Kacheln hoch, damit die
//                Brille ihre Bildrate hält — und wann darf er wieder herunter?
//   DruckRegler  Dasselbe für den Speicher: sind Kacheln dauerhaft verweigert, weil der
//                Zwischenspeicher voll ist, wird gröber verfeinert statt Teile wegzulassen.
//   Takt         In welchem Bild wird welcher Kachelbaum neu durchlaufen?
//   ParseTor     Darf in diesem Bild eine weitere Kachel anfangen zu entpacken?
//   Einblender   Wie viele frisch geladene Kacheln werden in diesem Bild zum ersten
//                Mal gezeichnet (Hochladen auf die Grafikkarte)?
//   xrTakt       Woher bekommen die Warteschlangen der Bibliothek ihren Takt?
//
// Der fünfte ist der Grund, warum es dieses Modul gibt: 3d-tiles-renderer
// taktet Download-, Parse- und Knoten-Warteschlangen über `Scheduler`, und der
// nimmt `window.requestAnimationFrame`, solange niemand `setXRSession` ruft.
// In einer immersiven Sitzung läuft das Fensterbild nicht mehr — die
// Warteschlangen stehen still, und das Modell bleibt unvollständig.

/** Ein Bild, das länger dauert, ist ein Hänger (Ziel der Aufgabe: keiner über ~50 ms). */
export const HAENGER_MS = 50;

/** Bildzeit-Budget in Millisekunden für eine Bildrate. */
export function budgetMs(hz) {
  return 1000 / (Number.isFinite(hz) && hz > 0 ? hz : 72);
}

// ─────────────────────────────────────────────────────────────────
// BILDMESSER
// ─────────────────────────────────────────────────────────────────

/**
 * Misst den Abstand zwischen Bildern aus deren Zeitstempeln. Der Abstand — nicht
 * die Rechenzeit der Seite — ist, was der Träger der Brille erlebt: ein
 * ausgelassenes Bild steht hier als doppelte Dauer, auch wenn die CPU nichts tat.
 */
export class Bildmesser {
  constructor(fenster = 144) {
    this.dt = new Float32Array(fenster);
    this.n = 0;
    this.pos = 0;
    this.letzte = null;
    this.haenger = 0;         // seit Beginn
    this.bilder = 0;          // seit Beginn
    this.laengstes = 0;       // seit Beginn
  }

  /** Ein Bild melden. Gibt den Abstand zum vorigen zurück, `null` beim ersten. */
  bild(zeitMs) {
    const letzte = this.letzte;
    this.letzte = zeitMs;
    if (letzte === null) return null;
    const dt = zeitMs - letzte;
    // Lücken über einer Sekunde sind kein Bild: Tab im Hintergrund, Sitzungsbeginn
    if (!(dt > 0) || dt > 1000) return null;
    this.dt[this.pos] = dt;
    this.pos = (this.pos + 1) % this.dt.length;
    this.n = Math.min(this.n + 1, this.dt.length);
    this.bilder++;
    if (dt > HAENGER_MS) this.haenger++;
    if (dt > this.laengstes) this.laengstes = dt;
    return dt;
  }

  /** Ohne Gedächtnis weitermessen (neue Sitzung). */
  zuruecksetzen() {
    this.n = 0; this.pos = 0; this.letzte = null;
    this.haenger = 0; this.bilder = 0; this.laengstes = 0;
  }

  /** Kennzahlen des Fensters (die letzten bis zu 144 Bilder). */
  auswerten(budget = budgetMs(72)) {
    const n = this.n;
    if (n === 0) return { n: 0, fps: 0, mittel: 0, p95: 0, max: 0, ueberBudget: 0, haengerFenster: 0 };
    const werte = Array.from(this.dt.subarray(0, n)).sort((a, b) => a - b);
    const summe = werte.reduce((s, x) => s + x, 0);
    const mittel = summe / n;
    const p95 = werte[Math.min(n - 1, Math.ceil(n * 0.95) - 1)];
    return {
      n,
      fps: 1000 / mittel,
      mittel,
      p95,
      max: werte[n - 1],
      ueberBudget: werte.filter(x => x > budget * 1.2).length / n,
      haengerFenster: werte.filter(x => x > HAENGER_MS).length,
    };
  }
}

/** Die letzten Werte einer Zeitmessung (Millisekunden), mit Mittel, p95 und Höchstwert. */
export class Zeitreihe {
  constructor(fenster = 144) {
    this.werte = new Float32Array(fenster);
    this.n = 0;
    this.pos = 0;
  }

  add(ms) {
    this.werte[this.pos] = ms;
    this.pos = (this.pos + 1) % this.werte.length;
    this.n = Math.min(this.n + 1, this.werte.length);
  }

  zuruecksetzen() { this.n = 0; this.pos = 0; }

  auswerten() {
    const n = this.n;
    if (!n) return { n: 0, mittel: 0, p95: 0, max: 0 };
    const w = Array.from(this.werte.subarray(0, n)).sort((a, b) => a - b);
    return {
      n,
      mittel: w.reduce((s, x) => s + x, 0) / n,
      p95: w[Math.min(n - 1, Math.ceil(n * 0.95) - 1)],
      max: w[n - 1],
    };
  }
}

/**
 * Alles, was die Anzeige braucht, an einer Stelle: Bildabstände, Rechenzeit der
 * Seite je Bild (Schleife und Kachel-Update getrennt), lange Aufgaben des
 * Browsers, dazu bei jeder Abfrage der Stand der Kachelbäume und des Zeichners.
 * Der Bildabstand ist, was der Träger der Brille erlebt; die Rechenzeit zeigt,
 * ob es an der Seite liegt oder an der Grafikkarte: ist der Abstand lang, die
 * Rechenzeit kurz, wartet das Bild auf die GPU.
 */
export class Messung {
  constructor() {
    this.bilder = new Bildmesser();
    this.schleife = new Zeitreihe();
    this.kacheln = new Zeitreihe();
    this.durchlauf = new Zeitreihe();
    this.lang = { n: 0, summe: 0, max: 0 };   // „long tasks" des Browsers (> 50 ms am Stück)
    this.seit = null;
  }

  bild(zeitMs) {
    if (this.seit === null) this.seit = zeitMs;
    return this.bilder.bild(zeitMs);
  }

  schleifeZeit(ms) { this.schleife.add(ms); }
  kachelZeit(ms) { this.kacheln.add(ms); }
  durchlaufZeit(ms) { this.durchlauf.add(ms); }

  langeAufgabe(dauerMs) {
    this.lang.n++;
    this.lang.summe += dauerMs;
    if (dauerMs > this.lang.max) this.lang.max = dauerMs;
  }

  zuruecksetzen() {
    this.bilder.zuruecksetzen();
    this.schleife.zuruecksetzen();
    this.kacheln.zuruecksetzen();
    this.durchlauf.zuruecksetzen();
    this.lang = { n: 0, summe: 0, max: 0 };
    this.seit = null;
  }

  /**
   * @param budget  Zielzeit je Bild (ms)
   * @param zeichnen  { aufrufe, dreiecke, geometrien, texturen } aus renderer.info
   * @param baeume  [{ name, t }] — die Kachelbäume (Modell zuerst)
   * @param extras  weiteres, das mit in den Stand soll (Güte, Takt …)
   */
  stand({ budget, zeichnen = {}, baeume = [], extras = {} } = {}) {
    const b = this.bilder.auswerten(budget);
    const liste = baeume.map(({ name, t }) => {
      const s = kachelStand(t);
      return { name, ...s, fehlend: fehlend(s) };
    });
    return {
      budget,
      bild: b,
      bilderGesamt: this.bilder.bilder,
      haenger: this.bilder.haenger,
      laengstes: this.bilder.laengstes,
      schleife: this.schleife.auswerten(),
      kachelUpdate: this.kacheln.auswerten(),
      durchlauf: this.durchlauf.auswerten(),
      lang: { ...this.lang },
      zeichnen,
      baeume: liste,
      fehlendGesamt: liste.reduce((s, x) => s + x.fehlend, 0),
      ...extras,
    };
  }
}

const f1 = x => (Number.isFinite(x) ? x.toFixed(1).replace('.', ',') : '–');
const f0 = x => (Number.isFinite(x) ? String(Math.round(x)) : '–');

/** Der Stand als Textzeilen — für das Tablet in der Brille und das Feld am Bildschirm. */
export function leistungZeilen(l) {
  const b = l.bild;
  const z = [];
  z.push(`${f0(b.fps)} Bilder/s · Ø ${f1(b.mittel)} ms · p95 ${f1(b.p95)} · max ${f1(b.max)}  (Ziel ${f1(l.budget)} ms)`);
  z.push(`Hänger über ${HAENGER_MS} ms: ${l.haenger} gesamt · ${b.haengerFenster} im Fenster · längstes ${f0(l.laengstes)} ms · über Budget ${f0(b.ueberBudget * 100)} %`);
  z.push(`Seite je Bild: Ø ${f1(l.schleife.mittel)} ms · max ${f1(l.schleife.max)} — davon Kachelbäume Ø ${f1(l.durchlauf.mittel)} · max ${f1(l.durchlauf.max)}`);
  z.push(`Lange Aufgaben (> 50 ms): ${l.lang.n} · Summe ${f0(l.lang.summe)} ms · längste ${f0(l.lang.max)} ms`);
  const d = l.zeichnen || {};
  z.push(`Zeichnen: ${f0(d.aufrufe)} Aufrufe · ${f1((d.dreiecke || 0) / 1e6)} Mio. Dreiecke · ${f0(d.geometrien)} Geometrien · ${f0(d.texturen)} Texturen`);
  for (const k of l.baeume) {
    z.push(`${k.name}: ${k.benutzt} benutzt · ${k.sichtbar} sichtbar · ${k.wartet}+${k.ladend}+${k.entpackend} (wartet+lädt+entpackt) · ${k.fehlgeschlagen} fehlgeschlagen · ${k.verweigert} verweigert`);
    z.push(`   Speicher ${f0(k.mb)} / ${f0(k.mbMax)} MB · ${k.eintraege} Kacheln · Fehlerziel ${f1(k.fehlerZiel)} px · ${f0(k.fortschritt * 100)} %`);
  }
  z.push(`Es fehlen noch ${l.fehlendGesamt} Kacheln${l.fehlendGesamt === 0 ? ' — vollständig' : ''}`);
  if (l.extra) for (const zeile of String(l.extra).split('\n')) z.push(zeile);
  return z;
}

// ─────────────────────────────────────────────────────────────────
// GÜTEREGLER
// ─────────────────────────────────────────────────────────────────

/**
 * Stellt einen Faktor 1 … max ein, mit dem der zulässige Bildschirmfehler der
 * Kacheln multipliziert wird: größer = gröbere Kacheln = weniger Dreiecke.
 *
 * Gemessen wird in Fenstern von einer Sekunde. Hänger (über dem Dreifachen des
 * Budgets) zählen nicht mit — sie kommen vom Entpacken einer Kachel, nicht
 * von der Last der Szene, und eine gröbere Kachelstufe löst sie nicht. Nach
 * jeder Änderung bleibt ein Fenster Ruhe, damit die neue Stufe erst einmal
 * ankommt; zurück geht es nur nach mehreren ruhigen Fenstern (Hysterese),
 * sonst pendelte der Wert jede Sekunde.
 */
export class GueteRegler {
  constructor({ min = 1, max = 3, hoch = 1.25, runter = 1.15, fensterMs = 1000, ruhig = 3 } = {}) {
    Object.assign(this, { min, max, hoch, runter, fensterMs, ruhig });
    this.faktor = min;
    this.zuruecksetzen();
  }

  zuruecksetzen() {
    this.faktor = this.min;
    this._summe = 0; this._n = 0; this._ueber = 0; this._spitzen = 0;
    this._start = null; this._ruhigZaehler = 0; this._pause = 0;
    this.letzte = null;       // Auswertung des letzten Fensters (zum Anzeigen)
  }

  /**
   * Ein Bild melden.
   * @param dtMs     Abstand zum vorigen Bild
   * @param budget   Zielzeit je Bild
   * @param jetztMs  Uhrzeit
   * @returns        der (womöglich neue) Faktor
   */
  bild(dtMs, budget, jetztMs) {
    if (this._start === null) this._start = jetztMs;
    if (dtMs > budget * 3) this._spitzen++;
    else {
      this._summe += dtMs;
      this._n++;
      if (dtMs > budget * 1.2) this._ueber++;
    }
    if (jetztMs - this._start < this.fensterMs) return this.faktor;

    // Fenster zu Ende
    const n = this._n;
    const mittel = n ? this._summe / n : 0;
    const ueber = n ? this._ueber / n : 0;
    this.letzte = { mittel, ueber, spitzen: this._spitzen, n, faktor: this.faktor };
    this._summe = 0; this._n = 0; this._ueber = 0; this._spitzen = 0;
    this._start = jetztMs;
    if (n < 20) return this.faktor;                  // zu wenig gesehen

    if (this._pause > 0) { this._pause--; return this.faktor; }

    const zuSchwer = mittel > budget * 1.10 || ueber > 0.20;
    const luftig = mittel < budget * 0.80 && ueber < 0.02;
    if (zuSchwer && this.faktor < this.max) {
      this.faktor = Math.min(this.faktor * this.hoch, this.max);
      this._ruhigZaehler = 0;
      this._pause = 1;
    } else if (luftig && this.faktor > this.min) {
      if (++this._ruhigZaehler >= this.ruhig) {
        this.faktor = Math.max(this.faktor / this.runter, this.min);
        this._ruhigZaehler = 0;
        this._pause = 1;
      }
    } else {
      this._ruhigZaehler = 0;
    }
    return this.faktor;
  }
}

// ─────────────────────────────────────────────────────────────────
// DRUCKREGLER (SPEICHER)
// ─────────────────────────────────────────────────────────────────

/**
 * Stellt denselben Faktor ein wie der GueteRegler, aber nach dem Speicher statt
 * nach der Bildzeit. Ist der Zwischenspeicher voll und stehen weiter Kacheln aus
 * (`verweigert` > 0, nichts mehr unterwegs), hilft Warten nicht: die benötigten
 * Kacheln sind größer als der Speicher. Dann wird der zulässige Fehler angehoben,
 * die Auswahl wird gröber, weniger Kacheln werden gebraucht — das Modell ist
 * gröber, aber nicht an zufälligen Stellen leer. Die Fehlerauswahl lässt Fernes
 * zuerst weg (der Fehler wächst mit der Entfernung rückwärts); verweigert der
 * Speicher, trifft es dagegen auch Nahes. Deshalb die hohe Obergrenze (×6).
 *
 * Zurück geht es, sobald eine Weile nichts mehr verweigert wird: nähert man sich
 * dem Modell, braucht die Ansicht weniger Kacheln, und die Verfeinerung muss
 * zurückkommen. Ein Speicherstand als Maßstab taugt dafür nicht — der LRU-Speicher
 * behält Unbenutztes bis zu seiner unteren Grenze, er steht also auch bei
 * kleinem Bedarf hoch. Stattdessen Zeit mit Rückfall-Verzögerung: kommt die
 * Verweigerung nach einem Schritt zurück bald wieder, verdoppelt sich die
 * Wartezeit bis zum nächsten (höchstens `maxEntspannMs`); sonst pendelte der
 * Faktor mit Laden und Verwerfen bei jedem Schritt.
 */
export class DruckRegler {
  constructor({ max = 6, hoch = 1.3, runter = 1.3, stauMs = 1500, entspannMs = 8000,
    rueckfallMs = 30000, maxEntspannMs = 120000 } = {}) {
    Object.assign(this, { max, hoch, runter, stauMs, entspannMs0: entspannMs, rueckfallMs, maxEntspannMs });
    this.zuruecksetzen();
  }

  zuruecksetzen() {
    this.faktor = 1;
    this.angehoben = 0;
    this.entspannMs = this.entspannMs0;
    this._seit = null;            // seit wann dauerhaft verweigert wird
    this._verweigertZuletzt = -Infinity;
    this._letzteSenkung = -Infinity;
    this._haltenBis = 0;
  }

  /**
   * @param s        kachelStand() des Modells
   * @param jetztMs  Uhrzeit
   * @returns        der (womöglich neue) Faktor
   */
  bild(s, jetztMs) {
    const unterwegs = s.wartet + s.ladend + s.entpackend;
    if (s.verweigert > 0) this._verweigertZuletzt = jetztMs;
    // Verweigert wird nur bei vollem Speicher. Dass noch einzelne Kacheln unterwegs
    // sind, ändert daran nichts: ihr Ankommen füllt ihn weiter. Gegen kurze Ausreißer
    // (der LRU gibt Unbenutztes erst nach und nach frei) schützt `stauMs`.
    const voll = s.verweigert > 0;
    if (voll) {
      if (this._seit === null) this._seit = jetztMs;
      if (jetztMs - this._seit >= this.stauMs && this.faktor < this.max) {
        // Kam es kurz nach einer Senkung zurück, war die Senkung zu früh
        if (jetztMs - this._letzteSenkung < this.rueckfallMs) {
          this.entspannMs = Math.min(this.entspannMs * 2, this.maxEntspannMs);
        }
        this.faktor = Math.min(this.faktor * this.hoch, this.max);
        this.angehoben++;
        this._haltenBis = jetztMs + this.entspannMs;
        this._seit = jetztMs;
      }
      return this.faktor;
    }
    this._seit = null;
    if (this.faktor > 1 && unterwegs === 0 && jetztMs >= this._haltenBis
        && jetztMs - this._verweigertZuletzt >= this.entspannMs
        && jetztMs - this._letzteSenkung >= this.entspannMs) {
      this.faktor = Math.max(this.faktor / this.runter, 1);
      this._letzteSenkung = jetztMs;
    }
    return this.faktor;
  }
}

// ─────────────────────────────────────────────────────────────────
// PUFFERREGLER (UNTERE GRENZE DES KACHELSPEICHERS)
// ─────────────────────────────────────────────────────────────────

/**
 * Wie viel von seinem Kachelspeicher das Modell behält, wenn es gerade nichts
 * Neues braucht. Die Bibliothek wirft Kacheln, die im letzten Durchlauf nicht
 * benutzt wurden (hinter dem Kopf, außerhalb des Blickfelds), schon dann hinaus,
 * wenn der Speicher über `minBytesSize` liegt — und zwar die am längsten nicht
 * gesehenen zuerst. Mit einer niedrigen unteren Grenze verschwindet beim
 * Umdrehen, was eben noch da war, und muss neu geladen werden.
 *
 * Der Regler hält die untere Grenze deshalb nahe an der oberen (`ruhe`), damit
 * Gesehenes stehen bleibt. Bricht die Bildrate ein (`lag`), senkt er sie auf
 * `lagAnteil`: dann geht das am längsten Ungesehene, also das Entfernteste,
 * hinaus und der Speicher wird entlastet. Zurück auf `ruhe` geht es erst nach
 * `haltenMs` ohne Lag, sonst pendelte die Grenze mit jedem Ausreißer.
 */
export class PufferRegler {
  constructor({ ruhe = 0.9, lagAnteil = 0.55, haltenMs = 6000 } = {}) {
    Object.assign(this, { ruhe, lagAnteil, haltenMs });
    this.anteil = ruhe;
    this._lagZuletzt = -Infinity;
  }

  /**
   * @param lag      Bildrate bricht gerade ein
   * @param jetztMs  Uhrzeit
   * @returns        Anteil der oberen Grenze, der als untere gilt
   */
  bild(lag, jetztMs) {
    if (lag) this._lagZuletzt = jetztMs;
    this.anteil = jetztMs - this._lagZuletzt < this.haltenMs ? this.lagAnteil : this.ruhe;
    return this.anteil;
  }

  zuruecksetzen() {
    this.anteil = this.ruhe;
    this._lagZuletzt = -Infinity;
  }
}

// ─────────────────────────────────────────────────────────────────
// TAKT DER KACHELBÄUME
// ─────────────────────────────────────────────────────────────────

/**
 * Soll der Kachelbaum Nummer `index` im Bild `bild` neu durchlaufen werden?
 *
 * Außerhalb der Brille in jedem Bild (der Rechner hat Luft). In der Brille
 * wechseln sich die Bäume ab: das Modell (index 0) in jedem zweiten Bild, die
 * übrigen — Gelände, Gebäude — reihum in den Bildern dazwischen. Der Durchlauf
 * kostet auf der Quest ein paar Millisekunden je Baum; dreimal je Bild war es
 * ein Drittel des Budgets für Arbeit, deren Ergebnis sich kaum ändert.
 * Was beim Aussetzen sichtbar war, bleibt stehen, nur neu Hinzukommendes ist
 * höchstens zwei bis drei Bilder (30–40 ms) später da.
 *
 *   anzahl 3:  Bild 0 Modell · 1 Gelände · 2 Modell · 3 Gebäude · 4 Modell …
 */
export function aktualisierenSoll(bild, index, anzahl, brille) {
  if (!brille || anzahl <= 1) return true;
  if (index === 0) return bild % 2 === 0;
  const umlauf = 2 * (anzahl - 1);
  return bild % umlauf === 2 * index - 1;
}

// ─────────────────────────────────────────────────────────────────
// PARSE-TOR
// ─────────────────────────────────────────────────────────────────

/**
 * Entscheidet, ob in diesem Bild eine weitere Kachel anfangen darf zu
 * entpacken. Das Entpacken einer Kachel (JSON, Puffer, Meshopt) läuft im
 * Hauptfaden und kostet auf der Quest je nach Größe 10–80 ms; mehrere auf einmal
 * sind ein Hänger. Das Tor lässt höchstens eine pro Bild an, und nur wenn vom
 * Budget noch etwas übrig ist. Damit das Modell trotzdem fertig wird, geht
 * nach `hungerMs` ohne Start eine durch — auch in einem schweren Bild.
 */
export class ParseTor {
  constructor({ reserveMs = 4, hungerMs = 300 } = {}) {
    this.reserveMs = reserveMs;
    this.hungerMs = hungerMs;
    this.letzter = -Infinity;
    this.gestartet = 0;
    this.erzwungen = 0;
  }

  /**
   * @param restMs   Budget, das im Bild noch übrig ist (negativ: überzogen)
   * @param jetztMs  Uhrzeit
   */
  erlaubt(restMs, jetztMs) {
    const frei = restMs >= this.reserveMs;
    const hunger = jetztMs - this.letzter >= this.hungerMs;
    if (!frei && !hunger) return false;
    if (!frei) this.erzwungen++;
    this.letzter = jetztMs;
    this.gestartet++;
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────
// EINBLENDER
// ─────────────────────────────────────────────────────────────────

/**
 * Hält frisch geladene Kacheln zurück und gibt sie nacheinander frei. Eine Kachel
 * wird erst beim ersten Zeichnen auf die Grafikkarte geladen (Vertexpuffer,
 * Texturen, Mips) — bei den großen Kacheln der IFC-Modelle (bis 35 MB Geometrie)
 * ist das ein Bild für sich. Treffen fünf zugleich ein, sind es fünf auf einmal.
 * Der Einblender macht daraus eine je Bild, und nur wenn das letzte Bild sein
 * Budget gehalten hat; nach `hungerMs` ohne Freigabe geht eine durch.
 *
 * Gedacht für additive Verfeinerung (`ADD`): eine zurückgehaltene Kachel fehlt dann
 * ein paar Bilder lang, mehr nicht. Bei `REPLACE` ersetzt sie ihre Eltern — dort
 * entstünde ein Loch, solche Kacheln gehören nicht hierher.
 */
export class Einblender {
  constructor({ proBild = 1, hungerMs = 120 } = {}) {
    this.proBild = proBild;
    this.hungerMs = hungerMs;
    this.warte = [];
    this.letzte = -Infinity;
    this.zurueckgehalten = 0;
    this.freigegeben = 0;
  }

  /** Eine Kachel ist eingetroffen: unsichtbar halten. */
  ankunft(szene) {
    szene.visible = false;
    this.warte.push(szene);
    this.zurueckgehalten++;
  }

  /** Die Kachel wurde verworfen, bevor sie freigegeben war. */
  entfernen(szene) {
    const i = this.warte.indexOf(szene);
    if (i >= 0) this.warte.splice(i, 1);
  }

  /**
   * Je Bild vor dem Zeichnen rufen.
   * @param erlaubt  das letzte Bild hat sein Budget gehalten
   * @param luft     das letzte Bild hatte deutlich Luft: dann doppelt so viele
   * @returns        wie viele freigegeben wurden
   */
  bild(erlaubt, jetztMs, luft = false) {
    if (this.warte.length === 0) return 0;
    const hunger = jetztMs - this.letzte >= this.hungerMs;
    if (!erlaubt && !hunger) return 0;
    const grenze = luft && erlaubt ? this.proBild * 2 : this.proBild;
    let n = 0;
    while (n < grenze && this.warte.length) {
      this.warte.shift().visible = true;
      n++;
    }
    this.freigegeben += n;
    this.letzte = jetztMs;
    return n;
  }

  /** Alles sofort zeigen (Sitzung zu Ende, Modellwechsel). */
  alleFreigeben() {
    for (const s of this.warte) s.visible = true;
    this.freigegeben += this.warte.length;
    this.warte.length = 0;
  }
}

// ─────────────────────────────────────────────────────────────────
// TAKT DER WARTESCHLANGEN
// ─────────────────────────────────────────────────────────────────

/**
 * Den Takt der Bibliotheks-Warteschlangen auf die XR-Sitzung legen (oder bei
 * `null` zurück auf das Fenster).
 *
 * `Scheduler.setXRSession` räumt erst die anstehenden Rückrufe ab und weist die
 * Sitzung dann zu. Läuft bei dem Abräumen einer davon und fragt über die
 * beendete Sitzung ein neues Bild an, wirft das — und die Zuweisung bleibt aus,
 * der Scheduler zeigt dann für immer auf eine tote Sitzung. Deshalb wird nach
 * einem Fehler die Zuweisung erzwungen.
 *
 * @returns true, wenn der Scheduler danach auf `sitzung` zeigt
 */
export function xrTakt(Scheduler, sitzung) {
  try {
    Scheduler.setXRSession(sitzung);
  } catch (e) {
    console.warn('VR: Scheduler.setXRSession', e);
  }
  if (Scheduler.session !== sitzung) {
    Scheduler.session = sitzung;
    if (sitzung === null) Scheduler.pending.clear();
  }
  return Scheduler.session === sitzung;
}

// ─────────────────────────────────────────────────────────────────
// TEXTUREN TEILEN
// ─────────────────────────────────────────────────────────────────
//
// Der Tiler legt jeder Kachel ihre eigenen Texturen bei: je Material drei
// 512²-JPEG (Farbe, Normale, Rauheit), und dieselben Materialien kommen in fast
// jeder Kachel vor. Am Campus-IFC sind 71 % der eingebetteten Bilder Duplikate;
// dekodiert hält jede Kachel gut 20 MB, und der Speicher der Kacheln (600 MB)
// ist nach 40 von 124 benötigten Kacheln voll — der Rest wird dauerhaft
// verweigert, das Modell bleibt lückenhaft. Gleiche Bilder werden deshalb nur
// einmal dekodiert und hochgeladen und zwischen den Kacheln geteilt.

/**
 * Schlüssel für den Inhalt eines Bildes (2 × 32 Bit über alle Bytes + Länge).
 * Kein Kryptohash: gebraucht wird „gleiche Bytes → gleicher Schlüssel“ und eine
 * Kollision, die bei einigen hundert Bildern nicht vorkommt.
 */
export function bildSchluessel(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = u8.length;
  let h1 = 0x811c9dc5 | 0;
  let h2 = (0x9e3779b1 ^ n) | 0;
  // Immer dieselbe Rechnung, gleich wie der Puffer im Speicher liegt: vier Bytes
  // zu einem Wort (little endian) von Hand, kein Uint32Array — das verlangt einen
  // ausgerichteten Anfang, und derselbe Inhalt müsste sonst je nach Lage
  // verschiedene Schlüssel bekommen.
  let i = 0;
  for (const ende = n - 3; i < ende; i += 4) {
    const x = (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) | 0;
    h1 = Math.imul(h1 ^ x, 16777619);
    h2 = Math.imul(h2 + x, 0x85ebca6b) ^ (h2 >>> 15);
  }
  for (; i < n; i++) {
    h1 = Math.imul(h1 ^ u8[i], 16777619);
    h2 = Math.imul(h2 + u8[i], 0x85ebca6b) ^ (h2 >>> 15);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}-${n.toString(36)}`;
}

/** Größe, bei der die lange Kante höchstens `kante` misst; das Seitenverhältnis bleibt. */
export function passeGroesse(breite, hoehe, kante) {
  const lang = Math.max(breite, hoehe);
  if (!(lang > kante) || !(kante > 0)) return [breite, hoehe];
  const f = kante / lang;
  return [Math.max(1, Math.round(breite * f)), Math.max(1, Math.round(hoehe * f))];
}

/** Bytes einer Textur im Speicher (RGBA, mit Mip-Kette) — dieselbe Schätzung wie in der Bibliothek. */
export function texturBytes(breite, hoehe, mips = true) {
  return Math.round(breite * hoehe * 4 * (mips ? 4 / 3 : 1));
}

/**
 * Wo schon dekodierte Bilder liegen, nach Inhalt. Die fertigen Einträge werden
 * nur schwach gehalten: solange eine Kachel das Bild braucht, lebt es, danach
 * darf es der Speicherbereiniger nehmen — kein fester Vorrat, der auf der Quest
 * Platz belegt, und bei Bildern ohne Duplikate (Fotos eines Netzes) bleibt nichts
 * zurück. Läuft das Dekodieren noch, wartet der nächste Aufrufer auf dasselbe
 * Versprechen und dekodiert nicht ein zweites Mal.
 */
export class TexturRegister {
  constructor(SchwachRef = (typeof WeakRef !== 'undefined' ? WeakRef : null)) {
    this.SchwachRef = SchwachRef;
    this.fertig = new Map();
    this.laeuft = new Map();
    this.treffer = 0;
    this.neu = 0;
  }

  /** Das Versprechen für `schluessel`, oder null, wenn es das Bild noch nicht gibt. */
  holen(schluessel) {
    const l = this.laeuft.get(schluessel);
    if (l) { this.treffer++; return l; }
    const w = this.fertig.get(schluessel);
    if (w) {
      const quelle = this.SchwachRef ? w.deref() : w;
      if (quelle) { this.treffer++; return Promise.resolve(quelle); }
      this.fertig.delete(schluessel);
    }
    return null;
  }

  eintragen(schluessel, versprechen) {
    this.neu++;
    this.laeuft.set(schluessel, versprechen);
    versprechen.then(
      quelle => {
        this.laeuft.delete(schluessel);
        this.fertig.set(schluessel, this.SchwachRef ? new this.SchwachRef(quelle) : quelle);
      },
      () => this.laeuft.delete(schluessel),
    );
    return versprechen;
  }

  /** Einträge, deren Bild noch lebt (für die Anzeige). */
  lebende() {
    let n = this.laeuft.size;
    for (const [k, w] of this.fertig) {
      if (!this.SchwachRef || w.deref()) n++; else this.fertig.delete(k);
    }
    return n;
  }
}

// ─────────────────────────────────────────────────────────────────
// KACHELSTAND
// ─────────────────────────────────────────────────────────────────

const MB = 2 ** 20;

/** Die Zahlen eines Kachelbaums, flach und ohne Verweise (zum Anzeigen und Protokollieren). */
export function kachelStand(t) {
  const s = t.stats || {};
  const c = t.lruCache;
  const dl = t.downloadQueue;
  let dlWartet = 0, dlLaeuft = 0;
  if (dl && dl.originQueues) {
    for (const q of dl.originQueues.values()) { dlWartet += q.items.length; dlLaeuft += q.currJobs; }
  }
  const pq = t.parseQueue;
  return {
    benutzt: s.used | 0,
    sichtbar: s.visible | 0,
    aktiv: s.active | 0,
    imSpeicher: s.inCache | 0,
    wartet: s.queued | 0,
    ladend: s.downloading | 0,
    entpackend: s.parsing | 0,
    geladen: s.loaded | 0,
    fehlgeschlagen: s.failed | 0,
    verweigert: s.refused | 0,
    mb: c ? c.cachedBytes / MB : 0,
    mbMax: c ? c.maxBytesSize / MB : 0,
    eintraege: c ? c.itemSet.size : 0,
    eintraegeMax: c ? c.maxSize : 0,
    dlWartet, dlLaeuft,
    parseWartet: pq ? pq.items.length : 0,
    parseLaeuft: pq ? pq.currJobs : 0,
    fortschritt: Number.isFinite(t.loadProgress) ? t.loadProgress : 1,
    ladeterGerade: !!t.isLoading,
    fehlerZiel: t.errorTarget,
  };
}

/**
 * Was dem Modell noch fehlt: Kacheln, die der letzte Durchlauf haben wollte und
 * die noch nicht da sind. Null, solange nichts mehr läuft, ist „vollständig".
 * `verweigert` zählt mit: das ist, was der Speicher nicht mehr aufnahm — der
 * Fall, in dem Warten nichts hilft.
 */
export function fehlend(stand) {
  return stand.wartet + stand.ladend + stand.entpackend + stand.verweigert;
}
