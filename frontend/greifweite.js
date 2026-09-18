/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
/**
 * greifweite.js — wie weit ein Zug die Welt verschieben darf
 *
 * Cesium packt beim Ziehen den Punkt unter dem Zeiger und hält ihn dort fest.
 * Das ist genau richtig, solange der Punkt in der Nähe liegt. Erwischt man
 * dagegen knapp über dem Horizont ein Stück Gelände in zwanzig Kilometern
 * Entfernung, wird derselbe Zentimeter Zeigerweg zu einem Sprung über die
 * halbe Landschaft — man steht plötzlich woanders und weiß nicht, wo.
 *
 * Das Modul hat dagegen ZWEI Riegel, und beide werden gebraucht.
 *
 * ── 1 · Der Griff wird gekürzt (`klemmeAn`) ───────────────────────────────
 *
 * Der zu weite Griff wird **gekürzt, nicht weggeworfen**: der Punkt rutscht
 * auf demselben Sehstrahl bis auf die erlaubte Weite heran. Gezogen wird
 * weiter — nur eben mit dem Hebel der Nähe statt dem der Ferne. (Die erste
 * Fassung hat den Griff verworfen; dann rotierte Cesium bloß noch auf der
 * Stelle, und Greifen und Vor-/Zurückschieben waren weg. Ein Werkzeug, das
 * eine Bewegung dämpfen soll, darf sie nicht abschaffen.)
 *
 * Das wirkt dort, wo Cesium den Griffpunkt wirklich benutzt: im *Streifen*
 * (`strafe`), den es bei flachem Blick wählt — genau der Horizontfall.
 *
 * ── 2 · Der Weg wird begrenzt (`pruefen`) ─────────────────────────────────
 *
 * Riegel 1 allein reicht nicht, und der Grund steht in Cesiums Quelltext:
 * `spin3D` legt aus dem Griffpunkt nur eine **Kugel** um den Erdmittelpunkt
 * und ruft damit `pan3D`. `pan3D` sucht Anfangs- und Endpunkt danach selbst
 * per `camera.pickEllipsoid` auf dieser Kugel — den gekürzten Griffpunkt
 * sieht es nie wieder. Streift der Sehstrahl die Kugel flach, liegt sein
 * Schnittpunkt kilometerweit weg, und die Drehung wird riesig; verfehlt er
 * sie ganz, schaltet Cesium mitten im Zug auf `rotate3D` und dreht den ganzen
 * Globus. Das ist der Sprung, nach dem man die Ansicht neu setzen muss.
 *
 * Deshalb wird zusätzlich der **tatsächliche Kameraweg** begrenzt, egal auf
 * welchem Weg Cesium ihn erzeugt hat:
 *
 *   · **Ein Zug versetzt höchstens `zugFaktor × Höhe über Grund`** (mindestens
 *     `zugMinimum`). Wer zehn Meter über dem Dach steht, kommt mit einem Zug
 *     zehn Meter weit, nicht zehn Kilometer. Trägheit nach dem Loslassen zählt
 *     mit — sonst rutschte der Rest hinterher.
 *
 *   · **Je Bild höchstens so weit, wie der Zeiger gewandert ist**, auf den
 *     Greifabstand projiziert (`sicherheit` als Reserve). Das ist das Maß,
 *     das ein richtiges Ziehen von sich aus einhält: der Punkt bleibt unter
 *     dem Zeiger. Damit wird die Bewegung nicht abgeschnitten, sondern auf
 *     ihr eigenes, ehrliches Tempo zurückgeführt — es ruckelt nichts.
 *
 * Zuviel Weg wird nicht verworfen, sondern **anteilig gemischt**: der
 * Kamerastand von vor dem Bild und der danach werden verschnitten. Der Betrag
 * der Position wird dabei eigens gemischt — die Sehne zwischen zwei Punkten
 * einer Kugel liegt innerhalb der Kugel, und auf Erdradius sänke die Kamera
 * sonst bei jedem Bild ein Stück.
 *
 * Greift der Strahl ins Leere, bleibt alles, wie es war: der Himmel ist kein
 * Griff, da schaut Cesium nur (`look3D`), und das ist richtig so.
 *
 * Im Geh- und Flugmodus, bei abgeschalteten Eingaben (Schnittbox, Bildebenen,
 * Bauplaner) und bei nicht-identischer Kameramatrix hält sich das Modul ganz
 * heraus — dort hängt die Kamera nicht am Zeiger.
 *
 *   Greifweite.einstellen({ faktor: 3, minimum: 30 });   // Riegel 1
 *   Greifweite.einstellen({ zugFaktor: 2, zugMinimum: 20 });   // Riegel 2
 *   Greifweite.aus();  /  Greifweite.an();
 */
