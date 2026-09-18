/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Licensed under BSL 1.1 (siehe clipping-planes.js).
 */

// ===============================
// BILDEBENEN v1.1 — Bilder und PDF-Pläne im Maßstab an ein Bauteil legen
//
// Ein Foto, ein Bestandsplan, eine Fassadenabwicklung, eine Textur: alles,
// was als Bild vorliegt und im Modell an eine bestimmte Stelle gehört. Man
// wählt es aus und zieht es im Modell als Rechteck auf — in Metern, nicht in
// Bildschirmpixeln.
//
// ## Zwei Züge, und beide bleiben in der Ebene
//
// **Aufziehen** legt Ort und Größe zugleich fest: drücken, ziehen, loslassen.
// Nicht „Breite eintippen, dann klicken" — eine Breite in Metern muss man am
// Bauwerk erst schätzen, ein Rechteck zieht man an dem Bauteil ab, das man
// vor sich sieht. Ein Schalter hält dabei das Seitenverhältnis der Datei
// fest; offen lässt sich das Bild verzerren, etwa um einen schief
// eingescannten Plan auf zwei bekannte Punkte zu bringen.
//
// **Schieben** rückt ein gesetztes Bild zurecht: im Bild drücken und ziehen.
// Ein Druck AUSSERHALB des Bildes gehört weiter der Kamera — deshalb darf der
// Modus nach dem Setzen scharf bleiben, ohne die Bedienung zu belegen.
//
// ## Die Fläche: gemessen und dann eingerastet
//
// Woher die Neigung der Bildebene kommt, entscheidet, ob das Bild an der Wand
// hängt oder schief im Raum steht. Cesium gibt die Dreiecke eines
// 3D-Tiles-Bauteils nicht heraus; die einzige Quelle ist der Tiefenpuffer,
// und der ist quantisiert.
//
// **Ausgleichsebene statt Kreuzprodukt.** Drei Tastpunkte über fünf Pixel
// geben auf einer Wand mehrere Zehntelgrad bis Grad Fehler — gemessen: 0,60°
// im Mittel bei ±5 mm Tiefenrauschen. Siebzehn Punkte auf zwei Ringen, durch
// eine Ausgleichsebene nach Eberly gemittelt, kommen auf 0,25°. Zweimal
// gerechnet, dazwischen nach dem Ebenenabstand aussortiert, weil an einer
// Ecke ein Teil der Punkte auf der Nachbarfläche liegt.
//
// **Und dann eingerastet.** Auch 0,25° sind an einer 4 m breiten Bildebene
// 1,7 cm Versatz über die Breite — sichtbar, sobald zwei Bilder nebeneinander
// an derselben Wand hängen. Ein Bauwerk besteht aber aus lotrechten Wänden
// und waagerechten Decken: was an Restneigung übrigbleibt, ist Rauschen und
// kein Entwurf. Bis `RAST_GRAD` wird deshalb exakt ins Lot gezogen — und wenn
// die Wand nah an einer Achse des Kachelrahmens steht, auch auf diese. Ein
// wirklich geneigtes Dach (ab etwa 15°) bleibt unberührt.
//
// Beides rechnet über den Schnitt des Sichtstrahls mit der **Ebene des
// Bildes** (`_strahlAufEbene()`), nicht über die Geometrie darunter. Das ist
// der Kern: die Ebene steht mit dem DRÜCKEN fest, alles Weitere ist eine
// Rechnung in dieser einen Ebene. Ginge jeder Zwischenschritt wieder über
// `scene.pickPosition()`, wanderte das Rechteck beim Ziehen über eine Kante
// auf die Nachbarfläche und wäre am Ende windschief — und ein Verschieben an
// einer schrägen Wand liefe waagerecht davor statt parallel zur Wand.
//
// Abgrenzung zu den beiden Nachbarn, damit niemand dreimal dasselbe baut:
//
//   geschossplaene.js  Grundrisse, die das Backend aus dem Modell SCHNEIDET,
//                      waagerecht, ihre Lage steht fest.
//   plan-media.js      Bilder auf einem 2D-Planblatt, in Blattkoordinaten.
//   bildebenen.js      frei gesetzte Bilder IM RAUM, beliebig geneigt.
//
// ## Vier weitere Festlegungen
//
// **Die Fläche ist ein Einheitsquadrat, alles Übrige steckt in der Matrix.**
// Die Geometrie ist ein Quadrat von −0,5 bis +0,5 in der xy-Ebene; Ort, Lage,
// Breite und Höhe stehen in `modelMatrix` (Spalte 0 = rechts · Breite,
// Spalte 1 = oben · Höhe, Spalte 2 = Normale, Spalte 3 = Mitte).
//
// Das ist der Unterschied zu `geschossplaene._flaecheAnlegen()`, das seine
// vier Ecken als Weltkoordinaten in die Geometrie schreibt. Dort ist das
// richtig: die Lage steht fest, und der einzige Regler (Stapelabstand) ist
// eine reine Verschiebung. Hier ändern sich Ort und Größe bei JEDEM
// Zeigerzug — mit gebackenen Ecken wäre jeder davon eine neue Geometrie und
// damit eine neue Texturübertragung zur Grafikkarte, sechzigmal in der
// Sekunde. Über die Matrix ist es das Schreiben von sechzehn Zahlen. Das
// Aufziehen ist ohne diese Bauart nicht flüssig zu bekommen.
//
// **Flach beleuchtet, wie beim Geschossgrundriss und aus demselben Grund.**
// Ein `Primitive` mit `MaterialAppearance({ flat: true })` statt einer Entity
// mit `plane`: Entity-Geometrie bekommt einen Lambert-Term gegen den
// Sonnenstand, und ein Plan, dessen Lesbarkeit an der Tageszeit hängt, ist
// kaputt (nachgewiesen und ausführlich begründet in geschossplaene.js).
//
// **Die Ebene hängt am Bauteil, nicht an der Welt.** Wurde beim Setzen ein
// geladenes Modell getroffen, werden Mitte, Normale und Rechtsachse in dessen
// Kachelrahmen (`tileset.root.computedTransform`) abgelegt. Rückt
// `terrain-align.js` das Modell auf das Gelände oder zieht jemand am
// Höhenregler (`z-offset.js`), wandert das Bild mit. Eine Wache auf
// `scene.preUpdate` vergleicht die Matrix je Bild — dank des
// Einheitsquadrats ist das Nachziehen dann eine Matrixmultiplikation und
// kein Neubau. Ein Treffer auf Gelände oder freiem Globus hat keinen Anker
// und steht in Weltkoordinaten.
//
// **Die Bilddaten stehen nicht bei der Ebene.** Dieselbe Festlegung wie in
// plan-media.js: die Liste der Ebenen geht nach jedem Handgriff synchron in
// localStorage, ein eingebetteter Bestandsplan sprengte dessen 5 MB beim
// zweiten Blatt. Die Ebene führt einen Verweis ins Skizzenarchiv
// (`{schluessel, index}`), die Daten kommen aus IndexedDB und liegen zur
// Laufzeit in `_cache`. Nebenwirkung, und zwar die erwünschte: ein Bild, das
// hier gesetzt wurde, steht damit auch im Bericht und auf dem Planblatt zur
// Verfügung, ohne es ein zweites Mal von der Platte zu suchen.
//
// ## Der Maßstab
//
// Ein Bild trägt Pixel, ein PDF trägt Millimeter Papier — Meter trägt keines
// von beiden. Es gibt deshalb zwei Wege zur Breite, und beide stehen im
// Panel nebeneinander:
//
//   PDF mit bekanntem Plotmaßstab   „1:100" eintippen → Breite folgt aus der
//                                   Papiergröße (breite_mm / 1000 × 100)
//   alles andere                    Breite in Metern eintippen, die Höhe
//                                   folgt aus dem Seitenverhältnis der Datei
//
// Ein PDF geht dafür einmal durch `POST /plan/pdf` im Backend (pdf2svg,
// derselbe Weg wie bei plan-pdf.js) und kommt als Vektor-SVG samt Papiergröße
// zurück. Das SVG wird hier zu einem PNG gerastert: Cesium lädt zwar auch ein
// SVG als Textur, aber in seiner Eigengröße — bei einer A0-Vorlage sind das
// je nach Browser ein paar hundert Pixel, auf 1,2 m Breite gezogen unlesbar.
// Gerastert wird auf `TEXTUR_MAX` an der langen Kante, damit die Beschriftung
// stehen bleibt.
// ===============================
'use strict';

