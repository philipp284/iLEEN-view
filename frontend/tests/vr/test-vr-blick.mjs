// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Blick + Kneifen, wie die Vision Pro es WebXR liefert — nachgestellt.
//
// IWER bildet nur Metas Geräte nach. Seine Hände tragen ein Gamepad, und sein
// Blick („gaze") folgt Metas Muster, nicht Apples. Dieser Prüfstein schaltet
// IWERs Controller ab und speist Apples Muster selbst ein (webkit.org/blog/15162):
//   · zwei Hände als `tracked-pointer` ohne Gamepad — nur Lage, keine Ereignisse
//   · Kneifen als `transient-pointer` dahinter (Index 2): `inputsourceschange`,
//     dann `selectstart` mit aktivem Frame, `selectend`, wieder weg
// Die Posen sind echte IWER-XRSpaces relativ zum Bezugsraum der Sitzung, die
// Ereignisse laufen durch three.js (WebXRManager) wie in der Brille.
//
// Was er NICHT zeigen kann: wie sich das in der echten Vision Pro anfühlt —
// Zielgenauigkeit des Blicks auf dem Tablet, Größe und Lage des schwebenden
// Tablets, Drehen per Knopf statt Stick.
//
// Aufruf:  node tests/vr/test-vr-blick.mjs
//          VIEWER_URL=http://localhost:5197/ VR_JOB=<id> node tests/vr/test-vr-blick.mjs

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEITE = process.env.VIEWER_URL || 'http://localhost:5181/';
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8100';
const IWER = 'https://cdn.jsdelivr.net/npm/iwer@2.6.0/build/iwer.module.js';

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis !== undefined ? `\n      ${hinweis}` : ''}`); }
}

async function jobWaehlen() {
  if (process.env.VR_JOB) return process.env.VR_JOB;
  const assets = await (await fetch(`${BACKEND}/assets/`)).json();
  const kran = assets.find(a => a.content_type === 'ifc' && /kranhalle/i.test(a.name));
  return (kran || assets.find(a => a.content_type === 'ifc')).job_id;
}

const job = await jobWaehlen();
console.log(`Modell: ${job}\n`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  acceptInsecureCerts: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=1200,800'],
});

const konsole = [];
try {
  const seite = await browser.newPage();
  await seite.setViewport({ width: 1200, height: 800 });
  seite.on('console', m => { if (m.type() === 'error' && !/error code 404|Failed to load resource/.test(m.text())) konsole.push(m.text()); });
  seite.on('pageerror', e => konsole.push(`pageerror: ${(e.stack || e.message).split('\n').slice(0, 4).join(' ← ')}`));
  // Ohne Vites Hot Reload: wird nebenher an den VR-Dateien gearbeitet, lädt
  // die Seite sonst mitten im Lauf neu. Der Vite-Client lädt nur nach einem
  // Ereignis seiner Verbindung neu — ein WebSocket, der für `vite-*` nie öffnet,
  // legt ihn still. (Request-Interception ginge auch, schleust aber jede der
  // Hunderten Anfragen über DevTools und lief auf einem ausgelasteten Rechner in Zeitgrenzen.)
  await seite.evaluateOnNewDocument(() => {
    const Echt = window.WebSocket;
    const Still = function (url, protokoll) {
      if (String(protokoll || '').startsWith('vite-')) {
        const s = new EventTarget();
        Object.assign(s, { url: String(url), readyState: 0, protocol: '', send() {}, close() {} });
        return s;
      }
      const ws = protokoll === undefined ? new Echt(url) : new Echt(url, protokoll);
      // Gruppe (vr-gemeinsam.js): die gesendeten Posen mitlesen — sieht man den Kneif-Strahl?
      if (/vr-raum/.test(String(url))) {
        const senden = ws.send.bind(ws);
        window.__posen = [];
        ws.send = d => {
          try { const n = JSON.parse(d); if (n.t === 'pose') { __posen.push(n); if (__posen.length > 40) __posen.shift(); } } catch { /* kein JSON */ }
          return senden(d);
        };
      }
      return ws;
    };
    Still.prototype = Echt.prototype;
    Object.assign(Still, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Still;
  });

  // Ohne Welt: schneller, und der Rasterboden ist der Landeplatz. Eigener Raum
  // der Gruppe — gegen den laufenden Dienst merkt der Raum „labor" nichts.
  await seite.goto(`${SEITE}vr.html?job=${encodeURIComponent(job)}&welt=0&raum=pruef-blick-${Date.now().toString(36)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await seite.waitForFunction(() => window.ILeenVR && ILeenVR.zustand.ausgerichtet, { timeout: 90000 });
  await seite.waitForFunction(() => ILeenVR.app.ladestand() >= 1, { timeout: 90000 }).catch(() => {});

  // ── Brille ohne Controller ────────────────────────────────────
  await seite.addScriptTag({
    type: 'module',
    content: `
      import { XRDevice, metaQuest3, XRInputSource, XRSpace, P_SPACE } from '${IWER}';
      const brille = new XRDevice(metaQuest3);
      brille.installRuntime({ forceInstall: true });
      brille.controllers.left.connected = false;
      brille.controllers.right.connected = false;
      window.__brille = brille;
      window.__iwer = { XRInputSource, XRSpace, P_SPACE };
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
  await bilder(8);

  // Hilfsmittel in der Seite: Eingaben anlegen, ausrichten, Ereignisse im Frame
  await seite.evaluate(() => {
    const V = ILeenVR;
    const { XRInputSource, XRSpace, P_SPACE } = __iwer;
    const T = V.THREE;
    const sitzung = () => V.renderer.xr.getSession();
    const bezug = () => V.renderer.xr.getReferenceSpace();
    window.__vp = {
      quelle(hand, art) {
        const strahl = new XRSpace(bezug());
        const griff = new XRSpace(bezug());
        return new XRInputSource(hand, art, art === 'transient-pointer' ? ['generic-button'] : ['generic-hand'], strahl, undefined, griff, undefined);
      },
      wechsel(hinzu, weg) {
        const e = new Event('inputsourceschange');
        e.added = hinzu;
        e.removed = weg;
        sitzung().dispatchEvent(e);
      },
      /** Ereignis im nächsten Frame (wie die Brille: mit aktivem Frame) */
      ereignis(art, quelle) {
        return new Promise(fertig => sitzung().requestAnimationFrame((t, frame) => {
          const e = new Event(art);
          e.inputSource = quelle;
          e.frame = frame;
          sitzung().dispatchEvent(e);
          fertig();
        }));
      },
      /** Den Strahl vom Kopf auf einen Weltpunkt richten (Lage relativ zum Bezugsraum) */
      zielen(quelle, ziel) {
        V.nutzer.updateWorldMatrix(true, false);
        const auge = V.kamera.getWorldPosition(new T.Vector3());
        const welt = new T.Matrix4().lookAt(auge, ziel, new T.Vector3(0, 1, 0)).setPosition(auge);
        const lokal = V.nutzer.matrixWorld.clone().invert().multiply(welt);
        quelle.targetRaySpace[P_SPACE].offsetMatrix.set(lokal.elements);
      },
      /** Weltpunkt eines Tablet-Pixels */
      tabletPunkt(px, py) {
        const M = V.tabletMesh;
        const b = M.geometry.parameters.width;
        const h = M.geometry.parameters.height;
        M.updateWorldMatrix(true, false);
        return M.localToWorld(new T.Vector3((px / 1024 - 0.5) * b, (0.5 - py / 704) * h, 0));
      },
      /** Mitte einer Schaltfläche des Tablets */
      region(id) {
        const r = V.ui.regionen.find(x => x.id === id);
        return r ? [r.x + r.w / 2, r.y + r.h / 2] : null;
      },
      ring: () => V.szene.children.some(o => o.isMesh && o.geometry.type === 'RingGeometry' && o.visible),
    };
  });

  // ── vor dem ersten Kneifen ─────────────────────────────────────
  const t0 = await seite.evaluate(() => ({
    schwebt: ILeenVR.tabletMesh.parent === ILeenVR.nutzer,
    sichtbar: ILeenVR.tabletMesh.visible,
    groesse: ILeenVR.tabletMesh.scale.x,
  }));
  pruefe('ohne Controller schwebt das Tablet, sichtbar und vergrößert', t0.schwebt && t0.sichtbar && t0.groesse > 2, JSON.stringify(t0));

  // Hände wie auf der Vision Pro: tracked-pointer ohne Gamepad, nur Lage
  await seite.evaluate(() => {
    __vp.links = __vp.quelle('left', 'tracked-pointer');
    __vp.rechts = __vp.quelle('right', 'tracked-pointer');
    __vp.wechsel([__vp.links, __vp.rechts], []);
  });
  await bilder(4);
  const h0 = await seite.evaluate(() => ({
    verbunden: ILeenVR.haende.slice(0, 2).map(h => !!h.quelle),
    zeigen: ILeenVR.haende.slice(0, 2).map(h => h.zeigt || h.linie.visible),
    schwebt: ILeenVR.tabletMesh.parent === ILeenVR.nutzer,
    steuerung: ILeenVR.app.steuerung,
  }));
  pruefe('Hände belegen die Plätze 0 und 1', h0.verbunden.every(Boolean), JSON.stringify(h0));
  pruefe('Hände ohne Ereignisse zeigen keinen Strahl', h0.zeigen.every(z => !z), JSON.stringify(h0));
  pruefe('Hände ohne Gamepad tragen das Tablet nicht — es schwebt weiter', h0.schwebt);
  pruefe('Steuerung „hand" (Hilfe ohne Controller)', h0.steuerung === 'hand', h0.steuerung);

  const lage = await seite.evaluate(() => {
    const V = ILeenVR;
    const T = V.THREE;
    const kopf = V.kamera.getWorldPosition(new T.Vector3());
    const mitte = V.tabletMesh.getWorldPosition(new T.Vector3());
    const normale = new T.Vector3(0, 0, 1).transformDirection(V.tabletMesh.matrixWorld);
    const zumKopf = kopf.clone().sub(mitte).normalize();
    return { abstand: kopf.distanceTo(mitte), unter: kopf.y - mitte.y, zugewandt: normale.dot(zumKopf) };
  });
  pruefe('Tablet schwebt eine Armlänge vor dem Kopf und tiefer', lage.abstand > 0.6 && lage.abstand < 1.2 && lage.unter > 0.2, JSON.stringify(lage));
  pruefe('… und ist dem Gesicht zugewandt', lage.zugewandt > 0.98, lage.zugewandt);

  // ── Kneifen auf dem Tablet: tippt beim Loslassen ──────────────
  const kneifen = async (zielFn, { halten = 2, zug = null, schnell = false } = {}) => {
    await seite.evaluate(z => {
      __vp.blick = __vp.quelle('right', 'transient-pointer');
      __vp.zielen(__vp.blick, (0, eval)(`(${z})`)());
      __vp.wechsel([__vp.blick], []);
    }, zielFn.toString());
    if (schnell) {
      // Ein kurzes Kneifen ganz in der Seite: im Software-Rendering kostet ein Bild
      // rund 100 ms, jede Rundreise über DevTools noch einmal so viel — über
      // LANG_KNEIFEN (550 ms) wäre es sonst ein langes.
      const r = await seite.evaluate(() => new Promise(fertig => {
        const s = ILeenVR.renderer.xr.getSession();
        const h = () => ILeenVR.haende.find(x => x.quelle === __vp.blick);
        const ev = (art, frame) => { const e = new Event(art); e.inputSource = __vp.blick; e.frame = frame; s.dispatchEvent(e); };
        let waehrend;
        s.requestAnimationFrame((t, f1) => {
          ev('selectstart', f1);
          const x = h();
          waehrend = { platz: ILeenVR.haende.indexOf(x), transient: x && x.transient, zug: !!(x && x.tabletZug), zielt: !!(x && x.zielt) };
          s.requestAnimationFrame(() => s.requestAnimationFrame((t3, f3) => {
            const ring = __vp.ring();
            const dauer = Math.round(performance.now() - h().seit);
            ev('selectend', f3);
            fertig({ ...waehrend, ring, dauer });
          }));
        });
      }));
      await seite.evaluate(() => __vp.wechsel([], [__vp.blick]));
      await bilder(3);
      return r;
    }
    await seite.evaluate(() => __vp.ereignis('selectstart', __vp.blick));
    const waehrend = await seite.evaluate(() => {
      const h = ILeenVR.haende.find(x => x.quelle === __vp.blick);
      return { platz: ILeenVR.haende.indexOf(h), transient: h && h.transient, zug: !!(h && h.tabletZug), zielt: !!(h && h.zielt) };
    });
    if (zug) {
      for (const schritt of zug) {
        await seite.evaluate(z => __vp.zielen(__vp.blick, (0, eval)(`(${z})`)()), schritt.toString());
        await bilder(2);
      }
    } else if (typeof halten === 'number') {
      await bilder(halten);
    } else {
      await new Promise(r => setTimeout(r, halten.ms));
      await bilder(2);
    }
    const ring = await seite.evaluate(() => __vp.ring());
    const dauer = await seite.evaluate(() => new Promise(fertig => ILeenVR.renderer.xr.getSession().requestAnimationFrame((t, frame) => {
      const h = ILeenVR.haende.find(x => x.quelle === __vp.blick);
      const ms = h ? Math.round(performance.now() - h.seit) : null;
      const e = new Event('selectend');
      e.inputSource = __vp.blick;
      e.frame = frame;
      ILeenVR.renderer.xr.getSession().dispatchEvent(e);
      fertig(ms);
    })));
    await seite.evaluate(() => __vp.wechsel([], [__vp.blick]));
    await bilder(3);
    return { ...waehrend, ring, dauer };
  };

  await seite.evaluate(() => ILeenVR.app.aktionen.seite('hilfe'));
  await bilder(3);
  const reiter = await seite.evaluate(() => __vp.region('reiter:werkzeuge'));
  pruefe('Reiter „Werkzeuge" gezeichnet', !!reiter, JSON.stringify(reiter));
  const k1 = await kneifen(`() => __vp.tabletPunkt(${reiter[0]}, ${reiter[1]})`);
  pruefe('Kneifen bekommt einen eigenen Platz hinter den Händen (Index 2)', k1.platz === 2 && k1.transient, JSON.stringify(k1));
  pruefe('Kneifen auf dem Tablet beginnt einen Zug statt zu zielen', k1.zug && !k1.zielt, JSON.stringify(k1));
  const s1 = await seite.evaluate(() => ({ seite: ILeenVR.tablet.seite, frei: ILeenVR.haende[2].quelle === null }));
  pruefe('Loslassen tippt: Reiter „Werkzeuge" offen', s1.seite === 'werkzeuge', JSON.stringify(s1));
  pruefe('nach dem Kneifen ist der Platz wieder frei', s1.frei);

  // ── Kneifen und ziehen: rollt, tippt nicht ────────────────────
  await bilder(4);
  const vorher = await seite.evaluate(() => ({ scroll: ILeenVR.ui.scroll.get('werkzeuge') || 0, messen: ILeenVR.werkzeug.messen, boden: ILeenVR.werkzeug.bodenFolgen, start: __vp.region('wz:boden') }));
  const [bx, by] = vorher.start;
  const k2 = await kneifen(`() => __vp.tabletPunkt(${bx}, ${by})`, {
    zug: [60, 120, 180, 240].map(d => `() => __vp.tabletPunkt(${bx}, ${by - d})`),
  });
  const nachher = await seite.evaluate(() => ({ scroll: ILeenVR.ui.scroll.get('werkzeuge') || 0, messen: ILeenVR.werkzeug.messen, boden: ILeenVR.werkzeug.bodenFolgen, seite: ILeenVR.tablet.seite }));
  pruefe('Kneifen und nach oben ziehen rollt die Werkzeuge', k2.zug && nachher.scroll > vorher.scroll + 50, `${vorher.scroll} → ${nachher.scroll}`);
  pruefe('… ohne etwas umzuschalten', nachher.boden === vorher.boden && nachher.messen === vorher.messen && nachher.seite === 'werkzeuge', JSON.stringify(nachher));

  // ── Drehen über das Tablet (kein Stick) ───────────────────────
  await seite.evaluate(() => ILeenVR.ui.oben('werkzeuge'));
  await bilder(4);
  const links = await seite.evaluate(() => __vp.region('wz:links'));
  pruefe('Knopf „◀ 30°" auf den Werkzeugen', !!links);
  const g0 = await seite.evaluate(() => new ILeenVR.THREE.Euler().setFromQuaternion(ILeenVR.nutzer.quaternion, 'YXZ').y);
  await kneifen(`() => __vp.tabletPunkt(${links[0]}, ${links[1]})`);
  const g1 = await seite.evaluate(() => new ILeenVR.THREE.Euler().setFromQuaternion(ILeenVR.nutzer.quaternion, 'YXZ').y);
  pruefe('„◀ 30°" dreht um 30° nach links', Math.abs((g1 - g0) - Math.PI / 6) < 1e-6, `${(g0 * 180 / Math.PI).toFixed(2)}° → ${(g1 * 180 / Math.PI).toFixed(2)}°`);

  // ── Hinsehen auf den Boden, kurz kneifen: springen ────────────
  // Weg vom Tablet (es hängt links unten), schräg nach rechts vorn auf den Rasterboden
  const bodenZiel = `() => {
    const V = ILeenVR, T = V.THREE;
    const kopf = V.kamera.getWorldPosition(new T.Vector3());
    const vor = new T.Vector3(0, 0, -1).applyQuaternion(V.kamera.getWorldQuaternion(new T.Quaternion())); vor.y = 0; vor.normalize();
    const rechts = new T.Vector3(-vor.z, 0, vor.x);
    return kopf.clone().addScaledVector(vor, 2.2).addScaledVector(rechts, 0.6).setY(V.nutzer.position.y);
  }`;
  const ziel = await seite.evaluate(z => (0, eval)(`(${z})`)().toArray(), bodenZiel);
  const p0 = await seite.evaluate(() => ILeenVR.nutzer.position.toArray());
  const k3 = await kneifen(bodenZiel, { schnell: true });
  const p1 = await seite.evaluate(() => ILeenVR.nutzer.position.toArray());
  const kopf1 = await seite.evaluate(() => ILeenVR.kamera.getWorldPosition(new ILeenVR.THREE.Vector3()).toArray());
  const daneben = Math.hypot(kopf1[0] - ziel[0], kopf1[2] - ziel[2]);
  const bewegt = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
  if (k3.dauer >= 550) {
    // Ausgelasteter Rechner: drei Bilder dauern über LANG_KNEIFEN. Dann ist es ein langes Kneifen,
    // und so muss es sich auch verhalten — „kurz" bleibt diesmal ungeprüft.
    console.log(`  Hinweis: das kurze Kneifen dauerte ${k3.dauer} ms (Rechner ausgelastet) — „kurz" nicht prüfbar, es gilt als lang`);
    pruefe('… als langes gewertet: kein Ring, kein Sprung', !k3.ring && bewegt < 1e-6, JSON.stringify(k3));
  } else {
    pruefe('kurzes Kneifen zielt (Landeplatz-Ring sichtbar)', k3.zielt && k3.ring, JSON.stringify(k3));
    pruefe('… und springt dorthin', bewegt > 1.5 && daneben < 0.3,
      `bewegt ${bewegt.toFixed(2)} m, Kopf ${daneben.toFixed(2)} m neben dem Ziel, ${JSON.stringify(k3)}`);
  }

  // ── lange kneifen: Info statt Sprung ──────────────────────────
  const k4 = await kneifen(bodenZiel, { halten: { ms: 800 } });
  const p2 = await seite.evaluate(() => ILeenVR.nutzer.position.toArray());
  pruefe('lange gekniffen: kein Landeplatz-Ring', !k4.ring, JSON.stringify(k4));
  pruefe('… und kein Sprung', Math.hypot(p2[0] - p1[0], p2[2] - p1[2]) < 1e-6, JSON.stringify([p1, p2]));

  // ── Ein Controller kommt dazu: er trägt das Tablet wieder ────
  await seite.evaluate(() => { __brille.controllers.left.connected = true; });
  await bilder(6);
  const t1 = await seite.evaluate(() => ({
    hand: ILeenVR.haende.find(h => h.griff === ILeenVR.tabletMesh.parent)?.quelle?.handedness || null,
    groesse: ILeenVR.tabletMesh.scale.x, steuerung: ILeenVR.app.steuerung,
  }));
  pruefe('linker Controller verbunden: Tablet an der linken Hand, Originalgröße', t1.hand === 'left' && t1.groesse === 1 && t1.steuerung === 'controller', JSON.stringify(t1));

  // Quest-Weg daneben: der rechte Controller zeigt aufs Tablet und tippt mit dem Abzug
  // (zeigerHand und hand.zeigt sind für die Vision Pro umgebaut — hier darf sich nichts ändern)
  await seite.evaluate(() => {
    __brille.controllers.right.connected = true;
    const l = __brille.controllers.left;
    l.position.set(-0.12, 1.15, -0.35);
    l.quaternion.set(0, 0, 0, 1);
    __brille.controllers.right.position.set(0.18, 1.45, -0.05);
    ILeenVR.app.aktionen.seite('karte');
  });
  await bilder(6);
  const hilfeReiter = await seite.evaluate(() => __vp.region('reiter:hilfe'));
  for (let i = 0; i < 4; i++) {
    await seite.evaluate(([px, py]) => {
      const V = ILeenVR;
      const T = V.THREE;
      const zielW = __vp.tabletPunkt(px, py);
      const hand = V.haende.find(x => x.quelle && x.quelle.handedness === 'right' && x.quelle.gamepad);
      const von = hand.strahl.getWorldPosition(new T.Vector3());
      const zuNutzer = V.nutzer.getWorldQuaternion(new T.Quaternion()).invert();
      const soll = zielW.sub(von).normalize().applyQuaternion(zuNutzer);
      const ist = new T.Vector3(0, 0, -1).applyQuaternion(hand.strahl.getWorldQuaternion(new T.Quaternion())).applyQuaternion(zuNutzer);
      const c = __brille.controllers.right;
      const neu = new T.Quaternion().setFromUnitVectors(ist, soll).multiply(new T.Quaternion(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w));
      c.quaternion.set(neu.x, neu.y, neu.z, neu.w);
    }, hilfeReiter);
    await bilder(3);
  }
  const quest = await seite.evaluate(() => {
    const h = ILeenVR.haende.find(x => x.quelle && x.quelle.handedness === 'right' && x.quelle.gamepad);
    return { auf: h && h.aufTablet, zeigt: h && h.zeigt, linie: h && h.linie.visible, hover: ILeenVR.ui.hoverId };
  });
  pruefe('Quest: rechter Strahl sichtbar und auf dem Tablet', quest.zeigt && quest.linie && !!quest.auf, JSON.stringify(quest));
  await seite.evaluate(() => __brille.controllers.right.updateButtonValue('trigger', 1));
  await bilder(3);
  await seite.evaluate(() => __brille.controllers.right.updateButtonValue('trigger', 0));
  await bilder(3);
  pruefe('Quest: Abzug tippt sofort (Reiter „Hilfe")', await seite.evaluate(() => ILeenVR.tablet.seite) === 'hilfe');
  await seite.evaluate(() => { __brille.controllers.right.connected = false; });

  await seite.evaluate(() => { __brille.controllers.left.connected = false; });
  await bilder(6);
  const t2 = await seite.evaluate(() => ({ schwebt: ILeenVR.tabletMesh.parent === ILeenVR.nutzer, sichtbar: ILeenVR.tabletMesh.visible }));
  pruefe('Controller wieder weg: Tablet schwebt wieder', t2.schwebt && t2.sichtbar, JSON.stringify(t2));

  // ── Kalibrieren mit Kneifen (Gruppe, vr-gemeinsam.js) ─────────
  // Gemessen wird am Kneifpunkt (gripSpace: wo Daumen und Zeigefinger sich
  // treffen), nicht am Strahl — der beginnt bei der Vision Pro am Auge.
  const marke = async (p, { frueh = false } = {}) => {
    await seite.evaluate(p => {
      const V = ILeenVR;
      const T = V.THREE;
      __vp.blick = __vp.quelle('right', 'transient-pointer');
      __vp.blick.gripSpace[__iwer.P_SPACE].offsetMatrix.set(new T.Matrix4().makeTranslation(...p).elements);
      V.nutzer.updateWorldMatrix(true, false);
      __vp.zielen(__vp.blick, V.nutzer.localToWorld(new T.Vector3(...p)));
      __vp.wechsel([__vp.blick], []);
    }, p);
    await seite.evaluate(() => __vp.ereignis('selectstart', __vp.blick));
    await bilder(2);
    const waehrend = await seite.evaluate(() => {
      const g = ILeenVR.gemeinsam.zustand;
      const h = ILeenVR.haende.find(x => x.quelle === __vp.blick);
      const kugel = o => o.children.some(c => c.isMesh && c.visible && c.geometry.type === 'SphereGeometry');
      return {
        probe: !!(g.messen && g.messen.probe), art: g.messen && g.messen.probe ? g.messen.probe.art : null,
        gefangen: !!(h && h.gefangen), zielt: !!(h && h.zielt),
        kneifPunkt: !!h && kugel(h.griff), augenPunkt: !!h && kugel(h.strahl),
      };
    });
    if (!frueh) await seite.waitForFunction(() => !(ILeenVR.gemeinsam.zustand.messen || {}).probe, { timeout: 30000, polling: 200 }).catch(() => {});
    await seite.evaluate(() => __vp.ereignis('selectend', __vp.blick));
    await seite.evaluate(() => __vp.wechsel([], [__vp.blick]));
    await bilder(3);
    const nachher = await seite.evaluate(() => {
      const g = ILeenVR.gemeinsam.zustand;
      return { punkte: g.messen ? g.messen.punkte : null, meldung: g.messen ? g.messen.meldung : '', kalib: g.kalib ? { abstand: g.kalib.abstand } : null };
    });
    return { waehrend, nachher };
  };
  await seite.evaluate(() => { ILeenVR.app.aktionen.seite('gemeinsam'); ILeenVR.app.aktionen.gmKalibrieren(); });
  await bilder(2);
  pruefe('Gruppe › Kalibrieren läuft', await seite.evaluate(() => !!ILeenVR.gemeinsam.zustand.messen));
  const P1 = [0.4, 0.02, -0.9];
  const P2 = [2.4, 0.02, -0.9];
  const m0 = await marke(P1, { frueh: true });
  pruefe('Kneifen auf der Marke misst (Art „kneifen") statt zu zielen', m0.waehrend.probe && m0.waehrend.art === 'kneifen' && m0.waehrend.gefangen && !m0.waehrend.zielt, JSON.stringify(m0.waehrend));
  pruefe('… der weiße Punkt sitzt am Kneifpunkt, nicht am Auge', m0.waehrend.kneifPunkt && !m0.waehrend.augenPunkt, JSON.stringify(m0.waehrend));
  pruefe('zu früh losgelassen: keine Marke, Hinweis im Tablet', m0.nachher.punkte && m0.nachher.punkte.length === 0 && /zu früh/i.test(m0.nachher.meldung), JSON.stringify(m0.nachher));
  const m1 = await marke(P1);
  const d1 = m1.nachher.punkte && m1.nachher.punkte[0] ? Math.hypot(...m1.nachher.punkte[0].map((x, i) => x - P1[i])) : null;
  pruefe('gehalten: Marke 1 liegt am Kneifpunkt', d1 !== null && d1 < 1e-3, `Abstand ${d1} · ${JSON.stringify(m1.nachher)}`);
  const m2 = await marke(P2);
  pruefe('Marke 2: kalibriert, Marken 2,00 m auseinander', !!m2.nachher.kalib && Math.abs(m2.nachher.kalib.abstand - 2) < 0.01, JSON.stringify(m2.nachher));

  // ── Die anderen sehen, wohin sie kneift ───────────────────────
  // Der Strahl geht als z[rechts] mit, vom Auge zum Ziel (im Modellrahmen)
  if (await seite.evaluate(() => Array.isArray(window.__posen) && __posen.length > 0)) {
    await seite.evaluate(() => {
      const V = ILeenVR;
      const T = V.THREE;
      __vp.blick = __vp.quelle('right', 'transient-pointer');
      __vp.blick.gripSpace[__iwer.P_SPACE].offsetMatrix.set(new T.Matrix4().makeTranslation(0.25, 1.1, -0.35).elements);
      V.nutzer.updateWorldMatrix(true, false);
      __vp.zielen(__vp.blick, V.nutzer.localToWorld(new T.Vector3(0.5, 0, -2.5)));
      __vp.wechsel([__vp.blick], []);
      __posen.length = 0;
    });
    await seite.evaluate(() => __vp.ereignis('selectstart', __vp.blick));
    await bilder(5);
    const strahl = await seite.evaluate(() => {
      const V = ILeenVR;
      const T = V.THREE;
      const p = [...__posen].reverse().find(n => n.z && n.z[1]);
      V.modell.updateWorldMatrix(true, false);
      const auge = V.modell.worldToLocal(V.kamera.getWorldPosition(new T.Vector3()));
      return p ? { z: p.z[1], h: !!(p.h && p.h[1]), vomAuge: Math.hypot(p.z[1][0] - auge.x, p.z[1][1] - auge.y, p.z[1][2] - auge.z) } : null;
    });
    // Ohne selectend: nicht springen, nur loslassen
    await seite.evaluate(() => __vp.wechsel([], [__vp.blick]));
    await bilder(3);
    pruefe('Kneifen: Strahl geht an die anderen (rechte Seite)', !!strahl, JSON.stringify(strahl));
    pruefe('… er beginnt am Auge', !!strahl && strahl.vomAuge < 0.05, JSON.stringify(strahl));
  } else {
    console.log('  (Hinweis: keine Verbindung zum Relais — Strahl an die anderen nicht geprüft; mit VIEWER_URL=https://127.0.0.1:5443/)');
  }

  // ── Ende ──────────────────────────────────────────────────────
  await seite.evaluate(() => ILeenVR.renderer.xr.getSession().end());
  await seite.waitForFunction(() => !ILeenVR.renderer.xr.isPresenting, { timeout: 10000 }).catch(() => {});
  const ende = await seite.evaluate(() => ({ parent: !!ILeenVR.tabletMesh.parent, sichtbar: ILeenVR.tabletMesh.visible }));
  pruefe('nach der Sitzung: Tablet abgehängt und unsichtbar', !ende.parent && !ende.sichtbar, JSON.stringify(ende));

  const echte = konsole.filter(t => !/iwer|IWER/.test(t));
  pruefe('keine Fehler in der Konsole', echte.length === 0, echte.slice(0, 5).join('\n      '));
} finally {
  await browser.close();
}

console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
