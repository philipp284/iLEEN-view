/**
 * iLEEN — Sensor-Panel: die Messwerte am Modell, ein Klick in der linken Leiste.
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Öffnen schaltet die Einfärbung an, Schließen schaltet sie aus. Damit entfällt
 * die Frage, ob ein Modell beim Laden seine Farbe wechseln soll: wer das Panel
 * nicht öffnet, sieht sein Modell unverändert; wer es öffnet, sieht Werte und
 * Farbe zugleich — und die Legende daneben sagt, was die Farbe bedeutet.
 *
 * Dieses Modul zeigt, es rechnet nicht
 * ====================================
 * Die Werte kommen aus `SensorStore` (#4), die Farben aus `SensorFarben` (#5).
 * Kein eigener Netzabruf, keine eigene Farbskala, kein eigener Tileset-Stil: die
 * Farbfelder rufen `SensorFarben.zonenfarbe()` und sind damit **dieselbe**
 * Farbe wie im Modell, einschließlich entsättigt und Ausreißer. Eine zweite
 * Rechnung hier liefe früher oder später auseinander.
 *
 * Drei Dinge, die an der Vorlage schiefgingen
 * ===========================================
 * Sie sind der eigentliche Inhalt dieses Moduls; das Aussehen ist der leichte
 * Teil.
 *
 * 1. **Ein eingefrorener Fühler ist kein Stillstand.** `TMP-OG2-N` friert mit
 *    Absicht ein (Störung aus #2). Hieße „ein Wert veraltet" schon „läuft der
 *    Strom?", stünde der Hinweis immer da und würde überlesen. Er erscheint
 *    deshalb erst, wenn die **Mehrheit** steht (`stromSteht`); ein einzelner
 *    Fühler wird an seinem Geschoss benannt.
 *
 * 2. **Die Farbe verschluckt einzelne Fühler.** Die Geschossfarbe ist das Mittel
 *    der *gesunden* Fühler. Liefert einer von zweien einen Ausreißer, sieht das
 *    Geschoss unauffällig aus. Das Panel nennt deshalb je Geschoss die
 *    auffälligen Fühler beim Namen (`auffaellige`) — die Farbe allein würde es
 *    nicht sagen.
 *
 * 3. **Zeitstempel aus der Zukunft sind kein „gerade eben".** Ein
 *    Zeitraffer-Generator schreibt voraus. Negatives Alter als „gerade eben" zu
 *    lesen wäre genau falsch; es heißt „in der Zukunft (+13 Tage)", sichtbar
 *    abgesetzt (`alterText`).
 *
 * Die drei Regeln sind reine Funktionen mit gestellter Uhr, damit der Prüfstein
 * sie ohne Browser nachweisen kann.
 */
'use strict';

