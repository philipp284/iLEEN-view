/**
 * aufmass-fang.js — Der Fang: Ecke, Kante, Messpunkt, Raster.
 *
 * Warum es dieses Modul gibt
 * ==========================
 * Wer eine Wandecke messen will, trifft sie mit der Maus nicht. Ein Pixel
 * daneben sind auf zehn Meter Entfernung schnell zwei Zentimeter, und diese
 * zwei Zentimeter stehen anschließend in der Maßkette. Alles, was hier
 * passiert, hat nur ein Ziel: **der Punkt, der gesetzt wird, ist der Punkt,
 * den die Geometrie hergibt** — nicht der, den die Hand getroffen hat.
 *
 * Wie gefangen wird
 * =================
 * Nicht über die Dreiecke des Modells. Ein 3D-Tile ist gebatcht, seine
 * Vertices liegen verstreut hinter Batch-IDs, und für Splats und Gelände gibt
 * es sie überhaupt nicht. Ein Fang, der die Dreiecke braucht, funktioniert
 * also genau bei einem Drittel dessen, was in der Szene steht.
 *
 * Stattdessen wird **der Tiefenpuffer abgetastet**: ein Feld von 5 × 5 Proben
 * mit 3 px Abstand um den Zeiger, jede über `scene.pickPosition`. Aus je drei
 * benachbarten Proben ergibt sich eine Flächennormale, gleichgerichtete
 * Normalen werden zu Ebenen zusammengefasst — und dann sagt die *Zahl* der
 * Ebenen unter dem Zeiger, was dort liegt:
 *
 *   1 Ebene   → eine Fläche.        Der Punkt bleibt, wo er ist.
 *   2 Ebenen  → eine Kante.         Schnittgerade, Zeiger darauf gelotet.
 *   3 Ebenen  → eine Ecke.          Schnittpunkt der drei Ebenen.
 *
 * Das gilt für jede Geometrie, die in den Tiefenpuffer schreibt: IFC-Kacheln,
 * Netze, Gelände, Punktwolken. Für Gaussian Splats gilt es nicht — die
 * schreiben keine Tiefe (siehe `splat-pick.js`), dort übernimmt `SplatPick`.
 *
 * Splats: verglichen, nicht als Notnagel
 * ======================================
 * Bis September 2026 wurde `SplatPick` nur gefragt, wenn der Tiefenpuffer
 * unter dem Zeiger **gar nichts** hergab. Das ist genau der seltene Fall:
 * eine Splatwolke vor dem freien Himmel. Im Regelfall liegt hinter der Wolke
 * das Gelände oder ein Fachmodell — `pickPosition` liefert dann brav einen
 * Punkt, nämlich den auf dem Boden HINTER der Wolke, und der Splat wurde nie
 * gefragt. Man maß die Baugrube und traf die Wiese dahinter.
 *
 * Derselbe Fehler stand einmal in `tags.js` und ist dort schon behoben. Hier
 * gilt jetzt dieselbe Regel: **beides ermitteln, das Nähere gewinnt.** Liegt
 * der Splat vor der getroffenen Oberfläche, war er gemeint.
 *
 * Worauf gemessen wird, ist wählbar
 * =================================
 * `Fang.ziel` entscheidet, welche Träger überhaupt in Frage kommen:
 *
 *   'auto'      alles, das Nähere gewinnt — die Regel für den Alltag
 *   'modell'    nur geladene Modelle (IFC, Netze, Punktwolken), kein Gelände
 *   'splat'     nur Gaussian Splats
 *   'gelaende'  nur der Globus
 *
 * Die Automatik ist nicht immer die richtige Antwort. Über einem Baustellen-
 * scan, der einen Meter über dem Gelände liegt, entscheiden Zentimeter
 * darüber, welcher von beiden gewinnt — und dann misst man abwechselnd das
 * eine und das andere, ohne es zu merken. Wer weiß, was er messen will, sagt
 * es; und was er gemessen hat, steht danach als `traeger` am Treffer und
 * geht als solches in den Graphen.
 *
 * Der vierte Fall: die Silhouette
 * ===============================
 * Eine Hauskante gegen den Himmel ist **keine** zweite Ebene — dahinter ist
 * nichts. Solche Kanten sind aber genau die, die man beim Aufmaß am
 * häufigsten braucht. Sie zeigen sich als Tiefensprung: ein Teil des
 * Probenfeldes trifft nichts oder etwas weit Entferntes. Der Rand der noch
 * treffenden Proben ist die Silhouettenkante; durch ihn wird eine Gerade
 * gelegt.
 *
 * Rangfolge
 * =========
 * Es fängt immer genau eine Regel, und zwar die genaueste verfügbare:
 *
 *   Messpunkt  vor  Ecke  vor  Kante  vor  Raster  vor  Fläche
 *
 * Messpunkt steht oben, weil ein bereits gesetzter Punkt eine *Aussage* ist
 * und keine Schätzung — wer ein Polygon schließt, muss den Anfangspunkt
 * wieder treffen können, auch wenn zufällig eine Ecke daneben liegt.
 *
 * Das Raster (cm oder mm) steht **unter** der Geometrie, nicht darüber. Eine
 * gefangene Ecke auf den nächsten Zentimeter zu runden macht sie nicht
 * genauer, sondern verschiebt sie um bis zu 5 mm. Gerastert wird nur der
 * freie Punkt auf einer Fläche, wo es nichts Genaueres gibt.
 */
