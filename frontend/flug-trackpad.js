/**
 * flug-trackpad.js — Fliegen am Trackpad, ohne Maus und ohne Pointer Lock
 *
 * Der Flugmodus in `walkMode.js` war für die Maus gebaut: umsehen ging nur mit
 * gedrückter Taste oder über Pointer Lock, und Pointer Lock nimmt einem den
 * Zeiger weg. Am Trackpad ist beides unbrauchbar. Dieses Modul legt die
 * Bedienung darüber, die ein Trackpad tatsächlich hergibt:
 *
 *   Fadenkreuz      steht FEST in der Bildmitte — dort, wohin `W` fliegt und
 *                   wohin die Kamera sieht.
 *   Maus/1 Finger   umsehen — im Blickrichtungsmodus (Taste F), mit
 *                   gefangenem Zeiger.
 *   2 Finger        die Ansicht schieben: seitlich und hoch/runter fliegen.
 *   2 Finger auf/zu Öffnungswinkel (FOV) — im Blickrichtungsmodus abgeschaltet,
 *                   dort gehört die Fläche dem Umsehen.
 *   WASD            fliegt immer, auch außerhalb des Flugmodus. Nur nicht,
 *                   während in einem Schriftfeld getippt wird.
 *
 * Das Fadenkreuz steht in der Mitte, weil der Zeiger gefangen ist
 * ================================================================
 * Bis September 2026 führte das Fadenkreuz eine EIGENE Lage: es wanderte um
 * dieselben Differenzen wie der Systemzeiger, wurde am Canvasrand geklemmt,
 * lief nach zwei Sekunden Ruhe in die Mitte zurück, und im Randstreifen drehte
 * die Kamera von selbst weiter. Jede dieser vier Regeln für sich war
 * begründbar, zusammen ergaben sie eine Bedienung, die man nicht vorhersagen
 * kann:
 *
 *   · Der Systemzeiger lief weiter, das Kreuz nicht — am Bildrand standen
 *     beide sichtbar auseinander, und der echte Zeiger war plötzlich da.
 *   · Dieselbe Handbewegung drehte verschieden weit, je nachdem ob das Kreuz
 *     gerade in der Fläche stand (1:1), im Randstreifen (zusätzlich bis
 *     1,4 rad/s) oder gerade heimlief (gar nicht).
 *
 * Jetzt wird im Blickrichtungsmodus der Zeiger eingefangen
 * (`requestPointerLock`). Damit ist es die Bedienung, die jeder aus einem
 * Ego-Shooter kennt: Kreuz in der Mitte, kein Systemzeiger, jede Bewegung
 * dreht um denselben Betrag je Pixel, und es gibt keinen Rand, an dem etwas
 * anderes passiert. Klemmen, Heimlauf und Randlenkung sind damit ersatzlos
 * entfallen — nicht abgeschaltet, sondern gegenstandslos.
 *
 * Der Rückfallweg bleibt: Pointer Lock kann scheitern (Browserrichtlinie,
 * zu kurz nach einem vorherigen `exitPointerLock`, eingebettete Seite). Dann
 * gilt wieder die Bewegungsdifferenz des freien Zeigers — ohne Klemmen und
 * ohne Randlenkung, denn beides ergab nur im Verbund mit dem wandernden Kreuz
 * einen Sinn.
 */
'use strict';

