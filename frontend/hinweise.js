/**
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * iLEEN — Erklärtexte aus den Panels in die Sprechblase
 *
 * In den Panels standen rund 160 Erklärabsätze zwischen den Bedienelementen:
 * `.hint`, `.wz-hinweis`, `.plan-hint`, `.modern-hint`. Jeder kostet in einem
 * 320 px breiten Panel drei bis fünf Zeilen. Wer einen Schalter sucht, liest
 * an ihnen entlang statt sie zu lesen — und beim zehnten Öffnen desselben
 * Panels sind sie nur noch Rauschen.
 *
 * Dieses Modul nimmt sie aus dem Fluss und hängt sie an das Bedienelement,
 * zu dem sie gehören. Beim Überfahren erscheinen sie als Sprechblase.
 *
 * Der Weg ist derselbe wie in `ui-normalize.js`: ein Beobachter am Body statt
 * 160 Änderungen in vierzig Dateien. Die Panels bauen ihr Markup weiterhin so
 * auf, wie sie es immer getan haben; ob ein Erklärtext im Fluss steht oder in
 * der Blase, entscheidet allein diese Datei.
 *
 * Was ausdrücklich stehen bleibt:
 *
 *   · Texte mit `id` — das sind Statusanzeigen („3 Punkte gemessen"), keine
 *     Erklärungen. Sie werden zur Laufzeit beschrieben und gehören gesehen.
 *   · Warnungen (`.hint--warn`, `.wz-hinweis--warnung`) — eine Warnung, die
 *     man erst beim Überfahren sieht, ist keine.
 *   · Texte mit Bedienelementen darin (Knopf, Feld, Verweis) — die will man
 *     anklicken, und die Blase fängt keine Klicks.
 *   · Texte im Info-Bereich und im Handbuch — dort ist Text der Inhalt.
 *   · Texte ohne ein Element, an das sie gehören könnten — ein Reiter, der
 *     aus nichts als einem Erklärtext besteht, bliebe sonst leer.
 *
 * Entfernt wird nichts: der Absatz wird nur verborgen. Module, die ihn später
 * neu beschriften, finden ihn weiterhin, und die Blase liest ihren Text bei
 * jedem Öffnen frisch aus dem Element — nicht aus einer Kopie vom Anmeldezeit-
 * punkt, die beim ersten Sprachwechsel falsch wäre.
 */
'use strict';

