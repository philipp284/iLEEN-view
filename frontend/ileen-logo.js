/**
 * ileen-logo.js — der Schriftzug als Körper im Orbit
 *
 * Beim Öffnen steht die Kamera 10 000 km über Mitteleuropa und schaut
 * senkrecht nach unten (CONFIG.camera.DEFAULT_POSITION in core.js). In genau
 * diesen Blick wird das Logo gelegt: 4 500 km breit, 3 500 km über Grund,
 * flach in der Ost-Nord-Ebene, Oberkante nach Norden — aus der Startansicht
 * also lesbar, mit der Erde als Hintergrund.
 *
 * Das Modell ist ein echtes glTF (Assets/ileen-logo.glb), kein Bildschirm-
 * Overlay: es hat Tiefe, wirft die Sonne über seine Kanten und bleibt beim
 * Drehen der Kamera an seinem Ort im Raum stehen. Erzeugt wird es aus dem
 * Originallogo — siehe tools/make-ileen-logo.py.
 *
 * Beim Hineinzoomen blendet es sich aus (unter 2 500 km beginnend, unter
 * 1 200 km ganz weg). Ohne das hinge über jedem Bauwerk in Deutschland eine
 * kontinentgroße Platte am Himmel.
 *
 * API (auch in der Konsole):
 *   BimViewer.ILeenLogo.zeigen() / verbergen() / umschalten()
 *   BimViewer.ILeenLogo.hinfliegen()
 *   BimViewer.ILeenLogo.setzen({ lon, lat, hoehe, breite, heading })
 */
