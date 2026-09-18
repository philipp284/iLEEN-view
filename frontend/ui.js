/**
 * iLEEN — Oberfläche: Aktivitätsleiste, Panels, Modell-Liste
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Aufbau im DOM (andere Module hängen sich hier ein):
 *
 *   #toolbar
 *     #activityBar            .activity-btn[data-section=<id>]
 *     #sidebarPanel           .sidebar-section#section-<id>
 *                               .modern-header
 *                               .section-scroll-content
 *
 * `activateSection(id)` ist generisch über diese beiden Merkmale — ein
 * Werkzeug, das sich selbst einhängt (bauplaner-panel.js, konzept-panel.js,
 * flight-tracker.js), braucht keinen Eintrag in dieser Datei.
 *
 * Die Reiter im Werkzeuge-Panel laufen ebenso generisch über
 * `#section-tools .tabs [data-tab]` und `#toolsPane-<name>` (section-box.js
 * und plan-panel.js ergänzen dort ihre Reiter).
 */
'use strict';

// Die ion-Assets, die in der Vorschlagsliste erscheinen. Ein Konto sammelt
// über die Jahre Testuploads an; gezeigt wird, womit gearbeitet wird.
const VALID_ASSET_IDS = new Set([
  // 3D Tiles — ausgewählte Modelle
  4587934,  // Campus_HSMZ
  4574084,  // Campus HS 3DGS
  4563565,  // Holzstraße_36
  4709441,  // Holzstraße_H212
  4709448,  // Holzstraße_FLUR_2OG
  4563564,  // 250605_Lucy_LP5
  4557082,  // ifc_hsmainz_campus_ba2+ba1
  4005288,  // LUX_aussen
  3956925,  // LUX_innen
  3941307,  // BIMLabor (Wimla Bor)
  3904238,  // 2025-09_SC_Mainz_Rheinstrasse_Hochschule
  4690594,  // Schmidburg
  3713503,  // Marksburg_draft_2 (RS 3D JS)
  3390684,  // 3D_FBX_Oberstein_OPTIMIERT_reduced
  1415196,  // Aerometrex San Francisco High Resolution 3D Model
  69380,    // Melbourne Photogrammetry
  // Infrastruktur (immer verfügbar)
  2275207,  // Google Photorealistic 3D Tiles
  96188,    // Cesium OSM Buildings
  // Imagery
  3830186, 3830185, 3830184, 3830183, 3830182,  // Google Maps 2D
  3827, 4, 3, 2,                                  // Bing Maps
  // Terrain
  1         // Cesium World Terrain
]);

