/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Licensed under BSL 1.1 (siehe clipping-planes.js).
 */

// ===============================
// EXPLOSION — die Geschosse auseinanderziehen
//
// Ein Gebäude von außen ist ein Klotz. Die Explosionsansicht hebt jedes
// Geschoss um denselben Betrag über das darunterliegende, sodass man in alle
// Ebenen gleichzeitig hineinsieht, ohne etwas auszublenden oder zu schneiden.
//
// ## Drei Träger, zwei Techniken
//
// In der Szene liegen dreierlei Dinge, und sie lassen sich nicht auf demselben
// Weg bewegen:
//
//   1. **IFC-Modelle als 3D Tiles** — deren Geometrie liegt auf der GPU und
//      ist von JavaScript aus nicht einzeln greifbar. Sie wird über einen
//      `CustomShader` im Vertex-Shader verschoben.
//   2. **Konzept-Baukörper** (konzept-4d.js) und
//   3. **Bauplaner-Bauteile** (bauplaner.js) — beides Cesium-Entities mit
//      bekannter Lage und bekanntem Geschoss. Sie werden schlicht umgesetzt.
//
// Beide Wege sind vollständig rückbaubar: Tilesets bekommen ihren vorherigen
// Shader zurück, Entities ihre gemerkte Ausgangslage. Nichts davon wird
// gespeichert — die Explosion ist eine Ansicht, kein Zustand des Modells.
//
// ## Warum die Höhe im Augen-Koordinatensystem gemessen wird
//
// Der Vertex-Shader kennt nur `positionMC`, und was „MC" bedeutet, ist bei
// 3D Tiles von Kachel zu Kachel verschieden — jede bringt ihre eigene
// Transformation mit. Eine feste Matrix „Modell → Geschosshöhe" gibt es
// deshalb nicht.
//
// Was es gibt, ist `czm_modelView`: die Abbildung nach Augen-Koordinaten, die
// Cesium für jede Kachel korrekt setzt. Die Höhe über der Modellbasis ist
// darin ein Skalarprodukt:
//
//     h = dot(positionEC − basisEC, obenEC)
//
// `basisEC` ist der Tile-Ursprung, `obenEC` seine Hochachse — beide je Bild
// einmal aus `root.computedTransform` und der Kameramatrix nachgeführt. Der Umweg über
// Augen-Koordinaten ist nicht Umständlichkeit, sondern Genauigkeit: der
// naheliegende Weg über `czm_model` liefert ECEF-Koordinaten in der Größe des
// Erdradius, und in `float` bleibt davon knapp ein halber Meter Auflösung
// übrig — zu grob, um ein Geschoss vom nächsten zu trennen.
//
// ## Zwei Nullpunkte, ein Versatz
//
// `h` zählt damit ab dem **Tile-Ursprung**, und der liegt bei den Tilings
// dieses Backends in der *Mitte* des Hüllkörpers: der Octree zentriert das
// Modell noch einmal auf seinen Wurzelknoten, nachdem die Aufbereitung es auf
// die Unterkante gestellt hat. `GET /assets/{job}/storeys` zählt dagegen ab
// der **Modellunterkante** — dieselbe Zählung, die der Grundrissschnitt
// braucht. Beide Zahlen sind richtig und beziehen sich auf verschiedene
// Nullpunkte; `_grenzenFuer()` rechnet die Geschosshöhen deshalb um die
// Unterkante des Hüllkörpers (`_hoehenspanne().unten`) nach unten. Fehlt diese
// Umrechnung, liegen alle Trennebenen um eine halbe Gebäudehöhe zu hoch: die
// unterste greift dann irgendwo im Dachbereich, alles darunter steht still,
// und statt einer Explosion sieht man eine einzelne gedehnte Wand unter dem
// Dach.
//
// Zurückverschoben wird entlang `czm_inverseModelView * obenEC`. Dieser Vektor
// wird **nicht** normiert: `obenEC` ist ein Einheitsvektor in Weltmetern, seine
// Rücktransformation hat damit genau die Länge, die einem Weltmeter im
// Modellsystem entspricht — die Umrechnung erledigt sich von selbst, auch wenn
// das Tileset skaliert ist.
//
// ## Die Trennebene liegt über der Geschosshöhe, nicht auf ihr
//
// `IfcBuildingStorey.Elevation` ist die Oberkante der Rohdecke. Läge die
// Trennebene genau dort, bekäme die Decke ihre Unterseite vom unteren und ihre
// Oberseite vom oberen Geschoss zugewiesen — sie würde über den ganzen Abstand
// auseinandergezogen und stünde als meterdicker Klotz im Bild.
//
// Deshalb liegt die Trennebene um das **Fugenmaß** höher (Vorgabe 15 cm, etwa
// ein Fußbodenaufbau). Die Decke bleibt dann vollständig beim unteren
// Geschoss; gedehnt wird nur der unterste Streifen der aufgehenden Wände, und
// der bildet eine kurze Schräge, die man nicht sieht. Ein Bauteil, das mehrere
// Geschosse durchläuft — eine Stütze über zwei Ebenen, ein Treppenlauf —, wird
// dagegen zwangsläufig gedehnt. Das ist die Grenze des Verfahrens und der
// Preis dafür, dass es ohne Bauteilkennungen im Shader auskommt.
//
// ## Stauchen: das Geschoss auf seine eigene Ebene legen
//
// Auseinanderziehen allein lässt jedes Geschoss seine drei Meter Bauhöhe
// behalten — der Stapel ist eine Reihe von Klötzen. Der Regler „Auf eine
// Ebene stauchen" zieht zusätzlich jeden Vertex auf die Fußbodenebene seines
// Geschosses herunter:
//
//     positionMC -= obenMC * (h - basis) * u_flach
//
// `basis` ist dabei die Höhe, auf die gestaucht wird. Auf dem Klon-Weg ist sie
// eine einzige Zahl je Tileset — ein Klon enthält per Style genau ein Geschoss
// —, auf dem Shader-Weg fällt sie in derselben if-Kette an, die schon die
// Etage bestimmt.
//
// **Gestaucht wird nie ganz auf null** (`STAUCH_MAX`). Koplanare Flächen
// haben keine eindeutige Tiefensortierung: Fußboden, Decke und Wandfuß lägen
// exakt aufeinander und flimmerten gegeneinander, sobald sich die Kamera
// bewegt. Zwei Prozent Resthöhe sind bei einem Dreimetergeschoss sechs
// Zentimeter — im Bild flach, für den Tiefenpuffer eindeutig.
//
// Was dabei entsteht, ist eine *Ansicht*, kein Grundriss: die Wand wird zum
// Vollrechteck ohne Türöffnung, und von oben sieht man die Deckenunterseite
// statt der Raumaufteilung. Lesbare Grundrisse liefert der Backend-Schnitt —
// siehe geschossplaene.js, das sie als Bild in denselben Stapel legt.
//
// ## Was die Explosion nicht kann
//
// Cesium verwirft Kacheln, deren *ursprüngliche* Hüllkörper außerhalb des
// Sichtfelds liegen. Verschobene Geometrie kann deshalb bei großem Abstand und
// naher Kamera abrupt verschwinden — aus der Übersicht, aus der man eine
// Explosionsansicht ansieht, tritt das nicht auf. Im 2D- und Columbus-Modus
// bleibt sie ganz aus: dort rechnet Cesium mit einer anderen Kameramatrix, und
// eine schief stehende Explosion wäre schlechter als keine.
// ===============================
'use strict';