(function () {
  'use strict';

  // Probenfeld: 5 × 5 Proben, 3 px auseinander, also ±6 px um den Zeiger.
  // Größer heißt: über eine Kante hinweg mitteln. Kleiner heißt: bei
  // streifendem Blick liegen alle Proben auf derselben Fläche und die zweite
  // Ebene fehlt. Sechs Pixel sind der Bereich, in dem beides selten ist.
  const OFFS = [-6, -3, 0, 3, 6];
  const N = OFFS.length;

  // So weit darf der gefangene Punkt am Schirm vom Zeiger abweichen. Ohne
  // diese Grenze zieht eine Ecke am Bildrand den Punkt quer durchs Bild.
  const FANG_PX = 18;

  // Zwei Normalen gelten als dieselbe Ebene, wenn sie weniger als das
  // auseinanderliegen. 18° ist großzügig — der Tiefenpuffer rauscht, und ein
  // zu enger Winkel zerlegt eine ebene Wand in fünf Ebenen.
  const EBENEN_WINKEL = Math.cos(18 * Math.PI / 180);

  // Unter diesem Betrag der Determinante stehen drei Ebenen zu flach
  // zueinander, als dass ihr Schnittpunkt noch etwas bedeutete.
  const ECKE_DET_MIN = 0.12;

  const RASTER = { aus: 0, cm: 0.01, mm: 0.001 };

  // Worauf gemessen werden kann. Steht hier oben bei den übrigen Konstanten
  // und nicht unten bei den Trägerfunktionen: `Fang` reicht die Liste nach
  // außen, und eine `const` wird — anders als eine Funktionsdeklaration —
  // nicht vorgezogen. Weiter unten warf das Modul beim Laden.
  const ZIELE = ['auto', 'modell', 'splat', 'gelaende'];

  const Fang = {
    // Was gefangen werden darf. Alles einzeln abschaltbar, weil jede Regel
    // in einer bestimmten Lage im Weg sein kann — Ecken zum Beispiel an einem
    // stark vermaschten Scan, wo jedes Dreieck eine „Ecke" ist.
    ecken: true,
    kanten: true,
    punkte: true,
    splats: true,
    raster: 'aus',        // 'aus' | 'cm' | 'mm'

    // Worauf gemessen wird. Siehe Kopf.
    ziel: 'auto',         // 'auto' | 'modell' | 'splat' | 'gelaende'

    // Der letzte ausgewertete Fang — die Vorschau zeigt ihn, der Klick
    // übernimmt ihn. Beides muss dasselbe sein, sonst setzt man woandershin,
    // als man gesehen hat.
    letzter: null,

    fang: fang,
    aufRaster: aufRaster,
    zielSetzen: zielSetzen,
    ziele: () => ZIELE.slice(),
    _intern: { proben, normalen, ebenen, ecke, kante, silhouette, aufGerade,
               naeheres, splatTreffer, traegerUnter, ZIELE }
  };

  // ── Träger: worauf liegt der Punkt? ────────────────────────────────────────

  function zielSetzen(ziel) {
    Fang.ziel = ZIELE.indexOf(ziel) >= 0 ? ziel : 'auto';
    return Fang.ziel;
  }

  /**
   * Welcher von zwei Treffern liegt näher an der Kamera? `null` zählt als
   * „nicht getroffen" und verliert immer.
   *
   * Verglichen wird der Abstand zur Kamera, nicht die Tiefe im Puffer: der
   * eine Wert stammt aus dem Tiefenpuffer, der andere aus einem gerechneten
   * Strahlmarsch durch die Splats, und beide sind nur in Weltkoordinaten
   * miteinander vergleichbar.
   */
  function naeheres(a, b, kamera) {
    if (!a) return b || null;
    if (!b) return a;
    const da = Cesium.Cartesian3.distance(a.position, kamera);
    const db = Cesium.Cartesian3.distance(b.position, kamera);
    return da <= db ? a : b;
  }

  /** Der Splattreffer unter dem Zeiger, oder null. */
  function splatTreffer(pos) {
    if (!Fang.splats) return null;
    if (!window.SplatPick || !window.SplatPick.available || !window.SplatPick.available()) return null;
    let hit = null;
    try { hit = window.SplatPick.pickScreen(pos); } catch (e) { return null; }
    if (!hit || !hit.position) return null;
    return {
      position: hit.position, art: 'splat', traeger: 'splat',
      guete: hit.coverage === undefined ? 1 : hit.coverage,
      bildschirm: pos, ebenen: 0
    };
  }

  /**
   * Was hat der Tiefenpuffer unter dem Zeiger getroffen — ein geladenes
   * Modell oder der Globus?
   *
   * `scene.pick` beantwortet das, ohne dass der Tiefenpuffer dafür noch einmal
   * gelesen werden müsste: liefert es ein Feature oder ein Primitive mit
   * Tileset, steht dort ein Modell; liefert es nichts, war es das Gelände
   * (oder der Himmel, aber dann gäbe es auch keine Tiefe).
   */
  function traegerUnter(scene, pos) {
    let getroffen = null;
    try { getroffen = scene.pick(pos); } catch (e) { return 'gelaende'; }
    if (!Cesium.defined(getroffen)) return 'gelaende';
    if (getroffen instanceof Cesium.Cesium3DTileFeature) return 'modell';
    const prim = getroffen.primitive;
    if (prim && (prim instanceof Cesium.Cesium3DTileset || prim.isCesium3DTileset)) return 'modell';
    if (getroffen.tileset || getroffen.content) return 'modell';
    if (prim && prim.constructor && /Globe/.test(prim.constructor.name || '')) return 'gelaende';
    // Entities, Modelle, Punktwolkenprimitive — alles, was jemand geladen hat.
    return prim ? 'modell' : 'gelaende';
  }

  // ── Der Einstieg ───────────────────────────────────────────────────────────

  /**
   * Fängt den Punkt unter `pos` (Cesium.Cartesian2, Bildschirmpixel).
   *
   * `kontext` trägt, was der Aufrufer über die laufende Messung weiß:
   *   anker   Cartesian3 — Ursprung des örtlichen Systems fürs Raster
   *   punkte  [Cartesian3] — bereits gesetzte Messpunkte
   *
   * Zurück kommt `{ position, art, traeger, guete, bildschirm, ebenen }` oder
   * null, wenn unter dem Zeiger nichts liegt, das zum eingestellten Ziel passt.
   * `art` ist einer von
   * 'messpunkt' | 'ecke' | 'kante' | 'silhouette' | 'raster' | 'flaeche' | 'splat',
   * `traeger` einer von 'modell' | 'splat' | 'gelaende'.
   */
  function fang(pos, kontext) {
    const viewer = window.BimViewer && BimViewer.viewer;
    if (!viewer) return null;
    const scene = viewer.scene;
    kontext = kontext || {};
    const ziel = ZIELE.indexOf(Fang.ziel) >= 0 ? Fang.ziel : 'auto';

    // 1 · Ein bereits gesetzter Punkt schlägt alles. Reine Bildschirmrechnung,
    //     kostet nichts und muss deshalb zuerst kommen.
    if (Fang.punkte && kontext.punkte && kontext.punkte.length) {
      const treffer = naechsterMesspunkt(scene, pos, kontext.punkte);
      if (treffer) return merken(treffer);
    }

    // 2 · Der Splat wird ERMITTELT, nicht erst gefragt, wenn sonst nichts da
    //     ist. Welcher der beiden gewinnt, entscheidet unten der Abstand.
    const splat = (ziel === 'splat' || ziel === 'auto') ? splatTreffer(pos) : null;
    if (ziel === 'splat') return splat ? merken(splat) : null;

    // 3 · Das Probenfeld aus dem Tiefenpuffer.
    const feld = scene.pickPositionSupported ? proben(scene, pos) : null;
    const mitte = feld && feld.mitte;

    if (!mitte) return splat ? merken(splat) : null;

    // 4 · Passt, was der Tiefenpuffer getroffen hat, zum eingestellten Ziel?
    //     Ohne diese Frage misst „nur Modell" das Gelände, sobald der Zeiger
    //     einen Pixel neben das Bauteil rutscht.
    const traeger = traegerUnter(scene, pos);
    if (ziel === 'gelaende' && traeger !== 'gelaende') return null;
    if (ziel === 'modell' && traeger !== 'modell') return null;

    const gefunden = [];
    const gruppen = ebenen(normalen(feld), feld);

    if (Fang.ecken && gruppen.length >= 3) {
      const e = ecke(gruppen, feld);
      if (e) gefunden.push({ position: e, art: 'ecke', ebenen: gruppen.length });
    }
    if (Fang.kanten && gruppen.length >= 2 && !gefunden.length) {
      const k = kante(gruppen, feld, scene, pos);
      if (k) gefunden.push({ position: k, art: 'kante', ebenen: gruppen.length });
    }
    if (Fang.kanten && !gefunden.length && feld.luecken >= 4) {
      const s = silhouette(feld, scene, pos);
      if (s) gefunden.push({ position: s, art: 'silhouette', ebenen: gruppen.length });
    }

    // 5 · Was gefunden wurde, muss auch noch nah am Zeiger liegen. Sonst hat
    //     die Rechnung zwar eine Ecke gefunden, aber nicht die gemeinte.
    let ausTiefe = null;
    for (const g of gefunden) {
      const bs = scene.cartesianToCanvasCoordinates(g.position);
      if (!bs) continue;
      const d = Math.hypot(bs.x - pos.x, bs.y - pos.y);
      if (d <= FANG_PX) {
        g.bildschirm = bs;
        g.guete = 1 - d / FANG_PX;
        g.traeger = traeger;
        ausTiefe = g;
        break;
      }
    }

    // 6 · Freier Punkt auf einer Fläche — hier und nur hier greift das Raster.
    if (!ausTiefe) {
      const gerastert = aufRaster(mitte, kontext.anker);
      if (gerastert) {
        const bs = scene.cartesianToCanvasCoordinates(gerastert);
        ausTiefe = {
          position: gerastert, art: 'raster', traeger: traeger, guete: 1,
          bildschirm: bs || pos, ebenen: gruppen.length
        };
      } else {
        ausTiefe = {
          position: mitte, art: 'flaeche', traeger: traeger, guete: 1,
          bildschirm: pos, ebenen: gruppen.length
        };
      }
    }

    // 7 · Das Nähere gewinnt. Ein Splat vor der Fassade war gemeint, einer
    //     dahinter nicht — und ohne diesen Vergleich wäre es umgekehrt immer
    //     die Fassade, weil sie Tiefe schreibt und der Splat nicht.
    return merken(naeheres(ausTiefe, splat, scene.camera.positionWC));
  }

  function merken(t) { Fang.letzter = t; return t; }

  // ── Das Probenfeld ─────────────────────────────────────────────────────────

  /**
   * Tastet 5 × 5 Bildpunkte ab und rechnet die Treffer in ein örtliches
   * Ost-Nord-Hoch-System um den mittleren Treffer um.
   *
   * Warum örtlich: in ECEF sind die Koordinaten sechsstellige Meterwerte, die
   * Unterschiede zwischen zwei Proben aber Millimeter. Jede Normale aus einem
   * Kreuzprodukt solcher Differenzen wäre Rauschen. Örtlich sind es Zahlen um
   * null, und die Rechnung trägt.
   */
  function proben(scene, pos) {
    const roh = new Array(N * N).fill(null);
    const c2 = new Cesium.Cartesian2();
    let mitteEcef = null;

    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        c2.x = pos.x + OFFS[i];
        c2.y = pos.y + OFFS[j];
        const p = scene.pickPosition(c2);
        if (!Cesium.defined(p) || !isFinite(p.x)) continue;
        roh[i * N + j] = p;
        if (i === 2 && j === 2) mitteEcef = p;
      }
    }
    if (!mitteEcef) {
      // Der Zeiger selbst hat nichts getroffen, aber vielleicht seine
      // Nachbarn — am Rand eines Bauteils ist das der Normalfall.
      for (let k = 0; k < roh.length && !mitteEcef; k++) if (roh[k]) mitteEcef = roh[k];
      if (!mitteEcef) return null;
    }

    const nachWelt = Cesium.Transforms.eastNorthUpToFixedFrame(mitteEcef);
    const nachOrt = Cesium.Matrix4.inverse(nachWelt, new Cesium.Matrix4());

    const p = new Array(N * N).fill(null);
    let luecken = 0;
    let spann = 0, spannZahl = 0;
    for (let k = 0; k < roh.length; k++) {
      if (!roh[k]) { luecken++; continue; }
      p[k] = Cesium.Matrix4.multiplyByPoint(nachOrt, roh[k], new Cesium.Cartesian3());
    }
    // Mittlerer Abstand benachbarter Proben — der Maßstab, an dem sich alle
    // Toleranzen weiter unten bemessen. Bei einem Blick über hundert Meter
    // sind das Dezimeter, bei einem Detail Millimeter; eine feste Toleranz
    // wäre in einem der beiden Fälle immer falsch.
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < N; j++) {
      const a = p[i * N + j], b = p[(i + 1) * N + j];
      if (a && b) { spann += Cesium.Cartesian3.distance(a, b); spannZahl++; }
    }
    spann = spannZahl ? spann / spannZahl : 0.01;

    return {
      p: p, luecken: luecken, spann: spann,
      mitte: mitteEcef, nachWelt: nachWelt, nachOrt: nachOrt,
      // Blickrichtung im örtlichen System — braucht die Ausrichtung der Normalen.
      zurKamera: Cesium.Cartesian3.normalize(
        Cesium.Matrix4.multiplyByPointAsVector(
          nachOrt,
          Cesium.Cartesian3.subtract(scene.camera.positionWC, mitteEcef, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()),
        new Cesium.Cartesian3())
    };
  }

  /** Je Probe eine Normale aus ihren beiden Nachbarn rechts und unten. */
  function normalen(feld) {
    const out = [];
    const a = new Cesium.Cartesian3(), b = new Cesium.Cartesian3();
    for (let i = 0; i < N - 1; i++) {
      for (let j = 0; j < N - 1; j++) {
        const p0 = feld.p[i * N + j];
        const px = feld.p[(i + 1) * N + j];
        const py = feld.p[i * N + (j + 1)];
        if (!p0 || !px || !py) continue;
        Cesium.Cartesian3.subtract(px, p0, a);
        Cesium.Cartesian3.subtract(py, p0, b);
        // Ein Dreieck, dessen Kanten deutlich länger sind als der mittlere
        // Probenabstand, liegt über einem Tiefensprung — seine Normale ist
        // die des Sprungs, nicht die einer Fläche.
        if (Cesium.Cartesian3.magnitude(a) > 3 * feld.spann) continue;
        if (Cesium.Cartesian3.magnitude(b) > 3 * feld.spann) continue;
        const n = Cesium.Cartesian3.cross(a, b, new Cesium.Cartesian3());
        if (Cesium.Cartesian3.magnitude(n) < 1e-12) continue;
        Cesium.Cartesian3.normalize(n, n);
        // Alle Normalen zur Kamera drehen, sonst zerfällt eine Fläche in zwei
        // Gruppen mit entgegengesetztem Vorzeichen.
        if (Cesium.Cartesian3.dot(n, feld.zurKamera) < 0) Cesium.Cartesian3.negate(n, n);
        out.push({ n: n, p: p0 });
      }
    }
    return out;
  }

  /**
   * Fasst gleichgerichtete, deckungsgleiche Normalen zu Ebenen zusammen.
   *
   * Zwei Bedingungen, nicht eine: gleiche Richtung *und* gleicher Abstand vom
   * Ursprung. Ohne die zweite wären die beiden Wangen eines Türsturzes
   * dieselbe Ebene, und die Kante dazwischen ginge verloren.
   */
  function ebenen(nrm, feld) {
    const tol = Math.max(0.003, 0.6 * feld.spann);
    const gruppen = [];
    for (const s of nrm) {
      const d = Cesium.Cartesian3.dot(s.n, s.p);
      let heim = null;
      for (const g of gruppen) {
        if (Cesium.Cartesian3.dot(g.n, s.n) < EBENEN_WINKEL) continue;
        if (Math.abs(Cesium.Cartesian3.dot(g.n, s.p) - g.d) > tol) continue;
        heim = g; break;
      }
      if (heim) {
        heim.summe = Cesium.Cartesian3.add(heim.summe, s.n, heim.summe);
        heim.dSumme += d;
        heim.zahl++;
        Cesium.Cartesian3.normalize(heim.summe, heim.n);
        heim.d = heim.dSumme / heim.zahl;
      } else {
        const n = Cesium.Cartesian3.clone(s.n);
        gruppen.push({
          n: n, d: d, zahl: 1,
          summe: Cesium.Cartesian3.clone(s.n), dSumme: d
        });
      }
    }
    // Ebenen aus einer einzigen Probe sind Rauschen, keine Fläche.
    return gruppen.filter((g) => g.zahl >= 2).sort((a, b) => b.zahl - a.zahl);
  }

  // ── Die drei Fänge ─────────────────────────────────────────────────────────

  /** Schnittpunkt der drei stärksten Ebenen, per Cramer. */
  function ecke(gruppen, feld) {
    const [A, B, C] = gruppen;
    const det =
      A.n.x * (B.n.y * C.n.z - B.n.z * C.n.y) -
      A.n.y * (B.n.x * C.n.z - B.n.z * C.n.x) +
      A.n.z * (B.n.x * C.n.y - B.n.y * C.n.x);
    if (Math.abs(det) < ECKE_DET_MIN) return null;

    const dx =
      A.d * (B.n.y * C.n.z - B.n.z * C.n.y) -
      A.n.y * (B.d * C.n.z - B.n.z * C.d) +
      A.n.z * (B.d * C.n.y - B.n.y * C.d);
    const dy =
      A.n.x * (B.d * C.n.z - B.n.z * C.d) -
      A.d * (B.n.x * C.n.z - B.n.z * C.n.x) +
      A.n.z * (B.n.x * C.d - B.d * C.n.x);
    const dz =
      A.n.x * (B.n.y * C.d - B.d * C.n.y) -
      A.n.y * (B.n.x * C.d - B.d * C.n.x) +
      A.d * (B.n.x * C.n.y - B.n.y * C.n.x);

    const ort = new Cesium.Cartesian3(dx / det, dy / det, dz / det);
    // Eine Ecke, die zehn Probenfeldbreiten entfernt liegt, ist ein
    // Rechenartefakt aus zwei fast parallelen Ebenen.
    if (Cesium.Cartesian3.magnitude(ort) > 20 * feld.spann + 0.05) return null;
    return Cesium.Matrix4.multiplyByPoint(feld.nachWelt, ort, new Cesium.Cartesian3());
  }

  /** Schnittgerade der beiden stärksten Ebenen, Zeiger darauf gelotet. */
  function kante(gruppen, feld, scene, pos) {
    const [A, B] = gruppen;
    const u = Cesium.Cartesian3.cross(A.n, B.n, new Cesium.Cartesian3());
    const uu = Cesium.Cartesian3.magnitudeSquared(u);
    if (uu < 0.02) return null;   // zu flach zueinander, keine belastbare Kante

    // Aufpunkt der Schnittgeraden: (d1 (n2×u) + d2 (u×n1)) / |u|²
    const t1 = Cesium.Cartesian3.multiplyByScalar(
      Cesium.Cartesian3.cross(B.n, u, new Cesium.Cartesian3()), A.d, new Cesium.Cartesian3());
    const t2 = Cesium.Cartesian3.multiplyByScalar(
      Cesium.Cartesian3.cross(u, A.n, new Cesium.Cartesian3()), B.d, new Cesium.Cartesian3());
    const q = Cesium.Cartesian3.multiplyByScalar(
      Cesium.Cartesian3.add(t1, t2, new Cesium.Cartesian3()), 1 / uu, new Cesium.Cartesian3());

    return aufGerade(q, u, feld, scene, pos);
  }

  /**
   * Die Silhouettenkante: der Rand der Proben, die noch etwas getroffen haben.
   *
   * Es wird keine Ausgleichsgerade gerechnet, sondern die beiden am weitesten
   * auseinanderliegenden Randproben genommen. Bei fünfundzwanzig Proben auf
   * zwölf Pixeln ist jede Ausgleichsrechnung Zierde — die Streuung liegt im
   * Tiefenpuffer, nicht in der Wahl der Geraden.
   */
  function silhouette(feld, scene, pos) {
    const rand = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const p = feld.p[i * N + j];
      if (!p) continue;
      const nachbarn = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
      const offen = nachbarn.some(([a, b]) =>
        a >= 0 && a < N && b >= 0 && b < N && !feld.p[a * N + b]);
      if (offen) rand.push(p);
    }
    if (rand.length < 3) return null;

    let a = rand[0], b = rand[1], weit = -1;
    for (let x = 0; x < rand.length; x++) for (let y = x + 1; y < rand.length; y++) {
      const d = Cesium.Cartesian3.distanceSquared(rand[x], rand[y]);
      if (d > weit) { weit = d; a = rand[x]; b = rand[y]; }
    }
    if (weit < (0.8 * feld.spann) * (0.8 * feld.spann)) return null;

    const u = Cesium.Cartesian3.subtract(b, a, new Cesium.Cartesian3());
    return aufGerade(a, u, feld, scene, pos);
  }

  /**
   * Lotet den Sichtstrahl unter dem Zeiger auf die Gerade (q, u) — die
   * gemeinsame Normale zweier windschiefer Geraden, örtlich gerechnet.
   */
  function aufGerade(q, u, feld, scene, pos) {
    const strahl = scene.camera.getPickRay(pos);
    if (!strahl) return null;
    const o = Cesium.Matrix4.multiplyByPoint(feld.nachOrt, strahl.origin, new Cesium.Cartesian3());
    const v = Cesium.Matrix4.multiplyByPointAsVector(feld.nachOrt, strahl.direction, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(v, v);
    Cesium.Cartesian3.normalize(u, u);

    const w = Cesium.Cartesian3.subtract(q, o, new Cesium.Cartesian3());
    const uv = Cesium.Cartesian3.dot(u, v);
    const nenner = 1 - uv * uv;
    if (Math.abs(nenner) < 1e-6) return null;   // Blick genau entlang der Kante
    const s = (Cesium.Cartesian3.dot(w, u) - uv * Cesium.Cartesian3.dot(w, v)) / nenner;

    const ort = Cesium.Cartesian3.add(q, Cesium.Cartesian3.multiplyByScalar(u, s, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    if (Cesium.Cartesian3.magnitude(ort) > 30 * feld.spann + 0.05) return null;
    return Cesium.Matrix4.multiplyByPoint(feld.nachWelt, ort, new Cesium.Cartesian3());
  }

  // ── Messpunkt und Raster ───────────────────────────────────────────────────

  function naechsterMesspunkt(scene, pos, punkte) {
    let best = null, bestD = FANG_PX;
    for (let i = 0; i < punkte.length; i++) {
      const bs = scene.cartesianToCanvasCoordinates(punkte[i]);
      if (!bs) continue;
      const d = Math.hypot(bs.x - pos.x, bs.y - pos.y);
      if (d < bestD) { bestD = d; best = { position: punkte[i], bildschirm: bs, index: i }; }
    }
    if (!best) return null;
    return {
      // Ein gesetzter Messpunkt hat keinen Träger — er ist eine Aussage über
      // die Messung, keine über die Szene. Der Träger, auf dem er entstanden
      // ist, steht bereits an seinem eigenen Eintrag in der Kette.
      position: best.position, art: 'messpunkt', traeger: null,
      guete: 1 - bestD / FANG_PX,
      bildschirm: best.bildschirm, ebenen: 0, index: best.index
    };
  }

  /**
   * Rundet auf das eingestellte Raster — im örtlichen System des Ankers, nicht
   * in ECEF. Ein Zentimeterraster in ECEF hätte keine Richtung, die jemand
   * benennen könnte; hier sind es saubere Ost-, Nord- und Höhenwerte,
   * gemessen vom ersten Punkt der Messung.
   */
  function aufRaster(punktEcef, anker) {
    const s = RASTER[Fang.raster] || 0;
    if (!s) return null;
    const bezug = anker || punktEcef;
    const nachWelt = Cesium.Transforms.eastNorthUpToFixedFrame(bezug);
    const nachOrt = Cesium.Matrix4.inverse(nachWelt, new Cesium.Matrix4());
    const o = Cesium.Matrix4.multiplyByPoint(nachOrt, punktEcef, new Cesium.Cartesian3());
    o.x = Math.round(o.x / s) * s;
    o.y = Math.round(o.y / s) * s;
    o.z = Math.round(o.z / s) * s;
    return Cesium.Matrix4.multiplyByPoint(nachWelt, o, new Cesium.Cartesian3());
  }

  window.AufmassFang = Fang;
  console.log('🧲 Aufmaß-Fang geladen — Ecke, Kante, Silhouette, Raster');
})();
