/**
 * nav-hud.js — Compact Navigation HUD (bottom-right)
 * Kompass + Kamerahöhe im Kopf, darunter Walk / Fly / VR, eine Zeile je Schalter.
 */
(function () {
  'use strict';

  const CSS = `
    #navHud {
      position: fixed;
      bottom: 80px;
      right: 60px;
      z-index: 400;
      background: rgba(14, 17, 23, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 5px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-family: "Inter", "Helvetica Neue", sans-serif;
      min-width: 152px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(6px);
      user-select: none;
    }

    .nhud-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      height: 22px;
    }

    .nhud-label {
      font-size: 10.5px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.65);
      letter-spacing: 0.2px;
      flex: 1;
      white-space: nowrap;
    }

    .nhud-label .nhud-icon {
      margin-right: 5px;
      font-size: 11px;
    }

    /* Toggle switch */
    .nhud-switch {
      position: relative;
      width: 30px;
      height: 16px;
      flex-shrink: 0;
    }

    .nhud-switch input {
      opacity: 0;
      width: 0;
      height: 0;
      position: absolute;
    }

    .nhud-slider {
      position: absolute;
      inset: 0;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      cursor: pointer;
      transition: background 0.22s;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }

    .nhud-slider::before {
      content: "";
      position: absolute;
      width: 10px;
      height: 10px;
      left: 2px;
      bottom: 2px;
      background: rgba(255, 255, 255, 0.55);
      border-radius: 50%;
      transition: transform 0.22s, background 0.22s;
    }

    .nhud-switch input:checked + .nhud-slider {
      background: rgba(151, 191, 13, 0.25);
      border-color: #97BF0D;
    }

    .nhud-switch input:checked + .nhud-slider::before {
      transform: translateX(14px);
      background: #97BF0D;
    }

    /* Active label highlight */
    .nhud-row.active .nhud-label {
      color: #97BF0D;
    }

    /* Geschwindigkeitsstufen */
    .nhud-speed {
      display: flex;
      justify-content: space-between;
      gap: 2px;
      padding-bottom: 2px;
    }

    .nhud-speed button {
      flex: 1;
      height: 15px;
      padding: 0;
      font-family: inherit;
      font-size: 9px;
      line-height: 1;
      color: rgba(255, 255, 255, 0.55);
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 3px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }

    .nhud-speed button:hover {
      background: rgba(255, 255, 255, 0.14);
      color: rgba(255, 255, 255, 0.85);
    }

    .nhud-speed button.active {
      color: #0e1117;
      background: #97BF0D;
      border-color: #97BF0D;
      font-weight: 700;
    }

    .nhud-readout {
      font-size: 9.5px;
      font-variant-numeric: tabular-nums;
      color: rgba(255, 255, 255, 0.45);
    }

    .nhud-readout.ramping {
      color: #97BF0D;
    }

    /* Divider */
    .nhud-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.08);
      margin: 2px 0;
    }

    /* Kompass + Höhe */
    .nhud-nav {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 1px 0 3px;
    }

    .nhud-compass {
      width: 52px;
      height: 52px;
      flex-shrink: 0;
      padding: 0;
      margin: 0;
      border: 0;
      background: none;
      border-radius: 50%;
      line-height: 0;
      cursor: pointer;
      transition: filter 0.15s;
    }

    .nhud-compass:hover { filter: brightness(1.35); }

    .nhud-compass:focus-visible {
      outline: 1px solid #97BF0D;
      outline-offset: 2px;
    }

    .nhud-compass svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    .nhud-compass svg text {
      font-family: inherit;
    }

    .nhud-nav-values {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .nhud-nav-row {
      display: flex;
      align-items: baseline;
      gap: 4px;
      white-space: nowrap;
      font-size: 9px;
      color: rgba(255, 255, 255, 0.4);
    }

    .nhud-nav-row b {
      font-size: 10.5px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: rgba(255, 255, 255, 0.82);
    }

    .nhud-nav-row.nhud-nav-heading b {
      color: #97BF0D;
    }
  `;

  function injectCSS() {
    const s = document.createElement('style');
    s.id = 'navHudStyle';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // =========================================================================
  // KOMPASS UND HÖHE
  // =========================================================================
  //
  // Beides beantwortet dieselbe Frage in zwei Richtungen: wo stehe ich, und
  // wohin schaue ich. Deshalb sitzen sie in einer Zeile über den Schaltern —
  // die Kompassrose links, die Höhen rechts daneben.

  const AKZENT = '#97BF0D';

  const NAV_TEXTE = {
    de: {
      rose: ['N', 'O', 'S', 'W'],
      richtungen: ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'],
      nhn: 'NHN',
      ell: 'ell.',
      grund: 'Grund',
      komma: ',',
      tausender: '.',
      hinweis: 'Nach Norden ausrichten (Taste N)',
      titelHoehe: 'Kamerahöhe über Meer (EGM96); ohne Geoidgitter über dem Ellipsoid',
      titelGrund: 'Kamerahöhe über dem Gelände unter der Kamera',
    },
    en: {
      rose: ['N', 'E', 'S', 'W'],
      richtungen: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
      nhn: 'MSL',
      ell: 'ell.',
      grund: 'ground',
      komma: '.',
      tausender: ',',
      hinweis: 'Face north (key N)',
      titelHoehe: 'Camera height above sea level (EGM96); above the ellipsoid without the geoid grid',
      titelGrund: 'Camera height above the terrain below',
    },
  };

  const STRICH = '–';

  function navTexte(sprache) {
    return NAV_TEXTE[sprache] || NAV_TEXTE.de;
  }

  function spracheJetzt() {
    if (typeof ILeenI18n !== 'undefined' && ILeenI18n.getLanguage) {
      return ILeenI18n.getLanguage();
    }
    return 'de';
  }

  /** Bogenmaß der Cesium-Kamera → Grad im Bereich [0, 360). */
  function kursGrad(rad) {
    if (typeof rad !== 'number' || !isFinite(rad)) return 0;
    const g = (rad * 180) / Math.PI;
    return ((g % 360) + 360) % 360;
  }

  /** Um diesen Winkel wird die Rose gedreht, damit ihr N nach Norden zeigt. */
  function roseDrehung(rad) {
    return -kursGrad(rad);
  }

  /** Grad → Himmelsrichtung in acht Sektoren, jeder 45° breit. */
  function himmelsrichtung(grad, sprache) {
    const namen = navTexte(sprache).richtungen;
    const g = ((grad % 360) + 360) % 360;
    return namen[Math.round(g / 45) % 8];
  }

  /**
   * Meter als Anzeigetext. Unter 100 m mit einer Nachkommastelle — im Gebäude
   * ist der Unterschied zwischen 1,8 m und 2 m der zwischen Augenhöhe und
   * Sturzunterkante. Ab 10 km in Kilometern, sonst wächst die Zeile aus dem HUD.
   */
  function formatHoehe(m, sprache) {
    if (typeof m !== 'number' || !isFinite(m)) return STRICH;
    const t = navTexte(sprache);
    const betrag = Math.abs(m);
    if (betrag >= 10000) {
      const km = m / 1000;
      const text = Math.abs(km) >= 1000
        ? String(Math.round(km))
        : km.toFixed(1).replace('.', t.komma);
      return gruppiere(text, t.tausender) + ' km';
    }
    if (betrag >= 100) return gruppiere(String(Math.round(m)), t.tausender) + ' m';
    return m.toFixed(1).replace('.', t.komma) + ' m';
  }

  /** Tausenderpunkte in den Vorkommateil, Vorzeichen bleibt vorn. */
  function gruppiere(text, trenner) {
    const m = /^(-?)(\d+)(.*)$/.exec(text);
    if (!m) return text;
    return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, trenner) + m[3];
  }

  /** SVG der Rose. Die Buchstaben wechseln mit der Sprache (O ↔ E). */
  function roseSvg(sprache) {
    const buchstaben = navTexte(sprache).rose;

    let striche = '';
    for (let a = 0; a < 360; a += 45) {
      const haupt = a % 90 === 0;
      striche +=
        '<line x1="50" y1="' + (haupt ? 8 : 9) + '" x2="50" y2="' + (haupt ? 14 : 13) + '" ' +
        'stroke="rgba(255,255,255,' + (haupt ? 0.45 : 0.2) + ')" ' +
        'stroke-width="' + (haupt ? 2 : 1.4) + '" stroke-linecap="round" ' +
        'transform="rotate(' + a + ' 50 50)"/>';
    }

    let text = '';
    buchstaben.forEach((b, i) => {
      const bogen = ((i * 90 - 90) * Math.PI) / 180;
      const x = 50 + 31 * Math.cos(bogen);
      const y = 50 + 31 * Math.sin(bogen);
      const nord = i === 0;
      text +=
        '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" ' +
        'dominant-baseline="central" font-size="16" font-weight="' + (nord ? 700 : 500) + '" ' +
        'fill="' + (nord ? AKZENT : 'rgba(255,255,255,0.5)') + '">' + b + '</text>';
    });

    return '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<circle cx="50" cy="50" r="44" fill="rgba(255,255,255,0.05)" ' +
      'stroke="rgba(255,255,255,0.16)" stroke-width="1.5"/>' +
      '<g class="nhud-rose-dial">' + striche + text +
        '<path d="M50 30 L55.5 50 L44.5 50 Z" fill="' + AKZENT + '"/>' +
        '<path d="M50 70 L55.5 50 L44.5 50 Z" fill="rgba(255,255,255,0.28)"/>' +
        '<circle cx="50" cy="50" r="3" fill="rgba(14,17,23,0.9)" ' +
        'stroke="rgba(255,255,255,0.35)" stroke-width="1"/>' +
      '</g>' +
      '<path d="M50 0.5 L54.5 6 L45.5 6 Z" fill="rgba(255,255,255,0.8)"/>' +
      '</svg>';
  }

  /**
   * Kamera nach Norden drehen, Standpunkt und Neigung bleiben.
   * Im Walk- und Flugmodus führt walkMode.js die Kamera jedes Bild neu — ein
   * setView von außen wäre nach einem Frame wieder überschrieben, deshalb
   * dort über dessen eigenen Kurs.
   */
  function nachNorden() {
    const viewer = (typeof BimViewer !== 'undefined') ? BimViewer.viewer : null;
    if (!viewer || !viewer.camera) return;

    if (typeof WalkMode !== 'undefined' && WalkMode.isEnabled &&
        WalkMode.isEnabled() && WalkMode.setHeading) {
      WalkMode.setHeading(0);
      return;
    }

    const kamera = viewer.camera;
    kamera.flyTo({
      destination: kamera.positionWC.clone(),
      orientation: { heading: 0, pitch: kamera.pitch, roll: 0 },
      duration: 0.5,
    });
  }

  function buildRow(id, icon, label) {
    const row = document.createElement('div');
    row.className = 'nhud-row';
    row.id = 'nhud-row-' + id;

    const lbl = document.createElement('span');
    lbl.className = 'nhud-label';
    lbl.innerHTML = `<span class="nhud-icon">${icon}</span>${label}`;

    const sw = document.createElement('label');
    sw.className = 'nhud-switch';

    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.id = 'nhud-cb-' + id;

    const slider = document.createElement('span');
    slider.className = 'nhud-slider';

    sw.appendChild(inp);
    sw.appendChild(slider);
    row.appendChild(lbl);
    row.appendChild(sw);

    return { row, inp };
  }

  function createHUD() {
    if (document.getElementById('navHud')) return;

    injectCSS();

    const hud = document.createElement('div');
    hud.id = 'navHud';

    // --- Walk ---
    const { row: walkRow, inp: walkCb } = buildRow('walk', '🚶', 'Walk');
    // --- Fly ---
    const { row: flyRow, inp: flyCb } = buildRow('fly', '✈️', 'Fly');

    // --- Geschwindigkeit: Stufe 0 (Rampe) + Stufen 1-6 ---
    const speedRow = document.createElement('div');
    speedRow.className = 'nhud-row';
    const speedLbl = document.createElement('span');
    speedLbl.className = 'nhud-label';
    speedLbl.innerHTML = '<span class="nhud-icon">⏱</span>Speed';
    const speedVal = document.createElement('span');
    speedVal.className = 'nhud-readout';
    speedVal.id = 'nhud-speed-value';
    speedVal.textContent = '7 m/s';
    speedRow.appendChild(speedLbl);
    speedRow.appendChild(speedVal);

    const speedBtns = document.createElement('div');
    speedBtns.className = 'nhud-speed';
    // Stufe 0 = Rampe: startet unter Stufe 1 und beschleunigt, solange man
    // hält, bis nach 5 s die Höchstgeschwindigkeit von Stufe 6 ansteht.
    const SPEED_BUTTONS = [
      { lvl: -1, label: '0', title: 'Stufe 0 — beschleunigt: 0,8 m/s bis 200 m/s in 5 s' },
      { lvl: 0, label: '1', title: '1 m/s' },
      { lvl: 1, label: '2', title: '3 m/s' },
      { lvl: 2, label: '3', title: '7 m/s' },
      { lvl: 3, label: '4', title: '20 m/s' },
      { lvl: 4, label: '5', title: '60 m/s' },
      { lvl: 5, label: '6', title: '200 m/s' },
    ];
    SPEED_BUTTONS.forEach(spec => {
      const b = document.createElement('button');
      b.textContent = spec.label;
      b.title = spec.title;
      b.dataset.lvl = String(spec.lvl);
      b.addEventListener('click', () => {
        if (typeof BimViewer !== 'undefined' && BimViewer.setWalkSpeedLevel) {
          BimViewer.setWalkSpeedLevel(spec.lvl);
        }
      });
      speedBtns.appendChild(b);
    });

    const div1 = document.createElement('div');
    div1.className = 'nhud-divider';

    // --- VR ---
    const { row: vrRow, inp: vrCb } = buildRow('vr', '🥽', 'VR');

    // --- Kompass + Höhe (Kopfzeile) ---
    const navBlock = document.createElement('div');
    navBlock.className = 'nhud-nav';

    const compassBtn = document.createElement('button');
    compassBtn.type = 'button';
    compassBtn.className = 'nhud-compass';
    compassBtn.id = 'nhud-compass';

    const navValues = document.createElement('div');
    navValues.className = 'nhud-nav-values';

    function buildNavRow(cls) {
      const row = document.createElement('div');
      row.className = 'nhud-nav-row' + (cls ? ' ' + cls : '');
      const wert = document.createElement('b');
      wert.textContent = STRICH;
      const bezug = document.createElement('span');
      row.appendChild(wert);
      row.appendChild(bezug);
      navValues.appendChild(row);
      return { row, wert, bezug };
    }

    const kursZeile = buildNavRow('nhud-nav-heading');
    const hoeheZeile = buildNavRow('');
    const grundZeile = buildNavRow('');

    navBlock.appendChild(compassBtn);
    navBlock.appendChild(navValues);

    const div0 = document.createElement('div');
    div0.className = 'nhud-divider';

    let roseSprache = null;
    let roseDial = null;

    function zeichneRose(sprache) {
      const t = navTexte(sprache);
      compassBtn.innerHTML = roseSvg(sprache);
      compassBtn.title = t.hinweis;
      compassBtn.setAttribute('aria-label', t.hinweis);
      hoeheZeile.row.title = t.titelHoehe;
      grundZeile.row.title = t.titelGrund;
      roseDial = compassBtn.querySelector('.nhud-rose-dial');
      roseSprache = sprache;
    }

    zeichneRose(spracheJetzt());
    compassBtn.addEventListener('click', nachNorden);
    document.addEventListener('ileen:language-changed', () => {
      zeichneRose(spracheJetzt());
      syncNav();
    });

    hud.appendChild(navBlock);
    hud.appendChild(div0);
    hud.appendChild(walkRow);
    hud.appendChild(flyRow);
    hud.appendChild(speedRow);
    hud.appendChild(speedBtns);
    hud.appendChild(div1);
    hud.appendChild(vrRow);

    document.body.appendChild(hud);

    // ---- Walk toggle ----
    walkCb.addEventListener('change', () => {
      if (typeof BimViewer !== 'undefined' && BimViewer.toggleWalkMode) {
        BimViewer.toggleWalkMode('walk');
      }
    });

    // ---- Fly toggle ----
    flyCb.addEventListener('change', () => {
      if (typeof BimViewer !== 'undefined' && BimViewer.toggleWalkMode) {
        BimViewer.toggleWalkMode('fly');
      }
    });

    // ---- VR toggle ----
    vrCb.addEventListener('change', () => {
      if (typeof BimViewer !== 'undefined' && BimViewer.toggleVR) {
        BimViewer.toggleVR();
      }
    });

    // ---- Sync HUD switches from hidden DOM buttons (core.js sets .active class) ----
    function syncFromCore() {
      const wBtn = document.getElementById('toggleWalkMode');
      const fBtn = document.getElementById('toggleFlyMode');
      if (!wBtn || !fBtn) return;

      const wActive = wBtn.classList.contains('active');
      const fActive = fBtn.classList.contains('active');

      walkCb.checked = wActive;
      walkRow.classList.toggle('active', wActive);

      flyCb.checked = fActive;
      flyRow.classList.toggle('active', fActive);
    }

    // ---- Speed-Anzeige aus WalkMode ziehen ----
    // Stufe 0 ändert ihren Wert jeden Frame, deshalb gepollt statt Event-getrieben.
    function syncSpeed() {
      if (typeof WalkMode === 'undefined' || !WalkMode.getSpeedLevel) return;
      const lvl = WalkMode.getSpeedLevel();
      speedBtns.querySelectorAll('button').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.lvl, 10) === lvl);
      });
      const v = WalkMode.getSpeedValue();
      speedVal.textContent = WalkMode.formatSpeed ? WalkMode.formatSpeed(v) : v + ' m/s';
      speedVal.classList.toggle('ramping', lvl === -1);
    }
    syncSpeed();
    setInterval(syncSpeed, 100);

    // ---- Kompass und Höhe aus der Kamera ziehen ----
    // Gepollt statt an camera.changed gehängt: dessen Schwelle liegt bei einem
    // halben Bildausschnitt, eine Vierteldrehung auf der Stelle bliebe unbemerkt.
    function setzeText(el, text) {
      if (el.textContent !== text) el.textContent = text;
    }

    function syncNav() {
      const sprache = spracheJetzt();
      if (sprache !== roseSprache) zeichneRose(sprache);
      const t = navTexte(sprache);

      const viewer = (typeof BimViewer !== 'undefined') ? BimViewer.viewer : null;
      const kamera = viewer && viewer.camera;
      const carto = kamera && kamera.positionCartographic;
      if (!carto) {
        setzeText(kursZeile.wert, STRICH);
        setzeText(kursZeile.bezug, '');
        setzeText(hoeheZeile.wert, STRICH);
        setzeText(hoeheZeile.bezug, '');
        setzeText(grundZeile.wert, STRICH);
        setzeText(grundZeile.bezug, t.grund);
        return;
      }

      const grad = kursGrad(kamera.heading);
      if (roseDial) {
        roseDial.setAttribute('transform', 'rotate(' + roseDrehung(kamera.heading).toFixed(1) + ' 50 50)');
      }
      setzeText(kursZeile.wert, (Math.round(grad) % 360) + '°');
      setzeText(kursZeile.bezug, himmelsrichtung(grad, sprache));

      // Höhe: das Ellipsoid ist kein Meeresspiegel — über Rheinland-Pfalz
      // liegen rund 47 m zwischen beiden. Mit geladenem EGM96-Gitter steht
      // deshalb NHN in der Zeile, ohne es ehrlich „ell.".
      const hoehe = carto.height;
      let anzeige = hoehe;
      let bezug = t.ell;
      if (typeof ILEEN_GEOID !== 'undefined' && ILEEN_GEOID.toOrthometric) {
        const orth = ILEEN_GEOID.toOrthometric(
          hoehe, (carto.latitude * 180) / Math.PI, (carto.longitude * 180) / Math.PI);
        if (orth) {
          anzeige = orth.orthometric;
          bezug = t.nhn;
        }
      }
      setzeText(hoeheZeile.wert, formatHoehe(anzeige, sprache));
      setzeText(hoeheZeile.bezug, bezug);

      // Über Grund: globe.getHeight liest nur die schon geladene Geländekachel
      // und rendert nichts nach — bei fehlender Kachel gibt es undefined
      // zurück, und dann steht hier ein Strich statt einer erfundenen Zahl.
      let ueberGrund = null;
      const globe = viewer.scene && viewer.scene.globe;
      if (globe && typeof globe.getHeight === 'function') {
        const gelaende = globe.getHeight(carto);
        if (typeof gelaende === 'number' && isFinite(gelaende)) {
          ueberGrund = hoehe - gelaende;
        }
      }
      setzeText(grundZeile.wert, ueberGrund === null ? STRICH : formatHoehe(ueberGrund, sprache));
      setzeText(grundZeile.bezug, t.grund);
    }

    syncNav();
    setInterval(syncNav, 150);

    const obs = new MutationObserver(syncFromCore);
    const observeWhenReady = () => {
      const w = document.getElementById('toggleWalkMode');
      const f = document.getElementById('toggleFlyMode');
      if (w && f) {
        obs.observe(w, { attributes: true, attributeFilter: ['class'] });
        obs.observe(f, { attributes: true, attributeFilter: ['class'] });
      } else {
        setTimeout(observeWhenReady, 500);
      }
    };
    observeWhenReady();

    // ---- Keyboard shortcut: N richtet die Kamera nach Norden ----
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      e.preventDefault();
      nachNorden();
    });

    // F (Flugmodus starten, Blickrichtung umschalten) und Shift+F (Gehen ↔
    // Fliegen) liegen in flug-trackpad.js — die Taste steht dort an einer
    // Stelle statt an dreien.
  }

  // Init after DOM is ready — wait for BimViewer to exist
  function waitAndInit() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', waitAndInit);
      return;
    }
    // Small delay so other modules attach first
    setTimeout(createHUD, 800);
  }

  waitAndInit();

  // Die reine Rechnerei nach außen — die Prüfung in tests/navigation kommt
  // ohne Browser aus und fasst dafür kein DOM an.
  window.NavHud = {
    kursGrad,
    roseDrehung,
    himmelsrichtung,
    formatHoehe,
    roseSvg,
    nachNorden,
    TEXTE: NAV_TEXTE,
  };
})();
