/**
 * iLEEN — Sensorablage: die aktuellen Messwerte im Viewer, ohne zu wissen woher.
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Geometrie wird gekachelt und liegt danach fest; ein Messwert ändert sich im
 * Minutentakt. Beides trifft sich erst hier, und zwar über die IRI — dieselbe
 * Kennung, die der gaeco-Export vergibt.
 *
 *     Quelle ──▶ sensor-store.js ──ileen:sensor-geaendert──▶ Darstellung
 *     (HTTP heute,                      │
 *      WebSocket morgen)           amBauteil(GlobalId)
 *
 * Die Quelle ist austauschbar
 * ===========================
 * Dieses Modul kennt keine Verbindung. Es kennt ein Objekt mit `start(aufWerte)`
 * und `stop()`, das ihm Listen von Messwerten zuruft — wie oft und woher, ist
 * seine Sache. Heute fragt die mitgelieferte Quelle alle zehn Sekunden
 * `/sensoren/stand` ab; morgen tritt ein WebSocket an ihre Stelle, **ohne dass
 * sich hier etwas ändert.** Deshalb stehen `fetch` und `setInterval`
 * ausschließlich in `httpQuelle()` und nirgends sonst.
 *
 * Ein Backend, das nicht antwortet, ist kein Fehler
 * =================================================
 * Wie in `issues-store.js`: ein Aussetzer ist ein Zustand, kein Absturz. Der
 * Store behält seine letzten Werte, bleibt benutzbar und meldet sich **einmal**
 * in der Konsole statt bei jedem Versuch — eine Fehlermeldung alle zehn
 * Sekunden ist keine Information, sondern Lärm, in dem die echte untergeht.
 * Ohne konfiguriertes Backend bleibt er ganz still: der Viewer läuft auch ohne.
 *
 * Woher die Zuordnung Bauteil → Sensor kommt
 * ==========================================
 * Aus den Werten selbst. `/sensoren/stand` liefert je Sensor den vollen
 * Registereintrag — `anker_guid`, `anker_iri`, `einheit`, Messbereich — und
 * dazu den letzten Wert. Ein zweiter Abruf des Registers erübrigt sich damit,
 * und eine spätere WebSocket-Quelle darf sich auf das Nötige beschränken: was
 * einmal an Registerangaben kam, bleibt gemerkt.
 *
 * **`uuid5` wird im Browser nicht gerechnet.** Das Register hat die Antwort
 * schon; SHA-1 über `crypto.subtle` wäre asynchron und umständlich. Der Join
 * bleibt die IRI — der Browser leitet sie nur nicht selbst her.
 *
 * Dieses Modul zeichnet nichts. Es hält Werte und sagt Bescheid; was daraus
 * wird, entscheidet die Darstellung.
 */
'use strict';