function uiEsc(text) {
  return String(text === undefined || text === null ? '' : text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const BimViewerUI = {
  currentRole: 'architect',
  _ionAssetNames: null,
  _transformAssetId: null,

  init() {
    if (this._initialisiert) return;
    this._initialisiert = true;
    try {
      this.createModernToolbar();
      this.initEventHandlers();
    } catch (error) {
      console.error('Oberfläche konnte nicht aufgebaut werden:', error);
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // AKTIVITÄTSLEISTE UND PANELS — DIE ANMELDUNG
  // ─────────────────────────────────────────────────────────────────
  //
  // Die linke Leiste ist die Viewer-Seite. Ein Bereich darin ist angemeldet,
  // nicht eingebaut — dieselbe Mechanik, die `right-panel.js` für die rechte
  // Seite verwendet.
  //
  // Vorher war `addSection()` eine lokale Funktion in `createModernToolbar()`.
  // Von außen war sie nicht erreichbar, und so haben sechs Module (pano-tour,
  // bauplaner, konzept, flight-tracker, ifc-4d …) dieselben 35 Zeilen
  // DOM-Aufbau abgeschrieben — samt dem Kunstgriff, den eigenen Knopf vor dem
  // Einklapp-Knopf einzufügen, und samt einer eigenen Warteschleife, bis die
  // Leiste im DOM steht. Sechs Kopien, die bei jeder Änderung am Panelgerüst
  // einzeln nachzuziehen waren; eine davon lauschte auf das alte Ereignis
  // `geobim:language-changed` und verschwand beim Sprachwechsel spurlos.
  //
  // Angemeldet wird so:
  //
  //     BimViewerUI.bereichAnmelden({
  //       id: 'bericht', symbol: '📄', ordnung: 240,
  //       titel: () => t('panel.bericht'),
  //       inhalt: () => Bericht.markup(),           // String oder Funktion
  //       beimOeffnen: () => Bericht.aktualisieren(),
  //     });
  //
  // Ein Bereich mit Untergruppen gibt statt `inhalt` ein `gruppen`-Feld an;
  // ein fremdes Modul hängt sich in einen bestehenden Bereich über
  //
  //     BimViewerUI.gruppeAnmelden('ifc', { key: 'pruefung', ordnung: 30,
  //                                         label: () => t('group.pruefung'),
  //                                         inhalt: () => Pruefung.markup(),
  //                                         beimOeffnen: () => Pruefung.init() });
  //
  // `titel`, `label`, `inhalt` und `angeheftet` dürfen Funktionen sein und
  // sollten es sein, wo `t()` im Spiel ist: der Sprachwechsel baut die Leiste
  // neu auf und wertet sie dabei erneut aus. Als fester String eingetragen,
  // bliebe die Beschriftung in der Sprache des Anmeldezeitpunkts stehen.
  //
  // `ordnung` bestimmt die Reihenfolge in der Leiste, nicht der Zeitpunkt der
  // Anmeldung — sonst hinge die Anordnung der Symbole an der Reihenfolge der
  // `<script>`-Zeilen in index.html. Die Viewer-Bereiche liegen auf 10…90,
  // damit angemeldete Werkzeuge sich dazwischen und dahinter setzen können.

  /** Die angemeldeten Bereiche. Reihenfolge entsteht über `ordnung`. */
  _bereiche: [],

  /** Steht die Leiste im DOM? Vor dem ersten Aufbau wird nur vorgemerkt. */
  _leisteBereit: false,

  /**
   * Meldet einen Bereich an (oder überschreibt einen gleichnamigen).
   *
   * Vor dem ersten Aufbau wird nur vorgemerkt; danach wird die Leiste neu
   * gebaut. Die Ladereihenfolge der Module ist damit gleichgültig.
   */
  bereichAnmelden(beschreibung) {
    if (!beschreibung || !beschreibung.id) {
      console.warn('[BimViewerUI] bereichAnmelden ohne id');
      return;
    }
    const vorhanden = this._bereiche.find((b) => b.id === beschreibung.id);
    if (vorhanden) {
      // Gruppen, die sich fremde Module dazugehängt haben, überleben eine
      // erneute Anmeldung des Bereichs — sonst risse ein spät geladenes
      // Modul die Untergruppen eines früheren wieder heraus.
      const fremde = vorhanden.gruppen.filter((g) => g._fremd);
      Object.assign(vorhanden, beschreibung);
      vorhanden.gruppen = (beschreibung.gruppen || []).concat(fremde);
    } else {
      this._bereiche.push(Object.assign({
        symbol: '•',
        titel: beschreibung.id,
        ordnung: 500,
        gruppen: [],
        angeheftet: null,
        inhalt: null,
        beimOeffnen: null,
      }, beschreibung));
    }
    this._leisteNeuBauen();
  },

  /**
   * Hängt eine Untergruppe in einen bestehenden Bereich.
   *
   * Der Bereich muss vorher angemeldet sein. Die Viewer-Bereiche melden sich
   * in `_viewerBereicheAnmelden()` an, gleich zu Beginn von `init()` — also
   * bevor irgendein Werkzeugmodul dazu kommt, sich einzuhängen.
   */
  gruppeAnmelden(bereichId, gruppe) {
    if (!gruppe || !gruppe.key) {
      console.warn('[BimViewerUI] gruppeAnmelden ohne key');
      return;
    }
    const bereich = this._bereiche.find((b) => b.id === bereichId);
    if (!bereich) {
      console.warn('[BimViewerUI] Bereich "' + bereichId + '" gibt es nicht — '
                 + 'Gruppe "' + gruppe.key + '" bleibt draußen');
      return;
    }
    const eintrag = Object.assign({ ordnung: 500, _fremd: true }, gruppe);
    const i = bereich.gruppen.findIndex((g) => g.key === gruppe.key);
    if (i >= 0) bereich.gruppen[i] = eintrag;
    else bereich.gruppen.push(eintrag);
    this._leisteNeuBauen();
  },

  /**
   * Neuaufbau nach einer Anmeldung — gebündelt.
   *
   * Melden sich fünf Werkzeuge nacheinander an, soll die Leiste einmal neu
   * entstehen und nicht fünfmal. Vor dem ersten Aufbau geschieht gar nichts:
   * `createModernToolbar()` liest die Anmeldungen ohnehin frisch.
   */
  _leisteNeuBauen() {
    if (!this._leisteBereit || this._neuaufbauGeplant) return;
    this._neuaufbauGeplant = true;
    Promise.resolve().then(() => {
      this._neuaufbauGeplant = false;
      if (!this._leisteBereit) return;
      const aktiv = document.querySelector('.activity-btn.active')?.dataset.section;
      this.createModernToolbar();
      this.initEventHandlers();
      if (aktiv) this.activateSection(aktiv);
    });
  },

  /** `titel`/`inhalt`/`label` dürfen Funktion oder fertiger Wert sein. */
  _wert(x) {
    try {
      return typeof x === 'function' ? x.call(this) : (x ?? '');
    } catch (e) {
      console.error('[BimViewerUI] Panelinhalt nicht erzeugbar', e);
      return '<div class="plan-hint">Dieser Abschnitt ließ sich nicht aufbauen.</div>';
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // AKTIVITÄTSLEISTE UND PANELS — DER AUFBAU
  // ─────────────────────────────────────────────────────────────────

  createModernToolbar() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) {
      console.error('#toolbar fehlt im Markup');
      return;
    }

    toolbar.innerHTML = `
      <div id="activityBar" class="activity-bar">
        <div class="activity-logo" title="iLEEN"><img src="ileen-marke.svg" alt="iLEEN"></div>
      </div>
      <div id="sidebarPanel" class="sidebar-panel">
        <div class="sidebar-resize-handle" title="Breite ziehen"></div>
      </div>
    `;
    const leiste = document.getElementById('activityBar');
    const seite = document.getElementById('sidebarPanel');

    // Ein Bereich wird zu Knopf + Panel. Untergruppen werden zu `<details>`:
    // der Zustand lebt im DOM, das Aufklappen funktioniert ohne JavaScript,
    // und der Inhalt bleibt für die Suchfunktion des Browsers erreichbar.
    //
    // Vierzehn Symbole in der Leiste hießen vierzehnmal raten, wo etwas liegt —
    // „Layer Manager", „Point Cloud Settings" und „Assets" gehören für den
    // Benutzer zu einer Frage: welche Modelle sind geladen. Die Gruppen fassen
    // das zusammen; die Untergruppen bleiben sichtbar, damit niemand suchen
    // muss, wohin ein Panel gewandert ist.
    const bereiche = this._bereiche.slice().sort((a, b) => a.ordnung - b.ordnung);

    for (const bereich of bereiche) {
      const titel = this._wert(bereich.titel);

      const knopf = document.createElement('div');
      knopf.className = 'activity-btn';
      knopf.dataset.section = bereich.id;
      knopf.title = this._wert(bereich.hinweis) || titel;
      knopf.innerHTML = `<span class="modern-section-icon">${bereich.symbol}</span>`;
      // `beimOeffnen` ruft `activateSection()` — auch bei programmatischem
      // Öffnen, nicht nur beim Klick.
      knopf.addEventListener('click', () => this.activateSection(bereich.id));
      leiste.appendChild(knopf);

      // `angeheftet` steht über den Gruppen und klappt nie zu — für das, was
      // beim Öffnen des Panels immer sichtbar sein soll.
      let rumpf = this._wert(bereich.angeheftet);

      const gruppen = (bereich.gruppen || []).slice().sort((a, b) => a.ordnung - b.ordnung);
      if (gruppen.length) {
        rumpf += gruppen
          .map((g) => ({ g, inhalt: this._wert(g.inhalt) }))
          .filter((x) => x.inhalt)
          .map(({ g, inhalt }) => `
          <details class="panel-group" id="group-${g.key}"${g.offen ? ' open' : ''}>
            <summary class="panel-group__header">
              <span>${this._wert(g.label)}</span>
            </summary>
            <div class="panel-group__body">${inhalt}</div>
          </details>`)
          .join('');
      } else {
        rumpf += this._wert(bereich.inhalt);
      }

      const panel = document.createElement('div');
      panel.className = 'sidebar-section';
      panel.id = `section-${bereich.id}`;
      panel.style.display = 'none';
      panel.innerHTML = `
        <div class="modern-header">
          <div class="modern-logo-title">${titel}</div>
        </div>
        <div class="section-scroll-content">
          ${rumpf}
        </div>
      `;
      seite.appendChild(panel);
    }

    // Unten in der Leiste: die Seitenleiste einklappen. `margin-top: auto`
    // hält den Knopf am Boden. Er entsteht nach allen Bereichen, damit sich
    // kein angemeldetes Werkzeug mehr dahinter einreihen kann — genau dafür
    // hatte jedes handgebaute Panel vorher seinen eigenen Kunstgriff.
    const unten = document.createElement('div');
    unten.className = 'activity-btn activity-btn--collapse';
    unten.style.marginTop = 'auto';
    unten.title = 'Seitenleiste einklappen (M)';
    unten.innerHTML = '<span class="modern-section-icon">⇤</span>';
    unten.addEventListener('click', () => this.toggleSidebar());
    leiste.appendChild(unten);

    this._leisteBereit = true;
    this.activateSection(bereiche.length ? bereiche[0].id : 'models');

    // Die Untergruppen eines Panels verhalten sich wie ein Akkordeon: wer eine
    // öffnet, schließt damit die übrigen desselben Panels. Sonst stehen nach
    // ein paar Klicks alle offen, das Panel wird lang und die gesuchte Gruppe
    // rutscht aus dem Bild.
    //
    // Der Listener hängt am Dokument statt an den einzelnen `<details>`:
    // Sprachwechsel bauen die Panels komplett neu auf, einzeln verkabelte
    // Listener wären danach weg. `toggle` steigt nicht auf — deshalb die
    // Erfassungsphase (`true`).
    if (!this._accordionHookAttached) {
      this._accordionHookAttached = true;
      document.addEventListener('toggle', (event) => {
        const opened = event.target;
        if (!(opened instanceof HTMLElement)) return;
        if (!opened.matches('details.panel-group') || !opened.open) return;

        if (!opened.closest('.sidebar-section')) return;

        // Nur die Geschwister auf derselben Ebene, nicht alle Gruppen des
        // Panels: „Explosion" und „Geschosspläne" tragen eine feinere Gruppe
        // in sich — ein panelweites Zuklappen würde beim Öffnen der inneren
        // die umgebende schließen und sie damit mit aus dem Bild nehmen.
        for (const sibling of opened.parentElement?.children || []) {
          if (sibling === opened) continue;
          if (sibling instanceof HTMLDetailsElement
              && sibling.classList.contains('panel-group')
              && sibling.open) {
            sibling.open = false;
          }
        }
      }, true);
    }

    // Beschriftungen der Gruppen folgen der Sprachwahl. Die Panels werden dazu
    // komplett neu aufgebaut — ihr Inhalt sind HTML-Strings, die sich nicht
    // nachträglich übersetzen lassen. Angemeldete Bereiche kommen dabei von
    // selbst wieder mit; vorher musste jedes eingehängte Modul das für sich
    // allein bemerken, und wer auf das falsche Ereignis lauschte, war weg.
    if (!this._languageHookAttached) {
      this._languageHookAttached = true;
      document.addEventListener('ileen:language-changed', () => {
        const active = document.querySelector('.activity-btn.active')?.dataset.section;
        this.createModernToolbar();
        this.initEventHandlers();
        if (active) this.activateSection(active);

        // Die Liste der geladenen Modelle wird beim Neuaufbau geleert — sie
        // steht im Markup nur als leerer Behälter. Die Einträge entstehen
        // sonst nur beim Laden eines Modells, wären nach einem Sprachwechsel
        // also verschwunden, obwohl die Modelle in der Szene liegen.
        this.closeAssetTransform();
        BimViewer.loadedAssets?.forEach((_asset, assetId) => this.createAssetControls(assetId));

        // Dasselbe gilt für die Vorschlagsliste der Ion-Assets: sie steht im
        // Markup nur als leere `<datalist>`. Neu abgefragt wird nichts — die
        // Namen liegen seit dem Start in `_ionAssetNames`.
        this.fillIonSuggestions();
        if (window.LayerManager && LayerManager.viewer) LayerManager.populateUI();
        window.Vektorkacheln?.panelZeichnen();

        if (window.ILeenUINormalize) ILeenUINormalize.run();
      });
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // DIE VIEWER-BEREICHE
  // ─────────────────────────────────────────────────────────────────
  //
  // Was hier steht, ist der Viewer und gehört in beide Fassungen. Auswertungen
  // melden sich aus ihrer eigenen Datei an: `room-concept-panel.js` und
  // `ifclash-panel.js` hängen ihre Untergruppen in den Bereich „ifc", und
  // keine Zeile in dieser Datei weiß davon.

  _viewerBereicheAnmelden() {
    // Welche Modelle gerade in der Szene liegen, ist die Frage, die beim
    // Öffnen des Panels immer zuerst kommt — die Liste steht deshalb fest
    // oben und nicht eingeklappt im Cesium-Ion-Abschnitt.
    this.bereichAnmelden({
      id: 'models', symbol: '📦', ordnung: 10,
      titel: () => t('panel.models'),
      angeheftet: () => this.getLoadedAssetsContent(),
      gruppen: [
        { key: 'ionAssets', ordnung: 10, label: () => t('group.ionAssets'), inhalt: () => this.getAssetsContent(), offen: true },
        { key: 'backend',   ordnung: 20, label: () => t('group.backend'),   inhalt: () => this.getBackendContent() },
        { key: 'layers',    ordnung: 30, label: () => t('group.layers'),    inhalt: () => this.getLayerManagerContent() },
      ],
    });

    // Punktwolken stehen bei der Ansicht, nicht bei den Modellen. Punktgröße,
    // Eye-Dome-Lighting und Farbmodus ändern nichts daran, *was* in der Szene
    // liegt — nur daran, *wie* es aussieht.
    this.bereichAnmelden({
      id: 'view', symbol: '📷', ordnung: 20,
      titel: () => t('panel.view'),
      gruppen: [
        { key: 'camera',     ordnung: 10, label: () => t('group.camera'),     inhalt: () => this.getViewTabContent(), offen: true },
        { key: 'pointcloud', ordnung: 20, label: () => t('group.pointcloud'), inhalt: () => this.getPointCloudContent() },
      ],
    });

    // Vom Bauteile-Panel gehört dem Viewer der Filter. „Räume & Nutzung"
    // (room-concept-panel.js) und die Kollisionsprüfung (ifclash-panel.js)
    // sind Auswertungen und hängen sich selbst hier hinein.
    this.bereichAnmelden({
      id: 'ifc', symbol: '🏗️', ordnung: 30,
      titel: () => t('panel.ifc'),
      beimOeffnen: () => {
        if (typeof IFCFilterPro !== 'undefined') IFCFilterPro.renderFilterList();
      },
      gruppen: [
        { key: 'filter', ordnung: 10, label: () => t('group.filter'), inhalt: () => this.getIFCContent(), offen: true },
      ],
    });

    // Werkzeuge: Reiter, keine Unterebene. Weitere Reiter (Schnittbox, Plan)
    // hängen die zugehörigen Module selbst an.
    this.bereichAnmelden({
      id: 'tools', symbol: '📐', ordnung: 40,
      titel: () => t('panel.tools'), inhalt: () => this.getToolsContent(),
    });

    this.bereichAnmelden({
      id: 'tags', symbol: '🏷️', ordnung: 50,
      titel: () => t('panel.tags'), inhalt: () => this.getTagsContent(),
      // Notizen können seit dem letzten Öffnen dazugekommen sein — die Liste
      // wird nicht laufend gepflegt, sondern beim Aufschlagen des Panels.
      beimOeffnen: () => this.refreshTagsPanel(),
    });

    this.bereichAnmelden({
      id: 'settings', symbol: '⚙️', ordnung: 80,
      titel: () => t('panel.settings'), inhalt: () => this.getSettingsContent(),
    });

    this.bereichAnmelden({
      id: 'about', symbol: 'ℹ️', ordnung: 90,
      titel: () => t('panel.help'), inhalt: () => this.getAboutContent(),
    });
  },

  /**
   * Frühere Panel-Kennungen → {Gruppe, Untergruppe}.
   *
   * Aufrufe wie `activateSection('nmc')` stehen verstreut in anderen Modulen
   * und in gespeicherten Verweisen. Statt sie alle nachzuziehen — und dabei
   * einen zu übersehen — werden die alten Namen hier übersetzt und öffnen
   * zusätzlich die passende Untergruppe.
   */
  SECTION_ALIASES: {
    assets:     { section: 'models', group: 'ionAssets' },
    backend:    { section: 'models', group: 'backend' },
    layers:     { section: 'models', group: 'layers' },
    pointcloud: { section: 'view',   group: 'pointcloud' },
    lighting:   { section: 'settings' },
    rooms:      { section: 'ifc',    group: 'rooms' },
    panotour:   { section: 'models', group: 'panotour' },
    clash:      { section: 'ifc',    group: 'clash' },
    nmc:        { section: 'tools',  tab: 'measure' },
    measure:    { section: 'tools',  tab: 'measure' },
    drawing:    { section: 'tools',  tab: 'clipping' },
    clipping:   { section: 'tools',  tab: 'clipping' },
    inspection: { section: 'tags' },
  },

  activateSection(id) {
    const alias = this.SECTION_ALIASES[id];
    const sectionId = alias ? alias.section : id;

    const seite = document.getElementById('sidebarPanel');
    const btn = document.querySelector(`.activity-btn[data-section="${sectionId}"]`);
    // Ein Alias zeigt gezielt auf eine Untergruppe — das soll das Panel öffnen
    // und dorthin springen, nie zuklappen, auch wenn die Gruppe schon offen ist.
    const wasActive = !alias && btn && btn.classList.contains('active');

    document.querySelectorAll('.activity-btn[data-section]').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.sidebar-section').forEach((s) => { s.style.display = 'none'; });

    if (wasActive) {
      if (seite) seite.classList.remove('is-open');
      this.closeAssetTransform();
      return;
    }

    const toolbar = document.getElementById('toolbar');
    if (toolbar && toolbar.classList.contains('collapsed')) this.toggleSidebar(false);

    if (btn) btn.classList.add('active');
    const section = document.getElementById(`section-${sectionId}`);
    if (section) section.style.display = 'flex';
    if (seite) seite.classList.add('is-open');

    if (alias?.group) this.openGroup(alias.group);
    if (alias?.tab) this.showToolsTab(alias.tab);

    // Was beim Öffnen zu geschehen hat, meldet der Bereich selbst an — und
    // jede Untergruppe für sich. Vorher stand hier eine Kette von
    // `if (sectionId === …)`, und jede Auswertung, die so einen Haken
    // brauchte, musste dafür in diese Datei geschrieben werden: die
    // Kollisionsprüfung etwa setzt ihre Ereignisbehandlung bei jedem Öffnen
    // neu, weil ihre Elemente mit dem Panel neu entstehen.
    const bereich = this._bereiche.find((b) => b.id === sectionId);
    if (bereich) {
      this._hakenRufen(bereich.beimOeffnen, sectionId);
      (bereich.gruppen || []).forEach((g) =>
        this._hakenRufen(g.beimOeffnen, sectionId + '/' + g.key));
    }
  },

  /** Einen `beimOeffnen`-Haken rufen, ohne dass sein Fehler das Öffnen abbricht. */
  _hakenRufen(fn, wo) {
    if (typeof fn !== 'function') return;
    try { fn.call(this); }
    catch (e) { console.error('[BimViewerUI] beimOeffnen "' + wo + '"', e); }
  },

  /** Die ganze linke Leiste ein- oder ausfahren (Taste M). */
  toggleSidebar(einklappen) {
    const toolbar = document.getElementById('toolbar');
    const toggle = document.getElementById('sidebarToggle');
    if (!toolbar) return;
    const isCollapsed = typeof einklappen === 'boolean'
      ? toolbar.classList.toggle('collapsed', einklappen)
      : toolbar.classList.toggle('collapsed');
    if (toggle) toggle.classList.toggle('is-visible', isCollapsed);
    if (isCollapsed) this.closeAssetTransform();
  },

  /**
   * Reiter im Werkzeuge-Panel umschalten.
   *
   * Reiter statt aufklappbarer Gruppen: die Werkzeuge passen ohne Scrollen
   * ins Panel, und man sieht auf einen Blick, was es gibt.
   */
  showToolsTab(name) {
    document.querySelectorAll('#section-tools .tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.tab === name);
    });
    document.querySelectorAll('#section-tools .tab-pane').forEach((pane) => {
      pane.classList.toggle('is-active', pane.id === `toolsPane-${name}`);
    });
  },

  /** Klappt eine Untergruppe auf und scrollt sie in den sichtbaren Bereich. */
  openGroup(key) {
    const group = document.getElementById(`group-${key}`);
    if (!group) return;
    group.open = true;
    // Erst nach dem Aufklappen scrollen — vorher hat das Element noch die
    // zugeklappte Höhe und landet an der falschen Stelle.
    requestAnimationFrame(() => {
      group.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  },

  /** Rolle wechseln: bestimmt, welche Eigenschaften zuerst stehen. */
  switchRole(roleId) {
    this.currentRole = roleId;
    document.body.dataset.rolle = roleId;

    const panelTitle = document.getElementById('infoBoxPanelTitle');
    if (panelTitle) {
      // Rollennamen kommen aus dem Wörterbuch, damit sie der Sprachwahl folgen.
      // Rollen ohne Eintrag (Altbestand) fallen auf den Schlüssel zurück.
      const translated = window.t ? t(`role.${roleId}`) : roleId;
      const roleLabel = translated === `role.${roleId}` ? roleId.toUpperCase() : translated;
      const title = window.t ? t('props.title') : 'PROPERTIES';
      panelTitle.textContent = `${title} · ${roleLabel}`;
    }

    // Eigenschaften neu gruppieren — dieselben Daten, andere Rollensicht.
    // `refresh()` zeichnet aus dem Zwischenspeicher, ohne die Bauteildatenbank
    // erneut abzufragen.
    if (window.IFCRoleProperties) {
      IFCRoleProperties.refresh();
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // MODELLE
  // ─────────────────────────────────────────────────────────────────

  /**
   * Geladene Modelle — fester Kopf des Modelle-Panels.
   *
   * Die Frage „was liegt gerade in der Szene" stellt sich vor jeder anderen.
   */
  getLoadedAssetsContent() {
    const underground = window.BimViewer?.undergroundMode?.enabled ? ' checked' : '';

    return `
      <div class="section section--pinned">
        <div class="section__label section__label--split">
          <span>${t('group.loaded')}</span>
          <span id="loadedAssetsCount" class="count-badge">0</span>
        </div>
        <div id="loadedAssetsList" class="asset-list">
          <div class="modern-empty-state">${t('state.noAssets')}</div>
        </div>

        <!--
          Untergrund-Modus steht hier: gebraucht wird er in dem Moment, in dem
          das erste Modell in der Szene liegt und man an Keller oder Gründung
          heranfahren will — also genau hier, ohne Panelwechsel.
        -->
        <div class="row">
          <span class="row__label">🕳️ ${t('underground.mode')}</span>
          <label class="switch">
            <input type="checkbox" id="toggleUndergroundView"${underground}>
            <span class="switch__track"></span>
          </label>
        </div>
        <div class="row">
          <span class="row__label">${t('underground.zeroLevel')}</span>
          <label class="switch">
            <input type="checkbox" id="toggleNullebene"${window.BimViewer?.Untergrund?.nullebeneAn?.() === false ? '' : ' checked'}>
            <span class="switch__track"></span>
          </label>
        </div>
        <div class="row">
          <span class="row__label">${t('underground.seeThrough')}</span>
          <label class="switch">
            <input type="checkbox" id="toggleDurchblick"${window.BimViewer?.Untergrund?.durchblickAn?.() === false ? '' : ' checked'}>
            <span class="switch__track"></span>
          </label>
        </div>
        <p class="hint">${t('underground.hint')}</p>
      </div>
    `;
  },

  /**
   * Cesium Ion — ein Feld statt Liste, Importknopf und zweitem Feld.
   *
   * Ein Eingabefeld mit angehängter Vorschlagsliste (`<datalist>`): der Name
   * aus dem Konto lässt sich auswählen, eine fremde ID einfach eintippen — ein
   * Weg statt zwei. `_ionAssetNames` merkt sich dabei, welcher Name zu welcher
   * ID gehört, damit das geladene Modell in der Liste oben seinen richtigen
   * Namen trägt und nicht „Ion Asset 4587934".
   */
  getAssetsContent() {
    return `
      <div class="section">
        <div class="field">
          <label class="field__label" for="ionAssetInput">${t('models.ionField')}</label>
          <div class="input-row">
            <input id="ionAssetInput" class="input" list="ionAssetOptions" autocomplete="off"
                   placeholder="${t('models.ionPlaceholder')}">
            <button id="loadIonAsset" class="btn btn--icon" title="${t('action.load')}">+</button>
          </div>
          <datalist id="ionAssetOptions"></datalist>
        </div>
        <div id="ionAssetsStatus" class="hint">${t('state.loading')}</div>
      </div>
    `;
  },

  // Modell-Browser — die Modelle des eigenen Servers, separat von den Ion-Assets.
  //
  // Gleicher Aufbau wie der Ion-Abschnitt darüber: ein beschriftetes Feld mit
  // angehängtem Knopf, darunter die Liste. Wer die beiden Ladewege
  // untereinander sieht, soll nicht zweimal lernen müssen, wie sie zu bedienen
  // sind. Die Liste kommt von GET /assets/, geladen wird /tiles/{job}/tileset.json.
  //
  // Zwischen Status und Liste steht der Filter: Kategoriepillen je Inhaltstyp
  // und ein Namensfeld. Ein Server mit sechzig Modellen ist der Regelfall, und
  // in einer 180 px hohen Scrollbox findet man darin nichts.
  getBackendContent() {
    return `
      <div class="section">
        <div class="field">
          <label class="field__label" for="backendUrlInput">${t('models.backendUrl')}</label>
          <div class="input-row">
            <input id="backendUrlInput" type="text" class="input" placeholder="http://localhost:8100">
            <button id="backendRefresh" class="btn btn--icon" title="${t('action.refresh')}">⟳</button>
          </div>
        </div>
        <div id="backendStatus" class="hint">${t('models.backendOffline')}</div>
        <div id="backendFilter" class="models-filter" hidden>
          <input id="backendSearch" type="text" class="input"
                 placeholder="${t('models.search')}" autocomplete="off">
          <div id="backendFilterPills" class="pill-group"></div>
        </div>
        <div id="backendAssetsList" class="asset-list scroll-box"></div>
      </div>

      <div class="section">
        <div class="field">
          <label class="field__label" for="backendJobInput">${t('models.backendJob')}</label>
          <div class="input-row">
            <input id="backendJobInput" type="text" class="input" placeholder="${t('models.backendJobPlaceholder')}">
            <button id="loadBackendByInput" class="btn btn--icon" title="${t('action.load')}">+</button>
          </div>
        </div>
      </div>
    `;
  },

  // Symbol je Inhaltstyp, wie ihn /assets/ meldet
  BACKEND_TYPE_ICONS: {
    ifc: '🏢',
    pointcloud: '☁️',
    splat: '✨',
    mesh: '🔷',
    unknown: '📦'
  },

  // Der volle Serverstand. Gefiltert wird nur die Anzeige — wer nach „IFC"
  // filtert, soll damit nicht die Modelle verlieren, die er gerade geladen hat.
  backendAssets: [],
  backendFilter: 'alle',
  backendSuche: '',

  async refreshBackendAssets() {
    const statusEl = document.getElementById('backendStatus');
    const listEl = document.getElementById('backendAssetsList');
    if (!statusEl || !listEl) return;

    const baseUrl = BimViewer.getBackendUrl();
    if (!baseUrl) {
      statusEl.textContent = 'Keine Serveradresse eingetragen';
      this.backendAssets = [];
      this.renderBackendAssets();
      return;
    }

    statusEl.textContent = `Verbinde mit ${baseUrl} …`;
    listEl.innerHTML = '';

    const assets = await BimViewer.fetchBackendAssets();
    this.backendAssets = assets;

    if (!assets.length) {
      // Leere Liste und Verbindungsfehler sind für den Nutzer verschiedene Dinge
      statusEl.innerHTML = `<span class="text-warning">Keine Modelle gefunden</span> — Server erreichbar?`;
    } else {
      statusEl.innerHTML = `<span class="text-ok">✅ ${assets.length} Modell${assets.length === 1 ? '' : 'e'}</span> auf ${uiEsc(baseUrl)}`;
    }
    this.renderBackendAssets();
  },

  backendTypLabel(typ) {
    const label = t(`models.type.${typ}`);
    // t() gibt den Schlüssel zurück, wenn er fehlt — ein neuer Inhaltstyp im
    // Backend soll dann seinen Rohnamen zeigen, nicht „models.type.xyz".
    return label.startsWith('models.type.') ? typ : label;
  },

  gefilterteBackendAssets() {
    const q = this.backendSuche.trim().toLowerCase();
    return this.backendAssets.filter(a =>
      (this.backendFilter === 'alle' || a.content_type === this.backendFilter) &&
      (!q || String(a.name || '').toLowerCase().includes(q))
    );
  },

  renderBackendAssets() {
    const listEl = document.getElementById('backendAssetsList');
    const filterEl = document.getElementById('backendFilter');
    const pillsEl = document.getElementById('backendFilterPills');
    if (!listEl) return;

    // Nach einem Sprachwechsel baut sich das Panel neu auf: das Suchfeld ist
    // dann leer, der gemerkte Suchbegriff aber noch gesetzt — die Liste wäre
    // gefiltert, ohne dass man sähe wonach.
    const sucheEl = document.getElementById('backendSearch');
    if (sucheEl && sucheEl.value !== this.backendSuche) sucheEl.value = this.backendSuche;

    const zaehler = new Map();
    for (const a of this.backendAssets) {
      zaehler.set(a.content_type, (zaehler.get(a.content_type) || 0) + 1);
    }
    // Ein Filter auf eine Kategorie, die der Server nicht mehr führt, zeigte
    // sonst eine leere Liste, ohne dass der Grund zu sehen wäre.
    if (this.backendFilter !== 'alle' && !zaehler.has(this.backendFilter)) this.backendFilter = 'alle';

    if (filterEl) filterEl.hidden = this.backendAssets.length === 0;
    if (pillsEl) {
      const eintraege = [['alle', t('models.filterAll'), this.backendAssets.length]]
        .concat([...zaehler.keys()].sort()
          .map(k => [k, this.backendTypLabel(k), zaehler.get(k)]));
      pillsEl.innerHTML = eintraege.map(([key, label, n]) => {
        const aktiv = this.backendFilter === key ? ' is-active' : '';
        return `<span class="pill backend-pill${aktiv}" data-typ="${key}">` +
               `${label}<span class="pill__zahl">${n}</span></span>`;
      }).join('');
      // Bei einer einzigen Kategorie sagen die Pillen nichts, was die Liste
      // nicht schon zeigt.
      pillsEl.hidden = zaehler.size < 2;
      pillsEl.querySelectorAll('.backend-pill').forEach(p => {
        p.onclick = () => {
          this.backendFilter = p.dataset.typ;
          this.renderBackendAssets();
        };
      });
    }

    const sichtbar = this.gefilterteBackendAssets();
    if (!this.backendAssets.length) {
      listEl.innerHTML = '<div class="modern-empty-state">Keine Modelle auf dem Server</div>';
    } else if (!sichtbar.length) {
      listEl.innerHTML = '<div class="modern-empty-state">Kein Modell passt zu Filter und Suche</div>';
    } else {
      listEl.innerHTML = sichtbar.map(asset => this.getBackendAssetHTML(asset)).join('');
    }
  },

  getBackendAssetHTML(asset) {
    const jobId = asset.job_id || '';
    const name = asset.name || jobId.slice(0, 8);
    const icon = this.BACKEND_TYPE_ICONS[asset.content_type] || this.BACKEND_TYPE_ICONS.unknown;
    const date = asset.last_modified ? new Date(asset.last_modified).toLocaleDateString('de-DE') : '';

    // Anführungszeichen im Namen würden das onclick-Attribut zerreißen
    const safeName = String(name).replace(/'/g, "\\'").replace(/"/g, '&quot;');

    return `
      <button class="btn btn--ghost btn--block asset-row"
              title="${jobId}"
              onclick="BimViewer.loadBackendAsset('${jobId}', '${safeName}')">
        <span class="asset-row__icon">${icon}</span>
        <span class="asset-row__name">${uiEsc(name)}</span>
        <span class="asset-row__meta">${date}</span>
      </button>
    `;
  },

  /**
   * Layer — Karte, 3D-Ebenen, Gelände.
   *
   * Die Frage, um die es hier geht: welche Karte und welches Gelände liegen
   * unter dem Modell, und welche Gebäudekulisse steht daneben. Die Listen
   * füllt layerManager.js.
   */
  getLayerManagerContent() {
    return `
      <div class="section">
        <div class="section__label">${t('layer.basemap')}</div>
        <div id="basemapList" class="layer-basemap-list"></div>
      </div>

      <div class="section">
        <div class="section__label">${t('layer.tiles3d')}</div>
        <div class="row">
          <span class="row__label">OSM Buildings</span>
          <label class="switch">
            <input type="checkbox" id="toggleOSMBuildings">
            <span class="switch__track"></span>
          </label>
        </div>
        <div class="row">
          <span class="row__label">Google 3D Tiles</span>
          <label class="switch">
            <input type="checkbox" id="toggleGoogle3DTiles">
            <span class="switch__track"></span>
          </label>
        </div>
        <div id="googleTilesQualityRow" class="btn-group" style="display:none;">
          <button class="btn btn--sm google-tiles-preset-btn" data-preset="performance" onclick="BimViewer.setGoogleTilesQuality('performance')">Speed</button>
          <button class="btn btn--sm google-tiles-preset-btn active" data-preset="balanced" onclick="BimViewer.setGoogleTilesQuality('balanced')">Balanced</button>
          <button class="btn btn--sm google-tiles-preset-btn" data-preset="quality" onclick="BimViewer.setGoogleTilesQuality('quality')">Quality</button>
        </div>
        <div id="tilesetLayersList" class="layer-overlay-list"></div>
      </div>

      <div class="section">
        <div class="section__label">${t('layer.vector')}</div>
        <div id="vectorLayersList"></div>
        <p class="hint">${t('layer.vectorHint')}</p>
      </div>

      <div class="section">
        <div class="section__label">${t('layer.terrain')}</div>
        <div id="terrainList" class="layer-terrain-list"></div>
      </div>
    `;
  },

  /**
   * Punktwolken — Darstellung, deshalb im Ansicht-Panel (📷).
   *
   * Gleiches Vokabular wie die übrigen Panels (`section`, `row`, `slider-row`,
   * `switch`).
   */
  getPointCloudContent() {
    const s = (window.BimViewer && BimViewer.pointCloudSettings) || {
      edlEnabled: true,
      edlStrength: 1.0,
      edlRadius: 1.0,
      pointSize: 2.0,
      attenuationEnabled: true,
      maximumAttenuation: null,
      geometricErrorScale: 1.0,
      colorMode: 'rgb',
      backFaceCulling: false,
      maximumScreenSpaceError: 16,
      dynamicError: true,
      autoLeistung: true,
      heightWindow: null
    };

    return `
      <div class="section">
        <div class="section__label">${t('pc.presets')}</div>
        <div class="btn-group">
          <button class="btn btn--sm" onclick="BimViewer.applyPointCloudPreset('quality')">
            <span class="modern-btn-icon">💎</span><span>Quality</span>
          </button>
          <button class="btn btn--sm" onclick="BimViewer.applyPointCloudPreset('performance')">
            <span class="modern-btn-icon">⚡</span><span>Speed</span>
          </button>
          <button class="btn btn--sm" onclick="BimViewer.applyPointCloudPreset('detailed')">
            <span class="modern-btn-icon">🔍</span><span>Detail</span>
          </button>
        </div>
      </div>

      <div class="section">
        <div class="section__label">${t('pc.colorMode')}</div>
        <select id="colorModeSelect" class="select" onchange="BimViewer.setColorMode(this.value)">
          <option value="rgb"            ${s.colorMode === 'rgb'            ? 'selected' : ''}>Original RGB</option>
          <option value="height"         ${s.colorMode === 'height'         ? 'selected' : ''}>Height</option>
          <option value="intensity"      ${s.colorMode === 'intensity'      ? 'selected' : ''}>Intensity</option>
          <option value="classification" ${s.colorMode === 'classification' ? 'selected' : ''}>Classification</option>
        </select>
        <div id="pcHeightWindow" class="input-row" ${s.colorMode === 'height' ? '' : 'hidden'}>
          <input type="number" id="pcHeightMin" class="input" step="0.1"
                 title="${t('pc.heightFrom')}"
                 value="${s.heightWindow ? s.heightWindow.min : ''}"
                 onchange="BimViewer.setHeightWindow(this.value, document.getElementById('pcHeightMax').value)">
          <input type="number" id="pcHeightMax" class="input" step="0.1"
                 title="${t('pc.heightTo')}"
                 value="${s.heightWindow ? s.heightWindow.max : ''}"
                 onchange="BimViewer.setHeightWindow(document.getElementById('pcHeightMin').value, this.value)">
          <button class="btn btn--sm btn--ghost" title="${t('pc.heightAuto')}"
                  onclick="BimViewer.setHeightWindow()">auto</button>
        </div>
      </div>

      <div class="section">
        <div class="section__label">${t('pc.edl')}</div>
        <div class="row">
          <span class="row__label">EDL</span>
          <label class="switch">
            <input type="checkbox" id="toggleEDL" ${s.edlEnabled ? 'checked' : ''}
                   onchange="BimViewer.setEyeDomeLighting(this.checked)">
            <span class="switch__track"></span>
          </label>
        </div>
        <div id="edlStrengthGroup" class="slider-row ${s.edlEnabled ? '' : 'disabled'}">
          <span class="slider-row__label">Strength</span>
          <input type="range" id="edlStrengthSlider" class="slider" min="0" max="3" step="0.1" value="${s.edlStrength}"
                 oninput="BimViewer.setEDLStrength(this.value)"
                 ${s.edlEnabled ? '' : 'disabled'}>
          <span id="edlStrengthValue" class="slider-row__value">${s.edlStrength.toFixed(1)}</span>
        </div>
        <div id="edlRadiusGroup" class="slider-row ${s.edlEnabled ? '' : 'disabled'}">
          <span class="slider-row__label">Radius</span>
          <input type="range" id="edlRadiusSlider" class="slider" min="0.5" max="3" step="0.1" value="${s.edlRadius}"
                 oninput="BimViewer.setEDLRadius(this.value)"
                 ${s.edlEnabled ? '' : 'disabled'}>
          <span id="edlRadiusValue" class="slider-row__value">${s.edlRadius.toFixed(1)}</span>
        </div>
      </div>

      <div class="section">
        <div class="section__label">${t('pc.appearance')}</div>
        <div id="pointSizeGroup" class="slider-row ${s.attenuationEnabled ? 'disabled' : ''}">
          <span class="slider-row__label">Size</span>
          <input type="range" id="pointSizeSlider" class="slider" min="0.5" max="10" step="0.5" value="${s.pointSize}"
                 oninput="BimViewer.setPointSize(this.value)"
                 ${s.attenuationEnabled ? 'disabled' : ''}>
          <span id="pointSizeValue" class="slider-row__value">${s.pointSize.toFixed(1)}</span>
        </div>
        <div class="row">
          <span class="row__label">Attenuation</span>
          <label class="switch">
            <input type="checkbox" id="toggleAttenuation" ${s.attenuationEnabled ? 'checked' : ''}
                   onchange="BimViewer.setAttenuation(this.checked)">
            <span class="switch__track"></span>
          </label>
        </div>
        <div id="maxAttenuationGroup" class="slider-row ${s.attenuationEnabled ? '' : 'disabled'}">
          <span class="slider-row__label">Max Att.</span>
          <input type="range" id="maxAttenuationSlider" class="slider" min="1" max="10" step="0.5" value="${s.maximumAttenuation || 1}"
                 oninput="BimViewer.setMaximumAttenuation(this.value)"
                 ${s.attenuationEnabled ? '' : 'disabled'}>
          <span id="maxAttenuationValue" class="slider-row__value">${s.maximumAttenuation ? s.maximumAttenuation.toFixed(1) : 'None'}</span>
        </div>
      </div>

      <div class="section">
        <div class="section__label">${t('pc.performance')}</div>
        <div class="slider-row" title="${t('pc.detailHint')}">
          <span class="slider-row__label">${t('pc.detail')}</span>
          <input type="range" id="pcDetailSlider" class="slider" min="2" max="64" step="1"
                 value="${s.maximumScreenSpaceError}"
                 onchange="BimViewer.setPointCloudDetail(this.value)">
          <span id="pcDetailValue" class="slider-row__value">${s.maximumScreenSpaceError.toFixed(0)} px</span>
        </div>
        <div class="row" title="${t('pc.dynamicHint')}">
          <span class="row__label">${t('pc.dynamic')}</span>
          <label class="switch">
            <input type="checkbox" id="togglePcDynamic" ${s.dynamicError ? 'checked' : ''}
                   onchange="BimViewer.setPointCloudDynamicError(this.checked)">
            <span class="switch__track"></span>
          </label>
        </div>
        <div class="row" title="${t('pc.autoHint')}">
          <span class="row__label">${t('pc.auto')}</span>
          <label class="switch">
            <input type="checkbox" id="togglePcAuto" ${s.autoLeistung ? 'checked' : ''}
                   onchange="BimViewer.setPointCloudAuto(this.checked)">
            <span class="switch__track"></span>
          </label>
        </div>
        <div class="row"><span class="row__label" id="pcAutoWert"></span></div>
        <div class="slider-row">
          <span class="slider-row__label">Geo. Error</span>
          <input type="range" id="geometricErrorSlider" class="slider" min="0.1" max="5" step="0.1" value="${s.geometricErrorScale}"
                 oninput="BimViewer.setGeometricErrorScale(this.value)">
          <span id="geometricErrorValue" class="slider-row__value">${s.geometricErrorScale.toFixed(1)}</span>
        </div>
        <div class="row">
          <span class="row__label">Back Face Culling</span>
          <label class="switch">
            <input type="checkbox" id="toggleBackFaceCulling" ${s.backFaceCulling ? 'checked' : ''}
                   onchange="BimViewer.setBackFaceCulling(this.checked)">
            <span class="switch__track"></span>
          </label>
        </div>
      </div>

      <button class="btn btn--block" onclick="BimViewer.resetPointCloudSettings()">${t('action.reset')}</button>
    `;
  },

  // ─────────────────────────────────────────────────────────────────
  // WERKZEUGE
  // ─────────────────────────────────────────────────────────────────

  /**
   * Werkzeuge-Panel: Reiter Messen und Schnitte. Die Schnittbox
   * (section-box.js) und der Zeichenmodus (plan-panel.js) ergänzen ihre
   * eigenen Reiter.
   */
  getToolsContent() {
    return `
      <div class="tabs" role="tablist">
        <button class="tab is-active" role="tab" data-tab="measure"
                onclick="BimViewerUI.showToolsTab('measure')">${t('group.measure')}</button>
        <button class="tab" role="tab" data-tab="clipping"
                onclick="BimViewerUI.showToolsTab('clipping')">${t('group.clipping')}</button>
      </div>

      <div class="tab-pane is-active" id="toolsPane-measure">${this.getMeasureContent()}</div>
      <div class="tab-pane" id="toolsPane-clipping">${this.getDrawingContent()}</div>
    `;
  },

  /**
   * Reiter „Schnitte". Ein Schnitt durch das Modell ist die Schnittbox
   * (eigener Reiter); hier stehen die Ausschnitte der Weltkulisse.
   * ui-new-features-extension.js hängt die Google-Freistellung an.
   */
  getDrawingContent() {
    return `
      <div class="section">
        <p class="hint">
          Einen Ausschnitt durch ein Bauteil legt die <strong>Schnittbox</strong>
          (Reiter daneben). Hier wird die Weltkulisse um die eigenen Modelle freigestellt.
        </p>
      </div>
    `;
  },

  /**
   * Reiter „Messen" — der eine Messmodus aus `aufmass.js`.
   *
   * Was gemessen wird, entscheidet die Zahl der Klicks, nicht eine Auswahl
   * davor; das Panel stellt deshalb nur ein, was währenddessen gilt. Der Inhalt
   * liegt in `aufmass-panel.js`, weil er zum Modul gehört und nicht zur
   * Oberfläche.
   */
  getMeasureContent() {
    return `
      ${typeof AufmassPanel !== 'undefined' ? AufmassPanel.html()
        : '<div class="hint">Aufmaß-Modul wird geladen…</div>'}

      ${this.getTopoVolumeContent()}

      <details class="subgroup">
        <summary class="subgroup__header">${t('group.session')}</summary>
        <div class="subgroup__body">
          ${typeof ILEEN_SESSION !== 'undefined'
            ? ILEEN_SESSION.getSessionPanelHTML()
            : '<div id="ileen-session-panel" class="hint">Session-Modul wird geladen…</div>'}
        </div>
      </details>
    `;
  },

  /** Ruft `aufmass.js` beim Panel auf, wenn sich am Messstand etwas ändert. */
  aufmassStand() {
    if (typeof AufmassPanel !== 'undefined') AufmassPanel.stand();
  },

  /**
   * Topografisches Aufmaß — Volumen aus den Punkten, Karte aus dem Ergebnis.
   *
   * Die Darstellungsschalter stehen unter dem Ergebnis und nicht davor: vor
   * der Messung ist nicht zu beurteilen, welcher Höhenlinienabstand zu den
   * Daten passt, und danach wirkt jede Änderung sofort — neu gelesen wird
   * nichts. Die Rechnung selbst liegt in `volume-topo.js`.
   */
  getTopoVolumeContent() {
    return `
      <div class="section">
        <div class="section__label">${t('topo.title')}</div>

        <div class="btn-group">
          <button id="tvStart" class="btn btn--sm btn--primary"
                  onclick="TopoVolume.toggle()"
                  title="${t('topo.hint')}">${t('topo.draw')}</button>
          <button id="tvStop" class="btn btn--sm" style="display:none;"
                  onclick="TopoVolume.cancel()">${t('topo.discard')}</button>
        </div>
        <div id="tvCount" class="hint" style="display:none;"></div>
        <div id="tvBusy" class="hint" style="display:none;"></div>

        <div class="field" style="margin-top:8px;">
          <label class="field__label" for="tvReference">${t('topo.reference')}</label>
          <select id="tvReference" class="select" onchange="TopoVolume.recompute(false)">
            <option value="tiefste" selected>${t('topo.refLowest')}</option>
            <option value="mittel">${t('topo.refMean')}</option>
            <option value="geneigt">${t('topo.refTilted')}</option>
            <option value="fest">${t('topo.refFixed')}</option>
          </select>
        </div>

        <div class="field" id="tvFixedRow" style="display:none;">
          <label class="field__label" for="tvFixedHeight">${t('topo.fixedHeight')}</label>
          <input type="number" step="0.1" value="0" id="tvFixedHeight" class="input input--num"
                 onchange="TopoVolume.recompute(false)">
        </div>

        <div class="field">
          <label class="field__label" for="tvAggregate">${t('topo.aggregate')}</label>
          <select id="tvAggregate" class="select" onchange="TopoVolume.rebin()">
            <option value="mittel" selected>${t('topo.aggMean')}</option>
            <option value="hoch">${t('topo.aggHigh')}</option>
            <option value="tief">${t('topo.aggLow')}</option>
          </select>
        </div>

        <div class="field">
          <label class="field__label" for="tvCell">${t('topo.cell')}</label>
          <select id="tvCell" class="select" onchange="TopoVolume.rebin()">
            <option value="0" selected>${t('topo.cellAuto')}</option>
            <option value="0.1">0,10 m</option>
            <option value="0.25">0,25 m</option>
            <option value="0.5">0,50 m</option>
            <option value="1">1,00 m</option>
            <option value="2">2,00 m</option>
            <option value="5">5,00 m</option>
          </select>
        </div>

        <div id="tvResult" style="display:none;"></div>
        <div id="tvMap" style="display:none;margin-top:8px;"></div>

        <div id="tvTools" style="display:none;margin-top:8px;">
          <div class="field">
            <label class="field__label" for="tvRamp">${t('topo.ramp')}</label>
            <select id="tvRamp" class="select" onchange="TopoVolume.redraw()">
              <option value="hoehe" selected>${t('topo.rampHeight')}</option>
              <option value="auftrag">${t('topo.rampCutFill')}</option>
            </select>
          </div>

          <div class="field">
            <label class="field__label" for="tvInterval">${t('topo.interval')}</label>
            <select id="tvInterval" class="select" onchange="TopoVolume.redraw()">
              <option value="0" selected>${t('topo.intervalAuto')}</option>
              <option value="0.05">0,05 m</option>
              <option value="0.1">0,10 m</option>
              <option value="0.25">0,25 m</option>
              <option value="0.5">0,50 m</option>
              <option value="1">1,00 m</option>
              <option value="2">2,00 m</option>
              <option value="5">5,00 m</option>
            </select>
          </div>

          <div class="row">
            <span class="row__label">${t('topo.contours')}</span>
            <label class="switch">
              <input type="checkbox" id="tvContours" checked onchange="TopoVolume.redraw()">
              <span class="switch__track"></span>
            </label>
          </div>
          <div class="row">
            <span class="row__label">${t('topo.hillshade')}</span>
            <label class="switch">
              <input type="checkbox" id="tvHillshade" checked onchange="TopoVolume.redraw()">
              <span class="switch__track"></span>
            </label>
          </div>
          <div class="row">
            <span class="row__label">${t('topo.steps')}</span>
            <label class="switch">
              <input type="checkbox" id="tvSteps" onchange="TopoVolume.redraw()">
              <span class="switch__track"></span>
            </label>
          </div>
          <div class="row">
            <span class="row__label">${t('topo.overlay')}</span>
            <label class="switch">
              <input type="checkbox" id="tvOverlay" checked
                     onchange="TopoVolume.setOverlay(this.checked)">
              <span class="switch__track"></span>
            </label>
          </div>

          <div class="field">
            <label class="field__label" for="tvOpacity">${t('topo.opacity')}</label>
            <input type="range" class="slider" id="tvOpacity" min="0.2" max="1" step="0.05"
                   value="0.9" oninput="TopoVolume.setOpacity(this.value)">
          </div>

          <div class="btn-group" style="margin-top:8px;">
            <button class="btn btn--sm" onclick="TopoVolume.downloadMap()">${t('topo.saveMap')}</button>
            <button class="btn btn--sm" onclick="TopoVolume.logToSession()">${t('topo.log')}</button>
          </div>
        </div>

        <p class="hint">${t('topo.hint')}</p>
      </div>
    `;
  },

  /**
   * Kollisionsprüfung und RDF-Ausgabe — im Bauteile-Panel.
   *
   * Die Element-IDs sind die, die `ifclash.js` sucht.
   */

  // ─────────────────────────────────────────────────────────────────
  // ANSICHT
  // ─────────────────────────────────────────────────────────────────

  /** Wird von ui-new-features-extension.js um den Isolate-Modus ergänzt. */
  getVisibilityContent() {
    return '';
  },

  // Kamera, Sichtbarkeit, gespeicherte Ansichten, Tiefenschärfe
  getViewTabContent() {
    const D = (window.Views && window.Views.DEFAULT_DOF) || {
      enabled: false, focusDistance: 30, focusRange: 6, bokehStrength: 1.5, maxBlur: 8,
    };
    return `
      <div class="pc-section">
        <div class="pc-label">CAMERA</div>
        <div class="pc-slider-row">
          <span class="pc-row-label">Field of View</span>
          <input type="range" id="viewFovSlider" class="pc-slider" min="20" max="120" step="1" value="60"
                 oninput="BimViewer.setFieldOfView(parseFloat(this.value)); document.getElementById('viewFovValue').textContent=this.value+'°'">
          <span class="pc-value" id="viewFovValue">60°</span>
        </div>
      </div>

      <div class="pc-section">
        <div class="pc-label">VISIBILITY</div>
        <div class="btn-group" style="margin-bottom:6px;">
          <button id="toggleHideMode" class="btn btn--sm" title="Bauteile per Klick ausblenden (H)">
            Hide Elements
            <span id="hiddenFeaturesCount" class="count-badge" style="display:none;margin-left:4px;">0</span>
          </button>
          <button id="showAllHidden" class="btn btn--sm" title="Alle wieder einblenden (Umschalt+H)">
            Show All
          </button>
        </div>
        ${this.getVisibilityContent()}
      </div>

      <div class="pc-section">
        <div class="pc-label">SAVED VIEWS</div>
        <button id="viewsSaveBtn" class="btn btn--primary btn--block" style="margin-bottom:6px;">
          Save Current View
        </button>
        <div id="viewsList" class="modern-views-list"></div>
      </div>

      <div class="pc-section">
        <div class="pc-label">DEPTH OF FIELD</div>
        <div class="pc-row">
          <span class="pc-row-label">Enable DoF</span>
          <label class="pc-switch">
            <input type="checkbox" id="viewsDofToggle" onchange="window.Views&&Views.setDofEnabled(this.checked)">
            <span class="pc-switch-track"></span>
          </label>
        </div>
        <div class="pc-slider-row">
          <span class="pc-row-label">Focus Dist.</span>
          <input id="viewsDofFd" type="range" class="pc-slider" min="0.5" max="500" step="0.5" value="${D.focusDistance}"
                 oninput="window.Views&&Views.setFocusDistance(parseFloat(this.value)); document.getElementById('viewsDofFdVal').textContent=parseFloat(this.value).toFixed(1)+'m'">
          <span class="pc-value" id="viewsDofFdVal">${D.focusDistance.toFixed(1)}m</span>
        </div>
        <div class="pc-slider-row">
          <span class="pc-row-label">Focus Range</span>
          <input id="viewsDofFr" type="range" class="pc-slider" min="0.1" max="100" step="0.1" value="${D.focusRange}"
                 oninput="window.Views&&Views.setFocusRange(parseFloat(this.value)); document.getElementById('viewsDofFrVal').textContent=parseFloat(this.value).toFixed(1)+'m'">
          <span class="pc-value" id="viewsDofFrVal">${D.focusRange.toFixed(1)}m</span>
        </div>
        <div class="pc-slider-row">
          <span class="pc-row-label">Bokeh</span>
          <input id="viewsDofBs" type="range" class="pc-slider" min="0" max="3" step="0.05" value="${D.bokehStrength}"
                 oninput="window.Views&&Views.setBokehStrength(parseFloat(this.value)); document.getElementById('viewsDofBsVal').textContent=parseFloat(this.value).toFixed(2)">
          <span class="pc-value" id="viewsDofBsVal">${D.bokehStrength.toFixed(2)}</span>
        </div>
        <button id="viewsDofPick" class="btn btn--sm btn--block" style="margin-top:4px;">Auto-Focus from Center</button>
      </div>
    `;
  },


  // IFC Filter content — delegiert an IFCFilterPro (ifc-filter-pro.js) wenn geladen
  getIFCContent() {
    if (typeof IFCFilterPro !== 'undefined') {
      return IFCFilterPro.getPanelHTML();
    }
    return `
      <div class="section">
        <div class="section__label section__label--split">
          <span>IFC</span>
          <span><span id="activeEntityCount">0</span>/<span id="totalEntityCount">0</span></span>
        </div>
        <div class="btn-group">
          <button class="btn btn--sm" onclick="BimViewer.selectAllIFCTypes()">${t('action.showAll')}</button>
          <button class="btn btn--sm" onclick="BimViewer.deselectAllIFCTypes()">${t('action.hideAll')}</button>
        </div>
        <div id="ifcFiltersList" class="modern-ifc-filters"></div>
      </div>
    `;
  },

  // ─────────────────────────────────────────────────────────────────
  // NOTIZEN
  // ─────────────────────────────────────────────────────────────────

  /**
   * Notizen & Prüfung — die Oberfläche zu `tags.js`.
   *
   * Der Modus ließ sich früher nur über die Taste `C` ein- und ausschalten,
   * war also faktisch unauffindbar.
   */
  getTagsContent() {
    return `
      <div class="section">
        <button id="tagsModeToggle" class="btn btn--block"
                onclick="Tags.toggleMode(); BimViewerUI.refreshTagsPanel();">
          <span>📍</span>
          <span id="tagsModeLabel">${t('action.start')}</span>
          <span id="tagsCount" class="count-badge">0</span>
        </button>
        <p class="hint">
          Im Notizmodus setzt ein <strong>Rechtsklick</strong> eine Notiz —
          auf Bauteilen, Punktwolken und Gaussian Splats. <strong>C</strong>
          schaltet den Modus um, <strong>Esc</strong> beendet ihn.
        </p>
      </div>

      <div class="section">
        <div class="section__label">${t('tags.filter')}</div>
        <div id="tagsFilterPills" class="pill-row"></div>
      </div>

      <div class="section">
        <div id="tagsList" class="scroll-box scroll-box--tall">${t('state.loading')}</div>
      </div>

      <div class="section">
        <div class="btn-group">
          <button class="btn btn--sm" onclick="BimViewerUI.tagsRefresh()">
            ${t('action.refresh')}
          </button>
          <button class="btn btn--sm" onclick="BimViewerUI.tagsExportJSON()">JSON</button>
          <button class="btn btn--sm" onclick="BimViewerUI.exportTagsAsBcf()">BCF</button>
        </div>
      </div>
    `;
  },

  /** Notizen als BCF-Paket ausgeben (bcf-export.js). */
  exportTagsAsBcf() {
    if (typeof ILEEN_BCF === 'undefined') {
      BimViewer.updateStatus('BCF-Export nicht geladen', 'warning');
      return;
    }
    const items = (window.Tags && Tags.items) || [];
    if (!items.length) {
      BimViewer.updateStatus('Keine Notizen zum Exportieren', 'warning');
      return;
    }
    ILEEN_BCF.exportTags(items);
  },

  /**
   * Aktualisiert Notizliste und Modusschalter im Notizen-Panel.
   *
   * Gezeichnet wird von `tagsRefresh` (unten in dieser Datei): dort liegt die
   * Liste mit Filterpillen, Anhängen und Löschen.
   */
  refreshTagsPanel() {
    if (this.tagsRefresh) this.tagsRefresh();
  },

  // ─────────────────────────────────────────────────────────────────
  // EINSTELLUNGEN
  // ─────────────────────────────────────────────────────────────────

  getLightingContent() {
    const jetzt = new Date();
    const stunde = (window.BimViewer && BimViewer.lighting && BimViewer.lighting.stunde !== null &&
                    BimViewer.lighting.stunde !== undefined)
      ? BimViewer.lighting.stunde
      : jetzt.getHours() + jetzt.getMinutes() / 60;
    const format = (h) => String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.round((h % 1) * 60)).padStart(2, '0');
    return `
      <div class="slider-row">
        <span class="slider-row__label">☀️ Uhrzeit</span>
        <input type="range" id="lightingHour" class="slider" min="0" max="24" step="0.25" value="${stunde.toFixed(2)}">
        <span id="lightingHourValue" class="slider-row__value">${format(stunde)}</span>
      </div>
      <div class="row">
        <span class="row__label">Schatten</span>
        <label class="switch">
          <input type="checkbox" id="toggleShadows" checked>
          <span class="switch__track"></span>
        </label>
      </div>
      <p class="hint">Sonnenstand des heutigen Tages am Ort der Kamera.</p>
    `;
  },

  getSettingsContent() {
    const language = window.ILeenI18n ? ILeenI18n.getLanguage() : 'de';
    const hatToken = !!(window.BimViewer && BimViewer.getIonToken && BimViewer.getIonToken());

    return `
      <div class="section">
        <div class="section__label">${t('group.language')}</div>
        <div class="field">
          <label class="field__label" for="uiLanguageSelect">${t('language.label')}</label>
          <select id="uiLanguageSelect" class="select"
                  onchange="ILeenI18n.setLanguage(this.value)">
            <option value="de"${language === 'de' ? ' selected' : ''}>${t('language.de')}</option>
            <option value="en"${language === 'en' ? ' selected' : ''}>${t('language.en')}</option>
          </select>
        </div>
      </div>

      <!--
        Beleuchtung: Sonnenstand und Schatten werden einmal eingestellt und
        bleiben dann stehen — das ist eine Einstellung der Szene, kein Handgriff
        beim Betrachten.
      -->
      <div class="section">
        <div class="section__label">${t('group.lighting')}</div>
        ${this.getLightingContent()}
      </div>

      <div class="section">
        <div class="section__label">Cesium ion</div>
        <div class="field">
          <label class="field__label" for="ionTokenInput">Zugriffsschlüssel</label>
          <div class="input-row">
            <input id="ionTokenInput" type="password" class="input" autocomplete="off"
                   placeholder="${hatToken ? 'gesetzt' : 'nicht gesetzt'}">
            <button id="ionTokenSave" class="btn btn--icon" title="Speichern">✓</button>
          </div>
        </div>
        <p class="hint">Gilt nach dem Neuladen der Seite für Gelände, Luftbild und ion-Assets.</p>
      </div>

      <!-- Verborgene Anker für nav-hud.js / core.js (Walk- und Flugmodus) -->
      <div aria-hidden="true" style="display:none;">
        <button id="toggleWalkMode" onclick="BimViewer.toggleWalkMode('walk')"></button>
        <button id="toggleFlyMode" onclick="BimViewer.toggleWalkMode('fly')"></button>
        <div id="walkModeControls">
          <div id="walkHeightGroup">
            <span id="walkHeightValue">1.8 m</span>
            <input type="range" id="walkHeightSlider" min="0.1" max="50.0" step="0.1" value="1.8" oninput="BimViewer.setWalkHeight(this.value)">
          </div>
          <span id="walkZOffsetValue">0.0 m</span>
          <input type="range" id="walkZOffsetSlider" min="-20.0" max="100.0" step="0.5" value="0.0" oninput="BimViewer.setWalkZOffset(this.value)">
          <span id="walkSpeedValue">7 m/s</span>
          <button id="walkSpeedBtnRamp" onclick="BimViewer.setWalkSpeedLevel(-1)" title="Stufe 0 — beschleunigt bis 200 m/s">0</button>
          ${[1,3,7,20,60,200].map((v,i) => `<button id="walkSpeedBtn${i}" onclick="BimViewer.setWalkSpeedLevel(${i})" title="${v} m/s">${i+1}</button>`).join('')}
        </div>
        <button id="toggleVR" onclick="BimViewer.toggleVR()"></button>
      </div>

      <div class="section">
        <div class="section__label">Darstellung</div>
        <div class="field">
          <label class="field__label" for="performancePreset">Stufe</label>
          <select id="performancePreset" class="select">
            <option value="PERFORMANCE">Performance</option>
            <option value="BALANCED" selected>Balanced</option>
            <option value="QUALITY">Quality</option>
            <option value="ULTRA">Ultra</option>
          </select>
        </div>

        <div class="row">
          <span class="row__label">🌐 Globus durchsichtig</span>
          <label class="switch">
            <input type="checkbox" id="toggleGlobeTransparency">
            <span class="switch__track"></span>
          </label>
        </div>
        <div id="globeTransparencyControls" class="slider-row" hidden>
          <span class="slider-row__label">Alpha</span>
          <input type="range" id="globeAlphaSlider" class="slider" min="0" max="1" step="0.1" value="0.5">
          <span class="slider-row__value" id="globeAlphaValue">50%</span>
        </div>

        <div class="row">
          <span class="row__label">✨ FXAA</span>
          <label class="switch">
            <input type="checkbox" id="toggleFXAA" checked>
            <span class="switch__track"></span>
          </label>
        </div>
        <div class="row">
          <span class="row__label">🎨 PBR-Tonwerte</span>
          <label class="switch">
            <input type="checkbox" id="toggleToneMapper" checked>
            <span class="switch__track"></span>
          </label>
        </div>
        <div class="row">
          <span class="row__label">🌑 Umgebungsverdeckung (SSAO)</span>
          <label class="switch">
            <input type="checkbox" id="toggleAO">
            <span class="switch__track"></span>
          </label>
        </div>
        <div id="aoControls" hidden>
          <div class="slider-row">
            <span class="slider-row__label">Stärke</span>
            <input type="range" id="aoIntensitySlider" class="slider" min="0.5" max="10" step="0.1" value="3.0">
            <span class="slider-row__value" id="aoIntensityValue">3.0</span>
          </div>
          <div class="slider-row">
            <span class="slider-row__label">Bias</span>
            <input type="range" id="aoBiasSlider" class="slider" min="0" max="1" step="0.01" value="0.1">
            <span class="slider-row__value" id="aoBiasValue">0.10</span>
          </div>
        </div>
        <div class="row">
          <span class="row__label">🟩 Kachelhüllen</span>
          <label class="switch">
            <input type="checkbox" id="toggleTileBoundingBoxes">
            <span class="switch__track"></span>
          </label>
        </div>
      </div>

      <div class="section">
        <div class="section__label">Kamera</div>
        <div class="slider-row">
          <span class="slider-row__label">🔭 Öffnungswinkel</span>
          <input type="range" id="fovSlider" class="slider" min="20" max="120" step="1" value="60"
                 oninput="BimViewer.setFieldOfView(parseFloat(this.value))">
          <span class="slider-row__value" id="fovValue">60°</span>
        </div>
      </div>
    `;
  },

  getAboutContent() {
    return `
      <div class="section">
        <div class="section__label">iLEEN</div>
        <p class="hint">
          Viewer, Statik und Bauantrag am digitalen Gebäudemodell —
          BIM-Labor der Hochschule Mainz.
        </p>
      </div>

      <div class="section">
        <div class="section__label">Tasten</div>
        <div class="row"><span class="row__label">Seitenleiste ein/aus</span><span class="row__value">M</span></div>
        <div class="row"><span class="row__label">Bauteile ausblenden · alle zurück</span><span class="row__value">H · ⇧H</span></div>
        <div class="row"><span class="row__label">Notizmodus</span><span class="row__value">C</span></div>
        <div class="row"><span class="row__label">Fliegen · Gehen</span><span class="row__value">F · ⇧F</span></div>
        <div class="row"><span class="row__label">Nach Norden ausrichten</span><span class="row__value">N</span></div>
        <div class="row"><span class="row__label">Bildrate</span><span class="row__value">Strg/⌘ + Alt + F</span></div>
      </div>

      <div class="section">
        <div class="section__label">Lizenz</div>
        <p class="hint">
          © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0.
          Nutzung für nichtkommerzielle Zwecke, Forschung und Lehre frei;
          alles Weitere nach Absprache. Verwendete Fremdsoftware, allen voran
          CesiumJS (Apache-2.0), steht in THIRD-PARTY-NOTICES.md.
        </p>
      </div>
    `;
  },

  /**
   * Breite des Sidebar-Panels per Ziehgriff einstellbar machen. Delegiert
   * auf `document`, damit ein Neuaufbau des Panels (Sprachwechsel) den
   * Ziehgriff nicht neu verkabeln muss — nur das Handle-Element selbst wird
   * dabei neu erzeugt, der Listener bleibt gültig.
   */
  initSidebarResize() {
    const MIN_WIDTH = 260;
    const MAX_WIDTH = 640;
    const STORAGE_KEY = 'ileen_sidebar_width';

    const applyWidth = (width) => {
      const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
      document.documentElement.style.setProperty('--sidebar-width', clamped + 'px');
      return clamped;
    };

    let saved = NaN;
    try { saved = parseInt(localStorage.getItem(STORAGE_KEY), 10); } catch (e) { /* privates Fenster */ }
    if (!Number.isNaN(saved)) applyWidth(saved);

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    document.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.sidebar-resize-handle');
      if (!handle) return;
      dragging = true;
      startX = e.clientX;
      startWidth = document.getElementById('sidebarPanel')?.getBoundingClientRect().width || MIN_WIDTH;
      handle.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      applyWidth(startWidth + (e.clientX - startX));
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.querySelector('.sidebar-resize-handle.dragging')?.classList.remove('dragging');
      const width = document.getElementById('sidebarPanel')?.getBoundingClientRect().width;
      try {
        if (width) localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
      } catch (err) { /* privates Fenster */ }
    });
  },

  // ─────────────────────────────────────────────────────────────────
  // EREIGNISSE
  // ─────────────────────────────────────────────────────────────────

  initEventHandlers() {
    const an = (id, ereignis, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ereignis, handler);
      return el;
    };

    // Einmalig: Dinge, die am Dokument hängen und einen Neuaufbau überstehen
    if (!this._dokumentHakenAktiv) {
      this._dokumentHakenAktiv = true;

      // Breite des Sidebar-Panels per Ziehgriff
      this.initSidebarResize();

      document.getElementById('sidebarToggle')?.addEventListener('click', () => this.toggleSidebar(false));

      document.addEventListener('keydown', (e) => {
        if (e.key !== 'm' && e.key !== 'M') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const ziel = e.target;
        if (ziel && (ziel.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ziel.tagName))) return;
        e.preventDefault();
        this.toggleSidebar();
      });
    }

    // ── Cesium Ion: ein Feld für Name und ID ──────────────────────────
    //
    // Die Vorschlagsliste liefert Einträge der Form „Name (ID: 4587934)".
    // Eingetippt werden darf auch nur die Zahl. Beides läuft hier durch
    // dieselbe Auswertung: die letzte Zahlengruppe im Text ist die Asset-ID.
    const loadIonAsset = () => {
      const input = document.getElementById('ionAssetInput');
      const raw = (input?.value || '').trim();
      const match = raw.match(/(\d+)\s*\)?\s*$/);
      const assetId = match ? parseInt(match[1], 10) : NaN;

      if (!assetId) {
        BimViewer.updateStatus(t('models.ionInvalid'), 'error');
        return;
      }
      const name = this._ionAssetNames?.get(assetId) || `Ion Asset ${assetId}`;
      BimViewer.loadSelectedAsset(assetId, name);
      input.value = '';
    };
    an('loadIonAsset', 'click', loadIonAsset);
    an('ionAssetInput', 'keydown', (e) => {
      if (e.key === 'Enter') loadIonAsset();
    });

    // ── Self-hosted Backend ───────────────────────────────────────────
    const backendUrlInput = document.getElementById('backendUrlInput');
    if (backendUrlInput && window.BimViewer) backendUrlInput.value = BimViewer.getBackendUrl();

    an('backendRefresh', 'click', () => {
      BimViewer.setBackendUrl(document.getElementById('backendUrlInput')?.value);
      BimViewerUI.refreshBackendAssets();
    });
    backendUrlInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        BimViewer.setBackendUrl(backendUrlInput.value);
        BimViewerUI.refreshBackendAssets();
      }
    });

    const loadBackendByInput = () => {
      const input = document.getElementById('backendJobInput');
      const value = (input?.value || '').trim();
      if (!value) {
        BimViewer.updateStatus('Bitte Job-ID oder tileset.json-URL eingeben', 'error');
        return;
      }
      // Vollständige URL direkt laden, alles andere als Job-ID behandeln
      if (/^https?:\/\//i.test(value)) {
        BimViewer.loadBackendAssetByUrl(value);
      } else {
        BimViewer.loadBackendAsset(value);
      }
      input.value = '';
    };
    an('backendSearch', 'input', (e) => {
      BimViewerUI.backendSuche = e.target.value;
      BimViewerUI.renderBackendAssets();
    });

    an('loadBackendByInput', 'click', loadBackendByInput);
    an('backendJobInput', 'keydown', (e) => {
      if (e.key === 'Enter') loadBackendByInput();
    });

    // Beim Aufbau einmal automatisch verbinden, wenn eine URL vorliegt
    if (window.BimViewer && BimViewer.getBackendUrl()) {
      setTimeout(() => BimViewerUI.refreshBackendAssets(), 800);
    }

    // ── Sichtbarkeit ──────────────────────────────────────────────────
    an('toggleHideMode', 'click', () => BimViewer.toggleHideMode());
    an('showAllHidden', 'click', () => BimViewer.showAllHidden());
    an('toggleUndergroundView', 'change', (e) => BimViewer.toggleUndergroundView(e.target.checked));
    an('toggleNullebene', 'change', (e) => BimViewer.Untergrund?.nullebeneSetzen(e.target.checked));
    an('toggleDurchblick', 'change', (e) => BimViewer.Untergrund?.durchblickSetzen(e.target.checked));

    // ── Weltkulisse ───────────────────────────────────────────────────
    const osm = an('toggleOSMBuildings', 'change', (e) => BimViewer.toggleOSMBuildings(e.target.checked));
    if (osm && window.BimViewer) osm.checked = !!BimViewer.osmBuildings.enabled;

    const google = an('toggleGoogle3DTiles', 'change', async (e) => {
      await BimViewer.toggleGoogle3DTiles();

      // Sync checkbox to actual state (load guard or async failure may have diverged it)
      e.target.checked = !!BimViewer.googleTiles.enabled;

      const qualityRow = document.getElementById('googleTilesQualityRow');
      if (qualityRow) {
        qualityRow.style.display = BimViewer.googleTiles.enabled ? 'flex' : 'none';
      }
    });
    if (google && window.BimViewer) google.checked = !!BimViewer.googleTiles.enabled;

    // Amtliche Gebäudeebenen (RLP LoD2 …) — Schalter, wie die beiden Zeilen
    // darüber. `change` und nicht `click`: bei einem Kontrollkästchen ist der
    // Zustand erst im change-Ereignis gültig.
    an('tilesetLayersList', 'change', (e) => {
      const box = e.target.closest('[data-toggle-tileset]');
      if (!box || typeof LayerManager === 'undefined') return;
      const id = box.dataset.toggleTileset;
      if (box.checked) LayerManager.enableTileset(id);
      else LayerManager.disableTileset(id);
    });

    // Vektorkarte (vektorkacheln.js) — zeichnet und bindet ihre Zeilen selbst;
    // hier nur der Anstoß, sobald der Behälter im Markup steht.
    window.Vektorkacheln?.panelZeichnen();

    // ── Beleuchtung ───────────────────────────────────────────────────
    an('lightingHour', 'input', (e) => {
      const h = parseFloat(e.target.value);
      BimViewer.setLightingTime(h);
      const wert = document.getElementById('lightingHourValue');
      if (wert) wert.textContent = String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.round((h % 1) * 60)).padStart(2, '0');
    });
    an('toggleShadows', 'change', (e) => BimViewer.setShadows(e.target.checked));

    // ── Zugriffsschlüssel ─────────────────────────────────────────────
    an('ionTokenSave', 'click', () => {
      const feld = document.getElementById('ionTokenInput');
      const gesetzt = BimViewer.setIonToken(feld ? feld.value : '');
      if (feld) { feld.value = ''; feld.placeholder = gesetzt ? 'gesetzt' : 'nicht gesetzt'; }
      BimViewer.updateStatus(gesetzt ? 'ion-Token gespeichert — Seite neu laden' : 'ion-Token entfernt', 'success');
    });

    // ── Darstellung ───────────────────────────────────────────────────
    an('performancePreset', 'change', (e) => {
      const preset = CONFIG.performance.presets[e.target.value];
      if (preset) {
        BimViewer.applyPerformanceSettings(preset);
        // Merken: wer wegen seiner Grafikkarte heruntergestuft hat, will das
        // nicht bei jedem Start wiederholen (siehe Startvoreinstellung in
        // index.html).
        try { localStorage.setItem('ileen_performance_preset', e.target.value); } catch (err) { /* privat */ }
        BimViewer.updateStatus('Darstellung: ' + preset.name, 'success');
      }
    });
    if (window.BimViewer && BimViewer._currentPerformanceSettings) {
      const auswahl = document.getElementById('performancePreset');
      const schluessel = Object.keys(CONFIG.performance.presets)
        .find((k) => CONFIG.performance.presets[k] === BimViewer._currentPerformanceSettings);
      if (auswahl && schluessel) auswahl.value = schluessel;
    }

    an('toggleGlobeTransparency', 'change', (e) => {
      BimViewer.toggleGlobeTransparency(e.target.checked);
      const controls = document.getElementById('globeTransparencyControls');
      if (controls) controls.hidden = !e.target.checked;
    });
    an('globeAlphaSlider', 'input', (e) => {
      BimViewer.setGlobeTransparency(e.target.value);
      const wert = document.getElementById('globeAlphaValue');
      if (wert) wert.textContent = Math.round(e.target.value * 100) + '%';
    });

    an('toggleTileBoundingBoxes', 'change', () => {
      BimViewer.toggleTileBoundingBoxes();
    });

    an('toggleFXAA', 'change', function () {
      const fxaa = BimViewer.viewer?.scene.postProcessStages.fxaa;
      if (!fxaa) {
        this.checked = false;
        return;
      }
      fxaa.enabled = this.checked;
      BimViewer.updateStatus(this.checked ? 'FXAA enabled' : 'FXAA disabled', 'success');
    });

    // Tone Mapping
    an('toggleToneMapper', 'change', function () {
      const stufen = BimViewer.viewer?.scene.postProcessStages;
      if (!stufen) return;
      stufen.tonemapper = this.checked ? Cesium.Tonemapper.PBR_NEUTRAL : Cesium.Tonemapper.MODIFIED_REINHARD;
      BimViewer.viewer.scene.requestRender();
    });

    // Umgebungsverdeckung
    an('toggleAO', 'change', function () {
      const scene = BimViewer.viewer?.scene;
      const ao = scene && scene.postProcessStages.ambientOcclusion;
      if (!ao || !Cesium.PostProcessStageLibrary.isAmbientOcclusionSupported(scene)) {
        BimViewer.updateStatus('Umgebungsverdeckung wird nicht unterstützt', 'warning');
        this.checked = false;
        return;
      }
      ao.enabled = this.checked;
      const controls = document.getElementById('aoControls');
      if (controls) controls.hidden = !this.checked;
    });
    an('aoIntensitySlider', 'input', (e) => {
      const ao = BimViewer.viewer?.scene.postProcessStages.ambientOcclusion;
      if (ao) ao.uniforms.intensity = parseFloat(e.target.value);
      const wert = document.getElementById('aoIntensityValue');
      if (wert) wert.textContent = parseFloat(e.target.value).toFixed(1);
    });
    an('aoBiasSlider', 'input', (e) => {
      const ao = BimViewer.viewer?.scene.postProcessStages.ambientOcclusion;
      if (ao) ao.uniforms.bias = parseFloat(e.target.value);
      const wert = document.getElementById('aoBiasValue');
      if (wert) wert.textContent = parseFloat(e.target.value).toFixed(2);
    });
  },

  // ─────────────────────────────────────────────────────────────────
  // MODELL-LISTE
  // ─────────────────────────────────────────────────────────────────

  createAssetControls(assetId) {
    const container = document.getElementById('loadedAssetsList');
    const assetData = window.BimViewer && BimViewer.loadedAssets.get(String(assetId));
    if (!container || !assetData) return;

    container.querySelector('.modern-empty-state')?.remove();
    document.getElementById(`asset_${assetId}`)?.remove();

    const splat = assetData.tileset && assetData.tileset._isGaussianSplat;
    const symbol = assetData.isPointCloud ? '☁️' : splat ? '✨' : assetData.type === 'BACKEND' ? '🏢' : '🌐';
    // Baustufen gibt es nur an Bauteilen — eine Punktwolke hat keine.
    const stufen = (!assetData.isPointCloud && !splat)
      ? `<button class="modern-icon-btn" data-seq-asset="${assetId}"
                 onclick="BimViewer.toggleSequencing('${assetId}')"
                 title="Baustufen (4D über das stage-Merkmal)">🧱</button>`
      : '';

    // Ein Eintrag = eine Zeile. Alles zum Ausrichten (Deckkraft, Verschieben,
    // Drehen) liegt im Flyout, das seitlich neben dem Panel aufgeht.
    const assetDiv = document.createElement('div');
    assetDiv.className = 'modern-asset-item';
    assetDiv.id = `asset_${assetId}`;
    assetDiv.innerHTML = `
      <div class="modern-asset-header">
        <span class="modern-asset-name" title="${uiEsc(assetData.name)}">${symbol} ${uiEsc(assetData.name)}</span>
        <label class="ios-toggle asset-visibility" title="${t('asset.visibility')}">
          <input type="checkbox" ${assetData.visible !== false ? 'checked' : ''} onchange="BimViewer.toggleAssetVisibility('${assetId}')">
          <span class="ios-toggle-track"><span class="ios-toggle-thumb"></span></span>
        </label>
        <div class="modern-asset-controls">
          <button class="modern-icon-btn" onclick="BimViewer.zoomToAsset('${assetId}')" title="${t('action.flyTo')}">🎯</button>
          <button class="modern-icon-btn" data-tag-asset="${assetId}" onclick="typeof Tags !== 'undefined' && Tags.toggleMode('${assetId}')" title="${t('asset.tagMode')}">🏷️</button>
          ${stufen}
          <button class="modern-icon-btn" data-transform-asset="${assetId}"
                  onclick="BimViewerUI.toggleAssetTransform('${assetId}', this)"
                  title="${t('asset.transform')}">✥</button>
          <button class="modern-icon-btn modern-icon-btn-danger" onclick="BimViewer.unloadAsset('${assetId}')" title="${t('action.remove')}">✕</button>
        </div>
      </div>
    `;
    container.appendChild(assetDiv);
    this.updateLoadedAssetsCount();
  },

  updateLoadedAssetsCount() {
    const anzahl = window.BimViewer ? BimViewer.loadedAssets.size : 0;
    const badge = document.getElementById('loadedAssetsCount');
    if (badge) badge.textContent = anzahl;
    const liste = document.getElementById('loadedAssetsList');
    if (liste && !anzahl && !liste.querySelector('.modern-empty-state')) {
      liste.innerHTML = `<div class="modern-empty-state">${t('state.noAssets')}</div>`;
    }
  },

  // =====================================================================
  // ASSET-FLYOUT — Deckkraft, Verschieben, Drehen
  // =====================================================================

  /**
   * Öffnet oder schließt das Flyout zu einem Modell.
   *
   * Das Flyout hängt am `body` und wird neben die Seitenleiste gesetzt, nicht
   * in die Liste hinein: dadurch bleibt die Modell-Liste einzeilig, und der
   * Inhalt des Flyouts kann so hoch werden, wie er will, ohne das Panel zu
   * strecken. Es gibt genau eines — ein zweiter Klick auf ein anderes Modell
   * zieht es dorthin um.
   */
  toggleAssetTransform(assetId, anchorEl) {
    const open = this._transformAssetId === assetId.toString();
    if (open) {
      this.closeAssetTransform();
      return;
    }
    this.openAssetTransform(assetId, anchorEl);
  },

  openAssetTransform(assetId, anchorEl) {
    const assetData = BimViewer.loadedAssets.get(assetId.toString());
    if (!assetData || !assetData.tileset) return;

    let flyout = document.getElementById('assetTransformFlyout');
    if (!flyout) {
      flyout = document.createElement('div');
      flyout.id = 'assetTransformFlyout';
      flyout.className = 'flyout';
      document.body.appendChild(flyout);

      // Klick daneben und Esc schließen — sonst bleibt das Flyout stehen,
      // während man längst am Modell weiterarbeitet.
      document.addEventListener('mousedown', (event) => {
        if (!this._transformAssetId) return;
        if (event.target.closest('#assetTransformFlyout')) return;
        if (event.target.closest('[data-transform-asset]')) return;
        this.closeAssetTransform();
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this._transformAssetId) this.closeAssetTransform();
      });
      window.addEventListener('resize', () => this.closeAssetTransform());
    }

    this._transformAssetId = assetId.toString();
    flyout.innerHTML = this.getAssetTransformContent(assetId, assetData);
    flyout.classList.add('is-open');

    document.querySelectorAll('[data-transform-asset]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.transformAsset === this._transformAssetId);
    });

    this._positionAssetTransform(flyout, anchorEl);
  },

  closeAssetTransform() {
    this._transformAssetId = null;
    const flyout = document.getElementById('assetTransformFlyout');
    if (flyout) flyout.classList.remove('is-open');
    document.querySelectorAll('[data-transform-asset]').forEach((btn) => {
      btn.classList.remove('is-active');
    });
  },

  /**
   * Setzt das Flyout rechts neben die Seitenleiste, auf Höhe der Zeile.
   *
   * Die Höhe wird an das Fenster angelegt: sonst ragt ein Flyout, das weit
   * unten geöffnet wird, unter den Bildschirmrand — und genau das Scrollen
   * wäre wieder da, nur woanders.
   */
  _positionAssetTransform(flyout, anchorEl) {
    const panel = document.getElementById('sidebarPanel');
    const anchor = anchorEl?.getBoundingClientRect();
    const margin = 8;

    const left = panel
      ? panel.getBoundingClientRect().right + margin
      : margin;

    // Vor dem Messen sichtbar machen, sonst ist die Höhe 0.
    flyout.style.visibility = 'hidden';
    flyout.style.left = `${left}px`;
    flyout.style.top = '0px';
    const height = flyout.offsetHeight;

    const wanted = anchor ? anchor.top - 6 : margin;
    const top = Math.max(margin, Math.min(wanted, window.innerHeight - height - margin));

    flyout.style.top = `${top}px`;
    flyout.style.visibility = '';
  },

  /** Inhalt des Flyouts für ein 3D-Tiles-Modell. */
  getAssetTransformContent(assetId, assetData) {
    const head = `
      <div class="flyout__header">
        <span class="flyout__title" title="${uiEsc(assetData.name)}">${uiEsc(assetData.name)}</span>
        <button class="btn btn--sm btn--icon btn--ghost"
                onclick="BimViewerUI.closeAssetTransform()" title="${t('action.close')}">✕</button>
      </div>
      <div class="flyout__body">
        <div class="slider-row">
          <span class="slider-row__label">${t('asset.opacity')}</span>
          <input type="range" class="slider" min="0" max="1" step="0.05" value="${assetData.opacity ?? 1}"
                 oninput="BimViewer.updateAssetOpacity('${assetId}', this.value); document.getElementById('opacityValue_${assetId}').textContent=Math.round(this.value*100)+'%'">
          <span class="slider-row__value" id="opacityValue_${assetId}">${Math.round((assetData.opacity ?? 1) * 100)}%</span>
        </div>`;

    const offset = this._assetOffsets(assetData);

    // Ein Regler-Paar je Achse: Regler zum Suchen, Zahlenfeld zum Festlegen.
    const axis = (key, label, unit, min, max, step, value, decimals) => `
      <div class="axis-row">
        <span class="axis-row__label">${label}</span>
        <input type="range" class="slider" id="${key}_slider_${assetId}"
               min="${min}" max="${max}" step="${step}" value="${value}"
               oninput="BimViewerUI.updateAssetTransform('${assetId}', '${key}', this.value)">
        <input type="number" class="input input--num" id="${key}_input_${assetId}"
               min="${min}" max="${max}" step="${step}" value="${value.toFixed(decimals)}"
               onchange="BimViewerUI.setAssetTransformFromInput('${assetId}', '${key}', this.value)">
        <span class="axis-row__unit">${unit}</span>
        <button class="btn btn--sm btn--icon btn--ghost"
                onclick="BimViewerUI.setAssetTransformFromInput('${assetId}', '${key}', 0)"
                title="${t('action.reset')}">↺</button>
      </div>`;

    return head + `
        <div class="section__label" style="margin-top:12px;">${t('asset.move')}</div>
        ${axis('east',  'X · ' + t('asset.east'),  'm', -100, 100, 0.05, offset.east, 2)}
        ${axis('north', 'Y · ' + t('asset.north'), 'm', -100, 100, 0.05, offset.north, 2)}
        ${axis('up',    'Z · ' + t('asset.up'),    'm', -50, 50, 0.01, offset.up, 2)}

        <div class="section__label" style="margin-top:12px;">${t('asset.rotation')}</div>
        ${axis('heading', 'Z', '°', 0, 360, 1, offset.heading, 0)}

        <button class="btn btn--block btn--sm" style="margin-top:12px;"
                onclick="BimViewerUI.resetAssetTransform('${assetId}')">${t('asset.resetAll')}</button>
      </div>`;
  },

  /** Aktuelle Verschiebung und Drehung eines 3D-Tiles-Modells. */
  _assetOffsets(assetData) {
    const tileset = assetData && assetData.tileset;
    const move = (tileset && BimViewer.translation?.individualOffsets.get(tileset)) || { east: 0, north: 0 };
    return {
      east: move.east || 0,
      north: move.north || 0,
      up: (tileset && BimViewer.zOffset?.individualOffsets.get(tileset)) || 0,
      heading: (tileset && BimViewer.rotation?.individualHeadings.get(tileset)) || 0,
    };
  },

  /** Regler bewegt: Zahlenfeld nachziehen und die Szene sofort aktualisieren. */
  updateAssetTransform(assetId, axis, value) {
    const numeric = parseFloat(value);
    const input = document.getElementById(`${axis}_input_${assetId}`);
    if (input) input.value = axis === 'heading' ? Math.round(numeric) : numeric.toFixed(2);
    this._applyAssetTransform(assetId, axis, numeric, true);
  },

  /** Zahlenfeld geändert (oder Zurücksetzen geklickt): Regler nachziehen. */
  setAssetTransformFromInput(assetId, axis, value) {
    const numeric = parseFloat(value) || 0;
    const slider = document.getElementById(`${axis}_slider_${assetId}`);
    const input = document.getElementById(`${axis}_input_${assetId}`);
    if (slider) slider.value = numeric;
    if (input) input.value = axis === 'heading' ? Math.round(numeric) : numeric.toFixed(2);
    this._applyAssetTransform(assetId, axis, numeric, false);
  },

  _applyAssetTransform(assetId, axis, value, isLiveUpdate) {
    const apply = () => {
      if (axis === 'heading') {
        BimViewer.applyIndividualRotation(assetId, value, isLiveUpdate);
        return;
      }
      if (axis === 'up') {
        BimViewer.applyIndividualZOffset(assetId, value, isLiveUpdate);
        return;
      }
      // east / north — beide Werte gehen zusammen in eine Verschiebung.
      const assetData = BimViewer.loadedAssets.get(assetId.toString());
      const current = assetData ? this._assetOffsets(assetData) : { east: 0, north: 0 };
      const east = axis === 'east' ? value : current.east;
      const north = axis === 'north' ? value : current.north;
      BimViewer.applyIndividualTranslation(assetId, east, north, isLiveUpdate);
    };

    if (!isLiveUpdate) { apply(); return; }

    // Beim Ziehen am Regler nur einmal je Bild rechnen. Ohne die Bremse
    // stapeln sich mehrere Matrixaufbauten pro Bild — sichtbar als Ruckeln,
    // sobald mehrere Modelle geladen sind.
    if (this._transformFrame) cancelAnimationFrame(this._transformFrame);
    this._transformFrame = requestAnimationFrame(apply);
  },

  /** Setzt Verschiebung und Drehung eines Modells auf den Ausgangszustand. */
  resetAssetTransform(assetId) {
    BimViewer.resetAssetTranslation(assetId);
    BimViewer.resetAssetZOffset(assetId);
    BimViewer.resetAssetRotation(assetId);

    for (const axis of ['east', 'north', 'up', 'heading']) {
      const slider = document.getElementById(`${axis}_slider_${assetId}`);
      const input = document.getElementById(`${axis}_input_${assetId}`);
      if (slider) slider.value = 0;
      if (input) input.value = axis === 'heading' ? '0' : '0.00';
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // ION-VORSCHLÄGE
  // ─────────────────────────────────────────────────────────────────

  /**
   * Vorschlagsliste für das Ion-Feld füllen.
   *
   * Die Assets des Kontos landen als `<option>` in einer `<datalist>`: die
   * Vorschläge erscheinen beim Tippen und beanspruchen im geschlossenen
   * Zustand keine Panelhöhe.
   *
   * `_ionAssetNames` hält daneben die Zuordnung ID → Name. Ohne sie stünde in
   * der Liste der geladenen Modelle „Ion Asset 4587934" statt „Campus_HSMZ" —
   * denn aus dem Eingabefeld kommt am Ende nur die Zahl zurück.
   */
  async autoLoadIonAssets() {
    const statusEl = document.getElementById('ionAssetsStatus');
    const listEl = document.getElementById('ionAssetOptions');

    if (!listEl) {
      // Das Panel wird von createModernToolbar() gebaut; beim Start kann der
      // Aufruf davor liegen.
      setTimeout(() => this.autoLoadIonAssets(), 1000);
      return;
    }

    if (!BimViewer.getIonToken()) {
      if (statusEl) statusEl.textContent = 'Kein ion-Token — unter Einstellungen eintragen';
      return;
    }

    this._ionAssetNames = this._ionAssetNames || new Map();

    try {
      const allAssets = await BimViewer.fetchAvailableAssets();
      allAssets
        .filter(asset => VALID_ASSET_IDS.has(asset.id))
        .forEach(a => this._ionAssetNames.set(a.id, a.name));
      this.fillIonSuggestions();
      console.log(`${this._ionAssetNames.size} Ion-Assets in der Vorschlagsliste`);

    } catch (error) {
      console.error('Failed to load Ion assets:', error);
      if (statusEl) statusEl.textContent = t('models.ionFailed');
    }
  },

  /**
   * Vorschläge und Statuszeile aus `_ionAssetNames` zeichnen.
   *
   * Getrennt von `autoLoadIonAssets()`, weil ein Sprachwechsel die Panels neu
   * aufbaut: die `<datalist>` ist danach wieder leer, das Ion-Konto aber
   * unverändert. Ein zweiter Netzzugriff dafür wäre reine Verschwendung.
   */
  fillIonSuggestions() {
    const listEl = document.getElementById('ionAssetOptions');
    const statusEl = document.getElementById('ionAssetsStatus');
    if (!listEl || !this._ionAssetNames?.size) return;

    listEl.innerHTML = [...this._ionAssetNames]
      .map(([id, name]) => `<option value="${uiEsc(name)} (ID: ${id})"></option>`)
      .join('');
    if (statusEl) statusEl.textContent = t('models.ionReady', { n: this._ionAssetNames.size });
  }
};

// Die Viewer-Bereiche melden sich beim Laden dieser Datei an — nicht erst in
// `init()`. Sonst gäbe es den Bereich „ifc" noch nicht, wenn ein Werkzeug
// gleich darauf `gruppeAnmelden('ifc', …)` ruft, und die Gruppe fiele wortlos
// heraus. Gebaut wird trotzdem erst in `init()`: `_leisteNeuBauen()` tut vor
// dem ersten Aufbau nichts.
BimViewerUI._viewerBereicheAnmelden();


window.BimViewerUI = BimViewerUI;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => BimViewerUI.init());
} else {
  setTimeout(() => BimViewerUI.init(), 0);
}

