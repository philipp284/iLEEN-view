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
 * Wann gefangen wird
 * ==================
 * Dieses Modul rechnet nur, wenn es gefragt wird: `aufmass.js` fragt, sobald
 * der Zeiger ruht, und beim Klick — nie bei jeder Mausbewegung. Ein Fang
 * kostet bis zu hundert Tiefenabfragen und zwei Pick-Durchgänge; bei jeder
 * Bewegung war das der Grund, warum der Zeiger im Messmodus nachlief.
 *
 * Wie gefangen wird
 * =================
 * Nicht über die Dreiecke des Modells. Ein 3D-Tile ist gebatcht, seine
 * Vertices liegen verstreut hinter Batch-IDs, und für Splats und Gelände gibt
 * es sie überhaupt nicht. Ein Fang, der die Dreiecke braucht, funktioniert
 * also genau bei einem Drittel dessen, was in der Szene steht.
 *
 * Stattdessen wird **der Tiefenpuffer abgetastet**: ein Feld von Proben um den
 * Zeiger, jede über `scene.pickPosition`. Aus je drei benachbarten Proben
 * ergibt sich eine Flächennormale, gleichgerichtete Normalen werden zu Ebenen
 * zusammengefasst — und dann sagt die *Zahl* der Ebenen im Feld, was dort
 * liegt:
 *
 *   1 Ebene   → eine Fläche.        Der Punkt bleibt, wo er ist.
 *   2 Ebenen  → eine Kante.         Schnittgerade, Zeiger darauf gelotet.
 *   3 Ebenen  → eine Ecke.          Schnittpunkt der drei Ebenen.
 *
 * Das gilt für jede Geometrie, die in den Tiefenpuffer schreibt: IFC-Kacheln,
 * Netze, Gelände, Punktwolken. Für Gaussian Splats gilt es nicht — die
 * schreiben keine Tiefe (siehe `splat-pick.js`), dort übernimmt `SplatPick`.
 *
 * Die Reichweite: ca. 1 cm am Schirm
 * ==================================
 * Eine Ecke zu treffen heißt, bis auf ein paar Pixel an sie heranzukommen —
 * und das ist mit der Hand mühsam. Deshalb fängt der Fang nicht nur unter dem
 * Zeiger, sondern im Umkreis von `Fang.radius` Bildpunkten (36 px, am Schirm
 * rund ein Zentimeter). Zwei Felder, grob und fein:
 *
 *   fein   5 × 5 Proben, 3 px auseinander, ±6 px um den Zeiger
 *   grob   9 × 9 Proben, 12 px auseinander, ±48 px um den Zeiger
 *          (einen Probenabstand über die Reichweite hinaus, sonst fehlt hinter
 *          einer Kante am Rand die zweite Ebene)
 *
 * Das grobe Feld wird genauso in Ebenen zerlegt wie das feine. Zwei Ebenen im
 * ganzen Umkreis heißen: irgendwo darin knickt die Fläche. Ihre Schnittgerade
 * liegt fest — gerechnet aus allen Dreiecken beider Ebenen und damit genauer
 * als aus dem kleinen Feld —, und auf ihr wird der Punkt genommen, der dem
 * Zeiger am nächsten liegt. Aus drei Ebenen folgt entsprechend die Ecke.
 *
 * Damit eine Ebene, die nur zufällig im Bild steht, keine Kante vortäuscht,
 * muss jede der beteiligten Ebenen bis an den gefangenen Punkt heranreichen:
 * mindestens eines ihrer Dreiecke liegt dort höchstens drei Probenabstände
 * entfernt. Zwei Wände, von denen die eine vor der anderen steht, schneiden
 * sich in Gedanken irgendwo — dort ist aber nichts.
 *
 * Welche Kante oder Ecke gewinnt, entscheidet der **Abstand zum Zeiger**,
 * nicht die Reihenfolge der Regeln. Eine Ecke zählt dabei so, als läge sie
 * 40 % näher: wer in Richtung einer Ecke zielt, soll sie bekommen und nicht die
 * Kante, an der er auf dem Weg dorthin vorbeikommt — aber eine Ecke am Rand
 * der Reichweite schlägt keine Kante, die unter dem Zeiger liegt.
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
 * häufigsten braucht. Sie zeigen sich als Lücke im Probenfeld: ein Teil der
 * Proben trifft nichts. Der Rand der noch treffenden Proben ist die
 * Silhouettenkante; durch ihn wird eine Gerade gelegt. Im Umkreis wird dafür
 * der nächstgelegene Rand des groben Feldes gesucht und dort fein nachgemessen.
 *
 * Grenze: eine Kante gegen etwas, das Tiefe schreibt (ein Haus vor dem
 * Gelände), zeigt sich als Tiefensprung und wird nur gefangen, wenn dort zwei
 * Flächen zusammenstoßen. Ein reiner Tiefensprung ist keine Kante des Hauses.
 *
 * Rangfolge
 * =========
 *   Messpunkt  vor  Kante/Ecke/Silhouette (nach Abstand)  vor  Raster  vor  Fläche
 *
 * Messpunkt steht oben, weil ein bereits gesetzter Punkt eine *Aussage* ist
 * und keine Schätzung — wer ein Polygon schließt, muss den Anfangspunkt
 * wieder treffen können, auch wenn zufällig eine Ecke daneben liegt. Er fängt
 * nur im engen Umkreis (`FANG_PX`), nicht in der ganzen Reichweite: bei einem
 * kleinen Umriss lägen sonst alle Punkte in der Reichweite des vorigen.
 *
 * Das Raster (cm oder mm) steht **unter** der Geometrie, nicht darüber. Eine
 * gefangene Ecke auf den nächsten Zentimeter zu runden macht sie nicht
 * genauer, sondern verschiebt sie um bis zu 5 mm. Gerastert wird nur der
 * freie Punkt auf einer Fläche, wo es nichts Genaueres gibt.
 */