(function () {
  'use strict';

  const SPEICHER = 'ileen_logo_v1';
  const GLB = 'Assets/ileen-logo.glb';

  // Breite : Versalhöhe des Schriftzugs, aus dem GLB (X-Ausdehnung bei
  // Versalhöhe 1.0). Steht hier, weil die Breite in Metern angegeben wird —
  // das ist die Größe, die man im Bild abschätzt.
  const SEITENVERHAELTNIS = 6.465;

  const VORGABE = {
    lon: 10.9544,          // wird unten aus CONFIG.camera überschrieben,
    lat: 50.7323,          // damit Logo und Startansicht zusammenbleiben
    hoehe: 3.5e6,          // m über Ellipsoid
    breite: 4.5e6,         // m, Gesamtbreite des Schriftzugs
    heading: 0             // rad, Drehung um die lokale Hochachse
  };

  const AUSBLENDEN_AB = 2.5e6;   // Kamerahöhe, ab der das Logo zu verblassen
  const AUSGEBLENDET = 1.2e6;    // beginnt, und ab der es ganz weg ist

  const Logo = {
    modell: null,
    lage: Object.assign({}, VORGABE),
    sichtbar: true,
    _laedt: false,
    _horcher: null,

    // ---------------------------------------------------------------- Laden

    async init(viewer) {
      if (this.modell || this._laedt) return this.modell;
      if (!viewer || !viewer.scene) return null;
      this._laedt = true;

      const gespeichert = lesen();
      Object.assign(this.lage, standortAusConfig(), gespeichert.lage || {});
      if (gespeichert.sichtbar === false) this.sichtbar = false;

      try {
        const modell = await Cesium.Model.fromGltfAsync({
          url: GLB,
          modelMatrix: matrix(this.lage),
          scale: this.lage.breite / SEITENVERHAELTNIS,
          // Achsenkorrektur abschalten, damit das Logo flach liegt.
          //
          // Für glTF nimmt Cesium sonst upAxis=Y und forwardAxis=Z an und
          // rechnet Y_UP_TO_Z_UP · Z_UP_TO_X_UP (ModelUtility.js) — daraus
          // wird +X → Nord, +Y → OBEN, +Z → Ost: der Schriftzug stünde
          // hochkant auf der Hochachse. Mit upAxis=Z, forwardAxis=X ist die
          // Korrektur die Einheitsmatrix, und die Modellachsen sind
          // deckungsgleich mit Ost/Nord/Oben: die Schrift liegt in der
          // Ost-Nord-Ebene, die Vorderseite schaut in den Himmel.
          //
          // Die Datei selbst bleibt dabei richtig herum modelliert (Y-up,
          // aufrecht) — so wie sie ein glTF-Viewer oder Blender erwartet.
          upAxis: Cesium.Axis.Z,
          forwardAxis: Cesium.Axis.X,
          // Der Schriftzug ist ein Zeichen, kein Bauteil: er soll weder
          // Schatten auf die Erde werfen noch von ihr verschattet werden.
          shadows: Cesium.ShadowMode.DISABLED,
          // Nichts am Logo ist anklickbar — sonst fängt eine 4500 km breite
          // Fläche jeden Klick ab, mit dem jemand ein Gebäude treffen wollte.
          allowPicking: false,
          // Erst zeichnen, wenn alles da ist: ein halb geladenes Logo, das
          // buchstabenweise erscheint, sieht nach Fehler aus.
          incrementallyLoadTextures: false
        });

        modell.show = this.sichtbar;
        viewer.scene.primitives.add(modell);
        this.modell = modell;

        this._horcher = viewer.scene.preRender.addEventListener(() => {
          this._nachHoeheEinblenden(viewer);
        });

        console.log('🌍 iLEEN-Logo im Orbit:',
          `${(this.lage.breite / 1000).toFixed(0)} km breit,`,
          `${(this.lage.hoehe / 1000).toFixed(0)} km hoch`);
      } catch (fehler) {
        // Fehlt das GLB, ist der Viewer trotzdem voll benutzbar — deshalb nur
        // eine Warnung mit dem Weg zur Reparatur.
        console.warn('⚠️ iLEEN-Logo nicht geladen:', fehler.message,
          '— neu erzeugen mit: python3 tools/make-ileen-logo.py');
      } finally {
        this._laedt = false;
      }
      return this.modell;
    },

    // ------------------------------------------------------------- Bedienen

    zeigen() { this._umschalten(true); },
    verbergen() { this._umschalten(false); },
    umschalten() { this._umschalten(!this.sichtbar); },

    _umschalten(an) {
      this.sichtbar = an;
      if (this.modell) this.modell.show = an;
      schreiben({ sichtbar: an, lage: this.lage });
    },

    /** Lage oder Größe ändern; angegeben wird nur, was sich ändern soll. */
    setzen(werte) {
      Object.assign(this.lage, werte || {});
      if (this.modell) {
        this.modell.modelMatrix = matrix(this.lage);
        this.modell.scale = this.lage.breite / SEITENVERHAELTNIS;
      }
      schreiben({ sichtbar: this.sichtbar, lage: this.lage });
      return this.lage;
    },

    /** Zurück in die Startansicht — schräg von oben, Erde im Rücken. */
    hinfliegen(dauer) {
      const viewer = window.BimViewer && BimViewer.viewer;
      if (!viewer || !this.modell) return;
      if (!this.sichtbar) this.zeigen();
      viewer.camera.flyToBoundingSphere(this.modell.boundingSphere, {
        duration: typeof dauer === 'number' ? dauer : 3.0,
        offset: new Cesium.HeadingPitchRange(
          0, Cesium.Math.toRadians(-78), this.lage.breite * 1.6)
      });
    },

    // Zwischen AUSGEBLENDET und AUSBLENDEN_AB linear überblenden. Ein harter
    // Schnitt an einer Höhe ließe das Logo bei jeder kleinen Kamerabewegung
    // an der Schwelle flackern.
    _nachHoeheEinblenden(viewer) {
      if (!this.modell || !this.sichtbar) return;
      const h = viewer.camera.positionCartographic.height;
      const anteil = Cesium.Math.clamp(
        (h - AUSGEBLENDET) / (AUSBLENDEN_AB - AUSGEBLENDET), 0.0, 1.0);
      this.modell.show = anteil > 0.01;
      this.modell.color = Cesium.Color.WHITE.withAlpha(anteil);
    }
  };

  // ------------------------------------------------------------------ Lage

  /**
   * Objekt → ECEF, zwei Schritte, von rechts nach links gelesen:
   *   drehen  Heading um die lokale Hochachse, im Kompasssinn (0 = Schrift
   *           liegt nach Osten, Oberkante nach Norden).
   *   enu     Ost-Nord-Oben am Standort → erdfestes System.
   * Gekippt wird hier nichts: das erledigen upAxis/forwardAxis beim Laden.
   * Die Größe steckt nicht hier, sondern in model.scale.
   */
  function matrix(lage) {
    const ursprung = Cesium.Cartesian3.fromDegrees(
      lage.lon, lage.lat, lage.hoehe);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(ursprung);
    const drehen = Cesium.Matrix4.fromRotationTranslation(
      Cesium.Matrix3.fromRotationZ(-(lage.heading || 0)));
    return Cesium.Matrix4.multiply(enu, drehen, new Cesium.Matrix4());
  }

  /** Standort der Startkamera, damit das Logo mitwandert, wenn sie umzieht. */
  function standortAusConfig() {
    try {
      const p = CONFIG.camera.DEFAULT_POSITION;
      if (typeof p.longitude === 'number' && typeof p.latitude === 'number') {
        return { lon: p.longitude, lat: p.latitude };
      }
    } catch (_) { /* CONFIG gehört core.js — fehlt es, bleibt die Vorgabe */ }
    return {};
  }

  // -------------------------------------------------------------- Speicher

  function lesen() {
    try { return JSON.parse(localStorage.getItem(SPEICHER)) || {}; }
    catch (_) { return {}; }
  }

  function schreiben(zustand) {
    try { localStorage.setItem(SPEICHER, JSON.stringify(zustand)); }
    catch (_) { /* privater Modus: dann eben ohne Gedächtnis */ }
  }

  // ------------------------------------------------------------- Einhängen

  // Das Modul wartet selbst auf den Viewer, statt in den Startablauf von
  // index.html einzugreifen: es ist Beiwerk und darf nichts blockieren.
  function warten() {
    let versuche = 0;
    const takt = setInterval(function () {
      if (window.BimViewer && BimViewer.viewer && BimViewer.viewer.scene) {
        clearInterval(takt);
        Logo.init(BimViewer.viewer);
      } else if (++versuche > 240) {         // 2 Minuten, dann gibt es keinen
        clearInterval(takt);                 // Viewer mehr, auf den zu warten
      }
    }, 500);
  }

  window.BimViewer = window.BimViewer || {};
  window.BimViewer.ILeenLogo = Logo;
  warten();
})();
