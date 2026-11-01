// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Texturen der Kacheln teilen und in der Größe begrenzen.
//
// Warum: siehe vr-leistung.js, Abschnitt „Texturen teilen". Kurz: dieselben
// 512²-Bilder stecken in fast jeder Kachel, dekodiert über 20 MB je Kachel; der
// Speicher der Kacheln ist nach einem Drittel der benötigten Kacheln voll, der
// Rest bleibt dauerhaft aus dem Modell.
//
// Zwei Teile, beide hängen sich ein, ohne die Bibliothek anzufassen:
//
//   texturErweiterung  Erweiterung des GLTFLoaders: ersetzt `loadImageSource`.
//                      Ein eingebettetes JPEG wird nach seinem Inhalt nachgeschlagen;
//                      ist es schon dekodiert, bekommt die Kachel eine neue Textur,
//                      die sich dasselbe `Source` teilt — three.js lädt dann nur
//                      einmal auf die Grafikkarte und zählt die Nutzer selbst
//                      (WebGLTextures: `usedTimes`). Zu große Bilder werden vor dem
//                      Teilen verkleinert (lange Kante ≤ `kante()`).
//
//   geteiltPlugin      Plugin des Tile-Renderers: zieht beim Zählen des Speichers
//                      ab, was eine Kachel nur mitnutzt — sonst zählte der
//                      Zwischenspeicher dieselbe Textur je Kachel und bliebe voll,
//                      obwohl der Speicher längst reicht.
//
// Nur eingebettete JPEG: sie haben keinen Alpha-Kanal (kein Vormultiplizieren,
// das ein Teilen über ein Canvas verändern würde) und liegen als Bytes in der
// Kachel, sodass sich der Inhalt vor dem Dekodieren prüfen lässt. PNG, KTX2 und
// Texturen mit Adresse laufen unverändert durch.

import { bildSchluessel, passeGroesse, texturBytes } from './vr-leistung.js';

const MIME = 'image/jpeg';

/**
 * Aus einem frisch dekodierten Bild die geteilte Quelle machen, wenn nötig
 * verkleinert. Die Quelle gehört danach dem Register, nicht der Kachel.
 */
async function quelleBauen(THREE, textur, maxKante) {
  let bild = textur.image;
  const [w, h] = passeGroesse(bild.width, bild.height, maxKante);
  if (w !== bild.width || h !== bild.height) {
    const klein = await createImageBitmap(bild, {
      resizeWidth: w, resizeHeight: h, resizeQuality: 'high',
      premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    });
    bild.close();
    bild = klein;
  }
  // 3d-tiles-renderer ruft beim Verwerfen einer Kachel `texture.image.close()`.
  // Für ein geteiltes Bild wäre das für alle anderen Kacheln das Ende (leere
  // Textur beim nächsten Hochladen). Freigegeben wird es vom Speicherbereiniger,
  // sobald das Register und alle Texturen es losgelassen haben.
  bild.close = () => {};
  const quelle = new THREE.Source(bild);
  quelle.needsUpdate = true;
  quelle.vrBytes = texturBytes(bild.width, bild.height);
  return quelle;
}

/** Eine neue Textur für eine Kachel, die sich die Quelle mit den anderen teilt. */
function neueTextur(THREE, quelle, mitgenutzt) {
  const t = new THREE.Texture();
  t.source = quelle;
  // `needsUpdate = true` hieße, die geteilte Quelle bei jeder Kachel neu
  // hochzuladen (es zählt `source.version`). Die Quelle ist schon fertig; die
  // Textur braucht nur eine Version über 0, sonst bindet three.js eine leere.
  t.version = 1;
  t.userData.mimeType = MIME;
  t.userData.vrGeteilt = mitgenutzt;
  return t;
}

/**
 * Erweiterung für `GLTFExtensionsPlugin({ plugins: [...] })`.
 *
 * @param THREE     three.js (dasselbe, das die Seite benutzt)
 * @param register  TexturRegister (vr-leistung.js)
 * @param kante     () → größte erlaubte Kantenlänge in Bildpunkten
 */
export function texturErweiterung({ THREE, register, kante }) {
  return parser => {
    const original = parser.loadImageSource.bind(parser);
    parser.loadImageSource = function loadImageSource(quelleIndex, lader) {
      const def = parser.json.images && parser.json.images[quelleIndex];
      if (!def || def.bufferView === undefined || def.mimeType !== MIME || lader.isImageBitmapLoader !== true) {
        return original(quelleIndex, lader);
      }
      return parser.getDependency('bufferView', def.bufferView).then(bytes => {
        const grenze = kante();
        const schluessel = `${bildSchluessel(bytes)}:${grenze}`;
        let vorhanden = register.holen(schluessel);
        const mitgenutzt = !!vorhanden;
        if (!vorhanden) {
          vorhanden = register.eintragen(schluessel,
            original(quelleIndex, lader).then(textur => quelleBauen(THREE, textur, grenze)));
        }
        return vorhanden.then(quelle => neueTextur(THREE, quelle, mitgenutzt));
      });
    };
    return { name: 'ILEEN_texturen' };
  };
}

/**
 * Plugin für `tiles.registerPlugin(...)`: der Speicher, den eine Kachel nur
 * mitnutzt, zählt für sie nicht. Die Bibliothek summiert die Rückgaben aller
 * Plugins (`getBytesUsed`); eine negative Zahl ist ein Abzug.
 *
 * Die erste Kachel, die ein Bild mitbringt, zahlt es voll — erst die weiteren
 * zählen es nicht mehr. So bleibt die Rechnung beim Entladen der ersten Kachel
 * höchstens um ein Bild zu klein, nie um alle.
 */
export function geteiltPlugin() {
  const gemerkt = new WeakMap();
  return {
    name: 'ILEEN_geteilte_texturen',
    calculateBytesUsed(kachel, szene) {
      if (!szene) return 0;
      if (gemerkt.has(kachel)) return gemerkt.get(kachel);
      let abzug = 0;
      const gesehen = new Set();
      szene.traverse(o => {
        const stoffe = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of stoffe) {
          for (const k in m) {
            const t = m[k];
            if (t && t.isTexture && t.userData && t.userData.vrGeteilt && !gesehen.has(t)) {
              gesehen.add(t);
              const bild = t.image;
              if (bild) abzug += texturBytes(bild.width, bild.height, t.generateMipmaps);
            }
          }
        }
      });
      gemerkt.set(kachel, -abzug);
      return -abzug;
    },
  };
}