(function () {
  'use strict';

  // Feines Probenfeld: 5 × 5 Proben, 3 px auseinander, also ±6 px um den
  // Zeiger. Größer heißt: über eine Kante hinweg mitteln. Kleiner heißt: bei
  // streifendem Blick liegen alle Proben auf derselben Fläche und die zweite
  // Ebene fehlt. Sechs Pixel sind der Bereich, in dem beides selten ist.
  const OFFS = [-6, -3, 0, 3, 6];

  // Der enge Umkreis: so weit darf ein gesetzter Messpunkt vom Zeiger
  // entfernt sein, und so weit reichte der Fang, bevor es die Reichweite gab.
  // Zugleich die Untergrenze der Reichweite — `radius = 18` ist der alte Fang.
  const FANG_PX = 18;

  // Die Reichweite, wie sie ausgeliefert wird: ca. 1 cm am Schirm (ein
  // CSS-Pixel ist 1/96 Zoll, ein Zentimeter also rund 38 — auf einem Retina-
  // Schirm eher 45). Nach oben begrenzt, weil das grobe Feld mit ihr wächst:
  // bei 48 px sind es 11 × 11 = 121 Proben.
  const RADIUS_PX = 36;
  const RADIUS_MAX = 48;

  // Abstand der Proben im groben Feld. Fein genug, dass auch ein schmales
  // Bauteil (ein Pfosten, ein Fensterrahmen) noch zwei Dreiecke abbekommt,
  // grob genug, dass die Reichweite mit 81 Proben abgedeckt ist.
  const GROB_SCHRITT = 12;

  // Eine Ecke zählt, als läge sie so viel näher am Zeiger. Siehe Kopf.
  const ECKE_BONUS = 0.6;

  // So weit darf eine Ebene von einem gefangenen Punkt entfernt aufhören,
  // gemessen in Probenabständen. Siehe Kopf.
  const STUETZ_FAKTOR = 3;

  // Eine Ebene im groben Feld zählt nur, wenn mindestens so viele Proben auf
  // ihr liegen. Vier ist die Zahl, ab der ein Fehlgriff durch Zufall selten
  // wird: drei Punkte legen jede Ebene fest, der vierte bestätigt sie.
  const EBENE_MIN_PUNKTE = 4;
  const EBENEN_MAX = 5;

  // Zwei Normalen gelten als dieselbe Ebene, wenn sie weniger als das
  // auseinanderliegen. 18° ist großzügig — der Tiefenpuffer rauscht, und ein
  // zu enger Winkel zerlegt eine ebene Wand in fünf Ebenen. Das gilt für das
  // feine Feld, dessen Proben 3 px auseinanderliegen: das Rauschen ist dort so
  // groß wie der Abstand. Im groben Feld (12 px) ist der Abstand vier Mal so
  // groß, das Rauschen gleich — dort genügen 8°, und mehr wäre falsch: ein
  // Dreieck, das über einer Kante liegt, hat eine Mischnormale, und die darf
  // sich nicht einer der beiden Flächen anschließen und deren Ebene verziehen.
  const EBENEN_WINKEL = Math.cos(18 * Math.PI / 180);
  const EBENEN_WINKEL_GROB = Math.cos(8 * Math.PI / 180);

  // Unter diesem Betrag der Determinante stehen drei Ebenen zu flach
  // zueinander, als dass ihr Schnittpunkt noch etwas bedeutete.
  const ECKE_DET_MIN = 0.12;

  // Ecken und Kantenpunkte, die weiter als das vom Ursprung des Feldes
  // entfernt liegen (in Bildpunkten, an der Stelle gemessen), sind
  // Rechenartefakte. Reicht über die größte Reichweite hinaus.
  const ARTEFAKT_PX = 120;

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

    // Wie weit vom Zeiger entfernt eine Kante oder Ecke noch fängt, in
    // Bildpunkten. 18 ist der Fang von früher, 36 ca. ein Zentimeter am Schirm.
    radius: RADIUS_PX,

    // Der letzte ausgewertete Fang — die Vorschau zeigt ihn, der Klick
    // übernimmt ihn. Beides muss dasselbe sein, sonst setzt man woandershin,
    // als man gesehen hat.
    letzter: null,

    fang: fang,
    aufRaster: aufRaster,
    zielSetzen: zielSetzen,
    radiusSetzen: radiusSetzen,
    ziele: () => ZIELE.slice(),
    _intern: { proben, normalen, ebenen, ebenenAusPunkten, ausgleichsebene,
               kleinsterEigenvektor, ecke, kante, silhouette, aufGerade,
               naeheres, splatTreffer, traegerUnter, weiteSuche, lokaleKandidaten,
               ZIELE }
  };

  // ── Einstellungen ──────────────────────────────────────────────────────────

  function zielSetzen(ziel) {
    Fang.ziel = ZIELE.indexOf(ziel) >= 0 ? ziel : 'auto';
    return Fang.ziel;
  }

  /** Setzt die Reichweite in Bildpunkten, begrenzt auf 18 … 48. */
  function radiusSetzen(px) {
    Fang.radius = Math.max(FANG_PX, Math.min(RADIUS_MAX, Number(px) || RADIUS_PX));
    return Fang.radius;
  }

  /** Die gültige Reichweite — eine zerschossene Einstellung fällt auf 18 zurück. */
  function radiusPx() {
    const r = Number(Fang.radius);
    return isFinite(r) ? Math.max(FANG_PX, Math.min(RADIUS_MAX, r)) : FANG_PX;
  }

  // ── Träger: worauf liegt der Punkt? ────────────────────────────────────────

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
   * Was hat der Tiefenpuffer an dieser Stelle getroffen — ein geladenes
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
   * Zurück kommt
   *   { position, art, traeger, guete, bildschirm, ebenen, richtung, abstandPx, pickPixel }
   * oder null, wenn im Umkreis nichts liegt, das zum eingestellten Ziel passt.
   * `art` ist einer von
   * 'messpunkt' | 'ecke' | 'kante' | 'silhouette' | 'raster' | 'flaeche' | 'splat',
   * `traeger` einer von 'modell' | 'splat' | 'gelaende'.
   *
   * `richtung` ist bei Kante und Silhouette die Richtung der Kante (Einheits-
   * vektor, ECEF), sonst null. `pickPixel` ist ein Bildpunkt, der sicher auf
   * der Geometrie liegt, an der gefangen wurde — dort fragt man nach dem
   * Bauteil, nicht am Zeiger, der bei einer Kante gern daneben steht.
   */
  function fang(pos, kontext) {
    const viewer = window.BimViewer && BimViewer.viewer;
    if (!viewer) return null;
    const scene = viewer.scene;
    kontext = kontext || {};
    const ziel = ZIELE.indexOf(Fang.ziel) >= 0 ? Fang.ziel : 'auto';
    const radius = radiusPx();

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

    // 3 · Das feine Probenfeld am Zeiger — daraus kommt der freie Punkt auf
    //     einer Fläche und die Kante oder Ecke, die ohnehin unter dem Zeiger liegt.
    const tiefe = !!scene.pickPositionSupported;
    const feld = tiefe ? proben(scene, pos, OFFS) : null;
    const mitte = feld ? feld.mitte : null;
    const gruppen = feld ? ebenen(normalen(feld), feld) : [];
    const fangen = Fang.ecken || Fang.kanten;

    // 4 · Alles, was als Kante oder Ecke in Frage kommt. Eine Ecke direkt am
    //     Zeiger erspart die weite Suche; sonst wird im ganzen Umkreis
    //     nachgesehen.
    let kandidaten = (feld && fangen) ? lokaleKandidaten(feld, gruppen, scene, pos, radius) : [];
    if (tiefe && fangen && radius > FANG_PX && !kandidaten.some((k) => k.art === 'ecke')) {
      kandidaten = kandidaten.concat(weiteSuche(scene, pos, radius));
    }
    for (const k of kandidaten) k.wert = k.abstand * (k.art === 'ecke' ? ECKE_BONUS : 1);
    kandidaten.sort((a, b) => a.wert - b.wert);

    // 5 · Der beste, der zum eingestellten Ziel passt. Ohne diese Frage misst
    //     „nur Modell" das Gelände, sobald der Zeiger einen Pixel neben das
    //     Bauteil rutscht. Höchstens drei werden befragt — jede Frage ist ein
    //     Pick-Durchgang.
    let gewaehlt = null;
    for (const k of kandidaten.slice(0, 3)) {
      const traeger = traegerUnter(scene, k.pickPixel);
      if (ziel === 'gelaende' && traeger !== 'gelaende') continue;
      if (ziel === 'modell' && traeger !== 'modell') continue;
      gewaehlt = {
        position: k.position, art: k.art, traeger: traeger,
        guete: 1 - k.abstand / radius,
        bildschirm: k.bildschirm, ebenen: k.ebenen,
        richtung: k.richtung || null, abstandPx: k.abstand, pickPixel: k.pickPixel
      };
      break;
    }

    // 6 · Nichts gefangen: der freie Punkt auf einer Fläche — hier und nur
    //     hier greift das Raster.
    if (!gewaehlt && mitte) {
      const traeger = traegerUnter(scene, pos);
      if (ziel === 'gelaende' && traeger !== 'gelaende') return null;
      if (ziel === 'modell' && traeger !== 'modell') return null;
      const gerastert = aufRaster(mitte, kontext.anker);
      const bs = gerastert ? scene.cartesianToCanvasCoordinates(gerastert) : null;
      gewaehlt = {
        position: gerastert || mitte, art: gerastert ? 'raster' : 'flaeche',
        traeger: traeger, guete: 1,
        bildschirm: bs || pos, ebenen: gruppen.length,
        richtung: null, abstandPx: 0, pickPixel: pos
      };
    }

    // 7 · Das Nähere gewinnt. Ein Splat vor der Fassade war gemeint, einer
    //     dahinter nicht — und ohne diesen Vergleich wäre es umgekehrt immer
    //     die Fassade, weil sie Tiefe schreibt und der Splat nicht.
    if (!gewaehlt) return splat ? merken(splat) : null;
    return merken(naeheres(gewaehlt, splat, scene.camera.positionWC));
  }

  function merken(t) { Fang.letzter = t; return t; }

  // ── Die Probenfelder ───────────────────────────────────────────────────────

  /**
   * Tastet ein Feld von Bildpunkten ab (`offs` × `offs` um `pos`) und rechnet
   * die Treffer in ein örtliches Ost-Nord-Hoch-System um den Treffer, der dem
   * Zeiger am nächsten liegt.
   *
   * Warum örtlich: in ECEF sind die Koordinaten sechsstellige Meterwerte, die
   * Unterschiede zwischen zwei Proben aber Millimeter. Jede Normale aus einem
   * Kreuzprodukt solcher Differenzen wäre Rauschen. Örtlich sind es Zahlen um
   * null, und die Rechnung trägt.
   *
   * Eine Probe hat drei Zustände: ein Punkt (getroffen), `null` (die Abfrage
   * lief, dort ist nichts) und `undefined` (außerhalb der Leinwand, nicht
   * gefragt). Nur `null` ist eine Lücke — am Bildrand wäre sonst jede Kante
   * des Fensters eine Silhouette.
   */
  function proben(scene, pos, offs) {
    offs = offs || OFFS;
    const n = offs.length;
    const breite = scene.canvas ? scene.canvas.clientWidth : Infinity;
    const hoehe = scene.canvas ? scene.canvas.clientHeight : Infinity;
    const roh = new Array(n * n).fill(null);
    const c2 = new Cesium.Cartesian2();
    let mitteEcef = null, naechste = Infinity;

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = pos.x + offs[i], y = pos.y + offs[j];
        if (x < 0 || y < 0 || x >= breite || y >= hoehe) { roh[i * n + j] = undefined; continue; }
        c2.x = x; c2.y = y;
        const p = scene.pickPosition(c2);
        if (!Cesium.defined(p) || !isFinite(p.x)) continue;
        roh[i * n + j] = p;
        // Der Ursprung des örtlichen Systems: die Probe, die dem Zeiger am
        // nächsten liegt. Am Rand eines Bauteils trifft der Zeiger selbst oft
        // nichts, seine Nachbarn aber schon.
        const d = offs[i] * offs[i] + offs[j] * offs[j];
        if (d < naechste) { naechste = d; mitteEcef = p; }
      }
    }
    if (!mitteEcef) return null;

    const nachWelt = Cesium.Transforms.eastNorthUpToFixedFrame(mitteEcef);
    const nachOrt = Cesium.Matrix4.inverse(nachWelt, new Cesium.Matrix4());

    const p = new Array(n * n).fill(null);
    let luecken = 0;
    for (let k = 0; k < roh.length; k++) {
      if (roh[k] === undefined) { p[k] = undefined; continue; }
      if (!roh[k]) { luecken++; continue; }
      p[k] = Cesium.Matrix4.multiplyByPoint(nachOrt, roh[k], new Cesium.Cartesian3());
    }

    // Typischer Abstand benachbarter Proben — der Maßstab, an dem sich alle
    // Toleranzen weiter unten bemessen. Bei einem Blick über hundert Meter
    // sind das Dezimeter, bei einem Detail Millimeter; eine feste Toleranz
    // wäre in einem der beiden Fälle immer falsch. Der Mittelwert wäre hier
    // falsch: ein einziger Tiefensprung im Feld (Haus vor Gelände) ließe ihn
    // auf das Zehnfache steigen und die Toleranzen mit.
    const abst = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = p[i * n + j];
      if (!a) continue;
      const rechts = i + 1 < n ? p[(i + 1) * n + j] : null;
      const unten = j + 1 < n ? p[i * n + j + 1] : null;
      if (rechts) abst.push(Cesium.Cartesian3.distance(a, rechts));
      if (unten) abst.push(Cesium.Cartesian3.distance(a, unten));
    }
    abst.sort((a, b) => a - b);
    const spann = abst.length && abst[abst.length >> 1] > 0 ? abst[abst.length >> 1] : 0.01;

    const schritt = offs[1] - offs[0];
    return {
      p: p, n: n, offs: offs, luecken: luecken, spann: spann,
      zentrum: { x: pos.x, y: pos.y },
      // Wie streng zwei Dreiecke zur selben Ebene zählen: je größer der
      // Probenabstand, desto enger — siehe EBENEN_WINKEL_GROB.
      winkel: schritt >= 8 ? EBENEN_WINKEL_GROB : EBENEN_WINKEL,
      tolFaktor: schritt >= 8 ? 0.25 : 0.6,
      // Meter je Bildpunkt an dieser Stelle — für die Länge einer Kantenmarke.
      mProPx: spann / schritt,
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

  /**
   * Je Zelle des Feldes eine Normale aus dem Dreieck links oben.
   *
   * Zu jeder Normale gehört der Schwerpunkt des Dreiecks (`m`, örtlich) und
   * sein Bildpunkt relativ zum Zeiger (`sx`, `sy`) — daran erkennt man später,
   * wie weit eine Ebene an einen Punkt heranreicht.
   */
  function normalen(feld) {
    const n = feld.n, offs = feld.offs;
    const out = [];
    const a = new Cesium.Cartesian3(), b = new Cesium.Cartesian3();
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < n - 1; j++) {
        const p0 = feld.p[i * n + j];
        const px = feld.p[(i + 1) * n + j];
        const py = feld.p[i * n + (j + 1)];
        if (!p0 || !px || !py) continue;
        Cesium.Cartesian3.subtract(px, p0, a);
        Cesium.Cartesian3.subtract(py, p0, b);
        // Ein Dreieck, dessen Kanten deutlich länger sind als der typische
        // Probenabstand, liegt über einem Tiefensprung — seine Normale ist
        // die des Sprungs, nicht die einer Fläche.
        if (Cesium.Cartesian3.magnitude(a) > 3 * feld.spann) continue;
        if (Cesium.Cartesian3.magnitude(b) > 3 * feld.spann) continue;
        const nn = Cesium.Cartesian3.cross(a, b, new Cesium.Cartesian3());
        if (Cesium.Cartesian3.magnitude(nn) < 1e-12) continue;
        Cesium.Cartesian3.normalize(nn, nn);
        // Alle Normalen zur Kamera drehen, sonst zerfällt eine Fläche in zwei
        // Gruppen mit entgegengesetztem Vorzeichen.
        if (Cesium.Cartesian3.dot(nn, feld.zurKamera) < 0) Cesium.Cartesian3.negate(nn, nn);
        out.push({
          n: nn, p: p0,
          m: new Cesium.Cartesian3((p0.x + px.x + py.x) / 3, (p0.y + px.y + py.y) / 3, (p0.z + px.z + py.z) / 3),
          sx: offs[i] + (offs[i + 1] - offs[i]) / 3,
          sy: offs[j] + (offs[j + 1] - offs[j]) / 3
        });
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
   *
   * Jede Ebene merkt sich ihre Dreiecke (`stuetzen`): wer wissen will, ob sie
   * bis an einen bestimmten Punkt reicht, fragt dort.
   */
  function ebenen(nrm, feld) {
    const tol = Math.max(0.003, feld.tolFaktor * feld.spann);
    const gruppen = [];
    for (const s of nrm) {
      const d = Cesium.Cartesian3.dot(s.n, s.p);
      let heim = null;
      for (const g of gruppen) {
        if (Cesium.Cartesian3.dot(g.n, s.n) < feld.winkel) continue;
        if (Math.abs(Cesium.Cartesian3.dot(g.n, s.p) - g.d) > tol) continue;
        heim = g; break;
      }
      if (heim) {
        heim.summe = Cesium.Cartesian3.add(heim.summe, s.n, heim.summe);
        heim.dSumme += d;
        heim.zahl++;
        heim.stuetzen.push(s);
        Cesium.Cartesian3.normalize(heim.summe, heim.n);
        heim.d = heim.dSumme / heim.zahl;
      } else {
        const n = Cesium.Cartesian3.clone(s.n);
        gruppen.push({
          n: n, d: d, zahl: 1, stuetzen: [s],
          summe: Cesium.Cartesian3.clone(s.n), dSumme: d
        });
      }
    }
    // Ebenen aus einer einzigen Probe sind Rauschen, keine Fläche.
    return gruppen.filter((g) => g.zahl >= 2).sort((a, b) => b.zahl - a.zahl);
  }

  /**
   * Zerlegt ein Feld in Ebenen — nicht über Dreiecksnormalen, sondern über die
   * Punkte selbst.
   *
   * Warum nicht `ebenen()`: im groben Feld liegt auf jeder Kante eine Reihe
   * Dreiecke, die halb zur einen, halb zur anderen Fläche gehören. Ihre
   * Normalen liegen dazwischen, und manche fallen zu zweit zusammen — eine
   * kleine Pseudo-Ebene, die gegen eine schmale echte Fläche (ein Dach im
   * streifenden Blick) antritt und sie verdrängt. Ein Dreieck trägt außerdem
   * nur drei Punkte; die Ebene, die aus einem Dutzend Punkten folgt, ist
   * genauer als der Mittelwert ihrer Dreiecke.
   *
   * Das Verfahren ist ein sequentielles RANSAC: jedes Dreieck des Feldes ist
   * eine Hypothese, gewinnt die mit den meisten Punkten im Toleranzband, wird
   * mit allen diesen Punkten neu ausgeglichen und samt ihren Punkten
   * herausgenommen. Dann die nächste. Ein Dreieck auf einer Kante hat nur
   * wenige Punkte im Band und gewinnt nie.
   *
   * Jede Ebene trägt ihre Punkte (`stuetzen`, mit Bildpunkt relativ zum
   * Zeiger) — daran wird später geprüft, ob sie bis an einen Fangpunkt reicht.
   */
  function ebenenAusPunkten(feld) {
    const n = feld.n, offs = feld.offs;
    const punkte = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const m = feld.p[i * n + j];
      if (m) punkte.push({ m: m, sx: offs[i], sy: offs[j] });
    }
    if (punkte.length < EBENE_MIN_PUNKTE) return [];

    // Hypothesen: die Ebene jedes Dreiecks, das nicht über einen Tiefensprung
    // spannt (dieselbe Regel wie in `normalen()`).
    const hyp = [];
    const a = new Cesium.Cartesian3(), b = new Cesium.Cartesian3();
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
      const p0 = feld.p[i * n + j], px = feld.p[(i + 1) * n + j], py = feld.p[i * n + (j + 1)];
      if (!p0 || !px || !py) continue;
      Cesium.Cartesian3.subtract(px, p0, a);
      Cesium.Cartesian3.subtract(py, p0, b);
      if (Cesium.Cartesian3.magnitude(a) > 3 * feld.spann) continue;
      if (Cesium.Cartesian3.magnitude(b) > 3 * feld.spann) continue;
      const nn = Cesium.Cartesian3.cross(a, b, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitude(nn) < 1e-12) continue;
      Cesium.Cartesian3.normalize(nn, nn);
      hyp.push({ n: nn, d: Cesium.Cartesian3.dot(nn, p0) });
    }

    const tol = Math.max(0.003, feld.tolFaktor * feld.spann);
    const im = (pl, q) => Math.abs(Cesium.Cartesian3.dot(pl.n, q.m) - pl.d) <= tol;
    const gruppen = [];
    let rest = punkte;

    while (gruppen.length < EBENEN_MAX && rest.length >= EBENE_MIN_PUNKTE && hyp.length) {
      let beste = null, zahl = 0;
      for (const h of hyp) {
        let z = 0;
        for (const q of rest) if (im(h, q)) z++;
        if (z > zahl) { zahl = z; beste = h; }
      }
      if (!beste || zahl < EBENE_MIN_PUNKTE) break;

      // Einmal ausgleichen, das Band neu anlegen, noch einmal ausgleichen.
      let pl = ausgleichsebene(rest.filter((q) => im(beste, q))) || beste;
      let drin = rest.filter((q) => im(pl, q));
      if (drin.length >= EBENE_MIN_PUNKTE) pl = ausgleichsebene(drin) || pl;
      drin = rest.filter((q) => im(pl, q));
      if (drin.length < EBENE_MIN_PUNKTE) break;

      gruppen.push({ n: pl.n, d: pl.d, zahl: drin.length, stuetzen: drin });
      rest = rest.filter((q) => drin.indexOf(q) < 0);
    }
    return gruppen;
  }

  /**
   * Die Ebene durch eine Punktmenge im Sinne der kleinsten Quadrate: der
   * Schwerpunkt und die Richtung der kleinsten Streuung.
   */
  function ausgleichsebene(punkte) {
    if (punkte.length < 3) return null;
    let cx = 0, cy = 0, cz = 0;
    for (const q of punkte) { cx += q.m.x; cy += q.m.y; cz += q.m.z; }
    cx /= punkte.length; cy /= punkte.length; cz /= punkte.length;
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const q of punkte) {
      const x = q.m.x - cx, y = q.m.y - cy, z = q.m.z - cz;
      C[0] += x * x; C[1] += x * y; C[2] += x * z;
      C[4] += y * y; C[5] += y * z; C[8] += z * z;
    }
    C[3] = C[1]; C[6] = C[2]; C[7] = C[5];
    const v = kleinsterEigenvektor(C);
    const n = new Cesium.Cartesian3(v[0], v[1], v[2]);
    if (Cesium.Cartesian3.magnitude(n) < 0.5) return null;
    Cesium.Cartesian3.normalize(n, n);
    return { n: n, d: n.x * cx + n.y * cy + n.z * cz };
  }

  /**
   * Eigenvektor zum kleinsten Eigenwert einer symmetrischen 3×3-Matrix
   * (zeilenweise, neun Zahlen) — Jacobi-Verfahren. Für 3×3 ist das ein
   * Dutzend Drehungen, und anders als eine Potenzmethode konvergiert es auch
   * dann, wenn die Punkte einen schmalen Streifen bilden und zwei Eigenwerte
   * weit auseinanderliegen.
   */
  function kleinsterEigenvektor(C) {
    const A = C.slice();
    const V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const spur = Math.abs(A[0]) + Math.abs(A[4]) + Math.abs(A[8]) + 1e-30;
    for (let durchgang = 0; durchgang < 24; durchgang++) {
      if (Math.abs(A[1]) + Math.abs(A[2]) + Math.abs(A[5]) < 1e-14 * spur) break;
      for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
        const apq = A[p * 3 + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (A[q * 3 + q] - A[p * 3 + p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = A[k * 3 + p], akq = A[k * 3 + q];
          A[k * 3 + p] = c * akp - s * akq; A[k * 3 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = A[p * 3 + k], aqk = A[q * 3 + k];
          A[p * 3 + k] = c * apk - s * aqk; A[q * 3 + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
          V[k * 3 + p] = c * vkp - s * vkq; V[k * 3 + q] = s * vkp + c * vkq;
        }
      }
    }
    let kl = 0;
    if (A[4] < A[kl * 4]) kl = 1;
    if (A[8] < A[kl * 4]) kl = 2;
    return [V[kl], V[3 + kl], V[6 + kl]];
  }

  // ── Die Kandidaten ─────────────────────────────────────────────────────────

  /**
   * Kante, Ecke und Silhouette aus dem feinen Feld am Zeiger. Alle drei werden
   * gerechnet, die Wahl trifft `fang()` nach dem Abstand.
   */
  function lokaleKandidaten(feld, gruppen, scene, pos, radius) {
    const aus = [];
    const fuege = (r, art) => {
      if (!r) return;
      const bs = scene.cartesianToCanvasCoordinates(r.ort);
      if (!bs) return;
      const d = Math.hypot(bs.x - pos.x, bs.y - pos.y);
      if (d > radius) return;
      aus.push({
        position: r.ort, art: art, ebenen: gruppen.length, abstand: d, bildschirm: bs,
        richtung: r.richtung || null, pickPixel: pos
      });
    };
    if (Fang.ecken && gruppen.length >= 3) {
      const e = ecke(gruppen.slice(0, 3), feld);
      if (e) fuege({ ort: e }, 'ecke');
    }
    if (Fang.kanten && gruppen.length >= 2) fuege(kanteRoh(gruppen, feld, scene, pos), 'kante');
    if (Fang.kanten && feld.luecken >= 4) fuege(silhouetteRoh(feld, scene, pos), 'silhouette');
    return aus;
  }

  /**
   * Die Offsets des groben Feldes: ein Vielfaches von GROB_SCHRITT, und zwar
   * **einen Schritt weiter als die Reichweite**.
   *
   * Eine Kante bei 36 px braucht hinter sich noch Proben, aus denen die zweite
   * Ebene folgt — und eine einzige Spalte genügt dafür nicht: aus Punkten, die
   * auf einer Geraden liegen, lässt sich keine Ebene bestimmen. Mit ±36 px
   * reichte der Fang für Kanten tatsächlich nur bis 24 px; gemessen, nicht
   * angenommen.
   */
  function grobOffsets(radius) {
    const k = Math.max(2, Math.min(5, Math.ceil((radius + GROB_SCHRITT) / GROB_SCHRITT)));
    const o = [];
    for (let i = -k; i <= k; i++) o.push(i * GROB_SCHRITT);
    return o;
  }

  /**
   * Die Suche im ganzen Umkreis. Siehe „Die Reichweite" im Kopf.
   *
   * Gibt eine Liste von Kandidaten zurück (leer, wenn der Umkreis nur eine
   * einzige Fläche enthält — der häufigste Fall, und der billigste).
   */
  function weiteSuche(scene, pos, radius) {
    const liste = [];
    const grob = proben(scene, pos, grobOffsets(radius));
    if (!grob) return liste;

    const gruppen = ebenenAusPunkten(grob);
    const stark = gruppen;
    const stuetzMax = STUETZ_FAKTOR * grob.spann;

    // Nimmt einen Fangpunkt auf, wenn alle beteiligten Ebenen bis an ihn
    // heranreichen und er innerhalb der Reichweite liegt.
    const aufnehmen = (ort, richtung, art, beteiligte) => {
      if (!ort) return;
      const loc = Cesium.Matrix4.multiplyByPoint(grob.nachOrt, ort, new Cesium.Cartesian3());
      let pixel = null, naechste = Infinity;
      for (const g of beteiligte) {
        let nah = Infinity, nahS = null;
        for (const s of g.stuetzen) {
          const d = Cesium.Cartesian3.distance(s.m, loc);
          if (d < nah) { nah = d; nahS = s; }
        }
        if (nah > stuetzMax) return;      // diese Ebene hört vorher auf
        if (nah < naechste) { naechste = nah; pixel = nahS; }
      }
      const bs = scene.cartesianToCanvasCoordinates(ort);
      if (!bs) return;
      const d = Math.hypot(bs.x - pos.x, bs.y - pos.y);
      if (d > radius) return;
      liste.push({
        position: ort, art: art, ebenen: gruppen.length, abstand: d, bildschirm: bs,
        richtung: richtung || null,
        // Ein Bildpunkt auf dem Dreieck, das dem Fangpunkt am nächsten liegt —
        // dort sitzt sicher Geometrie, selbst wenn der Fangpunkt am Rand steht.
        pickPixel: new Cesium.Cartesian2(pos.x + pixel.sx, pos.y + pixel.sy)
      });
    };

    if (Fang.kanten) {
      for (let a = 0; a < stark.length; a++) for (let b = a + 1; b < stark.length; b++) {
        const paar = [stark[a], stark[b]];
        const r = kanteRoh(paar, grob, scene, pos);
        if (r) aufnehmen(r.ort, r.richtung, 'kante', paar);
      }
    }
    if (Fang.ecken) {
      const m = Math.min(stark.length, 4);
      for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) for (let c = b + 1; c < m; c++) {
        const tripel = [stark[a], stark[b], stark[c]];
        aufnehmen(ecke(tripel, grob), null, 'ecke', tripel);
      }
    }

    // Die Silhouette: der nächstgelegene Rand einer Lücke im groben Feld,
    // dort fein nachgemessen. Grob allein wäre ±12 px ungenau.
    if (Fang.kanten) {
      const rand = naechsterRand(grob);
      if (rand && rand.abstand <= radius + GROB_SCHRITT) {
        const mitteRand = new Cesium.Cartesian2(pos.x + rand.sx, pos.y + rand.sy);
        const fein = proben(scene, mitteRand, OFFS);
        if (fein && fein.luecken >= 4) {
          const r = silhouetteRoh(fein, scene, pos);
          const bs = r ? scene.cartesianToCanvasCoordinates(r.ort) : null;
          const d = bs ? Math.hypot(bs.x - pos.x, bs.y - pos.y) : Infinity;
          if (d <= radius) {
            liste.push({
              position: r.ort, art: 'silhouette', ebenen: gruppen.length, abstand: d,
              bildschirm: bs, richtung: r.richtung || null, pickPixel: mitteRand
            });
          }
        }
      }
    }
    return liste;
  }

  /**
   * Die Stelle, an der eine Lücke im groben Feld beginnt und die dem Zeiger am
   * nächsten liegt: die Mitte zwischen einer treffenden Probe und ihrem leeren
   * Nachbarn. Die Kante liegt irgendwo dazwischen, und dort — nicht auf der
   * treffenden Probe — muss das feine Feld nachmessen, sonst deckt es die
   * Lücke nicht ab und sieht keine.
   */
  function naechsterRand(feld) {
    const n = feld.n, offs = feld.offs;
    let best = null;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (!feld.p[i * n + j]) continue;
      for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (a < 0 || a >= n || b < 0 || b >= n || feld.p[a * n + b] !== null) continue;
        const sx = (offs[i] + offs[a]) / 2, sy = (offs[j] + offs[b]) / 2;
        const d = Math.hypot(sx, sy);
        if (!best || d < best.abstand) best = { sx: sx, sy: sy, abstand: d };
      }
    }
    return best;
  }

  // ── Die drei Fänge ─────────────────────────────────────────────────────────

  /** Schnittpunkt der drei Ebenen, per Cramer. */
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
    // Eine Ecke, die weit außerhalb des Feldes liegt, ist ein Rechenartefakt
    // aus zwei fast parallelen Ebenen.
    if (Cesium.Cartesian3.magnitude(ort) > ARTEFAKT_PX * feld.mProPx + 0.05) return null;
    return Cesium.Matrix4.multiplyByPoint(feld.nachWelt, ort, new Cesium.Cartesian3());
  }

  /** Schnittgerade der beiden stärksten Ebenen, Zeiger darauf gelotet. */
  function kante(gruppen, feld, scene, pos) {
    const r = kanteRoh(gruppen, feld, scene, pos);
    return r ? r.ort : null;
  }

  function kanteRoh(gruppen, feld, scene, pos) {
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
    const r = silhouetteRoh(feld, scene, pos);
    return r ? r.ort : null;
  }

  function silhouetteRoh(feld, scene, pos) {
    const n = feld.n, offs = feld.offs;
    const rand = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const p = feld.p[i * n + j];
      if (!p) continue;
      // Wohin die Lücke liegt: die Summe der Richtungen zu den leeren Nachbarn.
      let ox = 0, oy = 0, offen = 0;
      for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (a < 0 || a >= n || b < 0 || b >= n || feld.p[a * n + b] !== null) continue;
        ox += offs[a] - offs[i]; oy += offs[b] - offs[j]; offen++;
      }
      if (offen) rand.push({ p: p, sx: offs[i], sy: offs[j], ox: ox, oy: oy });
    }
    if (rand.length < 3) return null;

    let a = rand[0], b = rand[1], weit = -1;
    for (let x = 0; x < rand.length; x++) for (let y = x + 1; y < rand.length; y++) {
      const d = Cesium.Cartesian3.distanceSquared(rand[x].p, rand[y].p);
      if (d > weit) { weit = d; a = rand[x]; b = rand[y]; }
    }
    if (weit < (0.8 * feld.spann) * (0.8 * feld.spann)) return null;

    const pa = randVerfeinern(a, feld, scene), pb = randVerfeinern(b, feld, scene);
    const u = Cesium.Cartesian3.subtract(pb, pa, new Cesium.Cartesian3());
    return aufGerade(pa, u, feld, scene, pos);
  }

  /**
   * Schiebt eine Randprobe bis an die Kante: zwischen der treffenden Probe und
   * ihrem leeren Nachbarn wird dreimal halbiert, die Kante damit von 3 px auf
   * gut ein halbes Pixel eingegrenzt.
   *
   * Ohne das liegt jede Randprobe auf dem 3-px-Raster des Feldes, und eine
   * Kante, die schräg im Bild steht, wird zur Treppe: die Gerade durch die
   * beiden äußersten Stufen kippt um bis zu 14°. Am Ort der Kante sind das
   * ein bis zwei Pixel, am Ende einer markierten Kante ein Dutzend.
   *
   * Ein Treffer weit hinter der Probe ist kein Teil dieser Kante, sondern
   * etwas dahinter, das zufällig ins Bild fällt — er zählt als leer.
   */
  function randVerfeinern(r, feld, scene) {
    const breite = scene.canvas ? scene.canvas.clientWidth : Infinity;
    const hoehe = scene.canvas ? scene.canvas.clientHeight : Infinity;
    let lx = feld.zentrum.x + r.sx, ly = feld.zentrum.y + r.sy;     // treffende Seite
    let hx = lx + r.ox, hy = ly + r.oy;                              // leere Seite
    let beste = r.p;
    const c2 = new Cesium.Cartesian2();
    for (let k = 0; k < 3; k++) {
      const mx = (lx + hx) / 2, my = (ly + hy) / 2;
      let treffer = null;
      if (mx >= 0 && my >= 0 && mx < breite && my < hoehe) {
        c2.x = mx; c2.y = my;
        const q = scene.pickPosition(c2);
        if (Cesium.defined(q) && isFinite(q.x)) {
          const lokal = Cesium.Matrix4.multiplyByPoint(feld.nachOrt, q, new Cesium.Cartesian3());
          if (Cesium.Cartesian3.distance(lokal, beste) <= 3 * feld.spann) treffer = lokal;
        }
      }
      if (treffer) { lx = mx; ly = my; beste = treffer; }
      else { hx = mx; hy = my; }
    }
    return beste;
  }

  /**
   * Der Punkt der Geraden (q, u), der **am Schirm** dem Zeiger am nächsten
   * liegt. Gerechnet wird örtlich; zurück kommen der Punkt (ECEF) und die
   * Richtung der Geraden (ECEF, Einheitsvektor) — die Richtung braucht, wer die
   * Kante im Bild markieren will.
   *
   * Zwei Schritte: erst wird die Gerade ins Bild projiziert und der Fußpunkt
   * des Zeigers auf dieser Bildgeraden bestimmt, dann der Sichtstrahl durch
   * diesen Fußpunkt mit der Geraden im Raum geschnitten. Er trifft sie, weil
   * der Fußpunkt auf ihrem Bild liegt.
   *
   * Früher wurde der Sichtstrahl **durch den Zeiger** auf die Gerade gelotet
   * (kürzester Abstand zweier windschiefer Geraden). Das liefert den Punkt, der
   * dem Strahl im Raum am nächsten liegt — und der steht am Schirm ein Stück
   * neben dem Zeiger, bei einer senkrechten Kante im Blick von oben deutlich
   * darunter. Man sah die Markierung neben der Kante hinunterrutschen statt an
   * der Stelle zu stehen, auf die man zeigte, und die Reichweite stimmte nicht:
   * sie endete bei 31 statt bei 36 Bildpunkten.
   */
  function aufGerade(q, u, feld, scene, pos) {
    Cesium.Cartesian3.normalize(u, u);

    // Das Bild der Geraden: zwei Punkte darauf, weit genug auseinander, dass
    // die Richtung im Bild belastbar ist.
    let fuss = pos;
    const L = 100 * feld.mProPx;
    const welt = (loc) => Cesium.Matrix4.multiplyByPoint(feld.nachWelt, loc, new Cesium.Cartesian3());
    const bA = scene.cartesianToCanvasCoordinates(welt(
      Cesium.Cartesian3.subtract(q, Cesium.Cartesian3.multiplyByScalar(u, L, new Cesium.Cartesian3()), new Cesium.Cartesian3())));
    const bB = scene.cartesianToCanvasCoordinates(welt(
      Cesium.Cartesian3.add(q, Cesium.Cartesian3.multiplyByScalar(u, L, new Cesium.Cartesian3()), new Cesium.Cartesian3())));
    if (bA && bB) {
      const dx = bB.x - bA.x, dy = bB.y - bA.y, l2 = dx * dx + dy * dy;
      if (l2 > 1) {
        const t = ((pos.x - bA.x) * dx + (pos.y - bA.y) * dy) / l2;
        fuss = new Cesium.Cartesian2(bA.x + t * dx, bA.y + t * dy);
      }
    }

    const strahl = scene.camera.getPickRay(fuss);
    if (!strahl) return null;
    const o = Cesium.Matrix4.multiplyByPoint(feld.nachOrt, strahl.origin, new Cesium.Cartesian3());
    const v = Cesium.Matrix4.multiplyByPointAsVector(feld.nachOrt, strahl.direction, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(v, v);

    // Vom Aufpunkt der Geraden zum Auge, nicht umgekehrt: mit q − o statt o − q
    // kommt s mit falschem Vorzeichen heraus, und der Punkt liegt zwar auf der
    // Geraden, aber gespiegelt um ihren Aufpunkt. Das stand lange so im Code und
    // fiel nicht auf, weil nur der Abstand zur Geraden geprüft wurde — nicht,
    // wo auf ihr der Punkt sitzt.
    const w = Cesium.Cartesian3.subtract(o, q, new Cesium.Cartesian3());
    const uv = Cesium.Cartesian3.dot(u, v);
    const nenner = 1 - uv * uv;
    if (Math.abs(nenner) < 1e-6) return null;   // Blick genau entlang der Kante
    const s = (Cesium.Cartesian3.dot(w, u) - uv * Cesium.Cartesian3.dot(w, v)) / nenner;

    const ort = Cesium.Cartesian3.add(q, Cesium.Cartesian3.multiplyByScalar(u, s, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    // Ein Punkt, der weit außerhalb des Feldes liegt, ist keine Kante in diesem
    // Feld, sondern die Verlängerung einer Geraden ins Leere.
    if (Cesium.Cartesian3.magnitude(ort) > ARTEFAKT_PX * feld.mProPx + 0.05) return null;

    const richtung = Cesium.Matrix4.multiplyByPointAsVector(feld.nachWelt, u, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(richtung, richtung);
    return { ort: welt(ort), richtung: richtung };
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
      bildschirm: best.bildschirm, ebenen: 0, index: best.index,
      richtung: null, abstandPx: bestD, pickPixel: null
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
  console.log('🧲 Aufmaß-Fang geladen — Ecke, Kante, Silhouette, Raster, Reichweite');
})();