(function () {

  // Gesetzt, nicht gemessen — sobald der WebSocket da ist, gegenstandslos.
  const ABFRAGE_MS = 10000;

  // Ein Wert, der älter ist als das Dreifache seines Messtakts, ist nicht mehr
  // aktuell, auch wenn die Quelle ihn `ok` nennt: bei 60-s-Sensoren drei
  // Minuten. Ohne diese Regel zeigte der Viewer einen eingefrorenen Wert
  // unbegrenzt weiter, und niemand sähe den Unterschied zu einem lebenden.
  const VERALTET_FAKTOR = 3;
  const INTERVALL_STANDARD_S = 60;

  const EREIGNIS = 'ileen:sensor-geaendert';

  const Z = {
    register: new Map(),   // iri → Registerangaben
    anker: new Map(),      // anker_guid → Set von iri
    werte: new Map(),      // iri → { wert, zeit, status }
    quelle: null,
    laeuft: false,
    gemeldet: false,       // damit die Konsole nicht im Sekundentakt volläuft
  };

  // ── Die mitgelieferte Quelle: HTTP im Abfragetakt ─────────────────────────

  function basis() {
    if (typeof window === 'undefined') return '';
    if (window.BimViewer && typeof BimViewer.getBackendUrl === 'function') {
      return (BimViewer.getBackendUrl() || '').replace(/\/+$/, '');
    }
    const konf = window.ILEEN_CONFIG;
    return ((konf && konf.backendUrl) || '').replace(/\/+$/, '');
  }

  function httpQuelle() {
    let uhr = null;
    return {
      start(aufWerte) {
        const adresse = basis();
        if (!adresse) {
          // Kein Backend eingerichtet: still bleiben. Der Viewer kann alles
          // andere, und eine Fehlermeldung wäre hier schlicht falsch.
          console.info('📈 Sensorablage: kein Backend eingerichtet — keine Messwerte');
          return;
        }
        const holen = () => fetch(adresse + '/sensoren/stand')
          .then((antwort) => {
            if (!antwort.ok) throw new Error('HTTP ' + antwort.status);
            return antwort.json();
          })
          .then(aufWerte)
          .catch(melden);
        holen();
        uhr = setInterval(holen, ABFRAGE_MS);
      },
      stop() {
        if (uhr !== null) { clearInterval(uhr); uhr = null; }
      },
    };
  }

  function melden(fehler) {
    if (Z.gemeldet) return;
    Z.gemeldet = true;
    console.warn('📈 Sensorablage: keine Werte —', (fehler && fehler.message) || fehler,
                 '(weitere Versuche werden nicht mehr gemeldet)');
  }

  // ── Werte übernehmen ──────────────────────────────────────────────────────

  function uebernehmen(liste) {
    // Nach `beenden()` darf nichts mehr ankommen — eine Quelle, die ihren
    // letzten Abruf noch zu Ende führt, soll den Store nicht wiederbeleben.
    if (!Z.laeuft || !Array.isArray(liste)) return;

    // Es fließen wieder Werte: die Ausfallphase ist vorbei, der nächste Aussetzer
    // darf wieder gemeldet werden. Der Erfolg setzt zurück, nicht der Neustart —
    // sonst wäre „höchstens eine Meldung" eine Frage der Aufrufhäufigkeit.
    Z.gemeldet = false;

    const geaendert = [];
    for (const eintrag of liste) {
      if (!eintrag || !eintrag.iri) continue;
      const iri = eintrag.iri;

      // Registerangaben kommen mit dem ersten Schub und bleiben gemerkt; eine
      // knappere Quelle darf sie später weglassen.
      if (eintrag.sensor_id) merkeRegister(iri, eintrag);

      const neu = {
        wert: eintrag.wert !== undefined ? eintrag.wert : null,
        zeit: eintrag.zeit || null,
        status: eintrag.status || 'ok',
      };
      const alt = Z.werte.get(iri);
      if (!alt || alt.wert !== neu.wert || alt.zeit !== neu.zeit || alt.status !== neu.status) {
        Z.werte.set(iri, neu);
        geaendert.push(iri);
      }
    }

    // Genau ein Ereignis je Schub, und keines, wenn sich nichts geändert hat:
    // die Darstellung zeichnet daraufhin neu, und ein Ereignis je Sensor wären
    // vierundzwanzig Durchläufe statt einem.
    if (geaendert.length) melde(geaendert);
  }

  function merkeRegister(iri, eintrag) {
    const vorher = Z.register.get(iri);
    const angaben = {
      sensor_id: eintrag.sensor_id,
      iri,
      bezeichnung: eintrag.bezeichnung || eintrag.sensor_id,
      messgroesse: eintrag.messgroesse || '',
      einheit: eintrag.einheit || '',
      intervall_s: Number(eintrag.intervall_s) || INTERVALL_STANDARD_S,
      zone: eintrag.zone || '',
      zone_bezeichnung: eintrag.zone_bezeichnung || '',
      anker_guid: eintrag.anker_guid || '',
      anker_iri: eintrag.anker_iri || '',
      anker_typ: eintrag.anker_typ || '',
      brick_klasse: eintrag.brick_klasse || '',
      bereich_min: eintrag.bereich_min !== undefined ? Number(eintrag.bereich_min) : null,
      bereich_max: eintrag.bereich_max !== undefined ? Number(eintrag.bereich_max) : null,
    };
    Z.register.set(iri, angaben);

    if (vorher && vorher.anker_guid && vorher.anker_guid !== angaben.anker_guid) {
      const alt = Z.anker.get(vorher.anker_guid);
      if (alt) alt.delete(iri);
    }
    if (angaben.anker_guid) {
      if (!Z.anker.has(angaben.anker_guid)) Z.anker.set(angaben.anker_guid, new Set());
      Z.anker.get(angaben.anker_guid).add(iri);
    }
  }

  function melde(iris) {
    if (typeof document === 'undefined' || !document.dispatchEvent) return;
    try {
      document.dispatchEvent(new CustomEvent(EREIGNIS, { detail: { iris } }));
    } catch (e) {
      // Ein Zuhörer, der wirft, darf den Store nicht mitreißen.
      console.warn('📈 Sensorablage: Zuhörer auf ' + EREIGNIS + ' hat geworfen —', e);
    }
  }

  // ── Lesen ─────────────────────────────────────────────────────────────────

  function veraltet(angaben, wert) {
    if (!wert || !wert.zeit) return false;
    const takt = (angaben && angaben.intervall_s) || INTERVALL_STANDARD_S;
    const alter = Date.now() - Date.parse(wert.zeit);
    return Number.isFinite(alter) && alter > VERALTET_FAKTOR * takt * 1000;
  }

  function zusammen(iri) {
    const angaben = Z.register.get(iri) || { iri, intervall_s: INTERVALL_STANDARD_S };
    const wert = Z.werte.get(iri) || null;
    const status = wert
      ? (wert.status === 'ok' && veraltet(angaben, wert) ? 'veraltet' : wert.status)
      : 'ohne';
    return Object.assign({}, angaben, {
      wert: wert ? wert.wert : null,
      zeit: wert ? wert.zeit : null,
      status,
    });
  }

  function stand() {
    const iris = new Set([...Z.register.keys(), ...Z.werte.keys()]);
    return [...iris].map(zusammen);
  }

  function amBauteil(globalId) {
    const iris = Z.anker.get(globalId);
    if (!iris || !iris.size) return [];
    return [...iris].map(zusammen);
  }

  function sensor(iri) {
    if (!iri || (!Z.register.has(iri) && !Z.werte.has(iri))) return null;
    return zusammen(iri);
  }

  // ── Steuerung ─────────────────────────────────────────────────────────────

  function starten(optionen) {
    if (Z.laeuft) beenden();
    Z.quelle = (optionen && optionen.quelle) || httpQuelle();
    Z.laeuft = true;
    try {
      // Eine Quelle, die beim Start wirft — auch verzögert —, darf den Viewer
      // nicht mitnehmen. Sie hat dann eben keine Werte geliefert.
      const ergebnis = Z.quelle.start(uebernehmen);
      if (ergebnis && typeof ergebnis.catch === 'function') ergebnis.catch(melden);
    } catch (fehler) {
      melden(fehler);
    }
    return API;
  }

  function beenden() {
    Z.laeuft = false;
    if (Z.quelle && typeof Z.quelle.stop === 'function') {
      try { Z.quelle.stop(); } catch (fehler) { melden(fehler); }
    }
    Z.quelle = null;
  }

  const API = {
    starten, beenden, stand, amBauteil, sensor,
    httpQuelle,
    EREIGNIS,
    get laeuft() { return Z.laeuft; },
    get anzahl() { return Z.register.size; },
  };

  if (typeof window !== 'undefined') window.SensorStore = API;
  if (typeof globalThis !== 'undefined') globalThis.SensorStore = API;

  console.log('📈 Sensorablage geladen — Werte halten, Änderungen melden, Quelle austauschbar');
})();
