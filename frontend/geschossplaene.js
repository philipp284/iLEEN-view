/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Licensed under BSL 1.1 (siehe clipping-planes.js).
 */

// ===============================
// GESCHOSSGRUNDRISSE — die Schnitte als Bild in den Stapel
//
// Die Explosionsansicht zieht das Bauwerk auseinander, und der Regler
// „Auf eine Ebene stauchen" drückt jedes Geschoss flach. Was dabei entsteht,
// sieht aus wie ein Grundriss und ist keiner: die Wand wird zum Vollrechteck
// ohne Türöffnung, Decke und Fußboden liegen deckungsgleich übereinander, und
// von oben sieht man die Deckenunterseite statt der Raumaufteilung.
//
// Ein *lesbarer* Grundriss entsteht nicht durch Zusammendrücken, sondern durch
// Schneiden. Genau das tut `POST /assets/{job}/section` ohnehin — es ist
// derselbe Aufruf, aus dem der Zeichenmodus seine Blätter bezieht. Dieses
// Modul holt ihn je Geschoss, malt die Figuren in ein Canvas und legt das Bild
// als waagerechte Fläche an die Stelle im Raum, an der das Geschoss steht.
//
// ## Warum ein Bild und nicht die Figuren selbst
//
// Ein Geschossgrundriss bringt leicht ein paar tausend Polygone mit. Als
// Cesium-Entities wären das ebenso viele Primitive je Geschoss, bei sechs
// Geschossen fünfstellig — die Szene bliebe stehen. Als Textur ist es ein
// einziges Rechteck, und die Auflösung wird an der Gebäudegröße bemessen
// statt an der Zahl der Bauteile.
//
// Der Preis ist die feste Auflösung: wer ganz nah heranfliegt, sieht Pixel.
// Für den Blick, aus dem man einen Geschossstapel ansieht, ist das kein
// Verlust — und wer die Linien scharf braucht, öffnet das Blatt: jedes hier
// geholte Geschoss wird zugleich als Zeichnung ins Planarchiv gelegt und ist
// dort vektoriell weiterzubearbeiten.
//
// ## Zwei Höhensysteme, und jede Zahl gehört in genau eines
//
// Das ist die Falle dieses Moduls. Sie hat beim Bauen zugeschlagen, und ihr
// Fehlerbild sieht wie ein Erfolg aus.
//
//   · **Schnitt-System** — `SectionRequest.center`, `/storeys`,
//     `plane_origin`. `georef.recenter()` stellt das Modell auf seine
//     Unterkante; Z = 0 ist der Modellfuß.
//   · **Render-System** — `root.computedTransform`, also die Matrix, mit der
//     Cesium das Tileset stellt. Der Octree zentriert das Modell noch einmal
//     auf seinen Wurzelknoten; Z = 0 liegt in der MITTE des Hüllkörpers.
//
// Die **Box** geht ans Backend und bleibt deshalb im Schnitt-System: die
// Geschosshöhe wird unverändert übernommen, genau wie in `plan-panel.js`. Die
// **Lage der Fläche in der Szene** wird dagegen ins Render-System umgerechnet
// (`hoehe + Explosion.hoehenspanne().unten`) — sonst schwebte der ganze Stapel
// um eine halbe Gebäudehöhe zu hoch. Es ist derselbe Versatz, an dem schon die
// Explosionsansicht hing, und er kommt aus derselben Quelle.
//
// Waagerecht sind beide Systeme gleich: beide zentrieren auf die XY-Mitte. Der
// Grundriss liegt waagerecht, seine 2D-Punkte sind deshalb unmittelbar die
// X/Y auf Höhe der Schnittebene — dieselbe Gleichsetzung, die `_to_geojson()`
// im Backend nutzt.
//
// Gelegt wird die Zeichnung **fünfzehn Zentimeter über** den Geschossfußboden
// (`UEBER_FUSSBODEN`). Auf dem Fußboden selbst deckt ein voll gestauchtes
// Geschoss sie zu — die Explosion lässt zwei Prozent Resthöhe stehen, und die
// liegen genau dort. Im Modellmaßstab sieht man den Aufschlag nicht, ohne ihn
// sieht man die Zeichnung nicht.
//
// Wer die Box im falschen System rechnet, bekommt kein Fehlerbild, sondern ein
// falsches Ergebnis: am geprüften Sechsgeschosser fielen die unteren drei
// Geschosse unter den Modellfuß und kamen leer zurück, die oberen drei
// lieferten Figuren — die des falschen Geschosses.
//
// ## Die Texturzuordnung
//
// Die Fläche ist ein `Primitive` mit zwei Dreiecken, deren vier Ecken ihre
// Texturkoordinaten selbst tragen:
//
//     (xmin, ymin) → st (0,0)        (xmax, ymin) → st (1,0)
//     (xmin, ymax) → st (0,1)        (xmax, ymax) → st (1,1)
//
// Cesium lädt Bilder mit `flipY`, t = 1 liegt also an der BILDOBERKANTE. Das
// Canvas wird passend dazu gemalt: Pixelzeile 0 ist die Kante mit dem
// GRÖSSTEN y, die letzte Zeile die mit dem kleinsten. Damit liegt Norden im
// Norden und der Grundriss nicht spiegelverkehrt über dem Bauwerk — was man
// einem symmetrischen Bürogrundriss erst ansieht, wenn jemand eine Tür sucht.
// Nachgeprüft wird es deshalb im Bild: tests/geschossplaene/test-browser.mjs
// legt vier verschieden gefärbte Quadranten über denselben Weg in die Szene
// und liest nach, welche Farbe im Norden ankommt.
//
// ## Warum ein Primitive und keine Entity
//
// Cesium zeichnet Entity-Geometrie mit einer `MaterialAppearance`, deren
// `flat` von außen nicht erreichbar ist — die Fläche bekommt damit einen
// Lambert-Term gegen den Sonnenstand. Bei tief stehender Sonne wird die
// Zeichnung fast schwarz (im Browser-Prüfstein gemessen: Kanalwerte um 30
// statt 255). Eine Zeichnung, deren Lesbarkeit an der Tageszeit der Szene
// hängt, ist kaputt; `flat: true` nimmt die Beleuchtung ganz heraus. Dass die
// Texturzuordnung dabei nachprüfbar wird statt aus Cesiums Plane-Geometrie zu
// stammen, ist der zweite Gewinn.
//
// ## Was das Modul nicht tut
//
// Es zeichnet keine Schraffuren. Ein Musterraster, das im Blatt eine
// Betonwand von einer Mauerwerkswand unterscheidet, ist auf einer Textur aus
// zwanzig Metern Entfernung Rauschen und kostet je Figur eine Füllung mit
// eigenem Muster. Schnittflächen werden deshalb einfarbig gefüllt,
// Ansichtskanten dünn gezeichnet — das ist die Information, die aus dieser
// Entfernung ankommt. Die vollständige Signatur steht im Blatt.
// ===============================
'use strict';