(function () {

  const SPEICHER = 'ileen_sensor_panel_offen';

  // Nur für „vor x min": die Werte selbst kommen über das Ereignis des Stores.
  const ALTER_TAKT_MS = 30000;

  const Z = {
    offen: false,
    messgroesse: 'raumtemperatur',
    kasten: null,
    uhr: null,
  };

  // Das globale `t()` aus i18n.js, abgesichert: fehlt es, steht der Schlüssel
  // da statt eines Absturzes — der Start-Prüfstein fände ihn dann.
  const t = (schluessel, werte) =>
    (typeof window !== 'undefined' && typeof window.t === 'function')
      ? window.t(schluessel, werte) : schluessel;

  // ── Die drei Regeln — reine Funktionen ────────────────────────────────────

  /**
   * Das Alter eines Zeitstempels als Text. `jetzt` ist austauschbar, damit der
   * Prüfstein eine gestellte Uhr benutzen kann.
   */
  function alterText(zeit, jetzt) {
    if (!zeit) return { text: '—', zukunft: false };
    const ms = (jetzt === undefined ? Date.now() : jetzt) - Date.parse(zeit);
    if (!Number.isFinite(ms)) return { text: '—', zukunft: false };
    const min = Math.round(ms / 60000);
    // Mehr als eine Minute voraus: das ist kein Uhrenversatz mehr, sondern ein
    // Wert aus der Zukunft — und der verdient eine Warnung, kein „gerade eben".
    if (min < -1) {
      const h = Math.round(-min / 60);
      return h < 48
        ? { text: t('sensoren.zukunft.h', { n: h }), zukunft: true }
        : { text: t('sensoren.zukunft.tage', { n: Math.round(h / 24) }), zukunft: true };
    }
    if (min < 1) return { text: t('sensoren.alter.jetzt'), zukunft: false };
    if (min < 90) return { text: t('sensoren.alter.min', { n: min }), zukunft: false };
    if (min < 60 * 36) return { text: t('sensoren.alter.h', { n: Math.round(min / 60) }), zukunft: false };
    return { text: t('sensoren.alter.tage', { n: Math.round(min / 1440) }), zukunft: false };
  }

  /** Steht der Strom? Erst, wenn die Mehrheit veraltet ist. */
  function stromSteht(alle) {
    if (!alle || !alle.length) return false;
    return alle.filter((s) => s.status === 'veraltet').length > alle.length / 2;
  }

  /**
   * Je Zone die Fühler, die die Geschossfarbe verschluckt: Ausreißer und
   * solche ohne frischen Wert.
   */
  function auffaellige(alle, messgroesse) {
    const je = {};
    for (const s of alle || []) {
      if (s.messgroesse !== messgroesse) continue;
      if (s.status !== 'ausreisser' && s.status !== 'veraltet') continue;
      const z = je[s.zone] || (je[s.zone] = { ausreisser: [], veraltet: [] });
      z[s.status].push(s.sensor_id);
    }
    return je;
  }

  // ── Zeichnen ──────────────────────────────────────────────────────────────

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function zahl(v, stellen) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
    const sprache = (typeof window !== 'undefined' && window.ILeenI18n
      && ILeenI18n.getLanguage && ILeenI18n.getLanguage()) || 'de';
    return Number(v).toLocaleString(sprache === 'en' ? 'en-GB' : 'de-DE',
      { maximumFractionDigits: stellen === undefined ? 1 : stellen });
  }

  function markup() {
    const F = window.SensorFarben;
    const store = window.SensorStore;
    const kopf = `
      <div class="ileen-sensoren__kopf">
        <b class="ileen-sensoren__titel">${esc(t('sensoren.titel'))}</b>
        <span class="ileen-sensoren__alter" data-alter></span>
        <button type="button" class="ileen-sensoren__zu" data-zu
                title="${esc(t('sensoren.schliessen'))}" aria-label="${esc(t('sensoren.schliessen'))}">✕</button>
      </div>`;

    if (!F || !store) {
      return kopf + `<p class="ileen-sensoren__leer">${esc(t('sensoren.ohneModul'))}</p>`;
    }
    if (!backendDa()) {
      return kopf + `<p class="ileen-sensoren__leer">${esc(t('sensoren.ohneBackend'))}</p>`;
    }
    const alle = store.stand();
    if (!alle.some((s) => s.zeit)) {
      return kopf + `<p class="ileen-sensoren__leer">${esc(t('sensoren.ohneWerte'))}</p>`;
    }

    const mg = Z.messgroesse;
    const skala = F.SKALEN[mg] || F.SKALEN.raumtemperatur;
    const zonen = F.zonenwerte();
    const auff = auffaellige(alle, mg);
    const knopf = (wert) => `
      <button type="button" data-mg="${wert}"
              class="ileen-sensoren__wahl${mg === wert ? ' ileen-sensoren__wahl--an' : ''}">${esc(t('sensoren.' + wert))}</button>`;

    const geschosse = Object.keys(F.ZONE_GESCHOSS).map((zone) => {
      const w = zonen[zone];
      const alt = w && w.status === 'veraltet';
      const a = auff[zone] || { ausreisser: [], veraltet: [] };
      // Eingefrorene Fühler nur nennen, wenn das Geschoss nicht ohnehin
      // insgesamt als veraltet dasteht — sonst stünde dasselbe zweimal da.
      const hinweise =
        (a.ausreisser.length
          ? `<span class="ileen-sensoren__ausreisser" title="${esc(t('sensoren.ausreisser'))}: ${esc(a.ausreisser.join(', '))}">⚠ ${esc(a.ausreisser.join(', '))}</span>` : '')
        + (a.veraltet.length && !alt
          ? `<span class="ileen-sensoren__veraltet" title="${esc(t('sensoren.veraltet'))}: ${esc(a.veraltet.join(', '))}">◷ ${esc(a.veraltet.join(', '))}</span>` : '');
      return `
        <div class="ileen-sensoren__geschoss${alt ? ' ileen-sensoren__geschoss--alt' : ''}" data-zone="${zone}">
          <span class="ileen-sensoren__feld" style="background:${F.zonenfarbe(w, mg)}"></span>
          <span class="ileen-sensoren__name">${esc(F.ZONE_GESCHOSS[zone])}</span>
          <b>${w ? zahl(w.wert) + ' ' + esc(skala.einheit) : '—'}</b>${hinweise}
        </div>`;
    }).join('');

    // Die Legende liest ihre Zahlen aus der Skala, statt sie abzuschreiben —
    // wird die Skala geändert, stimmt die Beschriftung weiter.
    const mitte = (skala.von + skala.bis) / 2;
    const legende = `
      <div class="ileen-sensoren__verlauf"
           style="background:linear-gradient(90deg,${F.farbe(skala.von, mg)},${F.farbe(mitte, mg)},${F.farbe(skala.bis, mg)})"></div>
      <div class="ileen-sensoren__skala">
        <span>${zahl(skala.von)} ${esc(skala.einheit)}</span><span>${zahl(mitte)} ${esc(skala.einheit)}</span><span>${zahl(skala.bis)} ${esc(skala.einheit)}</span>
      </div>`;

    // Was keinem Geschoss zugeordnet ist oder gerade nicht eingefärbt wird.
    const uebrige = alle
      .filter((s) => s.messgroesse !== mg && !(F.ZONE_GESCHOSS[s.zone] && s.messgroesse === 'raumtemperatur'))
      .map((s) => `
        <div class="ileen-sensoren__sensor" title="${esc(s.bezeichnung || '')}">
          <span class="ileen-sensoren__punkt ileen-sensoren__punkt--${esc(s.status || 'ohne')}"></span>
          <span class="ileen-sensoren__kennung">${esc(s.sensor_id)}</span>
          <b>${zahl(s.wert, 2)}</b><span class="ileen-sensoren__einheit">${esc(s.einheit || '')}</span>
        </div>`).join('');

    const juengst = alle.map((s) => s.zeit).filter(Boolean).sort().pop();
    return kopf + `
      <div class="ileen-sensoren__wahlen">${knopf('raumtemperatur')}${knopf('wirkleistung')}</div>
      ${geschosse}${legende}
      <hr class="ileen-sensoren__trenner">
      ${uebrige}
      <div class="ileen-sensoren__fuss">
        ${esc(t('sensoren.stand', { zeit: juengst ? juengst.slice(11, 16) : '—' }))}
        · ${esc(t('sensoren.anzahl', { n: alle.length }))}
        ${stromSteht(alle) ? `· <span class="ileen-sensoren__steht">${esc(t('sensoren.stromSteht'))}</span>` : ''}
      </div>`;
  }

  function zeichnen() {
    if (!Z.offen || !Z.kasten) return;
    Z.kasten.innerHTML = markup();
    alterZeichnen();
    const zu = Z.kasten.querySelector('[data-zu]');
    if (zu) zu.addEventListener('click', schliessen);
    Z.kasten.querySelectorAll('[data-mg]').forEach((b) =>
      b.addEventListener('click', () => messgroesseSetzen(b.dataset.mg)));
  }

  // Panel und Modell wechseln gemeinsam — ein Umschalter, der nur eines von
  // beiden ändert, ließe Legende und Farbe auseinanderlaufen.
  function messgroesseSetzen(mg) {
    if (!mg) return;
    Z.messgroesse = mg;
    if (Z.offen && window.SensorFarben) SensorFarben.an(mg);
    zeichnen();
  }

  // Nur die Altersangabe, nicht das ganze Panel — sie ändert sich mit der Uhr,
  // die Werte nur mit dem Ereignis.
  function alterZeichnen() {
    if (!Z.kasten || !window.SensorStore) return;
    const feld = Z.kasten.querySelector('[data-alter]');
    if (!feld) return;
    const juengst = SensorStore.stand().map((s) => s.zeit).filter(Boolean).sort().pop();
    const a = alterText(juengst);
    feld.textContent = a.text;
    feld.classList.toggle('ileen-sensoren__alter--zukunft', a.zukunft);
    feld.title = a.zukunft ? t('sensoren.zukunft.hinweis') : '';
  }

  // ── Öffnen und Schließen ──────────────────────────────────────────────────

  function backendDa() {
    if (window.BimViewer && typeof BimViewer.getBackendUrl === 'function') {
      return !!BimViewer.getBackendUrl();
    }
    return !!(window.ILEEN_CONFIG && window.ILEEN_CONFIG.backendUrl);
  }

  function merken() {
    // Im privaten Fenster wirft der Zugriff — das Panel funktioniert dann eben
    // ohne Gedächtnis.
    try { localStorage.setItem(SPEICHER, Z.offen ? '1' : '0'); } catch (e) { /* egal */ }
  }

  function oeffnen() {
    if (Z.offen) return;
    Z.offen = true;
    Z.kasten = document.createElement('div');
    Z.kasten.id = 'ileen-sensor-panel';
    Z.kasten.className = 'ileen-sensoren';
    document.body.appendChild(Z.kasten);
    if (window.SensorStore && !SensorStore.laeuft && backendDa()) SensorStore.starten();
    if (window.SensorFarben) SensorFarben.an(Z.messgroesse);
    zeichnen();
    Z.uhr = setInterval(alterZeichnen, ALTER_TAKT_MS);
    merken();
    zustandMelden();
  }

  function schliessen() {
    if (!Z.offen) return;
    Z.offen = false;
    if (Z.uhr !== null) { clearInterval(Z.uhr); Z.uhr = null; }
    if (window.SensorFarben) SensorFarben.aus();
    if (Z.kasten) { Z.kasten.remove(); Z.kasten = null; }
    merken();
    zustandMelden();
  }

  function umschalten() {
    return Z.offen ? schliessen() : oeffnen();
  }

  // Der Knopf in der Leiste soll gedrückt aussehen, solange das Panel offen ist
  // — auch wenn es über das ✕ geschlossen wurde und nicht über den Knopf.
  function zustandMelden() {
    if (window.BimViewerUI && typeof BimViewerUI.aktionenAktualisieren === 'function') {
      BimViewerUI.aktionenAktualisieren();
    }
  }

  // ── Anmeldung ─────────────────────────────────────────────────────────────

  function anmelden() {
    if (!window.BimViewerUI || typeof BimViewerUI.bereichAnmelden !== 'function') return;
    BimViewerUI.bereichAnmelden({
      id: 'sensoren', symbol: '📈', ordnung: 60,
      titel: () => t('panel.sensoren'),
      hinweis: () => t('sensoren.knopf'),
      aktion: umschalten,
      an: () => Z.offen,
    });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('ileen:sensor-geaendert', zeichnen);
    // Ein offenes Panel bliebe sonst in der Sprache stehen, in der es gezeichnet
    // wurde — die Leiste baut sich beim Wechsel neu, das schwebende Panel nicht.
    document.addEventListener('ileen:language-changed', zeichnen);
    const los = () => {
      anmelden();
      let war = false;
      try { war = localStorage.getItem(SPEICHER) === '1'; } catch (e) { /* egal */ }
      if (war) oeffnen();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', los);
    else los();
  }

  const API = {
    oeffnen, schliessen, umschalten, zeichnen, messgroesseSetzen,
    alterText, stromSteht, auffaellige,
    get offen() { return Z.offen; },
    get messgroesse() { return Z.messgroesse; },
  };
  window.SensorPanel = API;

  console.log('📈 Sensor-Panel geladen — ein Klick in der linken Leiste');
})();
