// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Bauteile ein- und ausblenden — nach Klasse, nach Geschoss, einzeln.
//
// Die Kacheln sind gebatcht: Ein Mesh trägt viele Bauteile, unterschieden nur
// durch `_batchid` je Ecke. Ausblenden heißt deshalb, die Dreiecke eines
// Bauteils aus dem Index zu nehmen. Der Index wird an Ort und Stelle neu
// geschrieben (sichtbare Dreiecke nach vorn, `drawRange` bis dorthin), statt
// einen neuen anzulegen — ein ersetzter Index bliebe bis zum Entladen der
// Kachel auf der Grafikkarte liegen. Weil der Strahl von three.js den
// `drawRange` achtet, trifft man Ausgeblendetes auch nicht mehr: Man springt
// durch eine ausgeblendete Wand hindurch auf den Boden dahinter.
//
// Was es gibt, steht in den Batch Tables der geladenen Kacheln
// (`IfcType`, `Geschoss`, `GlobalId`, siehe backend/tiling/formats/ifc.py).
// Die Liste wächst also mit dem Nachladen; gezählt wird je GlobalId, damit
// ein Bauteil in mehreren Detailstufen nicht mehrfach zählt.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
import {
  bauteilZeilen, bauteilSichtbar, filterNeu, filterLeer, ifcName, geschosseSortieren,
} from './vr-rechnen.js';

/**
 * Alle Dreiecke eines Bauteils (Batch-ID `id`) einer Kachel nachzeichnen — über
 * alle Primitives, sonst bliebe bei einem Fenster das Glas unmarkiert. Nur im
 * gezeichneten Teil des Index: Ausgeblendetes bleibt aus. Zurück kommen die
 * neuen Netze; sie hängen an ihren Primitives und gehen mit der Kachel.
 */
