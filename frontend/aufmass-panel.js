/**
 * aufmass-panel.js — Die Seitenleiste zum Messmodus.
 *
 * Sie hat bewusst **keine** Werkzeugauswahl. Der Vorgänger führte hier sechs
 * Knöpfe für sechs Messarten; die sind ersatzlos entfallen, weil die Art der
 * Messung nicht mehr vorher festgelegt wird, sondern aus der Zahl der Klicks
 * folgt. Übrig bleiben drei Dinge, die man wirklich einstellen will —
 * worauf gemessen wird (Modell, Splat, Gelände), worauf gefangen wird (Ecke,
 * Kante, Messpunkt, Raster) und ob die Box schneidet — und die laufenden
 * Zahlen.
 *
 * Im Viewer fehlt gegenüber der Vollfassung der Abschnitt „Graph": das
 * Mitschreiben jeder Messung als Turtle-Tripel (`aufmass-rdf.js`) und der
 * Mengen-/CO₂-Auszug des getroffenen Bauteils (`aufmass-mengen.js`) hängen
 * am Bauteilverzeichnis des Backends und gehören zu den Auswertungen.
 *
 * Die Zahlen stehen zusätzlich im Ablesefeld über der Leinwand. Doppelt, ja:
 * beim Zielen sieht man nicht in die Seitenleiste, und beim Nachschlagen
 * nicht auf die Leinwand.
 */
