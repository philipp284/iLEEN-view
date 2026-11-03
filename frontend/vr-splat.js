// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Gaussian Splats in der Brille.
//
// `3d-tiles-renderer` kennt `KHR_gaussian_splatting` nicht: der Lader fände in
// einem Splat-Tile ein Primitive ohne Positionsdaten. Der Tiler (backend/tiling)
// legt die Splats aber als SPZ-Blob in die Kachel (`…_compression_spz_2`), und
// den liest Spark (sparkjs.dev, three.js-Renderer mit WebXR) unmittelbar. Diese
// Erweiterung hängt sich deshalb in den GLTFLoader des Tile-Renderers: sie
// reicht den Blob an ein `SplatMesh` weiter und gibt das als Inhalt der Kachel
// zurück. Auswahl, Nachladen, Zwischenspeicher und Kachelrahmen bleiben die der
// übrigen Modelle.
//
// Spark kommt erst, wenn die erste Splat-Kachel eintrifft (rund 2 MB mit
// eingebetteter WASM): wer nur IFC begeht, lädt es nie.

const SPARK = 'https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.3.1/dist/spark.module.js';

const EXT = 'KHR_gaussian_splatting';
const EXT_SPZ = 'KHR_gaussian_splatting_compression_spz_2';

let sparkLaden = null;

/** Spark laden und seinen Renderer in die Szene hängen — einmal. */
function spark({ renderer, szene }) {
  if (!sparkLaden) {
    sparkLaden = import(/* @vite-ignore */ SPARK).then(modul => {
      // Spark sortiert die Splats je Bild nach dem Blickpunkt; dafür braucht es
      // den Renderer und einen Platz in der Szene.
      const sparkRenderer = new modul.SparkRenderer({ renderer });
      szene.add(sparkRenderer);
      return modul;
    });
  }
  return sparkLaden;
}

/**
 * Erweiterung für `GLTFExtensionsPlugin({ plugins: [...] })`.
 *
 * Zwei Namen, weil der GLTFLoader jede Pflicht-Extension ohne Gegenstück meldet
 * (`extensionsRequired` nennt beide), und das für jede Kachel neu.
 */
export function splatErweiterungen(umgebung) {
  const stumm = name => () => ({ name });
  return [
    parser => ({
      name: EXT,
      loadMesh(meshIndex) {
        const primitive = parser.json.meshes[meshIndex].primitives[0];
        const spz = primitive.extensions
          && primitive.extensions[EXT]
          && primitive.extensions[EXT].extensions
          && primitive.extensions[EXT].extensions[EXT_SPZ];
        if (!spz) return null;
        const anzahl = parser.json.accessors[primitive.attributes.POSITION].count;
        return Promise.all([spark(umgebung), parser.getDependency('bufferView', spz.bufferView)])
          .then(([modul, bytes]) => {
            const mesh = new modul.SplatMesh({ fileBytes: bytes, fileType: 'spz' });
            mesh.splatAnzahl = anzahl;
            return mesh;
          });
      },
    }),
    stumm(EXT_SPZ),
  ];
}

/** Aufräumen, wenn der Tile-Renderer eine Kachel verwirft. */
export function splatEntsorgen(szene) {
  szene.traverse(o => { if (o.splatAnzahl !== undefined && o.dispose) o.dispose(); });
}

/** Splats in den sichtbaren Kacheln. */
export function sichtbareSplats(tiles) {
  let summe = 0;
  for (const kachel of tiles.visibleTiles) {
    const szene = kachel.engineData && kachel.engineData.scene;
    if (!szene) continue;
    szene.traverse(o => { if (o.splatAnzahl !== undefined) summe += o.splatAnzahl; });
  }
  return summe;
}

/**
 * Den zulässigen Bildschirmfehler so nachführen, dass die sichtbaren Splats den
 * Haushalt füllen, ohne ihn zu sprengen. Jeder sichtbare Splat wird in jedem
 * Bild sortiert und gezeichnet, und die Quest rechnet das für zwei Augen — der
 * Haushalt ist die Grenze. Darunter wird verfeinert: ein fester Fehlerwert wie
 * bei IFC ließe bei großen Splats nur die zusammengeführte Grobstufe stehen
 * (wenige, große, verwaschene Splats). Gesenkt wird erst, wenn die Kacheln
 * geladen sind, sonst rennt der Wert dem Nachladen davon.
 *
 * @param boden   untere Schranke des Fehlerwerts
 * @param fertig  alle gewünschten Kacheln sind geladen
 * @returns neuer Fehlerwert
 */
export function fehlerNachfuehren(aktuell, boden, sichtbar, haushalt, fertig = true) {
  if (sichtbar > haushalt) return Math.min(aktuell * 1.25, 600);
  if (fertig && sichtbar < haushalt * 0.7) return Math.max(aktuell / 1.2, boden);
  return aktuell;
}