(function () {

  if (!window.BimViewer) {
    console.warn('explosion.js: BimViewer nicht gefunden');
    return;
  }

  // Mehr Trennebenen erzeugt kein Hochhaus dieser Welt in einem Viewer, und
  // die if-Kette im Shader soll überschaubar bleiben.
  var STUFEN_MAX = 60;

  // Wie weit sich ein Geschoss höchstens stauchen lässt. Nicht 1.0: bei voller
  // Stauchung lägen Fußboden, Wandfuß und Deckenunterseite in derselben Ebene,
  // und koplanare Flächen haben keine eindeutige Tiefensortierung — das Bild
  // flimmert bei jeder Kamerabewegung. Zwei Prozent Resthöhe sind bei drei
  // Metern sechs Zentimeter.
  var STAUCH_MAX = 0.98;

  // Zwischenspeicher für die Rechnerei je Bild — ohne sie entstünden bei
  // sechzig Bildern in der Sekunde je Modell vier Cartesian3 pro Bild.
  var _wc1 = new Cesium.Cartesian3();
  var _wc2 = new Cesium.Cartesian3();
  var _ec1 = new Cesium.Cartesian3();
  var _ec2 = new Cesium.Cartesian3();
  var _m1 = new Cesium.Matrix4();

  BimViewer.Explosion = {

    aktiv: false,

    /** Abstand zwischen zwei Geschossen in Metern. 0 heißt: nichts bewegt sich. */
    abstand: 3.0,

    /** Obergrenze des Reglers — darüber verliert die Ansicht den Zusammenhang. */
    maxAbstand: 15,

    /**
     * Ersatz-Geschosshöhe für Modelle ohne Geschossverzeichnis.
     * Ion-Assets bringen keines mit; dort wird gleichmäßig geteilt.
     */
    regelhoehe: 3.0,

    /** Wie weit die Trennebene über der Geschosshöhe liegt (siehe Kopf). */
    fuge: 0.15,

    /**
     * Wie flach jedes Geschoss gedrückt wird. 0 = volle Bauhöhe, 1 = platt.
     *
     * Ein Uniform, kein Shader-Neubau: am Regler wird gezogen, und die Kette
     * aus Trennebenen bliebe dabei ohnehin dieselbe.
     */
    flach: 0,

    /** { tileset, shader, grenzen, name, quelle } je Modell am Shader-Weg. */
    ziele: [],

    /** { asset, name, gruppen, klone, showVorher } je Modell am Klon-Weg. */
    klonZiele: [],

    /** jobId → Geschosshöhen aus dem Backend. Einmal geholt, dann behalten. */
    _geschossCache: {},

    /** Modelle, die beim letzten Aufbau stehen geblieben sind, mit Grund. */
    uebersprungen: [],

    _wache: null,
    _bild: 0,

    // ── Schalten ───────────────────────────────────────────────────────────

    umschalten: function () {
      if (this.aktiv) this.aus(); else this.an();
    },

    an: async function () {
      if (this.aktiv) return;
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      if (!szene) return;

      if (szene.mode !== Cesium.SceneMode.SCENE3D) {
        this._melden('Die Explosionsansicht braucht die 3D-Ansicht.', 'error');
        this._anzeige();   // sonst bliebe der Schalter umgelegt, ohne dass etwas geschieht
        return;
      }

      this.aktiv = true;
      this._melden('Geschosse werden gelesen — Modelle mit Geschossverzeichnis '
                 + 'werden dafür je Geschoss einmal geladen.', 'busy');

      await this._zieleAufbauen();
      this._entitiesAnwenden();
      this._wacheStarten();
      this._anzeige();
      this._melden(this._bericht(), '');
    },

    aus: function () {
      if (!this.aktiv) return;
      this.aktiv = false;
      this._wacheStoppen();

      this.ziele.forEach(function (ziel) {
        try {
          BimViewer.ShaderVerbund.entfernen(ziel.tileset, 'explosion');
        } catch (e) { /* Tileset ist schon entladen */ }
      });
      this.ziele = [];
      this._kloneAbbauen();

      this._entitiesZuruecksetzen();
      this._anzeige();
      this._melden('', '');
    },

    /**
     * Regler „Abstand". Kostet keinen Shader-Neubau — nur ein Uniform.
     *
     * Wer am Regler zieht, will die Ansicht sehen und nicht erst noch einen
     * Schalter suchen: der erste Zug über null schaltet sie mit ein. Der Weg
     * zurück auf null schaltet dagegen NICHT aus — sonst würde beim Ziehen
     * über die Null jedes Mal die ganze Kette abgebaut und neu aufgebaut. Bei
     * Abstand null steht ohnehin alles an seinem Platz.
     */
    abstandSetzen: function (meter) {
      this.abstand = Math.max(0, Math.min(this.maxAbstand, parseFloat(meter) || 0));

      if (!this.aktiv) {
        if (this.abstand > 0) this.an();
        else this._anzeige();
        return;
      }

      this.ziele.forEach(function (ziel) {
        ziel.shader.setUniform('u_abstand', this.abstand);
      }, this);
      this._kloneLagen();
      this._entitiesAnwenden();
      this._anzeige();
    },

    /**
     * Regler „Auf eine Ebene stauchen".
     *
     * Wie `abstandSetzen()` ein reines Uniform, und aus demselben Grund auch
     * ein Einschalter: wer die Geschosse flach drücken will, will sie sehen.
     * Der Weg zurück auf null schaltet nicht aus — sonst würde beim Ziehen
     * über die Null die ganze Kette ab- und wieder aufgebaut.
     *
     * Bei Abstand null bleibt der Stapel ineinander stecken; das Stauchen ist
     * dann sinnlos, aber nicht falsch, und einen Abstand ungefragt zu setzen
     * wäre eine Entscheidung über eine Ansicht, die dem Nutzer gehört.
     */
    flachSetzen: function (wert) {
      this.flach = Math.max(0, Math.min(1, parseFloat(wert) || 0));

      if (!this.aktiv) {
        if (this.flach > 0) this.an();
        else this._anzeige();
        return;
      }

      var faktor = this.flach * STAUCH_MAX;
      this.ziele.forEach(function (ziel) {
        ziel.shader.setUniform('u_flach', faktor);
      });
      this.klonZiele.forEach(function (z) {
        z.klone.forEach(function (k) {
          if (k.shader) k.shader.setUniform('u_flach', faktor);
        });
      });
      this._anzeige();
    },

    /**
     * Ersatz-Geschosshöhe und Fugenmaß ändern die Trennebenen selbst — dafür
     * müssen die Shader neu gebaut werden, weil die Grenzen als Konstanten im
     * Quelltext stehen (siehe `_bausteinBauen`).
     */
    regelhoeheSetzen: function (meter) {
      this.regelhoehe = Math.max(1.5, Math.min(12, parseFloat(meter) || 3.0));
      this._neuAufbauen();
    },

    fugeSetzen: function (meter) {
      this.fuge = Math.max(0, Math.min(1.5, parseFloat(meter) || 0));
      this._neuAufbauen();
    },

    /**
     * Die Geschossaufbereitung nach außen — für geschossplaene.js.
     *
     * Dasselbe Verzeichnis, derselbe Zwischenspeicher, dieselbe Zusammen-
     * fassung doppelt geführter Ebenen. Ein zweiter Weg dorthin wäre ein
     * Zwilling, und beim ersten Modell mit zwei Bauwerken auf einer Höhe
     * stünden Explosionsstapel und Grundrissstapel verschieden hoch.
     */
    geschosse: function (jobId) {
      return this._geschosseHolen(jobId);
    },

    /** Ebenso: die Höhenspanne, aus der der Nullpunkt-Versatz folgt. */
    hoehenspanne: function (tileset) {
      return this._hoehenspanne(tileset);
    },

    /** Nach dem Laden weiterer Modelle: die neuen mitnehmen. */
    auffrischen: function () {
      if (this.aktiv) this._neuAufbauen();
      else this._anzeige();
    },

    _neuAufbauen: async function () {
      if (!this.aktiv) return;
      // Nur der Shader-Weg wird neu gebaut: Fugenmaß und Ersatzraster wirken
      // allein auf ihn, und die Klone noch einmal zu laden hieße, für nichts
      // ein halbes Modell durchs Netz zu ziehen.
      this.ziele.forEach(function (ziel) {
        try { BimViewer.ShaderVerbund.entfernen(ziel.tileset, 'explosion'); } catch (e) { /* entladen */ }
      });
      this.ziele = [];
      await this._zieleAufbauen();
      this._entitiesAnwenden();
      this._melden(this._bericht(), '');
      this._anzeige();
    },

    // ── Tilesets ───────────────────────────────────────────────────────────

    /**
     * Welche Modelle mitfliegen.
     *
     * Punktwolken und Gaussian Splats bleiben außen vor: ihr Inhalt läuft
     * nicht über den Modell-Renderer, ein `customShader` bliebe dort ohne
     * Wirkung oder zerstörte die Darstellung. Ein Gelände hat ohnehin keine
     * Geschosse.
     */
    _zieleAufbauen: async function () {
      var kandidaten = [];

      BimViewer.loadedAssets.forEach(function (asset) {
        var ts = asset.tileset;
        if (!ts || !ts.root) return;
        if (ts._isGaussianSplat || asset.isPointCloud) return;
        if (asset.visible === false) return;
        kandidaten.push(asset);
      });

      this.uebersprungen = [];

      for (var i = 0; i < kandidaten.length; i++) {
        var asset = kandidaten[i];

        // Schon geklont? Dann steht dieses Modell bereits richtig — beim
        // Neuaufbau nach einer Feineinstellung darf es nicht ein zweites Mal
        // dazukommen.
        if (this._klonZielFuer(asset)) continue;

        // Erste Wahl ist der Klon-Weg: er trennt nach dem Geschoss, in dem ein
        // Bauteil laut Modell steht, und zerrt deshalb an keinem Bauteil.
        // Er setzt ein Geschossverzeichnis voraus — fehlt es, bleibt der
        // Shader-Weg mit seiner Höhenschwelle.
        var gruppen = await this._geschosseFuer(asset);
        if (gruppen && gruppen.length > 1) {
          var geklont = await this._kloneAufbauen(asset, gruppen);
          if (geklont) continue;
        }

        var ebenen = await this._grenzenFuer(asset);

        if (!ebenen.grenzen.length) {
          this.uebersprungen.push(asset.name + ' (' + ebenen.quelle + ')');
          continue;
        }

        var baustein = this._bausteinBauen(ebenen.grenzen, ebenen.basen);
        // Angemeldet, nicht gesetzt: der Rückseitenschnitt aus core.js und
        // eine laufende Bildprojektion bleiben daneben stehen, und beim
        // Ausschalten wird nur dieser eine Baustein wieder abgemeldet.
        var shader;
        try {
          shader = BimViewer.ShaderVerbund.setzen(asset.tileset, 'explosion', baustein);
        } catch (e) {
          console.warn('explosion: Shader nicht setzbar für ' + asset.name, e);
          this.uebersprungen.push(asset.name + ' (Shader abgelehnt)');
          continue;
        }
        if (!shader) {
          this.uebersprungen.push(asset.name + ' (Shader abgelehnt)');
          continue;
        }
        this.ziele.push({
          tileset: asset.tileset,
          shader: shader,
          grenzen: ebenen.grenzen,
          name: asset.name,
          quelle: ebenen.quelle
        });
      }
      // Damit im ersten Bild schon die richtige Lage steht und nicht ein
      // Bild lang alles auf der Nullhöhe klebt.
      this._uniformsNachfuehren();
    },

    /**
     * Die Trennebenen eines Modells, in Tile-Koordinaten (Meter über dem
     * Tile-Ursprung), aufsteigend.
     *
     * Erste Wahl ist das Geschossverzeichnis des Backends — dieselbe Quelle,
     * aus der plan-panel.js seine Grundrisse schneidet, und damit dieselben
     * Höhen, die im Modell wirklich stehen. Ion-Assets ohne Backend-Auftrag
     * haben keines; dort wird ab der Modellunterkante gleichmäßig geteilt.
     */
    _grenzenFuer: async function (asset) {
      var gruppen = await this._geschosseFuer(asset);
      var hoehen = gruppen && gruppen.map(function (g) { return g.hoehe; });

      // Führt das Modell ein Geschossverzeichnis, gilt es — auch dann, wenn
      // darin nur ein Geschoss steht. Ein eingeschossiges Gebäude hilfsweise
      // in Drei-Meter-Scheiben zu schneiden, wäre keine Explosionsansicht,
      // sondern eine erfundene Gliederung.
      if (hoehen) {
        // Die beiden Zählungen haben verschiedene Nullpunkte: das Backend zählt
        // ab der Modellunterkante, der Shader ab dem Tile-Ursprung — und der
        // liegt in der MITTE des Hüllkörpers (siehe Kopf). Ohne diesen Versatz
        // liegen alle Trennebenen um eine halbe Gebäudehöhe zu hoch, und von
        // der Explosion bleibt nur eine gedehnte Dachkante übrig.
        var spanne = this._hoehenspanne(asset.tileset);
        var basis = spanne ? spanne.unten : 0;

        return {
          // Die unterste Ebene bekommt keine Trennung — unter ihr liegt nichts,
          // was sich abheben ließe.
          grenzen: hoehen.slice(1, STUFEN_MAX + 1)
                         .map(function (h) { return h + basis + this.fuge; }, this),
          // Gestaucht wird auf den Fußboden, nicht auf die Trennebene: die
          // liegt um das Fugenmaß höher, und ein Geschoss, das auf die Kante
          // *über* seiner Decke gedrückt wird, steckt im Nachbargeschoss.
          basen: hoehen.slice(0, STUFEN_MAX + 1)
                       .map(function (h) { return h + basis; }),
          quelle: hoehen.length > 1 ? 'Geschosse aus dem Modell'
                : hoehen.length ? 'nur ein Geschoss' : 'kein Geschoss mit Bauteilen'
        };
      }

      var raster = this._rasterGrenzen(asset.tileset);
      var spanneR = this._hoehenspanne(asset.tileset);
      var untenR = spanneR ? spanneR.unten : 0;
      return {
        grenzen: raster,
        // Ohne Verzeichnis liegen die Fußböden im Ersatzraster: die unterste
        // Ebene auf der Modellunterkante, jede weitere auf ihrer Trennebene —
        // dort gibt es kein Fugenmaß, das die beiden auseinanderhielte.
        basen: [untenR].concat(raster),
        quelle: 'gleichmäßig geteilt'
      };
    },

    /**
     * Das Geschossverzeichnis eines Modells, oder null wenn es keines gibt.
     *
     * Ion-Assets und alles, was nicht aus einem Backend-Auftrag stammt, führen
     * keines; ein Netzfehler ebenso wenig — beides endet hier gleich, weil in
     * beiden Fällen dasselbe folgt: der Shader-Weg.
     */
    _geschosseFuer: async function (asset) {
      if (!asset.jobId || !BimViewer.getBackendUrl()) return null;
      try {
        return await this._geschosseHolen(asset.jobId);
      } catch (e) {
        console.warn('explosion: Geschosse für ' + asset.name + ' nicht ladbar', e);
        return null;
      }
    },

    _geschosseHolen: async function (jobId) {
      if (this._geschossCache[jobId]) return this._geschossCache[jobId];

      var antwort = await fetch(BimViewer.getBackendUrl() + '/assets/' + jobId + '/storeys');
      if (!antwort.ok) throw new Error('HTTP ' + antwort.status);
      var liste = await antwort.json();

      // Geschosse ohne Bauteile sind Hilfsebenen (Fundamentkante, Attika) und
      // erzeugen sonst eine leere Stufe mitten im Stapel.
      //
      // Zwei Geschosse auf derselben Höhe (ein halber Meter Abstand genügt als
      // Unterscheidung) sind KEIN Fehler, sondern die übliche Aufteilung eines
      // Bauwerks in Fachebenen — „Gründung" und „UG" auf 1,60 m etwa. Sie
      // werden zu einer Ebene zusammengefasst, behalten aber BEIDE Namen:
      // die Klone filtern nach dem Geschossnamen aus der Batch Table, und ein
      // weggeworfener Name wäre ein unsichtbares Bauteil.
      var gruppen = [];
      liste
        .filter(function (g) { return g.bauteile > 0 && isFinite(g.hoehe); })
        .sort(function (a, b) { return a.hoehe - b.hoehe; })
        .forEach(function (g) {
          var letzte = gruppen[gruppen.length - 1];
          if (letzte && g.hoehe - letzte.hoehe <= 0.5) letzte.namen.push(g.name);
          else gruppen.push({ hoehe: g.hoehe, namen: [g.name] });
        });

      this._geschossCache[jobId] = gruppen;
      return gruppen;
    },

    /** Gleichmäßiges Raster ab Modellunterkante — für Modelle ohne Verzeichnis. */
    _rasterGrenzen: function (tileset) {
      var spanne = this._hoehenspanne(tileset);
      if (!spanne) return [];

      var grenzen = [];
      var h = spanne.unten + this.regelhoehe;
      while (h < spanne.oben - 0.5 && grenzen.length < STUFEN_MAX) {
        grenzen.push(h);
        h += this.regelhoehe;
      }
      return grenzen;
    },

    /**
     * Unter- und Oberkante des Modells in Tile-Koordinaten.
     *
     * Der ausgerichtete Hüllquader des Wurzelknotens sitzt eng am Bauwerk und
     * ist damit die brauchbare Angabe; die Hüllkugel ist nur der Notnagel und
     * liegt je nach Grundriss mehrere Meter zu tief. Beides steckt bei Cesium
     * eine Ebene tief in `boundingVolume.boundingVolume` — deshalb der
     * vorsichtige Zugriff.
     */
    _hoehenspanne: function (tileset) {
      var nachTile = this._nachTile(tileset);
      if (!nachTile) return null;

      var huelle = tileset.root.boundingVolume && tileset.root.boundingVolume.boundingVolume;

      if (huelle && huelle.halfAxes) {
        var achsen = huelle.halfAxes;
        var unten = Infinity, oben = -Infinity;
        for (var i = 0; i < 8; i++) {
          var eck = Cesium.Cartesian3.clone(huelle.center, new Cesium.Cartesian3());
          for (var a = 0; a < 3; a++) {
            var richtung = Cesium.Matrix3.getColumn(achsen, a, new Cesium.Cartesian3());
            var vorzeichen = (i & (1 << a)) ? 1 : -1;
            Cesium.Cartesian3.multiplyByScalar(richtung, vorzeichen, richtung);
            Cesium.Cartesian3.add(eck, richtung, eck);
          }
          var z = Cesium.Matrix4.multiplyByPoint(nachTile, eck, new Cesium.Cartesian3()).z;
          unten = Math.min(unten, z);
          oben = Math.max(oben, z);
        }
        if (isFinite(unten) && oben - unten > 1) return { unten: unten, oben: oben };
      }

      var kugel = tileset.boundingSphere;
      if (!kugel) return null;
      var zm = Cesium.Matrix4.multiplyByPoint(nachTile, kugel.center, new Cesium.Cartesian3()).z;
      return { unten: zm - kugel.radius, oben: zm + kugel.radius };
    },

    /** ECEF → Tile-Koordinaten des Modells. */
    _nachTile: function (tileset) {
      var nachEcef = tileset.root && tileset.root.computedTransform;
      if (!nachEcef) return null;
      return Cesium.Matrix4.inverseTransformation(nachEcef, new Cesium.Matrix4());
    },

    /**
     * Der Shader zu einem Satz Trennebenen.
     *
     * Die Grenzen stehen als Konstanten im Quelltext statt in einem Uniform:
     * `CustomShader` kennt keine Feldtypen, und ein Wechsel der Grenzen kommt
     * ohnehin nur vor, wenn ein anderes Modell geladen oder das Fugenmaß
     * verstellt wird — der Abstand selbst, an dem der Regler zieht, bleibt ein
     * Uniform und baut nichts neu.
     *
     * Der Rückseitenschnitt aus core.js wird mitgeführt: er ist bei IFC-Modellen
     * dauerhaft gesetzt, und ohne ihn stünde beim Einschalten der Explosion
     * plötzlich das Z-Fighting doppelseitiger Wände im Bild.
     */
    _bausteinBauen: function (grenzen, basen) {
      basen = basen || [];
      // Etage und Stauchebene fallen in derselben Kette an: die Bedingung ist
      // dieselbe, und zwei getrennte Ketten liefen beim ersten Eingriff am
      // Fugenmaß auseinander.
      var kette = grenzen.map(function (g, i) {
        var basis = basen.length > i + 1 ? basen[i + 1] : g;
        return '          if (h >= ' + g.toFixed(3) + ') { etage = ' + (i + 1) + '.0;'
             + ' basis = ' + basis.toFixed(3) + '; }';
      }).join('\n');
      var basisNull = (basen.length ? basen[0] : 0).toFixed(3);

      return {
        // Nach dem Rückseitenschnitt (0), vor allem Färbenden: was hier
        // verschoben wird, ist die Geometrie, auf die eine Bildprojektion
        // anschließend rechnet.
        ordnung: 10,
        uniforms: {
          u_abstand: { type: Cesium.UniformType.FLOAT, value: this.abstand },
          u_flach:   { type: Cesium.UniformType.FLOAT, value: this.flach * STAUCH_MAX },
          u_basisEC: { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3() },
          u_obenEC:  { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3(0, 0, 1) }
        },
        vertex: /* glsl */ `
          vec3 pEC = (czm_modelView * vec4(vsInput.attributes.positionMC, 1.0)).xyz;
          float h = dot(pEC - u_basisEC, u_obenEC);

          float etage = 0.0;
          float basis = ${basisNull};
${kette}

          // Nicht normieren: u_obenEC ist ein Weltmeter lang, seine
          // Rücktransformation damit genau ein Weltmeter im Modellsystem.
          vec3 obenMC = (czm_inverseModelView * vec4(u_obenEC, 0.0)).xyz;
          // Erst stauchen, dann anheben — beides entlang derselben Achse, die
          // Reihenfolge ist damit nur eine Frage des Vorzeichens.
          vsOutput.positionMC += obenMC * (etage * u_abstand - (h - basis) * u_flach);
      `
        // Kein Rückseitenschnitt mehr an dieser Stelle: er ist ein eigener
        // Baustein (core.js `_rueckseitenBaustein`) und steht ohnehin schon
        // im Verbund jedes IFC-Modells.
      };
    },

    /**
     * Basis und Hochachse jedes Modells in Augen-Koordinaten nachführen.
     *
     * Beides hängt an der Kamera und muss deshalb je Bild neu gesetzt werden —
     * und zwar in `preRender`, wo die Kameramatrix endgültig ist. In
     * `preUpdate` wäre sie noch die des vorigen Bildes, und die Geschosse
     * würden beim Drehen um Zentimeter zittern.
     */
    _uniformsNachfuehren: function () {
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      if (!szene) return;
      var sicht = szene.camera.viewMatrix;

      var verbund = BimViewer.ShaderVerbund;
      var setzen = function (tileset, shader) {
        var nachEcef = tileset.root && tileset.root.computedTransform;
        if (!nachEcef || !shader) return;

        var basisWC = Cesium.Matrix4.multiplyByPoint(nachEcef, Cesium.Cartesian3.ZERO, _wc1);
        var obenWC = Cesium.Matrix4.multiplyByPointAsVector(nachEcef, Cesium.Cartesian3.UNIT_Z, _wc2);
        Cesium.Cartesian3.normalize(obenWC, obenWC);

        // Über den Verbund, nicht über den gemerkten Shader: meldet sich
        // währenddessen ein weiterer Baustein an (eine Bildprojektion wird
        // eingeschaltet), ist der Shader ein anderer, und ein `setUniform`
        // auf dem alten ginge ins Leere — das Geschoss bliebe stehen, wo es
        // beim Umschalten gerade war.
        verbund.uniform(tileset, 'u_basisEC',
          Cesium.Matrix4.multiplyByPoint(sicht, basisWC, _ec1));
        verbund.uniform(tileset, 'u_obenEC',
          Cesium.Matrix4.multiplyByPointAsVector(sicht, obenWC, _ec2));
      };

      this.ziele.forEach(function (ziel) { setzen(ziel.tileset, ziel.shader); });

      // Die Klone brauchen dieselbe Nachführung, seit sie stauchen: ohne sie
      // bliebe `h` bei der Lage des ersten Bildes stehen, und das Geschoss
      // verzöge sich beim ersten Drehen der Kamera.
      this.klonZiele.forEach(function (z) {
        z.klone.forEach(function (k) { setzen(k.tileset, k.shader); });
      });
    },

    // ── Klone: ein Tileset je Geschoss ─────────────────────────────────────
    //
    // Der Shader kennt nur Vertexhöhen, keine Bauteile. Jedes Bauteil, das eine
    // Trennebene quert — eine Steigleitung, eine durchlaufende Wand, ein
    // Treppenlauf —, bekommt seine untere und seine obere Hälfte in
    // verschiedene Etagen gelegt und wird dadurch gedehnt statt gehoben. Bei
    // einem Architekturmodell fällt das kaum auf, bei einem Haustechnikmodell
    // ist es das ganze Bild: dort läuft fast jeder Strang durch alle Geschosse.
    //
    // Deshalb wird ein Modell mit Geschossverzeichnis nicht verformt, sondern
    // vervielfacht. Je Geschoss wird dasselbe Tileset noch einmal geladen, per
    // `Cesium3DTileStyle` auf die Bauteile GENAU DIESES Geschosses gefiltert
    // (die Batch Table jedes Tiles führt die Spalte `Geschoss`) und als Ganzes
    // über `modelMatrix` angehoben. Ein Bauteil gehört damit dorthin, wo es im
    // Modell steht, nicht dorthin, wo seine Vertices liegen — und nichts wird
    // gedehnt.
    //
    // Der Preis ist ehrlich zu nennen: n Geschosse heißen n Tilesets, also
    // n-facher Kachelspeicher und n-fache Zeichenbefehle. Die Ansicht ist
    // dafür gedacht, angesehen zu werden, nicht darin zu arbeiten.
    //
    // Das Original bleibt unangetastet und wird nur unsichtbar (`show`). Es
    // trägt Style, Shader und Clipping-Ebenen anderer Werkzeuge; würde die
    // Explosion daran drehen, käme das Modell nach dem Ausschalten anders
    // zurück, als es war. Eine Clipping-Ebene lässt sich ohnehin nur einem
    // Tileset zuweisen — die Klone bekommen deshalb keine.

    _klonZielFuer: function (asset) {
      for (var i = 0; i < this.klonZiele.length; i++) {
        if (this.klonZiele[i].asset === asset) return this.klonZiele[i];
      }
      return null;
    },

    _kloneAufbauen: async function (asset, gruppen) {
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      var vorlage = asset.tileset;
      var url = asset.url || (BimViewer.getBackendUrl() + '/tiles/' + asset.jobId + '/tileset.json');
      if (!szene || !url) return null;

      // Dieselbe Umrechnung wie in `_grenzenFuer()`: das Backend zählt ab der
      // Modellunterkante, der Shader ab dem Tile-Ursprung.
      var spanne = this._hoehenspanne(vorlage);
      var versatz = spanne ? spanne.unten : 0;

      var eintrag = {
        asset: asset, name: asset.name, gruppen: gruppen,
        klone: [], showVorher: vorlage.show, basisVorher: null
      };

      for (var rang = 0; rang < gruppen.length; rang++) {
        var klon;
        try {
          klon = await Cesium.Cesium3DTileset.fromUrl(url, this._ladeOptionen(vorlage, gruppen.length));
        } catch (e) {
          console.warn('explosion: Geschossklon für ' + asset.name + ' nicht ladbar', e);
          this._eintragAbbauen(eintrag);
          return null;
        }

        // Damit anderer Code (Auswahl, Layerliste) einen Klon als das erkennen
        // kann, was er ist, statt ihn für ein zweites Modell zu halten.
        klon._explosionKlonVon = asset;
        klon._explosionRang = rang;

        klon.style = this._stilFuer(gruppen, rang, vorlage.style);

        // Die Reihenfolge war einmal entscheidend und ist es nicht mehr:
        // `_klonAngleichen()` ruft `applyBackFaceCulling()` aus core.js, und
        // das setzte früher `tileset.customShader` auf seinen eigenen
        // Rückseitenschnitt — womit der Stauchshader still überschrieben war.
        // Die Uniforms ließen sich weiter setzen, sie hingen nur an einem
        // Shader, den niemand mehr zeichnete: der Regler zeigte 98 %, und das
        // Gebäude stand unverändert da. Seit beide Bausteine im Verbund
        // stehen (shader-verbund.js), stehen sie nebeneinander.
        this._klonAngleichen(klon);
        var klonShader = BimViewer.ShaderVerbund.setzen(
          klon, 'explosion', this._klonBausteinBauen(gruppen[rang].hoehe + versatz));

        szene.primitives.add(klon);
        eintrag.klone.push({ tileset: klon, rang: rang, shader: klonShader });
      }

      vorlage.show = false;
      this.klonZiele.push(eintrag);
      this._kloneLagen();
      return eintrag;
    },

    /**
     * Der Shader eines Geschossklons — Stauchen, sonst nichts.
     *
     * Das Anheben macht beim Klon die `modelMatrix` (siehe `_kloneLagen()`);
     * hier bleibt nur das Flachdrücken, und dafür braucht es keine if-Kette:
     * ein Klon enthält per Style genau ein Geschoss und damit genau eine
     * Stauchebene. Sie steht als Konstante im Quelltext, weil sie sich nur
     * ändert, wenn die Klone ohnehin neu geladen werden.
     *
     * Der Rückseitenschnitt kommt aus seinem eigenen Baustein: `_klonAngleichen()`
     * meldet ihn über `applyBackFaceCulling()` an, und ohne ihn stünde der Klon
     * mit dem Z-Fighting doppelseitiger Wände im Bild.
     */
    _klonBausteinBauen: function (basis) {
      return {
        ordnung: 10,
        uniforms: {
          u_flach:   { type: Cesium.UniformType.FLOAT, value: this.flach * STAUCH_MAX },
          u_basisEC: { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3() },
          u_obenEC:  { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3(0, 0, 1) }
        },
        vertex: /* glsl */ `
          vec3 pEC = (czm_modelView * vec4(vsInput.attributes.positionMC, 1.0)).xyz;
          // h zählt ab dem Tile-Ursprung des KLONS — und der ist um denselben
          // Betrag angehoben wie die Geometrie. Die Differenz ist damit von der
          // Explosion unabhängig, und die Stauchebene bleibt dieselbe Zahl,
          // gleich wie weit der Stapel auseinandergezogen ist.
          float h = dot(pEC - u_basisEC, u_obenEC);
          vec3 obenMC = (czm_inverseModelView * vec4(u_obenEC, 0.0)).xyz;
          vsOutput.positionMC -= obenMC * ((h - ${basis.toFixed(3)}) * u_flach);
      `
      };
    },

    /**
     * Der Filter eines Geschosses als Style.
     *
     * Das unterste Geschoss bekommt nicht seine eigenen Namen, sondern die
     * Verneinung aller höheren. So bleibt alles sichtbar, was zu keinem
     * Geschoss gehört — Bauteile ohne Zuordnung, Geschosse ohne `Elevation`,
     * die Namen aus Hilfsebenen. Ohne diesen Kniff verschwände genau das, was
     * niemand vermisst, bis es fehlt: Fundamente, Gelände, Außenanlagen.
     *
     * Ein Style, den ein anderes Werkzeug am Original gesetzt hat, wird
     * mitgenommen: seine Einfärbung unverändert, seine Sichtbarkeit als
     * zusätzliche Bedingung. Sonst hübe die Explosion jeden Filter auf.
     */
    _stilFuer: function (gruppen, rang, alt) {
      var hoehere = [];
      gruppen.slice(1).forEach(function (g) { hoehere = hoehere.concat(g.namen); });

      var zeigen = rang === 0
        ? (hoehere.length ? '!(' + this._namenAusdruck(hoehere) + ')' : 'true')
        : this._namenAusdruck(gruppen[rang].namen);

      var vorher = alt && alt.style;
      if (vorher && typeof vorher.show === 'string') {
        zeigen = '(' + vorher.show + ') && (' + zeigen + ')';
      }

      var stil = { show: zeigen };
      // Die Einfärbung wird unverändert übernommen, gleich ob sie ein einzelner
      // Ausdruck oder eine Bedingungsliste ist. Nur die Sichtbarkeit muss ein
      // Ausdruck sein, damit sie sich mit dem Geschossfilter verbinden lässt;
      // eine Bedingungsliste bei `show` bleibt deshalb außen vor — der Klon
      // zeigt dann mehr als das Original, was besser ist als ein leeres Bild.
      if (vorher && vorher.color !== undefined) stil.color = vorher.color;
      return new Cesium.Cesium3DTileStyle(stil);
    },

    _namenAusdruck: function (namen) {
      return namen.map(function (name) {
        var text = String(name === null || name === undefined ? '' : name)
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\'");
        return "${Geschoss} === '" + text + "'";
      }).join(' || ');
    },

    /**
     * Die LOD-Einstellungen des Originals — ein Klon soll nicht gröber sein.
     *
     * Der Kachelspeicher wird dagegen geteilt: bekäme jeder Klon das volle
     * Budget des Originals, hielte die Szene bei fünf Geschossen das Fünffache
     * dessen vor, was dasselbe Modell ungeteilt braucht — genug, um einen
     * Browser umzuwerfen. Jeder Klon zeigt ohnehin nur ein Geschoss.
     */
    _ladeOptionen: function (vorlage, anzahl) {
      var voll = vorlage.cacheBytes || 536870912;
      var ueber = vorlage.maximumCacheOverflowBytes || 536870912;
      return {
        cacheBytes: Math.max(67108864, Math.floor(voll / Math.max(1, anzahl))),
        maximumCacheOverflowBytes: Math.max(33554432, Math.floor(ueber / Math.max(1, anzahl))),
        maximumScreenSpaceError: vorlage.maximumScreenSpaceError,
        skipLevelOfDetail: vorlage.skipLevelOfDetail,
        baseScreenSpaceError: vorlage.baseScreenSpaceError,
        skipScreenSpaceErrorFactor: vorlage.skipScreenSpaceErrorFactor,
        skipLevels: vorlage.skipLevels,
        immediatelyLoadDesiredLevelOfDetail: vorlage.immediatelyLoadDesiredLevelOfDetail,
        loadSiblings: vorlage.loadSiblings,
        cullWithChildrenBounds: vorlage.cullWithChildrenBounds
      };
    },

    /** Beleuchtung und Darstellung wie beim Original — sonst leuchtet ein Geschoss anders. */
    _klonAngleichen: function (klon) {
      try {
        if (BimViewer.enableTilesetLighting) BimViewer.enableTilesetLighting(klon);
        if (BimViewer.applyBackFaceCulling) BimViewer.applyBackFaceCulling(klon);
        if (BimViewer._currentPerformanceSettings && BimViewer.applySettingsToTileset) {
          BimViewer.applySettingsToTileset(klon, BimViewer._currentPerformanceSettings);
        }
      } catch (e) {
        console.warn('explosion: Klon nicht angleichbar', e);
      }
    },

    /**
     * Jeden Klon auf seine Höhe setzen.
     *
     * Verschoben wird in Weltkoordinaten entlang der Hochachse des Modells —
     * nicht entlang der Ellipsoidnormalen: liegt das Bauwerk gekippt in der
     * Szene, soll die Explosion seiner eigenen Senkrechten folgen. Die
     * Verschiebung steht LINKS von der Modellmatrix des Originals, damit sie
     * dessen Platzierung ergänzt und nicht ersetzt (terrain-align.js rückt sie
     * nach, wenn das Gelände nachlädt).
     */
    _kloneLagen: function () {
      this.klonZiele.forEach(function (ziel) {
        var vorlage = ziel.asset.tileset;
        var nachEcef = vorlage.root && vorlage.root.computedTransform;
        if (!nachEcef) return;

        var obenWC = Cesium.Matrix4.multiplyByPointAsVector(nachEcef, Cesium.Cartesian3.UNIT_Z, _wc2);
        Cesium.Cartesian3.normalize(obenWC, obenWC);
        ziel.basisVorher = Cesium.Matrix4.clone(vorlage.modelMatrix, ziel.basisVorher);

        ziel.klone.forEach(function (k) {
          var hub = Cesium.Cartesian3.multiplyByScalar(obenWC, k.rang * this.abstand, _wc1);
          k.tileset.modelMatrix = Cesium.Matrix4.multiply(
            Cesium.Matrix4.fromTranslation(hub, _m1), vorlage.modelMatrix, new Cesium.Matrix4());
        }, this);
      }, this);
    },

    /**
     * Das Auge in der Modellliste soll auch während der Explosion wirken.
     *
     * `toggleAssetVisibility()` in core.js schaltet `asset.visible` und
     * `tileset.show` des Originals — und das Original ist während der
     * Explosion ohnehin unsichtbar. Ohne diesen Abgleich bliebe ein
     * ausgeblendetes Modell in seinen Klonen stehen, und das Auge täte
     * scheinbar nichts. Der gewünschte Zustand wird gleichzeitig in
     * `showVorher` festgehalten, damit das Ausschalten der Explosion die
     * inzwischen getroffene Wahl zurückgibt und nicht die von vorhin.
     */
    _sichtbarkeitSpiegeln: function () {
      this.klonZiele.forEach(function (ziel) {
        var sichtbar = ziel.asset.visible !== false;
        ziel.showVorher = sichtbar;
        ziel.klone.forEach(function (k) {
          if (k.tileset.show !== sichtbar) k.tileset.show = sichtbar;
        });
        if (ziel.asset.tileset.show) ziel.asset.tileset.show = false;
      });
    },

    _kloneAbbauen: function () {
      this.klonZiele.forEach(this._eintragAbbauen, this);
      this.klonZiele = [];
    },

    _eintragAbbauen: function (eintrag) {
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      eintrag.klone.forEach(function (k) {
        try { if (szene) szene.primitives.remove(k.tileset); } catch (e) { /* schon entladen */ }
      });
      eintrag.klone = [];
      try { eintrag.asset.tileset.show = eintrag.showVorher; } catch (e) { /* Modell ist fort */ }
    },

    // ── Entities: Konzept-Baukörper und Bauplaner-Bauteile ─────────────────

    /**
     * Die Hochachse des Rastersystems, in dem beide Werkzeuge zeichnen.
     *
     * Sie wird aus zwei Punkten des Bauplaner-Ursprungs abgeleitet statt aus
     * der Ellipsoidnormalen: so steht die Explosion auch dann senkrecht auf dem
     * Raster, wenn der Nutzer sein Modell irgendwo auf der Erde abgesetzt hat.
     */
    _hochachse: function () {
      if (!window.Bauplaner || !Bauplaner.hatUrsprung()) return null;
      var unten = Bauplaner.weltPunkt(0, 0, 0);
      var oben = Bauplaner.weltPunkt(0, 0, 1000);
      if (!unten || !oben) return null;
      return Cesium.Cartesian3.subtract(oben, unten, new Cesium.Cartesian3());
    },

    /**
     * Alle Entities beider Werkzeuge mit ihrem Geschossrang.
     *
     * Der Rang zählt von unten ab null — nicht der Geschossname, denn der ist
     * beim Bauplaner ein Index und beim Konzept ein Schlüssel („UG", „EG",
     * „1.OG"), und beide sagen für sich genommen nichts über die Reihenfolge.
     * Was die Reihenfolge sagt, ist die Höhe.
     */
    _entityZiele: function () {
      var liste = [];
      var v = BimViewer.viewer;
      if (!v) return liste;

      // 1 · Konzept-Baukörper
      var quelle = v.dataSources.getByName && v.dataSources.getByName('konzept-4d')[0];
      var zustand = window.Konzept4D && Konzept4D.zustand;
      if (quelle && zustand && zustand.koerper && zustand.koerper.length) {
        var nachId = {};
        var tiefste = {};
        zustand.koerper.forEach(function (k) {
          nachId[k.id] = k;
          if (!k.geschoss) return;
          if (tiefste[k.geschoss] === undefined || k.z < tiefste[k.geschoss]) {
            tiefste[k.geschoss] = k.z;
          }
        });
        var rang = this._raengeAus(tiefste);

        quelle.entities.values.forEach(function (e) {
          var k = nachId[e._konzept4d];
          // Baustelleneinrichtung — Kran, Bauzaun, Container, Baugrube — hat
          // kein Geschoss und bleibt stehen. Sie mit anzuheben hieße, den
          // Kran im dritten Obergeschoss schweben zu lassen.
          if (!k || !k.geschoss) return;
          liste.push({ entity: e, rang: rang[k.geschoss] || 0 });
        });
      }

      // 2 · Bauplaner-Bauteile
      var bp = window.Bauplaner && Bauplaner.zustand;
      if (bp && bp.bauteile && bp.geschosse) {
        var hoehen = {};
        bp.geschosse.forEach(function (g, i) { hoehen[i] = g.z; });
        var rangBp = this._raengeAus(hoehen);

        bp.bauteile.forEach(function (t) {
          if (!t.entity) return;
          liste.push({ entity: t.entity, rang: rangBp[t.geschoss] || 0 });
        });
      }

      return liste;
    },

    /** { schlüssel: höhe } → { schlüssel: rang von unten }. */
    _raengeAus: function (hoehen) {
      var rang = {};
      Object.keys(hoehen)
        .sort(function (a, b) { return hoehen[a] - hoehen[b]; })
        .forEach(function (key, i) { rang[key] = i; });
      return rang;
    },

    /**
     * Setzt jede Entity auf `Ausgangslage + Rang · Abstand`.
     *
     * Immer von der gemerkten Ausgangslage aus, nie um den letzten Schritt
     * weiter: sonst summierte sich jeder Reglerzug auf, und das Zurückstellen
     * fände nie wieder den Anfang.
     */
    _entitiesAnwenden: function () {
      var hoch = this._hochachse();
      var zeit = BimViewer.viewer && BimViewer.viewer.clock.currentTime;
      var abstand = this.abstand;

      this._entityZiele().forEach(function (z) {
        var e = z.entity;
        var meter = z.rang * abstand;

        // Decken und Platten aus dem Bauplaner sind ausgezogene Polygone —
        // ihre Höhe ist eine Zahl, keine Position.
        if (e.polygon && Cesium.defined(e.polygon.height)) {
          if (!e._explosionBasis) {
            e._explosionBasis = {
              h: e.polygon.height.getValue(zeit),
              eh: e.polygon.extrudedHeight ? e.polygon.extrudedHeight.getValue(zeit) : undefined
            };
          }
          e.polygon.height = e._explosionBasis.h + meter;
          if (e._explosionBasis.eh !== undefined) {
            e.polygon.extrudedHeight = e._explosionBasis.eh + meter;
          }
          return;
        }

        if (!e.position || !hoch) return;
        if (!e._explosionBasis) {
          e._explosionBasis = { p: Cesium.Cartesian3.clone(e.position.getValue(zeit)) };
        }
        if (!e._explosionBasis.p) return;
        e.position = Cesium.Cartesian3.add(
          e._explosionBasis.p,
          Cesium.Cartesian3.multiplyByScalar(hoch, meter, new Cesium.Cartesian3()),
          new Cesium.Cartesian3());
      });
    },

    _entitiesZuruecksetzen: function () {
      this._entityZiele().forEach(function (z) {
        var e = z.entity;
        if (!e._explosionBasis) return;
        if (e.polygon && e._explosionBasis.h !== undefined) {
          e.polygon.height = e._explosionBasis.h;
          if (e._explosionBasis.eh !== undefined) e.polygon.extrudedHeight = e._explosionBasis.eh;
        } else if (e._explosionBasis.p) {
          e.position = e._explosionBasis.p;
        }
        delete e._explosionBasis;
      });
    },

    // ── Wache ──────────────────────────────────────────────────────────────

    /**
     * Je Bild die Uniforms, alle zwanzig Bilder ein Blick auf die Entities.
     *
     * Der Bauplaner zeichnet ein Bauteil bei jeder Änderung neu — die neue
     * Entity kennt die Explosion dann nicht und stünde als einziges Bauteil an
     * seiner Rasterlage. Statt in bauplaner.js einzugreifen, wird hier
     * nachgesehen, ob unversetzte Entities dazugekommen sind. Zwanzig Bilder
     * sind ein Drittel Sekunde: schnell genug, dass es niemand bemerkt, und
     * selten genug, dass die Liste nicht sechzigmal je Sekunde entsteht.
     */
    _wacheStarten: function () {
      var self = this;
      this._wacheStoppen();
      this._wache = BimViewer.viewer.scene.preRender.addEventListener(function () {
        self._uniformsNachfuehren();

        if (++self._bild % 20) return;
        var offen = self._entityZiele().some(function (z) {
          return z.rang > 0 && !z.entity._explosionBasis;
        });
        if (offen) self._entitiesAnwenden();

        // terrain-align.js rückt Modelle nach, sobald das Gelände nachgeladen
        // ist. Die Klone hängen an der Modellmatrix des Originals und müssen
        // dann mit, sonst schwebt die Explosion neben dem Bauwerk.
        var gerueckt = self.klonZiele.some(function (z) {
          return !z.basisVorher ||
                 !Cesium.Matrix4.equals(z.basisVorher, z.asset.tileset.modelMatrix);
        });
        if (gerueckt) self._kloneLagen();

        self._sichtbarkeitSpiegeln();
      });
    },

    _wacheStoppen: function () {
      if (this._wache) { this._wache(); this._wache = null; }
    },

    // ── Anzeige ────────────────────────────────────────────────────────────

    _bericht: function () {
      var teile = this.klonZiele.map(function (z) {
        return z.name + ' — ' + z.gruppen.length + ' Geschosse (bauteilgenau)';
      });
      teile = teile.concat(this.ziele.map(function (z) {
        return z.name + ' — ' + (z.grenzen.length + 1) + ' Ebenen (' + z.quelle + ')';
      }));
      var entities = this._entityZiele().length;
      if (entities) teile.push(entities + ' Bauteile aus Bauplaner und Konzept');
      // Was NICHT mitfliegt, gehört genauso in die Rückmeldung: sonst sucht
      // man den Fehler bei sich, wenn ein Modell stehen bleibt.
      if (this.uebersprungen && this.uebersprungen.length) {
        teile.push('unverändert: ' + this.uebersprungen.join(', '));
      }
      return teile.length ? teile.join(' · ') : 'Kein Modell in der Szene, das sich teilen ließe.';
    },

    _melden: function (text, art) {
      var el = document.getElementById('explosionStatus');
      if (!el) return;
      el.textContent = text;
      // `.hint` kennt keine Zustandsvarianten — die Farbe kommt deshalb direkt
      // aus den Tokens des Design-Systems statt aus einer erfundenen Klasse.
      el.style.color = art === 'error' ? 'var(--ds-danger)'
                     : art === 'busy' ? 'var(--ds-warning)' : '';
      el.style.display = text ? '' : 'none';
    },

    _anzeige: function () {
      var schalter = document.getElementById('explosionAn');
      if (schalter) schalter.checked = this.aktiv;

      var regler = document.getElementById('explosionAbstand');
      if (regler) regler.value = this.abstand;

      var zahl = document.getElementById('explosionAbstandWert');
      if (zahl) zahl.value = this.abstand.toFixed(1);

      var prozent = Math.round(this.flach * 100);
      var flachRegler = document.getElementById('explosionFlach');
      if (flachRegler) flachRegler.value = prozent;

      var flachZahl = document.getElementById('explosionFlachWert');
      if (flachZahl) flachZahl.value = prozent;

      var raster = document.getElementById('explosionRaster');
      if (raster) raster.value = this.regelhoehe.toFixed(2);

      var fuge = document.getElementById('explosionFuge');
      if (fuge) fuge.value = this.fuge.toFixed(2);
    }
  };

  // ── Panel ────────────────────────────────────────────────────────────────

  /**
   * Die Explosion steht bei der Ansicht, nicht bei den Werkzeugen.
   *
   * Sie ändert nichts daran, *was* in der Szene liegt — nur daran, *wie* es
   * aussieht; nach demselben Maßstab sind vorher schon die Punktwolken dorthin
   * gezogen. Eingehängt wird per DOM statt in `ui.js`, damit dort nichts
   * angefasst werden muss (dasselbe Vorgehen wie beim Plan-Reiter).
   */
  function panelHtml() {
    return '' +
      '<div class="row">' +
        '<span class="row__label">Geschosse auseinanderziehen</span>' +
        '<label class="switch">' +
          '<input type="checkbox" id="explosionAn" onchange="BimViewer.Explosion.umschalten()">' +
          '<span class="switch__track"></span>' +
        '</label>' +
      '</div>' +

      '<div class="section">' +
        '<div class="section__label">Abstand je Geschoss</div>' +
        '<div class="slider-row">' +
          '<input type="range" class="slider" id="explosionAbstand" min="0" max="15" step="0.1" value="3"' +
                ' oninput="BimViewer.Explosion.abstandSetzen(this.value)">' +
          '<input type="number" class="input input--num" id="explosionAbstandWert" min="0" max="15" step="0.1" value="3.0"' +
                ' onchange="BimViewer.Explosion.abstandSetzen(this.value)">' +
          '<span class="unit">m</span>' +
        '</div>' +
      '</div>' +

      '<div class="section">' +
        '<div class="section__label">Auf eine Ebene stauchen</div>' +
        '<div class="slider-row">' +
          '<input type="range" class="slider" id="explosionFlach" min="0" max="100" step="1" value="0"' +
                ' oninput="BimViewer.Explosion.flachSetzen(this.value / 100)">' +
          '<input type="number" class="input input--num" id="explosionFlachWert" min="0" max="100" step="1" value="0"' +
                ' onchange="BimViewer.Explosion.flachSetzen(this.value / 100)">' +
          '<span class="unit">%</span>' +
        '</div>' +
        '<div class="hint">Drückt jedes Geschoss auf seine Fußbodenebene. Was dabei ' +
          'entsteht, ist eine Ansicht und kein Grundriss — eine Wand wird zum ' +
          'Vollrechteck ohne Türöffnung. Lesbare Grundrisse legt „Geschossgrundrisse" ' +
          'darunter in denselben Stapel.</div>' +
      '</div>' +

      '<details class="panel-group" id="group-explosionFein">' +
        '<summary class="panel-group__header"><span>Feineinstellung</span></summary>' +
        '<div class="panel-group__body">' +

          '<div class="field">' +
            '<label class="field__label" for="explosionFuge">Trennebene über Geschosshöhe</label>' +
            '<div class="slider-row">' +
              '<input type="number" class="input input--num" id="explosionFuge" min="0" max="1.5" step="0.05" value="0.15"' +
                    ' onchange="BimViewer.Explosion.fugeSetzen(this.value)">' +
              '<span class="unit">m</span>' +
            '</div>' +
            '<div class="hint">Liegt die Trennung genau auf der Geschosshöhe, wird die Rohdecke ' +
              'darunter mit auseinandergezogen. Ein Fußbodenaufbau Abstand darüber hält sie ' +
              'beim unteren Geschoss.</div>' +
          '</div>' +

          '<div class="field">' +
            '<label class="field__label" for="explosionRaster">Ersatz-Geschosshöhe</label>' +
            '<div class="slider-row">' +
              '<input type="number" class="input input--num" id="explosionRaster" min="1.5" max="12" step="0.25" value="3.00"' +
                    ' onchange="BimViewer.Explosion.regelhoeheSetzen(this.value)">' +
              '<span class="unit">m</span>' +
            '</div>' +
            '<div class="hint">Nur für Modelle ohne Geschossverzeichnis — Ion-Assets bringen ' +
              'keines mit. Modelle aus dem eigenen Backend werden nach ihren echten ' +
              'Geschosshöhen geteilt.</div>' +
          '</div>' +

          '<button class="btn btn--sm" onclick="BimViewer.Explosion.auffrischen()">' +
            'Neu einlesen</button>' +
        '</div>' +
      '</details>' +

      '<div class="hint" id="explosionStatus" style="display:none;"></div>';
  }

  function einhaengen() {
    var panel = document.querySelector('#section-view .section-scroll-content');
    if (!panel) return false;
    if (document.getElementById('group-explosion')) return true;

    var gruppe = document.createElement('details');
    gruppe.className = 'panel-group';
    gruppe.id = 'group-explosion';
    gruppe.innerHTML =
      '<summary class="panel-group__header"><span>Explosion</span></summary>' +
      '<div class="panel-group__body">' + panelHtml() + '</div>';

    // Hinter Kamera und Beleuchtung, vor den Punktwolken: die Explosion gehört
    // zu dem, was man am Bauwerk einstellt, nicht zu dem, was man an einer
    // Punktwolke einstellt.
    var punktwolken = document.getElementById('group-pointcloud');
    if (punktwolken) panel.insertBefore(gruppe, punktwolken);
    else panel.appendChild(gruppe);

    console.log('💥 Explosion eingehängt');
    return true;
  }

  // Das Panel entsteht erst, wenn ui.js die Aktivitätsleiste aufgebaut hat.
  var versuche = 0;
  var timer = setInterval(function () {
    if (einhaengen() || ++versuche > 30) clearInterval(timer);
  }, 400);

  console.log('💥 Explosion geladen');
})();
