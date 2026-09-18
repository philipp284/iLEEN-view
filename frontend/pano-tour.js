/**
 * pano-tour.js — 360°-Rundgang im georeferenzierten Modell (wie Matterport)
 *
 * Ein Rundgang ist eine Liste von Standpunkten (Spots). Jeder Spot hat eine
 * Weltlage (lon/lat/Höhe), eine Blickausrichtung und ein equirectangulares
 * 360°-Panorama. Klickt man einen Spot an, fliegt die Kamera dorthin, das
 * Panorama wird von innen auf eine Kugel um die Kamera gelegt, und man sieht
 * sich um wie in einem Foto — von dort führen die Nachbar-Spots weiter.
 *
 * Der Kern ist BEWUSST quell-agnostisch: er liest eine `tour.json` mit
 * fertigen Spots und weiß nicht, woher Panorama und Pose stammen. Zubringer
 * (Stativ-E57 mit eingebetteten Panoramen, separate 360°-Fotos, von Hand
 * gesetzte Spots) schreiben alle in dasselbe Format. Diese Trennung ist der
 * Grund, warum das Modul mit einem synthetischen Testpanorama vollständig
 * prüfbar ist, ohne dass eine einzige E57-Datei im Spiel sein muss.
 *
 * Warum eine Kugel statt eines Bildschirm-Overlays: das Panorama liegt als
 * echter Körper an der Aufnahmestelle im Raum — dieselbe Machart wie beim
 * iLEEN-Logo (ileen-logo.js). Dadurch bleibt der Weltbezug erhalten: man kann
 * zwischen Foto-Rundgang und Fachmodell hin- und herblenden, und ein Spot
 * liegt genau dort, wo im BIM-Modell die Kamera stand.
 *
 * Format `tour.json`:
 *   {
 *     "version": 1,
 *     "name": "Rundgang Erdgeschoss",
 *     "spots": [
 *       { "id": "s1", "name": "Eingang",
 *         "lon": 8.2599, "lat": 49.9929, "hoehe": 112.0,
 *         "heading": 0.0,               // rad, Blickrichtung der Bildmitte
 *         "panorama": "pano/s1.jpg",    // relativ zur tour.json
 *         "nachbarn": ["s2", "s5"] }    // optional; sonst automatisch
 *     ]
 *   }
 *
 * API (auch in der Konsole / über ileen_viewer_js):
 *   BimViewer.PanoTour.laden(urlOderObjekt)   // Tour laden, Spots als Marken
 *   BimViewer.PanoTour.betreten(spotId)       // in einen Spot hineingehen
 *   BimViewer.PanoTour.verlassen()            // zurück in die Übersicht
 *   BimViewer.PanoTour.weiter() / zurueck()   // durch die Nachbarn blättern
 *   BimViewer.PanoTour.zustand()              // { aktiv, imRundgang, anzahl }
 *   BimViewer.PanoTour.leeren()               // Tour entfernen
 */
