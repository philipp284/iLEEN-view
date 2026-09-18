/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Licensed under BSL 1.1 (siehe clipping-planes.js).
 */

// ===============================
// SCHNITTBOX v2.0 — Ausschnitt um ein angeklicktes Bauteil
//
// Ablösung von clipping-box.js (jetzt unter _archive/). Der Unterschied ist
// nicht die Technik, sondern der Ausgangspunkt: die alte Box entstand als
// Hüllquader des *ganzen Modells* und musste an sechs Griffen auf das
// zusammengezogen werden, was man ansehen wollte — bei einem Campusmodell ein
// Dutzend Züge über hundert Meter. Diese hier entsteht um ein Bauteil, das man
// anklickt, aufgeweitet um einen Faktor, damit die angrenzenden Bauteile
// mitkommen: eine Wand ohne die Decke darüber und die Wand daneben ist als
// Ausschnitt wertlos, denn genau der Anschluss ist das, was man sehen will.
//
// Drei Festlegungen, an denen alles Weitere hängt:
//
// 1. **Die Box lebt im tile-lokalen System des Modells.** Dort liegen die
//    Bauteil-Hüllboxen des Backends (`section.build_index()`), und dort
//    erwartet `POST /assets/{job}/section` seinen Ausschnitt. Jede andere Wahl
//    — ENU am Schwerpunkt wie in der alten Fassung — bedeutet, bei jedem
//    Zeichnen und bei jedem Klick zwischen zwei Systemen hin und her zu
//    rechnen. Nach ECEF geht es über `root.computedTransform`, also über die
//    Matrix, die Cesium ohnehin führt: eine Höhenverschiebung (z-offset.js)
//    oder eine Geländeausrichtung nimmt die Box damit von selbst mit.
//
// 2. **Eine Box, viele Tilesets.** Der Ausschnitt ist eine Aussage über den
//    Raum, nicht über eine Datei. Liegt ein Scan über dem Fachmodell, muss er
//    mitgeschnitten werden, sonst verdeckt die Punktwolke genau den
//    freigelegten Anschluss. Jedes Ziel bekommt deshalb seine eigene
//    ClippingPlaneCollection, die dieselbe Weltbox über die jeweils eigene
//    `clippingPlanesOriginMatrix` sieht.
//
// 3. **Rückseiten sind ein Schalter, kein Nebeneffekt.** Eine geschnittene
//    Wand ist innen hohl — Cesium füllt Schnittflächen nicht. Mit entfernten
//    Rückseiten schaut man deshalb durch das Bauteil hindurch ins Leere. Beim
//    Aufziehen einer Schnittbox will man sie also sehen; beim Prüfen von
//    Kanten und Dopplungen dagegen nicht. Standard bei aktiver Box: zeigen.
// ===============================
'use strict';