(function () {
  'use strict';

  const nf = (n, s) => new Intl.NumberFormat('de-DE',
    { minimumFractionDigits: s, maximumFractionDigits: s }).format(n);
  const m1 = (v) => (v === null || v === undefined) ? '—' : nf(v, 3) + ' m';
  const m2 = (v) => (v === null || v === undefined) ? '—' : nf(v, 3) + ' m²';
  const m3 = (v) => (v === null || v === undefined) ? '—' : nf(v, 3) + ' m³';
  const pz = (v) => (v === null || v === undefined) ? '—' : nf(v * 100, 1) + ' %';
  const kg = (v) => (v === null || v === undefined) ? '—'
    : Math.abs(v) >= 1000 ? nf(v / 1000, 2) + ' t' : nf(v, 1) + ' kg';

  const A = () => (window.BimViewer && BimViewer.Aufmass) || null;

  function html() {
    return `
      <div class="section">
        <div class="btn-group">
          <button id="amStart" class="btn btn--primary btn--sm" style="flex:2;"
                  onclick="BimViewer.Aufmass.umschalten()">${t('am.measure')}</button>
          <button class="btn btn--sm" onclick="BimViewer.Aufmass.abschluss()"
                  title="Enter">${t('am.finish')}</button>
          <button class="btn btn--sm" onclick="BimViewer.Aufmass.zurueck()"
                  title="Rücktaste">${t('am.back')}</button>
        </div>
        <p class="hint" id="amHinweis">
          ${t('am.intro')}
        </p>
      </div>

      <div class="section">
        <div class="section__label">${t('am.running')}</div>
        <div class="aufmass-werte" id="amWerte"></div>
      </div>

      <div class="section">
        <div class="section__label">${t('am.target')}</div>
        <div class="aufmass-fang-reihe">
          <button class="aufmass-chip" id="amZielAuto"     onclick="AufmassPanel.ziel('auto')">${t('am.targetAuto')}</button>
          <button class="aufmass-chip" id="amZielModell"   onclick="AufmassPanel.ziel('modell')">${t('am.targetModel')}</button>
          <button class="aufmass-chip" id="amZielSplat"    onclick="AufmassPanel.ziel('splat')">${t('am.targetSplat')}</button>
          <button class="aufmass-chip" id="amZielGelaende" onclick="AufmassPanel.ziel('gelaende')">${t('am.targetTerrain')}</button>
        </div>
        <p class="hint">${t('am.targetHint')}</p>
      </div>

      <div class="section">
        <div class="section__label">${t('am.snap')}</div>
        <div class="aufmass-fang-reihe">
          <button class="aufmass-chip" id="amFangEcken"  onclick="AufmassPanel.fang('ecken')">${t('am.corners')}</button>
          <button class="aufmass-chip" id="amFangKanten" onclick="AufmassPanel.fang('kanten')">${t('am.edges')}</button>
          <button class="aufmass-chip" id="amFangPunkte" onclick="AufmassPanel.fang('punkte')">${t('am.measurePoints')}</button>
        </div>
        <div class="aufmass-fang-reihe" style="margin-top:6px;">
          <button class="aufmass-chip" id="amRasterAus" onclick="AufmassPanel.raster('aus')">${t('am.free')}</button>
          <button class="aufmass-chip" id="amRasterCm"  onclick="AufmassPanel.raster('cm')">cm</button>
          <button class="aufmass-chip" id="amRasterMm"  onclick="AufmassPanel.raster('mm')">mm</button>
        </div>
        <p class="hint">
          ${t('am.snapHint')}
        </p>
      </div>

      <div class="section">
        <div class="section__label">${t('am.quantities')}</div>
        <div class="aufmass-werte" id="amMengen"></div>
        <div class="aufmass-liste" id="amBauteile" style="margin-top:6px;"></div>
        <p class="hint">${t('am.quantitiesHint')}</p>
      </div>

      <div class="section">
        <div class="section__label">${t('am.volumeTitle')}</div>
        <div class="aufmass-fang-reihe">
          <button class="aufmass-chip" id="amAutoBaugrube"
                  onclick="AufmassPanel.autoBaugrube()">${t('am.autoVolume')}</button>
        </div>
        <p class="hint">${t('am.autoVolumeHint')}</p>
      </div>

      <div class="section">
        <div class="section__label">${t('am.clipTitle')}</div>
        <div class="btn-group">
          <button class="btn btn--sm" id="amSchnitt"
                  onclick="AufmassPanel.schnitt()">${t('am.clipOn')}</button>
          <button class="btn btn--sm" onclick="BimViewer.Aufmass.schnittAus();AufmassPanel.stand()">${t('am.clipOff')}</button>
        </div>
        <p class="hint">
          ${t('am.clipHint')}
        </p>
      </div>

      <div class="section">
        <div class="section__label">${t('am.list')}</div>
        <div class="aufmass-liste" id="amListe"></div>
        <button class="btn btn--sm btn--danger" style="width:100%;margin-top:8px;"
                onclick="BimViewer.Aufmass.alleLoeschen()">${t('action.deleteAll')}</button>
      </div>
    `;
  }

  /** Zieht den Panelinhalt auf den Stand des Moduls nach. */
  function stand() {
    const a = A();
    if (!a || !document.getElementById('amWerte')) return;
    const z = a.zustand();

    const knopf = document.getElementById('amStart');
    if (knopf) {
      knopf.textContent = t(z.aktiv ? 'am.stop' : 'am.measure');
      knopf.classList.toggle('btn--primary', !z.aktiv);
      knopf.classList.toggle('btn--danger', z.aktiv);
    }

    const l = z.laufend;
    const letzte = z.messungen.length ? z.messungen[z.messungen.length - 1] : null;
    const w = (l && l.punkte) ? l : (letzte ? {
      punkte: letzte.punkte, laenge: letzte.werte.laenge, umfang: letzte.werte.umfang,
      flaeche: letzte.werte.flaeche, box: letzte.werte.boxLaenge ? {
        laenge: letzte.werte.boxLaenge, breite: letzte.werte.boxBreite, hoehe: letzte.werte.boxHoehe,
      } : null,
    } : null);

    const zeilen = [[t('am.points'), w ? w.punkte : 0]];
    if (w && w.laenge) zeilen.push([t('am.length'), m1(w.laenge)]);
    if (w && w.flaeche) {
      zeilen.push([t('am.area'), m2(w.flaeche)], [t('am.perimeter'), m1(w.umfang)]);
    }
    if (w && w.box) {
      zeilen.push([t('am.box'), nf(w.box.laenge, 2) + ' × ' + nf(w.box.breite, 2) + ' × ' + nf(w.box.hoehe, 2) + ' m']);
      zeilen.push([t('am.boxVolume'), m3(w.box.laenge * w.box.breite * w.box.hoehe)]);
    }
    if (letzte && letzte.werte.volumen != null && (!l || !l.punkte)) {
      zeilen.push([t('am.volume'), m3(letzte.werte.volumen)]);
      zeilen.push([t('am.fillRatio'), pz(letzte.werte.fuellverhaeltnis)]);
      if (letzte.werte.baugrubePunkte) {
        zeilen.push([t('am.fromPoints'), new Intl.NumberFormat('de-DE').format(letzte.werte.baugrubePunkte)]);
      }
    }
    document.getElementById('amWerte').innerHTML =
      zeilen.map(([k, v]) => '<span>' + k + '</span><span>' + v + '</span>').join('');

    // Mengen der berührten Bauteile — der laufenden Messung, sonst der letzten.
    const bauteile = (l && l.punkte)
      ? [...new Map((A()._Z.punkte || []).filter((p) => p.bauteil)
          .map((p) => [p.bauteil.globalId, p.bauteil])).values()]
          .map((b) => ({ globalId: b.globalId, name: b.name, typ: b.ifcType,
                         volumen: b.mengen && b.mengen.volumen, masse: b.mengen && b.mengen.masse,
                         co2: b.mengen && b.mengen.co2, werkstoff: b.mengen && b.mengen.werkstoffName }))
      : (letzte ? letzte.bauteile || [] : []);

    const sum = bauteile.reduce((a, b) => ({
      v: a.v + (b.volumen || 0), m: a.m + (b.masse || 0), c: a.c + (b.co2 || 0),
      ohne: a.ohne + (b.volumen == null ? 1 : 0),
    }), { v: 0, m: 0, c: 0, ohne: 0 });

    const mengenEl = document.getElementById('amMengen');
    if (mengenEl) {
      const zm = [[t('am.parts'), bauteile.length]];
      if (sum.v) zm.push([t('am.partVolume'), m3(sum.v)]);
      if (sum.m) zm.push([t('am.mass'), kg(sum.m)]);
      if (sum.c) zm.push(['CO₂ (A1–A3)', kg(sum.c)]);
      // Eine Summe, in der Bauteile fehlen, muss das sagen — sonst liest man
      // sie als vollständig.
      if (sum.ohne) zm.push([t('am.withoutQuantity'), sum.ohne]);
      mengenEl.innerHTML = zm.map(([k, v]) =>
        '<span>' + k + '</span><span>' + v + '</span>').join('');
    }

    const btEl = document.getElementById('amBauteile');
    if (btEl) {
      btEl.innerHTML = bauteile.length ? bauteile.map((b) => `
        <div class="aufmass-liste__zeile" title="${(b.name || b.globalId).replace(/"/g, '&quot;')}">
          <b>${(b.typ || '').replace(/^Ifc/, '')}</b>
          <span>${b.werkstoff ? b.werkstoff + ' · ' : ''}${b.volumen != null ? m3(b.volumen) : '—'}${
            b.co2 != null ? ' · ' + kg(b.co2) + ' CO₂' : ''}</span>
        </div>`).join('')
        : '<div class="hint">' + t('am.noParts') + '</div>';
    }

    const F = window.AufmassFang;
    if (F) {
      ['ecken', 'kanten', 'punkte'].forEach((k) => {
        const el = document.getElementById('amFang' + k[0].toUpperCase() + k.slice(1));
        if (el) el.classList.toggle('is-an', !!F[k]);
      });
      [['aus', 'amRasterAus'], ['cm', 'amRasterCm'], ['mm', 'amRasterMm']].forEach(([k, id]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('is-an', F.raster === k);
      });
      [['auto', 'amZielAuto'], ['modell', 'amZielModell'],
       ['splat', 'amZielSplat'], ['gelaende', 'amZielGelaende']].forEach(([k, id]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('is-an', (F.ziel || 'auto') === k);
      });
      // Ohne Splatwolke in der Szene ist „nur Splat" eine Sackgasse: jeder
      // Klick meldete „dort liegt kein Splat". Der Knopf bleibt sichtbar —
      // sonst fragte man sich, wo er hin ist —, aber er sagt, woran es liegt.
      const splatDa = !!(window.SplatPick && SplatPick.available && SplatPick.available());
      const sz = document.getElementById('amZielSplat');
      if (sz) {
        sz.disabled = !splatDa;
        sz.title = splatDa ? '' : t('am.targetNoSplat');
      }
    }

    const ab = document.getElementById('amAutoBaugrube');
    if (ab) ab.classList.toggle('is-an', !!z.autoBaugrube);

    const s = document.getElementById('amSchnitt');
    if (s) s.classList.toggle('btn--primary', !!z.schnitt);

    const liste = document.getElementById('amListe');
    liste.innerHTML = z.messungen.length
      ? z.messungen.slice().reverse().map((m) => `
          <div class="aufmass-liste__zeile">
            <b>${m.id}</b>
            <span>${m.punkte} P · ${m.werte.flaeche ? m2(m.werte.flaeche)
              : m.werte.laenge ? m1(m.werte.laenge) : t('am.pointShort')}${
              m.werte.volumen != null ? ' · ' + m3(m.werte.volumen) : ''}</span>
          </div>`).join('')
      : '<div class="hint">' + t('am.empty') + '</div>';
  }

  // ── Bedienung ──────────────────────────────────────────────────────────────

  function fang(welche) {
    if (!window.AufmassFang) return;
    AufmassFang[welche] = !AufmassFang[welche];
    stand();
  }

  function raster(wert) {
    if (!window.AufmassFang) return;
    AufmassFang.raster = wert;
    stand();
  }

  /**
   * Worauf gemessen wird. Ein zweiter Klick auf das eingestellte Ziel führt
   * zurück auf „alles" — dieselbe Umschaltlogik wie bei den Fangregeln
   * daneben, und der Weg zurück ist der, den man sucht, nachdem man sich
   * eingeschränkt hat.
   */
  function ziel(welches) {
    if (!window.AufmassFang || !AufmassFang.zielSetzen) return;
    AufmassFang.zielSetzen(AufmassFang.ziel === welches ? 'auto' : welches);
    stand();
  }

  function autoBaugrube() {
    const a = A();
    if (a) a.setAutoBaugrube(!a.zustand().autoBaugrube);
    stand();
  }

  function schnitt() {
    const a = A();
    if (!a) return;
    a.schnitt(!a.zustand().schnitt);
    stand();
  }

  window.AufmassPanel = { html, stand, fang, raster, ziel, autoBaugrube, schnitt };

  // Solange gemessen wird, laufen die Zahlen im Panel mit — aber nur zweimal
  // je Sekunde. Häufiger wäre nicht abzulesen und würde bei jedem Bild das
  // halbe Panel neu bauen; das Ablesefeld über der Leinwand ist der Ort für
  // die Zahl, die bei jeder Mausbewegung stimmen muss.
  setInterval(() => {
    const a = A();
    if (a && a.laeuft && document.getElementById('amWerte')) stand();
  }, 500);

  console.log('📐 Aufmaß-Panel geladen');
})();
