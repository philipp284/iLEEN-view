// Prüft das Logo im Orbit ohne Browser: die Orientierungsmatrix gegen echtes
// Cesium, die Lage im Raum, die Ausblendkurve über der Kamerahöhe und das
// erzeugte GLB.
//
// Aufruf:  node tests/logo/test-ileen-logo.js
//
// Warum gerade diese Stellen: Eine Drehung um 90° zu viel sieht in der Konsole
// nach nichts aus — das Logo steht dann hochkant zur Kamera und ist beim
// Öffnen schlicht nicht da. Und das Seitenverhältnis steht zweimal im Projekt
// (im Erzeugungsskript implizit, im Viewer-Modul als Zahl); laufen die beiden
// auseinander, ist das Logo um denselben Faktor zu breit wie zu hoch.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.resolve(__dirname, '..', '..');

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '   ' + hinweis : ''}`); }
}
const nahe = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

async function main() {
  const Cesium = await import('cesium');

  // ── Modul in einem gestellten Browser-Kontext laden ──────────────────────

  const speicher = {};
  const kontext = {
    Cesium,
    console: { log() {}, warn() {} },
    setInterval: () => 0,          // das Polling auf den Viewer würde Node
    clearInterval: () => {},       // sonst am Beenden hindern
    localStorage: {
      getItem: (k) => (k in speicher ? speicher[k] : null),
      setItem: (k, v) => { speicher[k] = String(v); },
    },
    CONFIG: { camera: { DEFAULT_POSITION: { longitude: 10.9544, latitude: 50.7323 } } },
  };
  kontext.window = kontext;
  kontext.globalThis = kontext;
  vm.createContext(kontext);
  vm.runInContext(
    fs.readFileSync(path.join(WURZEL, 'ileen-logo.js'), 'utf8'),
    kontext, { filename: 'ileen-logo.js' });

  const Logo = kontext.window.BimViewer.ILeenLogo;
  pruefe('Modul hängt sich als BimViewer.ILeenLogo ein', !!Logo);
  pruefe('Standort kommt aus CONFIG.camera.DEFAULT_POSITION',
         nahe(Logo.lage.lon, 10.9544) && nahe(Logo.lage.lat, 50.7323));

  // ── Orientierung ─────────────────────────────────────────────────────────
  //
  // Gerechnet wird die Kette, die Cesium beim Zeichnen tatsächlich anwendet:
  // modelMatrix · Achsenkorrektur. Die Korrektur ist der Teil, an dem das
  // Logo schon einmal hochkant stand — sie besteht aus ZWEI Drehungen
  // (ModelUtility.getAxisCorrectionMatrix): Y_UP_TO_Z_UP wegen upAxis=Y und
  // zusätzlich Z_UP_TO_X_UP wegen forwardAxis=Z. Wer nur die erste ansetzt,
  // prüft eine Matrix, die es im Bild nie gibt.

  const { Cartesian3, Matrix3, Matrix4, Transforms, Math: CMath, Axis } = Cesium;
  const quelle = fs.readFileSync(path.join(WURZEL, 'ileen-logo.js'), 'utf8');

  function achsenkorrektur(up, forward) {          // nachgebaut aus ModelUtility
    let m = Matrix4.clone(Matrix4.IDENTITY, new Matrix4());
    if (up === Axis.Y) m = Matrix4.clone(Axis.Y_UP_TO_Z_UP, m);
    else if (up === Axis.X) m = Matrix4.clone(Axis.X_UP_TO_Z_UP, m);
    if (forward === Axis.Z) m = Matrix4.multiplyTransformation(m, Axis.Z_UP_TO_X_UP, m);
    return m;
  }

  // Welche Achsen das Modul beim Laden angibt, steht in seiner Quelle — der
  // Test soll anschlagen, wenn jemand die beiden Optionen entfernt.
  const gesetzt = (name, vorgabe) => {
    const treffer = new RegExp(name + ':\\s*Cesium\\.Axis\\.([XYZ])').exec(quelle);
    return treffer ? Axis[treffer[1]] : vorgabe;
  };
  const korrektur = achsenkorrektur(gesetzt('upAxis', Axis.Y),
                                    gesetzt('forwardAxis', Axis.Z));

  // Die Matrixfunktion liegt im Modul privat; hier steht derselbe Aufbau.
  // Läuft er auseinander, schlägt die Achsprobe unten an.
  function modelMatrix(lage) {
    const ursprung = Cartesian3.fromDegrees(lage.lon, lage.lat, lage.hoehe);
    const enu = Transforms.eastNorthUpToFixedFrame(ursprung);
    const drehen = Matrix4.fromRotationTranslation(
      Matrix3.fromRotationZ(-(lage.heading || 0)));
    return Matrix4.multiply(enu, drehen, new Matrix4());
  }

  const lage = { lon: 10.9544, lat: 50.7323, hoehe: 3.5e6, heading: 0 };
  const ursprung = Cartesian3.fromDegrees(lage.lon, lage.lat, lage.hoehe);
  const enu = Transforms.eastNorthUpToFixedFrame(ursprung);

  const richtung = (m, x, y, z, korr) => {
    const gesamt = Matrix4.multiply(m, korr || korrektur, new Matrix4());
    const p = Matrix4.multiplyByPointAsVector(
      gesamt, new Cartesian3(x, y, z), new Cartesian3());
    return Cartesian3.normalize(p, p);
  };
  const enuAchse = (i) => {
    const spalte = Matrix4.getColumn(enu, i, new Cesium.Cartesian4());
    return Cartesian3.normalize(
      new Cartesian3(spalte.x, spalte.y, spalte.z), new Cartesian3());
  };
  const gleich = (a, b) => nahe(Cartesian3.dot(a, b), 1, 1e-9);

  const M = modelMatrix(lage);
  const [ost, nord, oben] = [enuAchse(0), enuAchse(1), enuAchse(2)];

  pruefe('Leserichtung zeigt nach Osten', gleich(richtung(M, 1, 0, 0), ost));
  pruefe('Oberkante der Schrift zeigt nach Norden', gleich(richtung(M, 0, 1, 0), nord));
  pruefe('Vorderseite schaut in den Himmel', gleich(richtung(M, 0, 0, 1), oben));
  pruefe('Der Schriftzug liegt in der Ost-Nord-Ebene, nicht auf der Hochachse',
         Math.abs(Cartesian3.dot(richtung(M, 0, 1, 0), oben)) < 1e-9);

  // Der Fall, der es einmal hochkant stellte: mit Cesiums Vorgabe für glTF
  // (upAxis=Y, forwardAxis=Z) zeigt die Oberkante der Schrift nach oben.
  // Steht diese Prüfung auf grün und die darüber auf rot, sind die beiden
  // Achsoptionen beim Laden verlorengegangen.
  const ohneAbschaltung = achsenkorrektur(Axis.Y, Axis.Z);
  pruefe('Ohne abgeschaltete Achsenkorrektur stünde es hochkant — geprüft',
         gleich(richtung(M, 0, 1, 0, ohneAbschaltung), oben));

  // Damit steht die Schrift senkrecht zum Blick der Startkamera (Pitch −89°,
  // Heading 0) und ist beim Öffnen lesbar — das ist der ganze Zweck.
  const M90 = modelMatrix(Object.assign({}, lage, { heading: CMath.PI_OVER_TWO }));
  const sued = Cartesian3.negate(nord, new Cartesian3());
  pruefe('Heading dreht im Kompasssinn (90° → Leserichtung Süd)',
         gleich(richtung(M90, 1, 0, 0), sued));
  pruefe('Heading kippt das Logo nicht aus der Waagerechten',
         gleich(richtung(M90, 0, 0, 1), oben));

  const mitte = Matrix4.getTranslation(M, new Cartesian3());
  const carto = Cesium.Cartographic.fromCartesian(mitte);
  pruefe('Logo hängt in der eingestellten Höhe', nahe(carto.height, 3.5e6, 1e-3),
         `${(carto.height / 1000).toFixed(1)} km`);
  pruefe('Logo hängt über dem Standort',
         nahe(CMath.toDegrees(carto.longitude), 10.9544, 1e-9) &&
         nahe(CMath.toDegrees(carto.latitude), 50.7323, 1e-9));

  // ── Ausblenden über der Kamerahöhe ───────────────────────────────────────

  const alpha = (h) => {
    let gesetzt = null;
    Logo.modell = {
      show: true,
      set color(c) { gesetzt = c.alpha; },
      get color() { return null; },
    };
    Logo.sichtbar = true;
    Logo._nachHoeheEinblenden({ camera: { positionCartographic: { height: h } } });
    const zeigt = Logo.modell.show;
    Logo.modell = null;
    return { alpha: gesetzt, show: zeigt };
  };

  pruefe('Aus der Startansicht (10 000 km) steht das Logo voll da',
         nahe(alpha(1.0e7).alpha, 1));
  pruefe('Auf halbem Weg (1 850 km) ist es halb verblasst',
         nahe(alpha(1.85e6).alpha, 0.5, 0.02));
  pruefe('Über einem Bauwerk (500 m) ist es weg', alpha(500).show === false);
  pruefe('Kein Sprung an der oberen Schwelle',
         Math.abs(alpha(2.49e6).alpha - alpha(2.51e6).alpha) < 0.02);

  // ── Sichtbarkeit merken ──────────────────────────────────────────────────

  Logo.modell = { show: true };
  Logo.verbergen();
  pruefe('Verbergen schaltet das Modell ab', Logo.modell.show === false);
  pruefe('und merkt sich das',
         JSON.parse(speicher['ileen_logo_v1']).sichtbar === false);
  Logo.umschalten();
  pruefe('Umschalten holt es zurück', Logo.modell.show === true);
  Logo.modell = null;

  // ── Das erzeugte GLB ─────────────────────────────────────────────────────

  const glb = path.join(WURZEL, 'Assets', 'ileen-logo.glb');
  pruefe('Assets/ileen-logo.glb liegt vor', fs.existsSync(glb),
         'fehlt — erzeugen mit: python3 tools/make-ileen-logo.py');
  if (!fs.existsSync(glb)) return abschluss();

  const roh = fs.readFileSync(glb);
  const magie = roh.readUInt32LE(0);
  const version = roh.readUInt32LE(4);
  const laenge = roh.readUInt32LE(8);
  pruefe('GLB-Kopf ist gültig',
         magie === 0x46546c67 && version === 2 && laenge === roh.length);

  const jsonLaenge = roh.readUInt32LE(12);
  const gltf = JSON.parse(roh.slice(20, 20 + jsonLaenge).toString('utf8'));
  const primitives = gltf.meshes[0].primitives;
  pruefe('Zwei Primitives — weiß und cyan getrennt', primitives.length === 2);
  pruefe('Materialien tragen die Logofarben',
         gltf.materials.map((m) => m.name).join(',') === 'iLEEN_weiss,iLEEN_cyan');
  pruefe('Beide Materialien leuchten von selbst',
         gltf.materials.every((m) => m.emissiveFactor.some((c) => c > 0)),
         'sonst verschwindet der Schriftzug auf der Nachtseite');

  const grenzen = primitives
    .map((p) => gltf.accessors[p.attributes.POSITION])
    .reduce((a, acc) => ({
      minX: Math.min(a.minX, acc.min[0]), maxX: Math.max(a.maxX, acc.max[0]),
      minY: Math.min(a.minY, acc.min[1]), maxY: Math.max(a.maxY, acc.max[1]),
      minZ: Math.min(a.minZ, acc.min[2]), maxZ: Math.max(a.maxZ, acc.max[2]),
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
          minZ: Infinity, maxZ: -Infinity });

  pruefe('Versalhöhe ist 1.0 — daran hängt die Umrechnung in Meter',
         nahe(grenzen.maxY - grenzen.minY, 1.0, 1e-4));
  pruefe('Schriftzug ist um den Ursprung zentriert',
         nahe(grenzen.minX + grenzen.maxX, 0, 1e-4) &&
         nahe(grenzen.minY + grenzen.maxY, 0, 1e-4));
  pruefe('Modell hat Tiefe, ist also ein Körper und keine Folie',
         grenzen.maxZ - grenzen.minZ > 0.05);

  // Die Zahl im Viewer-Modul muss zum GLB passen, sonst stimmt die in Metern
  // angegebene Breite nicht.
  const imModul = Number(/SEITENVERHAELTNIS\s*=\s*([\d.]+)/.exec(quelle)[1]);
  const imGlb = grenzen.maxX - grenzen.minX;
  pruefe('Seitenverhältnis im Modul stimmt mit dem GLB überein',
         nahe(imModul, imGlb, 0.01), `Modul ${imModul}, GLB ${imGlb.toFixed(3)}`);

  // 4 500 km Breite bei diesem Verhältnis: die Versalhöhe ist dann rund
  // 700 km — größer als jeder Berg, kleiner als der Erdradius. Genau das ist
  // die Größenordnung, in der „riesig im All" noch ins Bild passt.
  const skalierung = 4.5e6 / imModul;
  pruefe('4 500 km Breite ergeben eine Versalhöhe um 700 km',
         skalierung > 6.5e5 && skalierung < 7.2e5,
         `${(skalierung / 1000).toFixed(0)} km`);

  abschluss();
}

function abschluss() {
  console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen.`
                     : '\nAlle Prüfungen bestanden.');
  process.exit(fehler ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