(function () {

  if (!window.BimViewer) {
    console.warn('section-box.js: BimViewer nicht gefunden');
    return;
  }

  var FLAECHEN = [
    { key: '+x', achse: 0, vz: +1 },
    { key: '-x', achse: 0, vz: -1 },
    { key: '+y', achse: 1, vz: +1 },
    { key: '-y', achse: 1, vz: -1 },
    { key: '+z', achse: 2, vz: +1 },
    { key: '-z', achse: 2, vz: -1 }
  ];

  var KANTEN = [
    [0, 1], [2, 3], [4, 5], [6, 7],   // entlang X
    [0, 2], [1, 3], [4, 6], [5, 7],   // entlang Y
    [0, 4], [1, 5], [2, 6], [3, 7]    // entlang Z
  ];

  // Weit genug weg, dass keine Ebene mehr schneidet. `clippingPlanes` darf
  // nicht auf undefined gesetzt werden — Cesium greift danach im nächsten
  // Frame auf `_target` einer nicht mehr vorhandenen Collection zu.
  var AUS = 999999;

  // Schnittkanten in der Akzentfarbe der App, deutlich dicker als der
  // Cesium-Standard (1.0): bei 1 px verschwindet die Kante im Kontrast
  // zwischen geschnittener Wand und Hintergrund.
  var KANTENFARBE = Cesium.Color.fromCssColorString('#97BF0D');
  var KANTENBREITE = 3.0;
  var GRIFFFARBE = Cesium.Color.fromCssColorString('#97BF0D');

  var MINDESTGROESSE = 0.05;   // m — darunter ist die Box nicht mehr greifbar

  /**
   * Kantenlänge der Box beim Anlegen.
   *
   * Ein Meter, unabhängig vom Bauteil. Die Vorgängerfassung leitete die Größe
   * aus der Bauteil-Hüllbox ab, mal einem Faktor — an einer 14 m langen Wand
   * wurde daraus ein 16-m-Kasten, also ein halbes Geschoss, und der Weg zurück
   * zum Anschluss, den man ansehen wollte, waren sechs Griffe. Ein Meter ist
   * in jeder Lage ein brauchbarer Anfang: klein genug, um nichts zu verdecken,
   * groß genug, um die Griffe auseinanderzuhalten. Aufziehen ist eine Bewegung.
   */
  var KANTE = 1.0;

  // Griffgröße in Bildschirmpixeln, nicht in Metern: eine Kugel in Weltgröße
  // ist an einer Stütze größer als das Bauteil und an einer Geschossdecke ein
  // Punkt — man müsste sie ständig nachstellen. In Pixeln ist sie in jeder
  // Entfernung gleich gut zu treffen und verdeckt nie mehr als ihre Fläche.
  var GRIFF_PIXEL = 11;
  var GRIFF_PIXEL_AKTIV = 16;

  /**
   * Was die Box mit ihrem Inhalt macht.
   *
   * Cesium wertet je Ebene `amount = dot(normal, P) + distance` aus
   * (`getClippingFunction.js`) und verwirft danach:
   *
   *   unionClippingRegions = true   → sobald EINE Ebene ≤ 0 ist
   *   unionClippingRegions = false  → nur wenn ALLE Ebenen ≤ 0 sind
   *
   * Daraus folgen die beiden Belegungen unten — sie sind die Negation
   * voneinander, in Normale, Abstand und Modus zugleich (de Morgan):
   *
   *   innen behalten : Normalen nach INNEN, distance = +halb, UNION.
   *                    Innen ist jede Ebene positiv, außen mindestens eine
   *                    negativ — verworfen wird alles außerhalb.
   *   innen wegschneiden : Normalen nach AUSSEN, distance = −halb, INTERSECT.
   *                    Innen sind alle negativ (also verworfen), außerhalb ist
   *                    immer mindestens eine positiv — der Rest bleibt stehen.
   *
   * **Die Vorgängerfassung hatte die zweite Belegung mit der Beschriftung der
   * ersten.** Sie stanzte das angeklickte Bauteil aus, statt es freizustellen.
   * Beides ist brauchbar — nur eben nicht dasselbe, und deshalb steht es jetzt
   * als Schalter da statt als Kommentar.
   */
  var MODI = {
    innen:  { union: true,  vz: -1, dist: +1 },
    aussen: { union: false, vz: +1, dist: -1 }
  };

  BimViewer.SectionBox = {

    // ── Zustand ──────────────────────────────────────────────────────────

    box: null,        // { center:[3], size:[3], yaw } im tile-lokalen System
    quelle: null,     // { assetKey, jobId, tileset, name, ifcType, globalId, genau }
    ziele: [],        // [{ tileset, collection, backFaceVorher, rueckseiteVorher }]

    modus: 'innen',   // 'innen' = nur der Boxinhalt bleibt, 'aussen' = ausstanzen
    alleModelle: true,
    rueckseiten: true, // true = Rückseiten sichtbar (Backface-Culling aus)
    schnittanteil: 0.5, // Lage der Schnittebene in der Box, 0…1 quer zur Zeichenebene

    waehlt: false,    // Bauteil-Auswahlmodus läuft
    laeuft: false,    // Backend-Anfrage unterwegs

    _entities: [],
    _aktiverGriff: null,  // Fläche unter der Maus oder in der Hand
    _klickHandler: null,
    _escHandler: null,
    _ziehHandler: null,
    _matrixWache: null,
    _tileMatrix: null,
    _boxNachEcef: null,   // Box-Frame → ECEF, in _matrizenSetzen() gepflegt

    // ── Bauteil auswählen ────────────────────────────────────────────────

    /**
     * Schaltet den Auswahlmodus um. Der nächste Klick auf ein Bauteil legt die
     * Box; Esc oder ein erneuter Druck beendet ihn.
     */
    auswahlUmschalten: function () {
      if (this.waehlt) this.auswahlBeenden();
      else this.auswahlStarten();
    },

    auswahlStarten: function () {
      if (this.waehlt) return;
      this.waehlt = true;
      var self = this;
      var scene = BimViewer.viewer.scene;

      this._klickHandler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
      this._klickHandler.setInputAction(function (e) {
        var getroffen = scene.pick(e.position);
        if (!(getroffen instanceof Cesium.Cesium3DTileFeature)) {
          melde('Kein Bauteil getroffen — auf die Fläche eines Modells klicken.', 'error');
          return;
        }
        // Der Punkt unter dem Zeiger, nicht der Schwerpunkt des Bauteils: bei
        // einer 14 m langen Wand liegt deren Mitte irgendwo, angesehen werden
        // soll aber die Stelle, auf die man geklickt hat.
        var treffer = scene.pickPosition(e.position);
        self.auswahlBeenden();
        self.umBauteil(getroffen, treffer);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      this._escHandler = function (e) { if (e.key === 'Escape') self.auswahlBeenden(); };
      window.addEventListener('keydown', this._escHandler);

      knopfStand();
      melde('Bauteil anklicken — die Box legt sich darum.', 'busy');
      BimViewer.updateStatus('Schnittbox: Bauteil anklicken', 'loading');
    },

    auswahlBeenden: function () {
      if (!this.waehlt) return;
      this.waehlt = false;
      if (this._klickHandler) { this._klickHandler.destroy(); this._klickHandler = null; }
      if (this._escHandler) {
        window.removeEventListener('keydown', this._escHandler);
        this._escHandler = null;
      }
      knopfStand();
    },

    /** Fängt features.js den Klick weg, solange hier ausgewählt wird. */
    faengtKlick: function () {
      return this.waehlt === true;
    },

    /**
     * Legt einen Meterwürfel an die angeklickte Stelle.
     *
     * Der Mittelpunkt ist der Trefferpunkt auf der Bauteiloberfläche, nicht
     * der Schwerpunkt des Bauteils: bei einer langen Wand liegt der irgendwo,
     * angesehen werden soll aber die Stelle unter dem Zeiger. Der Würfel steht
     * damit halb im Bauteil und halb davor — für einen Anschluss genau
     * richtig, und alles Weitere macht man an den Griffen.
     *
     * Liefert `pickPosition` nichts (kein Tiefenwert, etwa bei sehr flachem
     * Blickwinkel), wird auf die Mitte des Bauteils zurückgegriffen — aus dem
     * Backend, sonst aus der Kachelhülle.
     */
    umBauteil: async function (feature, trefferWelt) {
      var tileset = feature.tileset || (feature.content && feature.content.tileset);
      var asset = assetZuTileset(tileset);
      if (!asset || !tileset || !tileset.root) {
        melde('Das Modell dieses Bauteils ist nicht auffindbar.', 'error');
        return;
      }

      var globalId = eigenschaft(feature, ['GlobalId', 'globalId', 'global_id']);
      var name = eigenschaft(feature, ['Name', 'name']) || '';
      var ifcType = eigenschaft(feature, ['IfcType', 'className', 'IfcEntity']) || '';

      var mitte = trefferWelt ? nachTileLokal(tileset, trefferWelt) : null;
      var bauteil = null;

      // Die Bauteil-Hüllbox wird nur geholt, wenn sie gebraucht wird: als
      // Ersatzmitte, oder später für „Auf Bauteil einpassen". Der erste Aufruf
      // je Modell baut serverseitig das Elementverzeichnis auf und dauert.
      if (!mitte) {
        if (asset.jobId && globalId) {
          melde('Lage des Bauteils wird geholt — beim ersten Mal dauert das.', 'busy');
          bauteil = await this._backendBox(asset.jobId, globalId);
        }
        if (!bauteil) bauteil = tileKasten(feature, tileset);
        if (!bauteil) { melde('Stelle nicht bestimmbar — noch einmal klicken.', 'error'); return; }
        mitte = bauteil.center.slice();
      }

      this.quelle = {
        assetKey: asset.id, jobId: asset.jobId || null, tileset: tileset,
        modell: asset.name || '', name: name, ifcType: ifcType,
        globalId: globalId || null, bauteil: bauteil
      };
      this.box = {
        center: mitte,
        size: [KANTE, KANTE, KANTE],
        yaw: (this.box && this.box.yaw) || 0
      };
      this._anlegen();

      melde(bauteilText(ifcType, name) + ' — ' + KANTE.toFixed(2).replace('.', ',') +
            ' m Kantenlänge, an den Griffen aufziehen.', '');
    },

    /** Holt die tile-lokale Hüllbox eines Bauteils. `null`, wenn es sie nicht gibt. */
    _backendBox: async function (jobId, globalId) {
      try {
        var antwort = await fetch(BimViewer.getBackendUrl() +
          '/assets/' + jobId + '/elements/' + encodeURIComponent(globalId) + '/box');
        if (!antwort.ok) return null;
        var daten = await antwort.json();
        return { center: daten.center.slice(), size: daten.size.slice() };
      } catch (e) {
        console.warn('section-box: Hüllbox nicht ladbar', e);
        return null;
      }
    },

    /** Setzt die Box auf den Meterwürfel zurück, ohne die Stelle zu verlassen. */
    zuruecksetzen: function () {
      if (!this.box) return;
      this.box.size = [KANTE, KANTE, KANTE];
      this._matrizenSetzen();
      this._planesSetzen();
      this._anzeigeAktualisieren();
    },

    /**
     * Legt die Box genau um das angeklickte Bauteil — ohne Zuschlag.
     *
     * Der eine Fall, in dem die Bauteilgeometrie doch die bessere Vorgabe ist:
     * eine Stütze oder ein Träger, den man ganz im Bild haben will. Als
     * Handgriff, nicht als Automatismus — beim Anlegen wäre er an einer langen
     * Wand ein halbes Geschoss.
     */
    aufBauteil: async function () {
      if (!this.box || !this.quelle) return;
      var q = this.quelle;
      if (!q.bauteil && q.jobId && q.globalId) {
        melde('Hüllbox des Bauteils wird geholt …', 'busy');
        q.bauteil = await this._backendBox(q.jobId, q.globalId);
      }
      if (!q.bauteil) {
        melde('Für dieses Bauteil gibt es keine Hüllbox — das geht nur bei Modellen ' +
              'aus dem eigenen Backend.', 'error');
        return;
      }
      this.box.center = q.bauteil.center.slice();
      this.box.size = q.bauteil.size.map(function (s) { return Math.max(s, MINDESTGROESSE); });
      this._matrizenSetzen();
      this._planesSetzen();
      this._anzeigeAktualisieren();
      melde('Box auf ' + bauteilText(q.ifcType, q.name) + ' eingepasst.', '');
    },

    // ── Box anlegen und abräumen ─────────────────────────────────────────

    _anlegen: function () {
      this._entitiesWeg();
      this._zieleLoesen();

      this._zieleWaehlen();
      this._matrizenSetzen();
      this._planesSetzen();
      this._rahmenZeichnen();
      this._griffeZeichnen();
      this._ziehenInstallieren();
      this._matrixWacheStarten();
      this._rueckseitenAnwenden();
      this._anzeigeAktualisieren();
      knopfStand();
    },

    /** Hebt die Box auf: Ebenen weit weg, Griffe fort, Rückseiten zurück. */
    aufheben: function () {
      this.auswahlBeenden();
      this._matrixWacheStopp();
      this._entitiesWeg();
      this._zieleLoesen();
      if (this._ziehHandler) { this._ziehHandler.destroy(); this._ziehHandler = null; }
      this.box = null;
      this.quelle = null;
      this._anzeigeAktualisieren();
      knopfStand();
      melde('Schnittbox aufgehoben.', '');
    },

    /**
     * Welche Tilesets geschnitten werden.
     *
     * Gaussian Splats bleiben außen vor: ihr Inhalt läuft nicht über den
     * Modell-Renderer, `clippingPlanes` bleibt dort wirkungslos. Sie
     * stillschweigend in die Liste zu nehmen hieße, dem Nutzer einen Ausschnitt
     * zu versprechen, den er nicht bekommt.
     */
    _zieleWaehlen: function () {
      var self = this;
      this.ziele = [];
      BimViewer.loadedAssets.forEach(function (asset) {
        var ts = asset.tileset;
        if (!ts || ts._isGaussianSplat) return;
        if (!self.alleModelle && asset.id !== self.quelle.assetKey) return;
        self.ziele.push({
          tileset: ts,
          collection: null,
          backFaceVorher: ts.backFaceCulling,
          // Nicht der ganze Shader, sondern nur die Frage, ob der
          // Rückseitenbaustein lief: der Steckplatz gehört dem Verbund, und
          // ihn im Ganzen zurückzuschreiben nähme einer Explosion oder einer
          // Bildprojektion, die inzwischen dazugekommen ist, ihren Baustein.
          rueckseiteVorher: BimViewer.ShaderVerbund
            ? BimViewer.ShaderVerbund.hat(ts, 'rueckseite')
            : !!ts.customShader
        });
      });
    },

    /**
     * Box-Frame → ECEF, und daraus je Ziel die Matrix der Ebenensammlung.
     *
     * `boxNachEcef = tileNachEcef · T(center) · Rz(−yaw)`. Das Minus ist kein
     * Vorzeichenfehler: `section.Box.axes()` im Backend dreht im Kompasssinn
     * (positiver Winkel dreht die Ostkante nach Süden), die Matrizenkonvention
     * von Cesium dagegen mathematisch positiv. Beide Seiten müssen denselben
     * Drehsinn haben, sonst liegt der gezeichnete Plan gespiegelt zur Box.
     */
    _matrizenSetzen: function () {
      var tileNachEcef = this.quelle.tileset.root.computedTransform;
      this._tileMatrix = Cesium.Matrix4.clone(tileNachEcef, new Cesium.Matrix4());

      var dreh = Cesium.Matrix3.fromRotationZ(
        -Cesium.Math.toRadians(this.box.yaw || 0), new Cesium.Matrix3());
      var lage = Cesium.Matrix4.fromRotationTranslation(
        dreh, Cesium.Cartesian3.fromArray(this.box.center), new Cesium.Matrix4());
      this._boxNachEcef = Cesium.Matrix4.multiply(tileNachEcef, lage, new Cesium.Matrix4());

      this.ziele.forEach(function (ziel) {
        var ursprungInvers = Cesium.Matrix4.inverseTransformation(
          ziel.tileset.clippingPlanesOriginMatrix, new Cesium.Matrix4());
        var modelMatrix = Cesium.Matrix4.multiply(
          ursprungInvers, this._boxNachEcef, new Cesium.Matrix4());

        if (!ziel.collection) {
          ziel.collection = new Cesium.ClippingPlaneCollection({
            planes: FLAECHEN.map(function () {
              return new Cesium.ClippingPlane(Cesium.Cartesian3.UNIT_X, AUS);
            }),
            modelMatrix: modelMatrix,
            unionClippingRegions: (MODI[this.modus] || MODI.innen).union,
            edgeColor: KANTENFARBE,
            edgeWidth: KANTENBREITE,
            enabled: true
          });
          ziel.tileset.clippingPlanes = ziel.collection;
        } else {
          Cesium.Matrix4.clone(modelMatrix, ziel.collection.modelMatrix);
        }
      }, this);
    },

    _planesSetzen: function () {
      if (!this.box) return;
      var halb = this.box.size.map(function (s) { return s / 2; });
      var regel = MODI[this.modus] || MODI.innen;

      this.ziele.forEach(function (ziel) {
        if (!ziel.collection) return;
        FLAECHEN.forEach(function (f, i) {
          var ebene = ziel.collection.get(i);
          if (!ebene) return;
          var n = new Cesium.Cartesian3(0, 0, 0);
          n[['x', 'y', 'z'][f.achse]] = f.vz * regel.vz;
          ebene.normal = n;
          ebene.distance = regel.dist * halb[f.achse];
        });
        // Der Modus gehört zur Sammlung, nicht zur Ebene: Cesium baut daraus
        // den Shader. Umschalten kostet eine Neuübersetzung, deshalb wird er
        // nur geschrieben, wenn er sich wirklich ändert.
        if (ziel.collection.unionClippingRegions !== regel.union) {
          ziel.collection.unionClippingRegions = regel.union;
        }
        ziel.collection.enabled = true;
      });
    },

    /**
     * Zwischen „nur den Boxinhalt zeigen" und „den Boxinhalt wegschneiden".
     *
     * Das eine stellt ein Bauteil samt Anschluss frei, das andere schaut an
     * derselben Stelle ins Bauwerk hinein — dieselbe Box, entgegengesetzte
     * Frage. Welche gemeint ist, hängt daran, ob man das Bauteil untersucht
     * oder das, was dahinter liegt.
     */
    setModus: function (modus) {
      if (!MODI[modus]) return;
      this.modus = modus;
      this._planesSetzen();
      this._anzeigeAktualisieren();
      knopfStand();
    },

    _zieleLoesen: function () {
      this.ziele.forEach(function (ziel) {
        if (ziel.collection) {
          ziel.collection.enabled = false;
          for (var i = 0; i < ziel.collection.length; i++) {
            var ebene = ziel.collection.get(i);
            if (ebene) ebene.distance = AUS;
          }
        }
        // Rückseiten auf den Stand vor der Box zurück — sonst bleibt ein
        // Modell dauerhaft einseitig gezeichnet, weil hier einmal umgeschaltet
        // wurde.
        try {
          if (ziel.rueckseiteVorher && typeof BimViewer.applyBackFaceCulling === 'function') {
            BimViewer.applyBackFaceCulling(ziel.tileset);
          } else if (typeof BimViewer.removeBackFaceCulling === 'function') {
            BimViewer.removeBackFaceCulling(ziel.tileset);
          }
          ziel.tileset.backFaceCulling = ziel.backFaceVorher;
        } catch (e) { /* Tileset schon entladen */ }
      });
      this.ziele = [];
    },

    /**
     * Hält die Box am Modell, wenn dieses verschoben wird.
     *
     * Höhenversatz, Drehung und Geländeausrichtung schreiben auf
     * `tileset.modelMatrix`; `root.computedTransform` zieht im nächsten Frame
     * nach. Ohne diese Wache bliebe die Box stehen und schnitte plötzlich
     * neben dem Bauteil. Verglichen wird die Matrix, nicht auf gut Glück jedes
     * Bild neu gerechnet — sechzehn Zahlen zu prüfen ist billiger als vier
     * Matrixprodukte je Ziel.
     */
    _matrixWacheStarten: function () {
      var self = this;
      this._matrixWacheStopp();
      this._matrixWache = BimViewer.viewer.scene.preUpdate.addEventListener(function () {
        if (!self.box || !self.quelle || !self.quelle.tileset.root) return;
        var jetzt = self.quelle.tileset.root.computedTransform;
        if (Cesium.Matrix4.equalsEpsilon(jetzt, self._tileMatrix, 1e-9)) return;
        self._matrizenSetzen();
        self._planesSetzen();
      });
    },

    _matrixWacheStopp: function () {
      if (this._matrixWache) { this._matrixWache(); this._matrixWache = null; }
    },

    // ── Rückseiten ───────────────────────────────────────────────────────

    /**
     * Rückseiten zeigen oder entfernen.
     *
     * `backFaceCulling = false` allein genügt nicht in beide Richtungen: das
     * Flag wirkt nur auf Materialien, die nicht ohnehin `doubleSided` sind —
     * und aus IFC kommt fast alles doppelseitig, weil dünne Wände sonst je nach
     * Blickrichtung verschwinden. Zum *Entfernen* braucht es deshalb zusätzlich
     * den Rückseitenbaustein aus core.js, der rückwärtige Fragmente verwirft
     * — an- und abgemeldet über den Shader-Verbund, damit eine laufende
     * Explosion oder Bildprojektion dabei stehen bleibt.
     */
    rueckseitenSetzen: function (zeigen) {
      this.rueckseiten = !!zeigen;
      this._rueckseitenAnwenden();
      this._anzeigeAktualisieren();
    },

    _rueckseitenAnwenden: function () {
      var zeigen = this.rueckseiten;
      this.ziele.forEach(function (ziel) {
        try {
          if (zeigen && typeof BimViewer.removeBackFaceCulling === 'function') {
            BimViewer.removeBackFaceCulling(ziel.tileset);
          } else if (zeigen) {
            ziel.tileset.backFaceCulling = false;
            ziel.tileset.customShader = undefined;
          } else if (typeof BimViewer.applyBackFaceCulling === 'function') {
            BimViewer.applyBackFaceCulling(ziel.tileset);
          } else {
            ziel.tileset.backFaceCulling = true;
          }
        } catch (e) {
          console.warn('section-box: Rückseiten nicht schaltbar', e);
        }
      });
    },

    // ── Regler ───────────────────────────────────────────────────────────

    setYaw: function (grad) {
      if (!this.box) return;
      this.box.yaw = parseFloat(grad) || 0;
      this._matrizenSetzen();
      this._planesSetzen();
      this._anzeigeAktualisieren();
    },

    setAlleModelle: function (an) {
      this.alleModelle = !!an;
      if (!this.box) return;
      this._zieleLoesen();
      this._zieleWaehlen();
      this._matrizenSetzen();
      this._planesSetzen();
      this._rueckseitenAnwenden();
      this._anzeigeAktualisieren();
    },

    setSchnittanteil: function (wert) {
      this.schnittanteil = Math.min(1, Math.max(0, parseFloat(wert) || 0));
      this._anzeigeAktualisieren();
    },

    /** Fliegt die Kamera auf die Box. */
    hinfliegen: function () {
      if (!this.box) return;
      var ecken = this._eckenWelt();
      var kugel = Cesium.BoundingSphere.fromPoints(ecken);
      BimViewer.viewer.camera.flyToBoundingSphere(kugel, {
        duration: 1.2,
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(-35), Cesium.Math.toRadians(-28), kugel.radius * 3.2)
      });
    },

    // ── Geometrie ────────────────────────────────────────────────────────

    /** Punkt im Box-Frame → ECEF. */
    _nachWelt: function (x, y, z) {
      return Cesium.Matrix4.multiplyByPoint(
        this._boxNachEcef, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
    },

    /** Richtung im Box-Frame → ECEF (ohne Verschiebung). */
    _richtungWelt: function (x, y, z) {
      var d = Cesium.Matrix4.multiplyByPointAsVector(
        this._boxNachEcef, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
      return Cesium.Cartesian3.normalize(d, d);
    },

    // Reihenfolge passend zu KANTEN: 0:(−,−,−) 1:(+,−,−) 2:(−,+,−) 3:(+,+,−)
    //                                4:(−,−,+) 5:(+,−,+) 6:(−,+,+) 7:(+,+,+)
    _eckenWelt: function () {
      var h = this.box.size.map(function (s) { return s / 2; });
      var ecken = [];
      for (var dz = -1; dz <= 1; dz += 2) {
        for (var dy = -1; dy <= 1; dy += 2) {
          for (var dx = -1; dx <= 1; dx += 2) {
            ecken.push(this._nachWelt(dx * h[0], dy * h[1], dz * h[2]));
          }
        }
      }
      return ecken;
    },

    _flaechenMitte: function (flaeche) {
      var h = this.box.size.map(function (s) { return s / 2; });
      var p = [0, 0, 0];
      p[flaeche.achse] = flaeche.vz * h[flaeche.achse];
      return this._nachWelt(p[0], p[1], p[2]);
    },

    // ── Darstellung ──────────────────────────────────────────────────────

    _rahmenZeichnen: function () {
      var self = this;
      this._entities.push(BimViewer.viewer.entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(function () {
            if (!self.box) return [];
            var e = self._eckenWelt(), punkte = [];
            KANTEN.forEach(function (k) { punkte.push(e[k[0]], e[k[1]]); });
            return punkte;
          }, false),
          width: 2,
          material: new Cesium.PolylineDashMaterialProperty({
            color: KANTENFARBE, dashLength: 10
          }),
          arcType: Cesium.ArcType.NONE
        }
      }));
    },

    /**
     * Sechs Flächengriffe.
     *
     * Ziehen bewegt **nur diese eine Fläche** — die Box wächst einseitig. Die
     * alte Fassung änderte die Halbgröße, die Box wuchs also symmetrisch in
     * beide Richtungen; wer die Decke freilegen wollte, holte sich unten den
     * Boden mit herein und musste jede Bewegung zweimal machen.
     *
     * Punkte in fester Pixelgröße statt Kugeln in Weltgröße. Sechs Kugeln, die
     * mit der Box mitwachsen, sind an einem großen Ausschnitt sechs
     * Metergebilde mitten im Bild — sie verdecken genau das Bauteil, um das es
     * geht. Der Griff muss anklickbar sein, sonst nichts; dafür sind elf Pixel
     * genug, in jeder Entfernung.
     *
     * Einheitsfarbe statt Achsfarben: bei einer Box sagt die Lage des Griffs
     * bereits, welche Fläche er bewegt. Drei Farbpaare zusätzlich sind
     * Buntheit ohne Aussage. Unterschieden wird nur, was gerade unter der Maus
     * liegt — die einzige Information, die man beim Zugreifen braucht.
     *
     * `disableDepthTestDistance` hält sie vor der Geometrie: ein Griff auf der
     * abgewandten Boxseite steckt sonst in der Wand und ist nicht erreichbar,
     * ohne die Kamera zu drehen.
     */
    _griffeZeichnen: function () {
      var self = this;
      FLAECHEN.forEach(function (flaeche) {
        var entity = BimViewer.viewer.entities.add({
          position: new Cesium.CallbackProperty(function () {
            return self.box ? self._flaechenMitte(flaeche) : Cesium.Cartesian3.ZERO;
          }, false),
          point: {
            pixelSize: new Cesium.CallbackProperty(function () {
              return self._aktiverGriff === flaeche ? GRIFF_PIXEL_AKTIV : GRIFF_PIXEL;
            }, false),
            color: new Cesium.CallbackProperty(function () {
              return self._aktiverGriff === flaeche ? Cesium.Color.WHITE : GRIFFFARBE;
            }, false),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        });
        entity._sectionBoxFlaeche = flaeche;
        self._entities.push(entity);
      });
    },

    _entitiesWeg: function () {
      this._entities.forEach(function (e) {
        try { BimViewer.viewer.entities.remove(e); } catch (err) { /* schon fort */ }
      });
      this._entities = [];
      this._aktiverGriff = null;
    },

    // ── Ziehen ───────────────────────────────────────────────────────────

    _ziehenInstallieren: function () {
      if (this._ziehHandler) return;
      var self = this;
      var scene = BimViewer.viewer.scene;
      var kamera = scene.camera;
      var handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
      this._ziehHandler = handler;
      var zug = null;

      handler.setInputAction(function (e) {
        var getroffen = scene.pick(e.position);
        var flaeche = getroffen && getroffen.id && getroffen.id._sectionBoxFlaeche;
        if (!flaeche || !self.box) return;

        scene.screenSpaceCameraController.enableInputs = false;
        self._aktiverGriff = flaeche;
        var lokal = [0, 0, 0];
        lokal[flaeche.achse] = flaeche.vz;
        zug = {
          flaeche: flaeche,
          achseWelt: self._richtungWelt(lokal[0], lokal[1], lokal[2]),
          startMitte: self._flaechenMitte(flaeche),
          startGroesse: self.box.size[flaeche.achse],
          startZentrum: self.box.center.slice()
        };
      }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

      handler.setInputAction(function (e) {
        if (!self.box) return;

        // Ohne Zug nur nachsehen, was unter der Maus liegt: der Griff wächst
        // dann und wird weiß. Ein Griff, der beim Überfahren nicht antwortet,
        // ist von einer Verzierung nicht zu unterscheiden.
        if (!zug) {
          var unterMaus = scene.pick(e.endPosition);
          var flaeche = unterMaus && unterMaus.id && unterMaus.id._sectionBoxFlaeche;
          self._aktiverGriff = flaeche || null;
          return;
        }

        var strahl = kamera.getPickRay(e.endPosition);
        if (!strahl) return;

        var t = aufAchse(zug.startMitte, zug.achseWelt, strahl.origin, strahl.direction);
        if (t === null) return;

        // Eine Fläche verschieben heißt: Größe um t ändern und das Zentrum um
        // t/2 in dieselbe Richtung — die gegenüberliegende Fläche bleibt damit
        // stehen, wo sie war.
        var neu = Math.max(MINDESTGROESSE, zug.startGroesse + t);
        var verschub = (neu - zug.startGroesse) / 2 * zug.flaeche.vz;

        // Der Verschub liegt in der Box-Achse; das Zentrum wird aber im
        // tile-lokalen System geführt. Bei gedrehter Box sind das zwei
        // verschiedene Richtungen, deshalb die Drehung um −yaw mitrechnen.
        var w = Cesium.Math.toRadians(-(self.box.yaw || 0));
        var c = Math.cos(w), s = Math.sin(w);
        var d = [0, 0, 0];
        d[zug.flaeche.achse] = verschub;
        self.box.center = [
          zug.startZentrum[0] + (c * d[0] - s * d[1]),
          zug.startZentrum[1] + (s * d[0] + c * d[1]),
          zug.startZentrum[2] + d[2]
        ];
        self.box.size[zug.flaeche.achse] = neu;

        self._matrizenSetzen();
        self._planesSetzen();
        self._anzeigeAktualisieren();
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

      handler.setInputAction(function () {
        if (!zug) return;
        zug = null;
        self._aktiverGriff = null;
        scene.screenSpaceCameraController.enableInputs = true;
      }, Cesium.ScreenSpaceEventType.LEFT_UP);
    },

    // ── Als Detail in den Plan ───────────────────────────────────────────

    /**
     * Zeichnet den Ausschnitt als Detail und öffnet den Zeichenmodus.
     *
     * Es ist derselbe Weg wie beim Geschossgrundriss (`POST .../section`), nur
     * mit dieser Box statt des ganzen Geschosses — und genau deshalb lebt die
     * Box im tile-lokalen System: `center`, `size` und `yaw` gehen unverändert
     * in die Anfrage.
     *
     * Zwei Unterschiede zum Geschossplan:
     *
     * * **Die Schnittebene liegt relativ in der Box.** Beim Geschoss meint die
     *   Schnitthöhe 1,20 m über Fußboden. In einem Detail um eine Stütze wäre
     *   das eine Ebene irgendwo im Bauteil oder darunter; hier ist die Boxmitte
     *   der Ausgangspunkt, verschiebbar über den Regler — in allen drei Ebenen.
     * * **Räume werden nicht beschriftet.** Ein Raumstempel mit Nummer,
     *   Nutzung und Fläche gehört in den Grundriss; über einem Ausschnitt von
     *   zwei Metern deckt er die Zeichnung zu.
     */
    detail: async function (ebene) {
      if (this.laeuft) return;
      if (!this.box) { melde('Erst eine Box setzen — Bauteil anklicken.', 'error'); return; }
      if (!this.quelle.jobId) {
        melde('Zeichnungen entstehen aus der IFC-Quelldatei — das geht nur bei ' +
              'Modellen aus dem eigenen Backend.', 'error');
        return;
      }

      var anfrage = this.anfrage(ebene);
      if (!anfrage) { melde('Unbekannte Ebene „' + ebene + '".', 'error'); return; }

      this.laeuft = true;
      melde('Detail ' + ebene.toUpperCase() + ' wird geschnitten …', 'busy');
      try {
        var antwort = await fetch(BimViewer.getBackendUrl() +
          '/assets/' + this.quelle.jobId + '/section', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(anfrage)
        });
        if (!antwort.ok) throw new Error(await fehlertext(antwort));
        var plan = await antwort.json();

        if (!plan.figures.length) {
          melde('Nichts getroffen — in der Box liegt an dieser Ebene kein Bauteil. ' +
                'Regler „Schnittebene" verschieben oder die Box weiter aufziehen.', 'error');
          return;
        }

        BimViewer.Plan2D.modell = this.quelle.modell;
        await BimViewer.Plan2D.open(plan, this.titel(ebene));
        melde(plan.figures.length + ' Figuren — im Blatt bemaßen und beschriften.', '');
      } catch (e) {
        melde('Fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.laeuft = false;
      }
    },

    /**
     * Die Anfrage an `POST .../section` für eine der drei Boxebenen.
     *
     * Der Ausschnitt sind immer die Boxgrenzen; verschieden ist nur, wie die
     * Zeichenebene darin liegt:
     *
     * | Ebene | Normale | Backend |
     * |---|---|---|
     * | XY | Box-Z | `grundriss`, `cut_height` über der Unterkante |
     * | XZ | Box-Y | `schnitt`, `cut_offset` von der −Y-Kante |
     * | YZ | Box-X | `schnitt`, Box um 90° gedreht |
     *
     * **YZ dreht die Box, statt einen dritten Modus zu erfinden.** Das Backend
     * schneidet im Schnitt-Modus stets quer zu `size[1]`. Mit `yaw + 90°` wird
     * `across` zur bisherigen X-Achse — die gewünschte Normale — und mit
     * getauschten `size[0]`/`size[1]` beschreibt die Anfrage denselben Quader
     * im Raum wie vorher. Nachrechnen: `along(a+90°) = −across(a)` und
     * `across(a+90°) = along(a)`, und weil die Box um ihre Mitte symmetrisch
     * ist, fällt das Vorzeichen der Menge der Eckpunkte nicht auf.
     */
    anfrage: function (ebene) {
      var b = this.box, t = this.schnittanteil;
      var gemeinsam = { with_views: true, with_rooms: false };

      if (ebene === 'xy') {
        return Object.assign({
          center: b.center.slice(), size: b.size.slice(), yaw: b.yaw || 0,
          mode: 'grundriss', cut_height: b.size[2] * t
        }, gemeinsam);
      }
      if (ebene === 'xz') {
        return Object.assign({
          center: b.center.slice(), size: b.size.slice(), yaw: b.yaw || 0,
          mode: 'schnitt', cut_offset: b.size[1] * t
        }, gemeinsam);
      }
      if (ebene === 'yz') {
        return Object.assign({
          center: b.center.slice(),
          size: [b.size[1], b.size[0], b.size[2]],
          yaw: (b.yaw || 0) + 90,
          mode: 'schnitt', cut_offset: b.size[0] * t
        }, gemeinsam);
      }
      return null;
    },

    /**
     * Der Blatttitel — er ist zugleich der halbe Archivschlüssel
     * (`job|mode|titel` in Plan2D). Deshalb stehen Ebene und Bauteil darin:
     * XZ und YZ sind für das Backend beide `schnitt`, und ohne den
     * Unterschied im Titel teilten sie sich eine Bemaßung.
     */
    titel: function (ebene) {
      var q = this.quelle || {};
      return 'Detail ' + (ebene === 'xy' ? '▤' : '◫') + ' ' + ebene.toUpperCase() + ' ' +
             bauteilText(q.ifcType, q.name) +
             (q.globalId ? ' [' + q.globalId.slice(0, 8) + ']' : '');
    },

    // ── Panel ────────────────────────────────────────────────────────────

    _anzeigeAktualisieren: function () {
      var masse = document.getElementById('sboxMasse');
      if (masse) {
        masse.textContent = this.box
          ? this.box.size.map(function (s) { return s.toFixed(2); }).join(' × ') + ' m' +
            (this.box.yaw ? ' · ' + Math.round(this.box.yaw) + '°' : '')
          : '—';
      }

      var bauteil = document.getElementById('sboxBauteil');
      if (bauteil) {
        bauteil.textContent = this.quelle
          ? bauteilText(this.quelle.ifcType, this.quelle.name)
          : 'noch keins gewählt';
      }

      // Der Regler gilt für alle drei Ebenen, misst aber je nach Ebene eine
      // andere Kante ab. Ein Meterwert stünde deshalb hier für drei
      // verschiedene Strecken — der Anteil ist die ehrlichere Angabe.
      var lage = document.getElementById('sboxSchnittWert');
      if (lage) lage.textContent = Math.round(this.schnittanteil * 100) + ' %';

      var ziele = document.getElementById('sboxZiele');
      if (ziele) {
        ziele.textContent = this.ziele.length
          ? this.ziele.length + (this.ziele.length === 1 ? ' Modell' : ' Modelle') + ' geschnitten'
          : '';
      }

    }
  };

  // ── Helfer ─────────────────────────────────────────────────────────────

  /**
   * Parameter t entlang der Achse (p0, richtung), an dem sie dem Mausstrahl am
   * nächsten kommt. `null`, wenn beide parallel sind — dann sagt die Maus über
   * die Achsposition nichts aus.
   */
  function aufAchse(p0, d0, p1, d1) {
    var w = Cesium.Cartesian3.subtract(p0, p1, new Cesium.Cartesian3());
    var a = Cesium.Cartesian3.dot(d0, d0);
    var b = Cesium.Cartesian3.dot(d0, d1);
    var c = Cesium.Cartesian3.dot(d1, d1);
    var d = Cesium.Cartesian3.dot(d0, w);
    var e = Cesium.Cartesian3.dot(d1, w);
    var nenner = a * c - b * b;
    if (Math.abs(nenner) < 1e-9) return null;
    return (b * e - c * d) / nenner;
  }

  /** ECEF-Punkt → tile-lokales System des Modells, als Zahlentripel. */
  function nachTileLokal(tileset, weltPunkt) {
    if (!weltPunkt || !tileset.root) return null;
    var ecefNachTile = Cesium.Matrix4.inverseTransformation(
      tileset.root.computedTransform, new Cesium.Matrix4());
    var p = Cesium.Matrix4.multiplyByPoint(ecefNachTile, weltPunkt, new Cesium.Cartesian3());
    return [p.x, p.y, p.z];
  }

  function assetZuTileset(tileset) {
    var treffer = null;
    BimViewer.loadedAssets.forEach(function (asset) {
      if (asset.tileset === tileset) treffer = asset;
    });
    return treffer;
  }

  /** Erste vorhandene Feature-Property aus einer Liste möglicher Namen. */
  function eigenschaft(feature, namen) {
    for (var i = 0; i < namen.length; i++) {
      try {
        var wert = feature.getProperty(namen[i]);
        if (wert !== undefined && wert !== null && wert !== '') return String(wert);
      } catch (e) { /* Property gibt es nicht */ }
    }
    return null;
  }

  /**
   * Notbehelf ohne Backend: die Hüllkugel der Kachel, in der das Bauteil liegt,
   * als tile-lokaler Quader. Zu groß, aber greifbar — die Griffe machen daraus
   * in ein paar Zügen einen brauchbaren Ausschnitt.
   */
  function tileKasten(feature, tileset) {
    var kachel = feature.content && feature.content.tile;
    var kugel = (kachel && kachel.boundingSphere) || tileset.boundingSphere;
    if (!kugel || !tileset.root) return null;
    var ecefNachTile = Cesium.Matrix4.inverseTransformation(
      tileset.root.computedTransform, new Cesium.Matrix4());
    var mitte = Cesium.Matrix4.multiplyByPoint(ecefNachTile, kugel.center, new Cesium.Cartesian3());
    var d = kugel.radius * 2;
    return { center: [mitte.x, mitte.y, mitte.z], size: [d, d, d] };
  }

  function bauteilText(ifcType, name) {
    var typ = (ifcType || '').replace(/^Ifc/, '') || 'Bauteil';
    return name ? typ + ' „' + name + '"' : typ;
  }

  function melde(nachricht, art) {
    var el = document.getElementById('sboxStatus');
    if (el) {
      el.textContent = nachricht;
      el.className = 'plan-status' + (art ? ' plan-status--' + art : '');
    }
  }

  function text(id, wert) {
    var el = document.getElementById(id);
    if (el) el.textContent = wert;
  }

  async function fehlertext(antwort) {
    try {
      var daten = await antwort.json();
      return daten.detail || antwort.statusText;
    } catch (e) {
      return antwort.status + ' ' + antwort.statusText;
    }
  }

  /** Schaltflächen und Schalter auf den Stand des Moduls bringen. */
  function knopfStand() {
    var s = BimViewer.SectionBox;
    var waehlen = document.getElementById('sboxPick');
    if (waehlen) {
      waehlen.classList.toggle('btn--primary', !s.waehlt);
      waehlen.classList.toggle('is-active', s.waehlt);
      waehlen.textContent = s.waehlt ? '… klicken Sie ein Bauteil an (Esc)' : '⌖ Bauteil anklicken';
    }
    var block = document.getElementById('sboxAktiv');
    if (block) block.style.display = s.box ? '' : 'none';

    [['sboxModusInnen', 'innen'], ['sboxModusAussen', 'aussen']].forEach(function (paar) {
      var btn = document.getElementById(paar[0]);
      if (btn) btn.classList.toggle('btn--primary', s.modus === paar[1]);
    });
  }

  // ── Reiter einhängen ───────────────────────────────────────────────────
  //
  // Wie in plan-panel.js über das DOM und nicht über `getToolsContent()`:
  // `showToolsTab()` geht generisch über [data-tab] und #toolsPane-{name},
  // findet den Reiter also von selbst, und ui.js bleibt unangetastet.

  function panelHtml() {
    return '' +
      '<div class="section">' +
        '<button class="btn btn--sm btn--primary btn--block" id="sboxPick"' +
              ' onclick="BimViewer.SectionBox.auswahlUmschalten()">⌖ Bauteil anklicken</button>' +
        '<div class="plan-hint">Ein Meterwürfel setzt sich auf die angeklickte Stelle. ' +
          'Aufgezogen wird er an den sechs Griffen — jeder bewegt seine Fläche, die ' +
          'gegenüberliegende bleibt stehen.</div>' +
        '<div class="sbox-zeile"><span>Bauteil</span><b id="sboxBauteil">noch keins gewählt</b></div>' +
        '<div class="plan-status" id="sboxStatus"></div>' +
      '</div>' +

      '<div id="sboxAktiv" style="display:none;">' +
        '<div class="section">' +
          '<div class="section__label">Was die Box schneidet</div>' +
          '<div class="btn-group sbox-modus">' +
            '<button class="btn btn--sm" id="sboxModusInnen"' +
                  ' title="Alles außerhalb der Box wird ausgeblendet — das Bauteil steht mit ' +
                          'seinen Anschlüssen frei"' +
                  ' onclick="BimViewer.SectionBox.setModus(\'innen\')">▣ Nur Boxinhalt</button>' +
            '<button class="btn btn--sm" id="sboxModusAussen"' +
                  ' title="Der Boxinhalt wird ausgeblendet — der Blick geht an dieser Stelle ' +
                          'ins Bauwerk hinein"' +
                  ' onclick="BimViewer.SectionBox.setModus(\'aussen\')">▢ Boxinhalt weg</button>' +
          '</div>' +
          '<div class="plan-hint">Dieselbe Box, entgegengesetzte Frage: das eine stellt das ' +
            'Bauteil frei, das andere schaut an seiner Stelle ins Bauwerk hinein.</div>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section__label">Box</div>' +
          '<div class="sbox-zeile"><span>Abmessung</span><b id="sboxMasse">—</b></div>' +
          '<div class="pc-slider-row">' +
            '<span class="pc-row-label">Drehung</span>' +
            '<input type="range" id="sboxYaw" min="-180" max="180" step="1" value="0"' +
                  ' oninput="BimViewer.SectionBox.setYaw(this.value)">' +
            '<span class="pc-value">°</span>' +
          '</div>' +
          '<label class="pc-row"><span class="pc-row-label">Alle Modelle schneiden</span>' +
            '<input type="checkbox" id="sboxAlle" checked' +
                  ' onchange="BimViewer.SectionBox.setAlleModelle(this.checked)"></label>' +
          '<label class="pc-row"><span class="pc-row-label">Rückseiten zeigen</span>' +
            '<input type="checkbox" id="sboxRueck" checked' +
                  ' onchange="BimViewer.SectionBox.rueckseitenSetzen(this.checked)"></label>' +
          '<div class="plan-hint" id="sboxZiele"></div>' +
          '<div class="plan-hint">Eine geschnittene Wand ist innen hohl — Cesium füllt ' +
            'Schnittflächen nicht. Ohne Rückseiten schaut man deshalb durch das Bauteil ' +
            'hindurch. Zum Prüfen von Kanten und doppelten Flächen ist es umgekehrt.</div>' +
          '<div class="btn-group">' +
            '<button class="btn btn--sm" onclick="BimViewer.SectionBox.zuruecksetzen()"' +
                  ' title="Zurück auf einen Meter Kantenlänge, an derselben Stelle">1 m</button>' +
            '<button class="btn btn--sm" onclick="BimViewer.SectionBox.aufBauteil()"' +
                  ' title="Box genau um das angeklickte Bauteil legen">Auf Bauteil</button>' +
            '<button class="btn btn--sm" onclick="BimViewer.SectionBox.hinfliegen()">Hinfliegen</button>' +
            '<button class="btn btn--sm btn--danger" onclick="BimViewer.SectionBox.aufheben()">Aufheben</button>' +
          '</div>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section__label">Als Detail zeichnen</div>' +
          '<div class="pc-slider-row">' +
            '<span class="pc-row-label">Schnittebene</span>' +
            '<input type="range" id="sboxSchnitt" min="0" max="1" step="0.02" value="0.5"' +
                  ' oninput="BimViewer.SectionBox.setSchnittanteil(this.value)">' +
            '<span id="sboxSchnittWert" class="pc-value">50 %</span>' +
          '</div>' +
          '<div class="btn-group sbox-ebenen">' +
            '<button class="btn btn--sm btn--primary" title="Waagerecht — Grundriss"' +
                  ' onclick="BimViewer.SectionBox.detail(\'xy\')">▤ XY</button>' +
            '<button class="btn btn--sm btn--primary" title="Senkrecht, Blick längs der Box-Y-Achse"' +
                  ' onclick="BimViewer.SectionBox.detail(\'xz\')">◫ XZ</button>' +
            '<button class="btn btn--sm btn--primary" title="Senkrecht, Blick längs der Box-X-Achse"' +
                  ' onclick="BimViewer.SectionBox.detail(\'yz\')">◫ YZ</button>' +
          '</div>' +
          '<div class="plan-hint">Drei Ebenen durch dieselbe Box: <b>XY</b> waagerecht, ' +
            '<b>XZ</b> und <b>YZ</b> senkrecht dazu. Der Ausschnitt sind jedes Mal die ' +
            'Boxgrenzen, der Regler schiebt die Ebene darin von einer Kante zur anderen.</div>' +
          '<div class="plan-hint">Gezeichnet wird immer der <b>Boxinhalt</b> — auch dann, ' +
            'wenn er gerade weggeschnitten ist.</div>' +
          '<div class="plan-hint">Öffnet den Zeichenmodus — dort bemaßen, beschriften und ' +
            'positionieren. Beim Schließen geht das Blatt ins Archiv im Reiter „Plan".</div>' +
          '<div class="btn-group">' +
            '<button class="btn btn--sm btn--primary" style="width:100%"' +
                  ' title="Alle drei Ebenen auf einmal ins Archiv legen — unter dem Namen des ' +
                  'Bauteils. Das erste Blatt öffnet sich, die Blattauswahl oben führt zu den ' +
                  'anderen." onclick="BimViewer.PlanBauteil && BimViewer.PlanBauteil.vomAuswahl()">' +
              '📐 Bauteil als Plansatz ablegen</button>' +
          '</div>' +
          '<div class="plan-hint">Der Plansatz ist der Weg zum <b>Detaillieren</b>: drei Blätter ' +
            'zum selben Bauteil, jedes mit Stahlliste, alle über die Blattauswahl im ' +
            'Zeichenfenster erreichbar. Ohne aufgezogene Box wird die Hüllbox des Bauteils ' +
            'genommen und um 15 % aufgeweitet, damit die Anschlüsse mit im Bild sind.</div>' +
        '</div>' +
      '</div>';
  }

  function reiterEinhaengen() {
    var reiter = document.querySelector('#section-tools .tabs');
    if (!reiter || reiter.querySelector('[data-tab="sbox"]')) return !!reiter;

    var knopf = document.createElement('button');
    knopf.className = 'tab';
    knopf.setAttribute('role', 'tab');
    knopf.dataset.tab = 'sbox';
    knopf.textContent = 'Schnittbox';
    knopf.onclick = function () {
      BimViewerUI.showToolsTab('sbox');
      BimViewer.SectionBox._anzeigeAktualisieren();
      knopfStand();
    };
    reiter.appendChild(knopf);

    var flaeche = document.createElement('div');
    flaeche.className = 'tab-pane';
    flaeche.id = 'toolsPane-sbox';
    flaeche.innerHTML = panelHtml();
    reiter.parentNode.appendChild(flaeche);

    console.log('📦 Schnittbox-Reiter eingehängt');
    return true;
  }

  /** Die Reglerstände zurück ins frisch gebaute Markup. */
  function panelStandHerstellen() {
    var s = BimViewer.SectionBox;
    wert('sboxSchnitt', s.schnittanteil);
    wert('sboxYaw', (s.box && s.box.yaw) || 0);
    haken('sboxAlle', s.alleModelle);
    haken('sboxRueck', s.rueckseiten);
    s._anzeigeAktualisieren();
    knopfStand();
  }

  function wert(id, v) {
    var el = document.getElementById(id);
    if (el) el.value = v;
  }

  function haken(id, an) {
    var el = document.getElementById(id);
    if (el) el.checked = !!an;
  }

  var versuche = 0;
  var timer = setInterval(function () {
    if (!reiterEinhaengen() && ++versuche <= 30) return;
    clearInterval(timer);
    panelStandHerstellen();
  }, 400);

  // Ein Sprachwechsel baut die gesamte Aktivitätsleiste neu auf (ui.js,
  // `ileen:language-changed`) — die Panels sind HTML-Strings und lassen sich
  // nicht nachträglich übersetzen. Der Reiter muss danach erneut eingehängt
  // werden, sonst ist das Werkzeug nach einem Klick auf „Deutsch/English"
  // verschwunden, obwohl die Box in der Szene weiterläuft. Nach dem Neuaufbau,
  // deshalb der Umweg über einen Frame.
  document.addEventListener('ileen:language-changed', function () {
    setTimeout(function () {
      reiterEinhaengen();
      panelStandHerstellen();
    }, 0);
  });

  // ── Einstieg aus der Modell-Liste ──────────────────────────────────────

  BimViewer.injectSectionBoxButton = function (assetId) {
    var karte = document.getElementById('asset_' + assetId.toString());
    if (!karte) return;
    var leiste = karte.querySelector('.modern-asset-controls');
    if (!leiste || document.getElementById('sboxBtn_' + assetId)) return;

    var btn = document.createElement('button');
    btn.id = 'sboxBtn_' + assetId;
    btn.className = 'modern-icon-btn';
    btn.title = 'Schnittbox um ein Bauteil dieses Modells';
    btn.textContent = '📦';
    btn.onclick = function () {
      if (BimViewerUI && BimViewerUI.activateSection) BimViewerUI.activateSection('tools');
      if (BimViewerUI && BimViewerUI.showToolsTab) BimViewerUI.showToolsTab('sbox');
      BimViewer.SectionBox.auswahlStarten();
    };
    leiste.insertBefore(btn, leiste.lastElementChild);
  };

  if (window.BimViewerUI && typeof BimViewerUI.createAssetControls === 'function') {
    var urspruenglich = BimViewerUI.createAssetControls.bind(BimViewerUI);
    BimViewerUI.createAssetControls = function (assetId) {
      urspruenglich(assetId);
      BimViewer.injectSectionBoxButton(assetId);
    };
  }

  // Ein entladenes Modell darf keine Box mehr tragen — ihre Ebenen zeigten
  // sonst auf ein Tileset, das Cesium bereits zerstört hat.
  if (typeof BimViewer.unloadAsset === 'function') {
    var urspruenglichesEntladen = BimViewer.unloadAsset.bind(BimViewer);
    BimViewer.unloadAsset = function (assetId) {
      var s = BimViewer.SectionBox;
      if (s.quelle && s.quelle.assetKey === assetId.toString()) s.aufheben();
      urspruenglichesEntladen(assetId);
    };
  }

  // ── Brücke für plan-panel.js ───────────────────────────────────────────
  //
  // Der Plan-Reiter kennt die alte Schnittstelle (`clipBox.configs` mit
  // Halbgrößen und der modelMatrix der Ebenensammlung) und liest daraus den
  // Ausschnitt für „Auf Clipping-Box begrenzen". Statt ihn anzufassen, bleibt
  // die Schnittstelle als Sicht auf die neue Box bestehen — sie kostet nichts
  // und hält den Haken am Leben.

  BimViewer.clipBox = {
    get activeAssetId() {
      var s = BimViewer.SectionBox;
      return s.box && s.quelle ? s.quelle.assetKey : null;
    },
    configs: {
      get: function (assetId) {
        var s = BimViewer.SectionBox;
        if (!s.box || !s.quelle || s.quelle.assetKey !== String(assetId)) return null;
        var ziel = s.ziele.find(function (z) { return z.tileset === s.quelle.tileset; });
        if (!ziel || !ziel.collection) return null;
        return {
          sizes: { 0: s.box.size[0] / 2, 1: s.box.size[1] / 2, 2: s.box.size[2] / 2 },
          collection: ziel.collection
        };
      },
      delete: function () { /* die Box räumt sich selbst ab */ }
    }
  };

  console.log('📦 Schnittbox v2.0 geladen — Bauteil anklicken, Box aufweiten, als Detail zeichnen');
})();
