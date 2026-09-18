/**
 * pano-tour-panel.js — Oberfläche zum 360°-Rundgang (pano-tour.js)
 *
 * Untergruppe „360°-Rundgang" im Asset-Browser, angemeldet über
 * `BimViewerUI.gruppeAnmelden('models', …)`. Der Rundgang selbst lebt in
 * pano-tour.js; hier steht nur, was die Oberfläche daraus macht: Tour laden,
 * Spots anklicken, hinein und wieder heraus.
 *
 * Vorher baute diese Datei Knopf und Panel von Hand ins DOM, weil
 * `addSection()` in ui.js eine lokale Funktion war. Dazu gehörten eine
 * Warteschleife, bis die Leiste stand, der Kunstgriff, den eigenen Knopf vor
 * dem Einklapp-Knopf einzufügen, und ein eigener Sprachwechsel-Haken — der
 * auf `geobim:language-changed` lauschte, ein Ereignis, das es unter diesem
 * Namen seit der Bereinigung nicht mehr gibt. Das Panel verschwand beim
 * Sprachwechsel deshalb spurlos. Die Anmeldung räumt alle drei Punkte ab.
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

      '<details class="panel-group" open id="panoBackendGruppe">' +
        '<summary class="panel-group__header">' +
          '<span>Backend-Touren</span>' +
          '<button class="btn btn--sm btn--ghost" onclick="event.preventDefault();PanoTourPanel.backendListe()" ' +
                  'title="Liste vom Backend neu holen">↻</button>' +
        '</summary>' +
        '<div class="panel-group__body">' +
          '<div class="pano-backend" id="panoBackend">' +
            '<div class="plan-hint">Wird geladen …</div>' +
          '</div>' +
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
    },

    // Touren aus dem Backend (GET /tour) holen und als klickbare Liste zeigen.
    backendListe: async function () {
      var el = document.getElementById('panoBackend');
      if (!el) return;
      var base = backendBasis();
      if (!base) {
        el.innerHTML = '<div class="plan-hint">Kein Backend konfiguriert — im ' +
          'Asset-Browser die Backend-URL setzen.</div>';
        return;
      }
      el.innerHTML = '<div class="plan-hint">Wird geladen …</div>';
      try {
        var r = await fetch(base + '/tour');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var liste = await r.json();
        if (!Array.isArray(liste) || !liste.length) {
          el.innerHTML = '<div class="plan-hint">Noch keine Touren im Backend. ' +
            'Mit <code>POST /tour</code> aus 360°-Fotos anlegen.</div>';
          return;
        }
        el.innerHTML = '';
        liste.forEach(function (t) {
          var url = base + (t.tour_url || ('/tour/' + t.tour_id + '/tour.json'));
          var b = document.createElement('button');
          b.className = 'pano-spot';
          b.title = t.erstellt ? ('angelegt ' + t.erstellt) : t.tour_id;
          b.innerHTML = '<span class="pano-spot__punkt"></span>' +
            '<span class="pano-spot__name">' + esc(t.name || t.tour_id) + '</span>' +
            '<span class="pano-spot__n">' + (t.anzahl || 0) + ' 📷</span>';
          b.addEventListener('click', function () { laden(url); });
          el.appendChild(b);
        });
      } catch (e) {
        el.innerHTML = '<div class="plan-hint">Backend nicht erreichbar: ' +
          esc(e.message) + '</div>';
      }
    }
  };

  // Backend-Basis ohne Schrägstrich am Ende; leer, wenn keins konfiguriert ist.
  function backendBasis() {
    var b = (window.BimViewer && BimViewer.getBackendUrl && BimViewer.getBackendUrl()) || '';
    return b ? b.replace(/\/+$/, '') : '';
  }

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

  // Anmeldung als Untergruppe des Asset-Browsers — nicht als eigenes Symbol in
  // der Leiste.
  //
  // Eine Tour ist nichts anderes als ein geladener Bestand: sie kommt aus
  // demselben Backend wie die Modelle, steht an denselben Koordinaten und wird
  // an derselben Stelle ausgewählt. Als vierzehntes Symbol in der
  // Aktivitätsleiste hätte sie die Frage „welche Daten liegen in der Szene"
  // auf zwei Orte verteilt.
  //
  // `inhalt` ist eine Funktion: der Sprachwechsel baut die Leiste neu auf und
  // holt sich das Markup dabei frisch.
  if (typeof BimViewerUI !== 'undefined') {
    BimViewerUI.gruppeAnmelden('models', {
      key: ID, ordnung: 40,
      label: '360°-Rundgang',
      inhalt: panelHtml,
    });
  }

  window.PanoTourPanel = PanoTourPanel;

  // Die Backend-Liste wird geholt, wenn die Gruppe aufgeklappt wird. Ein
  // eigener Bereich hatte dafür `beimOeffnen`; eine Untergruppe meldet ihr
  // Aufklappen über das `toggle`-Ereignis des `<details>`.
  document.addEventListener('toggle', function (e) {
    var el = e.target;
    if (el instanceof HTMLElement && el.id === 'group-' + ID && el.open) {
      PanoTourPanel.backendListe();
    }
  }, true);

  // Gewartet wird nur noch auf den Rundgang selbst — das Panel steht längst,
  // die Anmeldung oben hat es hingestellt. Vorher wartete diese Schleife auch
  // auf `BimViewerUI` und den Viewer, weil sie das DOM selbst zusammenbaute.
  var versuche = 0;
  var timer = setInterval(function () {
    if (!window.PanoTour) {
      if (++versuche > 90) clearInterval(timer);
      return;
    }
    T = window.PanoTour;
    clearInterval(timer);
    alles();
  }, 400);

  // Der Rundgang meldet jeden Zustandswechsel; das Panel zeichnet dann neu.
  document.addEventListener('pano:changed', alles);

  // Ein Sprachwechsel baut die Aktivitätsleiste neu auf (ui.js). Das Panel
  // kommt von selbst wieder mit, weil es angemeldet ist — nachzuzeichnen ist
  // nur der Bestand, der im Modul weiterlebt.
  document.addEventListener('ileen:language-changed', function () {
    setTimeout(alles, 0);
  });
})();
