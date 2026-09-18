/**
 * aufmass.js — Ein Modus für alles.
 *
 * Die Idee
 * ========
 * Es gibt nichts mehr umzuschalten. Kein „jetzt Länge", kein „jetzt Fläche",
 * kein „jetzt Volumen" — es gibt **eine** Kette von Punkten, und wie viele
 * davon gesetzt sind, sagt bereits, was gemessen wurde:
 *
 *   1 Punkt    → Koordinate
 *   2 Punkte   → Strecke, mit ΔOst, ΔNord, ΔHöhe und Neigung
 *   3 und mehr → Fläche, Umfang — und daraus von selbst:
 *                die Box zwischen tiefstem und höchstem Punkt um den
 *                Schwerpunkt, ihr Volumen, das gemessene Volumen der
 *                Baugrube darin und das Verhältnis der beiden
 *
 * Der Vorgänger (`measurement-v4.js`, `measurement.js`, `measurement-store.js`,
 * zusammen 2 500 Zeilen) hatte sechs Knöpfe für sechs Modi, jeder mit eigenem
 * Ereignisbehandler, eigener Vorschau und eigenem Speicherweg. Wer die
 * Grundfläche eines Raums *und* seine Höhe wollte, maß zweimal und rechnete
 * selbst. Hier fällt beides in einem Zug an, weil beides in denselben Punkten
 * steckt.
 *
 * Was während des Messens passiert
 * ================================
 * - Der Zeiger springt auf Ecken, Kanten und Silhouetten (`aufmass-fang.js`).
 *   Das Fadenkreuz steht auf dem gefangenen Punkt, nicht auf der Maus — der
 *   Systemzeiger wird ausgeblendet, damit man nur einen von beiden sieht.
 * - Jedes Maß steht mittig an seiner Maßlinie und rechnet mit, solange sich
 *   der Zeiger bewegt. Die Fläche steht im Schwerpunkt des Polygons.
 * - Jeder Klick geht als Tripel in den Graphen (`aufmass-rdf.js`): Koordinate,
 *   Fangart, Trefferart und — wenn ein Bauteil getroffen wurde — dessen
 *   GlobalId, IFC-Klasse und Name.
 *
 * Warum keine Entities neu gebaut werden
 * ======================================
 * Alles Bewegliche hängt an `CallbackProperty`. Die Kette, das Polygon, jede
 * Maßzahl lesen bei jedem Bild denselben Zustand aus; gebaut wird nur, wenn
 * ein Punkt dazukommt oder wegfällt. Ein Entity je Mausbewegung neu zu setzen
 * hieße, den Szenegraphen sechzigmal je Sekunde umzubauen — das ist der
 * Unterschied zwischen einer flüssigen Vorschau und einer, die beim dritten
 * Punkt hakt.
 *
 * Bedienung
 * =========
 *   Klick          Punkt setzen
 *   Doppelklick    abschließen
 *   Rechtsklick    abschließen
 *   Enter          abschließen
 *   Rücktaste      letzten Punkt zurücknehmen
 *   Esc            Kette verwerfen (nochmal: Modus verlassen)
 *   G              Raster: aus → cm → mm
 *
 * Nach dem Abschluss läuft der Modus weiter und die nächste Kette beginnt.
 * Messen ist selten eine einzelne Handlung.
 */
