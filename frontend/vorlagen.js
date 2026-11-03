/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// VORLAGEN — Ansichten, die man öfter lädt
//
// Eine Vorlage ist eine Szene aus der Zustands-Registry (zustand.js: welche
// Modelle geladen und sichtbar sind, Filter, Schnitt, Explosion, Notizen,
// Welt, Sonne, Farben, Licht, Punktwolken — in der Vollfassung auch die
// Raumansicht) und die Kamera dazu. Laden heißt: fehlende Modelle laden,
// ohne dass die Kamera davonfliegt; die Szene herstellen; die Kamera
// hinsetzen. Dieselbe Registry trägt die Szene einer Präsentationsfolie —
// eine Vorlage ist eine Folie ohne Vortrag.
//
// **Zuletzt geladen steht oben.** Die Liste sortiert nach der letzten
// Verwendung. Die Taste dagegen ist fest: jede Vorlage bekommt beim Anlegen
// die kleinste freie Nummer 1–9 für ⇧1…⇧9. Wanderte die Nummer mit der
// Reihenfolge, müsste man vor jedem Druck nachsehen, was gerade auf 1 liegt.
//
// **Abgelegt im Backend** (`/nutzung/vorlagen`), damit sie auf jedem Rechner
// da sind, und im localStorage als Spiegel. Was ohne Backend angelegt wurde,
// wird beim nächsten Start nachgereicht (`ileen_vorlagen_ausstehend`).
//
// Bedienung: Gruppe „Vorlagen" im Bereich 📷 Ansicht, Taste V für die Liste
// über der Szene (tippen filtert, ↑↓ und Enter laden, Enter ohne Treffer legt
// unter dem getippten Namen an, eine Ziffer bei leerem Feld lädt diese
// Nummer), ⇧1…⇧9 von überall.
// ===============================
'use strict';