window.FlugTrackpad = (function () {

  // ── Zustand ───────────────────────────────────────────────────────────
  let viewer = null;
  let canvas = null;
  let blickModus = false;          // Taste F — die Maus dreht die Kamera
  let fadenkreuz = null;           // DOM-Element
  let zeigerGefangen = false;      // Pointer Lock liegt bei uns
  let lockErbeten = false;         // Lock angefordert, Antwort steht aus
  let letzterZeiger = null;        // Bewegungsdifferenz im Rückfallweg
  let entferneVorBild = null;
  let letzteZeit = 0;

  // ── Einstellungen ─────────────────────────────────────────────────────
  const DREH_JE_PIXEL = 0.0035;    // rad/px beim Umsehen — die Grundempfindlichkeit
  const SCHIEBE_JE_PIXEL = 0.006;  // Sekunden Flugzeit je Pixel Wischweg
  const FOV_JE_PIXEL = 0.01;       // Aufziehen → Öffnungswinkel
  const FOV_MIN = 20, FOV_MAX = 120;
  const PITCH_GRENZE = Math.PI / 2 - 0.01;

  // Empfindlichkeit als Faktor auf DREH_JE_PIXEL. Eine Maus mit 400 dpi und
  // eine mit 3200 dpi liefern für dieselbe Handbewegung ein Achtfaches an
  // Pixeln; ohne Stellschraube ist die Bedienung für eine der beiden falsch.
  const EMPF_MIN = 0.2, EMPF_MAX = 5.0;
  const EMPF_SCHLUESSEL = 'ileen.flug.empfindlichkeit';
  let empfindlichkeit = 1.0;
  try {
    const gemerkt = parseFloat(localStorage.getItem(EMPF_SCHLUESSEL));
    if (isFinite(gemerkt) && gemerkt > 0) {
      empfindlichkeit = Math.max(EMPF_MIN, Math.min(EMPF_MAX, gemerkt));
    }
  } catch (e) { /* privates Fenster */ }

  // ── Tastenzustand des Dauerflugs ──────────────────────────────────────
  const tasten = { vor: false, zurueck: false, links: false, rechts: false, hoch: false, runter: false };

  // =========================================================================
  // REINE RECHNEREI — ohne DOM, ohne Cesium (Prüfsteine hängen hier)
  // =========================================================================

  /**
   * Öffnungswinkel aus dem Aufziehen. Multiplikativ, damit ein Schritt bei
   * 30° dieselbe gefühlte Größe hat wie bei 90°. Aufziehen (zwei Finger
   * auseinander) meldet negatives deltaY → kleinerer Winkel, also Tele.
   */
  function pinchFov(fovGrad, deltaY) {
    const neu = fovGrad * Math.exp(deltaY * FOV_JE_PIXEL);
    return Math.max(FOV_MIN, Math.min(FOV_MAX, neu));
  }

  /**
   * Wischweg in Metern. Gekoppelt an die Fluggeschwindigkeit, nicht an eine
   * feste Zahl: im Anschlussdetail bei 1 m/s schiebt derselbe Wisch
   * zentimeterweise, über dem Quartier bei 200 m/s hunderte Meter — genau die
   * Staffelung, die die Geschwindigkeitsstufen ohnehin schon meinen.
   */
  function schiebeWeg(deltaPixel, tempoMs) {
    return deltaPixel * SCHIEBE_JE_PIXEL * tempoMs;
  }

  /**
   * Drehwinkel aus einem Mausweg, in Radiant. Eine Zeile, aber die eine
   * Stelle, an der die Empfindlichkeit steht — vorher stand der Faktor an
   * drei Stellen im Code und die Randlenkung rechnete noch einmal anders.
   */
  function drehWinkel(pixel) {
    return pixel * DREH_JE_PIXEL * empfindlichkeit;
  }

  function empfindlichkeitSetzen(wert) {
    const v = parseFloat(wert);
    if (!isFinite(v)) return empfindlichkeit;
    empfindlichkeit = Math.max(EMPF_MIN, Math.min(EMPF_MAX, v));
    try { localStorage.setItem(EMPF_SCHLUESSEL, String(empfindlichkeit)); } catch (e) { /* privat */ }
    return empfindlichkeit;
  }

  /**
   * Wird gerade geschrieben? Dann gehören W, A, S und D ins Textfeld und
   * nicht in die Kamera. `select` zählt mit: dort tippt man den Eintrag an.
   */
  function istSchriftfeld(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /** Radweg in Pixeln, unabhängig davon, ob Zeilen oder Seiten gemeldet werden. */
  function radWeg(delta, modus) {
    return delta * (modus === 1 ? 16 : modus === 2 ? 400 : 1);
  }

  // =========================================================================
  // FADENKREUZ
  // =========================================================================

  // Vier Striche mit Lücke, ein Punkt in der Mitte, ein dezenter Ring: die
  // Form, die jeder kennt. Der dunkle Unterstrich darunter hält sie auch vor
  // einer weißen Fassade lesbar — eine rein weiße Zeichnung verschwindet dort,
  // und ein Fadenkreuz, das man suchen muss, ist keines.
  const KREUZ_SVG = [
    '<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">',
    '<g fill="none" stroke="#0a1016" stroke-opacity="0.6" stroke-width="3.2" stroke-linecap="round">',
    '<path d="M20 5v8M20 27v8M5 20h8M27 20h8"/></g>',
    '<g fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round">',
    '<path d="M20 5v8M20 27v8M5 20h8M27 20h8"/></g>',
    '<circle cx="20" cy="20" r="6" fill="none" stroke="#97BF0D" stroke-width="1" stroke-opacity="0.7"/>',
    '<circle cx="20" cy="20" r="2.2" fill="#0a1016" fill-opacity="0.6"/>',
    '<circle cx="20" cy="20" r="1.3" fill="#97BF0D"/>',
    '</svg>',
  ].join('');

  function kreuzElement() {
    if (fadenkreuz) return fadenkreuz;
    fadenkreuz = document.createElement('div');
    fadenkreuz.id = 'flugFadenkreuz';
    fadenkreuz.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:40px', 'height:40px',
      'margin:-20px 0 0 -20px', 'pointer-events:none', 'z-index:9998',
      'display:none', 'will-change:transform',
      'filter:drop-shadow(0 0 3px rgba(0,0,0,0.45))',
    ].join(';');
    fadenkreuz.innerHTML = KREUZ_SVG;
    document.body.appendChild(fadenkreuz);
    return fadenkreuz;
  }

  /**
   * Das Kreuz steht in der Bildmitte. Immer — mit gefangenem Zeiger sowieso,
   * und im Rückfallweg ebenfalls: dort ist der Systemzeiger sichtbar und
   * übernimmt das Zeigen, ein zweites Kreuz daneben wäre der Zustand, aus dem
   * die alte Fassung nie herausgefunden hat.
   */
  function kreuzZeichnen() {
    const el = kreuzElement();
    if (!sichtbar()) { el.style.display = 'none'; return; }
    const r = canvas.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.display = 'block';
  }

  function sichtbar() {
    return !!canvas && typeof WalkMode !== 'undefined'
      && WalkMode.isEnabled() && WalkMode.getMode() === 'fly';
  }

  // =========================================================================
  // BLICKRICHTUNGSMODUS
  // =========================================================================

  function blickSetzen(an) {
    const neu = !!an && flugAktiv();
    if (neu === blickModus) { hinweisNachziehen(); return blickModus; }
    blickModus = neu;
    letzterZeiger = null;
    if (canvas) canvas.style.cursor = blickModus ? 'none' : '';
    if (blickModus) zeigerFangen();
    else zeigerFreigeben();
    hinweisNachziehen();
    kreuzZeichnen();
    return blickModus;
  }

  function blickUmschalten() {
    if (!flugAktiv()) {
      // Aus dem Normalzustand heraus ist F der ganze Weg: Flugmodus an und
      // gleich umsehen können. Der Modus hängt seine eigenen Hörer erst im
      // nächsten Tick an, deshalb der Umweg über setTimeout.
      if (typeof BimViewer === 'undefined' || !BimViewer.toggleWalkMode) return false;
      setTimeout(() => { BimViewer.toggleWalkMode('fly'); blickSetzen(true); }, 0);
      return true;
    }
    return blickSetzen(!blickModus);
  }

  function flugAktiv() {
    return typeof WalkMode !== 'undefined' && WalkMode.isEnabled() && WalkMode.getMode() === 'fly';
  }

  /**
   * Eigene Zeile über dem Hinweisband von walkMode.js statt eines Anhängsels
   * an dessen Text: der wird bei jeder Geschwindigkeitsänderung neu gesetzt —
   * in Stufe 0 zehnmal je Sekunde — und würde jeden Zusatz gleich wieder
   * überschreiben.
   */
  let hinweisStand = null;

  function hinweisNachziehen() {
    const stand = flugAktiv() ? (blickModus ? 'blick' : 'flug') : 'aus';
    if (stand === hinweisStand) return;   // läuft in jedem Bild — nur bei Wechsel schreiben
    hinweisStand = stand;
    let el = document.getElementById('flugTrackpadHinweis');
    if (stand === 'aus') { if (el) el.style.display = 'none'; return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'flugTrackpadHinweis';
      el.style.cssText = [
        'position:fixed', 'bottom:62px', 'left:50%', 'transform:translateX(-50%)',
        'background:rgba(10,16,22,0.88)', 'backdrop-filter:blur(12px)',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'font-size:11px', 'font-weight:600', 'letter-spacing:0.4px',
        'padding:7px 16px', 'border-radius:16px', 'z-index:9999',
        'pointer-events:none', 'text-align:center',
        'box-shadow:0 4px 24px rgba(0,0,0,0.4)',
      ].join(';');
      document.body.appendChild(el);
    }
    if (blickModus) {
      el.textContent = zeigerGefangen
        ? 'Blickrichtung — Maus: umsehen | WASD: fliegen | 2 Finger: schieben | F oder Esc: aus'
        : 'Blickrichtung — Zeiger bewegen: umsehen | 2 Finger: schieben | F: aus';
      el.style.color = '#97BF0D';
      el.style.border = '1px solid rgba(151,191,13,0.5)';
    } else {
      el.textContent = '2 Finger: schieben | 2 Finger aufziehen: Öffnungswinkel | F: Blickrichtung';
      el.style.color = 'rgba(230,238,245,0.75)';
      el.style.border = '1px solid rgba(255,255,255,0.12)';
    }
    el.style.display = 'block';
  }

  // =========================================================================
  // ZEIGER — umsehen mit einem Finger
  // =========================================================================

  /**
   * Umsehen. Mit gefangenem Zeiger ist `movementX/Y` genau der Weg, den die
   * Hand zurückgelegt hat — unbegrenzt, ohne Bildschirmrand, und in jedem
   * Bild derselbe Betrag je Pixel. Ohne Lock bleibt die Differenz aufeinander
   * folgender Lagen; die endet am Bildrand, aber sie tut wenigstens nichts
   * Unerwartetes davor.
   */
  function _onPointerMove(e) {
    if (!blickModus || !flugAktiv()) { letzterZeiger = null; return; }

    let dx, dy;
    if (zeigerGefangen) {
      dx = e.movementX || 0;
      dy = e.movementY || 0;
    } else {
      if (!ueberCanvas(e.clientX, e.clientY)) { letzterZeiger = null; return; }
      dx = letzterZeiger ? e.clientX - letzterZeiger.x : 0;
      dy = letzterZeiger ? e.clientY - letzterZeiger.y : 0;
      letzterZeiger = { x: e.clientX, y: e.clientY };
    }
    if (!dx && !dy) return;

    // Mit gedrückter Taste dreht walkMode.js selbst — sonst käme die Drehung
    // doppelt an. Mit gefangenem Zeiger tut es das nicht: dort steigt
    // walkMode.js aus, sobald der Blickrichtungsmodus läuft.
    if (zeigerGefangen || !e.buttons) drehen(drehWinkel(dx), -drehWinkel(dy));
  }

  // ── Zeiger fangen ───────────────────────────────────────────────────────

  function zeigerFangen() {
    if (!canvas || zeigerGefangen || lockErbeten) return;
    if (!canvas.requestPointerLock) return;      // altes WebKit, Rückfallweg gilt
    lockErbeten = true;
    try {
      // Chrome gibt seit 113 ein Promise zurück und lehnt still ab, wenn der
      // vorherige Lock gerade erst aufgehoben wurde. Beides darf hier nichts
      // umwerfen — der Rückfallweg trägt.
      const antwort = canvas.requestPointerLock({ unadjustedMovement: true });
      if (antwort && typeof antwort.catch === 'function') {
        antwort.catch(() => {
          // `unadjustedMovement` kennt nicht jeder Browser. Ohne die Option
          // greift die Mausbeschleunigung des Systems — brauchbar, nur nicht
          // ganz so gleichmäßig.
          try { canvas.requestPointerLock(); } catch (e2) { /* Rückfallweg */ }
        });
      }
    } catch (e) {
      lockErbeten = false;
    }
  }

  function zeigerFreigeben() {
    lockErbeten = false;
    if (document.pointerLockElement === canvas && document.exitPointerLock) {
      document.exitPointerLock();
    }
  }

  /**
   * Der Lock kann auch ohne unser Zutun enden — Escape, Fensterwechsel,
   * Vollbildende. Dann endet der Blickrichtungsmodus, aber **nicht** der
   * Flugmodus: wer Escape drückt, will den Zeiger zurück, nicht aus der Luft
   * fallen. (walkMode.js beendet beim Lockverlust den ganzen Modus — das ist
   * dort richtig, weil der Gehmodus ohne Lock nicht bedienbar ist, und gilt
   * deshalb nur für den Lock, den walkMode.js selbst geholt hat.)
   */
  function _onLockWechsel() {
    const nun = document.pointerLockElement === canvas;
    if (nun) {
      zeigerGefangen = true;
      lockErbeten = false;
      letzterZeiger = null;
      return;
    }
    if (!zeigerGefangen) { lockErbeten = false; return; }
    zeigerGefangen = false;
    lockErbeten = false;
    if (blickModus) blickSetzen(false);
  }

  function _onLockFehler() {
    lockErbeten = false;
    zeigerGefangen = false;
    // Kein Abbruch: ohne Lock gilt die Bewegungsdifferenz, das Kreuz bleibt
    // in der Mitte, und der Systemzeiger ist wieder zu sehen.
    if (canvas) canvas.style.cursor = '';
    console.info('[FlugTrackpad] Zeiger nicht einfangbar — umsehen über die Zeigerbewegung');
  }

  function ueberCanvas(x, y) {
    if (!canvas) return false;
    const r = canvas.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function drehen(dHeading, dPitch) {
    if (typeof WalkMode === 'undefined') return;
    if (dHeading) WalkMode.setHeading(WalkMode.getHeading() + dHeading);
    if (dPitch) {
      const p = WalkMode.getPitch() + dPitch;
      WalkMode.setPitch(Math.max(-PITCH_GRENZE, Math.min(PITCH_GRENZE, p)));
    }
  }

  // =========================================================================
  // ZWEI FINGER — schieben und Öffnungswinkel
  // =========================================================================

  function _onWheel(e) {
    if (!flugAktiv()) return;
    e.preventDefault();   // sonst zoomt am Trackpad der Browser selbst mit

    const dx = radWeg(e.deltaX, e.deltaMode);
    const dy = radWeg(e.deltaY, e.deltaMode);

    // Aufziehen meldet sich als Rad mit `ctrlKey` — das ist die Übereinkunft
    // aller Browser für die Pinch-Geste, keine gedrückte Steuerungstaste.
    if (e.ctrlKey) {
      if (blickModus) return;   // dort gehört die Fläche dem Umsehen
      const cam = viewer && viewer.camera;
      const frustum = cam && cam.frustum;
      if (!frustum || typeof frustum.fov !== 'number') return;
      const grad = pinchFov(Cesium.Math.toDegrees(frustum.fov), dy);
      if (typeof BimViewer !== 'undefined' && BimViewer.setFieldOfView) BimViewer.setFieldOfView(grad);
      else frustum.fov = Cesium.Math.toRadians(grad);
      return;
    }

    const tempo = (typeof WalkMode !== 'undefined' && WalkMode.getSpeedValue) ? WalkMode.getSpeedValue() : 7;
    schieben(schiebeWeg(dx, tempo), schiebeWeg(dy, tempo));
  }

  /**
   * Seitlich entlang der Kameraachse, hoch/runter entlang des Lots — nicht
   * entlang der Kamera-Oberkante. Wer steil nach unten sieht, will mit zwei
   * Fingern trotzdem steigen und nicht vorwärts kriechen.
   */
  function schieben(rechts, runter) {
    if (!viewer) return;
    const cam = viewer.camera;
    const versatz = new Cesium.Cartesian3();
    if (rechts) Cesium.Cartesian3.add(versatz,
      Cesium.Cartesian3.multiplyByScalar(cam.right, rechts, new Cesium.Cartesian3()), versatz);
    if (runter) Cesium.Cartesian3.add(versatz,
      Cesium.Cartesian3.multiplyByScalar(lotUp(cam.positionWC), -runter, new Cesium.Cartesian3()), versatz);
    if (!Cesium.Cartesian3.magnitude(versatz)) return;
    cam.position = Cesium.Cartesian3.add(cam.position, versatz, new Cesium.Cartesian3());
  }

  function lotUp(position) {
    return viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(position, new Cesium.Cartesian3())
      || Cesium.Cartesian3.normalize(position, new Cesium.Cartesian3());
  }

  // =========================================================================
  // DAUERFLUG — WASD ohne Flugmodus
  // =========================================================================

  function tasteZu(code, an, e) {
    switch (code) {
      case 'KeyW': tasten.vor = an; return true;
      case 'KeyS': tasten.zurueck = an; return true;
      case 'KeyA': tasten.links = an; return true;
      case 'KeyD': tasten.rechts = an; return true;
      case 'KeyE': tasten.hoch = an; return true;
      case 'KeyQ': tasten.runter = an; return true;
      default: return false;
    }
  }

  function _onKeyDown(e) {
    if (e.code === 'KeyF' && !e.ctrlKey && !e.altKey && !e.metaKey && !istSchriftfeld(e.target)) {
      // Umschalten zwischen Gehen und Fliegen bleibt erreichbar, rückt aber
      // auf Shift+F — F selbst ist jetzt die Blickrichtung.
      if (e.shiftKey) {
        // Über BimViewer und nicht über WalkMode.setMode: nur dieser Weg zieht
        // die Schalter im HUD, die Augenhöhe-Gruppe und den Globe-Zustand mit.
        if (flugAktivIrgendwie() && typeof BimViewer !== 'undefined' && BimViewer.toggleWalkMode) {
          e.preventDefault();
          const ziel = WalkMode.getMode() === 'fly' ? 'walk' : 'fly';
          if (blickModus) blickSetzen(false);
          BimViewer.toggleWalkMode(ziel);
        }
        return;
      }
      e.preventDefault();
      blickUmschalten();
      return;
    }
    if (!dauerflugErlaubt(e)) return;
    if (tasteZu(e.code, true, e)) e.preventDefault();
  }

  function _onKeyUp(e) {
    tasteZu(e.code, false, e);
  }

  function flugAktivIrgendwie() {
    return typeof WalkMode !== 'undefined' && WalkMode.isEnabled();
  }

  /**
   * Der Dauerflug hält sich aus allem heraus, was gerade wichtiger ist:
   * Schreiben, ein Werkzeug, das die Kamera festhält, und der Flugmodus
   * selbst — der bewegt mit denselben Tasten schon.
   */
  function dauerflugErlaubt(e) {
    if (!viewer) return false;
    if (e && (e.ctrlKey || e.altKey || e.metaKey)) return false;
    if (e && istSchriftfeld(e.target)) return false;
    if (istSchriftfeld(document.activeElement)) return false;
    if (flugAktivIrgendwie()) return false;
    const ctrl = viewer.scene.screenSpaceCameraController;
    if (ctrl && ctrl.enableInputs === false) return false;
    return true;
  }

  function tastenLoeschen() {
    Object.keys(tasten).forEach(k => tasten[k] = false);
  }

  function _vorBild() {
    const jetzt = performance.now();
    const dt = Math.min((jetzt - letzteZeit) / 1000, 0.1);
    letzteZeit = jetzt;

    // Der Flugmodus kann von überall beendet werden (ESC, Schalter im HUD).
    // Dann muss der Zeiger zurück und der Hinweis weg.
    if (blickModus && !flugAktiv()) blickSetzen(false);
    hinweisNachziehen();

    dauerflug(dt);
    kreuzZeichnen();
  }

  function dauerflug(dt) {
    if (!dauerflugErlaubt(null)) { tastenLoeschen(); return; }
    const bewegt = tasten.vor || tasten.zurueck || tasten.links || tasten.rechts || tasten.hoch || tasten.runter;
    const tempo = (typeof WalkMode !== 'undefined' && WalkMode.tempo) ? WalkMode.tempo(dt, bewegt) : 7;
    if (!bewegt) return;

    const cam = viewer.camera;
    const up = lotUp(cam.positionWC);
    const richtung = new Cesium.Cartesian3();
    const dazu = (v, s) => Cesium.Cartesian3.add(richtung,
      Cesium.Cartesian3.multiplyByScalar(v, s, new Cesium.Cartesian3()), richtung);

    if (tasten.vor) dazu(cam.direction, 1);
    if (tasten.zurueck) dazu(cam.direction, -1);
    if (tasten.rechts) dazu(cam.right, 1);
    if (tasten.links) dazu(cam.right, -1);
    if (tasten.hoch) dazu(up, 1);
    if (tasten.runter) dazu(up, -1);

    const laenge = Cesium.Cartesian3.magnitude(richtung);
    if (laenge < 1e-9) return;
    const versatz = Cesium.Cartesian3.multiplyByScalar(richtung, tempo * dt / laenge, new Cesium.Cartesian3());
    cam.position = Cesium.Cartesian3.add(cam.position, versatz, new Cesium.Cartesian3());
  }

  // =========================================================================
  // START
  // =========================================================================

  function init(cesiumViewer) {
    if (viewer) return;
    viewer = cesiumViewer || (typeof BimViewer !== 'undefined' ? BimViewer.viewer : null);
    if (!viewer) return;
    canvas = viewer.canvas;
    letzteZeit = performance.now();

    canvas.addEventListener('wheel', _onWheel, { passive: false });
    window.addEventListener('pointermove', _onPointerMove, { passive: true });
    window.addEventListener('keydown', _onKeyDown);
    window.addEventListener('keyup', _onKeyUp);
    window.addEventListener('blur', tastenLoeschen);
    document.addEventListener('pointerlockchange', _onLockWechsel);
    document.addEventListener('pointerlockerror', _onLockFehler);
    document.addEventListener('focusin', () => { if (istSchriftfeld(document.activeElement)) tastenLoeschen(); });

    entferneVorBild = viewer.scene.preRender.addEventListener(_vorBild);
    kreuzElement();
    console.log('[FlugTrackpad] bereit — F: Blickrichtung (Zeiger wird gefangen), Shift+F: Gehen/Fliegen');
  }

  function warten() {
    const v = (typeof BimViewer !== 'undefined') ? BimViewer.viewer : null;
    if (v && v.scene && v.canvas) { init(v); return; }
    setTimeout(warten, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', warten);
  else warten();

  return {
    init,
    blickUmschalten,
    blickSetzen,
    blickAktiv: () => blickModus,
    /** Liegt der Pointer Lock bei uns? walkMode.js fragt danach. */
    haeltZeiger: () => zeigerGefangen,
    fadenkreuzSichtbar: () => !!fadenkreuz && fadenkreuz.style.display !== 'none',
    empfindlichkeit: () => empfindlichkeit,
    empfindlichkeitSetzen,
    // Die Rechenkerne für den Prüfstein ohne Browser.
    _pruefsteine: {
      pinchFov, schiebeWeg, istSchriftfeld, radWeg, drehWinkel, empfindlichkeitSetzen,
      FOV_MIN, FOV_MAX, DREH_JE_PIXEL, SCHIEBE_JE_PIXEL, EMPF_MIN, EMPF_MAX,
    },
  };

})();