export function bauteilNachzeichnen(wurzel, id, stoff) {
  const netze = [];
  wurzel.traverse(o => {
    if (!o.isMesh || o.userData.vrMarkierung) return;
    const ids = o.geometry.getAttribute('_batchid');
    const pos = o.geometry.getAttribute('position');
    if (!ids || !pos) return;
    const index = o.geometry.index;
    const n = Math.min(index ? index.count : pos.count, o.geometry.drawRange.count);
    const out = [];
    for (let i = 0; i + 2 < n; i += 3) {
      const a = index ? index.getX(i) : i;
      if (Math.round(ids.getX(a)) !== id) continue;
      for (let k = 0; k < 3; k++) {
        const v = index ? index.getX(i + k) : i + k;
        out.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      }
    }
    if (!out.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    const m = new THREE.Mesh(g, stoff);
    m.userData.vrMarkierung = true;
    m.raycast = () => {};
    m.renderOrder = 2;
    o.add(m);
    netze.push(m);
  });
  return netze;
}

export function ebenenAnlegen() {
  const filter = filterNeu();
  const klassen = new Map();      // IfcType → Set(GlobalId)
  const geschosse = new Map();    // Geschoss → Set(GlobalId)
  const alle = new Set();
  const wurzeln = new Set();      // geladene Kachelszenen mit Batch Table
  let stand = 0;                  // zählt hoch, wenn sich Liste oder Filter ändern

  function eintragen(karte, schluessel, guid) {
    let s = karte.get(schluessel);
    if (!s) { s = new Set(); karte.set(schluessel, s); }
    if (!s.has(guid)) { s.add(guid); return true; }
    return false;
  }

  function bauteileDer(wurzel) {
    if (wurzel.userData.vrBauteile) return wurzel.userData.vrBauteile;
    const bt = wurzel.batchTable;
    const n = bt.count || 0;
    const liste = new Array(n);
    let neu = false;
    for (let id = 0; id < n; id++) {
      const z = bauteilZeilen(bt.getDataFromId(id, {}));
      const b = { typ: z.typ, geschoss: z.geschoss, guid: z.guid };
      liste[id] = b;
      neu = eintragen(klassen, b.typ, b.guid) || neu;
      neu = eintragen(geschosse, b.geschoss, b.guid) || neu;
      alle.add(b.guid);
    }
    if (neu) stand++;
    wurzel.userData.vrBauteile = liste;
    return liste;
  }

  /** Index einmal sichern; nicht indizierte Geometrie bekommt einen. */
  function vorbereiten(g, anzahlIds) {
    if (g.userData.vrVoll) return;
    const pos = g.getAttribute('position');
    const ids = g.getAttribute('_batchid');
    let voll;
    if (g.index) {
      voll = g.index.array.slice();
    } else {
      const n = pos.count;
      voll = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) voll[i] = i;
      g.setIndex(new THREE.BufferAttribute(voll.slice(), 1));
    }
    const dreiecke = Math.floor(voll.length / 3);
    const did = anzahlIds > 65535 ? new Uint32Array(dreiecke) : new Uint16Array(dreiecke);
    for (let t = 0; t < dreiecke; t++) did[t] = Math.round(ids.getX(voll[3 * t]));
    g.userData.vrVoll = voll;
    g.userData.vrDreieckId = did;
  }

  function anwenden(wurzel) {
    const bauteile = bauteileDer(wurzel);
    const leer = filterLeer(filter);
    const sicht = leer ? null : Uint8Array.from(bauteile, b => (bauteilSichtbar(b, filter) ? 1 : 0));
    wurzel.traverse(o => {
      if (!o.isMesh || o.userData.vrMarkierung) return;
      const g = o.geometry;
      if (!g.getAttribute('_batchid')) return;
      if (leer && !g.userData.vrVoll) return;   // nie gefiltert: nichts anfassen
      vorbereiten(g, bauteile.length);
      const voll = g.userData.vrVoll;
      const did = g.userData.vrDreieckId;
      const ziel = g.index.array;
      let n = 0;
      if (leer) {
        ziel.set(voll);
        n = voll.length;
      } else {
        for (let t = 0, i = 0; i + 2 < voll.length; t++, i += 3) {
          if (!sicht[did[t]]) continue;
          ziel[n] = voll[i];
          ziel[n + 1] = voll[i + 1];
          ziel[n + 2] = voll[i + 2];
          n += 3;
        }
      }
      g.index.needsUpdate = true;
      g.setDrawRange(0, n >= voll.length ? Infinity : n);
      o.visible = n > 0;
    });
  }

  function alleAnwenden() {
    stand++;
    for (const w of wurzeln) anwenden(w);
  }

  function liste(karte, aus, sortieren) {
    const namen = sortieren([...karte.keys()]);
    return namen.map(name => ({ schluessel: name, anzahl: karte.get(name).size, an: !aus.has(name) }));
  }

  return {
    filter,
    get stand() { return stand; },
    get anzahl() { return alle.size; },
    get hatBauteile() { return wurzeln.size > 0 || alle.size > 0; },

    /** Beim Laden einer Kachel (Ereignis `load-model`). */
    kachelGeladen(szene) {
      szene.traverse(o => {
        if (!o.batchTable) return;
        wurzeln.add(o);
        anwenden(o);
      });
    },

    kachelEntladen(szene) {
      szene.traverse(o => { if (o.batchTable) wurzeln.delete(o); });
    },

    /** Neues Modell: Liste und Filter von vorn. */
    leeren() {
      wurzeln.clear();
      klassen.clear();
      geschosse.clear();
      alle.clear();
      Object.assign(filter, filterNeu());
      stand++;
    },

    klassen() {
      return liste(klassen, filter.klassen, n => n.sort((a, b) => ifcName(a).localeCompare(ifcName(b), 'de')))
        .map(e => ({ ...e, name: ifcName(e.schluessel) }));
    },

    geschosse() {
      return liste(geschosse, filter.geschosse, geschosseSortieren)
        .map(e => ({ ...e, name: e.schluessel || 'ohne Geschoss' }));
    },

    klasseUmschalten(typ) {
      if (filter.klassen.has(typ)) filter.klassen.delete(typ); else filter.klassen.add(typ);
      filter.nur = null;
      alleAnwenden();
    },

    geschossUmschalten(name) {
      if (filter.geschosse.has(name)) filter.geschosse.delete(name); else filter.geschosse.add(name);
      filter.nur = null;
      alleAnwenden();
    },

    /** Nur diese Klasse (bzw. dieses Geschoss) — alle anderen der Art aus. */
    nurKlasse(typ) {
      filter.klassen = new Set([...klassen.keys()].filter(k => k !== typ));
      filter.nur = null;
      alleAnwenden();
    },

    nurGeschoss(name) {
      filter.geschosse = new Set([...geschosse.keys()].filter(k => k !== name));
      filter.nur = null;
      alleAnwenden();
    },

    alleKlassen(an) {
      filter.klassen = an ? new Set() : new Set(klassen.keys());
      filter.nur = null;
      alleAnwenden();
    },

    alleGeschosse(an) {
      filter.geschosse = an ? new Set() : new Set(geschosse.keys());
      filter.nur = null;
      alleAnwenden();
    },

    ausblenden(guid) {
      if (!guid) return;
      filter.guids.add(guid);
      if (filter.nur) filter.nur.delete(guid);
      alleAnwenden();
    },

    isolieren(guids) {
      filter.nur = new Set(guids.filter(Boolean));
      alleAnwenden();
    },

    einzelneZeigen() {
      filter.guids.clear();
      alleAnwenden();
    },

    allesZeigen() {
      Object.assign(filter, filterNeu());
      alleAnwenden();
    },

    /** Den ganzen Filter auf einmal setzen — eine geteilte Ansicht (vr-gemeinsam.js). */
    filterSetzen(f) {
      Object.assign(filter, f);
      alleAnwenden();
    },

    /**
     * Wo steckt ein Bauteil? [{ wurzel, id }] je Kachel und Batch-ID — in allen
     * geladenen Kacheln oder nur in denen unter `szene`.
     */
    fundstellen(guid, szene = null) {
      const out = [];
      if (!guid) return out;
      const suchen = w => {
        const liste = w.userData.vrBauteile || [];
        for (let id = 0; id < liste.length; id++) if (liste[id] && liste[id].guid === guid) out.push({ wurzel: w, id });
      };
      if (szene) szene.traverse(o => { if (o.batchTable && wurzeln.has(o)) suchen(o); });
      else for (const w of wurzeln) suchen(w);
      return out;
    },

    sichtbar(guid) {
      for (const w of wurzeln) {
        const b = (w.userData.vrBauteile || []).find(x => x.guid === guid);
        if (b) return bauteilSichtbar(b, filter);
      }
      return true;
    },
  };
}