(function () {

  if (!window.BimViewer) {
    console.warn('geschossplaene.js: BimViewer nicht gefunden');
    return;
  }

  var QUELLE = 'geschossplaene';

  // Kantenlänge der Textur. 2048 ist die Grenze, die auch ältere Geräte sicher
  // beherrschen; darüber verweigern manche Treiber die Textur ganz, und das
  // Bild bliebe leer statt nur grob zu sein.
  var TEXTUR_MAX = 2048;

  // Unter dieser Auflösung lohnt der Aufwand nicht: eine 24er Wand wäre
  // schmaler als ein Bildpunkt und verschwände zwischen den Zeilen.
  var PX_JE_METER_MIN = 8;

  // Randstreifen um die Zeichnung, damit eine Außenwand nicht auf der
  // Texturkante klebt — dort schneidet die Filterung sie an.
  var RAND_PX = 8;

  // Wie weit die Zeichnung über dem Geschossfußboden schwebt.
  //
  // Nicht null, und das ist keine Feinheit: liegt sie exakt auf dem Fußboden,
  // deckt ein voll gestauchtes Geschoss sie zu. Die Explosion lässt beim
  // Stauchen zwei Prozent Resthöhe stehen (`STAUCH_MAX`) — bei einem
  // Dreimetergeschoss also sechs Zentimeter. Fünfzehn Zentimeter liegen sicher
  // darüber und sind im Modellmaßstab unsichtbar; es ist dasselbe Maß, das die
  // Explosion als Fugenmaß nimmt, und aus verwandtem Grund — ein
  // Fußbodenaufbau.
  var UEBER_FUSSBODEN = 0.15;

  var FARBEN = {
    schnitt:  '#2b2b2b',   // getroffene Bauteile: das Gerüst des Grundrisses
    kante:    '#1a1a1a',
    ansicht:  '#9aa0a6',   // was unter der Schnittebene liegt
    raum:     '#1d5c86',
    grund:    'rgba(255,255,255,0.86)'
  };

  BimViewer.Geschossplaene = {

    aktiv: false,

    /** Das Modell, dessen Geschosse im Stapel liegen. */
    jobId: null,
    modellname: '',

    /** { name, hoehe, hoeheTile, flaeche, plan, schluessel, bild } je Geschoss. */
    blaetter: [],

    /** Abstand zwischen zwei Grundrissen in Metern. */
    abstand: 3.0,

    /** Deckkraft der Bilder. */
    deckung: 1.0,

    /**
     * Läuft der Stapel mit der Explosionsansicht mit?
     *
     * Voreinstellung ja: wer beides einschaltet, will einen Stapel und nicht
     * zwei, die sich durchdringen. Wer die Grundrisse allein stehen lassen
     * will — etwa um sie über dem unveränderten Gebäude schweben zu lassen —,
     * löst die Kopplung.
     */
    gekoppelt: true,

    /** Schnitthöhe über dem Geschossfußboden. Der Regelwert jeder Bauzeichnung. */
    schnitthoehe: 1.2,

    /** Raumnamen und Flächen mitzeichnen. */
    mitRaeumen: true,

    _laeuft: false,
    _wache: null,

    // ── Schalten ───────────────────────────────────────────────────────────

    umschalten: function () {
      if (this.aktiv || this._laeuft) this.aus();
      else this.an();
    },

    /**
     * Holt die Grundrisse aller Geschosse und legt sie in die Szene.
     *
     * Nacheinander und nicht gleichzeitig: das Backend hat einen Worker, und
     * der erste Schnitt eines Modells baut das Elementverzeichnis auf. Sechs
     * parallele Anfragen würden dieselbe Arbeit sechsfach anstoßen und sich
     * gegenseitig ausbremsen.
     *
     * **Es dauert, und zwar spürbar.** Am geprüften Sechsgeschosser
     * (`240603_GoOP-ARC.ifc`, bis 2494 Bauteile je Geschoss) liegt ein
     * vollständiger Durchlauf im Bereich einer halben Stunde — je Geschoss ein
     * eigener Schnitt, und im Grundriss kommen die Räume als zweiter
     * Iteratorlauf dazu. Deshalb meldet jede Stufe ihren Fortschritt, statt
     * still zu rechnen: ein Werkzeug, das minutenlang nichts sagt, ist von
     * einem kaputten nicht zu unterscheiden. Wer es eilig hat, schaltet die
     * Raumbeschriftung ab.
     */
    an: async function () {
      if (this._laeuft) return;
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      if (!szene) return;

      var asset = this._modell();
      if (!asset) {
        this._melden('Kein Backend-Modell in der Szene — die Grundrisse kommen '
                   + 'aus dem Schnitt des Modells.', 'error');
        this._anzeige();
        return;
      }
      if (!BimViewer.getBackendUrl()) {
        this._melden('Ohne Backend gibt es keinen Schnitt.', 'error');
        this._anzeige();
        return;
      }

      this.aus();
      this._laeuft = true;
      this.jobId = asset.jobId;
      this.modellname = asset.name || '';
      this._anzeige();

      var gruppen;
      try {
        gruppen = await this._geschosse(asset);
      } catch (e) {
        this._laeuft = false;
        this._melden('Geschossverzeichnis nicht lesbar: ' + e.message, 'error');
        this._anzeige();
        return;
      }

      if (!gruppen || !gruppen.length) {
        this._laeuft = false;
        this._melden('Das Modell führt kein Geschoss mit Bauteilen.', 'error');
        this._anzeige();
        return;
      }

      var spanne = BimViewer.Explosion && BimViewer.Explosion.hoehenspanne(asset.tileset);
      var versatz = spanne ? spanne.unten : 0;

      this.aktiv = true;
      var fehler = [];

      for (var i = 0; i < gruppen.length && this._laeuft; i++) {
        var gruppe = gruppen[i];
        this._melden('Geschoss ' + (i + 1) + ' von ' + gruppen.length
                   + ' wird geschnitten — ' + gruppe.namen[0] + ' …', 'busy');
        try {
          var blatt = await this._geschossHolen(asset, gruppe, i, gruppen, versatz);
          if (blatt) this.blaetter.push(blatt);
          else fehler.push(gruppe.namen[0] + ' (keine Bauteile im Schnitt)');
        } catch (e) {
          console.warn('geschossplaene: ' + gruppe.namen[0] + ' fehlgeschlagen', e);
          fehler.push(gruppe.namen[0] + ' (' + e.message + ')');
        }
      }

      this._laeuft = false;
      if (!this.blaetter.length) {
        this.aktiv = false;
        this._melden('Kein Geschoss ergab eine Zeichnung. ' + fehler.join(', '), 'error');
        this._anzeige();
        return;
      }

      this._lagen();
      this._wacheStarten();
      this._anzeige();
      this._melden(this._bericht(fehler), '');
    },

    aus: function () {
      this._laeuft = false;
      this.aktiv = false;
      this._wacheStoppen();

      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      this.blaetter.forEach(function (blatt) {
        try { if (szene && blatt.flaeche) szene.primitives.remove(blatt.flaeche); }
        catch (e) { /* Szene ist schon fort */ }
      });
      this.blaetter = [];
      this._anzeige();
      this._melden('', '');
    },

    // ── Regler ─────────────────────────────────────────────────────────────

    abstandSetzen: function (meter) {
      this.abstand = Math.max(0, Math.min(30, parseFloat(meter) || 0));
      this._lagen();
      this._anzeige();
    },

    deckungSetzen: function (wert) {
      this.deckung = Math.max(0.1, Math.min(1, parseFloat(wert) || 1));
      var alpha = this.deckung;
      this.blaetter.forEach(function (blatt) {
        // Nur das Uniform, nicht das Material: ein neues `Material.fromType`
        // lädt die Textur ein weites Mal, und beim Ziehen am Regler wäre das
        // je Bild ein Bild von mehreren Megabyte.
        var material = blatt.flaeche && blatt.flaeche.appearance
                    && blatt.flaeche.appearance.material;
        if (material && material.uniforms) {
          material.uniforms.color = new Cesium.Color(1, 1, 1, alpha);
        }
      });
      this._anzeige();
    },

    kopplungSetzen: function (an) {
      this.gekoppelt = !!an;
      this._lagen();
      this._anzeige();
    },

    /**
     * Der wirksame Abstand.
     *
     * Bei Kopplung der der Explosion — sonst stünden die Grundrisse in einem
     * anderen Raster als die Geschosse, über denen sie liegen sollen, und der
     * Stapel liefe auseinander, sobald jemand den einen Regler bewegt.
     */
    _abstand: function () {
      if (this.gekoppelt && BimViewer.Explosion && BimViewer.Explosion.aktiv) {
        return BimViewer.Explosion.abstand;
      }
      return this.abstand;
    },

    // ── Das Modell ─────────────────────────────────────────────────────────

    /**
     * Das Modell, dessen Geschosse gezeigt werden.
     *
     * Ein bereits gewähltes bleibt gewählt, solange es in der Szene liegt;
     * sonst das erste sichtbare Backend-Modell. Punktwolken und Splats haben
     * keine Geschosse, GLB-Assets kein Backend-Verzeichnis.
     */
    _modell: function () {
      var gefunden = null;
      var bevorzugt = null;
      var self = this;
      if (!BimViewer.loadedAssets) return null;

      BimViewer.loadedAssets.forEach(function (asset) {
        if (!asset.jobId || !asset.tileset || !asset.tileset.root) return;
        if (asset.isPointCloud || asset.tileset._isGaussianSplat) return;
        if (asset.tileset._explosionKlonVon) return;
        if (asset.jobId === self.jobId) bevorzugt = asset;
        if (!gefunden && asset.visible !== false) gefunden = asset;
      });
      return bevorzugt || gefunden;
    },

    _geschosse: function (asset) {
      if (!BimViewer.Explosion) {
        return Promise.reject(new Error('explosion.js fehlt — dort liegt die Geschossaufbereitung'));
      }
      return BimViewer.Explosion.geschosse(asset.jobId);
    },

    // ── Ein Geschoss ───────────────────────────────────────────────────────

    /**
     * Schneidet ein Geschoss, malt das Bild und hängt es in die Szene.
     *
     * Gibt `null` zurück, wenn der Schnitt keine Figur trifft — das ist kein
     * Fehler, sondern kommt bei einer Hilfsebene oder einem Dachgeschoss ohne
     * aufgehende Bauteile vor.
     */
    _geschossHolen: async function (asset, gruppe, index, gruppen, versatz) {
      var box = this._ausschnitt(asset, gruppe, index, gruppen);
      var antwort = await fetch(BimViewer.getBackendUrl() + '/assets/' + asset.jobId + '/section', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          center: box.center,
          size: box.size,
          yaw: 0,
          mode: 'grundriss',
          cut_height: this.schnitthoehe,
          with_views: true,
          with_rooms: !!this.mitRaeumen
        })
      });
      if (!antwort.ok) throw new Error('HTTP ' + antwort.status);
      var plan = await antwort.json();
      if (!plan.figures || !plan.figures.length) return null;

      var bild = this._bildBauen(plan);
      if (!bild) return null;

      var name = gruppe.namen.join(' / ');
      var blatt = {
        name: name,
        hoehe: gruppe.hoehe,
        // Zwei Nullpunkte: /storeys zählt ab Modellunterkante, das Tile-System
        // ab dem Tile-Ursprung. Ohne diesen Versatz schwebt der ganze Stapel.
        hoeheTile: gruppe.hoehe + versatz,
        rang: index,
        plan: plan,
        bild: bild,
        asset: asset,
        flaeche: null,
        matrixVorher: null,
        schluessel: null
      };

      blatt.flaeche = this._flaecheAnlegen(asset, blatt);
      blatt.schluessel = await this._archivieren(asset, blatt);
      return blatt;
    },

    /**
     * Der Ausschnitt eines Geschosses — im **Schnitt-System** des Backends.
     *
     * Hier liegt die Falle dieses Moduls, und sie hat beim Bauen zugeschlagen:
     * es gibt **zwei** Höhensysteme, und jede Zahl gehört in genau eines.
     *
     *   · **Schnitt-System** — `SectionRequest.center`, `/storeys`,
     *     `plane_origin`. `georef.recenter()` stellt das Modell auf seine
     *     Unterkante, Z = 0 ist also der Modellfuß.
     *   · **Render-System** — `root.computedTransform`. Der Octree zentriert
     *     das Modell noch einmal auf seinen Wurzelknoten; Z = 0 liegt in der
     *     MITTE des Hüllkörpers.
     *
     * Die Box geht ans Backend und gehört damit ins Schnitt-System: die
     * Geschosshöhe wird unverändert übernommen, genau wie in `plan-panel.js`
     * (`zMitte = g.hoehe + zHoehe / 2`). Nur die *Lage der Fläche in der
     * Szene* (`blatt.hoeheTile`) wird auf das Render-System umgerechnet.
     *
     * Wer hier den Versatz addiert, bekommt ein Ergebnis, das nach Erfolg
     * aussieht: am geprüften Sechsgeschosser (Modellunterkante bei −12 im
     * Render-System) fielen die unteren drei Geschosse unter den Modellfuß und
     * kamen leer zurück — die oberen drei lieferten Figuren, aber die des
     * falschen Geschosses. „Aufsicht" schnitt im Erdgeschoss und brachte 2130
     * Figuren statt 68 mit. Eine Fehlermeldung gibt es dabei nirgends.
     *
     * Waagerecht wird das ganze Modell genommen (aus der Hüllkugel, mit
     * demselben Zuschlag wie plan-panel.js). Die XY-Mitte ist in beiden
     * Systemen dieselbe — beide zentrieren auf sie —, sie darf deshalb aus der
     * Render-Matrix kommen.
     *
     * Senkrecht reicht die Box vom Fußboden dieses Geschosses bis zum
     * nächsten. Die Box-Unterkante liegt damit genau auf dem Fußboden, und
     * `cut_height` zählt von dort — so ist die Schnitthöhe die, die auf jeder
     * Bauzeichnung steht, und nicht ein Maß über irgendeiner Kastenkante.
     */
    _ausschnitt: function (asset, gruppe, index, gruppen) {
      var tileset = asset.tileset;
      var nachEcef = tileset.root.computedTransform;
      var nachTile = Cesium.Matrix4.inverseTransformation(nachEcef, new Cesium.Matrix4());
      var kugel = tileset.boundingSphere;
      var mitte = Cesium.Matrix4.multiplyByPoint(nachTile, kugel.center, new Cesium.Cartesian3());

      var naechstes = gruppen[index + 1];
      var hoch = naechstes ? Math.max(naechstes.hoehe - gruppe.hoehe, 0.5) : 3.5;

      return {
        // Ohne Versatz — siehe oben. Die Höhe kommt aus `/storeys` und geht
        // in dasselbe System zurück, aus dem sie stammt.
        center: [mitte.x, mitte.y, gruppe.hoehe + hoch / 2],
        size: [kugel.radius * 2.2, kugel.radius * 2.2, hoch]
      };
    },

    // ── Das Bild ───────────────────────────────────────────────────────────

    /**
     * Malt die Figuren eines Plans in ein Canvas.
     *
     * Gibt `{ url, breite, hoehe, bounds }` zurück — `bounds` ist dabei der
     * Bereich, den das Bild wirklich abdeckt, einschließlich des Randstreifens.
     * Ohne ihn läge die Außenwand auf der Texturkante, wo die Filterung sie
     * anschneidet.
     */
    _bildBauen: function (plan) {
      var b = plan.bounds;
      var breiteM = b[2] - b[0];
      var hoeheM = b[3] - b[1];
      if (!(breiteM > 0) || !(hoeheM > 0)) return null;

      // Die längere Kante bestimmt die Auflösung, damit ein langgestrecktes
      // Gebäude nicht in der Breite ausfranst.
      var lang = Math.max(breiteM, hoeheM);
      var pxJeMeter = (TEXTUR_MAX - 2 * RAND_PX) / lang;
      if (pxJeMeter < PX_JE_METER_MIN) pxJeMeter = PX_JE_METER_MIN;

      var w = Math.max(16, Math.round(breiteM * pxJeMeter) + 2 * RAND_PX);
      var h = Math.max(16, Math.round(hoeheM * pxJeMeter) + 2 * RAND_PX);

      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      if (!ctx) return null;

      ctx.fillStyle = FARBEN.grund;
      ctx.fillRect(0, 0, w, h);

      var randM = RAND_PX / pxJeMeter;
      var rahmen = [b[0] - randM, b[1] - randM, b[2] + randM, b[3] + randM];

      // Zeichenkoordinate → Bildpunkt. Y kehrt sich um: in der Zeichnung
      // wächst Nord nach oben, im Bild nach unten. Genau diese Umkehr ist es,
      // die den Grundriss unter der Textur richtig herum liegen lässt (siehe
      // Kopf, „Die Texturzuordnung").
      var px = function (x) { return (x - rahmen[0]) * pxJeMeter; };
      var py = function (y) { return (rahmen[3] - y) * pxJeMeter; };

      var strich = Math.max(1, pxJeMeter * 0.02);   // 2 cm Strichstärke

      // Erst die Ansichtskanten: sie liegen unter den Schnittfiguren, sonst
      // überdeckt eine dünne Umrisslinie die Fläche der Wand darüber —
      // dieselbe Reihenfolge wie in plan-2d.js.
      this._figurenMalen(ctx, plan.figures, 'ansicht', px, py, strich);
      this._figurenMalen(ctx, plan.figures, 'schnitt', px, py, strich);

      if (this.mitRaeumen && plan.rooms && plan.rooms.length) {
        this._raeumeMalen(ctx, plan.rooms, px, py, pxJeMeter);
      }

      return {
        url: canvas.toDataURL('image/png'),
        breite: rahmen[2] - rahmen[0],
        hoehe: rahmen[3] - rahmen[1],
        mitteX: (rahmen[0] + rahmen[2]) / 2,
        mitteY: (rahmen[1] + rahmen[3]) / 2,
        bounds: rahmen,
        pxJeMeter: pxJeMeter,
        pixel: [w, h]
      };
    },

    _figurenMalen: function (ctx, figuren, art, px, py, strich) {
      var schnitt = art === 'schnitt';
      ctx.lineJoin = 'round';
      ctx.fillStyle = FARBEN.schnitt;
      ctx.strokeStyle = schnitt ? FARBEN.kante : FARBEN.ansicht;
      ctx.lineWidth = schnitt ? strich : Math.max(0.75, strich * 0.5);

      for (var i = 0; i < figuren.length; i++) {
        var figur = figuren[i];
        var istAnsicht = figur.kind === 'ansicht';
        if (schnitt === istAnsicht) continue;

        ctx.beginPath();
        for (var r = 0; r < figur.rings.length; r++) {
          var ring = figur.rings[r];
          if (ring.length < 3) continue;
          for (var j = 0; j < ring.length; j++) {
            var x = px(ring[j][0]), y = py(ring[j][1]);
            if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
        }
        // Die Ringe einer Figur werden in EINEM Pfad gefüllt: `evenodd` macht
        // aus dem inneren Ring einer umlaufenden Wand ein Loch. Getrennt
        // gefüllt stünde dort eine massive Scheibe, und aus jedem Raum würde
        // eine Betonfläche.
        if (schnitt) ctx.fill('evenodd');
        ctx.stroke();
      }
    },

    /**
     * Raumname und Fläche an den Ankerpunkt.
     *
     * Der Anker kommt aus dem Backend (`polylabel`, nicht der Schwerpunkt) und
     * liegt damit auch bei einem L-förmigen Raum im Raum und nicht in der
     * Kerbe daneben. Beschriftet wird nur, was bei dieser Auflösung noch
     * lesbar ankommt — eine Schrift unter acht Bildpunkten ist ein grauer
     * Fleck, der die Zeichnung zudeckt, statt sie zu erklären.
     */
    _raeumeMalen: function (ctx, raeume, px, py, pxJeMeter) {
      var schrift = Math.max(9, pxJeMeter * 0.32);   // rund 32 cm hohe Schrift
      if (schrift < 9) return;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = FARBEN.raum;

      for (var i = 0; i < raeume.length; i++) {
        var raum = raeume[i];
        if (!raum.anchor) continue;
        var x = px(raum.anchor[0]), y = py(raum.anchor[1]);

        var titel = raum.long_name || raum.name || '';
        if (!titel) continue;

        // Ein Raum, der schmaler ist als seine Beschriftung, bekommt keine —
        // sie ragte sonst über die Wände in die Nachbarräume.
        ctx.font = '600 ' + schrift.toFixed(1) + 'px system-ui, sans-serif';
        var breite = ctx.measureText(titel).width;
        var platz = Math.sqrt(Math.max(raum.area || 0, 0)) * pxJeMeter;
        if (breite > platz * 1.1) continue;

        ctx.fillText(titel, x, y);
        if (raum.area > 0) {
          ctx.font = (schrift * 0.8).toFixed(1) + 'px system-ui, sans-serif';
          ctx.fillText(raum.area.toFixed(1) + ' m²', x, y + schrift * 1.05);
        }
      }
    },

    // ── Die Fläche in der Szene ────────────────────────────────────────────

    /**
     * Legt das Bild als waagerechte Fläche an seine Stelle im Raum.
     *
     * Ein `Primitive` mit eigener Geometrie und nicht eine Entity mit
     * `plane` — aus zwei Gründen, und der erste wiegt schwerer:
     *
     * **Ein Grundriss darf nicht beleuchtet werden.** Cesium zeichnet
     * Entity-Geometrie mit einer `MaterialAppearance`, deren `flat` nicht
     * erreichbar ist; die Fläche bekommt damit einen Lambert-Term gegen den
     * Sonnenstand. Bei tief stehender Sonne wird die Zeichnung fast schwarz —
     * gemessen im Browser-Prüfstein Kanalwerte um 30 statt 255. Eine
     * Zeichnung, deren Lesbarkeit an der Tageszeit der Szene hängt, ist
     * kaputt. `MaterialAppearance` mit `flat: true` nimmt die Beleuchtung
     * ganz heraus.
     *
     * **Und die Texturzuordnung wird dadurch nachprüfbar.** Die vier Ecken
     * tragen ihre `st` selbst, statt sie von Cesiums Plane-Geometrie zu erben:
     *
     *     (xmin, ymin) → st (0,0)        (xmax, ymin) → st (1,0)
     *     (xmin, ymax) → st (0,1)        (xmax, ymax) → st (1,1)
     *
     * Cesium lädt Bilder mit `flipY`, t = 1 liegt also an der Bildoberkante —
     * und die malt `_bildBauen()` mit dem größten y. Damit liegt Norden im
     * Norden. Nachgeprüft in tests/geschossplaene/test-browser.mjs, und dort
     * auch der Grund, warum es nachgeprüft gehört: an einem symmetrischen
     * Grundriss sieht man eine Spiegelung erst, wenn jemand eine Tür sucht.
     */
    _flaecheAnlegen: function (asset, blatt) {
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      var nachEcef = asset.tileset && asset.tileset.root && asset.tileset.root.computedTransform;
      if (!szene || !nachEcef) return null;

      var ecken = this._ecken(nachEcef, blatt);
      var werte = [];
      ecken.forEach(function (e) { werte.push(e.x, e.y, e.z); });

      // Die Hochachse des Modells, für jede Ecke dieselbe. `flat: true`
      // wertet sie nicht aus — der Vertexformat von `MaterialAppearance`
      // verlangt sie trotzdem, und eine fehlende Normale ist ein leeres
      // Attribut statt einer Fehlermeldung.
      var oben = Cesium.Matrix4.multiplyByPointAsVector(
        nachEcef, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(oben, oben);
      var normalen = [];
      for (var i = 0; i < 4; i++) normalen.push(oben.x, oben.y, oben.z);

      var geometrie = new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array(werte)
          }),
          normal: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            values: new Float32Array(normalen)
          }),
          st: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 2,
            values: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
          })
        },
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: Cesium.BoundingSphere.fromPoints(ecken)
      });

      var primitive = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry: geometrie }),
        appearance: new Cesium.MaterialAppearance({
          material: this._material(blatt),
          // Kein Licht auf einer Zeichnung — siehe oben.
          flat: true,
          faceForward: false,
          translucent: true,
          closed: false
        }),
        // Ohne Warten: die Fläche ist ein Rechteck, und der Umweg über den
        // Arbeitsthread kostet mehr, als er bei zwei Dreiecken spart.
        asynchronous: false,
        // Ein Grundriss ist eine Auflage über dem Bauwerk. Finge er die Klicks
        // ab, käme man an kein Bauteil mehr heran, über dem er liegt.
        allowPicking: false
      });
      primitive._geschossplan = blatt;
      szene.primitives.add(primitive);
      return primitive;
    },

    /**
     * Die vier Ecken der Zeichnung in Weltkoordinaten, gegen den Uhrzeigersinn
     * von Südwest — dieselbe Reihenfolge wie die `st` oben.
     *
     * Der Stapelversatz steckt NICHT darin: er läuft über `modelMatrix`, damit
     * der Regler nichts neu bauen muss.
     */
    _ecken: function (nachEcef, blatt) {
      var b = blatt.bild.bounds;
      // Der Aufschlag steht hier und nicht in `hoeheTile`: dort ist die
      // Geschosshöhe gemeint, hier die Lage der Zeichnung darüber. In einem
      // Feld vermischt wäre beim nächsten Lesen nicht mehr zu erkennen, was
      // gemessen und was zugegeben ist.
      var z = blatt.hoeheTile + UEBER_FUSSBODEN;
      var lokal = [
        new Cesium.Cartesian3(b[0], b[1], z),
        new Cesium.Cartesian3(b[2], b[1], z),
        new Cesium.Cartesian3(b[2], b[3], z),
        new Cesium.Cartesian3(b[0], b[3], z)
      ];
      return lokal.map(function (p) {
        return Cesium.Matrix4.multiplyByPoint(nachEcef, p, new Cesium.Cartesian3());
      });
    },

    _material: function (blatt) {
      var material = Cesium.Material.fromType('Image', { image: blatt.bild.url });
      material.uniforms.color = new Cesium.Color(1, 1, 1, this.deckung);
      return material;
    },

    /**
     * Der Stapelversatz eines Blattes als Verschiebung in Weltkoordinaten.
     *
     * Angehoben wird entlang der Hochachse des MODELLS, nicht entlang der
     * Ellipsoidnormalen: liegt das Bauwerk gekippt in der Szene, folgt der
     * Stapel seiner eigenen Senkrechten — dieselbe Festlegung wie in
     * explosion.js `_kloneLagen()`.
     */
    _versatz: function (asset, blatt, ergebnis) {
      var m = ergebnis || new Cesium.Matrix4();
      var nachEcef = asset.tileset && asset.tileset.root && asset.tileset.root.computedTransform;
      var hub = blatt.rang * this._abstand();
      if (!nachEcef || !hub) return Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY, m);

      var oben = Cesium.Matrix4.multiplyByPointAsVector(
        nachEcef, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(oben, oben);
      return Cesium.Matrix4.fromTranslation(
        Cesium.Cartesian3.multiplyByScalar(oben, hub, oben), m);
    },

    /**
     * Zieht die Höhen nach.
     *
     * Der Stapelversatz sitzt in der `modelMatrix` des Primitives: der Regler
     * schreibt damit eine Matrix und baut keine Geometrie neu.
     *
     * Die Ecken selbst stecken dagegen als Weltkoordinaten in der Geometrie.
     * Ändert sich die Matrix des Tilesets — `terrain-align.js` rückt Modelle
     * nach, sobald das Gelände geladen ist, und `z-offset.js` bei jedem
     * Handgriff am Höhenregler —, dann stimmen sie nicht mehr und die Fläche
     * bleibt neben dem Bauwerk stehen. Dann, und nur dann, wird die Fläche neu
     * gebaut; das ist ein seltener Fall, und ihn bei jedem Reglerzug
     * mitzumachen wäre je Geschoss eine neue Textur.
     */
    _lagen: function () {
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      var self = this;

      this.blaetter.forEach(function (blatt) {
        if (!blatt.flaeche) return;
        var nachEcef = blatt.asset.tileset && blatt.asset.tileset.root
                    && blatt.asset.tileset.root.computedTransform;

        if (nachEcef && blatt.matrixVorher &&
            !Cesium.Matrix4.equals(blatt.matrixVorher, nachEcef)) {
          try { if (szene) szene.primitives.remove(blatt.flaeche); }
          catch (e) { /* schon fort */ }
          blatt.flaeche = self._flaecheAnlegen(blatt.asset, blatt);
          if (!blatt.flaeche) return;
        }
        if (nachEcef) blatt.matrixVorher = Cesium.Matrix4.clone(nachEcef, blatt.matrixVorher);

        blatt.flaeche.modelMatrix = self._versatz(blatt.asset, blatt, blatt.flaeche.modelMatrix);
      });
    },

    // ── Archiv ─────────────────────────────────────────────────────────────

    /**
     * Legt den Schnitt zugleich als Blatt ins Planarchiv.
     *
     * Das ist kein Nebenprodukt, sondern der halbe Zweck: die Textur ist zum
     * Ansehen da, das Blatt zum Weiterarbeiten. Der Schlüssel ist derselbe,
     * den `Plan2D.open()` bildet — damit findet dieselbe Zeichnung ihren
     * Zustand wieder und lässt sich aus dem Planbrowser heraus öffnen, ohne
     * dass das Backend ein zweites Mal schneiden muss.
     *
     * Ohne SVG-Abzug: den schreibt erst das Schließen des Zeichenmodus. Der
     * Planbrowser zeichnet seine Vorschau ohnehin aus `drawing.figures`.
     */
    _archivieren: async function (asset, blatt) {
      if (!BimViewer.PlanStore || !BimViewer.PlanStore.verfuegbar()) return null;

      var titel = 'Grundriss ' + blatt.name + ' — ' + (asset.name || 'Modell');
      var schluessel = [blatt.plan.job_id, blatt.plan.mode, titel].join('|');
      try {
        await BimViewer.PlanStore.speichern({
          schluessel: schluessel,
          titel: titel,
          modell: asset.name || '',
          jobId: blatt.plan.job_id,
          mode: blatt.plan.mode,
          ansicht: 'aufsicht',
          massstab: this._passenderMassstab(blatt.plan.bounds),
          art: 'grundriss',
          geschoss: blatt.name,
          lauf: null,
          herkunft: QUELLE,
          drawing: blatt.plan,
          annot: null,
          svg: ''
        });
        return schluessel;
      } catch (e) {
        console.warn('geschossplaene: Blatt nicht archivierbar', e);
        return null;
      }
    },

    /**
     * Derselbe Maßstab, den `Plan2D` wählen würde.
     *
     * Nachgebildet statt aufgerufen: `_passenderMassstab()` dort ist an eine
     * geöffnete Zeichnung gebunden, und die gibt es hier nicht — das Blatt
     * geht ungeöffnet ins Archiv.
     */
    _passenderMassstab: function (bounds) {
      var breite = ((bounds[2] - bounds[0]) || 1) * 1000;
      var hoehe = ((bounds[3] - bounds[1]) || 1) * 1000;
      var stufen = [5, 10, 20, 25, 50, 100, 200, 500];
      for (var i = 0; i < stufen.length; i++) {
        if (breite / stufen[i] <= 811 && hoehe / stufen[i] <= 564) return stufen[i];
      }
      return stufen[stufen.length - 1];
    },

    /** Öffnet ein Geschoss im Zeichenmodus. */
    blattOeffnen: async function (index) {
      var blatt = this.blaetter[index];
      if (!blatt || !BimViewer.Plan2D) return;
      var vorlage = blatt.schluessel && BimViewer.PlanStore
        ? await BimViewer.PlanStore.laden(blatt.schluessel) : null;
      BimViewer.Plan2D.modell = this.modellname;
      await BimViewer.Plan2D.open(blatt.plan,
        'Grundriss ' + blatt.name + ' — ' + (this.modellname || 'Modell'), vorlage);
    },

    // ── Wache ──────────────────────────────────────────────────────────────

    /**
     * Der Stapel folgt der Explosion.
     *
     * Wer am Explosionsregler zieht, während die Grundrisse liegen, erwartet
     * dass sie mitgehen. Ein Ereignis dafür gibt es nicht, also wird alle
     * zwanzig Bilder nachgesehen — dieselbe Frequenz und dieselbe Begründung
     * wie bei der Nachzügler-Wache in explosion.js.
     */
    _wacheStarten: function () {
      var self = this;
      this._wacheStoppen();
      var bild = 0;
      var zuletzt = null;
      this._wache = BimViewer.viewer.scene.preRender.addEventListener(function () {
        if (++bild % 20) return;
        var jetzt = self._abstand();
        if (jetzt === zuletzt) return;
        zuletzt = jetzt;
        self._lagen();
        self._anzeige();
      });
    },

    _wacheStoppen: function () {
      if (this._wache) { this._wache(); this._wache = null; }
    },

    // ── Anzeige ────────────────────────────────────────────────────────────

    _bericht: function (fehler) {
      var teile = [this.blaetter.length + ' Geschosse geschnitten'];
      if (this.blaetter.some(function (b) { return b.schluessel; })) {
        teile.push('als Blätter im Planarchiv');
      }
      if (fehler && fehler.length) teile.push('ohne Zeichnung: ' + fehler.join(', '));
      return teile.join(' · ');
    },

    _melden: function (text, art) {
      var el = document.getElementById('geschossplaeneStatus');
      if (!el) return;
      el.textContent = text;
      el.style.color = art === 'error' ? 'var(--ds-danger)'
                     : art === 'busy' ? 'var(--ds-warning)' : '';
      el.style.display = text ? '' : 'none';
    },

    _anzeige: function () {
      var schalter = document.getElementById('geschossplaeneAn');
      if (schalter) schalter.checked = this.aktiv || this._laeuft;

      var koppel = document.getElementById('geschossplaeneKoppeln');
      if (koppel) koppel.checked = this.gekoppelt;

      var regler = document.getElementById('geschossplaeneAbstand');
      if (regler) {
        regler.value = this.abstand;
        regler.disabled = this.gekoppelt && BimViewer.Explosion && BimViewer.Explosion.aktiv;
      }

      var zahl = document.getElementById('geschossplaeneAbstandWert');
      if (zahl) zahl.value = this._abstand().toFixed(1);

      var deckung = document.getElementById('geschossplaeneDeckung');
      if (deckung) deckung.value = Math.round(this.deckung * 100);

      var hoehe = document.getElementById('geschossplaeneSchnitthoehe');
      if (hoehe) hoehe.value = this.schnitthoehe.toFixed(2);

      var raeume = document.getElementById('geschossplaeneRaeume');
      if (raeume) raeume.checked = this.mitRaeumen;

      this._listeZeichnen();
    },

    _listeZeichnen: function () {
      var liste = document.getElementById('geschossplaeneListe');
      if (!liste) return;

      if (!this.blaetter.length) {
        liste.innerHTML = '';
        liste.style.display = 'none';
        return;
      }

      liste.style.display = '';
      // Von oben nach unten, wie im Bauwerk: das oberste Geschoss steht oben.
      var reihen = this.blaetter.slice().sort(function (a, b) { return b.hoehe - a.hoehe; });
      liste.innerHTML = reihen.map(function (blatt) {
        var i = this.blaetter.indexOf(blatt);
        return '<div class="row">' +
                 '<span class="row__label" title="' + esc(blatt.name) + '">' +
                   esc(blatt.name) + ' · ' + blatt.plan.figures.length + ' Figuren</span>' +
                 '<button class="btn btn--sm" title="Als Blatt im Zeichenmodus öffnen"' +
                        ' onclick="BimViewer.Geschossplaene.blattOeffnen(' + i + ')">📐</button>' +
               '</div>';
      }, this).join('');
    },

    schnitthoeheSetzen: function (meter) {
      this.schnitthoehe = Math.max(0.1, Math.min(3, parseFloat(meter) || 1.2));
      this._anzeige();
    },

    raeumeSetzen: function (an) {
      this.mitRaeumen = !!an;
      this._anzeige();
    }
  };

  /** Bauteil- und Raumnamen kommen aus dem IFC und sind damit fremder Text. */
  function esc(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Panel ────────────────────────────────────────────────────────────────
  //
  // Direkt unter der Explosion, weil beide dieselbe Frage beantworten — wie
  // sehe ich in alle Geschosse zugleich hinein — und der Stapel nur dort
  // zusammenpasst, wo auch der Abstand eingestellt wird.

  function panelHtml() {
    return '' +
      '<div class="row">' +
        '<span class="row__label">Grundrisse in die Szene legen</span>' +
        '<label class="switch">' +
          '<input type="checkbox" id="geschossplaeneAn"' +
                ' onchange="BimViewer.Geschossplaene.umschalten()">' +
          '<span class="switch__track"></span>' +
        '</label>' +
      '</div>' +
      '<div class="hint">Schneidet jedes Geschoss im Backend und legt die Zeichnung ' +
        'als Bild an ihre Stelle im Bauwerk. Jedes Geschoss wird dabei zugleich ' +
        'als Blatt im Planarchiv abgelegt. <b>Das dauert:</b> je Geschoss ein ' +
        'Schnitt, bei einem großen Modell mehrere Minuten — der Fortschritt steht ' +
        'unten. Beim zweiten Mal geht es schnell, dann liegt der Schnitt im ' +
        'Zwischenspeicher des Backends.</div>' +

      '<div class="row">' +
        '<span class="row__label">Abstand der Explosion übernehmen</span>' +
        '<label class="switch">' +
          '<input type="checkbox" id="geschossplaeneKoppeln" checked' +
                ' onchange="BimViewer.Geschossplaene.kopplungSetzen(this.checked)">' +
          '<span class="switch__track"></span>' +
        '</label>' +
      '</div>' +

      '<div class="section">' +
        '<div class="section__label">Abstand je Geschoss</div>' +
        '<div class="slider-row">' +
          '<input type="range" class="slider" id="geschossplaeneAbstand" min="0" max="30" step="0.1" value="3"' +
                ' oninput="BimViewer.Geschossplaene.abstandSetzen(this.value)">' +
          '<input type="number" class="input input--num" id="geschossplaeneAbstandWert" min="0" max="30" step="0.1" value="3.0"' +
                ' onchange="BimViewer.Geschossplaene.abstandSetzen(this.value)">' +
          '<span class="unit">m</span>' +
        '</div>' +
      '</div>' +

      '<div class="section">' +
        '<div class="section__label">Deckkraft</div>' +
        '<div class="slider-row">' +
          '<input type="range" class="slider" id="geschossplaeneDeckung" min="10" max="100" step="5" value="100"' +
                ' oninput="BimViewer.Geschossplaene.deckungSetzen(this.value / 100)">' +
          '<span class="unit">%</span>' +
        '</div>' +
      '</div>' +

      '<div id="geschossplaeneListe" style="display:none;"></div>' +

      '<details class="panel-group" id="group-geschossplaeneFein">' +
        '<summary class="panel-group__header"><span>Feineinstellung</span></summary>' +
        '<div class="panel-group__body">' +

          '<div class="field">' +
            '<label class="field__label" for="geschossplaeneSchnitthoehe">Schnitthöhe über Fußboden</label>' +
            '<div class="slider-row">' +
              '<input type="number" class="input input--num" id="geschossplaeneSchnitthoehe" min="0.1" max="3" step="0.05" value="1.20"' +
                    ' onchange="BimViewer.Geschossplaene.schnitthoeheSetzen(this.value)">' +
              '<span class="unit">m</span>' +
            '</div>' +
            '<div class="hint">Der Regelwert einer Bauzeichnung. Höher geschnitten ' +
              'trifft man Oberlichter, tiefer die Brüstungen. Wirkt beim nächsten ' +
              'Einschalten.</div>' +
          '</div>' +

          '<div class="row">' +
            '<span class="row__label">Räume beschriften</span>' +
            '<label class="switch">' +
              '<input type="checkbox" id="geschossplaeneRaeume" checked' +
                    ' onchange="BimViewer.Geschossplaene.raeumeSetzen(this.checked)">' +
              '<span class="switch__track"></span>' +
            '</label>' +
          '</div>' +
          '<div class="hint">Kostet im Backend einen zweiten Durchgang durch das ' +
            'Modell. Führt die Datei keine IfcSpace, bleibt es ohne Wirkung.</div>' +

        '</div>' +
      '</details>' +

      '<div class="hint" id="geschossplaeneStatus" style="display:none;"></div>';
  }

  function einhaengen() {
    var panel = document.querySelector('#section-view .section-scroll-content');
    if (!panel) return false;
    if (document.getElementById('group-geschossplaene')) return true;

    var gruppe = document.createElement('details');
    gruppe.className = 'panel-group';
    gruppe.id = 'group-geschossplaene';
    gruppe.innerHTML =
      '<summary class="panel-group__header"><span>Geschossgrundrisse</span></summary>' +
      '<div class="panel-group__body">' + panelHtml() + '</div>';

    // Unmittelbar hinter die Explosion: die beiden gehören zusammen, und der
    // Kopplungsschalter wäre anderswo eine Frage ohne sichtbaren Bezug.
    var explosion = document.getElementById('group-explosion');
    if (explosion && explosion.parentNode === panel) {
      panel.insertBefore(gruppe, explosion.nextSibling);
    } else {
      var punktwolken = document.getElementById('group-pointcloud');
      if (punktwolken) panel.insertBefore(gruppe, punktwolken);
      else panel.appendChild(gruppe);
    }

    console.log('🗺 Geschossgrundrisse eingehängt');
    return true;
  }

  // Wie beim Explosionspanel: das Panel entsteht erst, wenn ui.js die
  // Aktivitätsleiste aufgebaut hat. Etwas länger als dort, weil es sich hinter
  // die Explosionsgruppe hängt und die zuerst da sein soll.
  var versuche = 0;
  var timer = setInterval(function () {
    if (einhaengen() || ++versuche > 40) clearInterval(timer);
  }, 400);

  // Für die Prüfung ohne Browser.
  BimViewer.Geschossplaene._internals = {
    panelHtml: panelHtml,
    einhaengen: einhaengen,
    esc: esc,
    TEXTUR_MAX: TEXTUR_MAX,
    RAND_PX: RAND_PX,
    PX_JE_METER_MIN: PX_JE_METER_MIN
  };

  console.log('🗺 Geschossgrundrisse geladen');
})();