const ILeenHinweise = (() => {

  /** Klassen, die in den Panels „das ist ein Erklärtext" bedeuten. */
  const HINWEIS_KLASSEN = [
    'hint', 'wz-hinweis', 'rp-hinweis', 'modern-hint', 'plan-hint',
    'plan2d-opt__hinweis', 'feb-hinweis', 'kz4d__hinweis', 'sim4dg__hinweis',
    'rk-offen-hinweis', 'props-role-hint', 'ifcp-role-hint',
  ];

  const SELECTOR = HINWEIS_KLASSEN.map((c) => `.${c}`).join(', ');

  /** Warnungen bleiben stehen — sie sollen ins Auge fallen, nicht sich verstecken. */
  const WARNUNGEN = '.hint--warn, .wz-hinweis--warnung, .is-warnung, .kz4d__hinweis.is-warnung';

  /** Was in einem Erklärtext steht und angeklickt werden will. */
  const BEDIENBAR = 'button, input, select, textarea, a[href], [onclick], details';

  /**
   * Überschriften taugen als Ziel nur mittelbar: sie sind schmal, und der
   * Erklärtext gilt ohnehin dem Abschnitt darunter. Trifft die Zuordnung eine
   * Überschrift, rückt sie auf deren Behälter.
   */
  const UEBERSCHRIFTEN = '.section__label, .subgroup__header, .panel-group__header, '
                       + '.wz-abschnitt__titel, .field__label, summary, h1, h2, h3, h4, h5, h6';

  /** Bereiche, in denen Text der Inhalt ist und nicht die Beigabe. */
  const TEXTBEREICHE = '#section-about, #ileenHilfe, .ileen-hilfe, .ileen-tip';

  /** Behälter, die als Ziel zu grob wären — dort bliebe die Blase überall offen. */
  const ZU_GROSS = '.sidebar-section, #sidebarPanel, #toolbar, #rightPanel, body, html';

  /** Ziel-Element → die Erklärtexte, die daran hängen. */
  const texte = new WeakMap();

  let verborgen = 0;

  // ── Einsammeln ───────────────────────────────────────────────────────────

  function istHinweis(el) {
    return !!el && el.nodeType === Node.ELEMENT_NODE && el.matches(SELECTOR);
  }

  function bleibtStehen(el) {
    if (el.dataset.hinweisBleibt !== undefined) return true;   // ausdrückliches Opt-out
    if (el.dataset.hinweisWeg !== undefined) return false;     // ausdrücklich in die Blase
    if (el.id) return true;                                     // Statusanzeige
    if (el.matches(WARNUNGEN)) return true;
    if (el.querySelector(BEDIENBAR)) return true;
    if (el.closest(TEXTBEREICHE)) return true;
    if (!el.textContent.trim()) return true;                    // leer — nichts zu zeigen
    return false;
  }

  /**
   * Ab dieser Länge gilt ein Text als Erklärung und nicht als Meldung.
   *
   * Die Unterscheidung wird nur dort gebraucht, wo ein Text allein in seinem
   * Behälter steht — dann nämlich ist aus der Stellung nicht abzulesen, ob er
   * etwas erklärt („Raumstempel kommen aus den IfcSpace-Elementen …") oder
   * einen Zustand meldet („Noch keine Tour geladen."). Eine Meldung gehört
   * gesehen; sie ist zudem kurz und kostet keinen Platz. Die Schwelle ist
   * bewusst hoch angesetzt: im Zweifel bleibt ein Text stehen.
   */
  const ERKLAERLAENGE = 60;

  /** Das nächste Geschwister eines Knotens, das als Ziel taugt. */
  function geschwisterZiel(knoten, rueckwaerts) {
    const vorher  = knoten.previousElementSibling;
    const nachher = knoten.nextElementSibling;
    const reihe = rueckwaerts ? [nachher, vorher] : [vorher, nachher];
    return reihe.find((k) => k && !istHinweis(k) && !k.hidden
                          && !k.classList.contains('ileen-hinweis--verborgen')) || null;
  }

  /**
   * Das Element, an dem der Erklärtext künftig hängt.
   *
   * `.modern-hint` steht seinem Inhalt voran (margin-bottom), die übrigen
   * folgen ihm (margin-top) — die Suchrichtung dreht sich entsprechend um.
   *
   * Steht der Text allein in seinem Abschnitt, sucht die Zuordnung eine Ebene
   * höher weiter: ein Erklärsatz, der einen ganzen Reiter einleitet, gehört
   * dann an dessen ersten Bedienblock. Höher als zwei Ebenen geht es nicht —
   * sonst hinge der Text irgendwann am halben Panel.
   */
  function zielFuer(el) {
    const rueckwaerts = el.classList.contains('modern-hint');
    let knoten = el;

    for (let ebene = 0; ebene <= 2 && knoten && !knoten.matches(ZU_GROSS); ebene++) {
      const gefunden = geschwisterZiel(knoten, rueckwaerts);
      if (gefunden) {
        // Ab der ersten Aufstiegsebene ist die Zuordnung nicht mehr aus der
        // Stellung ablesbar — dort zählt nur noch, ob der Text überhaupt eine
        // Erklärung ist.
        if (ebene > 0 && el.textContent.trim().length < ERKLAERLAENGE) return null;
        let ziel = gefunden;
        if (ziel.matches(UEBERSCHRIFTEN)) ziel = ziel.parentElement || ziel;
        return (ziel && !ziel.matches(ZU_GROSS)) ? ziel : null;
      }
      knoten = knoten.parentElement;
    }
    return null;
  }

  function verbergen(el) {
    if (el.dataset.ileenHinweis === '1') return;
    el.dataset.ileenHinweis = '1';

    if (bleibtStehen(el)) return;

    const ziel = zielFuer(el);
    if (!ziel) return;

    const liste = texte.get(ziel) || [];
    liste.push(el);
    texte.set(ziel, liste);

    // Das Merkmal ist der Haken für die Ereignisbehandlung; der Text selbst
    // steht bewusst nicht darin, sondern wird beim Öffnen gelesen.
    ziel.dataset.hinweis = '1';

    el.classList.add('ileen-hinweis--verborgen');
    verborgen++;
    huellePruefen(el.parentElement);
  }

  /**
   * Einen Abschnitt, der nach dem Verbergen nur noch aus seiner Überschrift
   * besteht, ebenfalls ausblenden.
   *
   * Sonst bliebe an Stellen wie dem Reiter „Schnitte" eine Überschrift ohne
   * Inhalt stehen — schlechter als der Erklärtext, den sie überschrieben hat.
   * Behälter mit `id` bleiben unangetastet: dort schreibt in aller Regel ein
   * Modul zur Laufzeit hinein, und was gleich kommt, darf nicht vorab
   * verborgen werden.
   */
  function huellePruefen(behaelter) {
    if (!behaelter || behaelter.id || behaelter.matches(ZU_GROSS)) return;
    if (behaelter.classList.contains('ileen-hinweis--verborgen')) return;

    const kinder = [...behaelter.children];
    if (!kinder.length) return;

    const uebrig = kinder.filter((k) => !k.classList.contains('ileen-hinweis--verborgen')
                                     && !k.matches(UEBERSCHRIFTEN));
    if (uebrig.length) return;

    // Eigener Text unmittelbar im Behälter (ohne Elementhülle) zählt als Inhalt.
    const eigenerText = [...behaelter.childNodes]
      .filter((k) => k.nodeType === Node.TEXT_NODE)
      .map((k) => k.textContent.trim()).join('');
    if (eigenerText) return;

    behaelter.classList.add('ileen-hinweis--verborgen');
    huellePruefen(behaelter.parentElement);
  }

  function durchgehen(wurzel) {
    if (!wurzel || wurzel.nodeType !== Node.ELEMENT_NODE) return;
    if (wurzel.closest?.('#cesiumContainer')) return;
    if (istHinweis(wurzel)) verbergen(wurzel);
    wurzel.querySelectorAll?.(SELECTOR).forEach(verbergen);
  }

  // ── Sprechblase ──────────────────────────────────────────────────────────

  const VERZOEGERUNG = 320;   // ms — kurz genug zum Nachschlagen, lang genug zum Vorbeifahren
  const ABSTAND = 10;         // px zwischen Element und Blase

  let blase = null;
  let uhr = null;
  let offenesZiel = null;
  let kandidat = null;        // Ziel, dessen Wartezeit gerade läuft

  function blaseHolen() {
    if (blase && blase.isConnected) return blase;
    blase = document.createElement('div');
    blase.className = 'ileen-tip';
    blase.setAttribute('role', 'tooltip');
    document.body.appendChild(blase);
    return blase;
  }

  /** Den aktuellen Wortlaut aller Erklärtexte eines Ziels — frisch gelesen. */
  function textVon(ziel) {
    const liste = texte.get(ziel);
    if (!liste || !liste.length) return '';
    return liste
      .filter((el) => el.isConnected && el.textContent.trim())
      .map((el) => el.innerHTML.trim())
      .join('<br><br>');
  }

  function setzen(ziel) {
    const b = blaseHolen();
    const kasten = ziel.getBoundingClientRect();
    const eigen = b.getBoundingClientRect();
    const rand = 8;

    // Panels stehen links, das Analysepanel rechts: die Blase weicht auf die
    // Seite aus, auf der mehr Platz ist — sonst läge sie über dem Panel, aus
    // dem sie kommt, und verdeckte genau das, was man gerade einstellt.
    const rechtsPlatz = window.innerWidth - kasten.right;
    const nachRechts = rechtsPlatz >= eigen.width + ABSTAND + rand
                    || rechtsPlatz >= kasten.left;

    let x = nachRechts ? kasten.right + ABSTAND : kasten.left - eigen.width - ABSTAND;
    x = Math.max(rand, Math.min(x, window.innerWidth - eigen.width - rand));

    let y = kasten.top;
    y = Math.max(rand, Math.min(y, window.innerHeight - eigen.height - rand));

    b.style.left = `${Math.round(x)}px`;
    b.style.top  = `${Math.round(y)}px`;
  }

  function zeigen(ziel) {
    const inhalt = textVon(ziel);
    if (!inhalt) return;

    const b = blaseHolen();
    b.innerHTML = inhalt;
    b.style.visibility = 'hidden';
    b.classList.add('is-offen');
    setzen(ziel);              // erst messen, dann setzen — sonst springt die Blase
    b.style.visibility = '';
    offenesZiel = ziel;
  }

  function schliessen() {
    clearTimeout(uhr);
    uhr = null;
    kandidat = null;
    offenesZiel = null;
    if (blase) blase.classList.remove('is-offen');
  }

  /**
   * Die Wartezeit läuft je Ziel genau einmal. Ohne `kandidat` würde jede
   * Mausbewegung innerhalb desselben Elements den Zähler neu starten — die
   * Blase erschiene erst, wenn der Zeiger 320 ms lang stillsteht.
   */
  function anmelden(ziel) {
    if (ziel === offenesZiel || ziel === kandidat) return;
    schliessen();
    kandidat = ziel;
    uhr = setTimeout(() => { uhr = null; zeigen(ziel); }, VERZOEGERUNG);
  }

  function verkabeln() {
    document.addEventListener('pointerover', (e) => {
      const ziel = e.target.closest?.('[data-hinweis]');
      if (ziel) anmelden(ziel);
      else if (offenesZiel || kandidat) schliessen();
    }, true);

    // Tastaturbedienung: der Erklärtext gehört zum Element, nicht zur Maus.
    document.addEventListener('focusin', (e) => {
      const ziel = e.target.closest?.('[data-hinweis]');
      if (ziel) anmelden(ziel); else schliessen();
    }, true);

    document.addEventListener('focusout', schliessen, true);
    document.addEventListener('pointerdown', schliessen, true);
    document.addEventListener('wheel', schliessen, { capture: true, passive: true });
    document.addEventListener('scroll', schliessen, { capture: true, passive: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') schliessen(); }, true);
    window.addEventListener('blur', schliessen);
  }

  // ── Start ────────────────────────────────────────────────────────────────

  let beobachter = null;

  function beobachten() {
    if (beobachter) beobachter.disconnect();
    beobachter = new MutationObserver((eintraege) => {
      for (const eintrag of eintraege) {
        for (const knoten of eintrag.addedNodes) {
          if (knoten.nodeType === Node.ELEMENT_NODE) durchgehen(knoten);
        }
      }
      // Ein Panel-Neuaufbau wirft das offene Ziel weg — die Blase hinge sonst
      // über einem Element, das es nicht mehr gibt.
      if (offenesZiel && !offenesZiel.isConnected) schliessen();
    });
    beobachter.observe(document.body, { childList: true, subtree: true });
  }

  function lauf() {
    document.body.querySelectorAll(SELECTOR).forEach((el) => {
      if (!el.closest('#cesiumContainer')) verbergen(el);
    });
  }

  function init() {
    const start = () => {
      verkabeln();
      beobachten();   // zuerst beobachten, damit zwischen Lauf und Beobachtung nichts durchfällt
      lauf();
      console.log(`✅ Erklärtexte in die Sprechblase verlegt (${verborgen})`);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(start, 600));
    } else {
      setTimeout(start, 600);
    }
  }

  return {
    init, lauf, durchgehen, schliessen,
    get anzahl() { return verborgen; },
  };
})();

window.ILeenHinweise = ILeenHinweise;
ILeenHinweise.init();
