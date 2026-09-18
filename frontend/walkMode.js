/**
 * walkMode.js — iLEEN Walk & Fly Mode v3.0
 *
 * Modi:
 *   walk — First-Person auf Terrain/Tiles/Punktwolken. Boden wird per 9-Punkt-Grid
 *          (1 m², 3×3) gesamplet, gemittelt und per EMA geglättet → smooth.
 *   fly  — Freies 6DOF-Fliegen entlang der lokalen Blickrichtung (pitch-aware).
 *
 * Bodenhöhen-Strategie (Walk):
 *   1 Lot-Strahl + 8 Strahlen in 3×3-Grid (1 m²) nach -localUp.
 *   Mittelwert (mit Ausreißer-Trimming) → robust gegen lokale Mesh-/Punktwolken-Spitzen.
 *   Immer-aktiver, frame-rate-unabhängiger Lerp (1 - exp(-k·dt)) → kein Hüpfen,
 *   keine Snap-Schwellen, gleichmäßig bei jeder Geschwindigkeit.
 *
 * Geschwindigkeit (6 Stufen, nichtlinear wie Twinmotion):
 *   1: 1 m/s   2: 3 m/s   3: 7 m/s   4: 20 m/s   5: 60 m/s   6: 200 m/s
 *
 * Stufe 0 (Taste 0, nur Fly): keine feste Stufe, sondern eine Rampe. Startet
 *   unter Stufe 1 und beschleunigt exponentiell, solange eine Bewegungstaste
 *   liegt — nach 5 s ist Stufe 6 (200 m/s) erreicht, dort bleibt es.
 *   Loslassen setzt zurueck.
 */
'use strict';

