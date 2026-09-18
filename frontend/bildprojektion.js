/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Licensed under BSL 1.1 (siehe clipping-planes.js).
 */

// ===============================
// BILDPROJEKTION v1.0 — ein Bild auf die Flächen legen, statt davorzuhängen
//
// bildebenen.js hängt ein Bild als Rechteck IN den Raum: zwei Dreiecke,
// eben, mit einer Abhebung von zwei Zentimetern gegen das Z-Flimmern. Das
// ist richtig für einen Bestandsplan über einem Geschoss — und falsch,
// sobald das Bild auf ein Bauwerk gehört, das keine Ebene ist. Ein Foto
// einer Fassade mit Erker, Gesims und Fensterlaibung liegt dann sichtbar
// VOR dem Erker statt auf ihm.
//
// Hier wird dasselbe Bild stattdessen PROJIZIERT: jedes Fragment jedes
// Bauteils fragt selbst nach, ob es im Kegel der Bildebene liegt, und holt
// sich seine Farbe aus der Textur. Das Bild folgt damit jeder Unregelmäßig-
// keit der Geometrie, ohne dass diese eine Texturbelegung hätte — und IFC-
// Geometrie hat keine.
//
// ## Warum keine UV-Koordinaten
//
// Der übliche Weg, ein Bild auf ein Mesh zu bringen, führt über dessen
// Texturkoordinaten. Aus einem IFC-Export kommen keine: die Dreiecke einer
// Wand tragen Farbe und Normale, mehr nicht. Sie nachträglich zu erzeugen
// hieße, das Modell aufzuschneiden und abzuwickeln — eine Arbeit, die im
// Browser nicht hingehört und die jede Neuberechnung des Tilesets zunichte
// macht.
//
// Die Projektion braucht keine. Sie rechnet aus der POSITION des Fragments,
// und die hat jedes Dreieck.
//
// ## Die Rechnung, und warum sie in Augen-Koordinaten läuft
//
// Eine Bildebene ist ein Achsenkreuz: Mitte `m`, Rechtsachse `r`, Hochachse
// `o`, Normale `n`. Die Bildkoordinate eines Punktes `p` ist damit eine
// Frage von zwei Skalarprodukten:
//
//     uv = ( (p−m)·r / breite , (p−m)·o / höhe ) + ½
//     t  = (p−m)·n                                  ← Abstand zur Bildebene
//
// Der naheliegende Weg wäre, `p` über `czm_model` in ECEF zu holen. Er ist
// falsch, und zwar messbar: ECEF-Koordinaten liegen in der Größenordnung
// 6.378.000 m, und ein `float` im Shader hat rund sieben Stellen. Was davon
// für die Nachkommastellen übrigbleibt, sind Dezimeter — das Bild zittert
// beim Drehen der Kamera und steht bei jedem Bild anders.
//
// Gerechnet wird deshalb in Augen-Koordinaten, aus demselben Grund und auf
// demselben Weg wie in explosion.js: `czm_modelView` ist die Abbildung, die
// Cesium je Kachel kameranah aufbaut, die Zahlen darin sind klein, und die
// Lage der Bildebene wird auf der CPU (in `double`) einmal je Bild dorthin
// umgerechnet. `Matrix4.multiplyByPointAsVector` erhält dabei Längen, weil
// die Sichtmatrix nur dreht und verschiebt.
//
// ## Was die Projektion begrenzt — und warum sie das muss
//
// Eine Projektion ist ein Beamer ohne Wand: sie leuchtet weiter, und zwar
// durch das Bauteil hindurch auf alles, was dahinter liegt. Ein Fassaden-
// foto stünde damit auch auf der Rückwand des Zimmers dahinter. Zwei
// Filter halten das auf:
//
//   **Tiefenband** (`proj_tiefe`)   nur Flächen innerhalb ±t um die Bild-
//                                   ebene. Das ist der Regler, mit dem man
//                                   entscheidet, wie tief das Bild greift:
//                                   0,25 m fängt eine Fassade samt Laibung,
//                                   5 m einen ganzen Raum.
//   **Neigung** (`proj_winkel`)     nur Flächen, die annähernd parallel zur
//                                   Bildebene stehen. Der BETRAG des
//                                   Skalarprodukts, nicht sein Vorzeichen:
//                                   aus IFC kommen Wandflächen in beiden
//                                   Wicklungen, und eine falsch herum
//                                   modellierte Wand ist keine andere Wand.
//
// Beides zusammen ist kein Ersatz für eine echte Verdeckungsrechnung. Die
// bräuchte eine Tiefenkarte aus Sicht des Projektors, und die gibt Cesium
// aus einem `CustomShader` nicht heraus — sie wäre ein eigener Renderdurch-
// gang. Für den Zweck, um den es hier geht (ein Bild auf EIN Bauteil oder
// EINE Fassade zu legen), sind die beiden Filter genau richtig: sie sind
// erklärbar und einstellbar, wo eine Schattenrechnung eine Blackbox wäre.
//
// ## Parallel und perspektivisch
//
// Voreinstellung ist die PARALLELprojektion, und das ist keine Bequemlich-
// keit: ein Bauplan, eine Fassadenabwicklung, ein Orthofoto sind parallel
// aufgenommen. Sie perspektivisch aufzutragen verzerrte sie.
//
// Ein Handyfoto ist es nicht. Dafür gibt es `proj_abstand`: den Standort
// des Projektors auf der Normalen vor der Bildebene, also die Aufnahme-
// entfernung. Jedes Fragment wird dann längs seines Sehstrahls auf die
// Bildebene gezogen, bevor `uv` daraus wird — und ein Erker bekommt die
// Verkürzung, die er im Foto auch hat.
//
// ## Grenzen, die man kennen sollte
//
//   * **Vier auf einmal.** Jede Projektion belegt eine Textureinheit und
//     einen entrollten Block im Shader; Cesium braucht die übrigen selbst.
//     Mehr als `MAX` aktive Bilder werden nicht gezeichnet (die ältesten
//     gewinnen), statt dass der Shader stillschweigend nicht mehr übersetzt.
//   * **Übersichtsauflösung.** Ein gekachelter A0-Plan (bildebenen.js legt
//     ihn in bis zu 3×3 Texturen ab) geht hier als EIN Bild in die
//     Projektion, nämlich als die Übersicht. Neun Sampler für ein Blatt
//     wären das Budget aller vier Projektionen.
//   * **Punktwolken und Splats bleiben außen vor**, aus demselben Grund wie
//     bei der Explosion: ihr Inhalt läuft nicht über den Modell-Renderer.
//   * **Das Bild wird beleuchtet.** Es liegt auf dem Material des Bauteils
//     und bekommt dessen Sonnenstand und Schatten mit. Anders als beim
//     Rechteck aus bildebenen.js, das `flat: true` trägt — dort ist es eine
//     eigene Fläche, hier ist es die Oberfläche des Bauwerks.
// ===============================
'use strict';