(function () {

  var B = window.BimViewer = window.BimViewer || {};
  var SPEICHER = 'ileen_vorlagen';
  var AUSSTEHEND = 'ileen_vorlagen_ausstehend';
  var GRUPPE = 'vorlagen';

  var vorlagen = [];
  var backend = 'unbekannt';   // 'ok' | 'aus' | 'unbekannt'
  var laedt = null;            // id der Vorlage, die gerade geladen wird

  function jetzt() { return new Date().toISOString(); }
  function neueId() { return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function finde(id) { return vorlagen.filter(function (v) { return v.id === id; })[0] || null; }
  function basis() {
    try { return (B.getBackendUrl && B.getBackendUrl()) || ''; } catch (e) { return ''; }
  }

  /** Zuletzt verwendet zuerst; nie geladen nach Anlegedatum. */
  function liste() {
    return vorlagen.slice().sort(function (a, b) {
      return String(b.zuletzt || b.angelegt || '').localeCompare(String(a.zuletzt || a.angelegt || ''));
    });
  }

  function freieTaste(ausser) {
    for (var n = 1; n <= 9; n++) {
      if (!vorlagen.some(function (v) { return v.taste === n && v !== ausser; })) return n;
    }
    return null;
  }

  // ── Ablage ───────────────────────────────────────────────────────────────

  function lokalLesen() {
    try {
      var roh = JSON.parse(localStorage.getItem(SPEICHER) || '[]');
      return Array.isArray(roh) ? roh : [];
    } catch (e) { return []; }
  }

  function lokalSichern() {
    try { localStorage.setItem(SPEICHER, JSON.stringify(vorlagen)); } catch (e) { /* voll oder privat */ }
  }

  function ausstehend(an) {
    try {
      if (an === undefined) return localStorage.getItem(AUSSTEHEND) === '1';
      if (an) localStorage.setItem(AUSSTEHEND, '1'); else localStorage.removeItem(AUSSTEHEND);
    } catch (e) { /* privat */ }
    return false;
  }

  var schreibTimer = null;

  /** Lokal sofort, ins Backend gebündelt — ein Umbenennen tippt sich Buchstabe für Buchstabe. */
  function sichern() {
    lokalSichern();
    zeichnen();
    clearTimeout(schreibTimer);
    schreibTimer = setTimeout(backendSchreiben, 400);
  }

  function backendSchreiben() {
    var url = basis();
    if (!url) { ausstehend(true); return Promise.resolve(false); }
    return fetch(url + '/nutzung/vorlagen', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vorlagen: vorlagen })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      backend = 'ok';
      ausstehend(false);
      return true;
    }).catch(function (e) {
      console.warn('[Vorlagen] Backend nicht erreichbar, nur lokal gesichert:', e.message || e);
      backend = 'aus';
      ausstehend(true);
      zeichnen();
      return false;
    });
  }

  /** Zwei Stände zusammenlegen — je Vorlage gewinnt der jüngere. */
  function vereinigen(a, b) {
    var nachId = {};
    var stand = function (v) { return String(v.geaendert || '') > String(v.zuletzt || '') ? v.geaendert : (v.zuletzt || v.angelegt || ''); };
    a.concat(b).forEach(function (v) {
      if (!v || !v.id) return;
      var alt = nachId[v.id];
      if (!alt || String(stand(v)) > String(stand(alt))) nachId[v.id] = v;
    });
    return Object.keys(nachId).map(function (k) { return nachId[k]; });
  }

  function start() {
    vorlagen = lokalLesen();
    var url = basis();
    if (!url) { backend = 'aus'; return; }
    fetch(url + '/nutzung/vorlagen').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (antwort) {
      backend = 'ok';
      var entfernt = Array.isArray(antwort && antwort.vorlagen) ? antwort.vorlagen : [];
      if (ausstehend()) {
        // Ohne Backend Angelegtes nachreichen.
        vorlagen = vereinigen(entfernt, vorlagen);
        sichern();
      } else {
        vorlagen = entfernt;
        lokalSichern();
        zeichnen();
      }
    }).catch(function () { backend = 'aus'; zeichnen(); });
  }

  // ── Kamera ───────────────────────────────────────────────────────────────

  function kameraLesen() {
    var v = B.viewer;
    if (!v) return null;
    var c = v.camera, p = c.positionWC;
    var fov = (c.frustum && typeof c.frustum.fov === 'number') ? Cesium.Math.toDegrees(c.frustum.fov) : null;
    return { pos: [p.x, p.y, p.z], hpr: [c.heading, c.pitch, c.roll], fov: fov };
  }

  function kameraFliegen(k) {
    var v = B.viewer;
    if (!v || !k || !Array.isArray(k.pos)) return;
    var c = v.camera;
    c.cancelFlight();
    c.flyTo({
      destination: new Cesium.Cartesian3(k.pos[0], k.pos[1], k.pos[2]),
      orientation: { heading: k.hpr[0], pitch: k.hpr[1], roll: k.hpr[2] },
      duration: 1.2
    });
    if (k.fov && c.frustum && typeof c.frustum.fov === 'number') {
      c.frustum.fov = Cesium.Math.toRadians(k.fov);
    }
  }

  // ── Was eine Vorlage zeigt — für die Zeile in der Liste ─────────────────

  function kurzbeschreibung(v) {
    var s = v.szene || {};
    var teile = [];
    var modelle = s.modelle ? Object.keys(s.modelle).map(function (k) { return s.modelle[k]; }) : [];
    var sichtbar = modelle.filter(function (m) { return m.sichtbar !== false; });
    if (sichtbar.length === 1) teile.push(String(sichtbar[0].name || 'Modell').replace(/\.(ifc|las|laz|e57|ply|glb)$/i, ''));
    else if (sichtbar.length) teile.push(sichtbar.length + ' Modelle');
    if (s.explosion && s.explosion.an) teile.push('Explosion');
    if (s.schnitt && s.schnitt.an) teile.push('Schnitt');
    if (s.raeume && s.raeume.an) {
      teile.push('Räume' + (s.raeume.geschosse && s.raeume.geschosse.length ? ' ' + s.raeume.geschosse.join('+') : ''));
    }
    return teile.join(' · ');
  }

  function vorschlagName() {
    var text = kurzbeschreibung({ szene: B.Zustand ? B.Zustand.lesen() : {} });
    return text || ('Ansicht ' + (vorlagen.length + 1));
  }

  function wannText(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return 'nie geladen';
    var s = (Date.now() - t) / 1000;
    if (s < 60) return 'gerade';
    if (s < 3600) return 'vor ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'vor ' + Math.round(s / 3600) + ' h';
    if (s < 2 * 86400) return 'gestern';
    if (s < 7 * 86400) return 'vor ' + Math.round(s / 86400) + ' Tagen';
    return new Date(t).toLocaleDateString('de-DE');
  }

  // ── Anlegen, laden, ändern ──────────────────────────────────────────────

  function aufnehmen() {
    return { szene: B.Zustand ? B.Zustand.lesen() : {}, kamera: kameraLesen() };
  }

  function speichern(name) {
    var n = String(name || '').trim() || vorschlagName();
    var v = Object.assign({
      id: neueId(), name: n, taste: freieTaste(), angelegt: jetzt(), geaendert: jetzt(),
      zuletzt: jetzt(), anzahl: 0
    }, aufnehmen());
    vorlagen.push(v);
    sichern();
    if (B.Nutzung) B.Nutzung.melden('vorlage_gespeichert', { id: v.id, name: v.name, bereiche: Object.keys(v.szene || {}) });
    schild('gespeichert', v);
    return v;
  }

  /** Die aktuelle Ansicht in eine bestehende Vorlage übernehmen. */
  function ueberschreiben(id) {
    var v = finde(id);
    if (!v) return null;
    Object.assign(v, aufnehmen(), { geaendert: jetzt() });
    sichern();
    if (B.Nutzung) B.Nutzung.melden('vorlage_ueberschrieben', { id: v.id, name: v.name });
    schild('aufgenommen', v);
    return v;
  }

  async function laden(id) {
    var v = finde(id);
    if (!v || laedt) return null;
    laedt = v.id;
    zeichnen();
    schild('wird geladen …', v);
    var t0 = performance.now();
    var fehler = [];
    try {
      var Z = B.Zustand;
      if (Z && v.szene) {
        // Erst laden, was fehlt (ohne Kameraflug), dann herstellen.
        var vb = await Z.vorbereiten([v.szene]);
        fehler = fehler.concat((vb && vb.fehler) || []);
        var an = await Z.anwenden(v.szene);
        fehler = fehler.concat((an && an.fehler) || []);
      }
      if (v.kamera) kameraFliegen(v.kamera);
      v.zuletzt = jetzt();
      v.anzahl = (v.anzahl || 0) + 1;
      if (B.Nutzung) {
        B.Nutzung.melden('vorlage_geladen', { id: v.id, name: v.name, ms: Math.round(performance.now() - t0),
                                             fehler: fehler.map(function (f) { return f.id; }) });
      }
      schild(fehler.length ? 'geladen, ' + fehler.length + ' Bereich(e) nicht herstellbar' : 'geladen', v);
      if (fehler.length) console.warn('[Vorlagen] nicht hergestellt:', fehler);
    } finally {
      laedt = null;
      sichern();
    }
    return { fehler: fehler };
  }

  function ladenNachTaste(n) {
    var v = vorlagen.filter(function (x) { return x.taste === n; })[0];
    if (!v) {
      if (B.Tasten) B.Tasten.schild('⇧' + n, 'Vorlage', { text: 'nicht belegt — V legt an' });
      return Promise.resolve(null);
    }
    return laden(v.id);
  }

  function umbenennen(id, name) {
    var v = finde(id);
    var n = String(name || '').trim();
    if (!v || !n || n === v.name) { zeichnen(); return; }
    v.name = n;
    v.geaendert = jetzt();
    sichern();
  }

  /** Taste 1–9 setzen; hat eine andere Vorlage sie, gibt sie sie ab. */
  function tasteSetzen(id, n) {
    var v = finde(id);
    if (!v) return;
    var taste = Number(n) >= 1 && Number(n) <= 9 ? Number(n) : null;
    if (taste) vorlagen.forEach(function (x) { if (x !== v && x.taste === taste) x.taste = null; });
    v.taste = taste;
    v.geaendert = jetzt();
    sichern();
  }

  var loeschBereit = null;

  /** Zweimal klicken statt Rückfrage — ein Dialog hielte die Szene an. */
  function loeschen(id) {
    if (loeschBereit !== id) {
      loeschBereit = id;
      zeichnen();
      setTimeout(function () { if (loeschBereit === id) { loeschBereit = null; zeichnen(); } }, 3000);
      return false;
    }
    loeschBereit = null;
    var v = finde(id);
    vorlagen = vorlagen.filter(function (x) { return x.id !== id; });
    sichern();
    if (v && B.Nutzung) B.Nutzung.melden('vorlage_geloescht', { id: v.id, name: v.name });
    return true;
  }

  function schild(text, v) {
    if (B.Tasten && typeof B.Tasten.schild === 'function') {
      B.Tasten.schild(v && v.taste ? '⇧' + v.taste : 'V', v ? v.name : 'Vorlage', { text: text });
    } else if (B.updateStatus) {
      B.updateStatus((v ? v.name + ': ' : '') + text, 'info');
    }
  }

  // ── Gruppe im Bereich „Ansicht" ──────────────────────────────────────────

  function zeileHtml(v) {
    var tasten = '<option value="">–</option>';
    for (var n = 1; n <= 9; n++) tasten += '<option value="' + n + '"' + (v.taste === n ? ' selected' : '') + '>⇧' + n + '</option>';
    var meta = [wannText(v.zuletzt), (v.anzahl || 0) + '×', kurzbeschreibung(v)].filter(Boolean).join(' · ');
    var id = esc(v.id);
    return '<div class="vorlage-zeile' + (laedt === v.id ? ' is-laedt' : '') + '" data-id="' + id + '">' +
      '<button class="vorlage-zeile__laden" onclick="BimViewer.Vorlagen.laden(\'' + id + '\')" title="Laden">' +
        '<span class="vorlage-zeile__name">' + esc(v.name) + '</span>' +
        '<span class="vorlage-zeile__meta">' + esc(meta) + '</span>' +
      '</button>' +
      '<select class="vorlage-zeile__taste" title="Taste" onchange="BimViewer.Vorlagen.tasteSetzen(\'' + id + '\', this.value)">' + tasten + '</select>' +
      '<button class="vorlage-zeile__knopf" title="Aktuelle Ansicht in diese Vorlage übernehmen" onclick="BimViewer.Vorlagen.ueberschreiben(\'' + id + '\')">⟳</button>' +
      '<button class="vorlage-zeile__knopf" title="Umbenennen" onclick="BimViewer.Vorlagen._umbenennenStart(\'' + id + '\')">✎</button>' +
      '<button class="vorlage-zeile__knopf' + (loeschBereit === v.id ? ' is-bereit' : '') + '" title="' +
        (loeschBereit === v.id ? 'Noch einmal klicken zum Löschen' : 'Löschen') +
        '" onclick="BimViewer.Vorlagen.loeschen(\'' + id + '\')">' + (loeschBereit === v.id ? 'löschen?' : '✕') + '</button>' +
    '</div>';
  }

  function markup() {
    return '<div class="vorlagen">' +
      '<div class="vorlagen__neu">' +
        '<input id="vorlageName" class="input" type="text" placeholder="Name — leer: aus der Szene"' +
        ' onkeydown="if (event.key === \'Enter\') BimViewer.Vorlagen._ausFeld()">' +
        '<button class="btn btn--sm" onclick="BimViewer.Vorlagen._ausFeld()" title="Modelle, Filter, Schnitt, Explosion, Räume, Licht … und die Kamera">＋ Ansicht speichern</button>' +
      '</div>' +
      '<div id="vorlagenListe" class="vorlagen__liste"></div>' +
      '<div id="vorlagenFuss" class="vorlagen__fuss"></div>' +
    '</div>';
  }

  function zeichnen() {
    var el = document.getElementById('vorlagenListe');
    if (el) {
      var l = liste();
      el.innerHTML = l.length ? l.map(zeileHtml).join('')
        : '<div class="modern-empty-state">Noch keine Vorlage. Stell die Ansicht ein und speichere sie.</div>';
    }
    var fuss = document.getElementById('vorlagenFuss');
    if (fuss) {
      fuss.textContent = 'V öffnet die Liste über der Szene · ⇧1…⇧9 lädt direkt · zuletzt geladene oben' +
        (backend === 'aus' ? ' · Backend nicht erreichbar, nur in diesem Browser gesichert' : '');
    }
    var p = document.getElementById('vorlagenPalette');
    if (p) paletteZeichnen();
  }

  function ausFeld() {
    var feld = document.getElementById('vorlageName');
    speichern(feld ? feld.value : '');
    if (feld) feld.value = '';
  }

  function umbenennenStart(id) {
    var v = finde(id);
    var zeile = document.querySelector('.vorlage-zeile[data-id="' + id + '"] .vorlage-zeile__name');
    if (!v || !zeile) return;
    var feld = document.createElement('input');
    feld.className = 'input vorlage-zeile__feld';
    feld.value = v.name;
    var fertig = false;
    var ende = function (uebernehmen) {
      if (fertig) return;
      fertig = true;
      if (uebernehmen) umbenennen(id, feld.value); else zeichnen();
    };
    feld.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') ende(true);
      if (e.key === 'Escape') ende(false);
    });
    feld.addEventListener('blur', function () { ende(true); });
    feld.addEventListener('click', function (e) { e.stopPropagation(); });
    zeile.replaceWith(feld);
    feld.focus();
    feld.select();
  }

  // ── Palette (V) ──────────────────────────────────────────────────────────

  var palette = { filter: '', markiert: 0 };

  function treffer() {
    var f = palette.filter.trim().toLowerCase();
    return liste().filter(function (v) {
      return !f || String(v.name).toLowerCase().indexOf(f) >= 0 || kurzbeschreibung(v).toLowerCase().indexOf(f) >= 0;
    });
  }

  function paletteZeichnen() {
    var el = document.getElementById('vorlagenPaletteListe');
    if (!el) return;
    var t = treffer();
    palette.markiert = Math.max(0, Math.min(palette.markiert, t.length - 1));
    var neu = palette.filter.trim();
    el.innerHTML = t.map(function (v, i) {
      return '<div class="vorlagen-palette__zeile' + (i === palette.markiert ? ' is-markiert' : '') + '" data-id="' + esc(v.id) + '">' +
        '<kbd>' + (v.taste ? '⇧' + v.taste : '·') + '</kbd>' +
        '<span class="vorlagen-palette__name">' + esc(v.name) + '</span>' +
        '<span class="vorlagen-palette__meta">' + esc([wannText(v.zuletzt), kurzbeschreibung(v)].filter(Boolean).join(' · ')) + '</span>' +
      '</div>';
    }).join('') +
    (neu && !t.some(function (v) { return v.name.toLowerCase() === neu.toLowerCase(); })
      ? '<div class="vorlagen-palette__zeile vorlagen-palette__neu' + (t.length ? '' : ' is-markiert') + '" data-neu="1">' +
          '<kbd>↵</kbd><span class="vorlagen-palette__name">„' + esc(neu) + '" als neue Vorlage speichern</span></div>'
      : '') +
    (!t.length && !neu ? '<div class="vorlagen-palette__leer">Noch keine Vorlage — Namen tippen und Enter speichert die jetzige Ansicht.</div>' : '');
  }

  function paletteSchliessen() {
    var p = document.getElementById('vorlagenPalette');
    if (p) p.remove();
  }

  function paletteOeffnen() {
    if (document.getElementById('vorlagenPalette')) { paletteSchliessen(); return; }
    palette = { filter: '', markiert: 0 };
    var p = document.createElement('div');
    p.id = 'vorlagenPalette';
    p.className = 'vorlagen-palette';
    p.innerHTML =
      '<div class="vorlagen-palette__karte">' +
        '<input id="vorlagenPaletteFeld" class="input" type="text" autocomplete="off"' +
        ' placeholder="Vorlage suchen · Ziffer lädt · neuer Name + Enter speichert">' +
        '<div id="vorlagenPaletteListe" class="vorlagen-palette__liste"></div>' +
        '<div class="vorlagen-palette__fuss">↑↓ wählen · Enter laden · ⇧1…⇧9 von überall · Esc schließt</div>' +
      '</div>';
    document.body.appendChild(p);
    var feld = document.getElementById('vorlagenPaletteFeld');
    feld.addEventListener('input', function () { palette.filter = feld.value; palette.markiert = 0; paletteZeichnen(); });
    feld.addEventListener('keydown', function (e) {
      e.stopPropagation();   // Buchstaben gehören dem Feld, nicht den Tastenkürzeln
      var t = treffer();
      if (e.key === 'Escape') { e.preventDefault(); paletteSchliessen(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); palette.markiert = Math.min(palette.markiert + 1, t.length - 1); paletteZeichnen(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); palette.markiert = Math.max(palette.markiert - 1, 0); paletteZeichnen(); return; }
      if (/^[1-9]$/.test(e.key) && !feld.value) {
        e.preventDefault();
        paletteSchliessen();
        ladenNachTaste(Number(e.key));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        var name = feld.value.trim();
        if (t.length) { paletteSchliessen(); laden(t[palette.markiert].id); }
        else if (name) { paletteSchliessen(); speichern(name); }
      }
    });
    p.addEventListener('mousedown', function (e) {
      if (e.target === p) { paletteSchliessen(); return; }
      var zeile = e.target.closest('.vorlagen-palette__zeile');
      if (!zeile) return;
      e.preventDefault();
      paletteSchliessen();
      if (zeile.dataset.neu) speichern(feld.value);
      else laden(zeile.dataset.id);
    });
    paletteZeichnen();
    feld.focus();
  }

  // ── Anmelden ─────────────────────────────────────────────────────────────

  function anmelden() {
    if (typeof BimViewerUI === 'undefined' || typeof BimViewerUI.gruppeAnmelden !== 'function') return;
    // Ganz oben im Bereich „Ansicht": eine Vorlage ist die Ansicht als Ganzes.
    BimViewerUI.gruppeAnmelden('view', {
      key: GRUPPE, ordnung: 5,
      label: 'Vorlagen',
      inhalt: markup,
      beimOeffnen: zeichnen,
    });
  }

  B.Vorlagen = {
    liste: liste,
    speichern: speichern,
    ueberschreiben: ueberschreiben,
    laden: laden,
    ladenNachTaste: ladenNachTaste,
    umbenennen: umbenennen,
    tasteSetzen: tasteSetzen,
    loeschen: loeschen,
    palette: paletteOeffnen,
    zeichnen: zeichnen,
    get backend() { return backend; },
    _ausFeld: ausFeld,
    _umbenennenStart: umbenennenStart,
    _intern: { vereinigen: vereinigen, kurzbeschreibung: kurzbeschreibung, freieTaste: freieTaste,
               setzen: function (l) { vorlagen = l; }, wannText: wannText }
  };

  anmelden();
  start();
  // Die Gruppe entsteht beim Aufbau der Leiste; danach die Liste füllen.
  window.addEventListener('load', function () { setTimeout(zeichnen, 800); });
})();
