/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// ZUSTAND-ANMELDER — die bestehenden Werkzeuge melden sich bei der Registry an
//
// Gehört zu zustand.js (dort steht, was ein Anmelder ist). Diese Datei ist die
// Brücke für die Werkzeuge, die es schon gab: sie lesen deren öffentliche
// Schnittstelle aus und stellen sie wieder her. Ein NEUES Werkzeug meldet sich
// besser selbst an, in seiner eigenen Datei — diese hier ist der Bestand.
//
// Alles, was die SZENE ausmacht, ist hier; Rechner-Eingaben (GEG-Tabellen,
// Lastabtrag-Annahmen, Bauplaner-Entwurf) ausdrücklich nicht: sie haben einen
// eigenen Speicher und sind keine Ansicht.
//
//   10  modelle       was geladen, sichtbar, wie deckend und wie verschoben ist
//   20  filter        abgewählte Bauteiltypen, Hervorhebung, ausgeblendete Bauteile
//   30  bildebenen    Bilder im Raum: sichtbar, Deckkraft
//   40  schnitt       Box, Scheiben, Modus, Drehung
//   45  explosion     Abstand, Stauchung
//   50  notizen       welche Notizen im Bild stehen
//   60  welt          Karte, Gelände, 3D-Kulissen, Globus
//   62  sonne         Uhrzeit und Schatten
//   70  farben        Weißabgleich, Bauwerksfarben, Glas
//   72  licht         Grundaufhellung, Taschenlampe
//   74  untergrund    Untergrund-Modus, Nullebene
//   76  punktwolken   Farbmodus, Punktgröße, Eye-Dome-Lighting
//
// ## Modelle werden ausgeblendet, nicht entladen
//
// Kommt ein geladenes Modell im Zustand nicht vor, wird es versteckt. Entladen
// würde bedeuten, es auf der nächsten Folie neu zu laden — Sekunden bis Minuten
// bei einem Campusmodell. `vorbereiten` lädt deshalb vor der ersten Folie alles,
// was irgendeine Folie braucht, und die Folien schalten nur noch um.
//
// ## Das Laden darf die Kamera nicht anfassen
//
// `loadBackendAsset` endet mit einem Kameraflug von fünf Sekunden zum Modell.
// Mitten in einer Präsentation würde er die Kamera kapern. `ohneFlug` ersetzt
// den Flug für die Dauer des Ladens durch nichts.
// ===============================
'use strict';

