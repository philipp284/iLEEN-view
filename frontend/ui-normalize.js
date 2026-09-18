/**
 * iLEEN — Vereinheitlichung der Bedienelemente zur Laufzeit
 *
 * Die Panels erzeugen ihr Markup als HTML-Strings, und über die Jahre hat
 * jede Schaltfläche ihr Aussehen als `style`-Attribut mitbekommen — allein in
 * `ui.js` über 260 Stück. Solange diese Attribute im DOM stehen, kann kein
 * Stylesheet dagegen anschreiben: Inline schlägt jede Spezifität.
 *
 * Dieses Modul entfernt sie. Aber nur die Eigenschaften, die das *Aussehen*
 * betreffen — Hintergrund, Rahmen, Farbe, Innenabstand, Schrift. Alles, was
 * ein Element im Layout *platziert* (Breite, Außenabstand, Position, Anzeige,
 * Raster), bleibt unangetastet: dort steckt echte Absicht, die kein
 * Stylesheet ersetzt, und ein pauschales Aufräumen würde Panels zerlegen.
 *
 * Danach trägt jede Schaltfläche `.btn` und bekommt ihr Aussehen aus
 * `design-system.css`.
 *
 * Läuft einmal beim Start und danach über einen MutationObserver für alles,
 * was Panels beim Öffnen nachzeichnen. Der Beobachter ist auf die
 * Panel-Container beschränkt, nicht auf das ganze Dokument — die Cesium-Szene
 * erzeugt pro Bild DOM-Änderungen, die hier nichts zu suchen haben.
 */
'use strict';

const ILeenUINormalize = (() => {

  /** Klassen, die früher „das ist eine Schaltfläche" bedeutet haben. */
  const BUTTON_CLASSES = [
    'modern-btn', 'ifcp-btn', 'ms-tool-btn', 'ms4-type-btn', 'pc-reset-btn',
    'floating-panel-btn', 'modern-icon-btn', 'modern-toggle-btn',
  ];

  /**
   * Inline-Eigenschaften, die das Design-System übernimmt. Bewusst *keine*
   * Auflistung der erlaubten, sondern der zu entfernenden: eine unbekannte
   * Eigenschaft bleibt damit stehen, statt still verloren zu gehen.
   */
  const VISUAL_PROPERTIES = [
    'background', 'background-color', 'background-image',
    'border', 'border-color', 'border-width', 'border-style', 'border-radius',
    'color', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'font-size', 'font-weight', 'letter-spacing', 'line-height',
    'box-shadow', 'transition', 'cursor', 'text-transform',
  ];

  const SELECTOR = BUTTON_CLASSES.map((c) => `.${c}`).join(', ');

  let normalized = 0;

  function normalizeButton(el) {
    if (el.dataset.dsNormalized === '1') return;
    el.dataset.dsNormalized = '1';

    for (const property of VISUAL_PROPERTIES) {
      el.style.removeProperty(property);
    }

    // Leeres style-Attribut wegräumen, sonst bleibt style="" im Markup stehen.
    if (el.getAttribute('style') === '') el.removeAttribute('style');

    el.classList.add('btn');

    // Alte Zustandsklasse auf die neue abbilden, damit aktive Werkzeuge
    // weiterhin hervorgehoben sind.
    if (el.classList.contains('active')) el.classList.add('is-active');

    // Die Inline-Hover-Handler aus dem alten Markup setzen `style.background`
    // beim Überfahren wieder — genau das, was hier entfernt wurde. Sie werden
    // gelöscht; das Hover-Verhalten kommt jetzt aus dem Stylesheet.
    if (el.hasAttribute('onmouseover')) el.removeAttribute('onmouseover');
    if (el.hasAttribute('onmouseout')) el.removeAttribute('onmouseout');

    normalized++;
  }

  function normalizeTree(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches?.(SELECTOR)) normalizeButton(root);
    root.querySelectorAll?.(SELECTOR).forEach(normalizeButton);
  }

  /**
   * Beobachtet wird der ganze `body`, nicht einzelne Panels: Analyse-Panel,
   * Sitzungsleiste und diverse Dialoge hängen sich unabhängig voneinander in
   * den Body und entstehen zu unterschiedlichen Zeitpunkten — eine feste Liste
   * hätte immer eines davon verpasst.
   *
   * Ausgenommen ist der Cesium-Container: dort ändert das Widget sein DOM
   * (Kreditzeile, Fehlermeldungen), und darin gibt es keine Panel-Schaltflächen.
   */
  function isIgnored(node) {
    return !!node.closest?.('#cesiumContainer');
  }

  let observer = null;

  function observe() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (isIgnored(record.target)) continue;
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) normalizeTree(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function run() {
    document.body.querySelectorAll(SELECTOR).forEach((el) => {
      if (!isIgnored(el)) normalizeButton(el);
    });
  }

  function init() {
    // Die Panels entstehen erst in `BimViewerUI.init()`, das selbst verzögert
    // startet. Ein einzelner Lauf beim Laden träfe deshalb ein leeres DOM —
    // deshalb der Beobachter plus ein erster Durchlauf, sobald es ihn gibt.
    const start = () => {
      observe();  // zuerst beobachten, damit zwischen Lauf und Beobachtung nichts durchfällt
      run();
      console.log(`✅ Bedienelemente vereinheitlicht (${normalized} Schaltflächen)`);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(start, 600));
    } else {
      setTimeout(start, 600);
    }
  }

  return { init, run, normalizeTree, get count() { return normalized; } };
})();

window.ILeenUINormalize = ILeenUINormalize;
ILeenUINormalize.init();
