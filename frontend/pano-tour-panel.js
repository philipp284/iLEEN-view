/**
 * pano-tour-panel.js — Oberfläche zum 360°-Rundgang (pano-tour.js)
 *
 * Eigenes Hauptmenü (📷) in der linken Aktivitätsleiste, eingehängt über das
 * DOM wie bauplaner-panel.js — `addSection()` in ui.js ist von außen nicht
 * erreichbar. Der Rundgang selbst lebt in pano-tour.js; hier steht nur, was
 * die Oberfläche daraus macht: Tour laden, Spots anklicken, hinein und wieder
 * heraus.
 */
'use strict';

(function () {

  var ID = 'panotour';
  var T = null;                         // window.PanoTour, erst beim Start sicher

  function panelHtml() {
    return '' +
      '<div class="pano-kopf">' +
        '<div class="pano-kopf__zeile">' +
          '<span class="pano-kopf__marke">📷 360°-Rundgang</span>' +
          '<span class="pano-kopf__zahl" id="panoZahl">—</span>' +
        '</div>' +
        '<div class="plan-status" id="panoStatus"></div>' +
      '</div>' +

      '<details class="panel-group" open>' +
        '<summary class="panel-group__header"><span>Tour laden</span></summary>' +
        '<div class="panel-group__body">' +
          '<div class="input-row">' +
            '<input class="input" id="panoUrl" placeholder="Pfad zur tour.json" ' +
                   'value="data/pano-demo/tour.json">' +
            '<button class="btn btn--sm" onclick="PanoTourPanel.ladenUrl()">Laden</button>' +
          '</div>' +
          '<button class="btn btn--sm btn--block" onclick="PanoTourPanel.demo()" ' +
                  'style="margin-top:6px;">Demo-Rundgang laden</button>' +
          '<div class="plan-hint">Eine Tour ist eine <b>tour.json</b> mit Spots ' +
            '(Weltlage, Blickrichtung, Panorama). Klick auf einen Spot in der Szene ' +
            'oder in der Liste geht hinein; <b>Esc</b> führt zurück, ' +
            '<b>←/→</b> blättern durch die Nachbarn.</div>' +
        '</div>' +
      '</details>' +

      '<details class="panel-group" open>' +
        '<summary class="panel-group__header"><span>Standpunkte</span></summary>' +
        '<div class="panel-group__body">' +
          '<div class="pano-spots" id="panoSpots"></div>' +
        '</div>' +
      '</details>' +

      '<div class="pano-steuer" id="panoSteuer" style="display:none;">' +
        '<button class="btn btn--sm" onclick="PanoTour.zurueck()" title="Voriger Nachbar (←)">‹</button>' +
        '<button class="btn btn--sm btn--ghost" onclick="PanoTour.verlassen()">Rundgang verlassen</button>' +
        '<button class="btn btn--sm" onclick="PanoTour.weiter()" title="Nächster Nachbar (→)">›</button>' +
      '</div>';
  }

  // ── Panel-Inhalt nachführen ────────────────────────────────────────────────

  function alles() {
    if (!T) return;
    var z = T.zustand();
    var zahl = document.getElementById('panoZahl');
    if (zahl) zahl.textContent = z.anzahl ? (z.anzahl + ' Spots') : '—';

    var liste = document.getElementById('panoSpots');
    if (liste) {
      if (!z.anzahl) {
        liste.innerHTML = '<div class="plan-hint">Noch keine Tour geladen.</div>';
      } else {
        liste.innerHTML = T.spots.map(function (s) {
          var aktiv = (s.id === z.aktiv) ? ' pano-spot--aktiv' : '';
          return '<button class="pano-spot' + aktiv + '" ' +
            'onclick="PanoTour.betreten(\'' + s.id + '\')">' +
            '<span class="pano-spot__punkt"></span>' +
            '<span class="pano-spot__name">' + esc(s.name) + '</span>' +
            '<span class="pano-spot__n">' + s.nachbarn.length + ' ⟶</span>' +
            '</button>';
        }).join('');
      }
    }

    var steuer = document.getElementById('panoSteuer');
    if (steuer) steuer.style.display = z.imRundgang ? 'flex' : 'none';
  }

  function status(text, art) {
    var el = document.getElementById('panoStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'plan-status' + (art ? ' plan-status--' + art : '');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ── Öffentliche Panel-Aktionen ──────────────────────────────────────────────

  var PanoTourPanel = {
    ladenUrl: async function () {
      var url = (document.getElementById('panoUrl') || {}).value;
      if (!url) return;
      await laden(url);
    },
    demo: async function () {
      var feld = document.getElementById('panoUrl');
      if (feld) feld.value = 'data/pano-demo/tour.json';
      await laden('data/pano-demo/tour.json');
    }
  };

  async function laden(url) {
    if (!T) T = window.PanoTour;
    if (!T) { status('Rundgang-Modul nicht bereit.', 'warn'); return; }
    status('Lade Tour …');
    try {
      var n = await T.laden(url);
      status(n + ' Spots geladen — Standpunkt anklicken.', 'ok');
    } catch (e) {
      status('Tour nicht ladbar: ' + e.message, 'warn');
    }
    alles();
  }

  // ── Panel einhängen ─────────────────────────────────────────────────────────

  function einhaengen() {
    var leiste = document.getElementById('activityBar');
    var seite = document.getElementById('sidebarPanel');
    if (!leiste || !seite) return false;
    if (document.getElementById('section-' + ID)) return true;

    var knopf = document.createElement('div');
    knopf.className = 'activity-btn';
    knopf.dataset.section = ID;
    knopf.title = '360°-Rundgang — von Standpunkt zu Standpunkt (wie Matterport)';
    knopf.innerHTML = '<span class="modern-section-icon">📷</span>';
    knopf.onclick = function () { BimViewerUI.activateSection(ID); };
    var unten = leiste.lastElementChild;
    if (unten && unten.style.marginTop === 'auto') leiste.insertBefore(knopf, unten);
    else leiste.appendChild(knopf);

    var panel = document.createElement('div');
    panel.className = 'sidebar-section';
    panel.id = 'section-' + ID;
    panel.style.display = 'none';
    panel.innerHTML =
      '<div class="modern-header" style="border-radius: 0 12px 0 0; padding: 12px 16px;">' +
        '<div class="modern-logo-title" style="font-size: 14px;">360°-Rundgang</div>' +
      '</div>' +
      '<div class="section-scroll-content" style="padding: 16px; overflow-y: auto; ' +
        'max-height: calc(100vh - 80px);">' + panelHtml() + '</div>';
    seite.appendChild(panel);

    alles();
    console.log('📷 PanoTour-Panel eingehängt');
    return true;
  }

  window.PanoTourPanel = PanoTourPanel;

  var versuche = 0;
  var timer = setInterval(function () {
    if (!window.BimViewer || !BimViewer.viewer || !window.BimViewerUI || !window.PanoTour) {
      if (++versuche > 90) clearInterval(timer);
      return;
    }
    T = window.PanoTour;
    if (!einhaengen() && ++versuche <= 90) return;
    clearInterval(timer);
    alles();
  }, 400);

  // Der Rundgang meldet jeden Zustandswechsel; das Panel zeichnet dann neu.
  document.addEventListener('pano:changed', alles);

  // Ein Sprachwechsel baut die Aktivitätsleiste neu auf (ui.js) und nimmt das
  // Panel mit — wie bei bauplaner-panel.js. Der Bestand lebt im Modul weiter.
  document.addEventListener('geobim:language-changed', function () {
    setTimeout(function () { einhaengen(); alles(); }, 0);
  });
})();