(function () {

  if (!window.BimViewer) {
    console.warn('bildprojektion.js: BimViewer nicht gefunden');
    return;
  }

  /**
   * Wie viele Bilder gleichzeitig projiziert werden können.
   *
   * Die Grenze ist die Zahl der Textureinheiten im Fragment-Shader
   * (`MAX_TEXTURE_IMAGE_UNITS`, garantiert 16 in WebGL 2). Cesium belegt
   * davon selbst einen guten Teil: Basisfarbe, Normalen, Metallic-Roughness,
   * Emission und Okklusion des glTF-Materials, dazu IBL und Schattenkarten.
   * Vier ist der Rest, mit dem man sicher rechnen kann.
   */
  var MAX = 4;

  /** Tiefenband in Metern, wenn eine Ebene zum ersten Mal projiziert wird. */
  var TIEFE_STANDARD = 0.25;

  /**
   * Größte Neigung einer Fläche gegen die Bildebene, in Grad.
   *
   * 60° ist großzügig und soll es sein: eine Fensterlaibung steht rechtwinklig
   * zur Fassade und soll das Bild NICHT bekommen, ein handgemessener Erker
   * weicht aber leicht ab und soll es sehr wohl.
   */
  var WINKEL_STANDARD = 60;

  /** Weicher Bildrand, als Anteil der Bildbreite. */
  var RANDWEICH = 0.02;

  function C3(x, y, z) { return new Cesium.Cartesian3(x || 0, y || 0, z || 0); }

  var _ecP = new Cesium.Cartesian3();
  var _ecV = new Cesium.Cartesian3();
  var _wc = new Cesium.Cartesian3();

  BimViewer.Bildprojektion = {

    MAX: MAX,

    /** Die Ebenen, die gerade projiziert werden — in der Reihenfolge des Shaders. */
    _projektoren: [],
    /** Die Träger, auf denen der Baustein steht: Tilesets, GLB-Modelle, Klone. */
    _ziele: [],
    /** schluessel → Cesium.TextureUniform. Eine Textur je Bild, nicht je Ziel. */
    _texturen: {},
    _wache: null,
    _bild: 0,
    /** Woran erkannt wird, dass der Shader neu gebaut werden muss. */
    _signatur: '',

    // ── Schalter ───────────────────────────────────────────────────────────

    /** Läuft für diese Ebene gerade eine Projektion? */
    laeuft: function (ebene) {
      return !!(ebene && ebene.projektion);
    },

    /**
     * Schaltet die Projektion einer Bildebene ein oder aus.
     *
     * Das Rechteck verschwindet dabei: beides zugleich wäre dasselbe Bild
     * zweimal, einmal auf der Wand und einmal zwei Zentimeter davor, und die
     * beiden kämpften um dieselben Bildpunkte. `_nachziehen()` in
     * bildebenen.js nimmt die Fläche fort, sobald `ebene.projektion` steht.
     */
    umschalten: function (ebeneId, an) {
      var Bildebenen = BimViewer.Bildebenen;
      var ebene = Bildebenen && Bildebenen.finden(ebeneId);
      if (!ebene) return;

      ebene.projektion = an === undefined ? !ebene.projektion : !!an;
      if (ebene.projektion) {
        if (ebene.proj_tiefe === undefined) ebene.proj_tiefe = TIEFE_STANDARD;
        if (ebene.proj_winkel === undefined) ebene.proj_winkel = WINKEL_STANDARD;
        if (ebene.proj_abstand === undefined) ebene.proj_abstand = 0;
      }

      Bildebenen.sichern();
      Bildebenen._nachziehen(ebene, true);
      this.nachziehen();
      Bildebenen._listeZeichnen();
    },

    /** Ein Regler der Projektion. Kostet keinen Shader-Neubau, nur ein Uniform. */
    setzen: function (ebeneId, feld, wert) {
      var Bildebenen = BimViewer.Bildebenen;
      var ebene = Bildebenen && Bildebenen.finden(ebeneId);
      if (!ebene) return;
      wert = parseFloat(wert);
      if (!isFinite(wert)) return;

      ebene[feld] = wert;
      Bildebenen.sichern();
      this._uniformsNachfuehren();
      this._werteZeichnen(ebene);

      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      if (szene) szene.requestRender();
    },

    // ── Aufbau ─────────────────────────────────────────────────────────────

    /**
     * Bringt Bausteine und Ziele auf den Stand der Dinge.
     *
     * Wird bei jedem Handgriff gerufen und zusätzlich von der Wache, wenn
     * ein Modell dazugekommen oder die Explosion angelaufen ist. Der teure
     * Teil — das Übersetzen des Shaders — passiert nur, wenn sich die
     * SIGNATUR geändert hat: welche Bilder in welcher Reihenfolge projiziert
     * werden. Ein Reglerzug ändert sie nicht.
     */
    nachziehen: function () {
      var Bildebenen = BimViewer.Bildebenen;
      var verbund = BimViewer.ShaderVerbund;
      if (!Bildebenen || !verbund) return;

      var self = this;
      var gewuenscht = Bildebenen.ebenen.filter(function (e) {
        return e.projektion && e.sichtbar !== false && !e._fehlt;
      });

      // Ein Bild, dessen Daten noch in IndexedDB liegen, wird angestoßen und
      // kommt beim nächsten Durchgang der Wache dazu — nicht sofort, dafür
      // ohne dass hier eine Zusage auf eine Zusage wartet.
      var bereit = [];
      gewuenscht.forEach(function (ebene) {
        var textur = self._textur(ebene);
        if (textur) bereit.push({ ebene: ebene, textur: textur });
      });

      if (bereit.length > MAX) {
        var weg = bereit.slice(MAX).map(function (p) { return p.ebene.titel; });
        console.warn('bildprojektion: mehr als ' + MAX + ' Bilder — nicht gezeichnet: ' +
                     weg.join(', '));
        bereit = bereit.slice(0, MAX);
      }

      var ziele = this._zieleSammeln();
      var signatur = bereit.map(function (p) {
        return p.ebene.quelle.schluessel + ':' + p.ebene.quelle.index;
      }).join('|') + '#' + ziele.length;

      // Abgefallene Ziele räumen (ein Modell wurde entladen, die Explosion
      // hat ihre Klone abgebaut). Ein Träger, den niemand mehr hält, bleibt
      // sonst mit einem Baustein stehen, dessen Uniforms nicht mehr
      // nachgeführt werden.
      this._ziele.forEach(function (traeger) {
        if (ziele.indexOf(traeger) === -1) {
          try { verbund.entfernen(traeger, 'bildprojektion'); } catch (e) { /* fort */ }
        }
      });

      this._projektoren = bereit.map(function (p, i) { return self._projektor(p, i); });
      this._ziele = ziele;

      if (!this._projektoren.length) {
        ziele.forEach(function (traeger) {
          try { verbund.entfernen(traeger, 'bildprojektion'); } catch (e) { /* fort */ }
        });
        this._signatur = '';
        // Die Wache bleibt, solange überhaupt eine Ebene projizieren WILL.
        // Beim Start des Viewers ist das der Regelfall: die Ebenen stehen
        // schon in localStorage, ihre Bilder liegen noch in IndexedDB und die
        // Modelle laden gerade erst. Ohne diesen Unterschied bliebe eine
        // gespeicherte Projektion für immer aus, weil niemand mehr nachsieht.
        if (gewuenscht.length) this._wacheStarten();
        else this._wacheStoppen();
        return;
      }

      var baustein = this._bausteinBauen(this._projektoren);
      ziele.forEach(function (traeger) {
        try { verbund.setzen(traeger, 'bildprojektion', baustein); }
        catch (e) { console.warn('bildprojektion: Baustein nicht setzbar', e); }
      });

      this._signatur = signatur;
      this._uniformsNachfuehren();
      this._wacheStarten();
    },

    /** Alles abbauen — für den Fall, dass die letzte Projektion ausgeht. */
    aus: function () {
      var verbund = BimViewer.ShaderVerbund;
      if (verbund) {
        this._ziele.forEach(function (traeger) {
          try { verbund.entfernen(traeger, 'bildprojektion'); } catch (e) { /* fort */ }
        });
      }
      this._ziele = [];
      this._projektoren = [];
      this._signatur = '';
      this._wacheStoppen();
    },

    /**
     * Worauf projiziert wird.
     *
     * Alle geladenen Modelle, nicht nur das verankerte: ein Fassadenfoto
     * gehört auf die Fassade, und ob die aus dem Architektur- oder dem
     * Bestandsmodell kommt, weiß beim Aufziehen niemand. Ausgenommen sind
     * Punktwolken und Gaussian Splats (ihr Inhalt läuft nicht über den
     * Modell-Renderer, ein `customShader` bliebe dort ohne Wirkung) und das
     * Gelände (es ist kein Tileset).
     *
     * Die Geschossklone der Explosion kommen mit: solange sie läuft, ist das
     * Original unsichtbar, und die Projektion wäre ohne sie nirgends zu
     * sehen.
     */
    _zieleSammeln: function () {
      var ziele = [];

      if (BimViewer.loadedAssets) {
        BimViewer.loadedAssets.forEach(function (asset) {
          var ts = asset.tileset;
          if (ts && ts.root && !ts._isGaussianSplat && !asset.isPointCloud) {
            ziele.push(ts);
          } else if (asset.isGLB && asset.model) {
            ziele.push(asset.model);
          }
        });
      }

      var ex = BimViewer.Explosion;
      if (ex && ex.aktiv && ex.klonZiele) {
        ex.klonZiele.forEach(function (z) {
          (z.klone || []).forEach(function (k) {
            if (k.tileset && ziele.indexOf(k.tileset) === -1) ziele.push(k.tileset);
          });
        });
      }

      return ziele;
    },

    /**
     * Die Textur eines Bildes, einmal je Bild und nicht je Ziel.
     *
     * Bei einem gekachelten Plan ist es die Übersicht (`_cache`), nicht der
     * Kachelsatz — siehe Kopfkommentar. Liegen die Daten noch nicht vor,
     * wird das Nachladen angestoßen und `null` zurückgegeben; die Wache
     * kommt wieder vorbei.
     */
    _textur: function (ebene) {
      var Bildebenen = BimViewer.Bildebenen;
      if (!ebene.quelle) return null;
      var schluessel = ebene.quelle.schluessel + ':' + ebene.quelle.index;

      if (this._texturen[schluessel]) return this._texturen[schluessel];

      var daten = Bildebenen._cache[schluessel];
      if (!daten) {
        Bildebenen._nachladen(ebene);
        return null;
      }

      try {
        this._texturen[schluessel] = new Cesium.TextureUniform({
          url: daten,
          // Ohne Klemmen zieht die Randinterpolation die gegenüberliegende
          // Bildkante herein — ein feiner falscher Saum rund um das Bild.
          repeat: false
        });
      } catch (e) {
        console.warn('bildprojektion: Textur nicht ladbar', e);
        return null;
      }
      return this._texturen[schluessel];
    },

    /** Die Uniform-Träger EINES Projektors. Eigene Objekte je Platz. */
    _projektor: function (p, i) {
      return {
        ebene: p.ebene,
        index: i,
        textur: p.textur,
        // Je Platz eigene Instanzen: sie werden je Bild beschrieben und
        // liegen als Referenz im Uniform. Ein geteiltes Scratch-Objekt hieße,
        // dass alle vier Projektoren dieselbe Lage bekommen.
        uMitte: C3(), uRechts: C3(), uOben: C3(), uNorm: C3(), uAuge: C3(),
        uPar: new Cesium.Cartesian4(1, TIEFE_STANDARD, 0.5, 0)
      };
    },

    // ── Shader ─────────────────────────────────────────────────────────────

    /**
     * Der Baustein: eine Hilfsfunktion plus ein Aufruf je Projektor.
     *
     * Entrollt, nicht als Schleife über ein Sampler-Array — GLSL ES 3.0
     * erlaubt zwar `sampler2D[]`, aber nur mit KONSTANTEM Index, und eine
     * Schleife mit vier festen Durchgängen ist genau das Entrollen von Hand,
     * nur unleserlicher.
     */
    _bausteinBauen: function (projektoren) {
      var uniforms = {};
      var aufrufe = [];

      projektoren.forEach(function (pr, i) {
        uniforms['u_bp_bild' + i]   = { type: Cesium.UniformType.SAMPLER_2D, value: pr.textur };
        uniforms['u_bp_mitte' + i]  = { type: Cesium.UniformType.VEC3, value: pr.uMitte };
        uniforms['u_bp_rechts' + i] = { type: Cesium.UniformType.VEC3, value: pr.uRechts };
        uniforms['u_bp_oben' + i]   = { type: Cesium.UniformType.VEC3, value: pr.uOben };
        uniforms['u_bp_norm' + i]   = { type: Cesium.UniformType.VEC3, value: pr.uNorm };
        uniforms['u_bp_auge' + i]   = { type: Cesium.UniformType.VEC3, value: pr.uAuge };
        uniforms['u_bp_par' + i]    = { type: Cesium.UniformType.VEC4, value: pr.uPar };

        aufrufe.push(
          '    bpLegen(bpP, bpN, u_bp_bild' + i + ', u_bp_mitte' + i + ', u_bp_rechts' + i +
          ', u_bp_oben' + i + ', u_bp_norm' + i + ', u_bp_auge' + i + ', u_bp_par' + i +
          ', bpFarbe);');
      });

      return {
        // Nach dem Verformenden (Explosion, 10) und nach dem Material-
        // gebenden (Beton, 30): was hier aufgetragen wird, ist die letzte
        // Schicht und soll von keiner weiteren übermalt werden.
        ordnung: 40,

        uniforms: uniforms,

        varyings: {
          v_bp_ec: Cesium.VaryingType.VEC3
        },

        // Nicht `fsInput.attributes.positionEC`: das ist die Position NACH
        // einer Verformung durch einen früheren Baustein. Bei laufender
        // Explosion führe die Wand dann durch einen feststehenden Lichtkegel,
        // statt das Bild mitzunehmen. `positionMC` ist der unverformte Ort
        // des Bauteils, und an dem klebt das Bild.
        vertex: /* glsl */ `
          v_bp_ec = (czm_modelView * vec4(vsInput.attributes.positionMC, 1.0)).xyz;
        `,

        helferFS: /* glsl */ `
        void bpLegen(vec3 p, vec3 nrm, sampler2D bild, vec3 mitte, vec3 rechts,
                     vec3 oben, vec3 norm, vec3 auge, vec4 par, inout vec3 farbe) {
          // par = (Deckkraft, Tiefenband in m, cos(größte Neigung), perspektivisch?)

          // Steht die Fläche quer zur Bildebene, gehört das Bild nicht auf
          // sie. Der BETRAG: aus IFC kommen Wandflächen in beiden Wicklungen.
          //
          // Die Längenprüfung davor sichert den Fall ab, dass keine brauchbare
          // Normale ankommt. Ohne sie wäre das Skalarprodukt dann null, der
          // Filter griffe IMMER, und die Projektion bliebe auf einem solchen
          // Modell vollständig aus — ohne Fehlermeldung, ohne Anhaltspunkt.
          // Wo es keine Normale gibt, kann man nicht nach Neigung
          // aussortieren; dann wird nicht aussortiert.
          if (dot(nrm, nrm) > 0.25 && abs(dot(nrm, norm)) < par.z) return;

          vec3 q = p;
          if (par.w > 0.5) {
            // Beamer: den Punkt längs seines Sehstrahls auf die Bildebene
            // ziehen, bevor uv daraus wird.
            vec3 s = p - auge;
            float nenner = dot(s, norm);
            if (abs(nenner) < 1.0e-6) return;
            float t = dot(mitte - auge, norm) / nenner;
            if (t <= 0.0) return;              // hinter dem Projektor
            q = auge + s * t;
          }

          // rechts und oben tragen den Kehrwert der Bildbreite bzw. -höhe
          // bereits in ihrer Länge — ein Skalarprodukt, keine Division.
          vec3 d = q - mitte;
          vec2 uv = vec2(dot(d, rechts), dot(d, oben)) + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return;

          float tief = abs(dot(p - mitte, norm));
          if (tief > par.y) return;

          vec4 bf = texture(bild, uv);

          // Weicher Bildrand: ein harter Schnitt liest sich als aufgeklebtes
          // Rechteck, ein weicher als Projektion.
          vec2 rand = smoothstep(0.0, ${RANDWEICH.toFixed(3)}, uv)
                    * smoothstep(0.0, ${RANDWEICH.toFixed(3)}, 1.0 - uv);

          // Und dasselbe zum Rand des Tiefenbands hin: sonst reißt das Bild
          // auf einer leicht schrägen Fläche mit einer sichtbaren Kante ab,
          // dort nämlich, wo sie aus dem Band läuft.
          float band = 1.0 - smoothstep(par.y * 0.7, par.y, tief);

          farbe = mix(farbe, bf.rgb, bf.a * par.x * rand.x * rand.y * band);
        }
        `,

        fragment: /* glsl */ `
          vec3 bpP = v_bp_ec;
          // Nicht blind normalisieren: normalize() auf einem Nullvektor ist
          // in GLSL undefiniert (in der Praxis NaN, und NaN vergleicht sich
          // mit allem zu falsch — der Neigungsfilter könnte dann je nach
          // Treiber das eine oder das andere tun).
          vec3 bpRoh = material.normalEC;
          vec3 bpN = dot(bpRoh, bpRoh) > 0.0 ? normalize(bpRoh) : vec3(0.0);
          vec3 bpFarbe = material.diffuse;
${aufrufe.join('\n')}
          material.diffuse = bpFarbe;
        `
      };
    },

    // ── Nachführung ────────────────────────────────────────────────────────

    /**
     * Lage und Regler jedes Projektors in Augen-Koordinaten, je Bild.
     *
     * Einmal gerechnet, auf alle Ziele geschrieben: die Werte hängen an der
     * Kamera und an der Bildebene, nicht am Modell. Das ist der Unterschied
     * zu explosion.js, wo jedes Tileset seine eigene Basis hat.
     */
    _uniformsNachfuehren: function () {
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      var Bildebenen = BimViewer.Bildebenen;
      var verbund = BimViewer.ShaderVerbund;
      if (!szene || !Bildebenen || !verbund || !this._projektoren.length) return;

      var sicht = szene.camera.viewMatrix;
      var ziele = this._ziele;

      this._projektoren.forEach(function (pr) {
        var ebene = pr.ebene;
        var lage = Bildebenen.weltlage(ebene);

        // KEIN `ebene.versatz`: die Abhebung ist die Gegenmaßnahme gegen das
        // Z-Flimmern eines Rechtecks, das vor der Wand hängt. Hier gibt es
        // kein Rechteck — das Bild liegt auf der Fläche, und um zwei
        // Zentimeter versetzt läge die Bildebene um zwei Zentimeter falsch.
        Cesium.Matrix4.multiplyByPoint(sicht, lage.mitte, pr.uMitte);

        Cesium.Matrix4.multiplyByPointAsVector(sicht, lage.rechts, _ecV);
        Cesium.Cartesian3.multiplyByScalar(_ecV, 1 / Math.max(1e-6, ebene.breite_m), pr.uRechts);

        Cesium.Matrix4.multiplyByPointAsVector(sicht, lage.oben, _ecV);
        Cesium.Cartesian3.multiplyByScalar(_ecV, 1 / Math.max(1e-6, ebene.hoehe_m), pr.uOben);

        Cesium.Matrix4.multiplyByPointAsVector(sicht, lage.n, pr.uNorm);
        Cesium.Cartesian3.normalize(pr.uNorm, pr.uNorm);

        var abstand = ebene.proj_abstand || 0;
        if (abstand > 0) {
          Cesium.Cartesian3.multiplyByScalar(lage.n, abstand, _wc);
          Cesium.Cartesian3.add(lage.mitte, _wc, _wc);
          Cesium.Matrix4.multiplyByPoint(sicht, _wc, pr.uAuge);
        } else {
          Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO, pr.uAuge);
        }

        var winkel = ebene.proj_winkel === undefined ? WINKEL_STANDARD : ebene.proj_winkel;
        pr.uPar.x = ebene.deckkraft === undefined ? 1 : ebene.deckkraft;
        pr.uPar.y = Math.max(0.001, ebene.proj_tiefe === undefined
                                      ? TIEFE_STANDARD : ebene.proj_tiefe);
        pr.uPar.z = Math.cos(Cesium.Math.toRadians(Math.min(89.9, Math.max(0, winkel))));
        pr.uPar.w = abstand > 0 ? 1 : 0;

        var i = pr.index;
        ziele.forEach(function (traeger) {
          verbund.uniform(traeger, 'u_bp_mitte' + i, pr.uMitte);
          verbund.uniform(traeger, 'u_bp_rechts' + i, pr.uRechts);
          verbund.uniform(traeger, 'u_bp_oben' + i, pr.uOben);
          verbund.uniform(traeger, 'u_bp_norm' + i, pr.uNorm);
          verbund.uniform(traeger, 'u_bp_auge' + i, pr.uAuge);
          verbund.uniform(traeger, 'u_bp_par' + i, pr.uPar);
        });
      });
    },

    /**
     * Die Wache: Uniforms je Bild, Bestandsaufnahme alle zwanzig.
     *
     * In `preRender` und nicht in `preUpdate`, aus demselben Grund wie bei
     * der Explosion: dort ist die Kameramatrix die endgültige dieses Bildes.
     * In `preUpdate` wäre sie die des vorigen, und das Bild wanderte beim
     * Drehen um Zentimeter über die Wand.
     */
    _wacheStarten: function () {
      if (this._wache) return;
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      if (!szene) return;
      var self = this;

      this._wache = szene.preRender.addEventListener(function () {
        self._uniformsNachfuehren();

        if (++self._bild % 20) return;

        // Ist ein Modell dazugekommen, eines entladen, die Explosion
        // angelaufen? Dann steht der Baustein auf den falschen Trägern.
        var ziele = self._zieleSammeln();
        var gleich = ziele.length === self._ziele.length &&
          ziele.every(function (t, i) { return t === self._ziele[i]; });

        // Und ist ein Bild inzwischen aus IndexedDB da, das beim letzten Mal
        // noch fehlte?
        var offen = BimViewer.Bildebenen.ebenen.some(function (e) {
          return e.projektion && e.sichtbar !== false && !e._fehlt &&
                 !self._projektoren.some(function (pr) { return pr.ebene === e; });
        });

        if (!gleich || offen) self.nachziehen();
      });
    },

    _wacheStoppen: function () {
      if (this._wache) { this._wache(); this._wache = null; }
    },

    // ── Panel ──────────────────────────────────────────────────────────────
    //
    // Kein eigenes Panel: die Projektion ist eine Eigenschaft EINER Bild-
    // ebene, und die hat ihren Platz schon. bildebenen.js ruft die beiden
    // folgenden Funktionen, wenn es die Regler einer Ebene zeichnet.

    /** Der Abschnitt im aufgeklappten Eintrag einer Bildebene. */
    reglerHtml: function (e) {
      var an = !!e.projektion;
      var tiefe = e.proj_tiefe === undefined ? TIEFE_STANDARD : e.proj_tiefe;
      var winkel = e.proj_winkel === undefined ? WINKEL_STANDARD : e.proj_winkel;
      var abstand = e.proj_abstand || 0;

      function regler(feld, beschriftung, min, max, schritt, wert, einheit) {
        return '' +
          '<div class="section">' +
            '<div class="section__label">' + beschriftung + '</div>' +
            '<div class="slider-row">' +
              '<input type="range" class="slider" data-bp-id="' + e.id + '" ' +
                     'data-bp-feld="' + feld + '" min="' + min + '" max="' + max + '" ' +
                     'step="' + schritt + '" value="' + wert + '">' +
              '<span class="unit" data-bp-wert="' + feld + '">' + wert + ' ' + einheit + '</span>' +
            '</div>' +
          '</div>';
      }

      return '' +
        '<div class="bildebenen-projektion' + (an ? ' is-an' : '') + '">' +
          '<label class="bildebenen-schalter">' +
            '<input type="checkbox" data-bp-an="' + e.id + '"' + (an ? ' checked' : '') + '>' +
            '<span>Auf die Flächen projizieren</span>' +
          '</label>' +
          '<div class="hint">Statt als Rechteck davorzuhängen, wird das Bild auf die ' +
            'Bauteile gelegt — es folgt dann jedem Erker, jeder Laibung und jeder ' +
            'Stufe. Die Bildebene bleibt, was sie ist: sie gibt Ort, Größe und ' +
            'Richtung der Projektion vor.</div>' +
          (an ?
            regler('proj_tiefe', 'Tiefenband (wie weit das Bild greift)',
                   0.02, 20, 0.01, tiefe.toFixed(2), 'm') +
            regler('proj_winkel', 'Größte Neigung der Flächen',
                   5, 89, 1, Math.round(winkel), '°') +
            regler('proj_abstand', 'Aufnahmeentfernung (0 = parallel)',
                   0, 50, 0.5, abstand.toFixed(1), 'm') +
            '<div class="hint">Das Tiefenband hält die Projektion an: ohne es liefe ' +
              'sie durch die Wand auf alles dahinter. 0,25 m fassen eine Fassade samt ' +
              'Laibung, 5 m einen ganzen Raum.</div>' +
            '<div class="hint">Die Aufnahmeentfernung macht aus der Parallelprojektion ' +
              'einen Beamer. Für Pläne, Abwicklungen und Orthofotos bleibt sie bei 0 — ' +
              'die sind parallel aufgenommen. Für ein Handyfoto trägt man ein, wie weit ' +
              'man vom Bauwerk entfernt stand.</div>'
            : '') +
        '</div>';
    },

    /** Hängt die Ereignisse des Abschnitts ein. `ziel` ist die Liste im Panel. */
    binden: function (ziel) {
      var self = this;
      ziel.querySelectorAll('[data-bp-an]').forEach(function (el) {
        el.onchange = function () { self.umschalten(this.dataset.bpAn, this.checked); };
      });
      ziel.querySelectorAll('[data-bp-feld]').forEach(function (el) {
        el.oninput = function () { self.setzen(this.dataset.bpId, this.dataset.bpFeld, this.value); };
      });
    },

    /** Nur die Zahlen neben den Reglern — die Liste bleibt stehen. */
    _werteZeichnen: function (ebene) {
      var kasten = document.querySelector('[data-be="' + ebene.id + '"]');
      if (!kasten) return;
      var texte = {
        proj_tiefe: (ebene.proj_tiefe || 0).toFixed(2) + ' m',
        proj_winkel: Math.round(ebene.proj_winkel || 0) + ' °',
        proj_abstand: (ebene.proj_abstand || 0).toFixed(1) + ' m'
      };
      Object.keys(texte).forEach(function (feld) {
        var el = kasten.querySelector('[data-bp-wert="' + feld + '"]');
        if (el) el.textContent = texte[feld];
      });
    }
  };

  console.log('✅ Bildprojektion bereit');

})();
