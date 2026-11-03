/**
 * Materialmodus — Texturen auf Bauteile im Modell ziehen.
 *
 * Der Zuordnungsassistent (`materials.js`) ist eine Liste von Stilnamen. Das
 * genügt, um eine Zuordnung zu korrigieren, und genügt nicht, um sie zu
 * *finden*: „Metall Fassade MUSTER_1" sagt niemandem, welche Fläche im Bau das
 * ist. Hier läuft es umgekehrt — man sieht das Bauteil und zieht die Textur
 * darauf.
 *
 * Der fehlende Schritt dazwischen ist die Brücke Bauteil → Stil. Die Batch
 * Table der Tiles führt sie nicht (texturiert wird eine Ebene tiefer, je
 * Material-Chunk innerhalb eines Bauteils), deshalb liefert das Backend sie
 * als eigenen Index: `GET /assets/{job}/materials/index`, einmal geladen und
 * im Speicher gehalten. Beim Ziehen über die Szene muss unter dem Zeiger
 * sofort feststehen, welches Material dort liegt — eine Rückfrage je
 * Mausbewegung wäre nicht bedienbar.
 *
 * **Zugeordnet wird immer dem Material, nie dem einzelnen Bauteil.** Wer auf
 * eine Wand zieht, texturiert jede Fläche desselben Stils im Modell. Das ist
 * keine Vereinfachung, sondern die Ebene, auf der die Texturierung im Tiling
 * stattfindet; das Panel sagt es an jeder Stelle dazu (die Bauteilzahl steht
 * an jedem Material).
 *
 * Was der Modus **nicht** kann: die Textur sofort zeigen. Sie steckt in den
 * B3DM-Tiles und erscheint erst nach dem Neu-Tiling. Sichtbar wird die
 * Zuordnung stattdessen im Panel — Kachel und Häkchen an der Materialzeile.
 *
 * Aufruf aus index.html: `MaterialModus.umschalten(asset, viewer, layers)`.
 */
'use strict';