'use strict';

window.Greifweite = (function () {

  let viewer = null;
  let aktiv = true;

  // Riegel 1 — wie weit weg der Griffpunkt liegen darf.
  let faktor = 4.0;        // × Höhe über Grund
  let minimum = 50.0;      // m — darunter wird nicht begrenzt

  // Riegel 2 — wie weit ein Zug die Kamera versetzen darf.
  let zugFaktor = 1.0;     // × Höhe über Grund  (Philipps Vorgabe: höchstens die Höhe)
  let zugMinimum = 10.0;   // m — sonst käme man dicht am Bauteil nicht mehr weiter
  let sicherheit = 1.5;    // Reserve auf den aus der Zeigerbahn errechneten Weg
  let nachlaufMs = 1200;   // so lange nach dem Loslassen zählt die Trägheit mit

  // Die beiden Wege, auf denen der Kamera-Controller den Griff bestimmt.
  let originalGlobePick = null;
  let originalScenePick = null;
  let klemmeSteht = false;

  // Der laufende Zug (Riegel 2). null = gerade keiner.
  let zug = null;
  let zeiger = new Set();   // gedrückte Pointer — ab zwei ist es kein Ziehen mehr

  /**
   * Die Grenze in Metern. `hoeheUeberGrund` darf null sein (keine Kachel
   * geladen) — dann bleibt die Höhe über dem Ellipsoid der beste Anhaltspunkt.
   */
  function grenze(hoeheUeberGrund) {
    const h = (typeof hoeheUeberGrund === 'number' && isFinite(hoeheUeberGrund))
      ? Math.abs(hoeheUeberGrund) : 0;
    return Math.max(minimum, faktor * h);
  }

  /** Wie weit ein einzelner Zug die Kamera überhaupt versetzen darf. */
  function zugweite(hoeheUeberGrund) {
    const h = (typeof hoeheUeberGrund === 'number' && isFinite(hoeheUeberGrund))
      ? Math.abs(hoeheUeberGrund) : 0;
    return Math.max(zugMinimum, zugFaktor * h);
  }

  function hoeheUeberGrund() {
    if (!viewer) return null;
    const scene = viewer.scene;
    const carto = viewer.camera.positionCartographic;
    if (!carto) return null;
    const globe = scene.globe;
    if (globe && typeof globe.getHeight === 'function') {
      const gelaende = globe.getHeight(carto);
      // getHeight liest nur die schon geladene Kachel — fehlt sie, ist die
      // Höhe über dem Ellipsoid die ehrlichere Näherung als eine erfundene 0.
      if (typeof gelaende === 'number' && isFinite(gelaende)) return carto.height - gelaende;
    }
    return carto.height;
  }

  /** Liegt der Treffer weiter weg als erlaubt? */
  function zuWeit(treffer, kamera, weite) {
    if (!treffer) return false;
    return Cesium.Cartesian3.distance(treffer, kamera) > weite;
  }

  /**
   * Zieht den Griffpunkt auf demselben Sehstrahl bis auf `weite` heran.
   * Verändert `treffer` an Ort und Stelle — Cesium reicht hier seine eigenen
   * Zwischenspeicher durch und erwartet genau dieses Objekt zurück.
   */
  function klemmen(treffer, kamera, weite) {
    if (!treffer) return treffer;
    const abstand = Cesium.Cartesian3.distance(treffer, kamera);
    if (!(abstand > weite) || !(abstand > 0)) return treffer;
    const anteil = weite / abstand;
    treffer.x = kamera.x + (treffer.x - kamera.x) * anteil;
    treffer.y = kamera.y + (treffer.y - kamera.y) * anteil;
    treffer.z = kamera.z + (treffer.z - kamera.z) * anteil;
    return treffer;
  }

  // =========================================================================
  // RECHNEN — reine Funktionen, ohne Cesium und ohne Browser prüfbar
  // =========================================================================

  const laenge3 = (v) => Math.hypot(v.x, v.y, v.z);
  const punkt3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

  function mischen3(a, b, f, ziel) {
    ziel.x = a.x + (b.x - a.x) * f;
    ziel.y = a.y + (b.y - a.y) * f;
    ziel.z = a.z + (b.z - a.z) * f;
    return ziel;
  }

  function normieren3(v) {
    const l = laenge3(v);
    if (l > 0) { v.x /= l; v.y /= l; v.z /= l; }
    return v;
  }

  /**
   * Wie viel von einem Schritt `e` noch in die Kugel mit Radius `L` um den
   * Zugbeginn passt, wenn man schon bei `d` steht. Ergebnis in [0, 1].
   *
   * Gesucht ist f mit |d + f·e| = L, also die Nullstelle von
   * f²·|e|² + 2f·(d·e) + |d|² − L² = 0. Der lineare Dreisatz
   * (L − |d|) / |e| wäre nur richtig, wenn der Schritt radial nach außen
   * zeigte; bei jedem anderen Winkel bremste er zu früh, und das Ziehen
   * würde zäh, lange bevor die Grenze wirklich erreicht ist.
   */
  function anteilBisGrenze(d, e, L) {
    const ziel = { x: d.x + e.x, y: d.y + e.y, z: d.z + e.z };
    if (laenge3(ziel) <= L) return 1;
    const ee = punkt3(e, e);
    if (!(ee > 0)) return 1;
    const de = punkt3(d, e);
    const rest = punkt3(d, d) - L * L;
    const disk = de * de - ee * rest;
    if (disk < 0) return 0;                 // schon draußen und nach außen unterwegs
    const f = (-de + Math.sqrt(disk)) / ee;
    return Math.max(0, Math.min(1, f));
  }

  /** Wie viel eines Schrittes das Guthaben aus der Zeigerbahn noch deckt. */
  function schrittAnteil(schritt, guthaben) {
    if (!(schritt > 0)) return 1;
    if (guthaben >= schritt) return 1;
    return Math.max(0, guthaben / schritt);
  }

  /**
   * Mischt zwei Kamerastände. f = 0 → a, f = 1 → b.
   *
   * Der Betrag der Position wird eigens gemischt: die Sehne zwischen zwei
   * Punkten einer Kugel liegt INNERHALB der Kugel. Linear gemischt sänke die
   * Kamera bei jedem Bild ein Stück tiefer — auf Erdradius ist das messbar
   * viel und träte als langsames Absacken beim Ziehen zutage.
   */
  function standMischen(a, b, f, ziel) {
    mischen3(a.pos, b.pos, f, ziel.pos);
    const soll = laenge3(a.pos) + (laenge3(b.pos) - laenge3(a.pos)) * f;
    const ist = laenge3(ziel.pos);
    if (ist > 0 && soll > 0) {
      const s = soll / ist;
      ziel.pos.x *= s; ziel.pos.y *= s; ziel.pos.z *= s;
    }
    normieren3(mischen3(a.dir, b.dir, f, ziel.dir));
    normieren3(mischen3(a.up, b.up, f, ziel.up));
    // up rechtwinklig zu dir stellen — sonst kippt der Horizont über viele
    // Bilder hinweg langsam weg.
    const d = punkt3(ziel.up, ziel.dir);
    ziel.up.x -= ziel.dir.x * d;
    ziel.up.y -= ziel.dir.y * d;
    ziel.up.z -= ziel.dir.z * d;
    normieren3(ziel.up);
    return ziel;
  }

  // =========================================================================
  // KLEMME — nur für die Dauer eines Zugs
  // =========================================================================

  /**
   * Die Begrenzung gilt ausschließlich zwischen Drücken und Loslassen. Beide
   * Pick-Funktionen benutzt auch der Rest der Anwendung (Messen, Anklicken,
   * Notizen), und dort wäre eine stillschweigende Reichweitengrenze ein Fehler
   * und kein Komfort. Cesium fragt den Griffpunkt ohnehin nur bei der ersten
   * Bewegung eines Zugs ab.
   */
  function klemmeAn() {
    if (klemmeSteht || !aktiv || !viewer) return;
    const scene = viewer.scene;
    const globe = scene.globe;
    if (!globe) return;
    // Im Geh- und Flugmodus liegt die Kamera ohnehin nicht am Zeiger.
    if (typeof WalkMode !== 'undefined' && WalkMode.isEnabled && WalkMode.isEnabled()) return;

    const weite = grenze(hoeheUeberGrund());
    const kamera = Cesium.Cartesian3.clone(viewer.camera.positionWC, new Cesium.Cartesian3());

    originalGlobePick = globe.pickWorldCoordinates;
    globe.pickWorldCoordinates = function () {
      return klemmen(originalGlobePick.apply(this, arguments), kamera, weite);
    };

    if (typeof scene.pickPositionWorldCoordinates === 'function') {
      originalScenePick = scene.pickPositionWorldCoordinates;
      scene.pickPositionWorldCoordinates = function () {
        return klemmen(originalScenePick.apply(this, arguments), kamera, weite);
      };
    }
    klemmeSteht = true;
  }

  function klemmeAus() {
    if (!klemmeSteht) return;
    const scene = viewer.scene;
    if (originalGlobePick && scene.globe) scene.globe.pickWorldCoordinates = originalGlobePick;
    if (originalScenePick) scene.pickPositionWorldCoordinates = originalScenePick;
    originalGlobePick = null;
    originalScenePick = null;
    klemmeSteht = false;
  }

  // =========================================================================
  // ZUG — der begrenzte Weg zwischen Drücken und Loslassen
  // =========================================================================

  const leererStand = () => ({
    pos: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }
  });

  function standNehmen(camera, ziel) {
    ziel = ziel || leererStand();
    const p = camera.positionWC, d = camera.directionWC, u = camera.upWC;
    ziel.pos.x = p.x; ziel.pos.y = p.y; ziel.pos.z = p.z;
    ziel.dir.x = d.x; ziel.dir.y = d.y; ziel.dir.z = d.z;
    ziel.up.x = u.x; ziel.up.y = u.y; ziel.up.z = u.z;
    return ziel;
  }

  /**
   * Cesium mutiert `camera.position` selbst an Ort und Stelle (siehe `strafe`
   * im ScreenSpaceCameraController) — das ist der vorgesehene Weg. `right`
   * muss dabei von Hand nachgezogen werden, Cesium rechnet es aus
   * `direction × up`.
   */
  function standSetzen(camera, stand) {
    camera.position.x = stand.pos.x; camera.position.y = stand.pos.y; camera.position.z = stand.pos.z;
    camera.direction.x = stand.dir.x; camera.direction.y = stand.dir.y; camera.direction.z = stand.dir.z;
    camera.up.x = stand.up.x; camera.up.y = stand.up.y; camera.up.z = stand.up.z;
    Cesium.Cartesian3.cross(camera.direction, camera.up, camera.right);
    Cesium.Cartesian3.normalize(camera.right, camera.right);
  }

  /** Hält sich das Modul gerade heraus? */
  function fremdgesteuert() {
    if (!aktiv || !viewer) return true;
    const scene = viewer.scene, camera = viewer.camera;
    const ssc = scene.screenSpaceCameraController;
    if (ssc && ssc.enableInputs === false) return true;
    if (!Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY)) return true;
    if (typeof WalkMode !== 'undefined' && WalkMode.isEnabled && WalkMode.isEnabled()) return true;
    if (typeof FlugTrackpad !== 'undefined' && FlugTrackpad.blickAktiv && FlugTrackpad.blickAktiv()) return true;
    // Ein laufender Kameraflug (`flyTo`, „Ansicht zurücksetzen", `zoomTo`)
    // bewegt die Kamera absichtlich weit. Er fällt in dasselbe Zeitfenster wie
    // der Nachlauf eines Zugs und darf auf keinen Fall mitgebremst werden —
    // sonst käme man mit dem Knopf, der alles geradezieht, nicht mehr weg.
    // `_currentFlight` ist Cesium-intern, aber der einzige Hinweis darauf;
    // `scene.tweens` fängt den Fall ab, falls es ihn einmal nicht mehr gibt.
    if (camera._currentFlight) return true;
    if (scene.tweens && scene.tweens.length > 0) return true;
    return false;
  }

  function zeigerPunkt(e) {
    const r = viewer.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Der Punkt, den der Zug anfasst — Tiefenpuffer zuerst, Globus als Rückfall. */
  function griffPunkt(p) {
    const scene = viewer.scene, camera = viewer.camera;
    const fenster = new Cesium.Cartesian2(p.x, p.y);
    let treffer;
    if (scene.pickPositionSupported) {
      try { treffer = scene.pickPosition(fenster); } catch (e) { treffer = undefined; }
    }
    if (!Cesium.defined(treffer) && scene.globe) {
      const strahl = camera.getPickRay(fenster);
      if (strahl) { try { treffer = scene.globe.pick(strahl, scene); } catch (e) { treffer = undefined; } }
    }
    return Cesium.defined(treffer) ? treffer : null;
  }

  /** Meter je Zeigerpixel im Abstand `abstand` — Cesiums eigene Rechnung. */
  function meterJePixel(abstand) {
    const scene = viewer.scene, frustum = viewer.camera.frustum;
    if (!frustum || typeof frustum.getPixelDimensions !== 'function') return 0;
    const masse = frustum.getPixelDimensions(
      scene.drawingBufferWidth, scene.drawingBufferHeight,
      abstand, scene.pixelRatio, new Cesium.Cartesian2());
    // Cesium rechnet mit demselben Maß gegen die Zeigerpixel aus dem
    // ScreenSpaceEventHandler (siehe pan3D) — also nicht auf Gerätepixel
    // umrechnen.
    return Math.max(masse.x, masse.y);
  }

  function zugStarten(e) {
    zug = null;
    if (fremdgesteuert()) return;
    const camera = viewer.camera;
    const p = zeigerPunkt(e);
    const griff = griffPunkt(p);
    // Der Himmel ist kein Griff. Cesium schaut dort nur (`look3D`), die Kamera
    // bleibt stehen — es gibt nichts zu begrenzen.
    if (!griff) return;

    const kKarto = Cesium.Cartographic.fromCartesian(camera.positionWC);
    const gKarto = Cesium.Cartographic.fromCartesian(griff);
    const hoehe = (kKarto && gKarto) ? Math.abs(kKarto.height - gKarto.height)
                                     : (hoeheUeberGrund() || 0);
    const abstand = Cesium.Cartesian3.distance(griff, camera.positionWC);

    zug = {
      start: standNehmen(camera),
      vorher: standNehmen(camera),
      weite: zugweite(hoehe),
      // Der Hebel für die Zeigerbahn: der wirkliche Greifabstand, aber
      // höchstens die erlaubte Greifweite — sonst schenkte ein Griff am
      // Horizont dem Zug ein Guthaben über die halbe Landschaft.
      bezug: Math.max(1, Math.min(abstand, grenze(hoehe))),
      guthaben: 0,
      offen: true,
      ende: 0,
      zeiger: p
    };
  }

  function zugWeiter(e) {
    if (!zug || !zug.offen) return;
    const p = zeigerPunkt(e);
    const weg = Math.hypot(p.x - zug.zeiger.x, p.y - zug.zeiger.y);
    zug.zeiger = p;
    zug.guthaben = Math.min(zug.weite, zug.guthaben + weg * meterJePixel(zug.bezug) * sicherheit);
  }

  /**
   * Losgelassen — aber noch nicht vorbei: Cesium lässt den Zug mit Trägheit
   * ausrollen. Die Wegmarke gilt weiter, das Guthaben aus der Zeigerbahn
   * nicht mehr; so klingt die Trägheit natürlich aus, bleibt aber innerhalb
   * dessen, was der Zug insgesamt durfte.
   */
  function zugLoslassen() {
    if (!zug) return;
    zug.offen = false;
    zug.ende = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + nachlaufMs;
  }

  const gemischt = leererStand();
  const jetzt = leererStand();

  function pruefen() {
    if (!zug) return;
    const nun = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!zug.offen && nun > zug.ende) { zug = null; return; }
    if (fremdgesteuert()) { zug = null; return; }

    const camera = viewer.camera;
    standNehmen(camera, jetzt);

    const e = {
      x: jetzt.pos.x - zug.vorher.pos.x,
      y: jetzt.pos.y - zug.vorher.pos.y,
      z: jetzt.pos.z - zug.vorher.pos.z
    };
    const schritt = laenge3(e);
    if (schritt < 1e-6) { standNehmen(camera, zug.vorher); return; }

    const d = {
      x: zug.vorher.pos.x - zug.start.pos.x,
      y: zug.vorher.pos.y - zug.start.pos.y,
      z: zug.vorher.pos.z - zug.start.pos.z
    };

    let f = anteilBisGrenze(d, e, zug.weite);
    if (zug.offen) f = Math.min(f, schrittAnteil(schritt, zug.guthaben));

    if (f < 1) {
      standSetzen(camera, standMischen(zug.vorher, jetzt, f, gemischt));
      if (viewer.scene.requestRender) viewer.scene.requestRender();
    }
    if (zug.offen) zug.guthaben = Math.max(0, zug.guthaben - schritt * f);
    standNehmen(camera, zug.vorher);
  }

  // =========================================================================
  // START
  // =========================================================================

  function init(cesiumViewer) {
    if (viewer) return;
    viewer = cesiumViewer || (typeof BimViewer !== 'undefined' ? BimViewer.viewer : null);
    if (!viewer) return;
    const canvas = viewer.canvas;

    // Vor Cesium: der Griffpunkt fällt erst bei der ersten Bewegung, das
    // Drücken kommt in jedem Fall zuerst. Capture, damit kein Werkzeug
    // dazwischen abbricht.
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerId !== undefined) zeiger.add(e.pointerId);
      // Zwei Finger sind kein Ziehen, sondern Kippen und Zoomen. Die Wegmarke
      // eines Zugs würde dort das Herausfahren abwürgen.
      if (zeiger.size > 1) { zug = null; return; }
      // Rechts zoomt, die Mitte kippt. Beide sollen ungebremst arbeiten — und
      // ein Zug, der noch im Nachlauf steht, würde ihnen sonst die ersten
      // Zehntelsekunden abschneiden.
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) { zug = null; return; }
      // Erst messen, dann klemmen — sonst käme der eigene Griffpunkt schon
      // gekürzt zurück und der Hebel für die Zeigerbahn wäre zu klein.
      zugStarten(e);
      klemmeAn();
    }, { capture: true });

    window.addEventListener('pointermove', zugWeiter, { capture: true, passive: true });

    ['pointerup', 'pointercancel'].forEach(art =>
      window.addEventListener(art, (e) => {
        if (e && e.pointerId !== undefined) zeiger.delete(e.pointerId);
        klemmeAus();
        zugLoslassen();
      }, { capture: true }));
    window.addEventListener('blur', () => {
      zeiger.clear();
      klemmeAus();
      zug = null;
    }, { capture: true });

    // preUpdate läuft unmittelbar NACH `initializeFrame`, und dort bewegt der
    // ScreenSpaceCameraController die Kamera. Genau hier ist der Schritt eines
    // Bildes messbar, und nur hier.
    viewer.scene.preUpdate.addEventListener(pruefen);

    console.log('[Greifweite] aktiv — Griff auf', faktor + '× Höhe über Grund, mindestens', minimum + ' m;',
      'Zug auf', zugFaktor + '× Höhe, mindestens', zugMinimum + ' m');
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
    an: () => { aktiv = true; },
    aus: () => { aktiv = false; klemmeAus(); zug = null; },
    istAn: () => aktiv,
    einstellen: (o) => {
      if (!o) return;
      if (typeof o.faktor === 'number' && o.faktor > 0) faktor = o.faktor;
      if (typeof o.minimum === 'number' && o.minimum >= 0) minimum = o.minimum;
      if (typeof o.zugFaktor === 'number' && o.zugFaktor > 0) zugFaktor = o.zugFaktor;
      if (typeof o.zugMinimum === 'number' && o.zugMinimum >= 0) zugMinimum = o.zugMinimum;
      if (typeof o.sicherheit === 'number' && o.sicherheit > 0) sicherheit = o.sicherheit;
      if (typeof o.nachlaufMs === 'number' && o.nachlaufMs >= 0) nachlaufMs = o.nachlaufMs;
      if (typeof o.aus === 'boolean') aktiv = !o.aus;
    },
    werte: () => ({ faktor, minimum, zugFaktor, zugMinimum, sicherheit, nachlaufMs, aktiv }),
    zustand: () => (zug ? {
      weite: zug.weite, bezug: zug.bezug, guthaben: zug.guthaben, offen: zug.offen,
      versatz: Math.hypot(zug.vorher.pos.x - zug.start.pos.x,
                          zug.vorher.pos.y - zug.start.pos.y,
                          zug.vorher.pos.z - zug.start.pos.z)
    } : null),
    _pruefsteine: {
      grenze, zuWeit, klemmen, zugweite, anteilBisGrenze, schrittAnteil, standMischen,
      einstellen: (f, m) => { faktor = f; minimum = m; },
      zugEinstellen: (f, m) => { zugFaktor = f; zugMinimum = m; }
    },
  };

})();
