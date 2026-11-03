/**
 * Textur-Zuordnungsassistent für IFC-Modelle.
 *
 * IFC-Dateien bringen keine Bildtexturen mit, nur benannte Oberflächenstile
 * ("Stahlbeton - Ortbeton C30/37"). Das Backend ordnet diese Namen beim Tiling
 * automatisch einer PBR-Kategorie zu — dieser Dialog zeigt das Ergebnis und
 * macht es korrigierbar.
 *
 * Der Dialog ist eine Werkbank aus zwei Spalten: links die Materialien des
 * Modells, rechts die Texturbibliothek als Kachelwand. Zugeordnet wird auf
 * zwei Wegen, die dasselbe tun — Textur auf ein Material ziehen, oder
 * Materialien auswählen und eine Textur anklicken. Der Ziehweg ist der
 * schnellere für den Einzelfall, der Auswahlweg der einzige, mit dem sich
 * mehrere Materialien (oder alle) in einem Zug texturieren lassen.
 *
 * Bewusst nachgelagert statt als Pflichtschritt beim Upload: das Modell ist
 * sofort nach dem Tiling sichtbar, und wer die automatische Zuordnung gut
 * findet, muss den Dialog nie öffnen. Erst „Speichern & neu tilen" wendet
 * Änderungen an, weil die Texturen in den B3DM-Tiles stecken.
 *
 * Wird von index.html über `MaterialAssistant.open(asset)` aufgerufen.
 */
'use strict';