(function () {

  var B = window.BimViewer;
  var Z = B && B.Zustand;
  if (!Z) { console.warn('zustand-anmelder.js: zustand.js muss vorher geladen sein'); return; }

  // ── Hilfen ─────────────────────────────────────────────────────────────────

  function klemm(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function num(x, vorgabe) { return (typeof x === 'number' && isFinite(x)) ? x : vorgabe; }
  function rund(x, n) { var f = Math.pow(10, n); return Math.round(x * f) / f; }
  function nahe(a, b, eps) { return Math.abs(num(a, 0) - num(b, 0)) <= (eps || 1e-6); }

  /** Die Kamerafahrt, die das Laden eines Modells sonst auslöst, ausschalten. */
  async function ohneFlug(fn) {
    var alt = B.cinematicFlyToTileset;
    B.cinematicFlyToTileset = async function () {};
    try { return await fn(); }
    finally { B.cinematicFlyToTileset = alt; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODELLE
  // ═══════════════════════════════════════════════════════════════════════════

  function quelleVon(schluessel, a) {
    if (a.type === 'BACKEND' && a.jobId) return { art: 'backend', jobId: a.jobId };
    if (a.type === 'BACKEND' && a.url) return { art: 'url', url: a.url };
    if (a.type === '3DTILES') return { art: 'ion', assetId: String(schluessel) };
    return null;
  }

  function lageVon(a) {
    var ts = a.tileset;
    var z = B.zOffset && B.zOffset.individualOffsets && B.zOffset.individualOffsets.get(ts);
    var h = B.rotation && B.rotation.individualHeadings && B.rotation.individualHeadings.get(ts);
    var t = B.translation && B.translation.individualOffsets && B.translation.individualOffsets.get(ts);
    return { z: rund(num(z, 0), 3), heading: rund(num(h, 0), 2),
             ost: rund(num(t && t.east, 0), 3), nord: rund(num(t && t.north, 0), 3) };
  }

  async function modellLaden(schluessel, eintrag) {
    var q = eintrag.quelle;
    if (!q) return;
    await ohneFlug(async function () {
      if (q.art === 'backend') await B.loadBackendAsset(q.jobId, eintrag.name || null);
      else if (q.art === 'url') await B.loadBackendAssetByUrl(q.url, eintrag.name || null);
      else if (q.art === 'ion') await B.loadSelectedAsset(q.assetId, eintrag.name || null);
    });
  }

  function modellVersteckt(a, versteckt) {
    if (!a || !a.tileset) return;
    var sichtbar = !versteckt;
    if ((a.visible !== false) === sichtbar) return;
    B.toggleAssetVisibility(a.id);
  }

  var lageBelegt = new Set();

  Z.anmelden({
    id: 'modelle', ordnung: 10, titel: 'Geladene Modelle',
    beschreibung: 'Welche Modelle in der Szene liegen, ob sichtbar, wie deckend und wie verschoben. ' +
                  'Quelle backend (jobId), ion (assetId) oder url.',
    weich: ['*.deckkraft', '*.lage.z', '*.lage.heading@winkel', '*.lage.ost', '*.lage.nord'],
    schema: {
      '*.sichtbar': { typ: 'bool' },
      '*.deckkraft': { typ: 'zahl', min: 0, max: 1 },
      '*.lage.z': { typ: 'meter', beschreibung: 'Höhenversatz' },
      '*.lage.heading': { typ: 'grad', beschreibung: 'Drehung um die Hochachse' },
      '*.lage.ost': { typ: 'meter' }, '*.lage.nord': { typ: 'meter' },
      '*.quelle': { typ: 'objekt', beschreibung: '{art:"backend",jobId} | {art:"ion",assetId} | {art:"url",url}' },
    },

    lesen: function () {
      var aus = {};
      if (!B.loadedAssets) return aus;
      B.loadedAssets.forEach(function (a, schluessel) {
        if (!a.tileset) return;
        var q = quelleVon(schluessel, a);
        if (!q) return;
        aus[schluessel] = { name: a.name, quelle: q, sichtbar: a.visible !== false,
                            deckkraft: rund(num(a.opacity, 1), 3), lage: lageVon(a) };
      });
      return aus;
    },

    setzen: async function (w, opt) {
      var schluessel = Object.keys(w);

      if (!opt.weich) {
        for (var i = 0; i < schluessel.length; i++) {
          if (!B.loadedAssets.has(schluessel[i])) await modellLaden(schluessel[i], w[schluessel[i]]);
        }
        // Was der Zustand nicht kennt, wird versteckt und nicht entladen.
        B.loadedAssets.forEach(function (a, k) { if (!(k in w)) modellVersteckt(a, true); });
      }

      for (var j = 0; j < schluessel.length; j++) {
        var k = schluessel[j], e = w[k], a = B.loadedAssets.get(k);
        if (!a || !a.tileset) continue;
        if (!opt.weich) modellVersteckt(a, e.sichtbar === false);

        if (typeof e.deckkraft === 'number' && Math.abs(num(a.opacity, 1) - e.deckkraft) > (opt.weich ? 0.004 : 1e-6)) {
          B.updateAssetOpacity(k, e.deckkraft);
        }

        var ist = lageVon(a), soll = e.lage || {};
        // Gelesen wird auf Millimeter gerundet; die halbe Rundung ist die feinste sinnvolle Toleranz.
        var tz = opt.weich ? 0.001 : 0.0006, tw = opt.weich ? 0.01 : 0.006;
        var aendert = !nahe(ist.z, soll.z, tz) || !nahe(ist.heading, soll.heading, tw) ||
                      !nahe(ist.ost, soll.ost, tz) || !nahe(ist.nord, soll.nord, tz);
        if (!aendert) continue;
        if (opt.weich && lageBelegt.has(k)) continue;   // die letzte Matrix ist noch in Arbeit
        var lauf = async function (asset, s, live) {
          if (!nahe(lageVon(asset).z, s.z, 0.001)) await B.applyIndividualZOffset(asset.id, num(s.z, 0), live);
          if (!nahe(lageVon(asset).heading, s.heading, 0.01)) await B.applyIndividualRotation(asset.id, num(s.heading, 0), live);
          var l2 = lageVon(asset);
          if (!nahe(l2.ost, s.ost, 0.001) || !nahe(l2.nord, s.nord, 0.001)) {
            await B.applyIndividualTranslation(asset.id, num(s.ost, 0), num(s.nord, 0), live);
          }
        };
        if (opt.weich) {
          lageBelegt.add(k);
          lauf(a, soll, true).catch(function () {}).then(function () { lageBelegt.delete(k); });
        } else {
          await lauf(a, soll, true);
        }
      }
    },

    vorbereiten: async function (listen) {
      var gesehen = {};
      for (var i = 0; i < listen.length; i++) {
        var ks = Object.keys(listen[i]);
        for (var j = 0; j < ks.length; j++) {
          var k = ks[j];
          if (gesehen[k] || B.loadedAssets.has(k)) continue;
          gesehen[k] = true;
          await modellLaden(k, listen[i][k]);
          var a = B.loadedAssets.get(k);
          if (a) modellVersteckt(a, true);   // erscheint erst, wenn eine Folie es verlangt
        }
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FILTER: Bauteiltypen, Hervorhebung, ausgeblendete Bauteile
  // ═══════════════════════════════════════════════════════════════════════════

  function assetSchluesselVon(tileset) {
    var treffer = null;
    B.loadedAssets.forEach(function (a, k) { if (a.tileset === tileset) treffer = k; });
    return treffer;
  }

  function ausgeblendetLesen() {
    var aus = {};
    var liste = (B.hiddenFeatures && B.hiddenFeatures.eintraege) || [];
    liste.forEach(function (e) {
      if (!e.guid) return;
      var k = assetSchluesselVon(e.tileset);
      if (!k) return;
      (aus[k] = aus[k] || []).push(e.guid);
    });
    Object.keys(aus).forEach(function (k) { aus[k].sort(); });
    return aus;
  }

  Z.anmelden({
    id: 'filter', ordnung: 20, titel: 'Bauteile: Filter, Hervorhebung, Ausgeblendetes',
    beschreibung: 'abgewaehlt = IFC-Typen, die NICHT gezeigt werden (ein später gefundener Typ bleibt sichtbar). ' +
                  'hervorhebung = GlobalIds in einer Farbe. ausgeblendet = je Modell die mit H ausgeblendeten GlobalIds.',
    schema: {
      abgewaehlt: { typ: 'liste', beschreibung: 'IFC-Typen, z. B. ["IfcSpace","IfcOpeningElement"]' },
      'hervorhebung.ids': { typ: 'liste', beschreibung: 'GlobalIds' },
      'hervorhebung.farbe': { typ: 'farbe' },
      ausgeblendet: { typ: 'objekt', beschreibung: '{ modellSchluessel: [GlobalId, …] }' },
    },

    lesen: function () {
      var F = B.ifcFilter;
      if (!F || !F.allEntities) return undefined;
      var ab = [];
      F.allEntities.forEach(function (t) { if (!F.enabledEntities.has(t)) ab.push(t); });
      ab.sort();
      var ids = B.ifcHighlight ? Array.from(B.ifcHighlight.ids).sort() : [];
      return { abgewaehlt: ab,
               hervorhebung: { ids: ids, farbe: (B.ifcHighlight && B.ifcHighlight.color) || '#ff2d95' },
               ausgeblendet: ausgeblendetLesen() };
    },

    setzen: async function (w) {
      var F = B.ifcFilter;
      if (!F) return;
      var aendern = false;

      if (Array.isArray(w.abgewaehlt)) {
        var ab = new Set(w.abgewaehlt);
        ab.forEach(function (t) { F.allEntities.add(t); });
        F.allEntities.forEach(function (t) {
          var soll = !ab.has(t);
          if (F.enabledEntities.has(t) !== soll) {
            if (soll) F.enabledEntities.add(t); else F.enabledEntities.delete(t);
            aendern = true;
          }
        });
        if (aendern && typeof B.updateIFCFilterUI === 'function') B.updateIFCFilterUI();
      }

      var h = w.hervorhebung;
      if (h) {
        var jetzt = B.ifcHighlight ? Array.from(B.ifcHighlight.ids).sort() : [];
        var soll = (h.ids || []).slice().sort();
        var farbeAnders = h.farbe && B.ifcHighlight && B.ifcHighlight.color !== h.farbe;
        if (soll.join() !== jetzt.join() || (soll.length && farbeAnders)) {
          if (soll.length) await B.highlightIFCElements(soll, { farbe: h.farbe });
          else B.clearIFCHighlight();
          aendern = false;   // highlightIFCElements wendet den Filter selbst an
        }
        // Die Farbe gehört zur Hervorhebung, auch wenn gerade nichts hervorgehoben ist.
        if (h.farbe && B.ifcHighlight && B.ifcHighlight.color !== h.farbe) B.ifcHighlight.color = h.farbe;
      }

      if (aendern && typeof B.applyIFCFilter === 'function') await B.applyIFCFilter();

      if (w.ausgeblendet && JSON.stringify(w.ausgeblendet) !== JSON.stringify(ausgeblendetLesen())) {
        B.showAllHidden();
        Object.keys(w.ausgeblendet).forEach(function (k) {
          var a = B.loadedAssets.get(k);
          if (!a || !a.tileset) return;
          var eig = a.guidPropertyName || (B.detectGuidProperty && B.detectGuidProperty(a.tileset));
          if (!eig) return;
          w.ausgeblendet[k].forEach(function (guid) {
            B.hiddenFeatures.eintraege.push({ tileset: a.tileset, guidEigenschaft: eig, guid: guid, feature: null });
          });
        });
        B.reapplyHiddenFeatures();
        B._ausgeblendetZaehlen();
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BILDEBENEN
  // ═══════════════════════════════════════════════════════════════════════════

  Z.anmelden({
    id: 'bildebenen', ordnung: 30, titel: 'Bildebenen im Raum',
    beschreibung: 'Sichtbarkeit und Deckkraft der gesetzten Bildebenen, je Kennung.',
    weich: ['ebenen.*.deckkraft'],
    schema: { 'ebenen.*.sichtbar': { typ: 'bool' }, 'ebenen.*.deckkraft': { typ: 'zahl', min: 0.05, max: 1 } },

    lesen: function () {
      var BE = B.Bildebenen;
      if (!BE || !Array.isArray(BE.ebenen)) return undefined;
      var aus = {};
      BE.ebenen.forEach(function (e) {
        aus[e.id] = { titel: e.titel || '', sichtbar: e.sichtbar !== false, deckkraft: rund(num(e.deckkraft, 1), 3) };
      });
      return { ebenen: aus };
    },

    setzen: function (w, opt) {
      var BE = B.Bildebenen;
      if (!BE || !w.ebenen) return;
      Object.keys(w.ebenen).forEach(function (id) {
        var e = BE.finden(id), soll = w.ebenen[id];
        if (!e) return;
        if (!opt.weich && (e.sichtbar !== false) !== (soll.sichtbar !== false)) BE.zeigen(id, soll.sichtbar !== false);
        if (typeof soll.deckkraft === 'number' && Math.abs(num(e.deckkraft, 1) - soll.deckkraft) > (opt.weich ? 0.004 : 1e-6)) {
          BE.setzen(id, 'deckkraft', soll.deckkraft);
        }
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHNITT: Box, Scheiben, Modus
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Box und Scheiben stehen im RAHMEN des Schnitts — einem ENU-System im
  // Schwerpunkt der geschnittenen Modelle, um `yaw` gedreht. Sie gelten also
  // für dieselbe Modellauswahl; `modelle` (Ordnung 10) kommt deshalb davor.

  Z.anmelden({
    id: 'schnitt', ordnung: 40, titel: 'Schnitt: Box und Scheiben',
    beschreibung: 'Die Schnittbox (min/max in Metern im Rahmen der Modelle), Scheiben (senkrechte Streifen), ' +
                  'Modus innen/aussen und die Drehung des Rahmens. Gilt für die Modelle derselben Folie.',
    weich: ['box.min', 'box.max', 'scheiben.*.d', 'scheiben.*.dicke', 'scheiben.*.winkel@winkel'],
    schema: {
      an: { typ: 'bool' }, modus: { typ: 'wahl', werte: ['innen', 'aussen'] },
      yaw: { typ: 'grad' }, 'box.min': { typ: 'meter3' }, 'box.max': { typ: 'meter3' },
      'scheiben.*.winkel': { typ: 'grad' }, 'scheiben.*.d': { typ: 'meter' }, 'scheiben.*.dicke': { typ: 'meter' },
      'scheiben.*.an': { typ: 'bool' }, flaechen: { typ: 'bool' }, kante: { typ: 'bool' }, griffe: { typ: 'bool' },
    },

    lesen: function () {
      var S = B.Schnitt;
      if (!S) return undefined;
      var st = S.stand(), z = S.zustand;
      // Ausgeschaltet bleiben Box und Scheiben „für das nächste Mal" im Werkzeug
      // stehen — das ist Erinnerung, keine Szene. Zwei Folien mit ausgeschaltetem
      // Schnitt unterschieden sich sonst durch Reste, und beim Einschalten käme
      // die Box aus dem Nichts statt von der ganzen Szene her hereingefahren.
      if (!st.an) {
        var ganz = z.szene && { min: z.szene.min.map(function (v) { return rund(v, 3); }),
                                max: z.szene.max.map(function (v) { return rund(v, 3); }) };
        return ganz ? { an: false, box: ganz } : { an: false };
      }
      var scheiben = {};
      st.scheiben.forEach(function (s) {
        scheiben[s.name] = { winkel: rund(s.winkel, 2), d: rund(s.d, 3), dicke: rund(s.dicke, 3), an: s.an !== false };
      });
      var aus = { an: st.an, modus: st.modus, flaechen: z.flaechen, kante: z.kante, griffe: z.griffe, scheiben: scheiben };
      if (st.yaw !== null && st.yaw !== undefined) aus.yaw = rund(st.yaw, 2);
      if (st.box) aus.box = { min: st.box.min.map(function (v) { return rund(v, 3); }),
                              max: st.box.max.map(function (v) { return rund(v, 3); }) };
      return aus;
    },

    setzen: async function (w, opt) {
      var S = B.Schnitt;
      if (!S) return;

      if (opt.weich) {
        if (!S.an) return;
        if (w.box) S.setBox(w.box.min, w.box.max);
        var cur = S.zustand.scheiben;
        Object.keys(w.scheiben || {}).forEach(function (name) {
          var s = cur.filter(function (x) { return x.name === name; })[0];
          if (s) S.scheibeSetzen(s.id, { winkel: w.scheiben[name].winkel, d: w.scheiben[name].d, dicke: w.scheiben[name].dicke });
        });
        return;
      }

      if (w.an === false) { if (S.an) S.beenden(); return; }
      if (!S.an && !S.starten()) return;

      if (w.modus) S.setModus(w.modus);
      if (typeof w.flaechen === 'boolean') S.setFlaechen(w.flaechen);
      if (typeof w.kante === 'boolean') S.setKante(w.kante);
      if (typeof w.griffe === 'boolean') S.setGriffe(w.griffe);

      var st = S.stand();
      if (typeof w.yaw === 'number' && Math.abs(num(st.yaw, 0) - w.yaw) > 0.01) S.setYaw(w.yaw);
      if (w.box) S.setBox(w.box.min, w.box.max); else S.ganz();

      // Scheiben nach Namen abgleichen: die Kennung vergibt der Schnitt selbst.
      var soll = w.scheiben || {};
      S.zustand.scheiben.slice().forEach(function (s) { if (!(s.name in soll)) S.scheibeWeg(s.id); });
      Object.keys(soll).forEach(function (name) {
        var werte = soll[name];
        var s = S.zustand.scheiben.filter(function (x) { return x.name === name; })[0];
        if (!s) {
          s = S.scheibeNeu({ winkel: werte.winkel, d: werte.d, dicke: werte.dicke });
          if (!s) return;
          s.name = name;
        }
        S.scheibeSetzen(s.id, { winkel: werte.winkel, d: werte.d, dicke: werte.dicke, an: werte.an !== false });
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPLOSION
  // ═══════════════════════════════════════════════════════════════════════════

  Z.anmelden({
    id: 'explosion', ordnung: 45, titel: 'Explosionsansicht',
    beschreibung: 'Geschosse auseinanderziehen (abstand in m) und auf eine Ebene stauchen (flach 0…1).',
    weich: ['abstand', 'flach'],
    schema: { an: { typ: 'bool' }, abstand: { typ: 'meter', min: 0, max: 15 }, flach: { typ: 'zahl', min: 0, max: 1 },
              fuge: { typ: 'meter' }, regelhoehe: { typ: 'meter' } },

    lesen: function () {
      var E = B.Explosion;
      if (!E) return undefined;
      // Ausgeschaltet steht alles an seinem Platz: Abstand und Stauchung sind null,
      // gleich was der Regler zuletzt zeigte. So fährt die Explosion auf der
      // nächsten Folie von null aus auf, statt aus dem Nichts zu springen.
      if (!E.aktiv) return { an: false, abstand: 0, flach: 0 };
      return { an: true, abstand: rund(E.abstand, 3), flach: rund(E.flach, 3),
               fuge: rund(E.fuge, 3), regelhoehe: rund(E.regelhoehe, 3) };
    },

    setzen: async function (w, opt) {
      var E = B.Explosion;
      if (!E) return;
      var abstand = klemm(num(w.abstand, E.abstand), 0, E.maxAbstand);
      var flach = klemm(num(w.flach, E.flach), 0, 1);

      if (opt.weich) {
        if (!E.aktiv) return;
        E.abstandSetzen(abstand);
        E.flachSetzen(flach);
        return;
      }

      if (!w.an) {
        if (E.aktiv) E.aus();
        E.abstand = abstand; E.flach = flach;
        return;
      }
      if (typeof w.fuge === 'number' && !nahe(E.fuge, w.fuge, 0.001)) E.fuge = w.fuge;
      if (typeof w.regelhoehe === 'number' && !nahe(E.regelhoehe, w.regelhoehe, 0.001)) E.regelhoehe = w.regelhoehe;
      if (!E.aktiv) {
        E.abstand = abstand; E.flach = flach;
        await E.an();
      } else {
        E.abstandSetzen(abstand);
        E.flachSetzen(flach);
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // NOTIZEN: welche Notizen im Bild stehen
  // ═══════════════════════════════════════════════════════════════════════════

  Z.anmelden({
    id: 'notizen', ordnung: 50, titel: 'Notizen im Bild',
    beschreibung: 'Ob Notizen als Beschriftung in der Szene stehen, ob erledigte ausgeblendet sind, ab welcher ' +
                  'Entfernung sie verschwinden, und — mit ids — welche Notizen genau gezeigt werden (null = alle).',
    weich: ['sichtweite'],
    schema: { an: { typ: 'bool' }, nurOffen: { typ: 'bool' }, sichtweite: { typ: 'meter', min: 1 },
              ids: { typ: 'liste', beschreibung: 'Notiz-Kennungen oder null für alle' } },

    lesen: function () {
      var A = window.Annotations;
      if (!A || !A.isEnabled) return undefined;
      return { an: A.isEnabled(), nurOffen: A.isOnlyOpen(), sichtweite: A.getMaxDistance(), ids: A.getVisibleSet() };
    },

    setzen: function (w, opt) {
      var A = window.Annotations;
      if (!A) return;
      if (typeof w.sichtweite === 'number' && w.sichtweite > 0 && A.getMaxDistance() !== w.sichtweite) A.setMaxDistance(w.sichtweite);
      if (opt.weich) return;
      if (typeof w.an === 'boolean' && A.isEnabled() !== w.an) A.setEnabled(w.an);
      if (typeof w.nurOffen === 'boolean' && A.isOnlyOpen() !== w.nurOffen) A.setOnlyOpen(w.nurOffen);
      if ('ids' in w) A.setVisibleSet(w.ids);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // WELT: Karte, Gelände, Kulissen, Globus
  // ═══════════════════════════════════════════════════════════════════════════

  function globusAlpha() {
    var v = B.viewer;
    if (!v) return 1;
    var t = v.scene.globe.translucency;
    return t && t.enabled ? num(t.frontFaceAlpha, 1) : 1;
  }

  Z.anmelden({
    id: 'welt', ordnung: 60, titel: 'Welt: Karte, Gelände, 3D-Kulissen',
    beschreibung: 'Basiskarte und Gelände (Kennungen der Layer-Liste), Google 3D Tiles, ' +
                  'amtliche Gebäudeebenen (lod2-de …) und die Durchsichtigkeit des Globus. ' +
                  '„osm" ist veraltet und schaltet LoD2 Deutschland.',
    weich: ['globusTransparenz'],
    schema: { karte: { typ: 'text' }, gelaende: { typ: 'text' }, osm: { typ: 'bool' }, google: { typ: 'bool' },
              ebenen: { typ: 'objekt', beschreibung: '{ ebenenId: bool }' },
              globusTransparenz: { typ: 'zahl', min: 0, max: 1, beschreibung: '1 = deckend' } },

    lesen: function () {
      if (!B.viewer) return undefined;
      var LM = window.LayerManager;
      var aus = { google: !!(B.googleTiles && B.googleTiles.enabled),
                  globusTransparenz: rund(globusAlpha(), 3) };
      if (LM && LM.aktiveKarte) aus.karte = LM.aktiveKarte;
      if (LM && LM.aktivesGelaende) aus.gelaende = LM.aktivesGelaende;
      if (LM && Array.isArray(LM.tilesetLayers) && LM.tilesetLayers.length) {
        aus.ebenen = {};
        LM.tilesetLayers.forEach(function (t) { aus.ebenen[t.id] = !!t.active; });
      }
      return aus;
    },

    setzen: async function (w, opt) {
      if (typeof w.globusTransparenz === 'number' && !nahe(globusAlpha(), w.globusTransparenz, opt.weich ? 0.004 : 1e-6)) {
        B.setGlobeTransparency(w.globusTransparenz);
      }
      if (opt.weich) return;
      var LM = window.LayerManager;
      if (LM) {
        if (w.karte && LM.aktiveKarte !== w.karte) await LM.switchBasemap(w.karte);
        if (w.gelaende && LM.aktivesGelaende !== w.gelaende) await LM.switchTerrain(w.gelaende);
        if (w.ebenen && Array.isArray(LM.tilesetLayers)) {
          for (var i = 0; i < LM.tilesetLayers.length; i++) {
            var t = LM.tilesetLayers[i];
            if (!(t.id in w.ebenen) || !!t.active === !!w.ebenen[t.id]) continue;
            if (w.ebenen[t.id]) await LM.enableTileset(t.id); else LM.disableTileset(t.id);
          }
        }
      }
      try {
        // Zustände aus der ion-Zeit: OSM Buildings → LoD2 Deutschland
        var lod2 = LM && Array.isArray(LM.tilesetLayers) && LM.tilesetLayers.find(function (t) { return t.id === 'lod2-de'; });
        if (typeof w.osm === 'boolean' && lod2 && !(w.ebenen && 'lod2-de' in w.ebenen) && !!lod2.active !== w.osm) {
          await B.toggleOSMBuildings(w.osm);
        }
        if (typeof w.google === 'boolean' && !!(B.googleTiles && B.googleTiles.enabled) !== w.google) await B.toggleGoogle3DTiles();
      } catch (e) { console.warn('[Zustand] Kulisse:', e.message); }
    },
  });

  Z.anmelden({
    id: 'sonne', ordnung: 62, titel: 'Sonnenstand und Schatten',
    beschreibung: 'Uhrzeit der Sonne (0–24, Ortszeit des Rechners, heutiges Datum) und ob Schatten fallen.',
    weich: ['stunde'],
    schema: { stunde: { typ: 'zahl', min: 0, max: 24, beschreibung: 'null = unverändert (Jetzt-Zeit)' },
              schatten: { typ: 'bool' } },

    lesen: function () {
      if (!B.lighting) return undefined;
      var h = B.lighting.stunde;
      if (typeof h !== 'number') {
        // Noch keine Uhrzeit gesetzt: die Uhr der Szene läuft auf „jetzt". Die
        // Stunde daraus zu lesen macht den Zustand vollständig — ein `null`
        // ließe sich nicht wiederherstellen, sobald jemand eine Uhrzeit gesetzt hat.
        var v = B.viewer;
        if (v && v.clock && window.Cesium) {
          var d = Cesium.JulianDate.toDate(v.clock.currentTime);
          h = d.getHours() + d.getMinutes() / 60;
        } else {
          h = null;
        }
      }
      return { stunde: (typeof h === 'number') ? rund(h, 3) : null, schatten: !!B.lighting.schatten };
    },

    setzen: function (w, opt) {
      if (!B.lighting) return;
      // Beim Nachziehen reicht eine Fünfsekundel, beim endgültigen Setzen nicht:
      // sonst bliebe die Sonne bei 16,9996 stehen, wo die Folie 17 sagt.
      var eps = opt.weich ? 0.002 : 1e-6;
      if (typeof w.stunde === 'number' && !nahe(B.lighting.stunde, w.stunde, eps)) B.setLightingTime(w.stunde);
      if (!opt.weich && typeof w.schatten === 'boolean' && !!B.lighting.schatten !== w.schatten) B.setShadows(w.schatten);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FARBEN, LICHT, UNTERGRUND, PUNKTWOLKEN
  // ═══════════════════════════════════════════════════════════════════════════

  var FARBEN = {
    zahlen: { kelvin: 'kelvinSetzen', tint: 'tintSetzen', belichtung: 'belichtungSetzen', kontrast: 'kontrastSetzen',
              saettigung: 'saettigungSetzen', staerke: 'staerkeSetzen', umgebungSaettigung: 'umgebungSaettigungSetzen',
              umgebungHelligkeit: 'umgebungHelligkeitSetzen', neutral: 'neutralSetzen', grundton: 'grundtonSetzen',
              zeichnung: 'zeichnungSetzen', glasAnteil: 'glasAnteilSetzen' },
    schalter: { an: 'schalten', umgebung: 'umgebungSetzen', neutralAn: 'neutralAnSetzen', glas: 'glasSetzen' },
    texte: { bodenfarbe: 'bodenfarbeSetzen', glasFarbe: 'glasFarbeSetzen', schema: 'schema' },
  };

  Z.anmelden({
    id: 'farben', ordnung: 70, titel: 'Farben: Weißabgleich, Bauwerksfarben, Glas',
    beschreibung: 'Die Bildkorrektur (Kelvin, Tint, Belichtung …), die Bauwerksfarben (schema neutral|ifc) und das Glas.',
    weich: Object.keys(FARBEN.zahlen),
    schema: { kelvin: { typ: 'zahl', min: 2000, max: 14000 }, tint: { typ: 'zahl', min: -1, max: 1 },
              belichtung: { typ: 'zahl' }, kontrast: { typ: 'zahl' }, saettigung: { typ: 'zahl' },
              schema: { typ: 'wahl', werte: ['neutral', 'ifc'] }, an: { typ: 'bool' } },

    lesen: function () {
      var F = B.Farben;
      if (!F) return undefined;
      var st = F.stand(), aus = {};
      [].concat(Object.keys(FARBEN.zahlen), Object.keys(FARBEN.schalter), Object.keys(FARBEN.texte)).forEach(function (k) {
        if (k in st) aus[k] = typeof st[k] === 'number' ? rund(st[k], 4) : st[k];
      });
      return aus;
    },

    setzen: function (w, opt) {
      var F = B.Farben;
      if (!F) return;
      var st = F.stand();
      Object.keys(FARBEN.zahlen).forEach(function (k) {
        if (typeof w[k] === 'number' && !nahe(st[k], w[k], opt.weich ? 0.0005 : 1e-6)) F[FARBEN.zahlen[k]](w[k]);
      });
      if (opt.weich) return;
      Object.keys(FARBEN.schalter).forEach(function (k) {
        if (typeof w[k] === 'boolean' && st[k] !== w[k]) F[FARBEN.schalter[k]](w[k]);
      });
      Object.keys(FARBEN.texte).forEach(function (k) {
        if (typeof w[k] === 'string' && st[k] !== w[k]) F[FARBEN.texte[k]](w[k]);
      });
    },
  });

  Z.anmelden({
    id: 'licht', ordnung: 72, titel: 'Kunstlicht: Grundaufhellung, Taschenlampe',
    beschreibung: 'Die Grundaufhellung (0–1) und die Taschenlampe an der Kamera.',
    weich: ['aufhellung', 'staerke', 'weite', 'reichweite'],
    schema: { aufhellung: { typ: 'zahl', min: 0, max: 1 }, lampe: { typ: 'bool' }, staerke: { typ: 'zahl', min: 0, max: 4 },
              weite: { typ: 'grad', min: 2, max: 80 }, reichweite: { typ: 'meter', min: 1, max: 500 }, farbe: { typ: 'farbe' } },

    lesen: function () {
      var L = B.Licht;
      if (!L) return undefined;
      var st = L.stand();
      return { lampe: st.lampe, staerke: rund(st.staerke, 3), weite: rund(st.weite, 2), reichweite: rund(st.reichweite, 2),
               farbe: st.farbe, aufhellung: rund(st.aufhellung, 4) };
    },

    setzen: function (w, opt) {
      var L = B.Licht;
      if (!L) return;
      var st = L.stand();
      var e = opt.weich ? 1 : 0.001;   // beim endgültigen Setzen gilt ein Tausendstel der Nachzieh-Toleranz
      if (typeof w.aufhellung === 'number' && !nahe(st.aufhellung, w.aufhellung, 0.0005 * e)) L.aufhellungSetzen(w.aufhellung);
      if (typeof w.staerke === 'number' && !nahe(st.staerke, w.staerke, 0.001 * e)) L.staerkeSetzen(w.staerke);
      if (typeof w.weite === 'number' && !nahe(st.weite, w.weite, 0.01 * e)) L.weiteSetzen(w.weite);
      if (typeof w.reichweite === 'number' && !nahe(st.reichweite, w.reichweite, 0.01 * e)) L.reichweiteSetzen(w.reichweite);
      if (opt.weich) return;
      if (typeof w.farbe === 'string' && st.farbe !== w.farbe) L.farbeSetzen(w.farbe);
      if (typeof w.lampe === 'boolean' && st.lampe !== w.lampe) L.taschenlampe(w.lampe);
    },
  });

  Z.anmelden({
    id: 'untergrund', ordnung: 74, titel: 'Untergrund-Modus',
    beschreibung: 'Die Kamera darf unter das Gelände; Nullebene markiert die Geländeoberkante; Durchblick über Modellen.',
    schema: { an: { typ: 'bool' }, nullebene: { typ: 'bool' }, durchblick: { typ: 'bool' } },

    lesen: function () {
      var U = B.Untergrund;
      if (!U) return undefined;
      var st = U.stand();
      return { an: !!st.an, nullebene: !!st.nullebene, durchblick: !!st.durchblick };
    },

    setzen: function (w) {
      var U = B.Untergrund;
      if (!U) return;
      var st = U.stand();
      if (typeof w.nullebene === 'boolean' && !!st.nullebene !== w.nullebene) U.nullebeneSetzen(w.nullebene);
      if (typeof w.durchblick === 'boolean' && !!st.durchblick !== w.durchblick) U.durchblickSetzen(w.durchblick);
      if (typeof w.an === 'boolean' && !!st.an !== w.an) B.toggleUndergroundView(w.an);
    },
  });

  var PUNKTE = {
    colorMode: 'setColorMode', pointSize: 'setPointSize', edlEnabled: 'setEyeDomeLighting',
    edlStrength: 'setEDLStrength', edlRadius: 'setEDLRadius', attenuationEnabled: 'setAttenuation',
  };

  Z.anmelden({
    id: 'punktwolken', ordnung: 76, titel: 'Punktwolken: Farbmodus, Punktgröße',
    beschreibung: 'Wie Punktwolken aussehen: Farbmodus (rgb|height|…), Punktgröße, Eye-Dome-Lighting.',
    weich: ['pointSize', 'edlStrength', 'edlRadius'],
    schema: { colorMode: { typ: 'text' }, pointSize: { typ: 'zahl', min: 1 }, edlEnabled: { typ: 'bool' },
              edlStrength: { typ: 'zahl' }, edlRadius: { typ: 'zahl' }, attenuationEnabled: { typ: 'bool' } },

    lesen: function () {
      var s = B.pointCloudSettings;
      if (!s) return undefined;
      var aus = {};
      Object.keys(PUNKTE).forEach(function (k) { aus[k] = typeof s[k] === 'number' ? rund(s[k], 3) : s[k]; });
      return aus;
    },

    setzen: function (w, opt) {
      var s = B.pointCloudSettings;
      if (!s) return;
      Object.keys(PUNKTE).forEach(function (k) {
        if (!(k in w) || w[k] === s[k]) return;
        if (typeof w[k] === 'number' && nahe(s[k], w[k], 0.002)) return;
        if (opt.weich && typeof w[k] !== 'number') return;
        B[PUNKTE[k]](w[k]);
      });
    },
  });

  console.log('🎛 Zustand: ' + Z.ids().join(', '));
})();