(function (BimViewer) {
  'use strict';

  const GRUEN = '#97BF0D';
  const BLAU = '#4DA6FF';

  // Fang und Vorschau kosten je Auswertung fünfundzwanzig Tiefenabfragen.
  // Wie oft das geht, hängt an der Szene — deshalb wird nicht auf eine feste
  // Frequenz gedrosselt, sondern auf das Doppelte der zuletzt gemessenen
  // Dauer. In einer leichten Szene läuft die Vorschau damit mit dem Bild, in
  // einer schweren wird sie träge, statt das Bild mit herunterzuziehen.
  const PAUSE_MIN = 16, PAUSE_MAX = 120;

  const Z = {
    aktiv: false,
    punkte: [],        // gesetzte Punkte, siehe punktDaten()
    vorschau: null,    // Cartesian3 unter dem Zeiger, oder null
    fang: null,        // letztes Ergebnis von AufmassFang.fang()
    anker: null,       // Cartesian3 des ersten Punktes
    nachOrt: null,     // Matrix4 ECEF → Ost-Nord-Hoch am Anker
    nachWelt: null,
    messungen: [],     // abgeschlossene Messungen dieser Sitzung
    letzte: null,      // die zuletzt abgeschlossene
    ds: null,          // CustomDataSource
    marken: [],        // Punkt-Entities
    masse: [],         // Maßzahl-Entities (Pool, wächst nur)
    kasten: [],        // Box-Entities der letzten Messung
    handler: null,
    tastatur: null,
    hud: null,
    kreuz: null,
    pause: 24,
    letzteAuswertung: 0,
    schnittAn: false,
    // Ob eine fertige Fläche das topografische Aufmaß (`volume-topo.js`) von
    // selbst anstößt. An, weil die Frage nach dem Volumen bei einer Fläche
    // über einer Punktwolke fast immer schon gestellt ist — aber abschaltbar,
    // weil die Rechnung über einer großen Wolke Sekunden dauert und man
    // manchmal nur die Fläche will. Das eigenständige Aufmaß im Panel bleibt
    // davon unberührt: es ist ein eigener Modus und kein Anhängsel hier.
    autoBaugrube: true,
    schnitte: [],      // [{ tileset, sammlung }] — bleiben hängen, siehe schnitt()
  };

  // ══ Modus ═════════════════════════════════════════════════════════════════

  function start() {
    if (Z.aktiv) return true;
    const viewer = BimViewer.viewer;
    if (!viewer) { console.warn('[Aufmaß] kein Viewer'); return false; }

    Z.aktiv = true;
    if (!Z.ds) {
      Z.ds = new Cesium.CustomDataSource('aufmass');
      viewer.dataSources.add(Z.ds);
      grundEntities();
    }
    hudAnlegen();
    viewer.scene.canvas.style.cursor = 'none';

    Z.handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    Z.handler.setInputAction((m) => zeiger(m.endPosition), Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    Z.handler.setInputAction((e) => klickAn(e.position), Cesium.ScreenSpaceEventType.LEFT_CLICK);
    Z.handler.setInputAction(() => { zurueck(); abschluss(); }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    Z.handler.setInputAction(() => abschluss(), Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    Z.tastatur = (e) => {
      if (!Z.aktiv) return;
      if (e.key === 'Enter') { e.preventDefault(); abschluss(); }
      else if (e.key === 'Backspace') { e.preventDefault(); zurueck(); }
      else if (e.key === 'Escape') { e.preventDefault(); Z.punkte.length ? abbrechen() : stop(); }
      else if (e.key === 'g' || e.key === 'G') { e.preventDefault(); rasterWeiter(); }
    };
    window.addEventListener('keydown', Z.tastatur);

    melden('Klicken setzt Punkte · Enter schließt ab · Esc verwirft');
    if (window.BimViewerUI && BimViewerUI.aufmassStand) BimViewerUI.aufmassStand();
    console.log('📐 Aufmaß an');
    return true;
  }

  function stop() {
    if (!Z.aktiv) return;
    Z.aktiv = false;
    abbrechen();
    if (Z.handler) { Z.handler.destroy(); Z.handler = null; }
    if (Z.tastatur) { window.removeEventListener('keydown', Z.tastatur); Z.tastatur = null; }
    if (BimViewer.viewer) BimViewer.viewer.scene.canvas.style.cursor = '';
    if (Z.hud) Z.hud.style.display = 'none';
    if (Z.kreuz) Z.kreuz.style.display = 'none';
    if (window.BimViewerUI && BimViewerUI.aufmassStand) BimViewerUI.aufmassStand();
    console.log('📐 Aufmaß aus');
  }

  const umschalten = () => (Z.aktiv ? stop() : start());

  // ══ Zeiger ════════════════════════════════════════════════════════════════

  function zeiger(pos) {
    if (!Z.aktiv || !pos) return;
    const jetzt = performance.now();
    if (jetzt - Z.letzteAuswertung < Z.pause) return;
    Z.letzteAuswertung = jetzt;

    const t0 = performance.now();
    const treffer = window.AufmassFang
      ? AufmassFang.fang(pos, { anker: Z.anker, punkte: Z.punkte.map((p) => p.ecef) })
      : rohPunkt(pos);
    Z.pause = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, 2 * (performance.now() - t0)));

    Z.fang = treffer;
    Z.vorschau = treffer ? treffer.position : null;
    kreuzSetzen(treffer ? treffer.bildschirm : pos, treffer);
    hudSchreiben();
  }

  /** Rückfall ohne Fangmodul — der reine Tiefenpuffer. */
  function rohPunkt(pos) {
    const scene = BimViewer.viewer.scene;
    const p = scene.pickPosition(pos);
    if (!Cesium.defined(p)) return null;
    return { position: p, art: 'flaeche', guete: 1, bildschirm: pos, ebenen: 1 };
  }

  // ══ Punkte setzen ═════════════════════════════════════════════════════════

  function klickAn(pos) {
    if (!Z.aktiv) return;
    // Es wird der Punkt gesetzt, der zu sehen war — nicht neu gepickt. Sonst
    // kann zwischen Vorschau und Klick ein anderer Fang gewinnen, und man
    // setzt woandershin, als das Fadenkreuz stand.
    let treffer = Z.fang;
    if (!treffer || abstandPx(treffer.bildschirm, pos) > 24) {
      treffer = window.AufmassFang
        ? AufmassFang.fang(pos, { anker: Z.anker, punkte: Z.punkte.map((p) => p.ecef) })
        : rohPunkt(pos);
    }
    if (!treffer) {
      const z = window.AufmassFang && AufmassFang.ziel;
      melden(z && z !== 'auto'
        ? 'Dort liegt kein ' + (TRAEGERTEXT[z] || z) + ' — Messen auf „alles" stellen oder anderswo zeigen'
        : 'Dort liegt nichts — auf Geometrie, Gelände oder Wolke zeigen');
      return;
    }

    // Auf den ersten Punkt geklickt heißt: Polygon schließen.
    if (treffer.art === 'messpunkt' && treffer.index === 0 && Z.punkte.length >= 3) {
      abschluss(); return;
    }
    setzen(treffer, pos);
  }

  function setzen(treffer, bildschirmPos) {
    if (!Z.punkte.length) rahmenSetzen(treffer.position);
    const d = punktDaten(treffer, bildschirmPos);
    Z.punkte.push(d);
    markeAnlegen(d);
    massePflegen();
    melden(hinweis());
    hudSchreiben();
    if (window.BimViewerUI && BimViewerUI.aufmassStand) BimViewerUI.aufmassStand();
    return d;
  }

  /** Setzt den Ursprung des örtlichen Ost-Nord-Hoch-Systems auf den ersten Punkt. */
  function rahmenSetzen(ecef) {
    Z.anker = Cesium.Cartesian3.clone(ecef);
    Z.nachWelt = Cesium.Transforms.eastNorthUpToFixedFrame(Z.anker);
    Z.nachOrt = Cesium.Matrix4.inverse(Z.nachWelt, new Cesium.Matrix4());
  }

  const ort = (ecef, m) => Cesium.Matrix4.multiplyByPoint(m || Z.nachOrt, ecef, new Cesium.Cartesian3());
  const welt = (o, m) => Cesium.Matrix4.multiplyByPoint(m || Z.nachWelt, o, new Cesium.Cartesian3());

  function punktDaten(treffer, bildschirmPos) {
    const c = Cesium.Cartographic.fromCartesian(treffer.position);
    const o = ort(treffer.position);
    const bauteil = bildschirmPos ? getroffenesBauteil(bildschirmPos) : null;
    return {
      ecef: treffer.position,
      lon: c ? Cesium.Math.toDegrees(c.longitude) : NaN,
      lat: c ? Cesium.Math.toDegrees(c.latitude) : NaN,
      hoehe: c ? c.height : NaN,
      ost: o.x, nord: o.y, auf: o.z,
      fangart: treffer.art,
      trefferart: bauteil ? 'Bauteil' : trefferartAus(treffer),
      bauteil: bauteil,
      zeit: new Date().toISOString(),
      iri: null,
    };
  }

  function trefferartAus(treffer) {
    if (treffer.art === 'splat') return 'Splat';
    const scene = BimViewer.viewer.scene;
    return scene.globe && scene.globe.show ? 'Gelände' : 'Geometrie';
  }

  const GUID_NAMEN = ['GlobalId', 'globalId', 'GUID', 'Guid', 'guid', 'IfcGUID'];
  const TYP_NAMEN = ['IfcType', 'ifcType', 'IfcClass', 'className', 'Entity', 'type'];
  const NAME_NAMEN = ['Name', 'name', 'LongName', 'ObjectType'];
  const GESCHOSS_NAMEN = ['Storey', 'storey', 'BuildingStorey', 'Level', 'Geschoss'];

  function getroffenesBauteil(pos) {
    const scene = BimViewer.viewer.scene;
    let f;
    try { f = scene.pick(pos); } catch (e) { return null; }
    if (!(f instanceof Cesium.Cesium3DTileFeature)) return null;
    const hol = (namen) => {
      for (const n of namen) {
        try { const v = f.getProperty(n); if (v !== undefined && v !== null && v !== '') return String(v); }
        catch (e) { /* Batch Table ohne diese Spalte */ }
      }
      return null;
    };
    const gid = hol(GUID_NAMEN);
    if (!gid) return null;
    let modell = null, jobId = null;
    if (BimViewer.loadedAssets) {
      BimViewer.loadedAssets.forEach((a, schluessel) => {
        if (a.tileset !== f.tileset) return;
        modell = a.name || String(schluessel);
        jobId = a.jobId || null;
      });
    }
    const bauteil = {
      globalId: gid, ifcType: hol(TYP_NAMEN), name: hol(NAME_NAMEN),
      geschoss: hol(GESCHOSS_NAMEN), modell: modell, jobId: jobId,
      mengen: null,
    };

    // Volumen, Material und CO₂ stehen nicht in der Batch Table, sondern in
    // den Property-Sets im Backend. Der Abruf läuft **neben** dem Klick: ein
    // Messpunkt darf nicht auf eine HTTP-Antwort warten. Beim Abschluss wird
    // einmal auf alle offenen Abrufe gewartet, damit im Graphen nichts fehlt.
    if (window.AufmassMengen && jobId) {
      AufmassMengen.laden(jobId, gid).then((m) => {
        bauteil.mengen = m;
        if (window.BimViewerUI && BimViewerUI.aufmassStand) BimViewerUI.aufmassStand();
      });
    }
    return bauteil;
  }

  function zurueck() {
    if (!Z.punkte.length) return;
    Z.punkte.pop();
    const m = Z.marken.pop();
    if (m) Z.ds.entities.remove(m);
    if (!Z.punkte.length) { Z.anker = null; Z.nachOrt = null; Z.nachWelt = null; }
    massePflegen();
    melden(hinweis());
    hudSchreiben();
    if (window.BimViewerUI && BimViewerUI.aufmassStand) BimViewerUI.aufmassStand();
  }

  function abbrechen() {
    Z.punkte = [];
    Z.anker = Z.nachOrt = Z.nachWelt = null;
    Z.marken.forEach((e) => Z.ds && Z.ds.entities.remove(e));
    Z.marken = [];
    Z.masse.forEach((e) => { e.show = false; });
    massePflegen();
    melden(Z.aktiv ? 'Klicken setzt Punkte · Enter schließt ab' : '');
    hudSchreiben();
    if (window.BimViewerUI && BimViewerUI.aufmassStand) BimViewerUI.aufmassStand();
  }

  function rasterWeiter() {
    if (!window.AufmassFang) return;
    const folge = ['aus', 'cm', 'mm'];
    AufmassFang.raster = folge[(folge.indexOf(AufmassFang.raster) + 1) % 3];
    melden('Raster: ' + AufmassFang.raster);
    hudSchreiben();
    if (window.BimViewerUI && BimViewerUI.aufmassStand) BimViewerUI.aufmassStand();
  }

  // ══ Rechnen ═══════════════════════════════════════════════════════════════

  // Vier CallbackProperties fragen im selben Bild dieselbe Rechnung. Ohne
  // Merker liefe sie viermal und legte dabei jedes Mal ein paar Dutzend
  // Cartesian3 an — bei sechzig Bildern je Sekunde und einem Polygon aus
  // zwanzig Punkten ist das der teuerste Posten im ganzen Modul.
  const merker = { schluessel: null, wert: null };
  function rechnenAktuell() {
    const k = kette();
    const s = k.length + '|' + (Z.vorschau ? Z.vorschau.x.toFixed(4) : '-') + '|' + Z.punkte.length;
    if (merker.schluessel !== s) { merker.schluessel = s; merker.wert = rechnen(k); }
    return merker.wert;
  }

  /**
   * Dieselbe Kette, aber ein Stück zur Kamera gezogen — nur zum Zeichnen.
   *
   * Gemessen wird fast immer *auf* einer Fläche: einem Dach, einer Wand,
   * einem Boden. Linie und Füllung liegen damit in derselben Ebene wie die
   * Geometrie und streiten mit ihr um den Tiefenwert; im Bild verschwindet
   * die Fläche dann fleckig im Bauteil und die Maßlinie erscheint als
   * gestrichelte Rückfalllinie, obwohl nichts davor steht.
   *
   * Der Versatz wächst mit der Entfernung, weil die Tiefenauflösung mit ihr
   * abnimmt — nah bleibt er unter zwei Zentimetern, auf hundert Meter sind es
   * acht. Am Maß ändert er nichts: `kette()` bleibt unangetastet, und die
   * Punktmarken stehen ohnehin über allem (`disableDepthTestDistance`).
   */
  function ketteGezeichnet() {
    const k = kette();
    if (!k.length || !BimViewer.viewer) return k;
    const kam = BimViewer.viewer.scene.camera.positionWC;
    return k.map((p) => versetzt(p, kam));
  }

  function versetzt(p, kam) {
    const v = Cesium.Cartesian3.subtract(kam, p, new Cesium.Cartesian3());
    const d = Cesium.Cartesian3.magnitude(v);
    if (!d) return p;
    const weite = Math.max(0.02, 0.0008 * d);
    return Cesium.Cartesian3.add(
      p, Cesium.Cartesian3.multiplyByScalar(v, weite / d, v), new Cesium.Cartesian3());
  }

  /** Die laufende Kette: gesetzte Punkte plus, solange gemessen wird, der Zeiger. */
  function kette() {
    const ps = Z.punkte.map((p) => p.ecef);
    if (Z.aktiv && Z.vorschau && Z.punkte.length) ps.push(Z.vorschau);
    return ps;
  }

  /**
   * Alle Maße aus einer Punktfolge — dieselbe Rechnung für die Vorschau und
   * für das Ergebnis. Zwei getrennte Wege wären zwei Gelegenheiten, sich zu
   * unterscheiden; genau daran krankte die Vorgängerfassung, deren Vorschau
   * die Fläche eben und das Ergebnis sie räumlich rechnete.
   *
   * Die Fläche kommt aus Newells Verfahren: die Summe der Kreuzprodukte
   * aufeinanderfolgender Ortsvektoren ist der doppelte Flächenvektor. Das ist
   * für ebene Polygone exakt, für windschiefe die Fläche der besten
   * Ausgleichsebene — und seine z-Komponente ist ohne weiteres Zutun die
   * Grundfläche im Grundriss.
   */
  function rechnen(ecefListe, rahmen) {
    const nachOrt = rahmen ? rahmen.nachOrt : Z.nachOrt;
    const nachWelt = rahmen ? rahmen.nachWelt : Z.nachWelt;
    if (!ecefListe.length || !nachOrt) return null;
    // Kein `map(ort)`: Array.map reicht den Index als zweites Argument weiter,
    // und der landete dann als Matrix im Umrechnen. Das Ergebnis waren
    // NaN-Abstände ab dem zweiten Punkt — sichtbar erst in den Zahlen, nicht
    // in der Zeichnung, weil die Punkte selbst richtig blieben.
    const o = ecefListe.map((p) => ort(p, nachOrt));
    const r = { n: o.length, laenge: 0, umfang: 0, flaeche: 0, flaecheHorizontal: 0, strecken: [] };

    for (let i = 0; i + 1 < o.length; i++) {
      const a = o[i], b = o[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const dh = Math.hypot(dx, dy);
      const s = {
        distanz: Math.hypot(dx, dy, dz), dx, dy, dz, horizontal: dh,
        // In Grad, nicht als Verhältnis dz/dh. Das Verhältnis sprengt an
        // jeder steilen Kante: an einer 10 m hohen Fassadenkante mit 11 cm
        // Grundrissversatz stand „90,07" da — eine Zahl, die wie ein
        // Gradmaß aussieht, keins ist und deren nächster Nachbar unendlich
        // heißt. Der Winkel ist auf ±90° beschränkt und immer lesbar.
        neigung: Math.atan2(dz, dh) * 180 / Math.PI,
        mitte: welt(new Cesium.Cartesian3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2), nachWelt),
      };
      r.strecken.push(s);
      r.laenge += s.distanz;
    }
    r.umfang = r.laenge;

    if (o.length >= 3) {
      // Schließende Kante mitzählen — ohne sie ist der Umfang der einer
      // offenen Kette, und die Fläche gehört zu einem geschlossenen Polygon.
      const a = o[o.length - 1], b = o[0];
      r.umfang += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < o.length; i++) {
        const p = o[i], q = o[(i + 1) % o.length];
        nx += p.y * q.z - p.z * q.y;
        ny += p.z * q.x - p.x * q.z;
        nz += p.x * q.y - p.y * q.x;
      }
      r.flaeche = 0.5 * Math.hypot(nx, ny, nz);
      r.flaecheHorizontal = 0.5 * Math.abs(nz);
      r.schwerpunkt = welt(new Cesium.Cartesian3(
        o.reduce((s, p) => s + p.x, 0) / o.length,
        o.reduce((s, p) => s + p.y, 0) / o.length,
        o.reduce((s, p) => s + p.z, 0) / o.length), nachWelt);
      r.box = boxAus(o);
    }
    return r;
  }

  /**
   * Die Box: das **kleinste** umschließende Rechteck im Grundriss, hoch vom
   * tiefsten bis zum höchsten Punkt.
   *
   * Achsparallel wäre einfacher und fast immer falsch: ein Gebäude, das
   * dreißig Grad zur Nordrichtung steht, bekäme eine Box, die ein Drittel
   * größer ist als das, was gemessen wurde — und ein Füllverhältnis, das
   * nichts mehr aussagt.
   *
   * **Die naheliegende Abhilfe, die Hauptachse der Punktwolke, ist auch
   * falsch.** Bei einem L-förmigen Umriss von 6 × 6 m liegt die Hauptachse
   * auf der Symmetriediagonalen; die Box wird 8,49 m lang und deutlich größer
   * als die achsparallele. Die Hauptachse beschreibt die *Streuung* der Ecken,
   * nicht die Ausdehnung der Fläche — bei einem Rechteck fällt beides
   * zusammen, sonst nicht.
   *
   * Deshalb wird das Minimum wirklich gesucht, mit dem Satz von Freeman und
   * Shapira: **das flächenkleinste umschließende Rechteck hat eine Seite auf
   * einer Kante der konvexen Hülle.** Es genügt also, die Hülle zu bilden und
   * je Hüllkante einmal abzumessen — ein Dutzend Kanten bei einem gezeichneten
   * Umriss. Für ein gedrehtes Rechteck kommt exakt dieses Rechteck heraus, für
   * das L die achsparallele 6 × 6, und in keinem Fall etwas Größeres als beide
   * Näherungen.
   */
  function boxAus(o) {
    const huelle = konvexeHuelle(o.map((p) => ({ x: p.x, y: p.y })));

    let best = null;
    for (let i = 0; i < huelle.length && huelle.length >= 2; i++) {
      const a = huelle[i], b = huelle[(i + 1) % huelle.length];
      const laenge = Math.hypot(b.x - a.x, b.y - a.y);
      if (laenge < 1e-12) continue;
      const ux = (b.x - a.x) / laenge, uy = (b.y - a.y) / laenge;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const p of huelle) {
        const s = p.x * ux + p.y * uy;
        const t = -p.x * uy + p.y * ux;
        if (s < u0) u0 = s; if (s > u1) u1 = s;
        if (t < v0) v0 = t; if (t > v1) v1 = t;
      }
      const flaeche = (u1 - u0) * (v1 - v0);
      if (!best || flaeche < best.flaeche - 1e-12) {
        best = { flaeche, ux, uy, u0, u1, v0, v1 };
      }
    }
    // Weniger als zwei verschiedene Punkte im Grundriss — eine senkrechte
    // Kette etwa. Dann gibt es keine Richtung, und Nord ist so gut wie jede.
    if (!best) {
      const mx = o.reduce((s, p) => s + p.x, 0) / o.length;
      const my = o.reduce((s, p) => s + p.y, 0) / o.length;
      best = { ux: 1, uy: 0, u0: mx, u1: mx, v0: my, v1: my };
    }

    const u = { x: best.ux, y: best.uy };
    const v = { x: -best.uy, y: best.ux };
    const um = (best.u0 + best.u1) / 2, vm = (best.v0 + best.v1) / 2;
    const z0 = Math.min(...o.map((p) => p.z));
    const z1 = Math.max(...o.map((p) => p.z));

    return {
      theta: Math.atan2(best.uy, best.ux), u, v,
      mitte: { x: um * u.x + vm * v.x, y: um * u.y + vm * v.y, z: (z0 + z1) / 2 },
      laenge: best.u1 - best.u0, breite: best.v1 - best.v0, hoehe: z1 - z0,
      unten: z0, oben: z1,
    };
  }

  /**
   * Konvexe Hülle im Grundriss, monotone Kette nach Andrew — Sortieren und
   * zweimal durchlaufen. Für die paar Dutzend Punkte einer gezeichneten
   * Messung ist alles andere Zierde; gebraucht wird sie nur, weil das
   * kleinste Rechteck ihre Kanten abschreitet.
   */
  function konvexeHuelle(punkte) {
    const s = punkte.slice().sort((a, b) => a.x - b.x || a.y - b.y)
      .filter((p, i, arr) => i === 0 || Math.abs(p.x - arr[i - 1].x) > 1e-12 || Math.abs(p.y - arr[i - 1].y) > 1e-12);
    if (s.length < 3) return s;
    const kreuz = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const unten = [], oben = [];
    for (const q of s) {
      while (unten.length >= 2 && kreuz(unten[unten.length - 2], unten[unten.length - 1], q) <= 0) unten.pop();
      unten.push(q);
    }
    for (let i = s.length - 1; i >= 0; i--) {
      const q = s[i];
      while (oben.length >= 2 && kreuz(oben[oben.length - 2], oben[oben.length - 1], q) <= 0) oben.pop();
      oben.push(q);
    }
    unten.pop(); oben.pop();
    return unten.concat(oben);
  }

  /** Die acht Ecken der Box in ECEF — Grundlage für Drahtgitter und Schnitt. */
  function boxEcken(b, nachWelt) {
    const a = b.laenge / 2, c = b.breite / 2, h = b.hoehe / 2;
    const eck = [];
    for (const sz of [-1, 1]) for (const sv of [-1, 1]) for (const su of [-1, 1]) {
      eck.push(welt(new Cesium.Cartesian3(
        b.mitte.x + su * a * b.u.x + sv * c * b.v.x,
        b.mitte.y + su * a * b.u.y + sv * c * b.v.y,
        b.mitte.z + sz * h), nachWelt));
    }
    return eck;  // Reihenfolge: [z-][v-][u-], [z-][v-][u+], [z-][v+][u-], …
  }

  // ══ Abschluss ═════════════════════════════════════════════════════════════

  async function abschluss() {
    if (!Z.punkte.length) return null;
    const punkte = Z.punkte.slice();
    const ecefs = punkte.map((p) => p.ecef);
    Z.vorschau = null;
    const r = rechnen(ecefs) || { n: punkte.length };

    const art = punkte.length === 1 ? 'Punktmessung'
      : punkte.length === 2 ? 'Streckenmessung'
      : 'Flaechenmessung';

    const m = {
      id: 'M' + (Z.messungen.length + 1),
      art, punkte, ecefs, ergebnis: r,
      zeit: new Date().toISOString(),
      baugrube: null, box: r.box || null,
      // Der Bezugsrahmen wandert mit der Messung. Er am Zustand hängen zu
      // lassen hieße: sobald die nächste Kette beginnt, zeigt die Box der
      // vorigen woandershin — sichtbar erst beim Schneiden, und dann als
      // Ausschnitt an einer Stelle, an der nie jemand gemessen hat.
      nachWelt: Z.nachWelt, nachOrt: Z.nachOrt,
    };

    // Ab drei Punkten steht das Volumen in denselben Punkten. Gerechnet wird
    // es trotzdem nur, wenn der Schalter steht und wirklich eine Wolke da ist
    // — sonst läuft eine sekundenlange Rechnung für ein Ergebnis, das
    // niemand angefordert hat.
    if (punkte.length >= 3 && Z.autoBaugrube && wolkeDa()) {
      melden('Baugrube wird gemessen …');
      m.baugrube = await baugrube(ecefs);
    }
    if (m.box) {
      m.box.volumen = m.box.laenge * m.box.breite * m.box.hoehe;
      if (m.baugrube) {
        m.volumen = Math.abs(m.baugrube.net);
        m.volumenQuelle = 'gemessen (topografisches Aufmaß, ' + m.baugrube.source + ')';
      } else {
        // Ohne Wolke bleibt nur der ausgezogene Umriss — und zwar der
        // **Grundriss**, nicht die geneigte Fläche.
        //
        // Mit `flaeche` stand an einer senkrechten Fassadenmessung ein
        // Füllverhältnis von 4 721 %: 651 m² Wandfläche mal 10,6 m Boxhöhe
        // ergaben 6 912 m³ in einer Box von 146 m³. Eine senkrechte Fläche
        // umschließt kein Volumen, und `Fläche × Höhe` behauptet trotzdem
        // eines. Die Grundrissfläche mal der Boxhöhe ist dagegen für jeden
        // Umriss der Körper, der wirklich darunter steht — und nie größer als
        // die Box, weil der Grundriss nie größer als ihre Grundfläche ist.
        m.volumen = r.flaecheHorizontal * m.box.hoehe;
        m.volumenQuelle = 'Prisma: Grundfläche × Boxhöhe (kein Aufmaß)';
      }
      m.fuellverhaeltnis = m.box.volumen > 1e-9 ? m.volumen / m.box.volumen : null;
    }

    // Erst die Mengen abwarten, dann schreiben — sonst stünde im Graphen für
    // ein Bauteil kein Volumen, nur weil sein Abruf eine Zehntelsekunde
    // länger brauchte als der Klick auf „Abschließen".
    if (window.AufmassMengen) { try { await AufmassMengen.fertig(); } catch (e) { /* egal */ } }
    m.mengen = window.AufmassMengen
      ? AufmassMengen.summe(m.punkte.filter((p) => p.bauteil).map((p) => p.bauteil.mengen))
      : null;

    inGraph(m);
    inSitzung(m);
    Z.messungen.push(m);
    Z.letzte = m;
    kastenZeichnen(m);
    bleibendZeichnen(m);

    Z.punkte = [];
    Z.marken.forEach((e) => Z.ds.entities.remove(e));
    Z.marken = [];
    massePflegen();
    melden(kurzfassung(m));
    hudSchreiben();
    if (window.BimViewerUI && BimViewerUI.aufmassStand) BimViewerUI.aufmassStand();
    console.log('📐 ' + art, m);
    return jsonFest(m);
  }

  function wolkeDa() {
    if (!BimViewer.loadedAssets) return false;
    let ja = false;
    BimViewer.loadedAssets.forEach((a) => {
      if (!a.tileset) return;
      if (a.isPointCloud) ja = true;
      if (window.SplatPick && SplatPick.isGaussianTileset && SplatPick.isGaussianTileset(a.tileset)) ja = true;
    });
    return ja;
  }

  /**
   * Das Volumen der Baugrube — gerechnet von `volume-topo.js`, das dafür die
   * Punkte selbst aufsummiert. Hier wird es nur angestoßen: dessen Zustand
   * bekommt den Umriss, dann läuft dieselbe Rechnung wie beim Zeichnen von
   * Hand. Ein zweiter Rechenweg für dieselbe Größe wäre eine zweite Zahl.
   */
  async function baugrube(ecefs) {
    if (!window.TopoVolume) return null;
    try {
      TopoVolume.cancel(true);
      const st = TopoVolume.state;
      st.positions = ecefs.slice();
      st.active = true;
      await TopoVolume.finish();
      return TopoVolume.state.result || null;
    } catch (e) {
      console.warn('[Aufmaß] Baugrube nicht gerechnet:', e && e.message);
      return null;
    }
  }

  // ══ In den Graphen ════════════════════════════════════════════════════════

  function inGraph(m) {
    if (!window.AufmassRDF) return;
    const R = AufmassRDF;
    const punktIris = m.punkte.map((p, i) => {
      p.index = i;
      p.label = m.id + '·P' + (i + 1);
      p.iri = R.punkt(p);
      return p.iri;
    });
    const dIris = (m.ergebnis.strecken || []).map((s, i) =>
      R.bemassung({ von: punktIris[i], bis: punktIris[i + 1], ...s }));
    if (m.punkte.length >= 3) {
      dIris.push(R.bemassung({
        von: punktIris[punktIris.length - 1], bis: punktIris[0],
        ...schliessende(m),
      }));
    }
    const bauteile = [...new Set(m.punkte.filter((p) => p.bauteil).map((p) => R.bauteil(p.bauteil)))];

    const w = {
      laenge: m.ergebnis.laenge || null,
      umfang: m.punkte.length >= 3 ? m.ergebnis.umfang : null,
      flaeche: m.ergebnis.flaeche || null,
      flaecheHorizontal: m.ergebnis.flaecheHorizontal || null,
    };
    if (m.mengen && m.mengen.anzahl) {
      // Die Summe über die *berührten* Bauteile — ganze Bauteile, nicht die
      // gemessene Fläche davon. Der Unterschied ist wesentlich und steht
      // deshalb auch im Vokabular: `betroffenesVolumen`, nicht `volumen`.
      w.betroffeneBauteile = m.mengen.anzahl;
      w.betroffenesVolumen = m.mengen.volumen || null;
      w.betroffeneMasse = m.mengen.masse || null;
      w.betroffenesCO2 = m.mengen.co2 || null;
      if (m.mengen.ohneMenge) w.bauteileOhneMenge = m.mengen.ohneMenge;
      if (m.mengen.ohneWerkstoff) w.bauteileOhneWerkstoff = m.mengen.ohneWerkstoff;
    }
    if (m.box) {
      w.boxLaenge = m.box.laenge; w.boxBreite = m.box.breite; w.boxHoehe = m.box.hoehe;
      w.boxDrehung = m.box.theta * 180 / Math.PI;
      w.boxUnten = m.box.unten; w.boxOben = m.box.oben;
      w.boxVolumen = m.box.volumen;
      w.volumen = m.volumen;
      w.volumenQuelle = m.volumenQuelle;
      w.fuellverhaeltnis = m.fuellverhaeltnis;
      if (m.baugrube) {
        w.volumenQuelle = m.baugrube.source;
        w.volumenPunkte = m.baugrube.points;
        w.bezugshoehe = m.baugrube.referenceHeight;
      }
    }
    m.iri = R.messung({
      art: m.punkte.length >= 3 && m.box && m.box.hoehe > 0.01 ? 'Volumenmessung' : m.art,
      label: kurzfassung(m), punkte: punktIris, bemassungen: dIris, bauteile,
      werte: w, zeit: m.zeit,
      sitzung: (typeof ILEEN_SESSION !== 'undefined' && ILEEN_SESSION.getSession)
        ? (ILEEN_SESSION.getSession() || {}).id : null,
    });
  }

  function schliessende(m) {
    const a = ort(m.ecefs[m.ecefs.length - 1], m.nachOrt), b = ort(m.ecefs[0], m.nachOrt);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, dh = Math.hypot(dx, dy);
    return { distanz: Math.hypot(dx, dy, dz), dx, dy, dz, horizontal: dh,
             neigung: Math.atan2(dz, dh) * 180 / Math.PI };
  }

  function inSitzung(m) {
    if (typeof ILEEN_SESSION === 'undefined' || !ILEEN_SESSION.recordMeasurement) return;
    ILEEN_SESSION.recordMeasurement({
      type: 'aufmass', label: kurzfassung(m),
      positions: m.punkte.map((p) => ({ lon: p.lon, lat: p.lat, height: p.hoehe })),
      results: jsonFest(m).werte,
    });
  }

  // ══ Darstellung ═══════════════════════════════════════════════════════════

  function grundEntities() {
    const E = Z.ds.entities;

    E.add({
      name: 'aufmass-kette',
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const k = ketteGezeichnet();
          return k.length >= 3 ? k.concat([k[0]]) : k;
        }, false),
        width: 2.5,
        material: Cesium.Color.fromCssColorString(GRUEN),
        clampToGround: false,
        // Ohne das verschwindet die Maßlinie in der Wand, an der gemessen wird.
        // Eine Maßlinie ist eine Aussage über die Geometrie, kein Teil von ihr.
        depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString(GRUEN).withAlpha(0.45), dashLength: 8,
        }),
      },
    });

    E.add({
      name: 'aufmass-flaeche',
      polygon: {
        hierarchy: new Cesium.CallbackProperty(() => {
          const k = ketteGezeichnet();
          return k.length >= 3 ? new Cesium.PolygonHierarchy(k) : undefined;
        }, false),
        material: Cesium.Color.fromCssColorString(GRUEN).withAlpha(0.18),
        perPositionHeight: true,
        outline: false,
      },
    });

    // Die Flächenzahl im Schwerpunkt. Sie steht dort und nicht am Rand, weil
    // sie zur Fläche gehört und nicht zu einer ihrer Kanten.
    E.add({
      name: 'aufmass-flaechenzahl',
      position: new Cesium.CallbackProperty(() => {
        const r = rechnenAktuell();
        return r && r.schwerpunkt ? r.schwerpunkt : undefined;
      }, false),
      label: beschriftung(new Cesium.CallbackProperty(() => {
        const r = rechnenAktuell();
        if (!r || !r.flaeche) return '';
        return meter2(r.flaeche) + '\n' + 'U ' + meter(r.umfang);
      }, false), GRUEN, 15),
    });
  }

  function beschriftung(text, farbe, groesse) {
    return {
      text: text,
      font: (groesse || 14) + 'px "Inter", system-ui, sans-serif',
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#101314').withAlpha(0.82),
      backgroundPadding: new Cesium.Cartesian2(8, 5),
      outlineColor: Cesium.Color.fromCssColorString(farbe),
      style: Cesium.LabelStyle.FILL,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      // Maßzahlen gehören vor die Geometrie, sonst liest man sie nur von
      // einer Seite.
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(2, 1.0, 400, 0.75),
    };
  }

  function markeAnlegen(d) {
    Z.marken.push(Z.ds.entities.add({
      position: d.ecef,
      point: {
        pixelSize: 9,
        color: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString(GRUEN),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));
  }

  /**
   * Hält so viele Maßzahl-Entities bereit, wie es Strecken gibt. Der Pool
   * wächst nur; überzählige werden ausgeblendet statt entfernt. Ein Entity zu
   * bauen kostet mehr als es zu verstecken, und beim Zeichnen eines Umrisses
   * wächst und schrumpft die Zahl der Strecken ständig.
   */
  function massePflegen() {
    const noetig = Math.max(0, kette().length - 1) + (kette().length >= 3 ? 1 : 0);
    while (Z.masse.length < noetig) {
      const i = Z.masse.length;
      Z.masse.push(Z.ds.entities.add({
        position: new Cesium.CallbackProperty(() => {
          const r = rechnenAktuell();
          return r && r.strecken[i] ? r.strecken[i].mitte : undefined;
        }, false),
        label: beschriftung(new Cesium.CallbackProperty(() => {
          const r = rechnenAktuell();
          const s = r && r.strecken[i];
          if (!s) return '';
          return meter(s.distanz);
        }, false), GRUEN, 14),
      }));
    }
    Z.masse.forEach((e, i) => { e.show = i < noetig; });
  }

  /** Die abgeschlossene Messung bleibt stehen — Linie, Punkte, Maße, Ergebnis. */
  function bleibendZeichnen(m) {
    const E = Z.ds.entities;
    const gruppe = [];
    const ps = m.ecefs;
    const gezeichnet = () => {
      const kam = BimViewer.viewer.scene.camera.positionWC;
      return ps.map((p) => versetzt(p, kam));
    };
    gruppe.push(E.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const g = gezeichnet();
          return g.length >= 3 ? g.concat([g[0]]) : g;
        }, false),
        width: 2, material: Cesium.Color.fromCssColorString(GRUEN).withAlpha(0.9),
        depthFailMaterial: Cesium.Color.fromCssColorString(GRUEN).withAlpha(0.35),
      },
    }));
    ps.forEach((p) => gruppe.push(E.add({
      position: p,
      point: { pixelSize: 7, color: Cesium.Color.fromCssColorString(GRUEN),
               outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5,
               disableDepthTestDistance: Number.POSITIVE_INFINITY },
    })));
    (m.ergebnis.strecken || []).forEach((s) => gruppe.push(E.add({
      position: s.mitte, label: beschriftung(meter(s.distanz), GRUEN, 13),
    })));
    if (m.ergebnis.schwerpunkt) gruppe.push(E.add({
      position: m.ergebnis.schwerpunkt, label: beschriftung(kurzfassung(m), BLAU, 14),
    }));
    if (ps.length >= 3) gruppe.push(E.add({
      polygon: {
        hierarchy: new Cesium.CallbackProperty(() => new Cesium.PolygonHierarchy(gezeichnet()), false),
        perPositionHeight: true,
        material: Cesium.Color.fromCssColorString(GRUEN).withAlpha(0.16),
      },
    }));
    m.entities = gruppe;
  }

  /** Die Box als Drahtgitter — zwölf Kanten aus acht gerechneten Ecken. */
  function kastenZeichnen(m) {
    Z.kasten.forEach((e) => Z.ds.entities.remove(e));
    Z.kasten = [];
    if (!m.box || m.box.hoehe < 1e-6) return;
    const e = boxEcken(m.box, m.nachWelt);
    // Indizes wie in boxEcken(): Bit 0 = u, Bit 1 = v, Bit 2 = z.
    const kanten = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4],
                    [0, 4], [1, 5], [2, 6], [3, 7]];
    // Die Box steckt fast immer halb im Bauwerk — sie ist ja der Ausschnitt
    // *durch* es. Die verdeckten Kanten müssen deshalb sichtbar bleiben, aber
    // als verdeckt lesbar sein: gestrichelt und schwächer, nicht einfach vor
    // alles gelegt. Ein Kasten, der immer obenauf liegt, sagt nicht mehr, was
    // vor und was hinter der Wand ist.
    const sichtbar = new Cesium.PolylineDashMaterialProperty({
      color: Cesium.Color.fromCssColorString(BLAU).withAlpha(0.6), dashLength: 10,
    });
    kanten.forEach(([a, b]) => Z.kasten.push(Z.ds.entities.add({
      polyline: { positions: [e[a], e[b]], width: 2,
                  material: Cesium.Color.fromCssColorString(BLAU).withAlpha(0.95),
                  depthFailMaterial: sichtbar },
    })));
    m.boxEcken = e;
  }

  // ══ Schnittgrenzen ════════════════════════════════════════════════════════

  /**
   * Die Box als Schnitt: was außerhalb liegt, wird verworfen.
   *
   * Die Ebenen stehen im Box-System, ihre Normalen zeigen nach **innen** und
   * `unionClippingRegions` bleibt auf true — Cesium verwirft dann, sobald
   * *eine* Ebene negativ wird, also alles außerhalb des Quaders. Die
   * umgekehrte Belegung (Normalen nach außen, INTERSECT) stanzt die Box aus,
   * was hier gerade nicht gemeint ist.
   *
   * **Aufgehoben wird der Schnitt nicht durch Entfernen der Sammlung.**
   * `tileset.clippingPlanes = undefined` zerstört sie samt ihrer Textur,
   * während die bereits gebauten Zeichenbefehle diese Textur noch als Uniform
   * führen — der nächste Bildaufbau stirbt mit „Cannot read properties of
   * undefined (reading '_target')" und das Bild bleibt schwarz stehen. Die
   * Sammlung bleibt deshalb hängen und wird nur auf `enabled = false`
   * gestellt; dasselbe tut `section-box.js` aus demselben Grund.
   *
   * Ein Tileset, das bereits fremde Schnittebenen trägt (etwa von der
   * Schnittbox), wird ausgelassen statt übernommen. Zwei Werkzeuge, die sich
   * dieselbe eine Eigenschaft teilen, können nur nacheinander gewinnen — und
   * ein Ausschnitt, der stillschweigend verschwindet, ist schlimmer als einer,
   * der nicht kommt.
   */
  function schnitt(an) {
    const m = Z.letzte;
    if (an && (!m || !m.box || m.box.hoehe < 1e-6)) { melden('Keine Box vorhanden'); return false; }
    if (!an) return schnittAus();

    const b = m.box;
    const nachEcef = Cesium.Matrix4.multiply(
      m.nachWelt || Cesium.Transforms.eastNorthUpToFixedFrame(m.ecefs[0]),
      Cesium.Matrix4.multiply(
        Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(b.mitte.x, b.mitte.y, b.mitte.z)),
        Cesium.Matrix4.fromRotationTranslation(Cesium.Matrix3.fromRotationZ(b.theta)),
        new Cesium.Matrix4()),
      new Cesium.Matrix4());

    const halb = [b.laenge / 2, b.breite / 2, b.hoehe / 2];
    const richtungen = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

    let getroffen = 0, fremd = 0;
    BimViewer.loadedAssets.forEach((a) => {
      const ts = a.tileset;
      if (!ts) return;
      // Splats kennen kein clippingPlanes — sie stillschweigend aufzunehmen
      // hieße, einen Ausschnitt zu versprechen, den man nicht bekommt.
      if (window.SplatPick && SplatPick.isGaussianTileset && SplatPick.isGaussianTileset(ts)) return;

      let eintrag = Z.schnitte.find((e) => e.tileset === ts);
      if (!eintrag) {
        if (ts.clippingPlanes) { fremd++; return; }
        const sammlung = new Cesium.ClippingPlaneCollection({
          planes: richtungen.map((n, i) =>
            new Cesium.ClippingPlane(new Cesium.Cartesian3(n[0], n[1], n[2]), halb[i >> 1])),
          unionClippingRegions: true,
          edgeWidth: 1.0,
          edgeColor: Cesium.Color.fromCssColorString(BLAU),
        });
        ts.clippingPlanes = sammlung;
        eintrag = { tileset: ts, sammlung };
        Z.schnitte.push(eintrag);
      }
      richtungen.forEach((n, i) => {
        const ebene = eintrag.sammlung.get(i);
        Cesium.Cartesian3.fromArray(n, 0, ebene.normal);
        ebene.distance = halb[i >> 1];
      });
      eintrag.sammlung.modelMatrix = Cesium.Matrix4.multiply(
        Cesium.Matrix4.inverse(ts.clippingPlanesOriginMatrix, new Cesium.Matrix4()),
        nachEcef, new Cesium.Matrix4());
      eintrag.sammlung.enabled = true;
      getroffen++;
    });

    Z.schnittAn = getroffen > 0;
    melden(Z.schnittAn
      ? 'Schnitt auf die Box gesetzt (' + getroffen + ')' +
        (fremd ? ' · ' + fremd + ' Modell(e) mit fremdem Schnitt ausgelassen' : '')
      : 'Kein Modell geschnitten');
    return Z.schnittAn;
  }

  function schnittAus() {
    Z.schnitte.forEach(({ sammlung }) => {
      try { sammlung.enabled = false; } catch (e) { /* Tileset entladen */ }
    });
    Z.schnittAn = false;
    return false;
  }

  // ══ Fokus aus der Messung ═════════════════════════════════════════════════

  /** Alle in dieser Sitzung getroffenen Bauteile freistellen. */
  function fokus(alpha) {
    const ids = [...new Set(Z.messungen.flatMap((m) =>
      m.punkte.filter((p) => p.bauteil).map((p) => p.bauteil.globalId)))];
    if (!ids.length) { melden('In dieser Messung wurde kein Bauteil getroffen'); return 0; }
    return AufmassRDF.fokus(ids, alpha);
  }

  // ══ HUD ═══════════════════════════════════════════════════════════════════

  function hudAnlegen() {
    if (Z.hud) { Z.hud.style.display = ''; Z.kreuz.style.display = ''; return; }
    const wrap = BimViewer.viewer.container;
    Z.kreuz = document.createElement('div');
    Z.kreuz.className = 'aufmass-kreuz';
    Z.kreuz.innerHTML = '<span class="aufmass-kreuz__h"></span><span class="aufmass-kreuz__v"></span><span class="aufmass-kreuz__ring"></span>';
    wrap.appendChild(Z.kreuz);

    Z.hud = document.createElement('div');
    Z.hud.className = 'aufmass-hud';
    wrap.appendChild(Z.hud);
  }

  function kreuzSetzen(bs, treffer) {
    if (!Z.kreuz) return;
    if (!bs) { Z.kreuz.style.opacity = '0.25'; return; }
    Z.kreuz.style.opacity = '1';
    Z.kreuz.style.transform = 'translate(' + Math.round(bs.x) + 'px,' + Math.round(bs.y) + 'px)';
    Z.kreuz.dataset.art = treffer ? treffer.art : 'nichts';
  }

  const ARTTEXT = {
    ecke: 'Ecke', kante: 'Kante', silhouette: 'Silhouette', messpunkt: 'Messpunkt',
    raster: 'Raster', flaeche: 'Fläche', splat: 'Splat',
  };

  // Worauf der Punkt liegt, ist eine andere Frage als worauf gefangen wurde —
  // und sie steht im HUD, weil man sie sonst nicht beantworten kann: eine
  // Fassade und ein Splat davor sehen im Bild gleich aus, und der Unterschied
  // sind gern zwei Dezimeter.
  const TRAEGERTEXT = { modell: 'Modell', splat: 'Splat', gelaende: 'Gelände' };

  function hudSchreiben() {
    if (!Z.hud) return;
    const zeilen = [];
    const f = Z.fang;
    const traeger = f && f.traeger ? TRAEGERTEXT[f.traeger] : null;
    const ziel = window.AufmassFang && AufmassFang.ziel && AufmassFang.ziel !== 'auto'
      ? AufmassFang.ziel : null;
    zeilen.push('<b>' + (f ? (ARTTEXT[f.art] || f.art) : '—') + '</b>' +
      (traeger ? ' <span class="aufmass-hud__dim">auf ' + traeger + '</span>' : '') +
      (ziel ? ' <span class="aufmass-hud__dim">· nur ' + (TRAEGERTEXT[ziel] || ziel) + '</span>' : '') +
      (window.AufmassFang && AufmassFang.raster !== 'aus'
        ? ' <span class="aufmass-hud__dim">Raster ' + AufmassFang.raster + '</span>' : ''));

    const r = rechnenAktuell();
    if (!Z.punkte.length && f) {
      const c = Cesium.Cartographic.fromCartesian(f.position);
      if (c) zeilen.push('<span class="aufmass-hud__dim">' +
        Cesium.Math.toDegrees(c.longitude).toFixed(7) + ' · ' +
        Cesium.Math.toDegrees(c.latitude).toFixed(7) + ' · ' + c.height.toFixed(3) + ' m</span>');
    }
    // Die letzte Strecke, die überhaupt eine ist: unmittelbar nach einem Klick
    // liegt der Vorschaupunkt noch auf dem gerade gesetzten, und ein „0,0 cm"
    // im Ablesefeld sagt nichts über die Messung, nur über den Zeitpunkt.
    const s = r && [...r.strecken].reverse().find((k) => k.distanz > 1e-4);
    if (s) {
      zeilen.push('Strecke <b>' + meter(s.distanz) + '</b>');
      zeilen.push('<span class="aufmass-hud__dim">ΔO ' + meter(s.dx) + ' · ΔN ' + meter(s.dy) +
        ' · ΔH ' + meter(s.dz) + '</span>');
    }
    if (r && r.flaeche) {
      zeilen.push('Fläche <b>' + meter2(r.flaeche) + '</b> · Umfang ' + meter(r.umfang));
      if (r.box && r.box.hoehe > 0.005) {
        zeilen.push('<span class="aufmass-hud__dim">Box ' + meter(r.box.laenge) + ' × ' +
          meter(r.box.breite) + ' × ' + meter(r.box.hoehe) + ' = ' +
          meter3(r.box.laenge * r.box.breite * r.box.hoehe) + '</span>');
      }
    }
    zeilen.push('<span class="aufmass-hud__dim">' + Z.punkte.length + ' Punkte · ' + hinweis() + '</span>');
    Z.hud.innerHTML = zeilen.join('<br>');
    Z.hud.style.display = Z.aktiv ? '' : 'none';
  }

  function hinweis() {
    const n = Z.punkte.length;
    if (!n) return 'Punkt setzen';
    if (n === 1) return 'zweiter Punkt = Strecke';
    if (n === 2) return 'dritter Punkt = Fläche';
    return 'Enter oder Klick auf P1 schließt';
  }

  function melden(text) {
    if (BimViewer.updateStatus) BimViewer.updateStatus(text ? '📐 ' + text : '', 'info');
  }

  // ══ Zahlen ════════════════════════════════════════════════════════════════

  const nf = (n, s) => new Intl.NumberFormat('de-DE',
    { minimumFractionDigits: s, maximumFractionDigits: s }).format(n);
  function meter(v) {
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    return a < 1 ? nf(v * 100, 1) + ' cm' : nf(v, a < 100 ? 3 : 2) + ' m';
  }
  const meter2 = (v) => isFinite(v) ? nf(v, v < 100 ? 3 : 1) + ' m²' : '—';
  const meter3 = (v) => isFinite(v) ? nf(v, v < 100 ? 3 : 1) + ' m³' : '—';
  const abstandPx = (a, b) => (a && b) ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity;

  function kurzfassung(m) {
    const r = m.ergebnis || {};
    if (m.punkte.length === 1) return 'Punkt';
    if (m.punkte.length === 2) return meter(r.laenge);
    let s = meter2(r.flaeche);
    if (m.volumen) s += ' · ' + meter3(m.volumen);
    if (m.fuellverhaeltnis != null) s += ' · ' + nf(m.fuellverhaeltnis * 100, 1) + ' %';
    return s;
  }

  // ══ Nach außen ════════════════════════════════════════════════════════════

  /**
   * Eine Messung als reines JSON — Zahlen, keine Cesium-Objekte. Der Weg, auf
   * dem ein Sprachmodell über `ileen_viewer_js` an das Ergebnis kommt.
   */
  function jsonFest(m) {
    if (!m) return null;
    const r = m.ergebnis || {};
    return {
      id: m.id, art: m.art, iri: m.iri, zeit: m.zeit, punkte: m.punkte.length,
      koordinaten: m.punkte.map((p) => ({
        lon: rund(p.lon, 9), lat: rund(p.lat, 9), hoehe: rund(p.hoehe, 4),
        ost: rund(p.ost, 4), nord: rund(p.nord, 4), auf: rund(p.auf, 4),
        fang: p.fangart, treffer: p.trefferart,
        bauteil: p.bauteil ? { globalId: p.bauteil.globalId, typ: p.bauteil.ifcType, name: p.bauteil.name } : null,
      })),
      strecken: (r.strecken || []).map((s) => ({
        distanz: rund(s.distanz, 4), dx: rund(s.dx, 4), dy: rund(s.dy, 4), dz: rund(s.dz, 4),
        horizontal: rund(s.horizontal, 4), neigung: rund(s.neigung, 4),
      })),
      werte: {
        laenge: rund(r.laenge, 4), umfang: rund(r.umfang, 4),
        flaeche: rund(r.flaeche, 4), flaecheHorizontal: rund(r.flaecheHorizontal, 4),
        boxLaenge: m.box ? rund(m.box.laenge, 4) : null,
        boxBreite: m.box ? rund(m.box.breite, 4) : null,
        boxHoehe: m.box ? rund(m.box.hoehe, 4) : null,
        boxDrehungGrad: m.box ? rund(m.box.theta * 180 / Math.PI, 2) : null,
        boxVolumen: m.box ? rund(m.box.volumen, 4) : null,
        volumen: rund(m.volumen, 4),
        volumenQuelle: m.volumenQuelle || null,
        fuellverhaeltnis: rund(m.fuellverhaeltnis, 5),
        baugrubeQuelle: m.baugrube ? m.baugrube.source : null,
        baugrubePunkte: m.baugrube ? m.baugrube.points : null,
        betroffeneBauteile: m.mengen ? m.mengen.anzahl : null,
        betroffenesVolumen: m.mengen ? rund(m.mengen.volumen, 4) : null,
        betroffeneMasse: m.mengen ? rund(m.mengen.masse, 1) : null,
        betroffenesCO2: m.mengen ? rund(m.mengen.co2, 1) : null,
      },
      bauteile: [...new Map(m.punkte.filter((p) => p.bauteil)
        .map((p) => [p.bauteil.globalId, p.bauteil])).values()].map((b) => ({
        globalId: b.globalId, typ: b.ifcType, name: b.name, geschoss: b.geschoss,
        volumen: b.mengen ? rund(b.mengen.volumen, 4) : null,
        flaeche: b.mengen ? rund(b.mengen.flaeche, 4) : null,
        material: b.mengen ? b.mengen.material : null,
        werkstoff: b.mengen ? b.mengen.werkstoff : null,
        masse: b.mengen ? rund(b.mengen.masse, 1) : null,
        co2: b.mengen ? rund(b.mengen.co2, 1) : null,
        quellen: b.mengen ? b.mengen.quellen : null,
      })),
    };
  }
  const rund = (v, n) => (v === null || v === undefined || !isFinite(v)) ? null : Number(Number(v).toFixed(n));

  /** Ein Klick an Bildschirmkoordinaten — für Skripte und für das MCP. */
  function klick(x, y) {
    if (!Z.aktiv) start();
    const pos = new Cesium.Cartesian2(x, y);
    zeiger(pos);
    klickAn(pos);
    return Z.punkte.length;
  }

  /**
   * Ein Punkt an geografischen Koordinaten — ohne Fang, ohne Bildschirm.
   * Damit lässt sich ein Umriss aus einer Datei, aus einer `.ttl` oder aus
   * einer Rechnung setzen, ohne dass die Stelle sichtbar sein muss.
   */
  function klickWelt(lon, lat, hoehe) {
    if (!Z.aktiv) start();
    const ecef = Cesium.Cartesian3.fromDegrees(lon, lat, hoehe || 0);
    setzen({ position: ecef, art: 'gesetzt', guete: 1, bildschirm: null, ebenen: 0 }, null);
    return Z.punkte.length;
  }

  function zustand() {
    return {
      aktiv: Z.aktiv,
      punkte: Z.punkte.length,
      raster: window.AufmassFang ? AufmassFang.raster : 'aus',
      fang: window.AufmassFang
        ? { ecken: AufmassFang.ecken, kanten: AufmassFang.kanten, punkte: AufmassFang.punkte }
        : null,
      letzterFang: Z.fang ? Z.fang.art : null,
      letzterTraeger: Z.fang ? (Z.fang.traeger || null) : null,
      ziel: window.AufmassFang ? AufmassFang.ziel : 'auto',
      laufend: rechnenJson(),
      messungen: Z.messungen.map(jsonFest),
      schnitt: Z.schnittAn,
      autoBaugrube: Z.autoBaugrube,
      graph: window.AufmassRDF ? AufmassRDF.stand() : null,
    };
  }

  function rechnenJson() {
    const r = rechnenAktuell();
    if (!r) return null;
    return {
      punkte: r.n, laenge: rund(r.laenge, 4), umfang: rund(r.umfang, 4),
      flaeche: rund(r.flaeche, 4), flaecheHorizontal: rund(r.flaecheHorizontal, 4),
      box: r.box ? { laenge: rund(r.box.laenge, 4), breite: rund(r.box.breite, 4),
                     hoehe: rund(r.box.hoehe, 4), drehungGrad: rund(r.box.theta * 180 / Math.PI, 2) } : null,
    };
  }

  function alleLoeschen() {
    abbrechen();
    schnittAus();
    Z.messungen.forEach((m) => (m.entities || []).forEach((e) => Z.ds.entities.remove(e)));
    Z.kasten.forEach((e) => Z.ds.entities.remove(e));
    Z.kasten = []; Z.messungen = []; Z.letzte = null;
    if (window.AufmassRDF) AufmassRDF.leeren();
    if (window.AufmassMengen) AufmassMengen.leeren();
    melden('Alles gelöscht');
    if (window.BimViewerUI && BimViewerUI.aufmassStand) BimViewerUI.aufmassStand();
  }

  /**
   * Eine `.ttl` einlesen und den Viewer danach ausrichten: die darin
   * genannten Bauteile bleiben sichtbar, alles andere geht hinter den Regler.
   * Gedacht für den Rückweg aus SPIDER, wo eine Auswahl im Graphen entsteht.
   */
  async function ttlLaden(text, alpha) {
    if (!window.AufmassRDF) return null;
    const gelesen = AufmassRDF.importieren(text);
    if (gelesen.bauteile.length) await AufmassRDF.fokus(gelesen.bauteile, alpha === undefined ? 0.12 : alpha);
    melden(gelesen.bauteile.length + ' Bauteile aus ' + gelesen.tripel + ' Tripeln');
    if (window.BimViewerUI && BimViewerUI.aufmassStand) BimViewerUI.aufmassStand();
    return gelesen;
  }

  BimViewer.Aufmass = {
    start, stop, umschalten,
    abschluss, abbrechen, zurueck, alleLoeschen,
    klick, klickWelt, zustand, rasterWeiter,
    /** Das topografische Aufmaß bei jeder fertigen Fläche mitrechnen lassen. */
    setAutoBaugrube: (an) => { Z.autoBaugrube = !!an; return Z.autoBaugrube; },
    schnitt, schnittAus, fokus, ttlLaden,
    ttl: () => (window.AufmassRDF ? AufmassRDF.turtle() : ''),
    export: (name) => (window.AufmassRDF ? AufmassRDF.export(name) : 0),
    get messungen() { return Z.messungen.map(jsonFest); },
    get letzte() { return jsonFest(Z.letzte); },
    get laeuft() { return Z.aktiv; },
    _Z: Z,
    _intern: { rechnen, boxAus, boxEcken, konvexeHuelle, kette, ort },
  };

  console.log('📐 Aufmaß geladen — ein Modus, Klickzahl entscheidet');
})(window.BimViewer = window.BimViewer || {});