const MaterialAssistant = (() => {

  // Zwei Werte, die keine Kategorie sind, aber wie eine zugewiesen werden
  // können — auch per Ziehen, damit „doch keine Textur" denselben Weg geht
  // wie jede andere Zuordnung.
  const AUTO = '__auto__';   // Erkennung entscheiden lassen (kein Override)
  const KEINE = '__keine__'; // ausdrücklich einfarbig
  const FARBE = 'farbe:';    // matte Volltonfarbe statt einer Textur

  let categories = [];        // aus GET /materials/library
  let asset = null;           // aktuell bearbeitetes Asset
  let styles = [];            // Stile des Modells
  let draft = new Map();      // Stilname → Kategorie ('' = keine Textur)
  let auswahl = new Set();    // ausgewählte Stilnamen
  let anker = null;           // Index für die Bereichsauswahl mit Umschalt
  let suche = '';             // Filtertext der Bibliothek
  let farbwahl = '#c8a05a';   // Stand des Farbwählers in der Bibliothek
  let ziehwert = null;        // Wert der gerade gezogenen Kachel
  let dialog = null;
  let pollTimer = null;

  // ── Daten ────────────────────────────────────────────────────────────────

  async function loadCategories() {
    if (categories.length) return categories;
    const res = await fetch('/materials/library');
    if (!res.ok) throw new Error('Materialbibliothek nicht abrufbar');
    categories = (await res.json()).filter(c => c.installed);
    return categories;
  }

  async function loadStyles(jobId) {
    const res = await fetch(`/assets/${jobId}/materials`);
    if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
    return res.json();
  }

  // ── Dialog ───────────────────────────────────────────────────────────────

  async function open(a) {
    asset = a;
    auswahl = new Set();
    anker = null;
    suche = '';
    try {
      const [, data] = await Promise.all([loadCategories(), loadStyles(a.job_id)]);
      styles = data.styles;
      draft = new Map(Object.entries(data.overrides || {}));

      if (!data.available) {
        render(emptyState());
        return;
      }
      render(body());
    } catch (e) {
      render(`<p class="ma-error">Konnte nicht geladen werden: ${escapeHtml(e.message)}</p>`);
    }
  }

  function close() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (dialog) { dialog.remove(); dialog = null; }
  }

  function render(inner) {
    close();
    dialog = document.createElement('div');
    dialog.className = 'ma-backdrop';
    dialog.innerHTML = `
      <div class="ma-dialog" role="dialog" aria-modal="true" aria-label="Texturen zuordnen">
        <header class="ma-header">
          <div>
            <strong>Texturen zuordnen</strong>
            <span class="ma-subtitle">${escapeHtml(asset?.name ?? '')}</span>
          </div>
          <button class="ma-icon" data-action="close" title="Schließen">✕</button>
        </header>
        ${inner}
      </div>`;

    dialog.addEventListener('click', onClick);
    dialog.addEventListener('input', onInput);
    dialog.addEventListener('keydown', onKeyDown);
    dialog.addEventListener('dragstart', onDragStart);
    dialog.addEventListener('dragend', onDragEnd);
    dialog.addEventListener('dragover', onDragOver);
    dialog.addEventListener('dragleave', onDragLeave);
    dialog.addEventListener('drop', onDrop);
    // Klick auf den abgedunkelten Hintergrund schließt, Klick im Dialog nicht.
    dialog.addEventListener('mousedown', (e) => {
      if (e.target === dialog) close();
    });
    document.body.appendChild(dialog);
  }

  function emptyState() {
    return `
      <div class="ma-body">
        <p class="ma-hint">
          Für dieses Modell liegt keine Stilliste vor. Das ist der Fall bei
          Punktwolken, Meshes und Splats — und bei IFC-Modellen, die vor
          Einführung des Assistenten getilt wurden.
        </p>
        <p class="ma-hint">
          Ein Neu-Tiling erzeugt die Liste. Die Verortung bleibt dabei erhalten.
        </p>
      </div>
      <footer class="ma-footer">
        <button data-action="close">Schließen</button>
        <button class="primary" data-action="retile">Jetzt neu tilen</button>
      </footer>`;
  }

  function body() {
    return `
      ${summary()}

      <div class="ma-columns">
        <section class="ma-col ma-col-styles" aria-label="Materialien des Modells">
          <div class="ma-col-head ma-dropall" data-drop="alle"
               title="Textur hierher ziehen: gilt für alle Materialien">
            <span>Materialien im Modell</span>
            <button class="ma-link" data-action="select-all">Alle auswählen</button>
          </div>
          <div class="ma-body" role="listbox" aria-multiselectable="true">
            ${styles.map((s, i) => styleRow(s, i)).join('')}
          </div>
        </section>

        <section class="ma-col ma-col-library" aria-label="Texturbibliothek">
          <div class="ma-col-head">
            <span>Texturbibliothek</span>
            <input class="ma-search" type="search" placeholder="Textur suchen…"
                   value="${escapeHtml(suche)}" aria-label="Textur suchen">
          </div>
          <div class="ma-target">${targetText()}</div>
          <div class="ma-gallery">${galleryInner()}</div>
        </section>
      </div>

      <footer class="ma-footer">
        <p class="ma-hint">
          Textur auf ein Material ziehen — oder Materialien auswählen und eine
          Textur anklicken. Texturen stecken in den Tiles, Änderungen wirken
          erst nach dem Neu-Tiling. Die Verortung bleibt erhalten.
        </p>
        <div class="ma-actions">
          <button data-action="close">Abbrechen</button>
          <button data-action="save">Nur speichern</button>
          <button class="primary" data-action="save-retile">Speichern &amp; neu tilen</button>
        </div>
      </footer>`;
  }

  function summary() {
    const assigned = styles.filter(s => effective(s)).length;
    const vollton = styles.filter(s => zuordnung(s).art === 'farbe').length;
    return `
      <div class="ma-summary">
        <span><strong>${styles.length}</strong> Oberflächenstile</span>
        <span><strong>${assigned}</strong> mit Textur</span>
        <span><strong>${vollton}</strong> Vollton</span>
        <span><strong>${styles.length - assigned - vollton}</strong> einfarbig</span>
        <button class="ma-link" data-action="accept-all">Alle Vorschläge übernehmen</button>
        <button class="ma-link" data-action="clear-all">Alle zurücksetzen</button>
      </div>`;
  }

  // ── Materialliste ────────────────────────────────────────────────────────

  function styleRow(style, index) {
    const isOverride = draft.has(style.name);
    const badge = isOverride
      ? '<span class="ma-badge manual">manuell</span>'
      : confidenceBadge(style);

    return `
      <div class="ma-row${auswahl.has(style.name) ? ' selected' : ''}"
           data-index="${index}" role="option" tabindex="0"
           aria-selected="${auswahl.has(style.name)}">
        <span class="ma-stilfarbe" style="background:${style.farbe ?? '#3a4048'}"
              title="Farbe im Modell: ${escapeHtml(style.farbe ?? 'unbekannt')}"></span>
        <div class="ma-preview">${previewTile(zuordnung(style))}</div>
        <div class="ma-info">
          <div class="ma-name" title="${escapeHtml(style.name)}">${escapeHtml(style.name)}</div>
          <div class="ma-meta">
            ${style.occurrences > 1 ? `${style.occurrences}× &middot; ` : ''}${badge}
          </div>
        </div>
        <div class="ma-assign">${assignChip(style)}</div>
      </div>`;
  }

  /** Rechte Spalte einer Zeile: zugeordnete Kategorie und der Weg zurück. */
  function assignChip(style) {
    const z = zuordnung(style);
    const isOverride = draft.has(style.name);
    const text = z.art === 'textur' ? labelOf(z.kategorie)
      : z.art === 'farbe' ? `Vollton ${z.farbe}`
      : 'einfarbig';
    return `
      <span class="ma-chip${z.art === 'keine' ? ' plain' : ''}" title="${escapeHtml(text)}">${escapeHtml(text)}</span>
      ${isOverride
        ? '<button class="ma-icon" data-action="row-auto" title="Wieder automatisch erkennen">↺</button>'
        : ''}`;
  }

  function previewTile(z) {
    if (z.art === 'farbe') {
      return `<div class="ma-tile vollton" style="background:${escapeHtml(z.farbe)}"
                   title="Matte Volltonfarbe ${escapeHtml(z.farbe)}"></div>`;
    }
    if (z.art !== 'textur') {
      return '<div class="ma-tile empty" title="Einfarbig, keine Textur"></div>';
    }
    return `<img class="ma-tile" src="/materials/library/${z.kategorie}/preview"
                 alt="${escapeHtml(labelOf(z.kategorie))}" title="${escapeHtml(labelOf(z.kategorie))}"
                 loading="lazy">`;
  }

  function confidenceBadge(style) {
    if (!style.suggested) return '<span class="ma-badge none">nicht erkannt</span>';
    if (style.confidence >= 0.9) return '<span class="ma-badge high">sicher erkannt</span>';
    if (style.confidence >= 0.75) return '<span class="ma-badge mid">wahrscheinlich</span>';
    return '<span class="ma-badge low">unsicher — bitte prüfen</span>';
  }

  /**
   * Was für diesen Stil gilt — Entwurf schlägt Vorschlag. `textur` mit
   * Kategorie, `farbe` mit Hexwert, sonst `keine`.
   */
  function zuordnung(style) {
    if (draft.has(style.name)) {
      const wert = draft.get(style.name);
      if (!wert) return { art: 'keine', manuell: true };
      if (wert.startsWith(FARBE)) {
        return { art: 'farbe', farbe: wert.slice(FARBE.length), manuell: true };
      }
      return { art: 'textur', kategorie: wert, manuell: true };
    }
    return style.suggested
      ? { art: 'textur', kategorie: style.suggested }
      : { art: 'keine' };
  }

  /** Aktuell gültige Texturkategorie, oder null (auch bei Volltonfarbe). */
  function effective(style) {
    const z = zuordnung(style);
    return z.art === 'textur' ? z.kategorie : null;
  }

  function labelOf(key) {
    return categories.find(c => c.key === key)?.label ?? key;
  }

  function groupCategories() {
    const map = new Map();
    for (const c of categories) {
      if (!map.has(c.group)) map.set(c.group, []);
      map.get(c.group).push(c);
    }
    return [...map];
  }

  // ── Texturbibliothek ─────────────────────────────────────────────────────

  function galleryInner() {
    const term = suche.trim().toLowerCase();
    const passt = (c) =>
      !term || c.label.toLowerCase().includes(term) || c.group.toLowerCase().includes(term)
      || c.key.toLowerCase().includes(term);

    // Die beiden Sonderkacheln bleiben immer erreichbar: sie sind die einzige
    // Möglichkeit, eine Zuordnung zurückzunehmen, ohne die Zeile zu suchen.
    const special = `
      <div class="ma-group">
        <h4 class="ma-group-title">Ohne Textur</h4>
        <div class="ma-grid">
          ${swatch(AUTO, 'Automatisch', 'auto')}
          ${swatch(KEINE, 'Keine Textur', 'none')}
          <div class="ma-farbgruppe">
            <button type="button" class="ma-swatch" draggable="true" data-value="${FARBE}"
                    title="Matte Volltonfarbe ${escapeHtml(farbwahl)}">
              <span class="ma-swatch-tile vollton" style="background:${escapeHtml(farbwahl)}"></span>
              <span class="ma-swatch-label">Vollton</span>
            </button>
            <input type="color" class="ma-farbwahl" value="${escapeHtml(farbwahl)}"
                   title="Farbe wählen" aria-label="Volltonfarbe wählen">
          </div>
        </div>
      </div>`;

    const gruppen = groupCategories()
      .map(([group, items]) => [group, items.filter(passt)])
      .filter(([, items]) => items.length)
      .map(([group, items]) => `
        <div class="ma-group">
          <h4 class="ma-group-title">${escapeHtml(group)} <span>${items.length}</span></h4>
          <div class="ma-grid">
            ${items.map(c => swatch(c.key, c.label)).join('')}
          </div>
        </div>`).join('');

    if (!gruppen) {
      return special + `<p class="ma-hint ma-empty">Keine Textur passt zu „${escapeHtml(suche)}".</p>`;
    }
    return special + gruppen;
  }

  /**
   * Eine Kachel der Bibliothek. Sie ist zugleich Ziehquelle und Schaltfläche —
   * derselbe Wert, zwei Bedienwege.
   */
  function swatch(value, label, variant) {
    const bild = variant
      ? `<span class="ma-swatch-tile ${variant}" aria-hidden="true">${variant === 'auto' ? '⌁' : ''}</span>`
      : `<img class="ma-swatch-tile" src="/materials/library/${value}/preview"
              alt="" loading="lazy" draggable="false">`;
    return `
      <button type="button" class="ma-swatch" draggable="true"
              data-value="${escapeHtml(value)}" title="${escapeHtml(label)}">
        ${bild}
        <span class="ma-swatch-label">${escapeHtml(label)}</span>
      </button>`;
  }

  /** Zeile über der Bibliothek: worauf ein Klick auf eine Kachel wirkt. */
  function targetText() {
    if (!auswahl.size) {
      return '<span class="ma-target-hint">Kein Material ausgewählt — Textur auf ein Material ziehen oder links auswählen</span>';
    }
    if (auswahl.size === styles.length) {
      return `<span class="ma-target-on">Zuweisen an <strong>alle ${styles.length}</strong> Materialien</span>
              <button class="ma-link" data-action="select-none">Auswahl aufheben</button>`;
    }
    const name = auswahl.size === 1 ? [...auswahl][0] : `${auswahl.size} Materialien`;
    return `<span class="ma-target-on">Zuweisen an <strong>${escapeHtml(name)}</strong></span>
            <button class="ma-link" data-action="select-none">Auswahl aufheben</button>`;
  }

  // ── Zuordnen ─────────────────────────────────────────────────────────────

  /**
   * Schreibt einen Wert in den Entwurf. `AUTO` löscht den Eintrag (die
   * Erkennung entscheidet wieder), `KEINE` schreibt den leeren String — das
   * ist im Backend die ausdrückliche Ansage „einfarbig lassen".
   */
  function zuweisen(namen, wert) {
    for (const name of namen) {
      if (wert === AUTO) draft.delete(name);
      else draft.set(name, wert === KEINE ? '' : wert);
    }
    for (const name of namen) refreshRow(name);
    refreshSummary();
  }

  /** Materialien, auf die eine Zuweisung wirkt, wenn sie an `name` andockt. */
  function zielMenge(name) {
    // Wer eine Auswahl getroffen hat und in sie hinein zieht, meint die ganze
    // Auswahl. Ein Zug auf eine Zeile außerhalb meint genau diese Zeile.
    if (name && auswahl.has(name)) return [...auswahl];
    if (name) return [name];
    return [...auswahl];
  }

  function refreshRow(name) {
    const index = styles.findIndex(s => s.name === name);
    const style = styles[index];
    const row = dialog?.querySelector(`.ma-row[data-index="${index}"]`);
    if (!row || !style) return;

    row.querySelector('.ma-preview').innerHTML = previewTile(zuordnung(style));
    const badge = draft.has(style.name)
      ? '<span class="ma-badge manual">manuell</span>'
      : confidenceBadge(style);
    row.querySelector('.ma-meta').innerHTML =
      (style.occurrences > 1 ? `${style.occurrences}× &middot; ` : '') + badge;
    row.querySelector('.ma-assign').innerHTML = assignChip(style);
    row.classList.toggle('selected', auswahl.has(style.name));
    row.setAttribute('aria-selected', auswahl.has(style.name));
  }

  function refreshSummary() {
    const summaryEl = dialog?.querySelector('.ma-summary');
    if (!summaryEl) return;
    const assigned = styles.filter(s => effective(s)).length;
    const vollton = styles.filter(s => zuordnung(s).art === 'farbe').length;
    const counters = summaryEl.querySelectorAll('span strong');
    if (counters.length === 4) {
      counters[1].textContent = assigned;
      counters[2].textContent = vollton;
      counters[3].textContent = styles.length - assigned - vollton;
    }
  }

  function refreshTarget() {
    const el = dialog?.querySelector('.ma-target');
    if (el) el.innerHTML = targetText();
  }

  function refreshGallery() {
    const el = dialog?.querySelector('.ma-gallery');
    if (el) el.innerHTML = galleryInner();
  }

  // ── Auswahl ──────────────────────────────────────────────────────────────

  function auswaehlen(index, { toggle = false, bereich = false } = {}) {
    const style = styles[index];
    if (!style) return;

    if (bereich && anker !== null) {
      const [von, bis] = anker <= index ? [anker, index] : [index, anker];
      for (let i = von; i <= bis; i++) auswahl.add(styles[i].name);
    } else if (toggle) {
      if (auswahl.has(style.name)) auswahl.delete(style.name);
      else auswahl.add(style.name);
      anker = index;
    } else {
      const nurDiese = auswahl.size === 1 && auswahl.has(style.name);
      auswahl.clear();
      if (!nurDiese) auswahl.add(style.name);
      anker = index;
    }
    refreshAuswahl();
  }

  function refreshAuswahl() {
    dialog?.querySelectorAll('.ma-row').forEach((row) => {
      const style = styles[Number(row.dataset.index)];
      const an = !!style && auswahl.has(style.name);
      row.classList.toggle('selected', an);
      row.setAttribute('aria-selected', an);
    });
    refreshTarget();
  }

  // ── Ziehen und Ablegen ───────────────────────────────────────────────────

  /** Der Wert einer Kachel; die Volltonkachel holt ihn aus dem Farbwähler. */
  function wertVon(swatchEl) {
    const wert = swatchEl.dataset.value;
    return wert === FARBE ? FARBE + farbwahl : wert;
  }

  function onDragStart(e) {
    const swatchEl = e.target.closest('.ma-swatch');
    if (!swatchEl) return;
    ziehwert = wertVon(swatchEl);
    swatchEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'copy';
    // Ohne gesetzte Nutzlast bricht Firefox das Ziehen sofort ab.
    e.dataTransfer.setData('text/plain', ziehwert);
  }

  function onDragEnd() {
    ziehwert = null;
    dialog?.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    dialog?.querySelectorAll('.dropping').forEach(el => el.classList.remove('dropping'));
  }

  function onDragOver(e) {
    if (ziehwert === null) return;
    const ziel = e.target.closest('.ma-row, .ma-dropall');
    if (!ziel) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!ziel.classList.contains('dropping')) {
      dialog?.querySelectorAll('.dropping').forEach(el => el.classList.remove('dropping'));
      ziel.classList.add('dropping');
    }
  }

  function onDragLeave(e) {
    const ziel = e.target.closest('.ma-row, .ma-dropall');
    // relatedTarget liegt beim Wechsel zwischen Kindknoten noch im Ziel — dann
    // ist das kein Verlassen, sondern eine Bewegung innerhalb der Zeile.
    if (ziel && !ziel.contains(e.relatedTarget)) ziel.classList.remove('dropping');
  }

  function onDrop(e) {
    const wert = ziehwert ?? e.dataTransfer.getData('text/plain');
    if (!wert) return;
    const ziel = e.target.closest('.ma-row, .ma-dropall');
    if (!ziel) return;
    e.preventDefault();
    ziel.classList.remove('dropping');

    if (ziel.classList.contains('ma-dropall')) {
      zuweisen(styles.map(s => s.name), wert);
    } else {
      const style = styles[Number(ziel.dataset.index)];
      if (style) zuweisen(zielMenge(style.name), wert);
    }
    ziehwert = null;
  }

  // ── Interaktion ──────────────────────────────────────────────────────────

  function onInput(e) {
    if (e.target.classList.contains('ma-farbwahl')) {
      farbwahl = e.target.value;
      const kachel = dialog.querySelector('.ma-farbgruppe .ma-swatch-tile');
      if (kachel) kachel.style.background = farbwahl;
      return;
    }
    if (!e.target.classList.contains('ma-search')) return;
    suche = e.target.value;
    refreshGallery();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') return close();
    const row = e.target.closest?.('.ma-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      auswaehlen(Number(row.dataset.index), { toggle: e.ctrlKey || e.metaKey, bereich: e.shiftKey });
    }
  }

  async function onClick(e) {
    // Eine Kachel wirkt auf die Auswahl; ohne Auswahl bleibt nur der Ziehweg,
    // darauf weist die Zielzeile hin.
    const swatchEl = e.target.closest('.ma-swatch');
    if (swatchEl) {
      e.preventDefault();
      if (!auswahl.size) {
        dialog.querySelector('.ma-target')?.classList.add('warn');
        setTimeout(() => dialog?.querySelector('.ma-target')?.classList.remove('warn'), 900);
        return;
      }
      return zuweisen([...auswahl], wertVon(swatchEl));
    }

    const action = e.target.closest('[data-action]')?.dataset.action;

    if (action === 'row-auto') {
      e.preventDefault();
      const row = e.target.closest('.ma-row');
      const style = styles[Number(row?.dataset.index)];
      if (style) zuweisen([style.name], AUTO);
      return;
    }

    if (!action) {
      const row = e.target.closest('.ma-row');
      if (row) {
        return auswaehlen(Number(row.dataset.index), {
          toggle: e.ctrlKey || e.metaKey, bereich: e.shiftKey,
        });
      }
      return;
    }
    e.preventDefault();

    if (action === 'close') return close();

    if (action === 'select-all') {
      auswahl = new Set(styles.map(s => s.name));
      return refreshAuswahl();
    }

    if (action === 'select-none') {
      auswahl.clear();
      anker = null;
      return refreshAuswahl();
    }

    if (action === 'accept-all') {
      // Vorschläge festschreiben: aus „automatisch" wird eine bewusste
      // Zuordnung, die auch dann gilt, wenn die Erkennung später anders urteilt.
      for (const s of styles) if (s.suggested) draft.set(s.name, s.suggested);
      return render(body());
    }

    if (action === 'clear-all') {
      draft.clear();
      return render(body());
    }

    if (action === 'save' || action === 'save-retile') {
      return save(action === 'save-retile');
    }

    if (action === 'retile') {
      return startRetile();
    }
  }

  async function save(retile) {
    setBusy('Zuordnung wird gespeichert…');
    try {
      const res = await fetch(`/assets/${asset.job_id}/materials`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: Object.fromEntries(draft), retile }),
      });
      if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);

      if (retile) return watchRetile();
      setBusy(`${draft.size} Zuordnung(en) gespeichert. Sie greifen beim nächsten Tiling.`, true);
    } catch (e) {
      setBusy(`Speichern fehlgeschlagen: ${e.message}`, true);
    }
  }

  async function startRetile() {
    setBusy('Neu-Tiling wird gestartet…');
    try {
      const res = await fetch(`/assets/${asset.job_id}/materials/retile`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
      watchRetile();
    } catch (e) {
      setBusy(`Start fehlgeschlagen: ${e.message}`, true);
    }
  }

  /** Fragt den Fortschritt ab, bis das Tiling fertig ist oder scheitert. */
  function watchRetile() {
    setBusy('Modell wird neu getilt — das dauert je nach Größe einige Minuten.');
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/assets/${asset.job_id}/materials/retile`);
        if (!res.ok) return;
        const job = await res.json();
        setBusy(job.message, job.status === 'done' || job.status === 'failed');

        if (job.status === 'done' || job.status === 'failed') {
          clearInterval(pollTimer);
          pollTimer = null;
          if (job.status === 'done') {
            document.dispatchEvent(
              new CustomEvent('materials:retiled', { detail: { jobId: asset.job_id } })
            );
          }
        }
      } catch { /* nächster Durchlauf versucht es erneut */ }
    }, 2000);
  }

  /**
   * Ersetzt den Dialoginhalt durch eine Fortschrittsmeldung. `done` blendet
   * den Schließen-Button ein — währenddessen soll der Dialog offen bleiben,
   * damit der Fortschritt sichtbar ist.
   */
  function setBusy(message, done = false) {
    if (!dialog) return;
    const dlg = dialog.querySelector('.ma-dialog');
    dlg.querySelector('.ma-summary')?.remove();
    dlg.querySelector('.ma-columns')?.remove();
    dlg.querySelector('.ma-body')?.remove();
    dlg.querySelector('.ma-footer')?.remove();

    const existing = dlg.querySelector('.ma-progress');
    if (existing) {
      existing.querySelector('.ma-progress-text').textContent = message;
      existing.querySelector('.ma-spinner').hidden = done;
      existing.querySelector('button').hidden = !done;
      return;
    }

    const block = document.createElement('div');
    block.className = 'ma-progress';
    block.innerHTML = `
      <div class="ma-spinner" ${done ? 'hidden' : ''}></div>
      <p class="ma-progress-text">${escapeHtml(message)}</p>
      <button data-action="close" ${done ? '' : 'hidden'}>Schließen</button>`;
    dlg.appendChild(block);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  return { open, close };
})();