const MaterialModus = (() => {

  const AUTO = '__auto__';
  const KEINE = '__keine__';
  // Eine Zuordnung darf statt einer Texturkategorie eine Volltonfarbe sein.
  // Das Backend erkennt sie am Präfix und tauscht dann nur die Flächenfarbe;
  // matt und nichtmetallisch ist der Flachfarben-Pfad des Tilings ohnehin.
  const FARBE = 'farbe:';

  // Multiplikativ auf die Bauteilfarbe: WEISS lässt sie unverändert, GEDIMMT
  // nimmt ihr Helligkeit und Sättigung. Damit tritt beim Hervorheben alles
  // andere zurück, statt dass das Ziel eingefärbt wird — eine eingefärbte
  // Wand verliert genau die Farbe, um die es hier geht.
  const WEISS = () => Cesium.Color.WHITE;
  const GEDIMMT = () => new Cesium.Color(0.38, 0.40, 0.45, 1.0);

  let viewer = null;
  let layers = null;
  let asset = null;
  let layer = null;

  let index = null;          // { styles: [...], elemente: { guid: [stilnummer] } }
  let stilNummer = new Map();// Stilname → Nummer in index.styles
  let kategorien = [];       // Texturbibliothek
  let draft = new Map();     // Stilname → Kategorie ('' = keine Textur)
  let vorschlag = new Map(); // Stilname → automatisch erkannte Kategorie

  let aktiv = null;          // hervorgehobener Stilname
  let suche = '';
  let farbwahl = '#c8a05a';   // Stand des Farbwählers in der Palette
  let farbeAngefasst = false; // ob der Wähler von Hand gesetzt wurde
  let gespeichert = '{}';     // Serverstand der Zuordnung, zum Vergleich
  let ziehwert = null;       // Wert der gerade gezogenen Kachel
  let unterZeiger = null;    // Stilname unter dem Mauszeiger

  let panel = null;
  let handler = null;        // Cesium-Ereignisse (Klick, Bewegung)
  let tileHook = null;       // Abmeldefunktion des tileVisible-Listeners
  let pickGedrosselt = 0;

  // ── Öffnen und Schließen ─────────────────────────────────────────────────

  async function umschalten(a, v, ls) {
    if (panel) return schliessen();
    return oeffnen(a, v, ls);
  }

  async function oeffnen(a, v, ls) {
    asset = a; viewer = v; layers = ls;
    layer = layers.get(a.job_id) ?? null;
    if (!layer) {
      meldung('Das Modell ist nicht geladen — erst in der Liste auswählen.');
      return;
    }

    aufbauen();
    zeigeLaden('Materialien werden gelesen…');

    try {
      const [bibliothek, stile, idx] = await Promise.all([
        ladeBibliothek(), ladeStile(a.job_id), ladeIndex(a.job_id),
      ]);
      kategorien = bibliothek;
      index = idx;
      stilNummer = new Map(index.styles.map((s, i) => [s.name, i]));
      draft = new Map(Object.entries(stile.overrides || {}));
      gespeichert = JSON.stringify(Object.fromEntries(draft));
      vorschlag = new Map((stile.styles || []).map(s => [s.name, s.suggested]));

      zeichnen();
      szeneAnbinden();
    } catch (e) {
      zeigeLaden(`Konnte nicht geladen werden: ${e.message}`, true);
    }
  }

  function schliessen(ohneRueckfrage = false) {
    // Der Entwurf lebt nur im Panel — ihn beim Schließen stillschweigend
    // wegzuwerfen wäre die unangenehmste Art, Arbeit zu verlieren.
    if (!ohneRueckfrage && geaendert()
        && !confirm('Es gibt nicht gespeicherte Zuordnungen. Trotzdem schließen?')) {
      return;
    }
    szeneLoesen();
    aktiv = null;
    faerben();
    panel?.remove();
    panel = null;
  }

  // ── Daten ────────────────────────────────────────────────────────────────

  async function ladeBibliothek() {
    const res = await fetch('/materials/library');
    if (!res.ok) throw new Error('Materialbibliothek nicht abrufbar');
    return (await res.json()).filter(c => c.installed);
  }

  async function ladeStile(jobId) {
    const res = await fetch(`/assets/${jobId}/materials`);
    if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
    return res.json();
  }

  /**
   * Der Bauteilindex. Fehlt er (Modell von vor dem Materialmodus), baut ihn
   * das Backend im Hintergrund und antwortet mit 202 — das dauert so lange
   * wie das Öffnen der IFC-Datei, bei einem 550-MB-Modell eine Viertelminute.
   */
  async function ladeIndex(jobId, versuche = 40) {
    for (let i = 0; i < versuche; i++) {
      const res = await fetch(`/assets/${jobId}/materials/index`);
      if (res.ok) return res.json();
      const daten = await res.json().catch(() => ({}));
      if (res.status !== 202) {
        throw new Error(daten.status ?? daten.detail ?? res.statusText);
      }
      zeigeLaden('Bauteile werden den Materialien zugeordnet — das dauert beim '
        + 'ersten Mal einmalig eine halbe Minute.');
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Der Bauteilindex wurde nicht fertig.');
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  function aufbauen() {
    panel = document.createElement('aside');
    panel.id = 'mm-panel';
    panel.innerHTML = `
      <header class="mm-head">
        <div>
          <strong>Materialien</strong>
          <span class="mm-sub">${escapeHtml(asset?.name ?? '')}</span>
        </div>
        <div class="mm-kopfknoepfe">
          <button class="mm-icon" data-action="liste" title="Alle Materialien als Liste (Zuordnungsassistent)">☰</button>
          <button class="mm-icon" data-action="close" title="Materialmodus beenden">✕</button>
        </div>
      </header>
      <div class="mm-inhalt"></div>`;
    panel.addEventListener('click', onClick);
    panel.addEventListener('input', onInput);
    panel.addEventListener('dragstart', onDragStart);
    panel.addEventListener('dragend', onDragEnd);
    document.getElementById('viewer').appendChild(panel);
  }

  function zeigeLaden(text, fehler = false) {
    const ziel = panel?.querySelector('.mm-inhalt');
    if (ziel) {
      ziel.innerHTML = `<p class="mm-hinweis${fehler ? ' fehler' : ''}">${escapeHtml(text)}</p>`;
    }
  }

  function zeichnen() {
    const ziel = panel.querySelector('.mm-inhalt');
    const scrollMat = ziel.querySelector('.mm-liste')?.scrollTop ?? 0;
    const scrollLib = ziel.querySelector('.mm-galerie')?.scrollTop ?? 0;

    ziel.innerHTML = `
      <div class="mm-zeiger">${zeigerText()}</div>

      <div class="mm-abschnitt">
        <span>Materialien im Modell</span>
        <span class="mm-zahl">${index.styles.length}</span>
      </div>
      <div class="mm-liste">${index.styles.map(stilZeile).join('')}</div>

      <div class="mm-abschnitt">
        <span>Texturen</span>
        <input class="mm-suche" type="search" placeholder="suchen…"
               value="${escapeHtml(suche)}" aria-label="Textur suchen">
      </div>
      <div class="mm-galerie">${galerie()}</div>

      <footer class="mm-fuss">
        <p class="mm-hinweis">
          Textur auf ein Bauteil im Modell ziehen — sie gilt für alle Bauteile
          desselben Materials. Sichtbar wird sie nach dem Neu-Tiling.
        </p>
        <div class="mm-knoepfe">
          <span class="mm-stand${geaendert() ? ' offen' : ''}">${draft.size} Zuordnung(en)${geaendert() ? ' · ungespeichert' : ''}</span>
          <button data-action="speichern">Speichern</button>
          <button class="primary" data-action="tilen">Speichern &amp; neu tilen</button>
        </div>
      </footer>`;

    ziel.querySelector('.mm-liste').scrollTop = scrollMat;
    ziel.querySelector('.mm-galerie').scrollTop = scrollLib;
  }

  function stilZeile(stil, i) {
    const z = zuordnung(stil.name);
    const herkunft = z.manuell ? ' (manuell)' : ' (erkannt)';
    let ziel;
    if (z.art === 'textur') {
      ziel = `<img class="mm-kachel" src="/materials/library/${z.kategorie}/preview"
                   alt="" title="${escapeHtml(labelVon(z.kategorie))}${herkunft}" loading="lazy">`;
    } else if (z.art === 'farbe') {
      ziel = `<span class="mm-kachel vollton" style="background:${escapeHtml(z.farbe)}"
                    title="Matte Volltonfarbe ${escapeHtml(z.farbe)}"></span>`;
    } else {
      ziel = `<span class="mm-kachel leer" title="Unverändert einfarbig"></span>`;
    }
    return `
      <div class="mm-zeile${aktiv === stil.name ? ' aktiv' : ''}" data-stil="${i}"
           title="${escapeHtml(stil.name)}">
        <span class="mm-farbe" style="background:${stil.farbe ?? '#444'}"
              title="Farbe im Modell: ${escapeHtml(stil.farbe ?? 'unbekannt')}"></span>
        <span class="mm-name">${escapeHtml(stil.name)}</span>
        <span class="mm-anzahl">${stil.bauteile}</span>
        ${ziel}
      </div>`;
  }

  function galerie() {
    const begriff = suche.trim().toLowerCase();
    const passt = c => !begriff || c.label.toLowerCase().includes(begriff)
      || c.group.toLowerCase().includes(begriff) || c.key.toLowerCase().includes(begriff);

    const sonder = `
      ${kachel(AUTO, 'Automatisch', 'auto')}
      ${kachel(KEINE, 'Keine', 'keine')}
      ${farbkachel()}`;
    const rest = kategorien.filter(passt).map(c => kachel(c.key, c.label)).join('');
    return `<div class="mm-raster">${sonder}${rest}</div>`;
  }

  function kachel(wert, beschriftung, art) {
    const bild = art
      ? `<span class="mm-kachelbild ${art}">${art === 'auto' ? '⌁' : ''}</span>`
      : `<img class="mm-kachelbild" src="/materials/library/${wert}/preview" alt=""
              loading="lazy" draggable="false">`;
    return `
      <button type="button" class="mm-textur" draggable="true"
              data-wert="${escapeHtml(wert)}" title="${escapeHtml(beschriftung)} — auf ein Bauteil im Modell ziehen">
        ${bild}<span class="mm-beschriftung">${escapeHtml(beschriftung)}</span>
      </button>`;
  }

  /**
   * Die Volltonfarbe: eine Kachel wie jede andere, nur dass ihr Wert aus dem
   * Farbwähler daneben kommt. Sie deckt den Fall ab, für den es keine Textur
   * gibt und nie eine geben wird — eine schlicht gestrichene Fläche, ein
   * Bauteil, das nur farblich zu unterscheiden sein soll.
   */
  function farbkachel() {
    return `
      <div class="mm-farbgruppe">
        <button type="button" class="mm-textur" draggable="true" data-wert="${FARBE}"
                title="Matte Volltonfarbe ${escapeHtml(farbwahl)} — auf ein Bauteil ziehen">
          <span class="mm-kachelbild vollton" style="background:${escapeHtml(farbwahl)}"></span>
          <span class="mm-beschriftung">Vollton</span>
        </button>
        <input type="color" class="mm-farbwahl" value="${escapeHtml(farbwahl)}"
               title="Farbe wählen" aria-label="Volltonfarbe wählen">
      </div>`;
  }

  function zeigerText() {
    if (ziehwert !== null) {
      return unterZeiger
        ? `<strong>${escapeHtml(unterZeiger)}</strong> — hier loslassen`
        : 'Über ein Bauteil ziehen…';
    }
    if (unterZeiger) return `Unter dem Zeiger: <strong>${escapeHtml(unterZeiger)}</strong>`;
    if (aktiv) return `Hervorgehoben: <strong>${escapeHtml(aktiv)}</strong>`;
    return 'Auf ein Bauteil zeigen, um sein Material zu sehen';
  }

  function frischeZeigerzeile() {
    const el = panel?.querySelector('.mm-zeiger');
    if (el) el.innerHTML = zeigerText();
  }

  /** Ob der Entwurf vom zuletzt gespeicherten Stand abweicht. */
  function geaendert() {
    return JSON.stringify(Object.fromEntries(draft)) !== gespeichert;
  }

  /**
   * Was für diesen Stil gilt — Entwurf schlägt Vorschlag.
   * `textur` mit Kategorie, `farbe` mit Hexwert, oder `keine`.
   */
  function zuordnung(name) {
    if (draft.has(name)) {
      const wert = draft.get(name);
      if (!wert) return { art: 'keine', manuell: true };
      if (wert.startsWith(FARBE)) {
        return { art: 'farbe', farbe: wert.slice(FARBE.length), manuell: true };
      }
      return { art: 'textur', kategorie: wert, manuell: true };
    }
    const erkannt = vorschlag.get(name);
    return erkannt ? { art: 'textur', kategorie: erkannt } : { art: 'keine' };
  }

  function labelVon(key) {
    return kategorien.find(c => c.key === key)?.label ?? key;
  }

  // ── Szene ────────────────────────────────────────────────────────────────

  function szeneAnbinden() {
    const canvas = viewer.canvas;
    canvas.addEventListener('dragover', onCanvasDragOver);
    canvas.addEventListener('drop', onCanvasDrop);
    canvas.addEventListener('dragleave', onCanvasDragLeave);

    handler = new Cesium.ScreenSpaceEventHandler(canvas);
    handler.setInputAction((bewegung) => {
      const stil = stilAn(bewegung.endPosition);
      if (stil !== unterZeiger) { unterZeiger = stil; frischeZeigerzeile(); }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((klick) => {
      const stil = stilAn(klick.position);
      hervorheben(stil && stil === aktiv ? null : stil);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Nachgeladene Tiles müssen die Hervorhebung übernehmen — ohne das wäre
    // sie nach dem ersten Kameraflug lückenhaft.
    tileHook = layer.tileset.tileVisible.addEventListener(einfaerben);
  }

  function szeneLoesen() {
    const canvas = viewer?.canvas;
    if (canvas) {
      canvas.removeEventListener('dragover', onCanvasDragOver);
      canvas.removeEventListener('drop', onCanvasDrop);
      canvas.removeEventListener('dragleave', onCanvasDragLeave);
    }
    handler?.destroy();
    handler = null;
    if (tileHook) { tileHook(); tileHook = null; }
  }

  /** Stilname des Bauteils an einer Bildschirmposition, oder null. */
  function stilAn(position) {
    const getroffen = viewer.scene.pick(position);
    if (!(getroffen instanceof Cesium.Cesium3DTileFeature)) return null;
    if (layer && getroffen.tileset !== layer.tileset) return null;
    const namen = stileVon(getroffen.getProperty('GlobalId'));
    return namen.length ? namen[0] : null;
  }

  function stileVon(guid) {
    const nummern = (guid && index?.elemente[guid]) || [];
    return nummern.map(n => index.styles[n]?.name).filter(Boolean);
  }

  function alleStileAn(position) {
    const getroffen = viewer.scene.pick(position);
    if (!(getroffen instanceof Cesium.Cesium3DTileFeature)) return [];
    if (layer && getroffen.tileset !== layer.tileset) return [];
    return stileVon(getroffen.getProperty('GlobalId'));
  }

  function hervorheben(stil) {
    aktiv = stil;
    // Solange niemand am Wähler gedreht hat, steht dort die Farbe des
    // ausgewählten Materials. Das trifft den häufigsten Wunsch: diese Fläche
    // matt und einfarbig lassen, wie sie im Modell schon aussieht.
    if (!farbeAngefasst && stil) farbwahl = farbeVon(stil) ?? farbwahl;
    faerben();
    zeichnen();
    const zeile = panel?.querySelector('.mm-zeile.aktiv');
    zeile?.scrollIntoView({ block: 'nearest' });
  }

  function faerben() {
    if (!layer?.tileset) return;
    for (const tile of sichtbareTiles()) einfaerben(tile);
  }

  /**
   * Cesium führt keine Liste der sichtbaren Tiles heraus; `_selectedTiles` ist
   * intern, aber der einzige Weg, eine Hervorhebung auf das **bereits**
   * Gezeichnete anzuwenden. Für alles, was danach nachlädt, sorgt der
   * `tileVisible`-Listener — der Griff hier ist nur die Nachzügler-Korrektur
   * für den Augenblick des Klicks.
   */
  function sichtbareTiles() {
    return layer.tileset._selectedTiles ?? [];
  }

  function einfaerben(tile) {
    const inhalte = [tile.content, ...(tile.content?.innerContents ?? [])];
    const nummer = aktiv != null ? stilNummer.get(aktiv) : null;
    for (const inhalt of inhalte) {
      if (!inhalt || !inhalt.featuresLength) continue;
      for (let i = 0; i < inhalt.featuresLength; i++) {
        const f = inhalt.getFeature(i);
        if (aktiv == null) { f.color = WEISS(); continue; }
        const nummern = index.elemente[f.getProperty('GlobalId')] ?? [];
        f.color = nummern.includes(nummer) ? WEISS() : GEDIMMT();
      }
    }
  }

  // ── Ziehen auf das Modell ────────────────────────────────────────────────

  function onDragStart(e) {
    const knopf = e.target.closest('.mm-textur');
    if (!knopf) return;
    ziehwert = wertVon(knopf);
    knopf.classList.add('zieht');
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', ziehwert);
    frischeZeigerzeile();
  }

  function onDragEnd() {
    ziehwert = null;
    unterZeiger = null;
    panel?.querySelectorAll('.zieht').forEach(el => el.classList.remove('zieht'));
    viewer?.canvas.classList.remove('mm-ziel');
    frischeZeigerzeile();
  }

  function onCanvasDragOver(e) {
    if (ziehwert === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    viewer.canvas.classList.add('mm-ziel');

    // `scene.pick()` kostet einen eigenen Renderdurchgang. Bei jedem
    // `dragover` (dutzende je Sekunde) bricht das die Bildrate ein, deshalb
    // höchstens alle 80 ms.
    const jetzt = performance.now();
    if (jetzt - pickGedrosselt < 80) return;
    pickGedrosselt = jetzt;

    const stil = stilAn(bildschirmPunkt(e));
    if (stil !== unterZeiger) { unterZeiger = stil; frischeZeigerzeile(); }
  }

  function onCanvasDragLeave() {
    viewer.canvas.classList.remove('mm-ziel');
    unterZeiger = null;
    frischeZeigerzeile();
  }

  function onCanvasDrop(e) {
    const wert = ziehwert ?? e.dataTransfer.getData('text/plain');
    if (!wert) return;
    e.preventDefault();
    viewer.canvas.classList.remove('mm-ziel');

    const stile = alleStileAn(bildschirmPunkt(e));
    ziehwert = null;

    if (!stile.length) {
      meldung('Dort liegt kein Bauteil mit einem erkennbaren Material.');
      return;
    }
    if (stile.length === 1) return zuweisen(stile[0], wert);

    // Mehrschichtige Bauteile tragen mehrere Stile — welcher gemeint ist,
    // kann der Zeiger nicht sagen: getroffen wird der Körper, nicht die
    // Schicht. Also fragen, statt den ersten zu nehmen.
    auswahlMenue(e.clientX, e.clientY, stile, wert);
  }

  function bildschirmPunkt(e) {
    const kasten = viewer.canvas.getBoundingClientRect();
    return new Cesium.Cartesian2(e.clientX - kasten.left, e.clientY - kasten.top);
  }

  function auswahlMenue(x, y, stile, wert) {
    document.getElementById('mm-menue')?.remove();
    const menue = document.createElement('div');
    menue.id = 'mm-menue';
    menue.style.left = `${x}px`;
    menue.style.top = `${y}px`;
    menue.innerHTML = `
      <p>Dieses Bauteil hat ${stile.length} Materialien:</p>
      ${stile.map(n => `
        <button type="button" data-stil="${escapeHtml(n)}">
          <span class="mm-farbe" style="background:${farbeVon(n) ?? '#444'}"></span>
          ${escapeHtml(n)}
        </button>`).join('')}`;
    menue.addEventListener('click', (ev) => {
      const name = ev.target.closest('[data-stil]')?.dataset.stil;
      menue.remove();
      if (name) zuweisen(name, wert);
    });
    document.body.appendChild(menue);
    setTimeout(() => document.addEventListener('mousedown', function weg(ev) {
      if (!menue.contains(ev.target)) { menue.remove(); document.removeEventListener('mousedown', weg); }
    }), 0);
  }

  /** Der Wert einer Kachel; die Volltonkachel holt ihn aus dem Farbwähler. */
  function wertVon(knopf) {
    const wert = knopf.dataset.wert;
    return wert === FARBE ? FARBE + farbwahl : wert;
  }

  function farbeVon(name) {
    return index.styles[stilNummer.get(name)]?.farbe ?? null;
  }

  // ── Zuordnen und Speichern ───────────────────────────────────────────────

  function zuweisen(stil, wert) {
    if (wert === AUTO) draft.delete(stil);
    else draft.set(stil, wert === KEINE ? '' : wert);

    aktiv = stil;
    faerben();
    zeichnen();
    const text = wert === AUTO ? 'automatisch erkannt'
      : wert === KEINE ? 'ohne Textur'
      : wert.startsWith(FARBE) ? `matter Vollton ${wert.slice(FARBE.length)}`
      : labelVon(wert);
    meldung(`${stil} → ${text}`, 'ok');
  }

  async function speichern(tilen) {
    const knoepfe = panel.querySelectorAll('.mm-knoepfe button');
    knoepfe.forEach(b => b.disabled = true);
    try {
      const res = await fetch(`/assets/${asset.job_id}/materials`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: Object.fromEntries(draft), retile: tilen }),
      });
      if (!res.ok) throw new Error((await res.json()).detail ?? res.statusText);
      meldung(tilen
        ? 'Gespeichert — das Modell wird neu getilt. Der Fortschritt steht in der Assetliste.'
        : `${draft.size} Zuordnung(en) gespeichert. Sie greifen beim nächsten Tiling.`, 'ok');
      gespeichert = JSON.stringify(Object.fromEntries(draft));
      if (tilen) schliessen(true);
      else zeichnen();
    } catch (e) {
      meldung(`Speichern fehlgeschlagen: ${e.message}`, 'fehler');
    } finally {
      knoepfe.forEach(b => b.disabled = false);
    }
  }

  /** Kurze Rückmeldung am unteren Rand des Viewers. */
  function meldung(text, art = 'info') {
    document.getElementById('mm-meldung')?.remove();
    const el = document.createElement('div');
    el.id = 'mm-meldung';
    el.className = art;
    el.textContent = text;
    document.getElementById('viewer').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  // ── Bedienung im Panel ───────────────────────────────────────────────────

  function onInput(e) {
    if (e.target.classList.contains('mm-farbwahl')) {
      farbwahl = e.target.value;
      farbeAngefasst = true;
      const kachelEl = panel.querySelector('.mm-farbgruppe .mm-kachelbild');
      if (kachelEl) kachelEl.style.background = farbwahl;
      return;
    }
    if (!e.target.classList.contains('mm-suche')) return;
    suche = e.target.value;
    const galerieEl = panel.querySelector('.mm-galerie');
    if (galerieEl) galerieEl.innerHTML = galerie();
  }

  function onClick(e) {
    const aktion = e.target.closest('[data-action]')?.dataset.action;
    if (aktion === 'close') return schliessen();
    if (aktion === 'liste') {
      // Beide Sichten arbeiten auf derselben gespeicherten Zuordnung. Ohne
      // das Speichern zeigte die Liste den Serverstand und der Modus seinen
      // Entwurf — zwei Wahrheiten für dieselbe Frage.
      return (geaendert() ? speichern(false) : Promise.resolve())
        .then(() => MaterialAssistant.open(asset));
    }
    if (aktion === 'speichern') return speichern(false);
    if (aktion === 'tilen') return speichern(true);

    const textur = e.target.closest('.mm-textur');
    if (textur) {
      // Anklicken statt Ziehen wirkt auf das hervorgehobene Material — der
      // kurze Weg, wenn es ohnehin schon ausgewählt ist.
      if (!aktiv) return meldung('Erst ein Bauteil im Modell anklicken — oder die Textur darauf ziehen.');
      return zuweisen(aktiv, wertVon(textur));
    }

    const zeile = e.target.closest('.mm-zeile');
    if (zeile) {
      const stil = index.styles[Number(zeile.dataset.stil)];
      if (stil) hervorheben(aktiv === stil.name ? null : stil.name);
    }
  }

  function escapeHtml(wert) {
    return String(wert ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  return { umschalten, oeffnen, schliessen, get offen() { return !!panel; } };
})();
