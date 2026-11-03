// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tablet, Ebenen, Welt, Karte und Werkzeuge in der nachgebildeten Quest 3.
//
// Voraussetzung wie test-vr.mjs: puppeteer-core, Vite auf 5181 (oder
// VIEWER_URL), Backend auf 8100, Internet (three.js, Emulator, und hier auch
// Gelände, Luftbild und LoD2 von ihren Diensten).
//
// Aufruf:  node tests/vr/test-vr-tablet.mjs
//          VR_JOB=<job-id> node tests/vr/test-vr-tablet.mjs   (sonst der Lux-Pavillon:
//                                                               verortet, mit Property-Sets)
//
// Geprüft wird, was man in der Brille tut, nicht nur, was die Seite anbietet:
//   · das Tablet hängt an der linken Hand, der rechte Strahl trifft es, der
//     Abzug tippt einen Reiter an, der Stick rollt eine Liste
//   · Klasse aus: ihre Dreiecke fallen aus dem Index, der Strahl geht hindurch
//   · Isolieren und Alles zeigen
//   · Eigenschaften eines Bauteils kommen aus dem Backend
//   · die Welt: Gelände unter dem Modell, abgesenkt im Grundriss, man steht
//     beim Start auf dem Gelände, LoD2-Nachbarn sind da
//   · Minikarte: Sprung 30 m nach Norden landet 30 m weiter nördlich
//   · Messen mit zwei Abzügen, Höhenschnitt an den Modellmaterialien
//   · Tischmodell: Welt endet an einem Kreis, Tablet bleibt
//   · keine Fehler in der Konsole

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEITE = process.env.VIEWER_URL || 'http://localhost:5181/';
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8100';
const IWER = 'https://cdn.jsdelivr.net/npm/iwer@2.6.0/build/iwer.module.js';
const WELTQUELLEN = /geodatenzentrum\.de|reearth\.land|elevation-tiles-prod|maps\.eox\.at|openstreetmap\.org|rlp\.de|hessen\.de|nrw\.de|bayern\.de|saarland\.de|lod2_4326|ileen-quest\.json/;

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis !== undefined ? `\n      ${hinweis}` : ''}`); }
}

async function jobWaehlen() {
  if (process.env.VR_JOB) return process.env.VR_JOB;
  const assets = await (await fetch(`${BACKEND}/assets/`)).json();
  const lux = assets.find(a => a.content_type === 'ifc' && /^Lux Pavillon/.test(a.name));
  return (lux || assets.find(a => a.content_type === 'ifc')).job_id;
}

const job = await jobWaehlen();
console.log(`Modell: ${job}\n`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  acceptInsecureCerts: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=1400,900'],
});

const konsole = [];
try {
  const seite = await browser.newPage();
  await seite.setViewport({ width: 1400, height: 900 });
  seite.on('console', m => {
    if (m.type() !== 'error') return;
    const wo = (m.location() && m.location().url) || '';
    if (WELTQUELLEN.test(wo) || WELTQUELLEN.test(m.text()) || /error code 404/.test(m.text())) return;
    konsole.push(m.text());
  });
  seite.on('pageerror', e => konsole.push(`pageerror: ${(e.stack || e.message).split('\n').slice(0, 4).join(' ← ')}`));

  await seite.goto(`${SEITE}vr.html?job=${encodeURIComponent(job)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  pruefe('Seitentitel ist iLEEN VR', (await seite.title()) === 'iLEEN VR', await seite.title());
  await seite.waitForFunction(() => window.ILeenVR && ILeenVR.zustand.ausgerichtet, { timeout: 90000 });
  await seite.waitForFunction(() => ILeenVR.app.ladestand() >= 1 && ILeenVR.welt.zustand.geladenZahl > 0, { timeout: 120000 }).catch(() => {});

  // ── Welt am Bildschirm ────────────────────────────────────────
  const w0 = await seite.evaluate(() => {
    const V = ILeenVR;
    const w = V.welt.zustand;
    return {
      ort: !!V.zustand.ort, N: w.N, gelaende: w.geladenZahl, lod2: !!w.gebaeude && w.gebaeude.group.visible,
      mitte: V.welt.gelaendeMitte(), raster: V.zustand.raster, nebel: !!V.szene.fog, fern: V.kamera.far,
    };
  });
  pruefe('Modell ist verortet', w0.ort);
  pruefe('Geoidundulation geladen (Mainz ≈ 48 m)', w0.N > 40 && w0.N < 55, w0.N);
  pruefe('Geländekacheln geladen', w0.gelaende > 0, w0.gelaende);
  pruefe('LoD2-Nachbarn eingeschaltet', w0.lod2);
  pruefe('Gelände in Grundrissmitte nahe der Sohle (±3 m)', w0.mitte !== null && Math.abs(w0.mitte) < 3, w0.mitte);
  pruefe('mit Gelände tritt das Raster zurück', w0.raster === false);
  pruefe('Dunst und weite Sicht mit Welt', w0.nebel && w0.fern >= 50000, JSON.stringify(w0));

  // Grundriss und Absenkung: Strahl von oben in die Grundrissmitte trifft kein sichtbares Gelände über der Sohle
  const fuss = await seite.evaluate(() => {
    const V = ILeenVR;
    const f = V.zustand.fuss;
    return { f, sohle: V.welt.unsichtbarerTreffer({ object: V.welt.zustand.gelaende.group.children[0] || V.welt.zustand.gelaende.group }, { x: f.cx, y: 0.5, z: f.cz }) };
  });
  pruefe('Grundrissrechteck erkannt', fuss.f && fuss.f.a > 0.5 && fuss.f.b > 0.5, JSON.stringify(fuss.f));
  pruefe('Gelände über der Sohle im Grundriss zählt nicht als Treffer', fuss.sohle === 'gelaende', fuss.sohle);

  // ── Eigenschaften am Bildschirm ───────────────────────────────
  const szene = await seite.$('#vrSzene canvas');
  const r = await szene.boundingBox();
  for (const [fx, fy] of [[0.5, 0.55], [0.5, 0.5], [0.52, 0.6], [0.45, 0.5], [0.55, 0.45], [0.5, 0.65]]) {
    await seite.mouse.click(r.x + r.width * fx, r.y + r.height * fy);
    if (await seite.evaluate(() => ILeenVR.auswahl && ILeenVR.auswahl.quelle === 'modell')) break;
  }
  await seite.waitForFunction(() => ILeenVR.auswahl && ILeenVR.auswahl.eigenschaften !== 'laedt', { timeout: 20000 }).catch(() => {});
  const a = await seite.evaluate(() => {
    const x = ILeenVR.auswahl;
    return x && { titel: x.titel, guid: x.guid, gruppen: Array.isArray(x.eigenschaften) ? x.eigenschaften.length : x.eigenschaften, seite: ILeenVR.tablet.seite };
  });
  pruefe('Klick wählt ein Bauteil, Tablet auf Info', !!a && a.seite === 'info', JSON.stringify(a));
  pruefe('Property-Sets aus dem Backend', !!a && typeof a.gruppen === 'number' && a.gruppen > 0, JSON.stringify(a));

  // ── Ebenen: Klasse aus, Strahl geht hindurch ──────────────────
  const klasse = await seite.evaluate(() => {
    const V = ILeenVR;
    const typ = V.ebenen.klassen().map(k => k.schluessel).find(Boolean);
    const zaehle = () => {
      let voll = 0;
      let gezeichnet = 0;
      V.tiles.group.traverse(o => {
        if (!o.isMesh || !o.geometry.getAttribute('_batchid') || o.userData.vrMarkierung) return;
        const n = o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position').count;
        voll += n;
        gezeichnet += o.visible ? Math.min(n, o.geometry.drawRange.count) : 0;
      });
      return { voll, gezeichnet };
    };
    const vorher = zaehle();
    V.tabletDruecken('reiter:ebenen');
    const gedrueckt = V.tabletDruecken(`ebene:klassen:${typ}`);
    const nachher = zaehle();
    const aus = !V.ebenen.klassen().find(k => k.schluessel === typ).an;
    V.tabletDruecken('ebenen:an');
    const wieder = zaehle();
    return { typ, gedrueckt, aus, vorher, nachher, wieder };
  });
  pruefe('Reiter und Zeile über das Tablet gedrückt', klasse.gedrueckt && klasse.aus, JSON.stringify(klasse));
  pruefe('Klasse aus: weniger Dreiecke gezeichnet', klasse.nachher.gezeichnet < klasse.vorher.gezeichnet,
    `${klasse.typ}: ${klasse.vorher.gezeichnet} → ${klasse.nachher.gezeichnet}`);
  pruefe('Alle an: wieder vollständig', klasse.wieder.gezeichnet === klasse.vorher.gezeichnet,
    `${klasse.wieder.gezeichnet} / ${klasse.vorher.gezeichnet}`);

  const iso = await seite.evaluate(() => {
    const V = ILeenVR;
    if (!V.auswahl || !V.auswahl.guid) return null;
    V.tabletDruecken('reiter:info');
    V.tabletDruecken('info:iso');
    const nur = V.ebenen.filter.nur && [...V.ebenen.filter.nur];
    const sichtbar = V.ebenen.sichtbar(V.auswahl.guid);
    V.tabletDruecken('info:alles');
    return { nur, sichtbar, leer: V.app.ebenen.filterLeer };
  });
  pruefe('Isolieren lässt genau das gewählte Bauteil stehen', !!iso && iso.nur && iso.nur.length === 1 && iso.sichtbar, JSON.stringify(iso));
  pruefe('Alles zeigen leert den Filter', !!iso && iso.leer);

  // ── Brille ────────────────────────────────────────────────────
  await seite.addScriptTag({
    type: 'module',
    content: `
      import { XRDevice, metaQuest3 } from '${IWER}';
      const brille = new XRDevice(metaQuest3);
      brille.installRuntime({ forceInstall: true });
      window.__brille = brille;
    `,
  });
  await seite.waitForFunction(() => !!window.__brille, { timeout: 30000 });
  await seite.evaluate(() => ILeenVR.pruefeXR());
  await seite.waitForFunction(() => !document.getElementById('vrKnopfVR').disabled, { timeout: 10000 }).catch(() => {});
  await seite.click('#vrKnopfVR');
  await seite.waitForFunction(() => ILeenVR.renderer.xr.isPresenting, { timeout: 15000 }).catch(() => {});
  pruefe('1:1-Sitzung läuft', await seite.evaluate(() => ILeenVR.renderer.xr.isPresenting));

  const bilder = n => seite.evaluate(n => new Promise(fertig => {
    const s = ILeenVR.renderer.xr.getSession();
    let rest = n;
    const weiter = () => (--rest <= 0 ? fertig() : s.requestAnimationFrame(weiter));
    s.requestAnimationFrame(weiter);
  }), n);
  await bilder(10);

  // Abgesetzt auf dem Gelände (bis zu 5 s, die Kacheln unter dem Start kommen nach)
  let start = null;
  for (let i = 0; i < 25; i++) {
    await bilder(6);
    start = await seite.evaluate(() => ({ y: ILeenVR.nutzer.position.y, z: ILeenVR.nutzer.position.z, kz: ILeenVR.zustand.kasten.max.z }));
    if (Math.abs(start.y) > 1e-4) break;
  }
  pruefe('Start vor der Südseite', start.z > start.kz, JSON.stringify(start));
  pruefe('beim Start aufs Gelände gestellt (|y| < 6 m)', Math.abs(start.y) < 6, start.y);

  // Tablet an der linken Hand
  const t0 = await seite.evaluate(() => ({
    sichtbar: ILeenVR.tabletMesh.visible,
    hand: ILeenVR.haende.find(h => h.griff === ILeenVR.tabletMesh.parent)?.quelle?.handedness,
  }));
  pruefe('Tablet hängt sichtbar an der linken Hand', t0.sichtbar && t0.hand === 'left', JSON.stringify(t0));

  /**
   * Den rechten Strahl auf eine Stelle des Tablets richten (Pixel der Leinwand).
   * Nachgeführt statt ausgerechnet: zwischen der Lage des Controllers und
   * seinem Strahl kann ein fester Versatz liegen; die Drehung von „ist“ nach
   * „soll“ links angesetzt hebt ihn auf.
   */
  const zielenAuf = async (px, py) => {
    await seite.evaluate(() => {
      const l = __brille.controllers.left;
      l.position.set(-0.12, 1.15, -0.35);
      l.quaternion.set(0, 0, 0, 1);
      __brille.controllers.right.position.set(0.18, 1.45, -0.05);
    });
    await bilder(3);
    for (let i = 0; i < 4; i++) {
      await seite.evaluate((px, py) => {
        const V = ILeenVR;
        const T = V.tabletMesh;
        const V3 = T.position.constructor;
        const Q = T.quaternion.constructor;
        const b = T.geometry.parameters.width;
        const h = T.geometry.parameters.height;
        const ziel = T.localToWorld(new V3((px / 1024 - 0.5) * b, (0.5 - py / 704) * h, 0));
        const hand = V.haende.find(x => x.quelle && x.quelle.handedness === 'right');
        const von = hand.strahl.getWorldPosition(new V3());
        const zuNutzer = V.nutzer.getWorldQuaternion(new Q()).invert();
        const soll = ziel.sub(von).normalize().applyQuaternion(zuNutzer);
        const ist = new V3(0, 0, -1).applyQuaternion(hand.strahl.getWorldQuaternion(new Q())).applyQuaternion(zuNutzer);
        const c = __brille.controllers.right;
        const neu = new Q().setFromUnitVectors(ist, soll).multiply(new Q(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w));
        c.quaternion.set(neu.x, neu.y, neu.z, neu.w);
      }, px, py);
      await bilder(3);
    }
    return seite.evaluate(() => {
      const h = ILeenVR.haende.find(x => x.quelle && x.quelle.handedness === 'right');
      return h.aufTablet;
    });
  };

  // Der Reiter „Karte“: seine Lage liest der Test aus dem Tablet, statt sie festzuschreiben —
  // mit jedem Reiter mehr (zuletzt „Leistung“) werden die übrigen schmaler und rücken
  const [kx, ky] = await seite.evaluate(() => {
    const r = ILeenVR.ui.regionen.find(x => x.id === 'reiter:karte');
    return r ? [r.x + r.w / 2, r.y + r.h / 2] : [0, 0];
  });
  const treffer = await zielenAuf(kx, ky);
  pruefe('rechter Strahl trifft das Tablet', !!treffer, JSON.stringify(treffer));
  if (treffer) console.log(`      bei ${treffer.map(v => Math.round(v)).join(' / ')} px (Ziel ${Math.round(kx)} / ${Math.round(ky)})`);
  const hover = await seite.evaluate(() => ILeenVR.ui.hoverId);
  pruefe('Reiter unter dem Strahl ist hervorgehoben', hover === 'reiter:karte', hover);
  await seite.evaluate(() => __brille.controllers.right.updateButtonValue('trigger', 1));
  await bilder(3);
  await seite.evaluate(() => __brille.controllers.right.updateButtonValue('trigger', 0));
  await bilder(3);
  const nachTippen = await seite.evaluate(() => ({ seite: ILeenVR.tablet.seite, y: ILeenVR.nutzer.position.y, ring: ILeenVR.szene.children.some(o => o.isMesh && o.geometry.type === 'RingGeometry' && o.visible) }));
  pruefe('Abzug auf dem Tablet tippt (Karte offen), ohne zu springen', nachTippen.seite === 'karte' && Math.abs(nachTippen.y - start.y) < 1e-6,
    JSON.stringify(nachTippen));

  // Rechter Stick auf dem Tablet rollt statt zu drehen
  const rollen = await seite.evaluate(async () => {
    const V = ILeenVR;
    V.tabletDruecken('reiter:info');
    return { gier: V.nutzer.rotation.y };
  });
  await zielenAuf(500, 500);
  await seite.evaluate(() => __brille.controllers.right.updateAxes('thumbstick', 0, 1));
  await bilder(20);
  await seite.evaluate(() => __brille.controllers.right.updateAxes('thumbstick', 0, 0));
  await bilder(2);
  const nachRollen = await seite.evaluate(() => ({ scroll: ILeenVR.ui.scroll.get('info') || 0, gier: ILeenVR.nutzer.rotation.y, inhalt: ILeenVR.ui.bereiche.get('info')?.inhalt }));
  pruefe('Stick auf dem Tablet rollt die Liste', nachRollen.scroll > 0 || (nachRollen.inhalt || 0) < 420, JSON.stringify(nachRollen));
  pruefe('…und dreht dabei nicht', Math.abs(nachRollen.gier - rollen.gier) < 1e-6);

  // Strahl weg vom Tablet
  await seite.evaluate(() => {
    const c = __brille.controllers.right;
    c.position.set(0.25, 1.4, -0.3);
    c.quaternion.set(0, 0, 0, 1);
  });
  await bilder(4);

  // ── Minikarte: 30 m nach Norden ───────────────────────────────
  const sprung = await seite.evaluate(() => {
    const V = ILeenVR;
    const vorher = V.kamera.getWorldPosition(V.nutzer.position.clone());
    const g = V.lokalZuGrad(vorher.x, 0, vorher.z);
    V.hinspringen(g.lat + 30 / 111320, g.lon);
    const nachher = V.kamera.getWorldPosition(V.nutzer.position.clone());
    return { dx: nachher.x - vorher.x, dz: nachher.z - vorher.z };
  });
  pruefe('Kartensprung 30 m nach Norden (−z)', Math.abs(sprung.dz + 30) < 0.5 && Math.abs(sprung.dx) < 0.5, JSON.stringify(sprung));
  await bilder(10);

  // ── Messen ────────────────────────────────────────────────────
  await seite.evaluate(() => { ILeenVR.tabletDruecken('reiter:werkzeuge'); ILeenVR.tabletDruecken('wz:messen'); });
  const messen = async neigung => {
    await seite.evaluate(a => {
      const c = __brille.controllers.right;
      c.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2));
      c.updateButtonValue('trigger', 1);
    }, neigung);
    await bilder(3);
    await seite.evaluate(() => __brille.controllers.right.updateButtonValue('trigger', 0));
    await bilder(3);
  };
  await messen(-Math.PI / 3);
  await messen(-Math.PI / 5);
  const m = await seite.evaluate(() => ILeenVR.werkzeug.messung);
  if (process.env.VR_DEBUG) console.log(await seite.evaluate(() => JSON.stringify({
    punkte: ILeenVR.werkzeug.punkte.map(p => p.toArray().map(v => +v.toFixed(2))),
    nutzer: ILeenVR.nutzer.position.toArray().map(v => +v.toFixed(2)),
    strahl: ILeenVR.haende.find(h => h.quelle.handedness === 'right').strahl.getWorldDirection(ILeenVR.nutzer.position.clone()).toArray().map(v => +v.toFixed(2)),
  })));
  pruefe('zwei Abzüge messen eine Strecke', !!m && m.abstand > 0.1, JSON.stringify(m));
  if (m) console.log(`      ${m.abstand.toFixed(2)} m, waagerecht ${m.waagerecht.toFixed(2)} m`);
  await seite.evaluate(() => ILeenVR.tabletDruecken('wz:messen'));

  // ── Höhenschnitt ──────────────────────────────────────────────
  const schnitt = await seite.evaluate(() => {
    const V = ILeenVR;
    V.tabletDruecken('wz:schnitt');
    let mit = 0;
    let ohne = 0;
    V.tiles.group.traverse(o => {
      if (!o.material || o.userData.vrMarkierung) return;
      for (const s of [].concat(o.material)) { if (s.clippingPlanes === V.schnittEbenen) mit++; else ohne++; }
    });
    const r = { an: V.werkzeug.schnitt.an, ebenen: V.schnittEbenen.length, mit, ohne };
    V.tabletDruecken('wz:schnitt');
    return { ...r, danach: V.schnittEbenen.length };
  });
  pruefe('Höhenschnitt hängt an allen Modellmaterialien', schnitt.an && schnitt.ebenen === 1 && schnitt.mit > 0 && schnitt.ohne === 0, JSON.stringify(schnitt));
  pruefe('Höhenschnitt aus: keine Ebene mehr', schnitt.danach === 0);

  // ── B/Y: Tablet aus und an ────────────────────────────────────
  const knopfY = async () => {
    await seite.evaluate(() => __brille.controllers.left.updateButtonValue('y-button', 1));
    await bilder(3);
    await seite.evaluate(() => __brille.controllers.left.updateButtonValue('y-button', 0));
    await bilder(3);
    return seite.evaluate(() => ILeenVR.tabletMesh.visible);
  };
  const aus = await knopfY();
  const an = await knopfY();
  pruefe('Y schaltet das Tablet aus und wieder an', aus === false && an === true, `${aus} / ${an}`);

  await seite.evaluate(() => ILeenVR.renderer.xr.getSession().end());
  await seite.waitForFunction(() => !ILeenVR.renderer.xr.isPresenting, { timeout: 10000 }).catch(() => {});

  // ── Tischmodell ───────────────────────────────────────────────
  await seite.click('#vrKnopfTisch');
  await seite.waitForFunction(() => ILeenVR.renderer.xr.isPresenting, { timeout: 15000 }).catch(() => {});
  await bilder(10);
  const tisch = await seite.evaluate(() => ({
    modus: ILeenVR.zustand.modus, tablet: ILeenVR.tabletMesh.visible, nebel: !!ILeenVR.szene.fog,
    welt: ILeenVR.welt.gruppe.parent === ILeenVR.modell,
  }));
  pruefe('Tischmodell: Welt verkleinert sich mit, kein Dunst, Tablet da', tisch.modus === 'tisch' && tisch.welt && !tisch.nebel && tisch.tablet, JSON.stringify(tisch));
  await seite.evaluate(() => ILeenVR.renderer.xr.getSession().end());
  await seite.waitForFunction(() => !ILeenVR.renderer.xr.isPresenting, { timeout: 10000 }).catch(() => {});

  // ── Welt aus und an ───────────────────────────────────────────
  const schalten = await seite.evaluate(() => {
    const V = ILeenVR;
    V.tabletDruecken('reiter:welt');
    V.tabletDruecken('welt:an');
    const aus = { renderer: V.welt.renderer().length, gelaende: !!V.welt.zustand.gelaende, raster: V.zustand.raster, nebel: !!V.szene.fog };
    V.tabletDruecken('welt:an');
    const an = { renderer: V.welt.renderer().length, raster: V.zustand.raster };
    return { aus, an };
  });
  pruefe('Umgebung aus: Kacheln entsorgt, Raster zurück, kein Dunst',
    schalten.aus.renderer === 0 && !schalten.aus.gelaende && schalten.aus.raster && !schalten.aus.nebel, JSON.stringify(schalten.aus));
  pruefe('Umgebung wieder an', schalten.an.renderer > 0 && !schalten.an.raster, JSON.stringify(schalten.an));

  const echte = konsole.filter(t => !/iwer|IWER/.test(t));
  pruefe('keine Fehler in der Konsole', echte.length === 0, echte.slice(0, 5).join('\n      '));
} finally {
  await browser.close();
}

console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