// =====================================================================
// NOTIZEN — Liste, Filter, Darstellung (spricht mit window.Tags aus tags.js)
// =====================================================================

(function () {
  const tagsFilter = { type: null, kind: null, status: null };

  const KIND_ICON = { ifc: '🟦', splat: '✨', b3dm: '📦', free: '📍' };

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderFilters() {
    const el = document.getElementById('tagsFilterPills');
    if (!el || typeof Tags === 'undefined') return;
    const sections = [
      { axis: 'type',   label: t('tags.type'),   values: Tags.TYPES },
      { axis: 'kind',   label: t('tags.target'), values: Tags.KINDS },
      { axis: 'status', label: t('tags.status'), values: Tags.STATUS }
    ];
    el.innerHTML = sections.map(sec => {
      const pills = sec.values.map(v => {
        const active = tagsFilter[sec.axis] === v ? ' is-active' : '';
        return `<span class="pill tags-pill${active}" data-axis="${sec.axis}" data-value="${v}">${v}</span>`;
      }).join('');
      return `<div class="pill-group">
                <span class="pill-group__label">${sec.label}</span>
                ${pills}
              </div>`;
    }).join('');

    el.querySelectorAll('.tags-pill').forEach(p => {
      p.onclick = () => {
        const axis = p.dataset.axis, value = p.dataset.value;
        tagsFilter[axis] = (tagsFilter[axis] === value) ? null : value;
        renderFilters();
        renderList();
      };
    });
  }

  function applyFilter(items) {
    return items.filter(t =>
      (!tagsFilter.type   || t.type === tagsFilter.type) &&
      (!tagsFilter.kind   || t.target?.kind === tagsFilter.kind) &&
      (!tagsFilter.status || t.payload?.status === tagsFilter.status)
    );
  }

  function renderList() {
    const el = document.getElementById('tagsList');
    if (!el || typeof Tags === 'undefined') return;
    const all = Tags.items || [];
    const filtered = applyFilter(all);

    const countEl = document.getElementById('tagsCount');
    if (countEl) countEl.textContent = String(all.length);

    if (!filtered.length) {
      const msg = !all.length ? t('tags.emptyAll') : t('tags.emptyFilter');
      el.innerHTML = `<div class="modern-empty-state">${msg}</div>`;
      return;
    }

    el.innerHTML = filtered.map(t => {
      const icon = KIND_ICON[t.target?.kind] || '📍';
      const title = escapeHtml(t.payload?.title || '(ohne Titel)');
      const body  = escapeHtml((t.payload?.body || '').slice(0, 80) +
                               ((t.payload?.body || '').length > 80 ? '…' : ''));
      const meta  = [t.type, t.payload?.status, t.payload?.priority].filter(Boolean).map(escapeHtml).join(' · ');
      const guidLine = t.target?.ifcGuid
        ? `<div class="tag-card__guid">GUID ${escapeHtml(t.target.ifcGuid.slice(0,16))}…</div>` : '';
      const atts = t.payload?.attachments || [];
      const attLine = atts.length
        ? `<div class="tag-card__atts" data-tag-id="${t.id}">
            ${atts.map(a => {
              const aIcon = (a.type || '').startsWith('image/') ? '🖼️'
                          : (a.type === 'application/pdf' ? '📄' : '📎');
              return `<button class="btn btn--sm tags-att" data-att-id="${a.id}" data-att-name="${escapeHtml(a.name)}" data-att-type="${escapeHtml(a.type || '')}" title="${escapeHtml(a.name)}">
                ${aIcon} ${escapeHtml(a.name.length > 18 ? a.name.slice(0,16) + '…' : a.name)}
              </button>`;
            }).join('')}
          </div>` : '';
      return `
        <div class="tag-card">
          <div class="tag-card__head">
            <span>${icon}</span>
            <span class="tag-card__title">${title}</span>
            <button class="btn btn--sm btn--icon btn--ghost tags-goto" data-id="${t.id}" title="Hinfliegen">🎯</button>
            <button class="btn btn--sm btn--icon btn--ghost tags-del" data-id="${t.id}" title="Löschen">🗑</button>
          </div>
          ${body ? `<div class="tag-card__body">${body}</div>` : ''}
          ${guidLine}
          ${attLine}
          <div class="tag-card__meta">${meta} · ${fmtDate(t.createdAt)}</div>
        </div>
      `;
    }).join('');

    el.querySelectorAll('.tags-goto').forEach(b => {
      b.onclick = () => Tags.flyTo(b.dataset.id);
    });
    el.querySelectorAll('.tags-del').forEach(b => {
      b.onclick = async () => {
        if (!confirm('Diese Notiz löschen?')) return;
        await Tags.remove(b.dataset.id);
        renderList();
      };
    });
    el.querySelectorAll('.tags-att').forEach(b => {
      b.onclick = async () => {
        const url = await Tags.attachments.url(b.dataset.attId);
        if (!url) {
          alert('Anhang nicht in IndexedDB gefunden: ' + b.dataset.attName);
          return;
        }
        // Open in new tab; browser handles image/pdf preview natively.
        window.open(url, '_blank', 'noopener');
        // Object URL stays valid until tab closed; revoke after a delay.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      };
    });
  }

  function updateModeButton() {
    const btn = document.getElementById('tagsModeToggle');
    const lbl = document.getElementById('tagsModeLabel');
    if (!btn || !lbl || typeof Tags === 'undefined') return;
    // Zustand über die Klasse, nicht über Inline-Stile: das Aussehen des
    // aktiven Werkzeugs steht einmal im Design-System.
    lbl.textContent = Tags.active ? t('action.stop') : t('action.start');
    btn.classList.toggle('is-active', !!Tags.active);
  }

  function exportJSON() {
    if (typeof Tags === 'undefined') return;
    const blob = new Blob([JSON.stringify(Tags.items, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `tags_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // Öffentliche Haken an BimViewerUI
  window.BimViewerUI = window.BimViewerUI || {};
  BimViewerUI.tagsRefresh           = function () { renderFilters(); renderList(); updateModeButton(); };
  BimViewerUI.tagsRenderList        = renderList;
  BimViewerUI.tagsRenderFilters     = renderFilters;
  BimViewerUI.tagsUpdateModeButton  = updateModeButton;
  BimViewerUI.tagsExportJSON        = exportJSON;

  document.addEventListener('tags:changed',  () => BimViewerUI.tagsRefresh());
  document.addEventListener('tags:mode-on',  updateModeButton);
  document.addEventListener('tags:mode-off', updateModeButton);
})();