(function () {
  'use strict';

  // Radius der Panoramakugel in Metern. Groß genug, dass die Kamera in der
  // Mitte weit von der Wand entfernt ist (kein sichtbares Verzerren beim
  // Umsehen), klein genug, dass sie nicht mit anderen Szenenteilen streitet —
  // die Tiefenprüfung ist ohnehin abgeschaltet, die Kugel ist reiner
  // Hintergrund wie ein Skybox.
  var KUGEL_R = 50.0;

  // Überblendung Spot → Spot und beim ersten Betreten (Sekunden).
  var BLENDE_S = 0.7;
  var FLUG_S = 1.1;

  // Öffnungswinkel-Grenzen beim Zoomen im Panorama (rad). Plain gerechnet
  // (Grad·π/180) statt über Cesium, damit die oberste Modulebene ohne Cesium
  // lädt — der Node-Prüfstein braucht die reinen Rechenteile ohne Browser.
  var FOV_MIN = 30 * Math.PI / 180;
  var FOV_MAX = 110 * Math.PI / 180;

  // Nickwinkel beim Umsehen: knapp unter senkrecht, sonst kippt der Horizont
  // über den Pol und die Steuerung fühlt sich verkehrt an.
  var PITCH_MAX = 85 * Math.PI / 180;

  // Automatische Nachbarschaft, wenn die Tour keine `nachbarn` mitbringt:
  // jeder Spot bekommt die nächsten innerhalb dieses Radius, höchstens so viele.
  var AUTO_RADIUS_M = 12.0;
  var AUTO_MAX = 4;

  // Ausrichtung der equirectangularen Textur — die eine Festlegung, die nur
  // das Bild selbst beantwortet (wie die flipY-Notiz in geschossplaene.js).
  // Von INNEN gesehen ist eine normal texturierte Kugel horizontal gespiegelt:
  // die st der Cesium-EllipsoidGeometry sind fürs Betrachten von AUSSEN
  // gedacht, drum die Spiegelung (Skalierung −1 in X) — ohne sie liefe das
  // Umsehen seitenverkehrt (nach rechts drehen zeigte, was links liegt).
  // NORD_VERSATZ dreht die Textur zusätzlich so, dass die Bildspalte, die nach
  // Norden zeigen soll, bei heading 0 auch nach Norden fällt; für die
  // EllipsoidGeometry-st-Konvention (u aus atan2(y,x)+0.5) sind das 90°.
  // Beide zusammen liefern: schaut man nach Kompass-Norden, steht die
  // Bildspalte „Norden" in der Mitte, und Drehen nach rechts pant nach rechts.
  var NORD_VERSATZ = Math.PI / 2;

  var PanoTour = {
    viewer: null,
    spots: [],            // normalisierte Spots, _pos als Cartesian3
    _proMitte: {},        // id → Spot
    tourName: '',
    basisUrl: '',
    aktiv: null,          // id des aktuellen Spots, null = Übersicht
    imRundgang: false,

    _quelle: null,        // CustomDataSource der Hotspot-Marken
    _kugel: null,         // aktuelle Panorama-Primitive
    _kugelAlt: null,      // während der Überblendung
    _klick: null,         // ScreenSpaceEventHandler für Hotspot-Klicks
    _tasten: null,        // keydown-Handler (Esc)
    _blick: { heading: 0, pitch: 0 },
    _zieht: null,         // laufendes Umsehen { x, y }
    _anim: null,          // laufende Überblendung/Flug
    _tick: null,          // rAF-Handle
    _modellStand: null,   // gemerkte Sichtbarkeit der Tilesets

    // ------------------------------------------------------------- Anbinden

    init: function (viewer) {
      if (this.viewer) return;
      if (!viewer || !viewer.scene) return;
      this.viewer = viewer;
      this._quelle = new Cesium.CustomDataSource('pano-tour');
      viewer.dataSources.add(this._quelle);
      console.log('📷 PanoTour bereit');
    },

    // --------------------------------------------------------------- Laden

    /** Tour aus einer URL (tour.json) oder direkt aus einem Objekt laden. */
    laden: async function (quelle) {
      if (!this.viewer) this.init(window.BimViewer && BimViewer.viewer);
      this.verlassen();

      var json, basis = '';
      if (typeof quelle === 'string') {
        var antwort = await fetch(quelle);
        if (!antwort.ok) throw new Error('Tour nicht ladbar: HTTP ' + antwort.status);
        json = await antwort.json();
        basis = quelle.slice(0, quelle.lastIndexOf('/') + 1);
      } else {
        json = quelle || {};
        basis = json.basisUrl || '';
      }

      this.basisUrl = basis;
      this.tourName = json.name || 'Rundgang';
      this.spots = P.tourNormalisieren(json, basis);
      this.spots.forEach(function (s) {
        s._pos = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.hoehe);
      });
      P.nachbarnBilden(this.spots, { radius: AUTO_RADIUS_M, maxN: AUTO_MAX });

      this._proMitte = {};
      this.spots.forEach(function (s) { this._proMitte[s.id] = s; }, this);

      this._markenZeichnen();
      this._melden();
      console.log('📷 Tour „' + this.tourName + '" —', this.spots.length, 'Spots');
      return this.spots.length;
    },

    leeren: function () {
      this.verlassen();
      if (this._quelle) this._quelle.entities.removeAll();
      this.spots = [];
      this._proMitte = {};
      this.tourName = '';
      this._melden();
    },

    // ---------------------------------------------------------- Hotspots

    _markenZeichnen: function () {
      var q = this._quelle;
      if (!q) return;
      q.entities.removeAll();
      this.spots.forEach(function (s) {
        q.entities.add({
          id: 'panospot-' + s.id,
          position: s._pos,
          point: {
            pixelSize: 14,
            color: Cesium.Color.fromCssColorString('#30B4E7').withAlpha(0.9),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            // Durch Wände sichtbar — sonst findet man den nächsten Standpunkt
            // hinter der Wand nicht, an der man gerade steht.
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          },
          label: {
            text: s.name || s.id,
            font: '600 12px system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
            pixelOffset: new Cesium.Cartesian2(0, -20),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scale: 0.9
          }
        });
      });
      this._hotspotsAn();
    },

    /** Klicks auf Hotspot-Marken abfangen und dorthin gehen. */
    _hotspotsAn: function () {
      if (this._klick || !this.viewer) return;
      var self = this;
      this._klick = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
      this._klick.setInputAction(function (bewegung) {
        var treffer = self.viewer.scene.pick(bewegung.position);
        if (!treffer || !treffer.id || !treffer.id.id) return;
        var id = String(treffer.id.id);
        if (id.indexOf('panospot-') !== 0) return;
        self.betreten(id.slice('panospot-'.length));
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    // ------------------------------------------------------- Spot betreten

    betreten: function (spotId) {
      var ziel = this._proMitte[spotId];
      if (!ziel || !this.viewer) return;
      var vorher = this.imRundgang;

      // Neue Kugel unsichtbar vorbereiten und einblenden.
      var neu = this._kugelBauen(ziel, 0.0);
      this.viewer.scene.primitives.add(neu);
      var alt = this._kugel;
      this._kugel = neu;
      this._kugelAlt = alt;

      if (!this.imRundgang) this._rundgangAn();
      this.aktiv = spotId;
      // Während der Kamera fliegt, treibt das Umsehen nicht mit — sonst
      // streiten flyTo und die eigenen setView-Aufrufe um dieselbe Kamera.
      this._uebergang = true;

      var self = this;
      var start = performance.now();
      // Die Überblendung der Kugeln läuft parallel zum Kameraflug über die
      // Animationsuhr; requestRender hält sie auch unter requestRenderMode
      // (core.js schaltet ihn zeitweise) sichtbar.
      var dauer = (vorher && alt ? BLENDE_S : FLUG_S) * 1000;
      this._anim = {
        lauf: function (jetzt) {
          var t = Cesium.Math.clamp((jetzt - start) / dauer, 0, 1);
          var e = t * t * (3 - 2 * t);
          self._kugelAlpha(neu, e);
          if (alt) self._kugelAlpha(alt, 1 - e);
          self.viewer.scene.requestRender();
          if (t >= 1) {
            if (alt) self.viewer.scene.primitives.remove(alt);
            self._kugelAlt = null;
            self._anim = null;
          }
        }
      };

      // Kamera zum Standpunkt fliegen und dort ausrichten. flyTo eased sowohl
      // den kurzen Weg zwischen zwei Spots als auch den langen aus der
      // Übersicht — kein lineares Lerp aus dem Orbit mehr.
      this.viewer.camera.flyTo({
        destination: ziel._pos,
        orientation: { heading: ziel.heading || 0, pitch: 0, roll: 0 },
        duration: vorher && alt ? BLENDE_S : FLUG_S,
        complete: function () {
          self._blick.heading = ziel.heading || 0;
          self._blick.pitch = 0;
          self._uebergang = false;
        }
      });

      this._nachbarnHervorheben();
      this._melden();
    },

    /** Zum nächsten / vorigen Nachbarn des aktuellen Spots. */
    weiter: function () { this._blaettern(1); },
    zurueck: function () { this._blaettern(-1); },
    _blaettern: function (richtung) {
      if (!this.aktiv) return;
      var s = this._proMitte[this.aktiv];
      if (!s || !s.nachbarn.length) return;
      // Der zuletzt gegangene Nachbar merkt sich der Spot nicht — geblättert
      // wird der Reihe nach durch die Nachbarliste, das genügt zum Erkunden.
      var i = (s._blatt || 0);
      i = (i + richtung + s.nachbarn.length) % s.nachbarn.length;
      s._blatt = i;
      this.betreten(s.nachbarn[i]);
    },

    verlassen: function () {
      if (!this.imRundgang) { this.aktiv = null; return; }
      this._rundgangAus();
      if (this._kugel) { this.viewer.scene.primitives.remove(this._kugel); this._kugel = null; }
      if (this._kugelAlt) { this.viewer.scene.primitives.remove(this._kugelAlt); this._kugelAlt = null; }
      this._anim = null;
      var pos = this.aktiv && this._proMitte[this.aktiv]
        ? this._proMitte[this.aktiv]._pos : null;
      this.aktiv = null;
      this._hotspotsFarbe();
      // Aus der Vogelschau auf den zuletzt besuchten Spot herabsehen.
      if (pos && this.viewer) {
        this.viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(pos, 12), {
            duration: 1.2,
            offset: new Cesium.HeadingPitchRange(
              this._blick.heading, Cesium.Math.toRadians(-45), 24)
          });
      }
      this._melden();
    },

    zustand: function () {
      return {
        name: this.tourName,
        anzahl: this.spots.length,
        aktiv: this.aktiv,
        imRundgang: this.imRundgang,
        fov: this.viewer ? Cesium.Math.toDegrees(this.viewer.camera.frustum.fov) : null
      };
    },

    // ----------------------------------------------------- Rundgang-Modus

    _rundgangAn: function () {
      this.imRundgang = true;
      var s = this.viewer.scene;
      var c = s.screenSpaceCameraController;
      // Die Standardsteuerung dreht am Globus; im Panorama soll die Kamera an
      // der Stelle bleiben und sich nur umsehen — das treibt dieses Modul
      // selbst (Ziehen → heading/pitch), also alle Cesium-Eingaben aus.
      this._sscc = {
        rotate: c.enableRotate, translate: c.enableTranslate,
        zoom: c.enableZoom, tilt: c.enableTilt, look: c.enableLook
      };
      c.enableRotate = c.enableTranslate = c.enableZoom =
        c.enableTilt = c.enableLook = false;

      // Das Fachmodell tritt zurück — im Panorama IST das Foto die Welt.
      // Über „Modell einblenden" lässt es sich als georeferenzierte
      // Überlagerung wieder hinzuschalten.
      this._modellVerbergen();

      this._umsehenAn();
      this._tastenAn();
      this._laufAn();
    },

    _rundgangAus: function () {
      this.imRundgang = false;
      var c = this.viewer.scene.screenSpaceCameraController;
      if (this._sscc) {
        c.enableRotate = this._sscc.rotate; c.enableTranslate = this._sscc.translate;
        c.enableZoom = this._sscc.zoom; c.enableTilt = this._sscc.tilt;
        c.enableLook = this._sscc.look;
        this._sscc = null;
      }
      this._modellZeigen(true);
      this._umsehenAus();
      this._tastenAus();
      this._laufAus();
    },

    // -------------------------------------------------------- Umsehen

    _umsehenAn: function () {
      var self = this, canvas = this.viewer.scene.canvas;
      this._maus = new Cesium.ScreenSpaceEventHandler(canvas);
      this._maus.setInputAction(function (e) { self._zieht = { x: e.position.x, y: e.position.y }; },
        Cesium.ScreenSpaceEventType.LEFT_DOWN);
      this._maus.setInputAction(function (e) {
        if (!self._zieht) return;
        var dx = e.endPosition.x - self._zieht.x;
        var dy = e.endPosition.y - self._zieht.y;
        self._zieht = { x: e.endPosition.x, y: e.endPosition.y };
        var k = 0.0025 * (self.viewer.camera.frustum.fov / Cesium.Math.toRadians(60));
        self._blick.heading = P.wrap(self._blick.heading - dx * k);
        self._blick.pitch = Cesium.Math.clamp(self._blick.pitch + dy * k, -PITCH_MAX, PITCH_MAX);
        self._kameraSetzen(self._proMitte[self.aktiv]._pos);
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      this._maus.setInputAction(function () { self._zieht = null; },
        Cesium.ScreenSpaceEventType.LEFT_UP);
      // Rad = Öffnungswinkel (Zoom im Bild), wie in Street View.
      this._maus.setInputAction(function (bewegung) {
        var f = self.viewer.camera.frustum;
        if (!(f instanceof Cesium.PerspectiveFrustum)) return;
        f.fov = Cesium.Math.clamp(f.fov * (bewegung > 0 ? 0.92 : 1.08), FOV_MIN, FOV_MAX);
        self.viewer.scene.requestRender();
      }, Cesium.ScreenSpaceEventType.WHEEL);
    },

    _umsehenAus: function () {
      if (this._maus) { this._maus.destroy(); this._maus = null; }
      this._zieht = null;
    },

    _tastenAn: function () {
      var self = this;
      this._tasten = function (e) {
        if (e.key === 'Escape') { self.verlassen(); }
        else if (e.key === 'ArrowRight') { self.weiter(); }
        else if (e.key === 'ArrowLeft') { self.zurueck(); }
      };
      window.addEventListener('keydown', this._tasten);
    },
    _tastenAus: function () {
      if (this._tasten) { window.removeEventListener('keydown', this._tasten); this._tasten = null; }
    },

    // ----------------------------------------------------- Animationsuhr

    _laufAn: function () {
      if (this._tick) return;
      var self = this;
      (function schritt(jetzt) {
        if (!self.imRundgang) { self._tick = null; return; }
        if (self._anim) self._anim.lauf(jetzt || performance.now());
        self._tick = requestAnimationFrame(schritt);
      })(performance.now());
    },
    _laufAus: function () {
      if (this._tick) { cancelAnimationFrame(this._tick); this._tick = null; }
    },

    // -------------------------------------------------------- Kamera

    _kameraSetzen: function (pos) {
      // Während des Kamerafluges nicht dazwischenfunken (flyTo führt die
      // Kamera selbst); danach hält dieses setView die Kamera am Standpunkt
      // fest und dreht nur die Blickrichtung.
      if (this._uebergang) return;
      this.viewer.camera.setView({
        destination: pos,
        orientation: {
          heading: this._blick.heading,
          pitch: this._blick.pitch,
          roll: 0
        }
      });
      this.viewer.scene.requestRender();
    },

    // -------------------------------------------------- Panoramakugel

    _kugelBauen: function (spot, alpha) {
      var geom = new Cesium.EllipsoidGeometry({
        radii: new Cesium.Cartesian3(KUGEL_R, KUGEL_R, KUGEL_R),
        // Genug Unterteilung, dass die equirectangulare Textur nicht an den
        // Polen einbricht; mehr kostet an einer einzelnen Kugel nichts.
        stackPartitions: 64,
        slicePartitions: 64,
        vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat
      });
      var material = Cesium.Material.fromType('Image', {
        image: spot.panorama,
        color: Cesium.Color.WHITE.withAlpha(alpha)
      });
      var appearance = new Cesium.MaterialAppearance({
        material: material,
        flat: true,             // kein Licht — das Panorama bringt seine
        translucent: true,      // Helligkeit selbst mit
        renderState: {
          // Von innen gesehen: die Rückflächen sind die Wand. Nicht kullern,
          // sonst verschwindet die Innenseite. Tiefe aus — die Kugel ist reiner
          // Hintergrund und darf die Hotspot-Marken nie verdecken.
          cull: { enabled: false },
          depthTest: { enabled: false },
          depthMask: false
        }
      });
      // Ost-Nord-Oben an der Aufnahmestelle: die Kugelpole liegen dadurch auf
      // der Hochachse (oben/unten des Panoramas), der Äquator auf dem Horizont —
      // genau die equirectangulare Zuordnung. Die Drehung um die Hochachse
      // (heading + NORD_VERSATZ) legt fest, welche Bildspalte nach Norden zeigt;
      // die Spiegelung (−1 in X) macht die von innen betrachtete Kugel wieder
      // richtig herum. Reihenfolge: enu · Rz(…) · Spiegel (lokal zuerst).
      var enu = Cesium.Transforms.eastNorthUpToFixedFrame(spot._pos);
      var dreh = Cesium.Matrix4.fromRotationTranslation(
        Cesium.Matrix3.fromRotationZ(NORD_VERSATZ - (spot.heading || 0)));
      var spiegel = Cesium.Matrix4.fromScale(new Cesium.Cartesian3(-1, 1, 1));
      var modelMatrix = Cesium.Matrix4.multiply(
        Cesium.Matrix4.multiply(enu, dreh, new Cesium.Matrix4()),
        spiegel, new Cesium.Matrix4());

      return new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry: geom }),
        appearance: appearance,
        modelMatrix: modelMatrix,
        asynchronous: false,
        allowPicking: false
      });
    },

    _kugelAlpha: function (prim, a) {
      if (prim && prim.appearance && prim.appearance.material) {
        prim.appearance.material.uniforms.color =
          Cesium.Color.WHITE.withAlpha(Cesium.Math.clamp(a, 0, 1));
      }
    },

    // -------------------------------------------------- Modell verbergen

    _modellVerbergen: function () {
      var geladen = window.BimViewer && BimViewer.loadedAssets;
      if (!geladen || !geladen.forEach) return;
      this._modellStand = [];
      var self = this;
      geladen.forEach(function (a) {
        var ts = a && a.tileset;
        if (ts) { self._modellStand.push({ ts: ts, show: ts.show }); ts.show = false; }
      });
    },
    _modellZeigen: function () {
      if (!this._modellStand) return;
      this._modellStand.forEach(function (e) { e.ts.show = e.show; });
      this._modellStand = null;
    },

    // ------------------------------------------------ Hotspots einfärben

    _nachbarnHervorheben: function () {
      var s = this._proMitte[this.aktiv];
      if (!s) return;
      var nachbarSet = {};
      s.nachbarn.forEach(function (id) { nachbarSet[id] = true; });
      this._hotspotsFarbe(function (spot) {
        if (spot.id === s.id) return null;               // sich selbst nicht zeigen
        return nachbarSet[spot.id]
          ? Cesium.Color.fromCssColorString('#30B4E7').withAlpha(0.95)
          : Cesium.Color.fromCssColorString('#8899aa').withAlpha(0.35);
      });
    },

    /** Farbe je Hotspot neu setzen; ohne Argument der Übersichtszustand. */
    _hotspotsFarbe: function (regel) {
      if (!this._quelle) return;
      var self = this;
      this.spots.forEach(function (spot) {
        var e = self._quelle.entities.getById('panospot-' + spot.id);
        if (!e || !e.point) return;
        var farbe = regel ? regel(spot)
          : Cesium.Color.fromCssColorString('#30B4E7').withAlpha(0.9);
        e.point.show = !!farbe;
        if (e.label) e.label.show = !!farbe;
        if (farbe) e.point.color = farbe;
      });
    },

    _melden: function () {
      document.dispatchEvent(new CustomEvent('pano:changed', { detail: this.zustand() }));
    }
  };

  // =====================================================================
  //  Reine Rechenteile — ohne Cesium, damit sie ohne Browser prüfbar sind
  //  (tests/pano-tour/test-pano-tour.js). Erreichbar über PanoTour._intern.
  // =====================================================================
  var P = {
    /** tour.json → normalisierte Spotliste, Panorama-URLs aufgelöst. */
    tourNormalisieren: function (json, basis) {
      var roh = (json && json.spots) || [];
      basis = basis || '';
      return roh.filter(function (s) {
        return s && typeof s.lon === 'number' && typeof s.lat === 'number';
      }).map(function (s, i) {
        var url = s.panorama || s.panoramaUrl || '';
        if (url && !/^([a-z]+:)?\/\//i.test(url) && !url.startsWith('data:')) {
          url = basis + url;
        }
        return {
          id: String(s.id != null ? s.id : 'spot' + (i + 1)),
          name: s.name || ('Spot ' + (i + 1)),
          lon: s.lon, lat: s.lat,
          hoehe: typeof s.hoehe === 'number' ? s.hoehe
            : (typeof s.height === 'number' ? s.height : 0),
          heading: typeof s.heading === 'number' ? s.heading : 0,
          panorama: url,
          nachbarn: Array.isArray(s.nachbarn) ? s.nachbarn.map(String)
            : (Array.isArray(s.neighbors) ? s.neighbors.map(String) : null)
        };
      });
    },

    /**
     * Nachbarschaft ergänzen, wo keine angegeben ist. Gearbeitet wird auf
     * `_pos` (Cartesian3 im Browser, {x,y,z} im Test) über den euklidischen
     * Abstand — bei den kurzen Wegen eines Rundgangs unterscheidet sich das
     * nicht von der Bogenlänge. Die Kante wird beidseitig gesetzt: ist s2
     * Nachbar von s1, dann auch umgekehrt, sonst ist ein Rundgang eine
     * Einbahnstraße.
     */
    nachbarnBilden: function (spots, opt) {
      opt = opt || {};
      var radius = opt.radius || 12.0, maxN = opt.maxN || 4;
      var fehlt = spots.some(function (s) { return !s.nachbarn; });
      spots.forEach(function (s) { if (!Array.isArray(s.nachbarn)) s.nachbarn = []; });
      if (fehlt) {
        spots.forEach(function (s) {
          if (s.nachbarn.length) return;
          var kand = spots.filter(function (o) { return o.id !== s.id; })
            .map(function (o) { return { id: o.id, d: P.abstand(s._pos, o._pos) }; })
            .filter(function (o) { return o.d <= radius; })
            .sort(function (a, b) { return a.d - b.d; })
            .slice(0, maxN)
            .map(function (o) { return o.id; });
          s.nachbarn = kand;
        });
      }
      // Beidseitig schließen und Selbstbezüge/Doppelte entfernen.
      var proId = {};
      spots.forEach(function (s) { proId[s.id] = s; });
      spots.forEach(function (s) {
        s.nachbarn.forEach(function (id) {
          var o = proId[id];
          if (o && o.nachbarn.indexOf(s.id) < 0) o.nachbarn.push(s.id);
        });
      });
      spots.forEach(function (s) {
        s.nachbarn = s.nachbarn.filter(function (id, i, a) {
          return id !== s.id && proId[id] && a.indexOf(id) === i;
        });
      });
      return spots;
    },

    abstand: function (a, b) {
      if (!a || !b) return Infinity;
      var dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    },

    /** Winkel in [-π, π). */
    wrap: function (a) {
      var t = ((a + Math.PI) % (2 * Math.PI));
      if (t < 0) t += 2 * Math.PI;
      return t - Math.PI;
    },

    /** Spot, der einer Weltlage am nächsten liegt (für „Spot hier setzen"). */
    naechster: function (spots, pos) {
      var best = null, bd = Infinity;
      spots.forEach(function (s) {
        var d = P.abstand(s._pos, pos);
        if (d < bd) { bd = d; best = s; }
      });
      return best;
    }
  };

  PanoTour._intern = P;

  // ------------------------------------------------------------- Einhängen

  function warten() {
    var versuche = 0;
    var takt = setInterval(function () {
      if (window.BimViewer && BimViewer.viewer && BimViewer.viewer.scene) {
        clearInterval(takt);
        PanoTour.init(BimViewer.viewer);
      } else if (++versuche > 240) {
        clearInterval(takt);
      }
    }, 500);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PanoTour;              // für den Node-Prüfstein (ohne Browser)
  } else {
    window.BimViewer = window.BimViewer || {};
    window.BimViewer.PanoTour = PanoTour;
    window.PanoTour = PanoTour;
    warten();
  }
})();