window.WalkMode = (function () {

  // ── Cesium Viewer Referenz ────────────────────────────────────────────
  let viewer = null;
  let canvas = null;

  // ── Modus ─────────────────────────────────────────────────────────────
  let mode = 'walk';   // 'walk' | 'fly'
  let enabled = false;
  let removePreRender = null;
  let lastTime = 0;

  // ── Kamera-Orientierung (lokal, in Rad) ──────────────────────────────
  let heading = 0.0;
  let pitch = 0.0;

  // ── Sprung-Physik (nur Walk) ──────────────────────────────────────────
  let verticalVelocity = 0.0;
  let isOnGround = false;
  let jumpRequested = false;
  const GRAVITY = -12.0;
  const JUMP_SPEED = 5.0;

  // ── Einstellungen ─────────────────────────────────────────────────────
  let walkHeight = 1.80;       // Augen-Höhe über Boden (Walk)
  let lookSensitivity = 0.003;

  // 6 Geschwindigkeitsstufen — nichtlinear (Twinmotion-Feeling)
  const SPEED_LEVELS = [1, 3, 7, 20, 60, 200]; // m/s
  let speedLevel = 2; // 0-basiert → default 7 m/s

  // ── Stufe 0 — beschleunigter Anlauf ───────────────────────────────────
  // v(t) = RAMP_V0 · e^(RAMP_K·t), solange eine Bewegungstaste gehalten wird,
  // gedeckelt bei RAMP_VMAX. Die Rampe fängt unter Stufe 1 an und endet bei
  // Stufe 6 — sie ersetzt also nicht die Stufen, sondern durchfährt sie:
  // Anschlussdetail, Geschoss, Gebäude, Quartier, ohne die Taste loszulassen.
  const RAMP_LEVEL = -1;         // speedLevel-Wert für Stufe 0
  const RAMP_V0 = 0.8;           // m/s — etwas unter Stufe 1
  const RAMP_VMAX = SPEED_LEVELS[SPEED_LEVELS.length - 1]; // = Stufe 6
  const RAMP_TIME = 5.0;         // s bis zur Höchstgeschwindigkeit
  const RAMP_K = Math.log(RAMP_VMAX / RAMP_V0) / RAMP_TIME; // 1/s
  let rampTime = 0;              // s — aufsummierte Haltedauer
  let rampSpeed = RAMP_V0;       // m/s — aktueller Rampenwert (HUD)
  let lastRampReadout = 0;         // ms — Drossel für die HUD-Anzeige

  // ── Tastenzustand ─────────────────────────────────────────────────────
  const keys = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    up: false,      // Q — nur Fly
    down: false,    // E — nur Fly
    jump: false,
    sprint: false,
  };

  // ── Maus-Fallback (kein Pointer Lock) ────────────────────────────────
  // `pointerLockGehalten` merkt, ob der Zeiger tatsächlich einmal eingefangen
  // war. Ohne das beendete der Wechsel vom Gehen ins Fliegen den frisch
  // gestarteten Modus gleich wieder: `exitPointerLock()` meldet sich erst im
  // nächsten Tick zurück, da läuft der Flug schon — und sein eigener Hörer
  // deutete die Meldung als „Zeiger verloren, Modus beenden".
  let pointerLockGehalten = false;
  let mouseDown = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  // ── Geglättete Bodenhöhe ──────────────────────────────────────────────
  let smoothedGroundHeight = null;
  // Zeitkonstanten in Sekunden — frame-rate-unabhängig via 1 - exp(-dt/τ).
  // Kleinere τ = schneller folgen, größere τ = mehr Glättung.
  const GROUND_TAU = 0.12;   // EMA des gemessenen Bodens
  const FOLLOW_TAU = 0.08;   // Kamera folgt der Sollhöhe

  // ── Z-Offset (manueller vertikaler Versatz) ───────────────────────────
  let zOffset = 0.0; // m, positiv = höher

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  function init(cesiumViewer) {
    viewer = cesiumViewer;
    canvas = viewer.canvas;
    canvas.setAttribute('tabindex', '0');
  }

  function toggle(force) {
    const newState = (force !== undefined) ? !!force : !enabled;
    if (newState === enabled) return enabled;
    enabled = newState;
    if (enabled) _enable(); else _disable();
    return enabled;
  }

  function setMode(m) {
    if (m !== 'walk' && m !== 'fly') return;
    if (m === mode) return;
    mode = m;
    smoothedGroundHeight = null; // Reset bei Moduswechsel
    verticalVelocity = 0.0;
    isOnGround = false;
    _updateOverlayText(_overlayText());
    console.log('[WalkMode] Modus:', mode);
  }

  function getMode() { return mode; }

  function setHeight(h) {
    walkHeight = Math.max(0.1, Math.min(200.0, parseFloat(h) || 1.80));
    smoothedGroundHeight = null; // nächstes Frame neu berechnen
  }

  function setZOffset(z) {
    zOffset = Math.max(-500, Math.min(500, parseFloat(z) || 0));
  }

  function setSpeedLevel(lvl) {
    const n = parseInt(lvl, 10);
    if (n === RAMP_LEVEL) { speedLevel = RAMP_LEVEL; _resetRamp(); return; }
    speedLevel = Math.max(0, Math.min(SPEED_LEVELS.length - 1, isNaN(n) ? 0 : n));
  }

  function getSpeedLevel() { return speedLevel; }
  function getSpeedValue() { return speedLevel === RAMP_LEVEL ? rampSpeed : SPEED_LEVELS[speedLevel]; }
  function getSpeedLevels() { return SPEED_LEVELS.slice(); }
  function isRamping() { return speedLevel === RAMP_LEVEL; }

  function _resetRamp() { rampTime = 0; rampSpeed = RAMP_V0; }

  /**
   * Geschwindigkeit dieses Frames in m/s. Stufen 1–6 sind konstant, Stufe 0
   * beschleunigt exponentiell, solange gehalten wird — im Walk-Modus bleibt
   * sie schlicht die langsamste Gangart (Rampe nur im freien Flug sinnvoll).
   */
  function _currentSpeed(dt, moving) {
    let base;
    if (speedLevel === RAMP_LEVEL) {
      // Außerhalb des Modus (Dauerflug über flug-trackpad.js) wird immer frei
      // geflogen — dort gilt die Rampe genauso wie im Flugmodus selbst.
      if (!moving || (enabled && mode !== 'fly')) {
        _resetRamp();
      } else {
        rampTime = Math.min(rampTime + dt, RAMP_TIME);
        // Am Deckel den Sollwert setzen statt ihn auszurechnen: exp(ln(x)) gibt
        // 199.999… zurück, und die Stufe soll exakt Stufe 6 sein.
        rampSpeed = rampTime >= RAMP_TIME ? RAMP_VMAX : RAMP_V0 * Math.exp(RAMP_K * rampTime);
      }
      base = rampSpeed;
    } else {
      base = SPEED_LEVELS[speedLevel];
    }
    return base * (keys.sprint ? 2.5 : 1.0);
  }

  function formatSpeed(v) {
    return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + ' m/s';
  }

  function isEnabledFn() { return enabled; }

  // =========================================================================
  // ENABLE / DISABLE
  // =========================================================================

  function _enable() {
    console.log('[WalkMode] Aktiviert —', mode);
    const ctrl = viewer.scene.screenSpaceCameraController;
    ctrl.enableRotate = false;
    ctrl.enableTranslate = false;
    ctrl.enableZoom = false;
    ctrl.enableTilt = false;
    ctrl.enableLook = false;

    heading = viewer.camera.heading;
    pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, viewer.camera.pitch));

    verticalVelocity = 0.0;
    isOnGround = false;
    jumpRequested = false;
    smoothedGroundHeight = null;

    window.addEventListener('keydown', _onKeyDown);
    window.addEventListener('keyup', _onKeyUp);
    document.addEventListener('mousemove', _onMouseMove);
    canvas.addEventListener('mousedown', _onMouseDown);
    window.addEventListener('mouseup', _onMouseUp);
    document.addEventListener('pointerlockchange', _onPointerLockChange);
    document.addEventListener('pointerlockerror', _onPointerLockError);
    document.addEventListener('focusin', _onFocusIn);
    window.addEventListener('blur', _alleTastenLos);

    canvas.focus();
    mouseDown = false;
    pointerLockGehalten = false;
    // Pointer Lock nur beim Gehen. Im Flug übernimmt flug-trackpad.js das
    // Umsehen mit einem Finger und braucht dafür einen sichtbaren Zeiger —
    // Pointer Lock nähme ihn weg und beendete beim ESC gleich den ganzen Modus.
    if (mode === 'walk' && canvas.requestPointerLock) {
      const lockResult = canvas.requestPointerLock();
      if (lockResult && typeof lockResult.catch === 'function') {
        lockResult.catch(() => {
          console.warn('[WalkMode] Pointer Lock verweigert — Klick+Drag Fallback aktiv');
        });
      }
    }

    console.log('[WalkMode] aktiviert — canvas fokussiert:', document.activeElement === canvas);

    lastTime = performance.now();
    removePreRender = viewer.scene.preRender.addEventListener(_update);
    _showOverlay(true);

    if (mode === 'walk') {
      try { _snapToGround(true); } catch (err) {
        console.warn('[WalkMode] _snapToGround initial fehlgeschlagen, wird im nächsten Frame erneut versucht:', err);
        smoothedGroundHeight = null;
      }
    }
  }

  function _disable() {
    console.log('[WalkMode] Deaktiviert');
    const ctrl = viewer.scene.screenSpaceCameraController;
    ctrl.enableRotate = true;
    ctrl.enableTranslate = true;
    ctrl.enableZoom = true;
    ctrl.enableTilt = true;
    ctrl.enableLook = true;

    if (document.pointerLockElement === canvas) document.exitPointerLock();
    pointerLockGehalten = false;
    mouseDown = false;

    window.removeEventListener('keydown', _onKeyDown);
    window.removeEventListener('keyup', _onKeyUp);
    document.removeEventListener('mousemove', _onMouseMove);
    canvas.removeEventListener('mousedown', _onMouseDown);
    window.removeEventListener('mouseup', _onMouseUp);
    document.removeEventListener('pointerlockchange', _onPointerLockChange);
    document.removeEventListener('pointerlockerror', _onPointerLockError);
    document.removeEventListener('focusin', _onFocusIn);
    window.removeEventListener('blur', _alleTastenLos);

    if (removePreRender) { removePreRender(); removePreRender = null; }
    Object.keys(keys).forEach(k => keys[k] = false);
    _showOverlay(false);
  }

  // =========================================================================
  // EVENT HANDLER
  // =========================================================================

  /**
   * Wird gerade geschrieben? Dann gehören W, A, S und D ins Feld und nicht in
   * die Kamera. Sonst fliegt man beim Benennen einer Notiz quer über das
   * Gelände. Escape bleibt ausgenommen — das ist der Notausgang.
   */
  function _imSchriftfeld(ziel) {
    const el = ziel || document.activeElement;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function _onKeyDown(e) {
    if (e.code === 'Escape') {
      if (enabled) {
        toggle(false);
        if (typeof BimViewer !== 'undefined' && BimViewer.onWalkModeExited) BimViewer.onWalkModeExited();
      }
      return;
    }
    if (_imSchriftfeld(e.target) || _imSchriftfeld(null)) return;
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    keys.forward  = true; break;
      case 'KeyS': case 'ArrowDown':  keys.backward = true; break;
      case 'KeyA': case 'ArrowLeft':  keys.left     = true; break;
      case 'KeyD': case 'ArrowRight': keys.right    = true; break;
      case 'KeyQ':                    keys.down     = true; break;
      case 'KeyE':                    keys.up       = true; break;
      case 'Space':
        e.preventDefault();
        if (mode === 'walk' && isOnGround) jumpRequested = true;
        break;
      case 'ShiftLeft': case 'ShiftRight': keys.sprint = true; break;
      case 'KeyF':
        // F gehört der Blickrichtung (flug-trackpad.js). Das Umschalten
        // zwischen Gehen und Fliegen liegt auf Shift+F — dort behandelt es
        // dasselbe Modul, damit die Taste nur an einer Stelle steht.
        break;
      // Geschwindigkeit per Scroll oder 0-6 (0 = beschleunigte Rampe)
      case 'Digit0': setSpeedLevel(RAMP_LEVEL); _notifySpeedChange(); break;
      case 'Digit1': setSpeedLevel(0); _notifySpeedChange(); break;
      case 'Digit2': setSpeedLevel(1); _notifySpeedChange(); break;
      case 'Digit3': setSpeedLevel(2); _notifySpeedChange(); break;
      case 'Digit4': setSpeedLevel(3); _notifySpeedChange(); break;
      case 'Digit5': setSpeedLevel(4); _notifySpeedChange(); break;
      case 'Digit6': setSpeedLevel(5); _notifySpeedChange(); break;
    }
  }

  // Wer mitten im Flug in ein Feld klickt, hält die Taste vielleicht noch —
  // ohne dieses Loslassen flöge die Kamera weiter, während getippt wird.
  function _alleTastenLos() { Object.keys(keys).forEach(k => keys[k] = false); }
  function _onFocusIn() { if (_imSchriftfeld(null)) _alleTastenLos(); }

  function _onKeyUp(e) {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    keys.forward  = false; break;
      case 'KeyS': case 'ArrowDown':  keys.backward = false; break;
      case 'KeyA': case 'ArrowLeft':  keys.left     = false; break;
      case 'KeyD': case 'ArrowRight': keys.right    = false; break;
      case 'KeyQ':                    keys.down     = false; break;
      case 'KeyE':                    keys.up       = false; break;
      case 'ShiftLeft': case 'ShiftRight': keys.sprint = false; break;
    }
  }

  function _onMouseDown(e) {
    if (!enabled) return;
    if (document.pointerLockElement !== canvas) {
      // Kein Pointer Lock → Klick+Drag Modus
      mouseDown = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      e.preventDefault();
    }
  }

  function _onMouseUp() {
    mouseDown = false;
  }

  function _onMouseMove(e) {
    if (!enabled) return;
    // Im Blickrichtungsmodus dreht flug-trackpad.js aus derselben Bewegung —
    // beides zusammen wäre die doppelte Drehung.
    if (typeof FlugTrackpad !== 'undefined' && FlugTrackpad.blickAktiv && FlugTrackpad.blickAktiv()) return;

    let dx = 0, dy = 0;
    if (document.pointerLockElement === canvas) {
      dx = e.movementX || 0;
      dy = e.movementY || 0;
    } else if (mouseDown) {
      dx = e.clientX - lastMouseX;
      dy = e.clientY - lastMouseY;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    } else {
      return;
    }

    heading += dx * lookSensitivity;
    pitch   -= dy * lookSensitivity;
    const pitchLimit = Math.PI / 2 - 0.01;
    pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));
    _applyCameraOrientation();
  }

  function _onPointerLockChange() {
    // Seit September 2026 fängt auch flug-trackpad.js den Zeiger ein — für
    // das Fadenkreuz im Blickrichtungsmodus. Dessen Lock gehört nicht hierher:
    // wer dort Escape drückt, will den Zeiger zurück und nicht aus der Luft
    // fallen. Der Gehmodus dagegen ist ohne Lock nicht bedienbar und wird beim
    // Verlust zu Recht ganz beendet.
    if (typeof FlugTrackpad !== 'undefined' && FlugTrackpad.blickAktiv && FlugTrackpad.blickAktiv()) {
      return;
    }
    if (document.pointerLockElement === canvas) pointerLockGehalten = true;
    else if (!pointerLockGehalten) return;   // nachlaufende Meldung des Vorgängers

    if (document.pointerLockElement !== canvas && enabled) {
      pointerLockGehalten = false;
      // Pointer Lock verloren (ESC, Alt-Tab, Browser) während aktiv → Modus
      // vollständig beenden statt in einem maus-losen Zwischenzustand hängen
      // zu bleiben (sonst braucht der Toggle-Button einen zweiten Klick,
      // um wieder in einen sauberen Zustand zu kommen).
      toggle(false);
      if (typeof BimViewer !== 'undefined' && BimViewer.onWalkModeExited) BimViewer.onWalkModeExited();
    } else if (document.pointerLockElement === canvas) {
      _updateOverlayText(_overlayText());
    }
  }

  function _onPointerLockError() {
    console.warn('[WalkMode] Pointer Lock fehlgeschlagen');
  }

  function _notifySpeedChange() {
    _updateOverlayText(_overlayText());
    if (typeof BimViewer !== 'undefined' && BimViewer.onWalkSpeedChanged) {
      BimViewer.onWalkSpeedChanged(speedLevel, getSpeedValue());
    }
  }

  // =========================================================================
  // HAUPTSCHLEIFE
  // =========================================================================

  function _update(_scene, _time) {
    if (!enabled || !viewer) return;
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    try {
      if (mode === 'fly') {
        _updateFly(dt);
      } else {
        _updateWalk(dt);
      }
    } catch (err) {
      console.error('[WalkMode] Fehler im Update-Loop:', err);
    }

    // Stufe 0 ändert ihren Wert jeden Frame — Anzeige gedrosselt nachziehen.
    if (speedLevel === RAMP_LEVEL && now - lastRampReadout > 100) {
      lastRampReadout = now;
      _notifySpeedChange();
    }
  }

  // ── WALK ─────────────────────────────────────────────────────────────────

  function _updateWalk(dt) {
    const camera = viewer.camera;
    const position = camera.position;

    const localUp   = _getLocalUp(position);
    const localEast = _getLocalEast(localUp);
    const localNorth = Cesium.Cartesian3.cross(localUp, localEast, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(localNorth, localNorth);

    const sinH = Math.sin(heading), cosH = Math.cos(heading);
    const forward = new Cesium.Cartesian3(
      localNorth.x * cosH + localEast.x * sinH,
      localNorth.y * cosH + localEast.y * sinH,
      localNorth.z * cosH + localEast.z * sinH
    );
    const right = new Cesium.Cartesian3(
      localEast.x * cosH - localNorth.x * sinH,
      localEast.y * cosH - localNorth.y * sinH,
      localEast.z * cosH - localNorth.z * sinH
    );

    const moving = keys.forward || keys.backward || keys.left || keys.right;
    const d = _currentSpeed(dt, moving) * dt;

    let moveVec = new Cesium.Cartesian3();
    if (keys.forward)  Cesium.Cartesian3.add(moveVec, Cesium.Cartesian3.multiplyByScalar(forward,  d, new Cesium.Cartesian3()), moveVec);
    if (keys.backward) Cesium.Cartesian3.add(moveVec, Cesium.Cartesian3.multiplyByScalar(forward, -d, new Cesium.Cartesian3()), moveVec);
    if (keys.right)    Cesium.Cartesian3.add(moveVec, Cesium.Cartesian3.multiplyByScalar(right,    d, new Cesium.Cartesian3()), moveVec);
    if (keys.left)     Cesium.Cartesian3.add(moveVec, Cesium.Cartesian3.multiplyByScalar(right,   -d, new Cesium.Cartesian3()), moveVec);

    const newPos = Cesium.Cartesian3.add(position, moveVec, new Cesium.Cartesian3());

    // Sprung
    if (jumpRequested && isOnGround) { verticalVelocity = JUMP_SPEED; isOnGround = false; jumpRequested = false; }
    if (!isOnGround) verticalVelocity += GRAVITY * dt;
    Cesium.Cartesian3.add(newPos, Cesium.Cartesian3.multiplyByScalar(localUp, verticalVelocity * dt, new Cesium.Cartesian3()), newPos);

    const ellipsoid = viewer.scene.globe.ellipsoid;
    const carto = ellipsoid.cartesianToCartographic(newPos);
    if (!carto) return;

    _snapToGround(false, carto, newPos, localUp, dt);
  }

  // ── FLY ──────────────────────────────────────────────────────────────────

  function _updateFly(dt) {
    const camera = viewer.camera;
    const position = camera.position;

    const localUp   = _getLocalUp(position);
    const localEast = _getLocalEast(localUp);
    const localNorth = Cesium.Cartesian3.cross(localUp, localEast, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(localNorth, localNorth);

    const sinH = Math.sin(heading), cosH = Math.cos(heading);
    const sinP = Math.sin(pitch),   cosP = Math.cos(pitch);

    // Blickrichtung im ENU: pitch + heading
    const lookDir = new Cesium.Cartesian3(
      (localNorth.x * cosH + localEast.x * sinH) * cosP + localUp.x * sinP,
      (localNorth.y * cosH + localEast.y * sinH) * cosP + localUp.y * sinP,
      (localNorth.z * cosH + localEast.z * sinH) * cosP + localUp.z * sinP
    );
    Cesium.Cartesian3.normalize(lookDir, lookDir);

    // Horizontale Vorwärtsrichtung (für Sidestepping)
    const hFwd = new Cesium.Cartesian3(
      localNorth.x * cosH + localEast.x * sinH,
      localNorth.y * cosH + localEast.y * sinH,
      localNorth.z * cosH + localEast.z * sinH
    );
    const right = new Cesium.Cartesian3(
      localEast.x * cosH - localNorth.x * sinH,
      localEast.y * cosH - localNorth.y * sinH,
      localEast.z * cosH - localNorth.z * sinH
    );

    // Richtungsvektor aus Tasten — W/S in Blickrichtung (pitch-aware)
    let dir = new Cesium.Cartesian3();
    if (keys.forward)  Cesium.Cartesian3.add(dir, lookDir, dir);
    if (keys.backward) Cesium.Cartesian3.subtract(dir, lookDir, dir);
    if (keys.right)    Cesium.Cartesian3.add(dir, right,   dir);
    if (keys.left)     Cesium.Cartesian3.subtract(dir, right,   dir);
    if (keys.up)       Cesium.Cartesian3.add(dir, localUp, dir);
    if (keys.down)     Cesium.Cartesian3.subtract(dir, localUp, dir);

    // Diagonal-Bewegung normieren → konstanter Speed in alle Richtungen
    const dirLen = Cesium.Cartesian3.magnitude(dir);
    const speed = _currentSpeed(dt, dirLen > 1e-9);

    let moveVec = new Cesium.Cartesian3();
    if (dirLen > 1e-9) {
      Cesium.Cartesian3.multiplyByScalar(dir, speed * dt / dirLen, moveVec);
    }

    camera.position = Cesium.Cartesian3.add(position, moveVec, new Cesium.Cartesian3());
    _applyCameraOrientation();
  }

  // =========================================================================
  // BODEN-EINRASTEN — 9-Punkt-Grid (3×3 in 1 m²) + getrimmter Mittelwert
  // =========================================================================

  /**
   * Samplet die Bodenhöhe via 9 Lot-Strahlen in einem 3×3-Grid auf 1 m².
   * Strahlrichtung = -localUp, Ursprung 1 m über dem zuletzt bekannten Boden
   * (nicht über der Augenposition — sonst sammelt der Strahl Decken/Wände auf).
   * Ausreißer-Trimming (höchste + niedrigste verworfen) und Mittelwert →
   * robust gegen lokale Spitzen in Meshes & Punktwolken.
   * Glättung dann frame-rate-unabhängig per 1 - exp(-dt/τ).
   */
  const _SAMPLE_OFFSETS_2D = [
    [-0.5, -0.5], [0.0, -0.5], [0.5, -0.5],
    [-0.5,  0.0], [0.0,  0.0], [0.5,  0.0],
    [-0.5,  0.5], [0.0,  0.5], [0.5,  0.5],
  ];

  function _snapToGround(instant, carto, pos, up, dt) {
    if (!viewer || !enabled || mode !== 'walk') return;

    const camera = viewer.camera;
    const scene = viewer.scene;
    const ellipsoid = scene.globe.ellipsoid;

    const currentPos  = pos   || camera.position;
    const currentCarto = carto || ellipsoid.cartesianToCartographic(currentPos);
    if (!currentCarto) return;

    const localUp   = up || _getLocalUp(currentPos);
    const localDown = Cesium.Cartesian3.negate(localUp, new Cesium.Cartesian3());
    const localEast = _getLocalEast(localUp);
    const localNorth = Cesium.Cartesian3.cross(localUp, localEast, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(localNorth, localNorth);

    // Strahl-Ursprung: 1 m über dem letzten bekannten Boden — nicht über Augenposition,
    // sonst trifft der Lot-Strahl auch Decken/Wände/Tische über dem Kopf.
    const RAY_UP = 1.0;
    const baseGroundH = (smoothedGroundHeight !== null)
      ? smoothedGroundHeight
      : currentCarto.height - walkHeight;
    const rayOriginBase = Cesium.Cartesian3.fromRadians(
      currentCarto.longitude, currentCarto.latitude, baseGroundH + RAY_UP, ellipsoid
    );

    const heights = [];
    const tmpA = new Cesium.Cartesian3();
    const tmpB = new Cesium.Cartesian3();

    for (let i = 0; i < _SAMPLE_OFFSETS_2D.length; i++) {
      const dN = _SAMPLE_OFFSETS_2D[i][0];
      const dE = _SAMPLE_OFFSETS_2D[i][1];
      Cesium.Cartesian3.multiplyByScalar(localNorth, dN, tmpA);
      Cesium.Cartesian3.multiplyByScalar(localEast,  dE, tmpB);
      const offset = Cesium.Cartesian3.add(tmpA, tmpB, new Cesium.Cartesian3());
      const rayOrigin = Cesium.Cartesian3.add(rayOriginBase, offset, new Cesium.Cartesian3());
      const ray = new Cesium.Ray(rayOrigin, localDown);

      let h = null;
      try {
        const hit = scene.pickFromRay(ray, [], 0.0);
        if (hit && hit.position) {
          const hc = ellipsoid.cartesianToCartographic(hit.position);
          if (hc && Math.abs(hc.height - currentCarto.height) < 200) h = hc.height;
        }
      } catch (_) {}

      if (h === null) {
        try {
          const globeHit = scene.globe.pick(ray, scene);
          if (globeHit) {
            const hc = ellipsoid.cartesianToCartographic(globeHit);
            if (hc && Math.abs(hc.height - currentCarto.height) < 200) h = hc.height;
          }
        } catch (_) {}
      }

      if (h !== null) heights.push(h);
    }

    // Getrimmter Mittelwert: bei ≥4 Samples die höchste & niedrigste raus.
    // Mehrere Punktwolken-/Mesh-Spitzen werden so weggemittelt.
    let rawGroundHeight;
    if (heights.length >= 4) {
      heights.sort((a, b) => a - b);
      let sum = 0;
      for (let i = 1; i < heights.length - 1; i++) sum += heights[i];
      rawGroundHeight = sum / (heights.length - 2);
    } else if (heights.length > 0) {
      let sum = 0;
      for (const h of heights) sum += h;
      rawGroundHeight = sum / heights.length;
    } else {
      const terrainH = scene.globe.getHeight(currentCarto);
      rawGroundHeight = (terrainH !== undefined && terrainH !== null)
        ? terrainH
        : (smoothedGroundHeight !== null ? smoothedGroundHeight : currentCarto.height - walkHeight);
    }

    // Frame-rate-unabhängige Glättung des gemessenen Bodens.
    const dtSafe = (typeof dt === 'number' && dt > 0) ? dt : 1 / 60;
    if (smoothedGroundHeight === null || instant) {
      smoothedGroundHeight = rawGroundHeight;
    } else {
      const aGround = 1 - Math.exp(-dtSafe / GROUND_TAU);
      smoothedGroundHeight += aGround * (rawGroundHeight - smoothedGroundHeight);
    }

    const targetHeight = smoothedGroundHeight + walkHeight + zOffset;

    // Bodenkontakt-Flag (nur fürs Springen relevant).
    if (currentCarto.height <= targetHeight + 0.05) {
      isOnGround = true;
      if (verticalVelocity < 0) verticalVelocity = 0;
    } else {
      isOnGround = false;
    }

    // Kamera-Höhe folgt targetHeight immer (auch in der Luft beim Sprung-Apex
    // greift dieser Lerp nicht mehr — wir setzen dann nur bei isOnGround).
    let finalHeight;
    if (instant) {
      finalHeight = targetHeight;
    } else if (isOnGround) {
      const aFollow = 1 - Math.exp(-dtSafe / FOLLOW_TAU);
      finalHeight = currentCarto.height + (targetHeight - currentCarto.height) * aFollow;
    } else {
      // In der Luft (Sprung): vertikale Position aus newPos beibehalten.
      finalHeight = currentCarto.height;
    }

    camera.position = Cesium.Cartesian3.fromRadians(
      currentCarto.longitude, currentCarto.latitude, finalHeight, ellipsoid
    );

    _applyCameraOrientation();
  }

  // =========================================================================
  // KAMERA-ORIENTIERUNG
  // =========================================================================

  function _applyCameraOrientation() {
    if (!viewer) return;
    viewer.camera.setView({
      destination: viewer.camera.position,
      orientation: { heading, pitch, roll: 0.0 }
    });
  }

  // =========================================================================
  // ENU-HILFSFUNKTIONEN
  // =========================================================================

  function _getLocalUp(position) {
    return viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(position, new Cesium.Cartesian3());
  }

  function _getLocalEast(localUp) {
    const ecefZ = new Cesium.Cartesian3(0, 0, 1);
    let east = Cesium.Cartesian3.cross(ecefZ, localUp, new Cesium.Cartesian3());
    if (Cesium.Cartesian3.magnitude(east) < 1e-6) east = new Cesium.Cartesian3(1, 0, 0);
    return Cesium.Cartesian3.normalize(east, east);
  }

  // =========================================================================
  // OVERLAY (HUD)
  // =========================================================================

  function _overlayText() {
    const modeLabel = mode === 'fly' ? 'Fly Mode' : 'Walk Mode';
    const speedLabel = speedLevel === RAMP_LEVEL
      ? `Speed 0/6 (${formatSpeed(rampSpeed)} — beschleunigt)`
      : `Speed ${speedLevel + 1}/6 (${SPEED_LEVELS[speedLevel]} m/s)`;
    if (mode === 'fly') {
      return `${modeLabel} — WASD: Fliegen | Q/E: Höhe | Shift: Sprint | 0-6: ${speedLabel} | ESC: Beenden`;
    }
    return `${modeLabel} — WASD: Bewegen | Space: Springen | Shift: Sprint | 0-6: ${speedLabel} | ESC: Beenden`;
  }

  function _showOverlay(show) {
    let overlay = document.getElementById('walkModeOverlay');
    if (!show) { if (overlay) overlay.style.display = 'none'; return; }

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'walkModeOverlay';
      overlay.style.cssText = [
        'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
        'background:rgba(10,16,22,0.88)', 'backdrop-filter:blur(12px)',
        'color:#97BF0D', 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'font-size:12px', 'font-weight:600', 'letter-spacing:0.5px',
        'padding:10px 20px', 'border-radius:20px',
        'border:1px solid rgba(151,191,13,0.3)', 'z-index:9999',
        'pointer-events:none', 'text-align:center',
        'box-shadow:0 4px 24px rgba(0,0,0,0.4)',
      ].join(';');
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'block';
    _updateOverlayText(_overlayText());
  }

  function _updateOverlayText(text) {
    const overlay = document.getElementById('walkModeOverlay');
    if (overlay) overlay.textContent = text;
  }

  // =========================================================================
  // EXPORTS
  // =========================================================================

  return {
    init,
    toggle,
    isEnabled: isEnabledFn,
    setEnabled: (v) => toggle(v),
    setMode,
    getMode,
    setHeight,
    setZOffset,
    // Kurs von außen setzen (Kompass im Navigations-HUD). Der Blickwinkel
    // liegt hier und wird jedes Bild auf die Kamera geschrieben — ein setView
    // von außen wäre einen Frame später wieder überschrieben.
    setHeading: (rad) => {
      if (typeof rad !== 'number' || !isFinite(rad)) return;
      heading = rad;
      if (enabled) _applyCameraOrientation();
    },
    getHeading: () => heading,
    // Neigung nach außen, aus demselben Grund wie der Kurs: sie liegt hier
    // und wird in jedem Bild auf die Kamera geschrieben.
    setPitch: (rad) => {
      if (typeof rad !== 'number' || !isFinite(rad)) return;
      const grenze = Math.PI / 2 - 0.01;
      pitch = Math.max(-grenze, Math.min(grenze, rad));
      if (enabled) _applyCameraOrientation();
    },
    getPitch: () => pitch,
    // Die Geschwindigkeit dieses Bildes — samt Rampe der Stufe 0. Der
    // Dauerflug außerhalb des Modus rechnet damit dieselbe Staffelung, statt
    // eine zweite danebenzustellen. Nur ein Aufrufer je Bild, sonst läuft die
    // Rampe doppelt.
    tempo: (dt, bewegt) => _currentSpeed(dt, !!bewegt),
    setSpeedLevel,
    getSpeedLevel,
    getSpeedValue,
    getSpeedLevels,
    isRamping,
    formatSpeed,
    RAMP_LEVEL,
    // Legacy-Kompatibilität
    setSpeed: (s) => {
      const v = parseFloat(s);
      // Nächste Stufe finden
      let best = 0;
      for (let i = 0; i < SPEED_LEVELS.length; i++) {
        if (Math.abs(SPEED_LEVELS[i] - v) < Math.abs(SPEED_LEVELS[best] - v)) best = i;
      }
      speedLevel = best;
    },
    setEyeLevel: (useDefault) => { if (useDefault) walkHeight = 1.80; },
  };

})();