(function () {

  if (!window.BimViewer) {
    console.warn('bildebenen.js: BimViewer nicht gefunden');
    return;
  }

  /**
   * Längste Kante EINER Kachel in Pixeln.
   *
   * Nicht die Auflösung des Bildes — die steht in `AUFLOESUNGEN` und darf ein
   * Vielfaches davon sein; das Bild wird dann in ein Raster aus Kacheln
   * zerlegt. 4096 ist die Größe, die jede Grafikkarte sicher kann
   * (`ContextLimits.maximumTextureSize` liegt heute meist bei 16384, aber ein
   * älteres Notebook kann bei 4096 stehen) und die sich noch in vertretbarer
   * Zeit über `toDataURL` schreiben lässt.
   */
  var KACHEL_MAX = 4096;

  /**
   * Wie hoch aufgelöst ein Plan in die Szene geht — längste Kante in Pixeln
   * über das GANZE Blatt, quer über alle Kacheln.
   *
   * Der Maßstab dieser Zahlen ist die Lesbarkeit einer Bauzeichnung, nicht
   * eine Grafikkartengrenze: eine Beschriftung ist rund 2,5 mm hoch, und
   * lesbar wird sie ab etwa zehn Bildpunkten Höhe. Auf einem A0-Blatt
   * (1189 mm) sind das
   *
   *     4096 px → 3,4 px/mm →  ~9 px Schrifthöhe  (86 dpi)  — reicht für die Übersicht
   *     8192 px → 6,9 px/mm → ~17 px Schrifthöhe (175 dpi)  — lesbar beim Hineinzoomen
   *    12288 px → 10,3 px/mm → ~26 px Schrifthöhe (262 dpi) — wie ein guter Plot
   *
   * Der Preis steht daneben, weil er wirklich anfällt: die Textur belegt
   * Grafikspeicher, und zwar Breite × Höhe × 4 Byte, gleich wie weit man
   * herausgezoomt ist. Ein A0 in 12288 px sind rund 425 MB — das ist eine
   * Entscheidung, die der Nutzer treffen soll, keine, die hier stillschweigend
   * fällt. Voreinstellung ist deshalb die mittlere Stufe.
   */
  var AUFLOESUNGEN = {
    normal:  { px: 4096,  name: 'Übersicht (schnell)' },
    hoch:    { px: 8192,  name: 'Lesbar (Standard)' },
    fein:    { px: 12288, name: 'Plotqualität (viel Speicher)' }
  };

  /** Rückfallwert, wenn ein Bild ohne bekannte Auflösung verkleinert wird. */
  var TEXTUR_MAX = KACHEL_MAX;

  /** Abhebung von der getroffenen Fläche in Metern, gegen das Z-Flimmern. */
  var VERSATZ_STANDARD = 0.02;

  /** Breite eines Bildes, das nur angeklickt und nicht aufgezogen wurde. */
  var BREITE_STANDARD = 2.0;

  /**
   * Ab dieser aufgezogenen Breite gilt der Zug als Rechteck und nicht als
   * Klick, in Metern.
   *
   * Der Unterschied trägt eine Entscheidung: ein aufgezogenes Rechteck gibt
   * die Größe vor, ein bloßer Klick lässt sie beim Maßstab der Vorlage. Wer
   * eine PDF-Vorlage im Maßstab 1:100 gewählt hat und einfach klickt, will
   * genau diesen Maßstab — ihn durch einen unabsichtlichen Zwei-Pixel-Zug zu
   * verlieren wäre die schlechtere Auslegung.
   */
  var MINDEST_ZIEHEN = 0.15;

  /** Kleinste Kante beim Aufziehen, damit nie eine Nullfläche entsteht. */
  var KLEINSTE_KANTE = 0.02;

  /** Ab hier gilt eine Fläche als waagerecht — dann gibt Norden das Oben vor. */
  var WAAGERECHT_AB = 0.985;

  /**
   * Die Radien, auf denen der Tiefenpuffer für die Normale abgetastet wird,
   * in Pixeln — und wie viele Punkte je Ring.
   *
   * Zwei Ringe statt dreier Punkte, und das ist keine Feinheit: die Normale
   * aus drei Tastpunkten über fünf Pixel ist auf einer Wand um mehrere Grad
   * unsicher, weil der Tiefenpuffer quantisiert ist und der Fehler mit der
   * kurzen Basis multipliziert wird. Ein Bild, das um 4° gegen die Wand
   * verdreht hängt, sieht im Raum schief aus — genau der Fehler, um den es
   * hier geht. Siebzehn Punkte über zwölf Pixel, durch eine Ausgleichsebene
   * gemittelt, drücken das auf einen Bruchteil.
   */
  var TAST_RADIEN = [7, 13];
  var TAST_JE_RING = 8;

  /**
   * Bis zu welcher Abweichung eine Fläche als waagerecht oder senkrecht gilt,
   * in Grad.
   *
   * Ein Bauwerk besteht aus lotrechten Wänden und waagerechten Decken; was
   * die Messung an Restneigung übriglässt, ist Rauschen und kein Entwurf.
   * Zehn Grad ist weit genug, um jede Messunsicherheit einzufangen, und eng
   * genug, dass ein wirklich geneigtes Dach (ab etwa 15°) davon unberührt
   * bleibt.
   */
  var RAST_GRAD = 10;

  var SPEICHER = 'ileen-bildebenen';

  var AUSRICHTUNGEN = {
    flaeche:    'an der getroffenen Fläche',
    waagerecht: 'waagerecht (wie ein Grundriss)',
    senkrecht:  'senkrecht (wie ein Aushang)'
  };

  // ── kleine Helfer ────────────────────────────────────────────────────────

  function C3(x, y, z) { return new Cesium.Cartesian3(x || 0, y || 0, z || 0); }

  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (z) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z];
    });
  }

  function alsFeld(v) { return [v.x, v.y, v.z]; }
  function ausFeld(f) { return C3(f[0], f[1], f[2]); }

  function melden(text, art) {
    if (BimViewer.updateStatus) BimViewer.updateStatus(text, art || '');
  }

  /** „1:100", „1 : 100" oder „100" → 100. Alles andere → null. */
  function massstabAusEingabe(text) {
    if (!text) return null;
    var treffer = String(text).replace(/\s+/g, '').match(/^(?:1:)?(\d+(?:[.,]\d+)?)$/);
    if (!treffer) return null;
    var wert = parseFloat(treffer[1].replace(',', '.'));
    return isFinite(wert) && wert > 0 ? wert : null;
  }

  // ── Bilder aufbereiten ───────────────────────────────────────────────────

  /** Natürliche Pixelmaße einer data:-URI. */
  function masse(datenUri) {
    return new Promise(function (erfuellen) {
      if (!datenUri) { erfuellen(null); return; }
      var bild = new Image();
      bild.onload = function () {
        erfuellen({ breite: bild.naturalWidth || 1, hoehe: bild.naturalHeight || 1 });
      };
      bild.onerror = function () { erfuellen(null); };
      bild.src = datenUri;
    });
  }

  /**
   * Zeichnet eine data:-URI auf eine Leinwand und gibt sie als PNG zurück.
   *
   * Zwei Aufgaben in einem Durchgang: ein zu großes Foto wird verkleinert
   * (eine 8000-px-Kamera-Datei kostet als Textur 250 MB Grafikspeicher), und
   * ein SVG bekommt überhaupt erst eine feste Auflösung — ohne `breitePx`
   * rastert der Browser es in seiner Eigengröße, was bei einer Planvorlage
   * die Beschriftung verschluckt.
   */
  function rastern(datenUri, breitePx, hoehePx) {
    return new Promise(function (erfuellen) {
      var bild = new Image();
      bild.onload = function () {
        var b = breitePx || bild.naturalWidth || 1;
        var h = hoehePx || bild.naturalHeight || 1;
        var faktor = Math.min(1, TEXTUR_MAX / Math.max(b, h));

        // Passt die Datei schon und ist keine Größe vorgegeben, bleibt sie wie
        // sie ist. Ein Foto von 2000 px durch die Leinwand zu schicken machte
        // aus einem 400-kB-JPEG ein 8-MB-PNG — und das ginge so in IndexedDB.
        if (!breitePx && faktor === 1) { erfuellen(datenUri); return; }

        b = Math.max(1, Math.round(b * faktor));
        h = Math.max(1, Math.round(h * faktor));

        var leinwand = document.createElement('canvas');
        leinwand.width = b;
        leinwand.height = h;
        var ctx = leinwand.getContext('2d');
        ctx.drawImage(bild, 0, 0, b, h);
        try { erfuellen(leinwand.toDataURL('image/png')); }
        catch (e) { erfuellen(datenUri); }
      };
      bild.onerror = function () { erfuellen(datenUri); };
      // Ein SVG rastert der Browser nur dann in der gewünschten Größe, wenn
      // das <img> sie vor dem Laden trägt.
      if (breitePx) { bild.width = breitePx; bild.height = hoehePx; }
      bild.src = datenUri;
    });
  }

  function textZuBase64(text) {
    return btoa(unescape(encodeURIComponent(text)));
  }

  /** Was die Grafikkarte je Kachel wirklich kann. */
  function kachelMax() {
    var grenze = Cesium.ContextLimits && Cesium.ContextLimits.maximumTextureSize;
    return Math.min(KACHEL_MAX, grenze || KACHEL_MAX);
  }

  /**
   * Das Raster, in das ein Bild von `breitePx` × `hoehePx` zerfällt.
   *
   * Aufgeteilt wird, weil eine einzelne Textur nicht beliebig groß sein darf
   * — und nebenbei, weil Cesium Kacheln außerhalb des Bildausschnitts nicht
   * zeichnet. Der Grafikspeicher wird dadurch nicht kleiner (die Texturen
   * liegen alle da), aber ein Plan mit 100 Megapixeln wird überhaupt erst
   * darstellbar.
   */
  function raster(breitePx, hoehePx) {
    var max = kachelMax();
    return {
      spalten: Math.max(1, Math.ceil(breitePx / max)),
      zeilen: Math.max(1, Math.ceil(hoehePx / max)),
      breitePx: breitePx,
      hoehePx: hoehePx
    };
  }

  /**
   * Schneidet ein SVG auf einen Ausschnitt zu und gibt es in Kachelgröße
   * zurück.
   *
   * Über `viewBox` und nicht über einen großen `<img>` mit Versatz auf der
   * Leinwand: ein SVG rastert der Browser in der Größe, die das `<img>`
   * trägt. Für eine Kachel eines 12288 px breiten Plans müsste dieses Bild
   * also 12288 px breit sein — und das für JEDE der zwölf Kacheln. Über die
   * viewBox rastert der Browser nur den Ausschnitt und nur in Kachelgröße.
   *
   * Der Weg über DOMParser und nicht über einen regulären Ausdruck: die
   * Kopfzeile eines pdf2svg-Ergebnisses trägt ein Dutzend Attribute in
   * wechselnder Reihenfolge, und ein Ausdruck, der `width` im falschen Tag
   * trifft, macht aus dem Plan eine leere Fläche — ohne Fehlermeldung.
   */
  function svgAusschnitt(svgText, feld, pxBreite, pxHoehe) {
    var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    var wurzel = doc.documentElement;
    if (!wurzel || wurzel.nodeName === 'parsererror') return null;

    wurzel.setAttribute('viewBox',
      feld.x + ' ' + feld.y + ' ' + feld.breite + ' ' + feld.hoehe);
    wurzel.setAttribute('width', String(pxBreite));
    wurzel.setAttribute('height', String(pxHoehe));
    // Ohne das streckt der Browser den Ausschnitt auf das Seitenverhältnis
    // der Kachel, statt ihn zu füllen — an der letzten Spalte eines Rasters,
    // die schmaler ist als die übrigen, sieht man das sofort.
    wurzel.setAttribute('preserveAspectRatio', 'none');
    return new XMLSerializer().serializeToString(doc);
  }

  /** Die ursprüngliche viewBox eines SVG, notfalls aus width/height gebildet. */
  function viewBoxVon(svgText) {
    var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    var wurzel = doc.documentElement;
    if (!wurzel) return null;

    var vb = wurzel.getAttribute('viewBox');
    if (vb) {
      var z = vb.trim().split(/[\s,]+/).map(Number);
      if (z.length === 4 && z.every(isFinite)) {
        return { x: z[0], y: z[1], breite: z[2], hoehe: z[3] };
      }
    }
    var b = parseFloat(wurzel.getAttribute('width'));
    var h = parseFloat(wurzel.getAttribute('height'));
    if (isFinite(b) && isFinite(h) && b > 0 && h > 0) {
      return { x: 0, y: 0, breite: b, hoehe: h };
    }
    return null;
  }

  /** Eine Leinwand in PNG — ein Weg für alle Kachelquellen. */
  function leinwandZuPng(leinwand, rueckfall) {
    try { return leinwand.toDataURL('image/png'); }
    catch (e) { return rueckfall || null; }
  }

  /**
   * Zerlegt ein SVG in ein Kachelraster von insgesamt `gesamtBreite` Pixeln.
   *
   * Kachel für Kachel, nicht alle auf einmal: eine 12288 × 8688 große
   * Zwischenstufe wären 425 MB im Arbeitsspeicher, und die bräuchte es nur,
   * um sie sofort wieder zu zerschneiden.
   */
  async function svgKacheln(svgText, gesamtBreite, gesamtHoehe) {
    var vb = viewBoxVon(svgText);
    if (!vb) return null;

    var r = raster(gesamtBreite, gesamtHoehe);
    var kacheln = [];

    for (var iy = 0; iy < r.zeilen; iy++) {
      for (var ix = 0; ix < r.spalten; ix++) {
        // Die letzte Spalte und Zeile sind schmaler — Pixel und viewBox
        // müssen dabei GLEICH beschnitten werden, sonst rutscht die
        // Zeichnung in der Randkachel.
        var pxB = Math.min(kachelMax(), gesamtBreite - ix * kachelMax());
        var pxH = Math.min(kachelMax(), gesamtHoehe - iy * kachelMax());
        var feld = {
          x: vb.x + vb.breite * (ix * kachelMax()) / gesamtBreite,
          y: vb.y + vb.hoehe * (iy * kachelMax()) / gesamtHoehe,
          breite: vb.breite * pxB / gesamtBreite,
          hoehe: vb.hoehe * pxH / gesamtHoehe
        };

        var teil = svgAusschnitt(svgText, feld, pxB, pxH);
        if (!teil) return null;
        var png = await rastern('data:image/svg+xml;base64,' + textZuBase64(teil), pxB, pxH);
        kacheln.push(png);
      }
    }
    return { kacheln: kacheln, spalten: r.spalten, zeilen: r.zeilen,
             breitePx: gesamtBreite, hoehePx: gesamtHoehe };
  }

  /**
   * Dasselbe für ein Rasterbild — einen eingescannten Plan etwa.
   *
   * Hier wird NICHT vergrößert: mehr Pixel, als die Datei hat, sind keine
   * Information. Passt das Bild in eine Kachel, entsteht gar kein Raster.
   */
  async function bildKacheln(datenUri) {
    var m = await masse(datenUri);
    if (!m) return null;
    var max = kachelMax();
    if (m.breite <= max && m.hoehe <= max) return null;

    var bild = await bildLaden(datenUri);
    if (!bild) return null;

    var r = raster(m.breite, m.hoehe);
    var kacheln = [];
    for (var iy = 0; iy < r.zeilen; iy++) {
      for (var ix = 0; ix < r.spalten; ix++) {
        var pxB = Math.min(max, m.breite - ix * max);
        var pxH = Math.min(max, m.hoehe - iy * max);
        var leinwand = document.createElement('canvas');
        leinwand.width = pxB;
        leinwand.height = pxH;
        leinwand.getContext('2d').drawImage(bild, -ix * max, -iy * max);
        kacheln.push(leinwandZuPng(leinwand, datenUri));
      }
    }
    return { kacheln: kacheln, spalten: r.spalten, zeilen: r.zeilen,
             breitePx: m.breite, hoehePx: m.hoehe };
  }

  /** Ein geladenes `<img>` zu einer data:-URI, oder null. */
  function bildLaden(datenUri) {
    return new Promise(function (erfuellen) {
      var bild = new Image();
      bild.onload = function () { erfuellen(bild); };
      bild.onerror = function () { erfuellen(null); };
      bild.src = datenUri;
    });
  }

  /**
   * Was schiefging, in einem Satz, den man weitergeben kann.
   *
   * Die Nummer allein („HTTP 500") sagt niemandem, was zu tun ist. FastAPI
   * legt den Grund in `detail`, und die drei Fälle, die wirklich vorkommen,
   * brauchen jeweils einen anderen Handgriff — deshalb stehen sie
   * ausgeschrieben da statt hinter einer Statuszahl.
   */
  async function fehlertext(antwort, adresse) {
    var grund = '';
    try {
      var text = await antwort.text();
      try { grund = (JSON.parse(text) || {}).detail || ''; }
      catch (e) { grund = text.slice(0, 200); }
    } catch (e) { /* Körper nicht lesbar */ }

    if (antwort.status === 404) {
      return 'das Backend unter ' + adresse + ' kennt diesen Weg nicht. ' +
             'Zeigt die Backend-Adresse (Panel „Modelle" → „Eigenes Backend") ' +
             'auf einen Server ohne die Planroute?';
    }
    if (antwort.status === 500) {
      return 'das Backend konnte die Datei nicht umwandeln' +
             (grund ? ' (' + grund + ')' : '') +
             '. Meist fehlt dort das Systempaket pdf2svg.';
    }
    if (antwort.status === 422) {
      return 'das Backend hat die Datei abgelehnt' + (grund ? ': ' + grund : '') + '.';
    }
    return 'HTTP ' + antwort.status + (grund ? ' — ' + grund : '') + ' (' + adresse + ').';
  }

  /** Grafikspeicher eines Kachelsatzes, in MB — für den Hinweis im Panel. */
  function speicherMb(breitePx, hoehePx) {
    return breitePx * hoehePx * 4 / (1024 * 1024);
  }

  /**
   * Höhe geteilt durch Breite eines Medieneintrags.
   *
   * Eine PDF-Vorlage bringt ihre Papiermaße mit — die sind genauer als jede
   * Nachmessung am gerasterten Bild, weil dort die Rundung auf ganze Pixel
   * schon drin ist. Erst wenn sie fehlen, wird die Datei gemessen; misslingt
   * auch das, gilt quadratisch.
   */
  async function verhaeltnisVon(eintrag) {
    if (eintrag.hoehe_mm && eintrag.breite_mm) return eintrag.hoehe_mm / eintrag.breite_mm;
    var m = await masse(eintrag.daten);
    return m && m.breite ? m.hoehe / m.breite : 1;
  }

  // ── Geometrie ────────────────────────────────────────────────────────────

  /**
   * Das Einheitsquadrat, einmal für alle Ebenen.
   *
   * Die Texturkoordinaten stehen in der Geometrie und werden nicht von einer
   * Cesium-Ebene geerbt — dieselbe Vorsicht wie in geschossplaene.js:
   *
   *     (−0,5, −0,5) → st (0,0)      (+0,5, −0,5) → st (1,0)
   *     (−0,5, +0,5) → st (0,1)      (+0,5, +0,5) → st (1,1)
   *
   * Cesium lädt Bilder mit `flipY`, t = 1 liegt also an der Bildoberkante.
   * Damit zeigt die Bildoberkante in Richtung der Spalte 1 der Matrix, und
   * das ist die Achse, die `_basis()` als „oben" bestimmt hat. An einem
   * symmetrischen Grundriss sieht man eine Spiegelung sonst erst, wenn
   * jemand eine Tür sucht.
   */
  function einheitsquadrat() {
    return new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: new Float64Array([
            -0.5, -0.5, 0,
             0.5, -0.5, 0,
             0.5,  0.5, 0,
            -0.5,  0.5, 0
          ])
        }),
        // `flat: true` wertet die Normale nicht aus — das Vertexformat von
        // `MaterialAppearance` verlangt sie trotzdem, und ein fehlendes
        // Attribut ist ein leeres Attribut statt einer Fehlermeldung.
        normal: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])
        }),
        st: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          values: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
        })
      },
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: new Cesium.BoundingSphere(C3(0, 0, 0), Math.SQRT1_2)
    });
  }

  /**
   * Die waagerechte Achse einer Ebene mit der Normalen `n` am Ort `mitte`.
   *
   * Steht die Fläche schräg oder senkrecht, ist das die Schnittgerade mit
   * der Waagerechten — das Bild steht dann aufrecht, wie ein Aushang an der
   * Wand. Liegt sie waagerecht, gibt es keine solche Gerade; dann zeigt die
   * Rechtsachse nach Osten, das Bild also mit Norden nach oben.
   */
  function basis(n, mitte) {
    var hoch = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(mitte, C3());
    if (!Cesium.defined(hoch)) hoch = C3(0, 0, 1);

    var rechts = C3();
    if (Math.abs(Cesium.Cartesian3.dot(n, hoch)) > WAAGERECHT_AB) {
      var enu = Cesium.Transforms.eastNorthUpToFixedFrame(mitte);
      Cesium.Matrix4.multiplyByPointAsVector(enu, Cesium.Cartesian3.UNIT_X, rechts);
    } else {
      Cesium.Cartesian3.cross(hoch, n, rechts);
    }
    if (Cesium.Cartesian3.magnitude(rechts) < 1e-9) rechts = C3(1, 0, 0);
    return Cesium.Cartesian3.normalize(rechts, rechts);
  }

  /**
   * Die Normale der Ausgleichsebene durch eine Punktwolke.
   *
   * Nach Eberly: aus den zentrierten Punkten werden die sechs Summen der
   * Kovarianz gebildet, daraus drei Kandidaten für die Normale — je einer
   * für den Fall, dass die Ebene vorwiegend zur x-, y- oder z-Achse steht.
   * Genommen wird der mit der größten Determinante, weil der die am besten
   * konditionierte Rechnung ist.
   *
   * Der Umweg über die Kovarianz statt über ein Kreuzprodukt zweier
   * Differenzen ist der ganze Punkt: ein Kreuzprodukt nimmt drei Punkte und
   * glaubt ihnen; die Ausgleichsebene nimmt siebzehn und mittelt das Rauschen
   * des Tiefenpuffers heraus.
   *
   * Zentriert wird zwingend: Weltkoordinaten liegen bei 6,4 Millionen, und
   * die Quadratsummen davon hätten in `double` keine Stellen mehr für die
   * Zentimeter, um die es geht.
   */
  function ausgleichsnormale(punkte) {
    if (!punkte || punkte.length < 3) return null;

    var schwer = C3();
    punkte.forEach(function (p) { Cesium.Cartesian3.add(schwer, p, schwer); });
    Cesium.Cartesian3.divideByScalar(schwer, punkte.length, schwer);

    var xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    punkte.forEach(function (p) {
      var dx = p.x - schwer.x, dy = p.y - schwer.y, dz = p.z - schwer.z;
      xx += dx * dx; xy += dx * dy; xz += dx * dz;
      yy += dy * dy; yz += dy * dz; zz += dz * dz;
    });

    var detX = yy * zz - yz * yz;
    var detY = xx * zz - xz * xz;
    var detZ = xx * yy - xy * xy;
    var best = Math.max(detX, detY, detZ);
    if (!(best > 0)) return null;               // alle Punkte auf einer Geraden

    var n;
    if (best === detX) n = C3(detX, xz * yz - xy * zz, xy * yz - xz * yy);
    else if (best === detY) n = C3(xz * yz - xy * zz, detY, xy * xz - yz * xx);
    else n = C3(xy * yz - xz * yy, xy * xz - yz * xx, detZ);

    if (Cesium.Cartesian3.magnitude(n) < 1e-12) return null;
    return Cesium.Cartesian3.normalize(n, n);
  }

  /** Der Abstand eines Punktes von der Ebene durch `stuetz` mit Normale `n`. */
  function ebenenAbstand(p, stuetz, n) {
    return Math.abs(Cesium.Cartesian3.dot(
      Cesium.Cartesian3.subtract(p, stuetz, C3()), n));
  }

  /**
   * Rastet eine gemessene Normale auf das ein, woraus Bauwerke bestehen.
   *
   * Drei Fälle, und nur drei:
   *
   *   fast parallel zur Hochachse  → waagerechte Fläche (Decke, Fußboden,
   *                                  Gelände). Normale wird exakt lotrecht.
   *   fast quer zur Hochachse      → senkrechte Fläche (Wand). Der Höhenanteil
   *                                  fällt weg; das Bild steht damit exakt im
   *                                  Lot statt um Messrauschen verkantet.
   *   dazwischen                   → ein wirklich geneigtes Dach. Bleibt.
   *
   * Bei einer Wand wird zusätzlich die Himmelsrichtung geprüft: liegt sie nah
   * an einer Achse des Modells, wird sie darauf gelegt. In einem Bauwerk
   * stehen die Wände auf dem Raster, und eine um zwei Grad gegen das Raster
   * gedrehte Bildebene fällt an der Kante zur Nachbarwand sofort auf.
   *
   * `achsen` sind die waagerechten Modellachsen samt Gegenrichtungen; ist die
   * Liste leer (Treffer auf Gelände oder freiem Globus), entfällt dieser
   * Schritt — es gibt dann kein Raster, an dem sich etwas ausrichten ließe.
   */
  function einrasten(n, hoch, achsen, grad) {
    var anteil = Cesium.Cartesian3.dot(n, hoch);
    var sinTol = Math.sin(Cesium.Math.toRadians(grad));
    var cosTol = Math.cos(Cesium.Math.toRadians(grad));

    if (Math.abs(anteil) >= cosTol) {
      return {
        normale: Cesium.Cartesian3.multiplyByScalar(hoch, anteil >= 0 ? 1 : -1, C3()),
        art: 'waagerecht', achse: false
      };
    }

    if (Math.abs(anteil) <= sinTol) {
      var flach = Cesium.Cartesian3.subtract(
        n, Cesium.Cartesian3.multiplyByScalar(hoch, anteil, C3()), C3());
      if (Cesium.Cartesian3.magnitude(flach) < 1e-9) {
        return { normale: n, art: 'frei', achse: false };
      }
      Cesium.Cartesian3.normalize(flach, flach);

      var beste = null, bestesMass = cosTol;
      (achsen || []).forEach(function (a) {
        var mass = Cesium.Cartesian3.dot(flach, a);
        if (mass > bestesMass) { bestesMass = mass; beste = a; }
      });
      return {
        normale: beste ? Cesium.Cartesian3.clone(beste, C3()) : flach,
        art: 'senkrecht', achse: !!beste
      };
    }

    return { normale: n, art: 'frei', achse: false };
  }

  /** Spalten-Matrix aus Achsen und Maßen — siehe Kopfkommentar. */
  function matrixAus(mitte, rechts, oben, n, breite, hoehe) {
    var m3 = Cesium.Matrix3.clone(Cesium.Matrix3.IDENTITY, new Cesium.Matrix3());
    Cesium.Matrix3.setColumn(m3, 0,
      Cesium.Cartesian3.multiplyByScalar(rechts, breite, C3()), m3);
    Cesium.Matrix3.setColumn(m3, 1,
      Cesium.Cartesian3.multiplyByScalar(oben, hoehe, C3()), m3);
    Cesium.Matrix3.setColumn(m3, 2, n, m3);
    return Cesium.Matrix4.fromRotationTranslation(m3, mitte, new Cesium.Matrix4());
  }

  // ── Modul ────────────────────────────────────────────────────────────────

  BimViewer.Bildebenen = {

    /** Die gesetzten Ebenen. Reihenfolge = Reihenfolge im Panel. */
    ebenen: [],

    /** Was als Nächstes gesetzt wird: {schluessel, index, titel, breite_m?, hoehe_m?}. */
    vorlage: null,

    /** null · 'neu' · die Id einer Ebene, die gerade verschoben wird. */
    setzmodus: null,

    ausrichtung: 'flaeche',

    /** Hält das Seitenverhältnis der Datei beim Aufziehen fest. */
    seitenSperre: true,

    /** Legt gemessene Flächen ins Lot und auf die Achsen des Bauwerks. */
    einrasten: true,

    /** Was beim letzten Treffer herauskam: {art, achse, gemessen}. */
    letzteLage: null,

    /** Die Ebene, die gerade am Zeiger hängt (Schiebemodus), oder null. */
    schiebemodus: null,

    /** Die im Panel aufgeklappte Ebene. */
    auswahl: null,

    /** schluessel:index → data:-URI der Übersicht, zur Laufzeit. */
    _cache: {},
    /** schluessel:index → {kacheln, spalten, zeilen} für hoch aufgelöste Pläne. */
    _kachelCache: {},
    /** Welche Auflösungsstufe für den nächsten Import gilt. */
    aufloesung: 'hoch',
    _laden: {},
    _handler: null,
    _wache: null,
    _installiert: false,

    /** Läuft gerade ein Aufziehen? {ecke, n, rechts, oben, ebene, verhaeltnis} */
    _aufziehen: null,
    /** Läuft gerade ein Schieben? {ebene, griff, mitte0, n, rechts, oben} */
    _schieben: null,
    /** Hält den Klick nach einem Zug zurück — siehe `faengtKlick()`. */
    _klicksperre: false,
    /** Die letzte benennbare Fehlerursache beim Aufnehmen einer Datei. */
    _letzterFehler: null,

    // ── Klick-Vorrang ──────────────────────────────────────────────────────

    /**
     * Fängt features.js den Klick weg, solange hier gezogen wird?
     *
     * Dieselbe Bremse wie bei der Schnittbox (`SectionBox.faengtKlick()`):
     * ohne sie öffnete derselbe Klick zusätzlich die Eigenschaftsanzeige und
     * färbte das Bauteil ein, auf das gerade ein Bild gelegt wird.
     *
     * Der **Schiebemodus allein** sperrt NICHT: er bleibt nach dem Setzen
     * scharf, und wer dann ein Bauteil anklickt, meint das Bauteil. Gesperrt
     * wird erst, wenn wirklich am Bild gezogen wurde — `_klicksperre` hält
     * das über das Mausloslassen hinaus, weil `LEFT_CLICK` in features.js
     * erst danach kommt und die Reihenfolge zweier Ereignisbehandlungen auf
     * derselben Leinwand nicht festgelegt ist.
     */
    faengtKlick: function () {
      return this.setzmodus !== null || this._schieben !== null || this._klicksperre;
    },

    // ── Setzen: das Rechteck wird aufgezogen ───────────────────────────────
    //
    // Nicht „Breite eintippen, dann klicken", sondern aufziehen wie in jedem
    // Zeichenprogramm: drücken, ziehen, loslassen. Der Grund ist nicht die
    // Bequemlichkeit, sondern die Bezugsgröße — eine Breite in Metern muss
    // man am Bauwerk erst schätzen, ein Rechteck zieht man am Bauteil ab, das
    // man vor sich sieht. Die Zahl steht danach in der Liste und lässt sich
    // dort nachziehen.
    //
    // **Die Ebene steht mit dem Drücken fest**, nicht mit dem Loslassen: die
    // getroffene Fläche und ihre Normale werden EINMAL beim Drücken bestimmt,
    // danach läuft alles über den Schnitt des Sichtstrahls mit genau dieser
    // Ebene. Ohne das wanderte das Rechteck beim Ziehen über eine Kante auf
    // die Nachbarfläche und wäre am Ende windschief.

    /**
     * Schaltet den Zeiger scharf. Der nächste Zug in der Szene zieht ein
     * Rechteck auf.
     *
     * `ebeneId` zieht eine vorhandene Ebene neu auf, statt eine neue
     * anzulegen — Bild und Seitenverhältnis bleiben, Ort und Größe nicht.
     */
    setzenStarten: function (ebeneId) {
      if (!ebeneId && !this.vorlage) {
        melden('Erst ein Bild wählen — Datei öffnen oder aus dem Archiv anklicken.', 'error');
        return;
      }
      this.schiebemodus = null;
      this.setzmodus = ebeneId || 'neu';
      this._handlerAn();
      this._zeiger('crosshair');
      this._hinweis('Im Modell ein Rechteck aufziehen — drücken, ziehen, loslassen. ' +
                    'Ein einzelner Klick setzt das Bild in Standardgröße. ESC bricht ab.');
      this._listeZeichnen();
    },

    /**
     * Schaltet eine Ebene zum Schieben scharf.
     *
     * Danach greift ein Druck INNERHALB des Bildes es und schiebt es beim
     * Ziehen in seiner eigenen Ebene — nicht auf die Fläche darunter
     * projiziert, sondern in der Ebene, in der es hängt. Nur so bleibt eine
     * Verschiebung an einer schrägen Wand parallel zur Wand.
     *
     * Ein Druck außerhalb des Bildes gehört weiter der Kamera. Das ist der
     * Unterschied zu einem Modus, der die ganze Leinwand belegt: das Modell
     * bleibt bedienbar, während ein Bild scharf ist.
     */
    schiebenStarten: function (ebeneId) {
      var ebene = this.finden(ebeneId);
      if (!ebene) return;
      this.setzmodus = null;
      this.schiebemodus = this.schiebemodus === ebeneId ? null : ebeneId;
      if (this.schiebemodus) {
        this._handlerAn();
        this._hinweis('„' + ebene.titel + '" schieben: im Bild drücken und ziehen. ' +
                      'Außerhalb bleibt die Kamera bedienbar. ESC beendet.');
      } else {
        this._handlerAus();
        this._hinweis('');
      }
      this._listeZeichnen();
    },

    abbrechen: function () {
      // Ein halb aufgezogenes Rechteck ist kein Bild: es wird nicht in
      // Standardgröße stehen gelassen, sondern verworfen.
      var halb = this._aufziehen;
      if (halb && halb.neu) {
        this._entfernen(halb.ebene);
        this.ebenen = this.ebenen.filter(function (e) { return e !== halb.ebene; });
      }
      this._aufziehen = null;
      this._schieben = null;
      this._klicksperre = false;
      this.setzmodus = null;
      this.schiebemodus = null;
      this._kameraSperren(false);
      this._handlerAus();
      this._zeiger('');
      this._hinweis('');
      this._listeZeichnen();
    },

    _handlerAn: function () {
      var viewer = BimViewer.viewer;
      if (!viewer || this._handler) return;
      var self = this;
      var E = Cesium.ScreenSpaceEventType;

      this._handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      this._handler.setInputAction(function (e) { self._druck(e.position); }, E.LEFT_DOWN);
      this._handler.setInputAction(function (e) { self._zug(e.endPosition); }, E.MOUSE_MOVE);
      this._handler.setInputAction(function (e) { self._los(e.position); }, E.LEFT_UP);

      this._esc = function (ereignis) {
        if (ereignis.key === 'Escape') self.abbrechen();
      };
      window.addEventListener('keydown', this._esc);
    },

    _handlerAus: function () {
      if (this._handler) { this._handler.destroy(); this._handler = null; }
      if (this._esc) { window.removeEventListener('keydown', this._esc); this._esc = null; }
    },

    _zeiger: function (wert) {
      var c = document.getElementById('cesiumContainer');
      if (c) c.style.cursor = wert;
    },

    /**
     * Hält die Kamera an, solange gezogen wird.
     *
     * `enableInputs` und nicht die einzelnen Schalter: der
     * `ScreenSpaceCameraController` fragt ihn ganz oben in seinem `update()`
     * ab und bricht dann vollständig ab. Damit wirkt die Sperre auch dann
     * noch, wenn der Controller den Druck schon für sich verbucht hat — die
     * Reihenfolge zweier Ereignisbehandlungen auf derselben Leinwand ist
     * nicht festgelegt, und ein halb begonnenes Drehen wäre sonst genau der
     * Ruckler, der beim Aufziehen stört.
     */
    _kameraSperren: function (an) {
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      if (!szene || !szene.screenSpaceCameraController) return;
      szene.screenSpaceCameraController.enableInputs = !an;
    },

    /**
     * Der Schnittpunkt des Sichtstrahls mit einer Ebene.
     *
     * Das Gegenstück zu `treffer()`: dort wird die Geometrie der Szene
     * gefragt, hier eine gedachte Ebene. Beim Aufziehen und beim Schieben ist
     * das die richtige Frage — das Bild soll in SEINER Ebene bleiben, nicht
     * auf das springen, was zufällig hinter dem Zeiger liegt.
     */
    _strahlAufEbene: function (bildschirmpunkt, stuetz, n) {
      var viewer = BimViewer.viewer;
      if (!viewer) return null;
      var strahl = viewer.camera.getPickRay(bildschirmpunkt);
      if (!Cesium.defined(strahl)) return null;

      var nenner = Cesium.Cartesian3.dot(strahl.direction, n);
      // Der Blick streift die Ebene: der Schnittpunkt läuft ins Unendliche,
      // und ein Rechteck von hier bis zum Horizont ist keine Eingabe.
      if (Math.abs(nenner) < 1e-4) return null;

      var t = Cesium.Cartesian3.dot(
        Cesium.Cartesian3.subtract(stuetz, strahl.origin, C3()), n) / nenner;
      if (t <= 0) return null;                    // Ebene liegt hinter der Kamera
      return Cesium.Cartesian3.add(strahl.origin,
        Cesium.Cartesian3.multiplyByScalar(strahl.direction, t, C3()), C3());
    },

    // ── Die drei Ereignisse ────────────────────────────────────────────────

    _druck: function (bildschirmpunkt) {
      if (this.setzmodus) { this._aufziehenStart(bildschirmpunkt); return; }
      if (this.schiebemodus) this._schiebenStart(bildschirmpunkt);
    },

    _zug: function (bildschirmpunkt) {
      if (this._aufziehen) { this._aufziehenZug(bildschirmpunkt); return; }
      if (this._schieben) { this._schiebenZug(bildschirmpunkt); return; }
      // Kein Zug im Gange: der Zeiger sagt nur an, ob hier gegriffen würde.
      if (this.schiebemodus) {
        this._zeiger(this._griffPunkt(this.finden(this.schiebemodus), bildschirmpunkt)
          ? 'move' : '');
      }
    },

    _los: function (bildschirmpunkt) {
      if (this._aufziehen) { this._aufziehenEnde(bildschirmpunkt); return; }
      if (this._schieben) this._schiebenEnde();
    },

    // ── Aufziehen ──────────────────────────────────────────────────────────

    _aufziehenStart: function (bildschirmpunkt) {
      var treffer = this.treffer(bildschirmpunkt);
      if (!treffer) {
        melden('An dieser Stelle liegt nichts, worauf sich ein Bild legen ließe.', 'error');
        return;
      }

      var vorhanden = this.setzmodus !== 'neu' ? this.finden(this.setzmodus) : null;
      var vorlage = vorhanden
        ? { schluessel: vorhanden.quelle.schluessel, index: vorhanden.quelle.index,
            titel: vorhanden.titel, verhaeltnis: vorhanden.hoehe_m / vorhanden.breite_m }
        : this.vorlage;
      if (!vorlage) return;

      var ebene = vorhanden || this.anlegen(treffer, vorlage);
      if (!ebene) return;
      if (vorhanden) this._verankern(ebene, treffer);

      var lage = this.weltlage(ebene);
      this._aufziehen = {
        ebene: ebene,
        neu: !vorhanden,
        ecke: treffer.mitte,
        n: lage.n,
        rechts: lage.rechts,
        oben: lage.oben,
        verhaeltnis: vorlage.verhaeltnis || (ebene.hoehe_m / ebene.breite_m) || 1,
        gezogen: false
      };
      this.auswahl = ebene.id;
      this._kameraSperren(true);
    },

    /**
     * Zieht das Rechteck von der gedrückten Ecke zum Zeiger.
     *
     * Bei gesperrtem Seitenverhältnis gibt die GRÖSSERE der beiden gezogenen
     * Kanten den Ausschlag, nicht die Breite. Sonst schrumpfte ein Bild auf
     * nichts zusammen, sobald jemand vorwiegend nach unten zieht — und genau
     * so zieht man ein Hochformat auf.
     */
    _aufziehenZug: function (bildschirmpunkt) {
      var z = this._aufziehen;
      var p = this._strahlAufEbene(bildschirmpunkt, z.ecke, z.n);
      if (!p) return;

      var weg = Cesium.Cartesian3.subtract(p, z.ecke, C3());
      var du = Cesium.Cartesian3.dot(weg, z.rechts);
      var dv = Cesium.Cartesian3.dot(weg, z.oben);

      var breite, hoehe;
      if (this.seitenSperre) {
        breite = Math.max(Math.abs(du), Math.abs(dv) / z.verhaeltnis);
        hoehe = breite * z.verhaeltnis;
      } else {
        breite = Math.abs(du);
        hoehe = Math.abs(dv);
      }
      breite = Math.max(breite, KLEINSTE_KANTE);
      hoehe = Math.max(hoehe, KLEINSTE_KANTE);

      // Die gedrückte Ecke bleibt liegen, das Rechteck wächst von ihr weg —
      // in die Richtung, in die gezogen wird. Bei einem Zug von genau null
      // gilt „nach rechts unten", wie überall.
      var su = du < 0 ? -1 : 1;
      var sv = dv < 0 ? -1 : 1;
      var mitte = Cesium.Cartesian3.add(z.ecke,
        Cesium.Cartesian3.add(
          Cesium.Cartesian3.multiplyByScalar(z.rechts, su * breite / 2, C3()),
          Cesium.Cartesian3.multiplyByScalar(z.oben, sv * hoehe / 2, C3()), C3()), C3());

      z.gezogen = breite >= MINDEST_ZIEHEN || hoehe >= MINDEST_ZIEHEN;
      z.ebene.breite_m = breite;
      z.ebene.hoehe_m = hoehe;
      this._weltMitteSetzen(z.ebene, mitte);
      this._nachziehen(z.ebene);
      this._werteZeichnen(z.ebene);
    },

    /**
     * Schließt das Aufziehen ab — oder wertet es als Klick.
     *
     * Ein Zug unter `MINDEST_ZIEHEN` war keine Größenangabe, sondern ein
     * Klick. Dann gilt wieder, was die Vorlage mitbringt: bei einer
     * PDF-Vorlage ihr Plotmaßstab, sonst die Standardbreite.
     */
    _aufziehenEnde: function () {
      var z = this._aufziehen;
      this._aufziehen = null;
      this._kameraSperren(false);
      if (!z) return;

      if (!z.gezogen) {
        // Eine vorhandene Ebene behält ihre Größe und wird nur versetzt —
        // wer sie neu aufziehen wollte, hätte gezogen.
        if (z.neu) {
          var breite = (this.vorlage && this.vorlage.breite_m) || BREITE_STANDARD;
          z.ebene.breite_m = breite;
          z.ebene.hoehe_m = breite * z.verhaeltnis;
        }
        this._weltMitteSetzen(z.ebene, z.ecke);
        this._nachziehen(z.ebene);
      }

      this.setzmodus = null;
      this.sichern();
      // Frisch gesetzt heißt fast immer: gleich noch ein Stück zurechtrücken.
      // Der Schiebemodus steht deshalb sofort bereit, ohne einen zweiten
      // Knopfdruck — er sperrt die Kamera nicht und stört deshalb auch den
      // nicht, der ihn nicht braucht.
      this.schiebemodus = z.ebene.id;
      this._zeiger('');
      this._hinweis('„' + z.ebene.titel + '" gesetzt, ' +
        z.ebene.breite_m.toFixed(2) + ' × ' + z.ebene.hoehe_m.toFixed(2) + ' m' +
        this._lageText() + '. Zum Verschieben im Bild drücken und ziehen.');
      this._listeZeichnen();
      melden('„' + z.ebene.titel + '" gesetzt.', 'success');
    },

    // ── Schieben in der Ebene ──────────────────────────────────────────────

    /**
     * Liegt der Zeiger im Bild? Dann der Punkt in der Bildebene, sonst null.
     *
     * Über den Schnitt mit der Bildebene und nicht über `scene.pick()`: die
     * Fläche ist `allowPicking: false` (sie soll das Bauteil darunter nicht
     * verdecken), und daran soll sich nichts ändern, nur damit man sie
     * greifen kann. Das Rechteck selbst ist billig zu prüfen.
     */
    _griffPunkt: function (ebene, bildschirmpunkt) {
      if (!ebene || !ebene.sichtbar) return null;
      var lage = this.weltlage(ebene);
      var mitte = lage.mitte;
      if (ebene.versatz) {
        mitte = Cesium.Cartesian3.add(mitte,
          Cesium.Cartesian3.multiplyByScalar(lage.n, ebene.versatz, C3()), C3());
      }
      var p = this._strahlAufEbene(bildschirmpunkt, mitte, lage.n);
      if (!p) return null;

      var weg = Cesium.Cartesian3.subtract(p, mitte, C3());
      var du = Cesium.Cartesian3.dot(weg, lage.rechts);
      var dv = Cesium.Cartesian3.dot(weg, lage.oben);
      if (Math.abs(du) > ebene.breite_m / 2 || Math.abs(dv) > ebene.hoehe_m / 2) return null;
      return { punkt: p, lage: lage };
    },

    _schiebenStart: function (bildschirmpunkt) {
      var ebene = this.finden(this.schiebemodus);
      var griff = this._griffPunkt(ebene, bildschirmpunkt);
      if (!griff) return;                     // außerhalb — der Druck gehört der Kamera

      this._schieben = {
        ebene: ebene,
        griff: griff.punkt,
        mitte0: Cesium.Cartesian3.clone(griff.lage.mitte, C3()),
        n: griff.lage.n,
        rechts: griff.lage.rechts,
        oben: griff.lage.oben
      };
      this._klicksperre = true;
      this._kameraSperren(true);
      this._zeiger('grabbing');
    },

    /**
     * Verschiebt um die Strecke, die der Zeiger IN DER EBENE zurückgelegt hat.
     *
     * Gerechnet wird gegen den Greifpunkt und nicht gegen den letzten
     * Zwischenstand: so sammelt sich über einen langen Zug kein Rundungsdrift
     * an, und das Bild sitzt am Ende genau dort, wo der Zeiger es hingetragen
     * hat.
     */
    _schiebenZug: function (bildschirmpunkt) {
      var z = this._schieben;
      var p = this._strahlAufEbene(bildschirmpunkt, z.griff, z.n);
      if (!p) return;

      var weg = Cesium.Cartesian3.subtract(p, z.griff, C3());
      var neu = Cesium.Cartesian3.add(z.mitte0,
        Cesium.Cartesian3.add(
          Cesium.Cartesian3.multiplyByScalar(z.rechts,
            Cesium.Cartesian3.dot(weg, z.rechts), C3()),
          Cesium.Cartesian3.multiplyByScalar(z.oben,
            Cesium.Cartesian3.dot(weg, z.oben), C3()), C3()), C3());

      this._weltMitteSetzen(z.ebene, neu);
      this._nachziehen(z.ebene);
    },

    _schiebenEnde: function () {
      var self = this;
      this._schieben = null;
      this._kameraSperren(false);
      this._zeiger('move');
      this.sichern();
      // Erst nach dem `LEFT_CLICK`, das auf das Loslassen folgt, wieder
      // freigeben — sonst wählt derselbe Zug am Ende noch das Bauteil unter
      // dem Bild aus.
      setTimeout(function () { self._klicksperre = false; }, 0);
    },

    /**
     * Setzt ein Bild ohne Aufziehen an eine Stelle — für Ablegen und
     * Einfügen, wo es keinen Zug gibt, den man auswerten könnte.
     *
     * Die Größe kommt aus der Vorlage (PDF-Maßstab, sonst Standardbreite);
     * zurechtgezogen wird danach über den Schiebemodus und die Regler, die
     * hier gleich scharf gestellt werden.
     */
    _sofortSetzen: function (treffer, vorlage) {
      var ebene = this.anlegen(treffer, vorlage);
      if (!ebene) return null;
      this.sichern();
      this.schiebemodus = ebene.id;
      this._handlerAn();
      this._listeZeichnen();
      this._hinweis('„' + ebene.titel + '" gesetzt, ' +
        ebene.breite_m.toFixed(2) + ' × ' + ebene.hoehe_m.toFixed(2) + ' m. ' +
        'Zum Verschieben im Bild drücken und ziehen.');
      melden('„' + ebene.titel + '" gesetzt.', 'success');
      return ebene;
    },

    /**
     * Was aus der Flächenerkennung wurde, in Worten.
     *
     * Steht in der Rückmeldung nach dem Setzen, weil es die einzige Stelle
     * ist, an der sich „das Bild hängt schief" von „die Wand IST schief"
     * unterscheiden lässt. Ohne diese Zeile bleibt dem Nutzer nur, das
     * Ergebnis anzusehen und zu raten.
     */
    _lageText: function () {
      var l = this.letzteLage;
      if (!l) return '';
      if (l.art === 'waagerecht') {
        return l.erzwungen ? ', waagerecht (vorgegeben)' : ', auf einer waagerechten Fläche';
      }
      if (l.art === 'senkrecht') {
        return l.achse ? ', lotrecht an einer Modellachse' : ', lotrecht an der Wand';
      }
      return l.gemessen === false
        ? ', Fläche nicht erkannt — zur Kamera gestellt'
        : ', auf einer geneigten Fläche';
    },

    /** Schreibt eine Weltmitte in die Ebene zurück — im Ankerrahmen, falls es einen gibt. */
    _weltMitteSetzen: function (ebene, mitteWelt) {
      var rahmen = ebene.anker ? this._rahmen(ebene.anker) : null;
      if (rahmen) {
        var inv = Cesium.Matrix4.inverse(rahmen, new Cesium.Matrix4());
        ebene.mitte = alsFeld(Cesium.Matrix4.multiplyByPoint(inv, mitteWelt, C3()));
      } else {
        ebene.mitte = alsFeld(mitteWelt);
      }
    },

    /**
     * Ort und Flächenlage unter dem Zeiger.
     *
     * Der Ort kommt über `Tags.pick()` und nicht über `scene.pickPosition()`
     * allein: dort steckt schon die ganze Fallunterscheidung zwischen
     * IFC-Feature, Gauß-Splat, Gelände und freiem Globus, einschließlich der
     * Entscheidung, wann ein Splat vor der gemessenen Oberfläche liegt. Die
     * hier zweimal zu treffen, hieße sie beim nächsten Umbau von tags.js an
     * einer Stelle zu vergessen.
     *
     * Die Normale liefert `Tags.pick()` nicht — dafür wird der Tiefenpuffer
     * an drei Stellen abgetastet.
     */
    treffer: function (bildschirmpunkt) {
      var viewer = BimViewer.viewer;
      if (!viewer || !window.Tags || !Tags.pick) return null;

      var ergebnis = Tags.pick(bildschirmpunkt);
      var wc = ergebnis && ergebnis.position && ergebnis.position.worldCart;
      if (!wc) return null;

      var mitte = C3(wc.x, wc.y, wc.z);
      // Das Asset zuerst: `_normaleAn()` braucht seinen Kachelrahmen, um die
      // Wand auf die Achsen des Bauwerks legen zu können.
      var assetId = (ergebnis.target && ergebnis.target.assetId) || null;
      var n = this._normaleAn(bildschirmpunkt, mitte, assetId);
      return { mitte: mitte, normale: n, assetId: assetId,
               art: (ergebnis.target && ergebnis.target.kind) || 'free' };
    },

    /**
     * Die Flächennormale unter dem Zeiger, aus dem Tiefenpuffer.
     *
     * Drei Tastpunkte im Abstand weniger Pixel spannen ein Dreieck auf; sein
     * Kreuzprodukt ist die Normale. Der Weg ist billig und braucht keine
     * Geometrie — er versagt aber an einer Silhouettenkante, wo der Nachbar
     * meterweit dahinterliegt. Deshalb die Plausibilitätsschranke: ist ein
     * Tastschritt deutlich größer als die Weltbreite eines Pixels an dieser
     * Entfernung, wurde über eine Kante hinweg gemessen und die Ebene fällt
     * auf die Waagerechte zurück, statt schief im Raum zu stehen.
     */
    _normaleAn: function (bildschirmpunkt, mitte, assetId) {
      var viewer = BimViewer.viewer;
      var hoch = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(mitte, C3()) || C3(0, 0, 1);
      this.letzteLage = null;

      if (this.ausrichtung === 'waagerecht') {
        this.letzteLage = { art: 'waagerecht', achse: false, erzwungen: true };
        return hoch;
      }

      var gemessen = this._normaleMessen(bildschirmpunkt);
      var n = gemessen || this._rueckfallNormale(hoch);

      if (this.ausrichtung === 'senkrecht') {
        this.letzteLage = { art: 'senkrecht', achse: false, erzwungen: true,
                            gemessen: !!gemessen };
        var flach = this._waagerechtMachen(n, hoch);
        // Auch eine erzwungen senkrechte Fläche darf sich an das Raster
        // legen — sonst stünde sie im Lot, aber quer zum Bauwerk.
        if (this.einrasten) {
          var gerastet = einrasten(flach, hoch, this._modellAchsen(assetId, hoch), RAST_GRAD);
          this.letzteLage.achse = gerastet.achse;
          return gerastet.normale;
        }
        return flach;
      }

      if (!this.einrasten) {
        this.letzteLage = { art: 'frei', achse: false, gemessen: !!gemessen };
        return n;
      }

      var e = einrasten(n, hoch, this._modellAchsen(assetId, hoch), RAST_GRAD);
      this.letzteLage = { art: e.art, achse: e.achse, gemessen: !!gemessen };
      return e.normale;
    },

    /**
     * Die Normale unter dem Zeiger, aus einer Ausgleichsebene durch den
     * Tiefenpuffer.
     *
     * Zwei Ringe von Tastpunkten um den Zeiger, siebzehn insgesamt. Der Weg
     * ist billig und braucht keine Geometrie — Cesium gibt die Dreiecke eines
     * 3D-Tiles-Bauteils nicht heraus, es gibt also keinen genaueren.
     *
     * **Zweimal gerechnet, dazwischen aussortiert.** An einer Kante liegt ein
     * Teil der Tastpunkte auf der Nachbarfläche oder metertief dahinter; die
     * ziehen die Ebene schief. Nach dem ersten Durchgang fliegt alles heraus,
     * was weiter als das Dreifache des mittleren Abstands von der Ebene liegt,
     * und es wird neu gerechnet. Das ist der übliche robuste Ausgleich, und
     * er ist hier nötig: die Stelle, an der man ein Bild an eine Wand setzt,
     * ist oft genug in der Nähe einer Ecke.
     *
     * **Und am Ende eine Güteprüfung.** Bleibt die Streuung groß gegen die
     * abgetastete Fläche, war das keine Ebene — ein Geländer, eine Pflanze,
     * eine Kante. Dann lieber `null` und der Rückfall, als eine erfundene
     * Neigung.
     */
    _normaleMessen: function (bildschirmpunkt) {
      var viewer = BimViewer.viewer;
      var szene = viewer && viewer.scene;
      if (!szene) return null;

      var mitte = szene.pickPosition(bildschirmpunkt);
      if (!Cesium.defined(mitte)) return null;

      var punkte = [mitte];
      TAST_RADIEN.forEach(function (r) {
        for (var i = 0; i < TAST_JE_RING; i++) {
          var w = 2 * Math.PI * i / TAST_JE_RING;
          var p = szene.pickPosition(new Cesium.Cartesian2(
            bildschirmpunkt.x + r * Math.cos(w),
            bildschirmpunkt.y + r * Math.sin(w)));
          if (Cesium.defined(p)) punkte.push(p);
        }
      });
      if (punkte.length < 6) return null;

      var n = ausgleichsnormale(punkte);
      if (!n) return null;

      // Aussortieren und noch einmal.
      var abstaende = punkte.map(function (p) { return ebenenAbstand(p, mitte, n); });
      var sortiert = abstaende.slice().sort(function (a, b) { return a - b; });
      var mittlerer = sortiert[Math.floor(sortiert.length / 2)];
      var schranke = Math.max(mittlerer * 3, 1e-4);
      var gefiltert = punkte.filter(function (p, i) { return abstaende[i] <= schranke; });

      if (gefiltert.length >= 6) {
        var n2 = ausgleichsnormale(gefiltert);
        if (n2) { n = n2; punkte = gefiltert; }
      }

      // Güte: Streuung gegen Ausdehnung. Eine Ebene, deren Punkte so weit
      // von ihr abliegen wie sie breit ist, ist keine.
      var streuung = 0, weite = 0;
      punkte.forEach(function (p) {
        streuung += Math.pow(ebenenAbstand(p, mitte, n), 2);
        weite = Math.max(weite, Cesium.Cartesian3.distance(p, mitte));
      });
      streuung = Math.sqrt(streuung / punkte.length);
      if (weite <= 0 || streuung > weite * 0.35) return null;

      // Zur Kamera hin: sonst zeigt das Bild in die Wand hinein.
      var zurKamera = Cesium.Cartesian3.subtract(viewer.camera.positionWC, mitte, C3());
      if (Cesium.Cartesian3.dot(n, zurKamera) < 0) Cesium.Cartesian3.negate(n, n);
      return n;
    },

    /**
     * Was gilt, wenn sich keine Ebene messen ließ.
     *
     * Nicht mehr stur die Waagerechte: wer waagerecht auf etwas blickt, meint
     * eine Wand, und eine waagerecht hingelegte Bildebene wäre dort das
     * Falscheste von allem — sie stünde quer zum Blick und wäre kaum zu
     * sehen. Also eine lotrechte Fläche, die dem Betrachter zugewandt ist;
     * einrasten darf sie danach trotzdem.
     */
    _rueckfallNormale: function (hoch) {
      var viewer = BimViewer.viewer;
      var blick = viewer && viewer.camera && viewer.camera.directionWC;
      if (!blick) return hoch;
      if (Math.abs(Cesium.Cartesian3.dot(blick, hoch)) >= 0.5) return hoch;
      return this._waagerechtMachen(
        Cesium.Cartesian3.negate(blick, C3()), hoch);
    },

    /**
     * Nimmt einer Richtung den Höhenanteil — übrig bleibt eine lotrechte
     * Fläche. Zeigt sie genau nach oben, entscheidet der Blick.
     */
    _waagerechtMachen: function (n, hoch) {
      var anteil = Cesium.Cartesian3.dot(n, hoch);
      var flach = Cesium.Cartesian3.subtract(
        n, Cesium.Cartesian3.multiplyByScalar(hoch, anteil, C3()), C3());
      if (Cesium.Cartesian3.magnitude(flach) > 1e-6) {
        return Cesium.Cartesian3.normalize(flach, flach);
      }
      var viewer = BimViewer.viewer;
      var blick = Cesium.Cartesian3.clone(viewer.camera.directionWC, C3());
      var b2 = Cesium.Cartesian3.dot(blick, hoch);
      Cesium.Cartesian3.subtract(
        blick, Cesium.Cartesian3.multiplyByScalar(hoch, b2, C3()), blick);
      if (Cesium.Cartesian3.magnitude(blick) < 1e-9) return C3(1, 0, 0);
      Cesium.Cartesian3.normalize(blick, blick);
      return Cesium.Cartesian3.negate(blick, blick);
    },

    /**
     * Die waagerechten Achsen des getroffenen Modells, samt Gegenrichtungen.
     *
     * Aus dem Kachelrahmen: seine x- und y-Achse sind die Achsen, in denen
     * das Bauwerk gezeichnet wurde. Genau daran sollen sich Wände ausrichten
     * — ein Bauwerk steht auf einem Raster, und die Himmelsrichtung ist dabei
     * ohne Belang.
     *
     * Ohne Modell (Gelände, freier Globus) bleibt die Liste leer; dann gibt es
     * kein Raster, an dem sich etwas ausrichten ließe, und `einrasten()`
     * überspringt den Schritt.
     */
    _modellAchsen: function (assetId, hoch) {
      var rahmen = assetId ? this._rahmen(assetId) : null;
      if (!rahmen) return [];

      var achsen = [];
      [Cesium.Cartesian3.UNIT_X, Cesium.Cartesian3.UNIT_Y].forEach(function (e) {
        var v = Cesium.Matrix4.multiplyByPointAsVector(rahmen, e, C3());
        var anteil = Cesium.Cartesian3.dot(v, hoch);
        Cesium.Cartesian3.subtract(
          v, Cesium.Cartesian3.multiplyByScalar(hoch, anteil, C3()), v);
        if (Cesium.Cartesian3.magnitude(v) < 1e-6) return;   // Achse steht senkrecht
        Cesium.Cartesian3.normalize(v, v);
        achsen.push(v);
        achsen.push(Cesium.Cartesian3.negate(v, C3()));
      });
      return achsen;
    },

    /**
     * Legt eine neue Bildebene an den Treffer — in Startgröße.
     *
     * Ihre endgültige Größe bekommt sie beim Aufziehen; hier steht sie nur
     * so groß da, dass beim Drücken sofort etwas zu sehen ist. Das
     * Seitenverhältnis kommt aus der Vorlage und wird NICHT hier gemessen:
     * beim Aufziehen wird es je Zeigerzug gebraucht, und eine Messung, die
     * erst später fertig wird, ließe die ersten Züge verzerrt.
     */
    anlegen: function (treffer, vorlage) {
      if (!vorlage) return null;
      var verhaeltnis = vorlage.verhaeltnis || 1;
      var breite = vorlage.breite_m || BREITE_STANDARD;

      var ebene = {
        id: 'be' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        titel: vorlage.titel || 'Bild',
        quelle: { schluessel: vorlage.schluessel, index: vorlage.index },
        breite_m: breite,
        hoehe_m: vorlage.hoehe_m || breite * verhaeltnis,
        drehung: 0,
        versatz: VERSATZ_STANDARD,
        deckkraft: 1,
        sichtbar: true
      };
      this._verankern(ebene, treffer);
      this.ebenen.push(ebene);
      this.auswahl = ebene.id;
      this._nachziehen(ebene, true);
      return ebene;
    },

    /**
     * Schreibt Ort und Lage in den Rahmen des getroffenen Modells.
     *
     * Wurde ein geladenes Modell getroffen, werden Mitte, Normale und
     * Rechtsachse mit der Umkehrmatrix seiner Kachelwurzel in dessen
     * Koordinaten umgerechnet und der `anker` gesetzt. Danach ist die Ebene
     * von jeder Verschiebung des Modells unabhängig — sie macht sie mit.
     *
     * Vorausgesetzt ist dabei, dass die Kachelmatrix drehstarr ist (Drehung
     * und Verschiebung, keine Skalierung): nur dann darf man eine Normale
     * mit derselben Matrix transformieren wie einen Punkt. Für die
     * Georeferenzierung eines IFC-Modells trifft das zu.
     */
    _verankern: function (ebene, treffer) {
      var rahmen = treffer.assetId ? this._rahmen(treffer.assetId) : null;
      var rechts = basis(treffer.normale, treffer.mitte);

      if (rahmen) {
        var inv = Cesium.Matrix4.inverse(rahmen, new Cesium.Matrix4());
        ebene.anker = treffer.assetId;
        ebene.mitte = alsFeld(Cesium.Matrix4.multiplyByPoint(inv, treffer.mitte, C3()));
        ebene.normale = alsFeld(Cesium.Cartesian3.normalize(
          Cesium.Matrix4.multiplyByPointAsVector(inv, treffer.normale, C3()), C3()));
        ebene.rechts = alsFeld(Cesium.Cartesian3.normalize(
          Cesium.Matrix4.multiplyByPointAsVector(inv, rechts, C3()), C3()));
      } else {
        ebene.anker = null;
        ebene.mitte = alsFeld(treffer.mitte);
        ebene.normale = alsFeld(treffer.normale);
        ebene.rechts = alsFeld(rechts);
      }
      ebene.matrixVorher = null;
    },

    /** Die Kachelmatrix eines Modells, oder null wenn es nicht (mehr) geladen ist. */
    _rahmen: function (assetId) {
      var asset = BimViewer.loadedAssets && BimViewer.loadedAssets.get(String(assetId));
      var wurzel = asset && asset.tileset && asset.tileset.root;
      return (wurzel && wurzel.computedTransform) || null;
    },

    // ── Darstellung ────────────────────────────────────────────────────────

    /**
     * Baut die Flächen einer Ebene, wenn es noch keine gibt, und setzt ihre
     * Matrizen neu.
     *
     * `neubau` erzwingt das Neuanlegen — nötig, wenn das Bild gewechselt hat.
     * Der Regelfall ist es nicht: Breite, Drehung, Versatz und Ort landen
     * alle in den Matrizen, und die kosten nichts.
     *
     * **Mehrere Flächen, wenn das Bild gekachelt ist.** Ein A0-Plan, der auf
     * 118 m Breite im Modell liegt, ist mit einer einzigen 4096er-Textur beim
     * Hineinzoomen unlesbar (drei Bildpunkte je Zentimeter Bauwerk). Mehr als
     * eine Texturgröße geht aber nicht in EINE Textur — deshalb ein Raster
     * aus Kacheln, jede mit eigener Fläche und eigener Textur. Die Geometrie
     * bleibt dieselbe: jede Kachel ist wieder das Einheitsquadrat, ihre Lage
     * und Größe stehen wieder nur in der Matrix.
     */
    _nachziehen: function (ebene, neubau) {
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      if (!szene) return;

      if (!ebene.sichtbar) { this._entfernen(ebene); return; }

      // Wird das Bild projiziert (bildprojektion.js), darf das Rechteck nicht
      // zusätzlich dastehen: dasselbe Bild zweimal, einmal auf der Wand und
      // einmal zwei Zentimeter davor, und die beiden kämpfen um dieselben
      // Bildpunkte.
      if (ebene.projektion) { this._entfernen(ebene); return; }

      // Eine verankerte Ebene ohne ihr Modell hätte keine Weltlage: ihre
      // Koordinaten stehen im Kachelrahmen, und der fehlt. Ohne diese Sperre
      // gälten sie als Weltkoordinaten und das Bild stünde irgendwo in der
      // Nähe des Erdmittelpunkts. Es wartet stattdessen, bis das Modell da
      // ist — `_wachen()` kommt jedes Bild wieder vorbei.
      if (ebene.anker && !this._rahmen(ebene.anker)) { this._entfernen(ebene); return; }

      var schluessel = ebene.quelle.schluessel + ':' + ebene.quelle.index;
      var daten = this._cache[schluessel];
      if (!daten) { this._nachladen(ebene); return; }

      if (neubau) this._entfernen(ebene);

      var satz = this._kachelCache[schluessel];
      var bilder = (satz && satz.kacheln) || [daten];
      var spalten = (satz && satz.spalten) || 1;
      var zeilen = (satz && satz.zeilen) || 1;

      if (!ebene._flaechen || ebene._flaechen.length !== bilder.length) {
        this._entfernen(ebene);
        ebene._flaechen = bilder.map(function (bild) {
          var flaeche = new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({ geometry: einheitsquadrat() }),
            appearance: new Cesium.MaterialAppearance({
              material: Cesium.Material.fromType('Image', { image: bild }),
              // Kein Licht auf einem Plan — siehe Kopfkommentar.
              flat: true,
              faceForward: false,
              translucent: true,
              // `closed: false` schaltet zugleich das Aussortieren der
              // Rückseiten ab: ein Bild an einer Innenwand soll auch von der
              // anderen Seite zu sehen sein, wenn man um die Wand herumgeht.
              closed: false
            }),
            // Zwei Dreiecke — der Umweg über den Arbeitsthread kostet mehr,
            // als er spart, und verzögert das Erscheinen um ein Bild.
            asynchronous: false,
            // Eine Auflage über dem Bauwerk. Finge sie die Klicks ab, käme man
            // an das Bauteil darunter nicht mehr heran — und genau das ist das
            // Bauteil, um das es geht.
            allowPicking: false
          });
          szene.primitives.add(flaeche);
          return flaeche;
        });
      }

      var matrizen = this.kachelMatrizen(ebene, spalten, zeilen);
      ebene._flaechen.forEach(function (flaeche, i) {
        var stoff = flaeche.appearance && flaeche.appearance.material;
        if (stoff && stoff.uniforms) {
          stoff.uniforms.color = new Cesium.Color(1, 1, 1, ebene.deckkraft);
        }
        flaeche.modelMatrix = matrizen[i];
      });
    },

    /**
     * Die Matrizen aller Kacheln, von links oben zeilenweise.
     *
     * Dieselbe Reihenfolge, in der `svgKacheln()` sie erzeugt — und die läuft
     * über die viewBox, deren y NACH UNTEN zählt. In der Bildebene zählt
     * `oben` nach oben; Zeile 0 liegt deshalb am OBEREN Rand, also bei
     * +hoehe/2. Diese eine Umkehr ist der ganze Unterschied zwischen einem
     * Plan und einem Plan, dessen Zeilen von unten nach oben aufgereiht sind
     * — und den sieht man an einer symmetrischen Zeichnung erst spät.
     */
    kachelMatrizen: function (ebene, spalten, zeilen) {
      var lage = this.weltlage(ebene);
      var mitte = lage.mitte;
      if (ebene.versatz) {
        Cesium.Cartesian3.add(
          mitte, Cesium.Cartesian3.multiplyByScalar(lage.n, ebene.versatz, C3()), mitte);
      }
      var kb = ebene.breite_m / spalten;
      var kh = ebene.hoehe_m / zeilen;

      var matrizen = [];
      for (var iy = 0; iy < zeilen; iy++) {
        for (var ix = 0; ix < spalten; ix++) {
          var du = (ix + 0.5) * kb - ebene.breite_m / 2;
          var dv = ebene.hoehe_m / 2 - (iy + 0.5) * kh;
          var km = Cesium.Cartesian3.add(mitte,
            Cesium.Cartesian3.add(
              Cesium.Cartesian3.multiplyByScalar(lage.rechts, du, C3()),
              Cesium.Cartesian3.multiplyByScalar(lage.oben, dv, C3()), C3()), C3());
          matrizen.push(matrixAus(km, lage.rechts, lage.oben, lage.n, kb, kh));
        }
      }
      return matrizen;
    },

    /**
     * Ort und Achsen einer Ebene in Weltkoordinaten — Anker angewandt,
     * Drehung eingerechnet, Abhebung NOCH NICHT.
     *
     * Getrennt von `matrix()`, weil drei Stellen dieselbe Rechnung brauchen:
     * die Matrix, der Griff beim Schieben (liegt der Zeiger im Rechteck?) und
     * das Aufziehen (in welcher Ebene wächst das Rechteck?). Die Abhebung
     * bleibt draußen, weil `mitte` die Größe ist, die zurückgeschrieben wird
     * — sie enthielte sonst beim nächsten Zug den Versatz doppelt.
     *
     * Alle Vektoren sind frisch: die Rückgabe wird beim Schieben je Zeigerzug
     * gelesen, und ein zwischengespeicherter Vektor, den jemand nebenbei
     * normalisiert, wäre der Fehler, den man erst am dritten Bild sieht.
     */
    weltlage: function (ebene) {
      var mitte = ausFeld(ebene.mitte);
      var n = ausFeld(ebene.normale);
      var r0 = ausFeld(ebene.rechts);

      var rahmen = ebene.anker ? this._rahmen(ebene.anker) : null;
      if (rahmen) {
        Cesium.Matrix4.multiplyByPoint(rahmen, mitte, mitte);
        Cesium.Cartesian3.normalize(
          Cesium.Matrix4.multiplyByPointAsVector(rahmen, n, n), n);
        Cesium.Cartesian3.normalize(
          Cesium.Matrix4.multiplyByPointAsVector(rahmen, r0, r0), r0);
      }

      if (ebene.drehung) {
        var q = Cesium.Quaternion.fromAxisAngle(n, Cesium.Math.toRadians(ebene.drehung));
        Cesium.Matrix3.multiplyByVector(Cesium.Matrix3.fromQuaternion(q), r0, r0);
        Cesium.Cartesian3.normalize(r0, r0);
      }

      var oben = Cesium.Cartesian3.cross(n, r0, C3());
      Cesium.Cartesian3.normalize(oben, oben);
      return { mitte: mitte, n: n, rechts: r0, oben: oben };
    },

    /** Die Weltmatrix einer Ebene: Lage, abgehoben, auf Breite und Höhe gebracht. */
    matrix: function (ebene) {
      var lage = this.weltlage(ebene);
      var mitte = lage.mitte;
      if (ebene.versatz) {
        Cesium.Cartesian3.add(
          mitte, Cesium.Cartesian3.multiplyByScalar(lage.n, ebene.versatz, C3()), mitte);
      }
      return matrixAus(mitte, lage.rechts, lage.oben, lage.n,
                       ebene.breite_m, ebene.hoehe_m);
    },

    _entfernen: function (ebene) {
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      (ebene._flaechen || []).forEach(function (flaeche) {
        try { if (szene) szene.primitives.remove(flaeche); }
        catch (e) { /* schon fort */ }
      });
      ebene._flaechen = null;
    },

    /**
     * Zieht verankerte Ebenen nach, wenn ihr Modell gerückt ist.
     *
     * Läuft auf `scene.preUpdate`, also je Bild — wie die Wache in
     * explosion.js. Der Vergleich ist eine Matrix je Ebene; bei einer
     * Handvoll Bildern ist das nichts, und die Alternative wäre, jedem der
     * drei Wege, die eine Kachelmatrix ändern (terrain-align, z-offset,
     * Modellwechsel), einen Rückruf hierher anzuhängen.
     *
     * Nachgezogen wird die MATRIX, nicht die Geometrie — nur deshalb darf
     * das je Bild laufen. Das ist der Zweck des Einheitsquadrats.
     */
    _wachen: function () {
      var self = this;
      this.ebenen.forEach(function (ebene) {
        if (!ebene.sichtbar || ebene._fehlt) return;

        // Ebenen, deren Bild noch aus IndexedDB kommt oder deren Modell noch
        // nicht geladen war, bekommen hier ihre zweite Gelegenheit.
        if (!ebene._flaechen) { self._nachziehen(ebene); return; }
        if (!ebene.anker) return;

        var rahmen = self._rahmen(ebene.anker);
        if (!rahmen) return;
        if (ebene.matrixVorher && Cesium.Matrix4.equals(ebene.matrixVorher, rahmen)) return;
        ebene.matrixVorher = Cesium.Matrix4.clone(rahmen, ebene.matrixVorher);

        var satz = self._kachelCache[ebene.quelle.schluessel + ':' + ebene.quelle.index];
        var matrizen = self.kachelMatrizen(ebene,
          (satz && satz.spalten) || 1, (satz && satz.zeilen) || 1);
        ebene._flaechen.forEach(function (flaeche, i) { flaeche.modelMatrix = matrizen[i]; });
      });
    },

    // ── Bilder beschaffen ──────────────────────────────────────────────────

    /**
     * Macht aus Dateien eine Skizze vom Typ „Medien" und wählt die erste als
     * Vorlage.
     *
     * Derselbe Weg wie in plan-media.js, und aus demselben Grund: ein Bild,
     * das nur an einer Wand im Modell hängt, ist im Berichtstool unsichtbar
     * und beim nächsten Plan wieder von der Platte zu suchen. Als Skizze
     * steht es überall zur Verfügung.
     */
    dateienAufnehmen: async function (dateien, titel) {
      var laden = BimViewer.SkizzenStore;
      if (!laden || !laden.verfuegbar()) {
        melden('Das Skizzenarchiv steht nicht zur Verfügung (IndexedDB blockiert).', 'error');
        return null;
      }

      var medien = [];
      this._letzterFehler = null;
      for (var i = 0; i < dateien.length; i++) {
        var datei = dateien[i];
        if (/\.pdf$/i.test(datei.name) || datei.type === 'application/pdf') {
          var ausPdf = await this._pdfAufnehmen(datei);
          if (ausPdf) medien.push(ausPdf);
          continue;
        }
        if (!/^image\//.test(datei.type) && !/\.svg$/i.test(datei.name)) continue;
        var roh = await laden.dateiLesen(datei);

        // Ein eingescannter Plan hat dasselbe Problem wie ein PDF, nur
        // umgekehrt: die Auflösung IST da, sie passt bloß nicht in eine
        // Textur. Vergrößert wird dabei nichts — mehr Pixel, als die Datei
        // hat, sind keine Information.
        var satzBild = await bildKacheln(roh);
        var eintragBild = {
          name: datei.name.replace(/\.[^.]+$/, ''),
          gruppe: 'Medien',
          mime: 'image/png',
          daten: await rastern(roh)
        };
        if (satzBild) {
          eintragBild.kacheln = satzBild.kacheln;
          eintragBild.raster = { spalten: satzBild.spalten, zeilen: satzBild.zeilen,
                                 breitePx: satzBild.breitePx, hoehePx: satzBild.hoehePx };
        }
        medien.push(eintragBild);
      }
      if (!medien.length) {
        // Nur wenn nichts Genaueres bekannt ist. Eine Datei, die aus einem
        // benennbaren Grund gescheitert ist, hat ihre Meldung schon gesetzt —
        // sie hier zu übermalen war der Fehler, der aus „das Backend kennt
        // /plan/pdf nicht" ein ratloses „keine verwertbare Datei" machte.
        if (!this._letzterFehler) {
          melden('Keine verwertbare Datei dabei — Bild, SVG oder PDF.', 'error');
        }
        return null;
      }

      var vorschau = await laden.vorschauBauen(medien[0].daten, 320);
      var jobId = (BimViewer.PlanPanel && BimViewer.PlanPanel.jobId) || null;

      var kurz = await laden.speichern({
        typ: 'medien',
        titel: titel || (medien.length === 1 ? medien[0].name : medien.length + ' Bilder'),
        jobId: jobId,
        vorschau: vorschau,
        medien: medien,
        notiz: 'als Bildebene ins Modell gelegt'
      });

      var self = this;
      medien.forEach(function (m, index) {
        self._cache[kurz.schluessel + ':' + index] = m.daten;
        if (m.kacheln) {
          self._kachelCache[kurz.schluessel + ':' + index] = {
            kacheln: m.kacheln, spalten: m.raster.spalten, zeilen: m.raster.zeilen
          };
        }
      });

      this.vorlage = {
        schluessel: kurz.schluessel, index: 0,
        titel: medien[0].name,
        breite_m: medien[0].breite_m || null,
        hoehe_m: medien[0].hoehe_m || null,
        // Das Seitenverhältnis steht VOR dem ersten Zeigerzug fest — beim
        // Aufziehen wird es je Zug gebraucht, und eine Messung, die erst
        // später fertig wird, ließe die ersten Züge verzerrt.
        verhaeltnis: await verhaeltnisVon(medien[0])
      };
      this._hinweis('„' + medien[0].name + '" bereit — „Setzen", dann im Modell ' +
                    'ein Rechteck aufziehen.');
      return this.vorlage;
    },

    /**
     * Eine PDF-Seite über das Backend zu einem gerasterten Bild machen.
     *
     * `POST /plan/pdf` liefert Vektor-SVG und Papiergröße — derselbe
     * Endpunkt, den plan-pdf.js für Blattvorlagen benutzt, und deshalb hier
     * kein zweiter im Backend. Der Maßstab wird gleich hier abgefragt: aus
     * ihm und der Papiergröße folgt die Breite in Metern, und ohne ihn wäre
     * die Vorlage nachher eine unter vielen, deren Größe niemand mehr weiß.
     */
    _pdfAufnehmen: async function (datei, seiteWunsch) {
      var seite = seiteWunsch || 1;

      // Ein PDF ist die einzige Vorlage, die NICHT im Browser entsteht: die
      // Umwandlung in ein Vektor-SVG macht `pdf2svg` im Backend. Steht das
      // nicht, steht auch dieser Weg — und dann muss dastehen, WARUM.
      var adresse = BimViewer.getBackendUrl() + '/plan/pdf';
      melden('PDF wird umgewandelt …', 'loading');
      var daten;
      try {
        var formular = new FormData();
        formular.append('datei', datei);
        formular.append('seite', String(seite));
        var antwort;
        try {
          antwort = await fetch(adresse, { method: 'POST', body: formular });
        } catch (netz) {
          // `fetch` wirft bei einem toten Server, bei einem abgelehnten
          // CORS-Zugriff und bei einem falschen Schema dieselbe nackte
          // Meldung („Failed to fetch"). Die Adresse dazuzuschreiben ist der
          // Unterschied zwischen einer Fehlermeldung und einem Hinweis.
          throw new Error('das Backend unter ' + adresse + ' ist nicht erreichbar. ' +
            'Läuft es, und stimmt die Adresse im Panel „Modelle" → „Eigenes Backend"? ' +
            '(' + netz.message + ')');
        }

        if (!antwort.ok) throw new Error(await fehlertext(antwort, adresse));
        daten = await antwort.json();
        if (!daten || typeof daten.svg !== 'string' || !daten.breite_mm) {
          throw new Error('das Backend hat kein SVG zurückgegeben (' + adresse + ').');
        }
      } catch (e) {
        // Die Meldung wird gemerkt, nicht nur gezeigt: `dateienAufnehmen()`
        // schreibt sonst gleich darauf sein allgemeines „keine verwertbare
        // Datei" darüber, und dann steht die eigentliche Ursache nirgends.
        this._letzterFehler = 'PDF nicht umwandelbar — ' + e.message;
        melden(this._letzterFehler, 'error');
        console.warn('[Bildebenen] PDF-Umwandlung fehlgeschlagen', adresse, e);
        return null;
      }

      // Ein Plansatz hat den gesuchten Grundriss selten auf Seite 1. Gefragt
      // wird erst NACH der ersten Antwort, weil erst sie die Seitenzahl kennt
      // — und nur dann, wenn es überhaupt etwas zu wählen gibt.
      if (!seiteWunsch && daten.seiten > 1) {
        var wunsch = window.prompt(
          '„' + datei.name + '" hat ' + daten.seiten + ' Seiten.\n' +
          'Welche soll in das Modell?', '1');
        if (wunsch === null) {
          // Ein Abbruch ist kein Fehler, aber er darf die Anzeige nicht auf
          // „wird umgewandelt …" stehen lassen — das sähe aus wie ein Hänger.
          this._letzterFehler = 'Abgebrochen.';
          melden('Seitenwahl abgebrochen — es wurde nichts geladen.', '');
          return null;
        }
        var nummer = parseInt(wunsch, 10);
        if (isFinite(nummer) && nummer >= 1 && nummer <= daten.seiten && nummer !== 1) {
          return this._pdfAufnehmen(datei, nummer);
        }
      }

      var eingabe = window.prompt(
        'In welchem Maßstab wurde „' + datei.name + '" geplottet?\n' +
        'Als „1:100" eingeben — dann folgt die Breite aus der Papiergröße (' +
        Math.round(daten.breite_mm) + ' × ' + Math.round(daten.hoehe_mm) + ' mm).\n' +
        'Leer lassen, um die Breite unten in Metern selbst einzutragen.', '1:100');
      var massstab = massstabAusEingabe(eingabe);

      // Auf die lange Kante rastern — in der gewählten Stufe, und wenn die
      // über eine Texturgröße hinausgeht, als Kachelraster. Ein A0-Plan auf
      // 118 m Modellbreite ist mit einer 4096er-Textur beim Hineinzoomen
      // unlesbar; siehe die Herleitung bei `AUFLOESUNGEN`.
      var stufe = AUFLOESUNGEN[this.aufloesung] || AUFLOESUNGEN.hoch;
      var lang = Math.max(daten.breite_mm, daten.hoehe_mm, 1);
      var faktor = stufe.px / lang;
      var gesamtB = Math.max(1, Math.round(daten.breite_mm * faktor));
      var gesamtH = Math.max(1, Math.round(daten.hoehe_mm * faktor));

      var svgUri = 'data:image/svg+xml;base64,' + textZuBase64(daten.svg);
      var uebersichtF = kachelMax() / lang;
      // Die Übersicht bleibt EIN Bild in Kachelgröße: sie ist es, die in der
      // Galerie, im Skizzenarchiv und im Bericht auftaucht, und dort wäre ein
      // Raster aus zwölf Teilen unbrauchbar.
      var uebersicht = await rastern(svgUri,
        Math.max(1, Math.round(daten.breite_mm * uebersichtF)),
        Math.max(1, Math.round(daten.hoehe_mm * uebersichtF)));

      melden('PDF wird in ' + stufe.px + ' px gerastert …', 'loading');
      var satz = (gesamtB > kachelMax() || gesamtH > kachelMax())
        ? await svgKacheln(daten.svg, gesamtB, gesamtH)
        : null;

      var eintrag = {
        name: datei.name.replace(/\.pdf$/i, '') + (daten.seiten > 1 ? ' (S. ' + seite + ')' : ''),
        gruppe: 'Medien',
        mime: 'image/png',
        daten: uebersicht,
        // Papiermaße bleiben stehen: nur mit ihnen lässt sich der Maßstab
        // später noch einmal ändern, ohne das PDF erneut hochzuladen.
        breite_mm: daten.breite_mm,
        hoehe_mm: daten.hoehe_mm,
        massstab: massstab
      };
      if (satz) {
        eintrag.kacheln = satz.kacheln;
        eintrag.raster = { spalten: satz.spalten, zeilen: satz.zeilen,
                           breitePx: satz.breitePx, hoehePx: satz.hoehePx };
      }
      if (massstab) {
        eintrag.breite_m = daten.breite_mm / 1000 * massstab;
        eintrag.hoehe_m = daten.hoehe_mm / 1000 * massstab;
      }
      var aufloesungstext = satz
        ? ' — ' + satz.breitePx + ' × ' + satz.hoehePx + ' px in ' +
          (satz.spalten * satz.zeilen) + ' Kacheln (' +
          Math.round(speicherMb(satz.breitePx, satz.hoehePx)) + ' MB Grafikspeicher)'
        : '';
      melden((massstab
        ? 'PDF geladen — 1:' + massstab + ', ' + eintrag.breite_m.toFixed(2) + ' m breit'
        : 'PDF geladen — Breite in Metern über das Aufziehen') + aufloesungstext + '.',
        'success');
      return eintrag;
    },

    /** Holt ein Bild aus dem Skizzenarchiv in den Laufzeitspeicher. */
    _nachladen: async function (ebene) {
      var schluessel = ebene.quelle.schluessel + ':' + ebene.quelle.index;
      if (this._laden[schluessel] || this._cache[schluessel] || ebene._fehlt) return;
      if (!BimViewer.SkizzenStore) return;
      this._laden[schluessel] = true;
      try {
        var skizze = await BimViewer.SkizzenStore.laden(ebene.quelle.schluessel);
        var m = skizze && skizze.medien && skizze.medien[ebene.quelle.index];
        if (m && m.daten) {
          this._cache[schluessel] = m.daten;
          if (m.kacheln && m.raster) {
            this._kachelCache[schluessel] = {
              kacheln: m.kacheln, spalten: m.raster.spalten, zeilen: m.raster.zeilen
            };
          }
          this._nachziehen(ebene, true);
        } else {
          // Die Skizze ist gelöscht worden. Das einmal zu merken ist keine
          // Feinheit: `_wachen()` läuft je Bild, und ohne die Marke wäre das
          // sechzig erfolglose IndexedDB-Abfragen in der Sekunde, solange die
          // verwaiste Ebene in der Liste steht.
          ebene._fehlt = true;
          console.warn('Bildebene „' + ebene.titel + '": Bild nicht mehr im Skizzenarchiv');
        }
      } catch (e) {
        ebene._fehlt = true;
      }
      delete this._laden[schluessel];
    },

    // ── Regler ─────────────────────────────────────────────────────────────

    finden: function (id) {
      for (var i = 0; i < this.ebenen.length; i++) {
        if (this.ebenen[i].id === id) return this.ebenen[i];
      }
      return null;
    },

    /**
     * Ändert ein Maß einer Ebene und zieht sie nach.
     *
     * Ein Weg für alle vier Regler statt vier fast gleicher Funktionen. Die
     * Breite zieht die Höhe mit, damit das Seitenverhältnis stehen bleibt —
     * es aus der Datei zu holen und dann beim Regeln zu verlieren wäre die
     * halbe Arbeit.
     */
    setzen: function (id, feld, wert) {
      var ebene = this.finden(id);
      if (!ebene) return;
      wert = parseFloat(wert);
      if (!isFinite(wert)) return;

      if (feld === 'breite_m') {
        if (wert <= 0) return;
        ebene.hoehe_m = ebene.hoehe_m * wert / ebene.breite_m;
        ebene.breite_m = wert;
      } else if (feld === 'deckkraft') {
        ebene.deckkraft = Math.max(0.05, Math.min(1, wert));
      } else {
        ebene[feld] = wert;
      }
      this.sichern();
      this._nachziehen(ebene);
      this._werteZeichnen(ebene);
    },

    zeigen: function (id, an) {
      var ebene = this.finden(id);
      if (!ebene) return;
      ebene.sichtbar = !!an;
      this.sichern();
      if (BimViewer.Bildprojektion) BimViewer.Bildprojektion.nachziehen();
      if (an) { this._nachziehen(ebene, true); return; }
      this._entfernen(ebene);
      // Ein ausgeblendetes Bild lässt sich nicht greifen — der scharfe
      // Schiebemodus wäre danach ein Zeiger, der nichts mehr tut.
      if (this.schiebemodus === id) this.schiebenStarten(id);
    },

    loeschen: function (id) {
      var ebene = this.finden(id);
      if (!ebene) return;
      if (this.schiebemodus === id) { this.schiebemodus = null; this._handlerAus(); }
      this._entfernen(ebene);
      this.ebenen = this.ebenen.filter(function (e) { return e !== ebene; });
      if (this.auswahl === id) this.auswahl = null;
      this.sichern();
      if (BimViewer.Bildprojektion) BimViewer.Bildprojektion.nachziehen();
      this._listeZeichnen();
    },

    /** Zeigt die Ebene formatfüllend — die Kamera senkrecht davor. */
    anfliegen: function (id) {
      var ebene = this.finden(id);
      var viewer = BimViewer.viewer;
      if (!ebene || !viewer) return;

      var m = this.matrix(ebene);
      var mitte = Cesium.Matrix4.getTranslation(m, C3());
      var n = Cesium.Matrix3.getColumn(
        Cesium.Matrix4.getMatrix3(m, new Cesium.Matrix3()), 2, C3());
      Cesium.Cartesian3.normalize(n, n);

      // Abstand so, dass die längere Kante das Bild füllt.
      var abstand = Math.max(ebene.breite_m, ebene.hoehe_m) * 1.3;
      var ziel = Cesium.Cartesian3.add(
        mitte, Cesium.Cartesian3.multiplyByScalar(n, abstand, C3()), C3());

      // Spalte 1 trägt die Höhe als Länge — die Kamera erwartet einen
      // Einheitsvektor, sonst kippt die Ansicht bei einem hohen Bild.
      var oben = Cesium.Matrix3.getColumn(
        Cesium.Matrix4.getMatrix3(m, new Cesium.Matrix3()), 1, C3());
      Cesium.Cartesian3.normalize(oben, oben);

      viewer.camera.flyTo({
        destination: ziel,
        orientation: { direction: Cesium.Cartesian3.negate(n, C3()), up: oben },
        duration: 1.2
      });
    },

    // ── Ablage ─────────────────────────────────────────────────────────────

    /**
     * Sichert die Ebenen — ohne Primitive, ohne Bilddaten, ohne Cache-Matrix.
     *
     * Was hier hineingerät, geht bei jedem Reglerzug durch `JSON.stringify`;
     * ein versehentlich mitgeschriebenes Primitive wäre ein Zyklus und damit
     * eine Ausnahme statt eines gesicherten Zustands.
     */
    sichern: function () {
      try {
        localStorage.setItem(SPEICHER, JSON.stringify(this.ebenen.map(function (e) {
          return {
            id: e.id, titel: e.titel, quelle: e.quelle, anker: e.anker,
            mitte: e.mitte, normale: e.normale, rechts: e.rechts,
            breite_m: e.breite_m, hoehe_m: e.hoehe_m, drehung: e.drehung,
            versatz: e.versatz, deckkraft: e.deckkraft, sichtbar: e.sichtbar,
            // bildprojektion.js — die Ebene bleibt der Ort, die Projektion
            // ist eine Eigenschaft von ihr und gehört in dieselbe Ablage.
            projektion: e.projektion, proj_tiefe: e.proj_tiefe,
            proj_winkel: e.proj_winkel, proj_abstand: e.proj_abstand
          };
        })));
      } catch (e) { /* privates Fenster — dann eben nur für diese Sitzung */ }
    },

    laden: function () {
      if (this._geladen) return;
      this._geladen = true;
      var roh = null;
      try { roh = localStorage.getItem(SPEICHER); } catch (e) { return; }
      if (!roh) return;
      try {
        var liste = JSON.parse(roh);
        if (!Array.isArray(liste)) return;
        this.ebenen = liste.filter(function (e) { return e && e.quelle && e.mitte; });
      } catch (e) { /* kaputter Eintrag — dann ohne */ }
    },

    // ── Panel ──────────────────────────────────────────────────────────────

    panelHtml: function () {
      var ausrichtung = Object.keys(AUSRICHTUNGEN).map(function (k) {
        return '<option value="' + k + '">' + esc(AUSRICHTUNGEN[k]) + '</option>';
      }).join('');
      var stufen = Object.keys(AUFLOESUNGEN).map(function (k) {
        return '<option value="' + k + '">' + esc(AUFLOESUNGEN[k].name) + '</option>';
      }).join('');

      return '' +
        '<div class="hint">Ein Bild, ein Scan oder ein PDF-Plan wird als Rechteck ' +
          'in das Modell aufgezogen — auf der Fläche, die beim Drücken getroffen ' +
          'wird. Für Bestandspläne über einem Geschoss, Fassadenfotos an einer ' +
          'Wand oder eine Textur auf einem Bauteil.</div>' +

        '<div class="btn-group" style="margin-bottom:8px;">' +
          '<button class="btn btn--sm" id="beDatei">Bild oder PDF wählen …</button>' +
          '<button class="btn btn--sm btn--primary" id="beSetzen">Setzen</button>' +
        '</div>' +
        '<input type="file" id="beDateiEingabe" accept="image/*,.svg,.pdf" multiple ' +
               'style="display:none;">' +
        '<div class="hint" id="beHinweis">Dateien lassen sich auch direkt in die Szene ' +
          'ziehen — dann wird an der Stelle gesetzt, an der man loslässt.</div>' +

        '<div class="row">' +
          '<span class="row__label">Seitenverhältnis sperren</span>' +
          '<label class="switch">' +
            '<input type="checkbox" id="beSperre" checked>' +
            '<span class="switch__track"></span>' +
          '</label>' +
        '</div>' +
        '<div class="hint">Gesperrt behält das Bild sein Format, gleich wie man ' +
          'zieht — die längere gezogene Kante gibt die Größe vor. Offen lässt es ' +
          'sich beliebig verzerren, etwa um einen schief eingescannten Plan auf ' +
          'zwei bekannte Punkte zu bringen.</div>' +

        '<div class="field">' +
          '<label class="field__label" for="beAusrichtung">Ausrichtung</label>' +
          '<select class="select" id="beAusrichtung">' + ausrichtung + '</select>' +
        '</div>' +

        '<div class="row">' +
          '<span class="row__label">Ins Lot und auf die Achsen einrasten</span>' +
          '<label class="switch">' +
            '<input type="checkbox" id="beEinrasten" checked>' +
            '<span class="switch__track"></span>' +
          '</label>' +
        '</div>' +
        '<div class="hint">Eine Wand ist lotrecht, eine Decke waagerecht — was ' +
          'die Messung an Restneigung übriglässt, ist Rauschen. Bis ' + RAST_GRAD +
          '° wird deshalb ins Lot gezogen und, wenn die Wand nah an einer Achse ' +
          'des Bauwerks steht, auch darauf. Ein wirklich geneigtes Dach bleibt ' +
          'unberührt. Ausschalten, wenn eine Fläche bewusst schräg getroffen ' +
          'werden soll.</div>' +

        '<div class="field">' +
          '<label class="field__label" for="beAufloesung">Auflösung neuer Pläne</label>' +
          '<select class="select" id="beAufloesung">' + stufen + '</select>' +
          '<div class="hint" id="beAufloesungHinweis"></div>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section__label">Aus dem Skizzenarchiv</div>' +
          '<div class="bildebenen-galerie" id="beGalerie"></div>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section__label">Gesetzte Bildebenen</div>' +
          '<div id="beListe"></div>' +
        '</div>';
    },

    /**
     * Was die gewählte Stufe an einem A0-Blatt bedeutet.
     *
     * Am A0 und nicht am gerade geladenen Plan, weil der beim Einstellen noch
     * gar nicht gewählt ist — und weil A0 das Format ist, an dem die Frage
     * überhaupt auftritt. Ein A4-Detail ist in jeder Stufe scharf.
     *
     * Die Zahlen stehen da, weil sie beide zählen: die Schrifthöhe sagt, ob
     * man den Plan lesen kann, der Speicher, ob das Fenster es überlebt.
     */
    _aufloesungHinweis: function () {
      var el = document.getElementById('beAufloesungHinweis');
      if (!el) return;
      var stufe = AUFLOESUNGEN[this.aufloesung] || AUFLOESUNGEN.hoch;

      var jeMm = stufe.px / 1189;                    // A0 quer
      var hoeheB = stufe.px, hoeheH = Math.round(stufe.px * 841 / 1189);
      var kacheln = Math.ceil(hoeheB / kachelMax()) * Math.ceil(hoeheH / kachelMax());

      el.textContent = 'Auf einem A0-Blatt: ' + jeMm.toFixed(1) + ' Bildpunkte je ' +
        'Millimeter Papier (' + Math.round(jeMm * 25.4) + ' dpi), eine 2,5-mm-Beschriftung ' +
        'also ' + Math.round(jeMm * 2.5) + ' Punkte hoch. ' +
        kacheln + (kacheln === 1 ? ' Kachel, ' : ' Kacheln, ') +
        Math.round(speicherMb(hoeheB, hoeheH)) + ' MB Grafikspeicher je Plan. ' +
        'Wirkt beim nächsten Öffnen einer Datei.';
    },

    _hinweis: function (text) {
      var el = document.getElementById('beHinweis');
      if (el) {
        el.textContent = text || 'Dateien lassen sich auch direkt in die Szene ziehen — ' +
          'dann wird an der Stelle gesetzt, an der man loslässt.';
      }
    },

    _binden: function () {
      var self = this;
      // Das Panel kann vor dem Viewer fertig sein — dann steht die Liste
      // sonst leer da, bis jemand sie durch Zufall neu zeichnen lässt.
      this.laden();

      var knopf = document.getElementById('beDatei');
      var eingabe = document.getElementById('beDateiEingabe');
      if (knopf && eingabe) {
        knopf.onclick = function () { eingabe.click(); };
        eingabe.onchange = async function () {
          if (this.files && this.files.length) {
            await self.dateienAufnehmen(this.files);
            self._galerieZeichnen();
          }
          this.value = '';
        };
      }

      var setzen = document.getElementById('beSetzen');
      if (setzen) setzen.onclick = function () { self.setzenStarten(); };

      var aus = document.getElementById('beAusrichtung');
      if (aus) {
        aus.value = this.ausrichtung;
        aus.onchange = function () { self.ausrichtung = this.value; };
      }

      var rasten = document.getElementById('beEinrasten');
      if (rasten) {
        rasten.checked = this.einrasten;
        rasten.onchange = function () { self.einrasten = this.checked; };
      }

      var stufe = document.getElementById('beAufloesung');
      if (stufe) {
        stufe.value = this.aufloesung;
        stufe.onchange = function () {
          self.aufloesung = this.value;
          self._aufloesungHinweis();
        };
      }
      this._aufloesungHinweis();

      var sperre = document.getElementById('beSperre');
      if (sperre) {
        sperre.checked = this.seitenSperre;
        sperre.onchange = function () { self.seitenSperre = this.checked; };
      }

      this._galerieZeichnen();
      this._listeZeichnen();
    },

    /**
     * Alle Medien aller Skizzen, flach.
     *
     * Bewusst nicht nach Skizze gruppiert — dieselbe Überlegung wie in der
     * Plangalerie: gesucht wird ein Bild, nicht die Rechnung, aus der es
     * stammt. Die Herkunft steht im Tooltip.
     */
    _galerieZeichnen: async function () {
      var ziel = document.getElementById('beGalerie');
      if (!ziel || !BimViewer.SkizzenStore || !BimViewer.SkizzenStore.verfuegbar()) return;
      var self = this;

      var kurz = await BimViewer.SkizzenStore.liste(null);
      var mitMedien = kurz.filter(function (e) { return e.medien > 0; });

      if (!mitMedien.length) {
        ziel.innerHTML = '<div class="hint">Noch keine Bilder abgelegt — oben eine ' +
          'Datei wählen.</div>';
        return;
      }

      var eintraege = [];
      for (var i = 0; i < mitMedien.length; i++) {
        var voll = await BimViewer.SkizzenStore.laden(mitMedien[i].schluessel);
        if (!voll) continue;
        (voll.medien || []).forEach(function (m, index) {
          eintraege.push({
            schluessel: voll.schluessel, index: index, titel: m.name,
            herkunft: voll.titel, daten: m.daten,
            breite_m: m.breite_m || null, hoehe_m: m.hoehe_m || null,
            breite_mm: m.breite_mm || null, hoehe_mm: m.hoehe_mm || null,
            kacheln: m.kacheln || null, raster: m.raster || null
          });
        });
      }

      ziel.innerHTML = eintraege.map(function (e, i) {
        return '<img src="' + e.daten + '" alt="' + esc(e.titel) + '" ' +
               'title="' + esc(e.herkunft + ' — ' + e.titel) + '" data-be-bild="' + i + '">';
      }).join('');

      ziel.querySelectorAll('[data-be-bild]').forEach(function (bild) {
        var eintrag = eintraege[parseInt(bild.dataset.beBild, 10)];
        bild.onclick = async function () {
          self.vorlage = eintrag;
          self._cache[eintrag.schluessel + ':' + eintrag.index] = eintrag.daten;
          if (eintrag.kacheln && eintrag.raster) {
            self._kachelCache[eintrag.schluessel + ':' + eintrag.index] = {
              kacheln: eintrag.kacheln,
              spalten: eintrag.raster.spalten, zeilen: eintrag.raster.zeilen
            };
          }
          ziel.querySelectorAll('img').forEach(function (b) { b.classList.remove('is-gewaehlt'); });
          this.classList.add('is-gewaehlt');
          self._hinweis('„' + eintrag.titel + '" gewählt — „Setzen" drücken, dann im ' +
                        'Modell ein Rechteck aufziehen.');
          // Das Bild liegt hier schon als data:-URI vor; die Messung ist ein
          // Bildaufbau im Speicher und lange fertig, bevor jemand die Maus
          // an der Wand hat.
          eintrag.verhaeltnis = await verhaeltnisVon(eintrag);
        };
      });
    },

    _listeZeichnen: function () {
      var ziel = document.getElementById('beListe');
      if (!ziel) return;
      var self = this;

      if (!this.ebenen.length) {
        ziel.innerHTML = '<div class="hint">Noch keine Bildebene gesetzt.</div>';
        return;
      }

      ziel.innerHTML = this.ebenen.map(function (e) {
        var offen = self.auswahl === e.id;
        var schiebt = self.schiebemodus === e.id;
        return '' +
          '<div class="bildebenen-eintrag' + (offen ? ' is-offen' : '') +
               (schiebt ? ' is-schiebt' : '') + '" data-be="' + e.id + '">' +
            '<div class="bildebenen-kopf">' +
              '<input type="checkbox" data-be-an="' + e.id + '"' + (e.sichtbar ? ' checked' : '') + '>' +
              '<span class="bildebenen-titel" data-be-auf="' + e.id + '">' + esc(e.titel) + '</span>' +
              '<span class="bildebenen-mass">' + e.breite_m.toFixed(2) + ' × ' +
                e.hoehe_m.toFixed(2) + ' m' + self._kachelText(e) + '</span>' +
              '<button class="btn btn--sm' + (schiebt ? ' btn--primary' : '') + '" ' +
                      'data-be-schieb="' + e.id + '" ' +
                      'title="Im Bild drücken und ziehen, um es in seiner Ebene zu ' +
                      'verschieben">✥</button>' +
              '<button class="btn btn--sm" data-be-flug="' + e.id + '" title="Ansehen">⌖</button>' +
              '<button class="btn btn--sm btn--danger" data-be-weg="' + e.id + '" title="Löschen">✕</button>' +
            '</div>' +
            (offen ? self._reglerHtml(e) : '') +
          '</div>';
      }).join('');

      ziel.querySelectorAll('[data-be-an]').forEach(function (el) {
        el.onchange = function () { self.zeigen(this.dataset.beAn, this.checked); };
      });
      ziel.querySelectorAll('[data-be-auf]').forEach(function (el) {
        el.onclick = function () {
          self.auswahl = self.auswahl === this.dataset.beAuf ? null : this.dataset.beAuf;
          self._listeZeichnen();
        };
      });
      ziel.querySelectorAll('[data-be-weg]').forEach(function (el) {
        el.onclick = function () { self.loeschen(this.dataset.beWeg); };
      });
      ziel.querySelectorAll('[data-be-flug]').forEach(function (el) {
        el.onclick = function () { self.anfliegen(this.dataset.beFlug); };
      });
      ziel.querySelectorAll('[data-be-feld]').forEach(function (el) {
        el.oninput = function () { self.setzen(this.dataset.beId, this.dataset.beFeld, this.value); };
      });
      ziel.querySelectorAll('[data-be-hin]').forEach(function (el) {
        el.onclick = function () { self.setzenStarten(this.dataset.beHin); };
      });
      ziel.querySelectorAll('[data-be-schieb]').forEach(function (el) {
        el.onclick = function () { self.schiebenStarten(this.dataset.beSchieb); };
      });

      if (BimViewer.Bildprojektion) BimViewer.Bildprojektion.binden(ziel);
    },

    /** „ · 4×3 Kacheln" hinter dem Maß, oder nichts bei einem einzelnen Bild. */
    _kachelText: function (ebene) {
      var satz = this._kachelCache[ebene.quelle.schluessel + ':' + ebene.quelle.index];
      if (!satz || satz.spalten * satz.zeilen <= 1) return '';
      return ' · ' + satz.spalten + '×' + satz.zeilen;
    },

    _reglerHtml: function (e) {
      var self = this;
      function regler(feld, beschriftung, min, max, schritt, wert, einheit) {
        return '' +
          '<div class="section">' +
            '<div class="section__label">' + beschriftung + '</div>' +
            '<div class="slider-row">' +
              '<input type="range" class="slider" data-be-id="' + e.id + '" data-be-feld="' + feld + '" ' +
                     'min="' + min + '" max="' + max + '" step="' + schritt + '" value="' + wert + '">' +
              '<span class="unit" data-be-wert="' + feld + '">' + wert + ' ' + einheit + '</span>' +
            '</div>' +
          '</div>';
      }
      return '' +
        '<div class="bildebenen-regler">' +
          regler('breite_m', 'Breite', 0.1, Math.max(50, e.breite_m * 2), 0.05,
                 e.breite_m.toFixed(2), 'm') +
          regler('drehung', 'Drehung in der Ebene', -180, 180, 1, e.drehung, '°') +
          regler('versatz', 'Abhebung von der Fläche', -0.5, 1, 0.005,
                 e.versatz.toFixed(3), 'm') +
          regler('deckkraft', 'Deckkraft', 0.05, 1, 0.05, e.deckkraft, '') +
          '<div class="btn-group">' +
            '<button class="btn btn--sm' +
              (self.schiebemodus === e.id ? ' btn--primary' : '') + '" ' +
              'data-be-schieb="' + e.id + '">' +
              (self.schiebemodus === e.id ? 'Schieben beenden' : 'Verschieben') + '</button>' +
            '<button class="btn btn--sm" data-be-hin="' + e.id + '">Neu aufziehen …</button>' +
          '</div>' +
          '<div class="hint">Verschieben heißt: im Bild drücken und ziehen. Es ' +
            'bleibt dabei in seiner Ebene — an einer schrägen Wand also parallel ' +
            'zur Wand, nicht waagerecht davor.</div>' +
          '<div class="hint">Die Abhebung hält das Bild von der Bauteiloberfläche ' +
            'frei; ohne sie kämpfen beide um dieselben Bildpunkte und das Bild ' +
            'flimmert. Ein negativer Wert legt es hinter die Fläche.</div>' +
          (BimViewer.Bildprojektion ? BimViewer.Bildprojektion.reglerHtml(e) : '') +
        '</div>';
    },

    /** Nur die Zahlen neben den Reglern — die Liste bleibt stehen. */
    _werteZeichnen: function (ebene) {
      var kasten = document.querySelector('[data-be="' + ebene.id + '"]');
      if (!kasten) return;
      var texte = {
        breite_m: ebene.breite_m.toFixed(2) + ' m',
        drehung: Math.round(ebene.drehung) + ' °',
        versatz: ebene.versatz.toFixed(3) + ' m',
        deckkraft: ebene.deckkraft.toFixed(2) + ' '
      };
      Object.keys(texte).forEach(function (feld) {
        var el = kasten.querySelector('[data-be-wert="' + feld + '"]');
        if (el) el.textContent = texte[feld];
      });
      var mass = kasten.querySelector('.bildebenen-mass');
      if (mass) mass.textContent = ebene.breite_m.toFixed(2) + ' × ' + ebene.hoehe_m.toFixed(2) + ' m';
    },

    // ── Ziehen und Einfügen ────────────────────────────────────────────────

    /**
     * Datei auf die Szene ziehen → an der Stelle setzen, an der losgelassen
     * wird. Einfügen (Strg/Cmd + V) → in die Bildmitte.
     *
     * Beides hängt am Cesium-Container und nicht am Dokument: plan-media.js
     * hört auf dasselbe Ereignis für das Planblatt, und zwei Empfänger für
     * einen Ablagevorgang legten dieselbe Datei zweimal ab. Solange die
     * Zeichnung offen ist (`plan2dOverlay`), gehört sie dort hin.
     */
    _ziehenInstallieren: function () {
      if (this._installiert) return;
      var behaelter = document.getElementById('cesiumContainer');
      if (!behaelter) return;
      this._installiert = true;
      var self = this;

      function zustaendig() { return !document.getElementById('plan2dOverlay'); }

      behaelter.addEventListener('dragover', function (ereignis) {
        if (!zustaendig()) return;
        ereignis.preventDefault();
        ereignis.dataTransfer.dropEffect = 'copy';
      });

      behaelter.addEventListener('drop', async function (ereignis) {
        if (!zustaendig()) return;
        var dateien = ereignis.dataTransfer && ereignis.dataTransfer.files;
        if (!dateien || !dateien.length) return;
        ereignis.preventDefault();

        // Der Ablageort wird VOR dem Einlesen gemerkt: bei einem PDF liegt
        // dazwischen der Weg zum Backend und eine Rückfrage, und danach ist
        // der Zeiger längst woanders.
        var kasten = behaelter.getBoundingClientRect();
        var stelle = new Cesium.Cartesian2(
          ereignis.clientX - kasten.left, ereignis.clientY - kasten.top);
        var treffer = self.treffer(stelle);

        var vorlage = await self.dateienAufnehmen(dateien);
        if (!vorlage) return;
        self._galerieZeichnen();
        if (!treffer) {
          melden('Bild abgelegt — an dieser Stelle war nichts zu treffen. ' +
                 '„Setzen" drücken und im Modell ein Rechteck aufziehen.', '');
          return;
        }
        self._sofortSetzen(treffer, vorlage);
      });

      document.addEventListener('paste', async function (ereignis) {
        if (!zustaendig()) return;
        var ziel = ereignis.target;
        if (ziel && /^(INPUT|TEXTAREA|SELECT)$/.test(ziel.tagName)) return;
        if (!document.getElementById('beGalerie')) return;

        var eintraege = (ereignis.clipboardData || {}).items || [];
        var dateien = [];
        for (var i = 0; i < eintraege.length; i++) {
          if (eintraege[i].kind === 'file' && /^image\//.test(eintraege[i].type)) {
            var datei = eintraege[i].getAsFile();
            if (datei) dateien.push(datei);
          }
        }
        if (!dateien.length) return;
        ereignis.preventDefault();

        var vorlage = await self.dateienAufnehmen(dateien, 'Eingefügtes Bild');
        if (!vorlage) return;
        self._galerieZeichnen();

        // Kein Zeigerort beim Einfügen — also die Bildmitte, dieselbe
        // Festlegung wie beim Einfügen auf das Planblatt.
        var viewer = BimViewer.viewer;
        var mitte = new Cesium.Cartesian2(
          viewer.scene.canvas.clientWidth / 2, viewer.scene.canvas.clientHeight / 2);
        var treffer = self.treffer(mitte);
        if (treffer) self._sofortSetzen(treffer, vorlage);
      });
    },

    // ── Start ──────────────────────────────────────────────────────────────

    init: function () {
      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      if (!szene || this._wache) return false;
      var self = this;

      this.laden();
      // Gespeicherte Projektionen wieder anwerfen (bildprojektion.js). Die
      // Bilder liegen jetzt noch in IndexedDB und die Modelle laden gerade
      // erst — der Aufruf startet die Wache, die beides abwartet.
      if (BimViewer.Bildprojektion) BimViewer.Bildprojektion.nachziehen();
      this._wache = function () { self._wachen(); };
      szene.preUpdate.addEventListener(this._wache);
      this._ziehenInstallieren();
      console.log('🖼 Bildebenen bereit — ' + this.ebenen.length + ' gesetzt');
      return true;
    }
  };

  // ── Einhängen ────────────────────────────────────────────────────────────
  //
  // In das Modelle-Panel (📦), unmittelbar hinter die Layer: eine Bildebene
  // IST eine Ebene über dem Bauwerk, und die Frage „was liegt gerade über dem
  // Modell" wird dort gestellt — neben Karte, Gelände und den 3D-Ebenen aus
  // dem `layerManager`, nicht bei Kamera und Beleuchtung.

  function einhaengen() {
    var panel = document.querySelector('#section-models .section-scroll-content');
    if (!panel) return false;
    if (document.getElementById('group-bildebenen')) return true;

    var gruppe = document.createElement('details');
    gruppe.className = 'panel-group';
    gruppe.id = 'group-bildebenen';
    gruppe.innerHTML =
      '<summary class="panel-group__header"><span>Bildebenen</span></summary>' +
      '<div class="panel-group__body">' + BimViewer.Bildebenen.panelHtml() + '</div>';

    var layer = document.getElementById('group-layers');
    if (layer && layer.parentNode === panel) {
      panel.insertBefore(gruppe, layer.nextSibling);
    } else {
      panel.appendChild(gruppe);
    }

    BimViewer.Bildebenen._binden();
    console.log('🖼 Bildebenen eingehängt');
    return true;
  }

  // Das Panel entsteht erst, wenn ui.js die Aktivitätsleiste aufgebaut hat,
  // und die Gruppe hängt sich hinter eine andere, die zuerst da sein soll.
  var versuche = 0;
  var timerPanel = setInterval(function () {
    if (einhaengen() || ++versuche > 45) clearInterval(timerPanel);
  }, 400);

  var versucheViewer = 0;
  var timerViewer = setInterval(function () {
    if (BimViewer.Bildebenen.init() || ++versucheViewer > 60) clearInterval(timerViewer);
  }, 400);

  // Für die Prüfung ohne Browser.
  BimViewer.Bildebenen._internals = {
    einhaengen: einhaengen,
    panelHtml: function () { return BimViewer.Bildebenen.panelHtml(); },
    massstabAusEingabe: massstabAusEingabe,
    fehlertext: fehlertext,
    ausgleichsnormale: ausgleichsnormale,
    einrasten: einrasten,
    ebenenAbstand: ebenenAbstand,
    RAST_GRAD: RAST_GRAD,
    TAST_RADIEN: TAST_RADIEN,
    TAST_JE_RING: TAST_JE_RING,
    basis: basis,
    MINDEST_ZIEHEN: MINDEST_ZIEHEN,
    KLEINSTE_KANTE: KLEINSTE_KANTE,
    matrixAus: matrixAus,
    einheitsquadrat: einheitsquadrat,
    esc: esc,
    TEXTUR_MAX: TEXTUR_MAX,
    KACHEL_MAX: KACHEL_MAX,
    AUFLOESUNGEN: AUFLOESUNGEN,
    raster: raster,
    viewBoxVon: viewBoxVon,
    svgAusschnitt: svgAusschnitt,
    svgKacheln: svgKacheln,
    bildKacheln: bildKacheln,
    kachelMax: kachelMax,
    speicherMb: speicherMb,
    VERSATZ_STANDARD: VERSATZ_STANDARD,
    WAAGERECHT_AB: WAAGERECHT_AB
  };

  console.log('🖼 Bildebenen geladen');
})();
