'use strict';

/**
 * room-concept-panel.js — Untergruppe „Räume & Nutzung" im Bauteile-Panel
 *
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Auswertung, kein Viewer-Werkzeug — diese Datei gehört zur Vollfassung
 * (GitLab) und wird nicht nach iLEEN-view übernommen.
 *
 * Gerechnet und gezeichnet wird in `room-concept.js`; diese Datei ist nur die
 * Anmeldung. Sie stand vorher als sechszeiliges `getRoomConceptContent()` in
 * `ui.js` — sechs Zeilen, die die Oberflächendatei des Viewers an eine
 * Auswertung banden.
 */

const RoomConceptPanel = (() => {

  function markup() {
    if (typeof RoomConcept !== 'undefined') {
      return RoomConcept.getPanelHTML();
    }
    return '<div class="rk-intro">room-concept.js nicht geladen.</div>';
  }

  if (typeof BimViewerUI !== 'undefined') {
    BimViewerUI.gruppeAnmelden('ifc', {
      key: 'rooms', ordnung: 20,
      label: () => t('group.rooms'),
      inhalt: markup,
    });
  }

  // ── Taste R: Menü auf, Räume ein/aus ───────────────────────────────────
  //
  // Wie X, P, I, G, M aus tastenkuerzel.js — nur meldet sich die Raumansicht
  // selbst an; tastenkuerzel.js gibt es nur in der Vollfassung, die
  // Raumansicht seit 2026-11-01 auch in iLEEN-view. Noch nicht
  // eingelesen? Dann liest R ein, derselbe Weg wie der Knopf.
  const B = typeof BimViewer !== 'undefined' ? BimViewer : null;
  if (B && B.Tasten) {
    B.Tasten.anmelden({
      taste: 'r', titel: 'Räume', ordnung: 60,
      hinweis: 'Raumansicht im Modell, einlesen falls nötig',
      menue: () => B.Tasten.menueOeffnen('ifc', { gruppe: 'rooms' }),
      // Im Bauplaner dreht R das gewählte Bauteil.
      sperre: () => !!(window.Bauplaner && Bauplaner.zustand && Bauplaner.zustand.auswahl !== null &&
                       Bauplaner.zustand.auswahl !== undefined),
      aktion: async () => {
        const RC = typeof RoomConcept !== 'undefined' ? RoomConcept : null;
        if (!RC) return { text: 'nicht geladen' };
        if (RC.sichtbar) { RC.ausblenden(); return { an: false }; }
        if (!RC.raeume.length) await RC.einlesen();
        else RC.anzeigen();
        return { an: !!RC.sichtbar, text: RC.raeume.length ? `${RC.raeume.length} Räume` : 'keine Räume gefunden' };
      },
    });
  }

  // ── Die Raumansicht als Teil einer Szene ─────────────────────────────────
  //
  // Für Vorlagen (vorlagen.js) und Präsentationsfolien: an/aus, wonach
  // eingefärbt wird, welche Geschosse, Stempel, ob das Modell zurücktritt.
  // Nicht die Räume selbst — die liest `setzen` bei Bedarf wieder ein.
  if (B && B.Zustand) {
    B.Zustand.anmelden({
      id: 'raeume', ordnung: 48, titel: 'Raumansicht',
      beschreibung: 'Räume im Modell: an, Modell (jobId), Einfärben nach, gezeigte Geschosse, ' +
                    'Raumstempel, Modell zurückgenommen.',
      schema: {
        an: { typ: 'bool' }, jobId: { typ: 'text' }, kriterium: { typ: 'text' },
        geschosse: { typ: 'liste', beschreibung: 'leer = alle' },
        stempel: { typ: 'bool' }, nurRaeume: { typ: 'bool' },
      },
      lesen: () => {
        const RC = typeof RoomConcept !== 'undefined' ? RoomConcept : null;
        if (!RC || !RC.sichtbar) return { an: false };
        return { an: true, jobId: RC._jobId || null, kriterium: RC.kriterium,
                 geschosse: [...RC.geschossWahl], stempel: !!RC.stempel, nurRaeume: !!RC.nurRaeume };
      },
      setzen: async (w) => {
        const RC = typeof RoomConcept !== 'undefined' ? RoomConcept : null;
        if (!RC) return;
        if (!w || !w.an) { if (RC.sichtbar) RC.ausblenden(); return; }
        // Das Modell der Vorlage, wenn es geladen ist — sonst das, was da ist.
        const geladen = w.jobId && [...(B.loadedAssets?.values() || [])].some((a) => a && a.jobId === w.jobId);
        const anderes = geladen && RC._jobId && RC._jobId !== w.jobId;
        if (geladen) RC._jobId = w.jobId;
        if (!RC.raeume.length || anderes) await RC.einlesen();
        if (w.kriterium) RC.setzeKriterium(w.kriterium);
        RC.stempel = w.stempel !== false;
        RC.geschossWahl.clear();
        (w.geschosse || []).forEach((g) => RC.geschossWahl.add(g));
        RC.anzeigen();
        if (typeof w.nurRaeume === 'boolean' && w.nurRaeume !== !!RC.nurRaeume) RC.modellZuruecknehmen();
      },
    });
  }

  return { markup };

})();
