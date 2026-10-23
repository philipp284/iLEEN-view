// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Gemeinsam in der Brille — mehrere Quests (und iLEEN am Mac) im selben Modell.
//
// Wer joint, sieht die anderen: Kopf, beide Controller, Namen, und solange
// jemand den Abzug hält, seinen Zeigestrahl. Damit Avatar und Mensch an
// derselben Stelle stehen, messen alle Brillen im Raum dieselben zwei Marken
// (Klebeband am Boden, zwei Tischecken) mit der Spitze des Controllers. Daraus
// entsteht ein gemeinsamer Raumrahmen (vr-gemeinsam-rechnen.js erklärt die
// drei Rahmen und rechnet). Danach gilt:
//
//   Mitgehen an   Wer geht, springt, dreht oder das Tischmodell greift, nimmt
//                 alle mit. Die Gruppe teilt die Abbildung Raum → Modell; jede
//                 Brille stellt danach ihren Nutzer (1:1) bzw. ihr Modell (Tisch)
//                 ein. So stehen die Avatare dort, wo die Menschen wirklich
//                 stehen — man sieht sich in VR und läuft nicht ineinander.
//   Mitgehen aus  Jeder geht für sich. Der Avatar steht, wo der andere im
//                 Modell ist; ein blasser „Geist" zeigt, wo er im Raum steht.
//
// Ohne Kalibrierung sieht man die anderen trotzdem — dort, wo sie im Modell
// sind, nur eben nicht deckungsgleich mit dem Raum.
//
// Miteinander: Auswahl (Bauteil leuchtet bei allen in der Farbe dessen, der es
// gewählt hat, mit Schild), Messung, Ansicht (Ebenen, Höhenschnitt — schaltbar),
// das Modell selbst (wer dazukommt, sieht, was die anderen sehen) und „Neben
// jemanden stellen". iLEEN am Mac schaut zu: es sieht die Brillen im Modell,
// und was man dort anklickt, leuchtet in der Brille.
//
// Das Netz: tools/vr-raum.mjs, ein Relais auf dem Mac (siehe dort). Gerechnet
// wird nur hier, in jeder Brille für sich.
//
// Fremde Posen und Gruppenlagen werden 100 ms in der Vergangenheit gezeigt und
// dazwischen gemischt — 20 bis 30 Pakete je Sekunde ruckeln sonst sichtbar, und
// eine ruckelnde Welt macht in der Brille übel.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
import {
  FARBEN, KALIBRIER, VERZOEGERUNG, PROTOKOLL, RAUM_PORT,
  lage, lageGueltig, lageGleich, lageMischen, lageSprung, lageRunden,
  gruppeAus, nutzerAusGruppe, modellAusGruppe,
  stichprobe, stichprobeFehler, kalibrierung, kalibrierVergleich,
  quatGier, poseLage, poseRunden, paketMischen, paketSprung, paketSauber, avatarMassstab, Puffer,
  ansichtSauber, ansichtLeer, raumAdresse, raumName, kennungGueltig, kennungNeu, nameSauber, anzeigeName, runden, drehen,
} from './vr-gemeinsam-rechnen.js';
import { meterText } from './vr-rechnen.js';
import { bauteilNachzeichnen } from './vr-ebenen.js';

const PARAMETER = new URLSearchParams(location.search);
const SPEICHER = 'ileen_vr_gemeinsam';   // Name, Raum, Mitgehen, Ansicht teilen
const KENNUNG = 'ileen_vr_kennung';      // je Tab: zwei Tabs sind zwei Teilnehmer

const TAKT = { xr: 50, vorschau: 200, gruppe: 40 };   // ms zwischen zwei Paketen
const EIGEN = 400;          // ms nach eigener Bewegung, in denen fremde Gruppenlagen warten
const STILL = 3000;         // ms ohne Pose: Avatar aus (Brille abgesetzt, Tab im Hintergrund)
const RUMPF = 0.5;          // m: Mitte des Rumpfs unter dem Kopf
const OBEN = new THREE.Vector3(0, 1, 0);

function lesen() {
  try { return JSON.parse(localStorage.getItem(SPEICHER) || '{}') || {}; } catch { return {}; }
}

function kennungHolen() {
  try {
    let k = sessionStorage.getItem(KENNUNG);
    if (!kennungGueltig(k)) {
      k = kennungNeu();
      sessionStorage.setItem(KENNUNG, k);
    }
    return k;
  } catch {
    return kennungNeu();
  }
}

function lageVon(o) {
  const q = o.quaternion;
  return lage(o.position.x, o.position.y, o.position.z, quatGier([q.x, q.y, q.z, q.w]), o.scale.x);
}

function lageSetzen(o, L, mitMassstab) {
  o.position.set(L.x, L.y, L.z);
  o.quaternion.set(0, Math.sin(L.gier / 2), 0, Math.cos(L.gier / 2));
  if (mitMassstab) o.scale.setScalar(L.s);
  o.updateMatrixWorld(true);
}

function stumm(o) {
  o.traverse(x => { x.raycast = () => {}; });
  return o;
}

/**
 * @param v  aus vr.js: renderer, szene, nutzer, modell, kamera, haende, zustand,
 *           werkzeug, ebenen, ui, tablet, schnittEbenen, status, modellLaden(job, name),
 *           bodenRuhig(), ansichtLesen(), ansichtAnwenden(a)
 */
export function gemeinsamAnlegen(v) {
  const gespeichert = lesen();
  const vorgabe = PARAMETER.get('gemeinsam');   // '0' nie, '1' immer verbinden

  const ich = {
    kennung: kennungHolen(),
    name: nameSauber(gespeichert.name || ''),
    geraet: null,      // 'brille' | 'bildschirm', sobald pruefeXR weiß, was es ist
    id: null, nummer: 0, farbe: 0,
  };

  const g = {
    verbindung: 'aus',  // aus | verbinde | offen | getrennt | keinDienst | ersetzt | voll
    raum: raumName(PARAMETER.get('raum') || gespeichert.raum),
    teilnehmer: new Map(),
    zustand: new Map(),        // Schlüssel → { w, von, seq }
    kalib: null,               // kalibrierung() + { zeit }
    messen: null,              // laufende Kalibrierung { schritt, punkte, probe, meldung }
    mitgehen: gespeichert.mitgehen ?? true,
    ansichtTeilen: gespeichert.ansichtTeilen ?? true,
    folge: new Puffer(24),     // Gruppenlagen der anderen
    eigeneSeq: 0,              // Nummer meiner letzten Gruppenlage (Echo vom Relais)
    eigenBis: 0,
    gesetzt: null,             // was ich zuletzt am Nutzer/Modell gesehen oder gesetzt habe
    gesendet: null,
    gesendetUm: 0,
    fuehrt: null,              // wer zuletzt die Gruppe bewegt hat
    poseUm: 0,
    letztePose: null,
    modellOffen: null,         // vor der Verbindung geladenes Modell, noch nicht gemeldet
    eigeneAuswahl: null,
    eigeneMessung: null,
    ansichtStumm: false,
    gedrosselt: new Map(),
  };

  let ws = null;
  let versuch = 0;
  let wiederUhr = null;
  let infoUhr = null;
  let sofortWieder = false;

  // ─────────────────────────────────────────────────────────────────
  // SZENE: Avatare, Geister, Marken, Hinweistafel
  // ─────────────────────────────────────────────────────────────────

  const weltGruppe = new THREE.Group();          // Avatare, Strahlen: in Weltkoordinaten
  weltGruppe.name = 'gemeinsam';
  v.szene.add(weltGruppe);
  const modellGruppe = new THREE.Group();        // Schilder und Messungen: wandern mit dem Modell
  modellGruppe.name = 'gemeinsamImModell';
  v.modell.add(modellGruppe);
  const markenGruppe = new THREE.Group();        // Kalibriermarken: physisch, hängen am Nutzer
  markenGruppe.name = 'kalibriermarken';
  v.nutzer.add(markenGruppe);

  const geo = {
    schaedel: new THREE.SphereGeometry(0.095, 24, 16),
    brille: new THREE.BoxGeometry(0.17, 0.075, 0.07),
    rumpf: new THREE.CapsuleGeometry(0.16, 0.38, 6, 16),
    hand: new THREE.BoxGeometry(0.045, 0.04, 0.115),
    ring: new THREE.TorusGeometry(0.038, 0.006, 8, 24),
    kugel: new THREE.SphereGeometry(1, 16, 12),
    // Kamera am Bildschirm: Pyramide mit der Spitze am Auge, offen nach vorn (−z)
    kamera: new THREE.ConeGeometry(0.13, 0.24, 4, 1, true).translate(0, -0.12, 0).rotateX(Math.PI / 2).rotateZ(Math.PI / 4),
  };
  const dunkel = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.25, metalness: 0.3 });

  function schildBauen() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const textur = new THREE.CanvasTexture(canvas);
    textur.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: textur, depthTest: false, transparent: true, toneMapped: false, fog: false }));
    sprite.renderOrder = 16;
    sprite.raycast = () => {};
    return { sprite, canvas, ctx: canvas.getContext('2d'), textur, text: null };
  }

  function schildSchreiben(s, oben, unten, farbe) {
    const text = `${oben}|${unten}|${farbe}`;
    if (s.text === text) return;
    s.text = text;
    const { ctx, canvas } = s;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(18, 18, 18, 0.88)';
    ctx.beginPath();
    ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 26);
    ctx.fill();
    ctx.fillStyle = farbe;
    ctx.fillRect(14, 20, 12, canvas.height - 40);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${unten ? 46 : 52}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.fillText(kuerzen(ctx, oben, 450), 44, unten ? 44 : 64);
    if (unten) {
      ctx.fillStyle = '#b8b8b8';
      ctx.font = '32px "Helvetica Neue", Helvetica, Arial, sans-serif';
      ctx.fillText(kuerzen(ctx, unten, 450), 44, 94);
    }
    s.textur.needsUpdate = true;
  }

  function kuerzen(ctx, text, breite) {
    let t = String(text);
    while (t.length > 1 && ctx.measureText(t).width > breite) t = t.slice(0, -2) + '…';
    return t;
  }

  /** Der Avatar eines Teilnehmers: Kopf mit Brille (oder Kamera), Rumpf, Hände, Strahlen, Schild. */
  function figurBauen(t) {
    const farbe = FARBEN[t.farbe] || FARBEN[0];
    const stoff = new THREE.MeshStandardMaterial({ color: farbe, roughness: 0.55, metalness: 0.05 });
    const glas = new THREE.MeshStandardMaterial({ color: farbe, transparent: true, opacity: 0.32, roughness: 0.8, depthWrite: false });
    const gruppe = new THREE.Group();
    const kopf = new THREE.Group();
    let rumpf = null;
    if (t.geraet === 'bildschirm') {
      const kegel = new THREE.Mesh(geo.kamera, new THREE.MeshBasicMaterial({ color: farbe, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
      const kanten = new THREE.LineSegments(new THREE.EdgesGeometry(geo.kamera), new THREE.LineBasicMaterial({ color: farbe }));
      kopf.add(kegel, kanten, new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), stoff));
    } else {
      const brille = new THREE.Mesh(geo.brille, dunkel);
      brille.position.set(0, 0.005, -0.075);
      kopf.add(new THREE.Mesh(geo.schaedel, stoff), brille);
      rumpf = new THREE.Mesh(geo.rumpf, glas);
      gruppe.add(rumpf);
    }
    const haende = [0, 1].map(() => {
      const h = new THREE.Group();
      const griff = new THREE.Mesh(geo.hand, stoff);
      griff.position.set(0, -0.01, 0.02);
      const ring = new THREE.Mesh(geo.ring, dunkel);
      ring.position.set(0, 0.01, -0.045);
      h.add(griff, ring);
      return h;
    });
    const strahlen = [0, 1].map(() => {
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
      const linie = new THREE.Line(g2, new THREE.LineBasicMaterial({ color: farbe, toneMapped: false, fog: false }));
      linie.frustumCulled = false;
      const punkt = new THREE.Mesh(geo.kugel, new THREE.MeshBasicMaterial({ color: farbe, toneMapped: false, fog: false }));
      punkt.scale.setScalar(0.03);
      const s = new THREE.Group();
      s.add(linie, punkt);
      return { gruppe: s, linie, punkt };
    });
    const schild = schildBauen();
    gruppe.add(kopf, ...haende, ...strahlen.map(s => s.gruppe), schild.sprite);
    weltGruppe.add(stumm(gruppe));
    return { gruppe, kopf, rumpf, haende, strahlen, schild };
  }

  /** Der Geist: wo der andere wirklich im Raum steht — blass, ohne Rumpf. */
  function geistBauen(t) {
    const farbe = FARBEN[t.farbe] || FARBEN[0];
    const stoff = new THREE.MeshBasicMaterial({ color: farbe, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false, fog: false });
    const gruppe = new THREE.Group();
    const kopf = new THREE.Group();
    const brille = new THREE.Mesh(geo.brille, stoff);
    brille.position.set(0, 0.005, -0.075);
    kopf.add(new THREE.Mesh(geo.schaedel, stoff), brille);
    const haende = [0, 1].map(() => new THREE.Mesh(geo.hand, stoff));
    const schild = schildBauen();
    gruppe.add(kopf, ...haende, schild.sprite);
    weltGruppe.add(stumm(gruppe));
    return { gruppe, kopf, haende, schild };
  }

  const geteilt = new Set(Object.values(geo));
  function wegwerfen(teil) {
    if (!teil) return;
    teil.gruppe.removeFromParent();
    teil.gruppe.traverse(o => {
      if (o.geometry && !geteilt.has(o.geometry)) o.geometry.dispose();
      if (o.material && o.material !== dunkel) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }

  // Kalibriermarken und die Messspitzen an den Controllern
  const markeStoff = new THREE.MeshBasicMaterial({ color: 0x97bf0d, toneMapped: false, fog: false, depthTest: false, transparent: true });
  const marken = [0, 1].map(i => {
    const m = new THREE.Group();
    const kugel = new THREE.Mesh(geo.kugel, markeStoff);
    kugel.scale.setScalar(0.012);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.004, 8, 40), markeStoff);
    ring.rotation.x = Math.PI / 2;
    const schild = schildBauen();
    schildSchreiben(schild, `Marke ${i + 1}`, '', '#97bf0d');
    schild.sprite.position.y = 0.09;
    schild.sprite.scale.set(0.2, 0.05, 1);
    m.add(kugel, ring, schild.sprite);
    m.visible = false;
    markenGruppe.add(stumm(m));
    return m;
  });
  let markenBis = 0;

  const spitzenStoff = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false, depthTest: false, transparent: true });
  const spitzen = v.haende.map(h => {
    const s = new THREE.Mesh(geo.kugel, spitzenStoff);
    s.scale.setScalar(0.008);
    s.renderOrder = 22;
    s.visible = false;
    stumm(s);
    h.strahl.add(s);
    return s;
  });

  // Hinweistafel: kurz vor dem Gesicht, verblasst von selbst
  const tafel = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 128;
    const textur = new THREE.CanvasTexture(canvas);
    textur.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.09),
      new THREE.MeshBasicMaterial({ map: textur, transparent: true, depthTest: false, toneMapped: false, fog: false }));
    mesh.renderOrder = 30;
    mesh.visible = false;
    mesh.raycast = () => {};
    v.szene.add(mesh);
    return { mesh, canvas, ctx: canvas.getContext('2d'), textur, bis: 0 };
  })();

  // ─────────────────────────────────────────────────────────────────
  // HINWEISE
  // ─────────────────────────────────────────────────────────────────

  function hinweis(text, farbe = '#97bf0d') {
    if (!v.renderer.xr.isPresenting) { v.status(text); return; }
    const { ctx, canvas } = tafel;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(18, 18, 18, 0.9)';
    ctx.beginPath();
    ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 30);
    ctx.fill();
    ctx.fillStyle = farbe;
    ctx.fillRect(18, 22, 10, canvas.height - 44);
    ctx.fillStyle = '#ffffff';
    ctx.font = '500 44px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(kuerzen(ctx, text, canvas.width - 80), 50, canvas.height / 2 + 2);
    tafel.textur.needsUpdate = true;
    const kopf = v.kamera.getWorldPosition(new THREE.Vector3());
    const blick = new THREE.Vector3(0, 0, -1).applyQuaternion(v.kamera.getWorldQuaternion(new THREE.Quaternion()));
    blick.y = 0;
    if (blick.lengthSq() < 1e-6) blick.set(0, 0, -1);
    blick.normalize();
    tafel.mesh.position.copy(kopf).addScaledVector(blick, 1.1);
    tafel.mesh.position.y -= 0.3;
    tafel.mesh.lookAt(kopf);
    tafel.mesh.material.opacity = 1;
    tafel.mesh.visible = true;
    tafel.bis = performance.now() + 3200;
  }

  /** Höchstens einmal je `ms` dieselbe Art Hinweis — Ansicht und Gruppe ändern sich in Schüben. */
  function hinweisGedrosselt(art, text, ms = 4000) {
    const jetzt = performance.now();
    if (jetzt - (g.gedrosselt.get(art) || -Infinity) < ms) return;
    g.gedrosselt.set(art, jetzt);
    hinweis(text);
  }

  function hinweisBild(jetzt) {
    if (!tafel.mesh.visible) return;
    const rest = tafel.bis - jetzt;
    if (rest <= 0) { tafel.mesh.visible = false; return; }
    tafel.mesh.material.opacity = Math.min(1, rest / 400);
  }

  // ─────────────────────────────────────────────────────────────────
  // VERBINDUNG
  // ─────────────────────────────────────────────────────────────────

  function adresse() {
    return raumAdresse({
      protokoll: location.protocol, host: location.host, hostname: location.hostname,
      port: Number((window.ILEEN_CONFIG && window.ILEEN_CONFIG.vrRaumPort) || RAUM_PORT),
      vorgabe: PARAMETER.get('raum-adresse'),
    });
  }

  /** Von selbst verbinden? Über https (die Brille) ja; am Mac erst, wenn man den Reiter öffnet. */
  function vonSelbst() {
    if (vorgabe === '0') return false;
    if (vorgabe === '1' || location.protocol === 'https:') return true;
    return !!gespeichert.amBildschirm || v.tablet.seite === 'gemeinsam';
  }

  function verbunden() {
    return !!ws && ws.readyState === 1 && !!ich.id;
  }

  function verbinden() {
    clearTimeout(wiederUhr);
    if (ws || !ich.geraet || vorgabe === '0') return;
    const ziel = adresse();
    if (!ziel) { g.verbindung = 'keinDienst'; v.ui.schmutzig = true; return; }
    g.verbindung = 'verbinde';
    v.ui.schmutzig = true;
    let s;
    try { s = new WebSocket(ziel); } catch { spaeter(); return; }
    ws = s;
    s.onopen = () => {
      s.send(JSON.stringify({ t: 'hallo', v: PROTOKOLL, raum: g.raum, kennung: ich.kennung, name: ich.name, geraet: ich.geraet }));
    };
    s.onmessage = e => {
      let n;
      try { n = JSON.parse(e.data); } catch { return; }
      if (n && typeof n.t === 'string') empfangen(n);
    };
    s.onclose = e => {
      if (ws !== s) return;
      ws = null;
      ich.id = null;
      for (const t of g.teilnehmer.values()) teilnehmerRaeumen(t);
      g.teilnehmer.clear();
      v.ui.schmutzig = true;
      if (e.code === 4000) { g.verbindung = 'ersetzt'; return; }
      if (e.code === 4001) { g.verbindung = 'voll'; versuch = 4; }
      if (sofortWieder) { sofortWieder = false; verbinden(); return; }
      spaeter();
    };
    s.onerror = () => {};
  }

  function spaeter() {
    if (g.verbindung !== 'voll') g.verbindung = 'getrennt';
    v.ui.schmutzig = true;
    const warte = Math.min(30000, 2000 * 2 ** versuch++);
    wiederUhr = setTimeout(verbinden, warte);
  }

  function senden(n) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(n));
  }

  function zustandSenden(k, w) {
    if (verbunden()) senden({ t: 'zustand', k, w });
  }

  function speichern() {
    try {
      localStorage.setItem(SPEICHER, JSON.stringify({
        name: ich.name, raum: g.raum, mitgehen: g.mitgehen, ansichtTeilen: g.ansichtTeilen, amBildschirm: gespeichert.amBildschirm,
      }));
    } catch { /* privates Fenster */ }
  }

  /** Meine Angaben für die anderen — gebündelt, sie ändern sich oft in Schüben. */
  function infoMelden() {
    clearTimeout(infoUhr);
    infoUhr = setTimeout(() => {
      if (!verbunden()) return;
      const k = g.kalib;
      senden({
        t: 'ich', name: ich.name,
        info: {
          modus: v.zustand.modus, job: v.zustand.job, modell: v.zustand.name,
          kalibriert: !!k, abstand: k ? runden(k.abstand, 4) : null, hoehe: k ? runden(k.hoehe, 3) : null,
          mitgehen: g.mitgehen, auswahl: g.eigeneAuswahl, messung: g.eigeneMessung,
        },
      });
    }, 60);
  }

  // ─────────────────────────────────────────────────────────────────
  // EMPFANGEN
  // ─────────────────────────────────────────────────────────────────

  function empfangen(n) {
    switch (n.t) {
      case 'willkommen': willkommen(n); break;
      case 'wer': if (n.teilnehmer && n.teilnehmer.id !== ich.id) teilnehmerSetzen(n.teilnehmer); break;
      case 'weg': teilnehmerWeg(n.id); break;
      case 'pose': poseEmpfangen(n); break;
      case 'zustand': zustandEmpfangen(n); break;
      case 'ereignis': if (n.art === 'hinweis' && typeof n.text === 'string') hinweis(`${nameVon(n.von)}: ${n.text.slice(0, 80)}`); break;
      case 'fehler': if (typeof n.text === 'string') v.status(n.text, 'fehler'); break;
      default: break;
    }
  }

  function willkommen(n) {
    ich.id = n.id;
    ich.nummer = n.nummer;
    ich.farbe = n.farbe;
    g.raum = n.raum;
    g.verbindung = 'offen';
    versuch = 0;
    if (location.protocol !== 'https:' && !gespeichert.amBildschirm) {
      gespeichert.amBildschirm = true;
      speichern();
    }
    for (const t of g.teilnehmer.values()) teilnehmerRaeumen(t);
    g.teilnehmer.clear();
    g.zustand = new Map(Object.entries(n.zustand || {}));
    for (const rec of n.teilnehmer || []) teilnehmerSetzen(rec, true);
    infoMelden();

    // Das Modell: wer zuerst da war, bestimmt; wer dazukommt, folgt
    const R = raumModell();
    if (g.modellOffen) {
      if (!R || !andereIm(R.job)) zustandSenden('modell', g.modellOffen);
      g.modellOffen = null;
    }
    if (R && !v.zustand.job && !v.renderer.xr.isPresenting && andereIm(R.job)) v.modellLaden(R.job, R.name);
    ansichtBeitreten();
    if (g.kalib && g.mitgehen) gruppeBeitreten();
    v.ui.schmutzig = true;
  }

  function teilnehmerSetzen(rec, still = false) {
    let t = g.teilnehmer.get(rec.id);
    const neu = !t;
    if (neu) {
      t = {
        id: rec.id, posen: new Puffer(12), ankunft: 0, figur: null, geist: null,
        auswahlNetze: [], auswahlSchild: null, auswahlSchluessel: '', auswahlStoff: null,
        messung: null, messungSchluessel: '',
      };
      g.teilnehmer.set(rec.id, t);
    }
    const alteFarbe = t.farbe;
    Object.assign(t, { nummer: rec.nummer, farbe: rec.farbe, name: nameSauber(rec.name || ''), geraet: rec.geraet, info: rec.info || {} });
    if (!neu && alteFarbe !== t.farbe) { wegwerfen(t.figur); wegwerfen(t.geist); t.figur = null; t.geist = null; }
    anhaengeAktualisieren(t);
    if (neu && !still) hinweis(`${anzeigeName(t)} ist dazugekommen`, FARBEN[t.farbe]);
    v.ui.schmutzig = true;
  }

  function teilnehmerRaeumen(t) {
    wegwerfen(t.figur);
    wegwerfen(t.geist);
    t.figur = null;
    t.geist = null;
    auswahlWeg(t);
    messungWeg(t);
  }

  function teilnehmerWeg(id) {
    const t = g.teilnehmer.get(id);
    if (!t) return;
    teilnehmerRaeumen(t);
    if (t.auswahlStoff) t.auswahlStoff.dispose();
    g.teilnehmer.delete(id);
    hinweis(`${anzeigeName(t)} ist gegangen`, FARBEN[t.farbe]);
    v.ui.schmutzig = true;
  }

  function nameVon(id) {
    if (id === ich.id) return 'Du';
    const t = g.teilnehmer.get(id);
    return t ? anzeigeName(t) : 'Jemand';
  }

  function poseEmpfangen(n) {
    const t = g.teilnehmer.get(n.von);
    const p = paketSauber(n);
    if (!t || !p) return;
    t.ankunft = performance.now();
    t.posen.neu(t.ankunft, p);
  }

  function zustandEmpfangen(n) {
    const alt = g.zustand.get(n.k);
    if (alt && alt.seq >= n.seq) return;
    g.zustand.set(n.k, { w: n.w, von: n.von, seq: n.seq });

    if (n.k.startsWith('gruppe:')) {
      if (n.von === ich.id) {
        g.eigeneSeq = Math.max(g.eigeneSeq, n.seq);
        g.folge.abSeq(n.seq);
        return;
      }
      const w = n.w;
      if (n.k !== `gruppe:${v.zustand.modus}` || !w || w.job !== v.zustand.job || !lageGueltig(w) || n.seq <= g.eigeneSeq) return;
      g.folge.neu(performance.now(), lage(w.x, w.y, w.z, w.gier, w.s), n.seq);
      g.fuehrt = n.von;
      return;
    }
    if (n.k === 'ansicht') {
      if (n.von === ich.id || !g.ansichtTeilen || !n.w || n.w.job !== v.zustand.job) return;
      ansichtUebernehmen(n.w);
      hinweisGedrosselt('ansicht', `${nameVon(n.von)} hat Ebenen oder Schnitt geändert`);
      return;
    }
    if (n.k === 'modell') {
      if (n.von === ich.id || !n.w || !n.w.job || n.w.job === v.zustand.job) { v.ui.schmutzig = true; return; }
      if (!v.zustand.job && !v.renderer.xr.isPresenting) { v.modellLaden(n.w.job, n.w.name); return; }
      hinweis(`${nameVon(n.von)} zeigt jetzt ${n.w.name || 'ein anderes Modell'} — Tablet › Gruppe`);
      v.ui.schmutzig = true;
    }
  }

  function raumModell() {
    const z = g.zustand.get('modell');
    return z && z.w && typeof z.w.job === 'string' ? { job: z.w.job, name: String(z.w.name || z.w.job) } : null;
  }

  function andereIm(job) {
    for (const t of g.teilnehmer.values()) if (t.info && t.info.job === job) return true;
    return false;
  }

  // ─────────────────────────────────────────────────────────────────
  // KALIBRIERUNG
  // ─────────────────────────────────────────────────────────────────

  function kalibrierenStarten() {
    if (!v.renderer.xr.isPresenting) return;
    g.messen = { schritt: 1, punkte: [], probe: null, meldung: '' };
    for (const m of marken) m.visible = false;
    markenBis = 0;
    v.ui.schmutzig = true;
  }

  function kalibrierenAbbrechen() {
    g.messen = null;
    for (const m of marken) m.visible = false;
    for (const s of spitzen) s.visible = false;
    v.ui.schmutzig = true;
  }

  /**
   * Der Abzug misst, solange kalibriert wird. Nur ein Controller: seine Spitze
   * ist ein fester Punkt (eine Hand oder der Blick der Vision Pro sind keiner).
   * Aufs Tablet tippt er weiter — das prüft vr.js vorher, sonst gäbe es kein Abbrechen.
   */
  function abzugFangen(hand) {
    if (!g.messen || g.messen.probe || !v.renderer.xr.isPresenting || !istController(hand)) return false;
    g.messen.probe = { hand, start: performance.now(), proben: [] };
    g.messen.meldung = '';
    hand.gefangen = true;
    v.ui.schmutzig = true;
    return true;
  }

  function messenBild(jetzt) {
    const m = g.messen;
    for (const s of spitzen) s.visible = !!m;
    if (!m && markenBis && jetzt > markenBis) {
      for (const mk of marken) mk.visible = false;
      markenBis = 0;
    }
    if (!m || !m.probe) return;
    const p = m.probe;
    if (!p.hand.quelle) { m.probe = null; m.meldung = 'Controller verloren — noch einmal'; v.ui.schmutzig = true; return; }
    p.proben.push(p.hand.strahl.position.toArray());
    const dauer = jetzt - p.start;
    const i = v.haende.indexOf(p.hand);
    if (spitzen[i]) spitzen[i].scale.setScalar(0.008 + 0.01 * Math.min(1, dauer / KALIBRIER.dauer));
    // Fertig, sobald die Zeit um ist und genug Proben da sind. In der Brille
    // sind das 36 Bilder in 0,5 s; ein langsames Gerät darf bis 8 s sammeln.
    if ((dauer < KALIBRIER.dauer || p.proben.length < KALIBRIER.mindestProben) && dauer < 8000) return;
    m.probe = null;
    if (spitzen[i]) spitzen[i].scale.setScalar(0.008);
    v.ui.schmutzig = true;
    const s = stichprobe(p.proben);
    const fehlerArt = stichprobeFehler(s);
    if (fehlerArt) {
      m.meldung = fehlerArt === 'unruhig'
        ? `Zu unruhig (${Math.round(s.unruhe * 1000)} mm) — die Spitze auf der Marke still halten`
        : 'Zu kurz gemessen — Abzug drücken und einen Moment halten';
      return;
    }
    m.punkte.push(s.mitte);
    marken[m.punkte.length - 1].position.fromArray(s.mitte);
    marken[m.punkte.length - 1].visible = true;
    if (m.punkte.length === 1) { m.schritt = 2; return; }
    const k = kalibrierung(m.punkte[0], m.punkte[1]);
    if (k.fehler) {
      m.punkte.pop();
      marken[1].visible = false;
      m.meldung = `Die Marken liegen nur ${meterText(k.abstand)} auseinander — mindestens 0,8 m, besser 2 bis 4 m`;
      return;
    }
    g.kalib = { ...k, zeit: Date.now() };
    g.messen = null;
    markenBis = jetzt + 6000;
    infoMelden();
    const vg = vergleich();
    if (vg && !vg.passt) hinweis(`Kalibriert, aber ${vg.name} misst ${Math.round(vg.abstand * 100)} cm anders — gleiche Marken?`, '#e05c5c');
    else hinweis(`Kalibriert — Marken ${meterText(k.abstand)} auseinander`);
    if (g.mitgehen) gruppeBeitreten();
  }

  function vergleich() {
    if (!g.kalib) return null;
    const andere = [...g.teilnehmer.values()]
      .filter(t => t.info && t.info.kalibriert)
      .map(t => ({ name: anzeigeName(t), abstand: t.info.abstand, hoehe: t.info.hoehe }));
    return kalibrierVergleich(g.kalib, andere);
  }

  // ─────────────────────────────────────────────────────────────────
  // DIE GRUPPE
  // ─────────────────────────────────────────────────────────────────

  function gekoppelt() {
    return !!g.kalib && g.mitgehen && verbunden() && v.renderer.xr.isPresenting
      && !!v.zustand.job && (v.zustand.modus === 'vr' || v.zustand.modus === 'tisch');
  }

  /**
   * Der Gruppe beitreten: Gibt es schon eine Lage für dieses Modell und diesen
   * Modus, stellt sich diese Brille danach ein (true). Sonst gilt ihre eigene
   * Lage, und sie meldet sie (false).
   */
  function gruppeBeitreten() {
    if (!g.kalib || !v.zustand.job || !(v.zustand.modus === 'vr' || v.zustand.modus === 'tisch')) return false;
    const istVR = v.zustand.modus === 'vr';
    const z = g.zustand.get(`gruppe:${v.zustand.modus}`);
    g.folge.leeren();
    if (z && z.w && z.w.job === v.zustand.job && lageGueltig(z.w) && z.von !== ich.id && verbunden()) {
      const S = lage(z.w.x, z.w.y, z.w.z, z.w.gier, z.w.s);
      const ziel = istVR
        ? nutzerAusGruppe(lageVon(v.modell), S, g.kalib.physNachRaum)
        : modellAusGruppe(lageVon(v.nutzer), S, g.kalib.physNachRaum);
      lageSetzen(istVR ? v.nutzer : v.modell, ziel, !istVR);
      v.bodenRuhig();
      g.gesetzt = ziel;
      g.eigenBis = 0;
      g.fuehrt = z.von;
      hinweis(`Mit ${nameVon(z.von)} im selben Raum`);
      return true;
    }
    g.gesetzt = null;
    g.gesendet = null;
    g.eigenBis = performance.now() + EIGEN;
    return false;
  }

  function gruppeBild(jetzt) {
    if (!gekoppelt()) return;
    const istVR = v.zustand.modus === 'vr';
    const ziel = istVR ? v.nutzer : v.modell;
    const jetztLage = lageVon(ziel);
    if (!g.gesetzt) g.gesetzt = jetztLage;
    else if (!lageGleich(jetztLage, g.gesetzt)) {
      // Selbst bewegt (Stick, Sprung, Drehen, Boden, Greifen): für eine Weile führt diese Brille
      g.eigenBis = jetzt + EIGEN;
      g.gesetzt = jetztLage;
    }
    if (jetzt < g.eigenBis) {
      if ((!g.gesendet || !lageGleich(jetztLage, g.gesendet, 1e-6)) && jetzt - g.gesendetUm >= TAKT.gruppe) {
        const S = gruppeAus(lageVon(v.modell), lageVon(v.nutzer), g.kalib.physNachRaum);
        zustandSenden(`gruppe:${v.zustand.modus}`, { job: v.zustand.job, ...lageRunden(S) });
        g.gesendet = jetztLage;
        g.gesendetUm = jetzt;
      }
      return;
    }
    if (g.folge.leer) return;
    const S = g.folge.lesen(jetzt - VERZOEGERUNG, lageMischen, lageSprung);
    if (!S) return;
    const soll = istVR
      ? nutzerAusGruppe(lageVon(v.modell), S, g.kalib.physNachRaum)
      : modellAusGruppe(lageVon(v.nutzer), S, g.kalib.physNachRaum);
    if (lageGleich(soll, jetztLage, 1e-6)) return;
    if (lageSprung(jetztLage, soll) && g.fuehrt) hinweisGedrosselt('gruppe', `${nameVon(g.fuehrt)} hat die Gruppe bewegt`, 2500);
    lageSetzen(ziel, soll, !istVR);
    v.bodenRuhig();
    g.gesetzt = soll;
  }

  // ─────────────────────────────────────────────────────────────────
  // POSEN SENDEN
  // ─────────────────────────────────────────────────────────────────

  const _modellInv = new THREE.Matrix4();
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _p2 = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();

  function nachModell(objekt) {
    _m.multiplyMatrices(_modellInv, objekt.matrixWorld).decompose(_p, _q, _s);
    return poseRunden([_p.x, _p.y, _p.z, _q.x, _q.y, _q.z, _q.w]);
  }

  /** Kinder des Nutzers stehen lokal im physischen Rahmen — von dort in den Raum. */
  function nachRaum(objekt) {
    const o = objekt;
    return poseRunden(poseLage(g.kalib.physNachRaum,
      [o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]));
  }

  function punktNachModell(p) {
    _p.copy(p).applyMatrix4(_modellInv);
    return [runden(_p.x, 3), runden(_p.y, 3), runden(_p.z, 3)];
  }

  /** Ein Controller mit Tasten — nicht eine Hand und nicht das Kneifen mit Blick (Vision Pro). */
  function istController(hand) {
    return !!hand.quelle && hand.quelle.targetRayMode === 'tracked-pointer' && !!hand.quelle.gamepad;
  }

  /** Linke Hand 0, rechte 1. Ein Kneifen mit Blick (transient-pointer) ist keine Hand am Avatar. */
  function handIndex(hand) {
    const q = hand.quelle;
    if (!q || q.targetRayMode !== 'tracked-pointer') return -1;
    return q.handedness === 'left' ? 0 : q.handedness === 'right' ? 1 : -1;
  }

  function sichtbar() {
    return v.renderer.domElement.clientWidth > 0 && document.visibilityState !== 'hidden';
  }

  function poseSenden(jetzt) {
    if (!verbunden() || !v.zustand.ausgerichtet) return;
    const xr = v.renderer.xr.isPresenting;
    // Eine Brille außerhalb der Sitzung zeigt sich nicht: das vorgeladene
    // iLEEN-Fenster in der Quest soll kein Gespenst in die Runde stellen.
    if (!xr && (ich.geraet !== 'bildschirm' || !sichtbar())) return;
    if (jetzt - g.poseUm < (xr ? TAKT.xr : TAKT.vorschau)) return;
    _modellInv.copy(v.modell.matrixWorld).invert();
    v.kamera.updateWorldMatrix(true, false);
    const k = nachModell(v.kamera);
    const paket = { t: 'pose', k, s: Number(v.modell.scale.x.toPrecision(8)), m: v.zustand.modus };
    if (xr) {
      paket.h = [null, null];
      paket.z = [null, null];
      const raumH = [null, null];
      for (const hand of v.haende) {
        const i = handIndex(hand);
        if (i < 0) continue;
        paket.h[i] = nachModell(hand.griff);
        if (g.kalib) raumH[i] = nachRaum(hand.griff);
        if (hand.zielt && !hand.aufTablet) {
          const von = hand.strahl.getWorldPosition(new THREE.Vector3());
          const bis = hand.treffer ? hand.treffer.punkt.clone()
            : von.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(hand.strahl.getWorldQuaternion(_q)).multiplyScalar(3));
          paket.z[i] = [...punktNachModell(von), ...punktNachModell(bis)];
        }
      }
      paket.f = runden(_p2.setFromMatrixPosition(v.nutzer.matrixWorld).applyMatrix4(_modellInv).y, 3);
      if (g.kalib) paket.r = { k: nachRaum(v.kamera), h: raumH };
    } else if (g.letztePose && k.every((x, i) => Math.abs(x - g.letztePose[i]) < 1e-3) && jetzt - g.poseUm < 2000) {
      return;   // am Bildschirm nur, wenn sich etwas bewegt — sonst alle 2 s als Lebenszeichen
    }
    g.letztePose = k;
    g.poseUm = jetzt;
    senden(paket);
  }

  // ─────────────────────────────────────────────────────────────────
  // AVATARE STELLEN
  // ─────────────────────────────────────────────────────────────────

  const _mq = new THREE.Quaternion();
  const _nq = new THREE.Quaternion();
  const _ich = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();

  function ausModell(pose, zielP, zielQ) {
    zielP.set(pose[0], pose[1], pose[2]).applyMatrix4(v.modell.matrixWorld);
    if (zielQ) zielQ.set(pose[3], pose[4], pose[5], pose[6]).premultiply(_mq);
  }

  function ausRaum(pose, zielP, zielQ) {
    const p = poseLage(g.kalib.raumNachPhys, pose);
    zielP.set(p[0], p[1], p[2]).applyMatrix4(v.nutzer.matrixWorld);
    zielQ.set(p[3], p[4], p[5], p[6]).premultiply(_nq);
  }

  function modusText(t) {
    const m = t.info && t.info.modus;
    if (m === 'vr') return '1:1';
    if (m === 'tisch') return 'Tischmodell';
    return t.geraet === 'brille' ? 'nicht in VR' : 'am Bildschirm';
  }

  /** Schild über dem Kopf: lesbar auch aus der Ferne, nie größer als nötig. */
  function schildStellen(schild, kopf, f) {
    schild.sprite.position.copy(kopf);
    schild.sprite.position.y += 0.26 * f;
    const d = schild.sprite.position.distanceTo(_ich);
    const b = 0.4 * Math.max(f, d / 6);
    schild.sprite.scale.set(b, b / 4, 1);
  }

  function figurStellen(t, p, eigenS) {
    if (!t.figur) t.figur = figurBauen(t);
    const F = t.figur;
    ausModell(p.k, F.kopf.position, F.kopf.quaternion);
    let f = avatarMassstab(eigenS, p.s);
    // Die Kamera am Bildschirm schwebt oft weit über dem Modell: als Zeichen sichtbar halten
    if (t.geraet === 'bildschirm') f = Math.max(f, F.kopf.position.distanceTo(_ich) / 14);
    F.kopf.scale.setScalar(f);
    if (F.rumpf) {
      F.rumpf.position.copy(F.kopf.position);
      F.rumpf.position.y -= RUMPF * f;
      F.rumpf.quaternion.setFromAxisAngle(OBEN, quatGier([F.kopf.quaternion.x, F.kopf.quaternion.y, F.kopf.quaternion.z, F.kopf.quaternion.w]));
      F.rumpf.scale.setScalar(f);
    }
    for (let i = 0; i < 2; i++) {
      const h = F.haende[i];
      const hp = p.h && p.h[i];
      h.visible = !!hp;
      if (hp) { ausModell(hp, h.position, h.quaternion); h.scale.setScalar(f); }
      const s = F.strahlen[i];
      const z = p.z && p.z[i];
      s.gruppe.visible = !!z;
      if (z) {
        ausModell(z, _a);
        ausModell(z.slice(3), _b);
        const pos = s.linie.geometry.getAttribute('position');
        pos.setXYZ(0, _a.x, _a.y, _a.z);
        pos.setXYZ(1, _b.x, _b.y, _b.z);
        pos.needsUpdate = true;
        s.punkt.position.copy(_b);
        s.punkt.scale.setScalar(Math.max(0.02, _b.distanceTo(_ich) * 0.01));
      }
    }
    schildSchreiben(F.schild, anzeigeName(t), modusText(t), FARBEN[t.farbe]);
    schildStellen(F.schild, F.kopf.position, f);
    F.gruppe.visible = true;
  }

  function geistStellen(t, p, figurDa) {
    if (!t.geist) t.geist = geistBauen(t);
    const G = t.geist;
    ausRaum(p.r.k, G.kopf.position, G.kopf.quaternion);
    // Mitgehen: Avatar und Geist fallen zusammen — dann zeigt der Avatar alles
    if (figurDa && G.kopf.position.distanceTo(t.figur.kopf.position) < 0.25) { G.gruppe.visible = false; return false; }
    for (let i = 0; i < 2; i++) {
      const hp = p.r.h && p.r.h[i];
      G.haende[i].visible = !!hp;
      if (hp) ausRaum(hp, G.haende[i].position, G.haende[i].quaternion);
    }
    G.schild.sprite.visible = !figurDa;
    if (!figurDa) {
      schildSchreiben(G.schild, anzeigeName(t), t.info.job !== v.zustand.job ? 'steht hier · anderes Modell' : 'steht hier', FARBEN[t.farbe]);
      schildStellen(G.schild, G.kopf.position, 1);
    }
    G.gruppe.visible = true;
    return true;
  }

  function avatareBild(jetzt) {
    if (!g.teilnehmer.size) return;
    const eigenS = v.modell.scale.x;
    v.modell.getWorldQuaternion(_mq);
    v.nutzer.getWorldQuaternion(_nq);
    v.kamera.getWorldPosition(_ich);
    const xr = v.renderer.xr.isPresenting;
    for (const t of g.teilnehmer.values()) {
      const p = t.posen.lesen(jetzt - VERZOEGERUNG, paketMischen, paketSprung);
      const frisch = !!p && jetzt - t.ankunft < STILL;
      const virtuell = frisch && !!t.info.job && t.info.job === v.zustand.job && v.zustand.ausgerichtet;
      const physisch = frisch && xr && !!g.kalib && !!p.r;
      t.sichtbar = false;
      if (virtuell) { figurStellen(t, p, eigenS); t.sichtbar = true; } else if (t.figur) t.figur.gruppe.visible = false;
      if (physisch) t.sichtbar = geistStellen(t, p, virtuell) || t.sichtbar;
      else if (t.geist) t.geist.gruppe.visible = false;
      const kopf = virtuell ? t.figur.kopf.position : (t.geist && t.geist.gruppe.visible ? t.geist.kopf.position : null);
      t.abstand = kopf ? kopf.distanceTo(_ich) : null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // AUSWAHL UND MESSUNG DER ANDEREN
  // ─────────────────────────────────────────────────────────────────

  function anhaengeAktualisieren(t) {
    auswahlZeigen(t);
    messungZeigen(t);
  }

  function auswahlWeg(t) {
    for (const m of t.auswahlNetze) { m.removeFromParent(); m.geometry.dispose(); }
    t.auswahlNetze = [];
    if (t.auswahlSchild) {
      t.auswahlSchild.sprite.removeFromParent();
      t.auswahlSchild.textur.dispose();
      t.auswahlSchild.sprite.material.dispose();
      t.auswahlSchild = null;
    }
    t.auswahlSchluessel = '';
  }

  function auswahlStoff(t) {
    if (!t.auswahlStoff) {
      t.auswahlStoff = new THREE.MeshBasicMaterial({
        color: FARBEN[t.farbe], transparent: true, opacity: 0.5, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
        side: THREE.DoubleSide, toneMapped: false, fog: false,
      });
      t.auswahlStoff.clippingPlanes = v.schnittEbenen;
    }
    t.auswahlStoff.color.set(FARBEN[t.farbe]);
    return t.auswahlStoff;
  }

  function auswahlZeigen(t) {
    const a = t.info && t.info.auswahl;
    const passt = !!a && t.info.job === v.zustand.job && v.zustand.ausgerichtet;
    const schluessel = passt ? `${v.zustand.job}|${a.guid || ''}|${Array.isArray(a.punkt) ? a.punkt.join(',') : ''}` : '';
    if (schluessel === t.auswahlSchluessel) return;
    auswahlWeg(t);
    t.auswahlSchluessel = schluessel;
    if (!passt) return;
    if (typeof a.guid === 'string' && a.guid) {
      for (const f of v.ebenen.fundstellen(a.guid)) t.auswahlNetze.push(...bauteilNachzeichnen(f.wurzel, f.id, auswahlStoff(t)));
    }
    if (Array.isArray(a.punkt) && a.punkt.length === 3 && a.punkt.every(Number.isFinite)) {
      const s = schildBauen();
      schildSchreiben(s, `${anzeigeName(t)}: ${String(a.titel || 'Bauteil').slice(0, 40)}`, String(a.name || '').slice(0, 50), FARBEN[t.farbe]);
      s.sprite.position.fromArray(a.punkt);
      s.basis = 0.36;
      modellGruppe.add(s.sprite);
      t.auswahlSchild = s;
    }
  }

  function messungWeg(t) {
    if (t.messung) {
      t.messung.gruppe.removeFromParent();
      t.messung.gruppe.traverse(o => { if (o.geometry && o.geometry !== geo.kugel) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      t.messung = null;
    }
    t.messungSchluessel = '';
  }

  function messungZeigen(t) {
    const m = t.info && t.info.messung;
    const ok = x => Array.isArray(x) && x.length === 3 && x.every(Number.isFinite);
    const passt = !!m && ok(m.a) && t.info.job === v.zustand.job && v.zustand.ausgerichtet;
    const schluessel = passt ? JSON.stringify([v.zustand.job, m.a, m.b]) : '';
    if (schluessel === t.messungSchluessel) return;
    messungWeg(t);
    t.messungSchluessel = schluessel;
    if (!passt) return;
    const farbe = FARBEN[t.farbe];
    const stoff = new THREE.MeshBasicMaterial({ color: farbe, depthTest: false, toneMapped: false, fog: false });
    const gruppe = new THREE.Group();
    const kugeln = [m.a, ...(ok(m.b) ? [m.b] : [])].map(p => {
      const k = new THREE.Mesh(geo.kugel, stoff);
      k.position.fromArray(p);
      k.renderOrder = 12;
      gruppe.add(k);
      return k;
    });
    let schild = null;
    if (ok(m.b)) {
      const linie = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...m.a), new THREE.Vector3(...m.b)]),
        new THREE.LineBasicMaterial({ color: farbe, depthTest: false, toneMapped: false, fog: false }));
      linie.renderOrder = 12;
      gruppe.add(linie);
      schild = schildBauen();
      const d = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]);
      schildSchreiben(schild, meterText(d), anzeigeName(t), farbe);
      schild.sprite.position.set((m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2, (m.a[2] + m.b[2]) / 2);
      schild.basis = 0.3;
      gruppe.add(schild.sprite);
    }
    modellGruppe.add(stumm(gruppe));
    t.messung = { gruppe, kugeln, schild };
  }

  /** Was am Modell hängt, hat Weltgröße: Maßstab des Tischmodells ausgleichen. */
  function anhaengeBild() {
    if (!g.teilnehmer.size) return;
    const s = 1 / (v.modell.scale.x || 1);
    for (const t of g.teilnehmer.values()) {
      for (const schild of [t.auswahlSchild, t.messung && t.messung.schild]) {
        if (!schild) continue;
        schild.sprite.getWorldPosition(_a);
        const b = schild.basis * Math.max(1, _a.distanceTo(_ich) / 5) * s;
        schild.sprite.scale.set(b, b / 4, 1);
      }
      if (t.messung) for (const k of t.messung.kugeln) k.scale.setScalar(0.025 * s);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // ANSICHT
  // ─────────────────────────────────────────────────────────────────

  function ansichtUebernehmen(w) {
    const a = ansichtSauber(w);
    if (!a) return;
    g.ansichtStumm = true;
    try { v.ansichtAnwenden(a); } finally { g.ansichtStumm = false; }
    auswahlenNeu();
  }

  /** Nach einem neuen Filter: fremde Hervorhebungen aus dem jetzt gezeichneten Index neu bauen. */
  function auswahlenNeu() {
    for (const t of g.teilnehmer.values()) {
      if (!t.auswahlSchluessel) continue;
      auswahlWeg(t);
      auswahlZeigen(t);
    }
  }

  function ansichtBeitreten() {
    if (!g.ansichtTeilen || !v.zustand.job || !verbunden()) return;
    const z = g.zustand.get('ansicht');
    if (z && z.w && z.w.job === v.zustand.job && z.von !== ich.id) ansichtUebernehmen(z.w);
    else if (!ansichtLeer(ansichtSauber(v.ansichtLesen()))) ansichtMelden();
  }

  /** Nach jeder eigenen Änderung an Ebenen, Sichtbarkeit oder Schnitt (vr.js → aktionen). */
  function ansichtMelden() {
    if (g.ansichtStumm) return;
    auswahlenNeu();
    if (!g.ansichtTeilen || !verbunden() || !v.zustand.job) return;
    zustandSenden('ansicht', { job: v.zustand.job, ...ansichtSauber(v.ansichtLesen()) });
  }

  // ─────────────────────────────────────────────────────────────────
  // NEBEN JEMANDEN STELLEN
  // ─────────────────────────────────────────────────────────────────

  function nebenMoeglich(t) {
    if (!v.renderer.xr.isPresenting || v.zustand.modus !== 'vr' || !t.figur || !t.figur.gruppe.visible) return false;
    // Wer mit mir mitgeht, steht ohnehin neben mir
    const beideGekoppelt = gekoppelt() && t.info.kalibriert && t.info.mitgehen && t.info.modus === 'vr';
    return !beideGekoppelt;
  }

  /** Rechts hinter den anderen, mit seiner Blickrichtung: man sieht, was er sieht. */
  function nebenStellen(id) {
    const t = g.teilnehmer.get(id);
    if (!t || !nebenMoeglich(t)) return;
    const kopf = t.figur.kopf;
    const psi = quatGier([kopf.quaternion.x, kopf.quaternion.y, kopf.quaternion.z, kopf.quaternion.w]);
    const [ox, oz] = drehen(psi, 0.7, 0.5);
    const lokal = v.kamera.position;
    const lq = v.kamera.quaternion;
    const gamma = psi - quatGier([lq.x, lq.y, lq.z, lq.w]);
    const [lx, lz] = drehen(gamma, lokal.x, lokal.z);
    const p = t.posen.letzter && t.posen.letzter.wert;
    const fussY = p && Number.isFinite(p.f) ? _a.set(0, p.f, 0).applyMatrix4(v.modell.matrixWorld).y : kopf.position.y - lokal.y;
    v.nutzer.position.set(kopf.position.x + ox - lx, fussY, kopf.position.z + oz - lz);
    v.nutzer.quaternion.set(0, Math.sin(gamma / 2), 0, Math.cos(gamma / 2));
    v.nutzer.updateMatrixWorld(true);
    v.bodenRuhig();
    hinweis(`Neben ${anzeigeName(t)}`, FARBEN[t.farbe]);
  }

  // ─────────────────────────────────────────────────────────────────
  // NACH AUSSEN
  // ─────────────────────────────────────────────────────────────────

  // Neu ausgerichtet (Oculus-Taste lange gedrückt): der physische Rahmen hat sich verschoben
  v.renderer.xr.addEventListener('sessionstart', () => {
    const rs = v.renderer.xr.getReferenceSpace();
    if (rs && rs.addEventListener) {
      rs.addEventListener('reset', () => {
        if (!g.kalib) return;
        g.kalib = null;
        g.folge.leeren();
        infoMelden();
        hinweis('Brille neu ausgerichtet — bitte neu kalibrieren', '#e05c5c');
        v.ui.schmutzig = true;
      });
    }
  });

  const aktionen = {
    gmKalibrieren: kalibrierenStarten,
    gmAbbrechen: kalibrierenAbbrechen,
    gmVergessen() {
      g.kalib = null;
      g.folge.leeren();
      infoMelden();
    },
    gmMitgehen(an) {
      g.mitgehen = an;
      speichern();
      infoMelden();
      g.folge.leeren();
      if (an) gruppeBeitreten();
    },
    gmAnsicht(an) {
      g.ansichtTeilen = an;
      speichern();
      if (an) ansichtBeitreten();
    },
    gmNeben: nebenStellen,
    gmModellWechseln() {
      const R = raumModell();
      if (R && R.job !== v.zustand.job) v.modellLaden(R.job, R.name);
    },
    gmName() {
      if (v.renderer.xr.isPresenting) return;
      // eslint-disable-next-line no-alert
      const n = prompt('Dein Name für die anderen (leer: Brille/Bildschirm mit Nummer)', ich.name || '');
      if (n === null) return;
      ich.name = nameSauber(n);
      speichern();
      infoMelden();
    },
    gmVerbinden() {
      versuch = 0;
      if (!ws) verbinden();
    },
  };

  return {
    aktionen,
    hinweis,

    /** pruefeXR() weiß jetzt, ob hier eine Brille ist. */
    geraetSetzen(neu) {
      if (ich.geraet === neu) return;
      const alt = ich.geraet;
      ich.geraet = neu;
      if (alt && ws) { sofortWieder = true; ws.close(1000); return; }   // mit dem neuen Gerät neu anmelden
      if (vonSelbst()) verbinden();
    },

    /** Der Reiter Gruppe wurde geöffnet — am Mac der Anlass, sich zu verbinden. */
    seiteGeoeffnet() {
      if (!ws && vorgabe !== '0' && ich.geraet) { versuch = 0; verbinden(); }
    },

    /** Jedes Bild, nach der Steuerung und vor dem Zeichnen. */
    bild(jetzt) {
      v.modell.updateMatrixWorld();
      v.nutzer.updateMatrixWorld();
      if (v.renderer.xr.isPresenting) messenBild(jetzt);
      gruppeBild(jetzt);
      v.modell.updateMatrixWorld();
      v.nutzer.updateMatrixWorld();
      poseSenden(jetzt);
      avatareBild(jetzt);
      anhaengeBild();
      hinweisBild(jetzt);
    },

    /** Abzug während der Kalibrierung: misst die Marke statt zu springen. */
    abzugFangen,

    /**
     * Beim Betreten (und wenn ein Modell in der Sitzung eintrifft): Ist die
     * Brille kalibriert und geht mit, stellt sie sich nach der Gruppe — dann
     * entfallen Startpose und Tischplatzierung (true).
     */
    modusBetreten() {
      g.gesetzt = null;
      g.folge.leeren();
      infoMelden();
      if (g.kalib && g.mitgehen && verbunden()) return gruppeBeitreten();
      return false;
    },

    sitzungEnde() {
      // Neue Sitzung, neuer physischer Rahmen: die Kalibrierung gilt nicht mehr
      g.kalib = null;
      g.messen = null;
      g.folge.leeren();
      g.gesetzt = null;
      for (const m of marken) m.visible = false;
      for (const s of spitzen) s.visible = false;
      for (const h of v.haende) h.gefangen = false;
      tafel.mesh.visible = false;
      infoMelden();
      v.ui.schmutzig = true;
    },

    /** Welches Modell beim Betreten? Sind andere schon drin, das der Gruppe. */
    modellFuerBeitritt() {
      const R = raumModell();
      return verbunden() && R && andereIm(R.job) ? R : null;
    },

    modellGeladen(job, name, vonGruppe) {
      g.gesetzt = null;
      g.folge.leeren();
      g.eigeneAuswahl = null;
      g.eigeneMessung = null;
      for (const t of g.teilnehmer.values()) anhaengeAktualisieren(t);
      infoMelden();
      if (vonGruppe) { g.modellOffen = null; return; }
      if (!verbunden()) { g.modellOffen = { job, name }; return; }
      const R = raumModell();
      if (!R || R.job !== job) zustandSenden('modell', { job, name });
    },

    /** Der Rahmen steht: Auswahl, Messungen und Ansicht der anderen gelten jetzt hier. */
    modellBereit() {
      for (const t of g.teilnehmer.values()) anhaengeAktualisieren(t);
      ansichtBeitreten();
    },

    /** Eine Kachel ist da: fremde Auswahl auch in ihr nachzeichnen (Feinstufen kommen nach). */
    kachelGeladen(szene) {
      for (const t of g.teilnehmer.values()) {
        const a = t.info && t.info.auswahl;
        if (!t.auswahlSchluessel || !a || !a.guid) continue;
        for (const f of v.ebenen.fundstellen(a.guid, szene)) t.auswahlNetze.push(...bauteilNachzeichnen(f.wurzel, f.id, auswahlStoff(t)));
      }
    },

    auswahlMelden(a, punktWelt) {
      let punkt = null;
      if (a && punktWelt) {
        v.modell.updateMatrixWorld();
        _modellInv.copy(v.modell.matrixWorld).invert();
        punkt = punktNachModell(punktWelt);
      }
      g.eigeneAuswahl = a ? {
        guid: a.guid || '', titel: String(a.titel || '').slice(0, 60), name: String(a.name || '').slice(0, 80), punkt,
      } : null;
      infoMelden();
    },

    messungMelden() {
      const p = v.werkzeug.punkte;
      g.eigeneMessung = p.length ? { a: p[0].toArray().map(x => runden(x, 3)), b: p[1] ? p[1].toArray().map(x => runden(x, 3)) : null } : null;
      infoMelden();
    },

    ansichtMelden,

    /** Für den Reiter: alles, was er zeichnet, in einem Stück. */
    get anzeige() {
      const xr = v.renderer.xr.isPresenting;
      const R = raumModell();
      const m = g.messen;
      return {
        verbindung: g.verbindung,
        adresse: !!adresse(),
        raum: g.raum,
        ich: { name: anzeigeName({ name: ich.name, geraet: ich.geraet, nummer: ich.nummer }), farbe: FARBEN[ich.farbe] || FARBEN[0], geraet: ich.geraet },
        brille: ich.geraet === 'brille',
        xr,
        kalib: g.kalib ? { abstand: g.kalib.abstand, vergleich: vergleich() } : null,
        messen: m ? { schritt: m.schritt, laeuft: !!m.probe, meldung: m.meldung } : null,
        mitgehen: g.mitgehen,
        ansichtTeilen: g.ansichtTeilen,
        gekoppelt: gekoppelt(),
        fuehrt: g.fuehrt && g.fuehrt !== ich.id && g.teilnehmer.has(g.fuehrt) ? nameVon(g.fuehrt) : null,
        raumModell: R && R.job !== v.zustand.job && andereIm(R.job) ? R : null,
        teilnehmer: [...g.teilnehmer.values()].sort((a, b) => (a.geraet === b.geraet ? a.nummer - b.nummer : a.geraet === 'brille' ? -1 : 1)).map(t => ({
          id: t.id, name: anzeigeName(t), farbe: FARBEN[t.farbe] || FARBEN[0], geraet: t.geraet, modus: modusText(t),
          kalibriert: !!t.info.kalibriert, mitgehen: !!t.info.mitgehen,
          anderesModell: !!t.info.job && t.info.job !== v.zustand.job,
          modell: t.info.modell || '', abstand: t.sichtbar ? t.abstand : null, neben: nebenMoeglich(t),
        })),
      };
    },

    /** Für die Nachführung des Reiters: ändert sich, wenn er neu gezeichnet werden muss. */
    merkmal() {
      const m = g.messen;
      return `${g.verbindung}|${m ? `${m.schritt}${m.probe ? 'p' : ''}${m.meldung}` : ''}|${!!g.kalib}|` +
        [...g.teilnehmer.values()].map(t => `${t.id}:${t.info.modus}:${t.info.kalibriert}:${t.sichtbar ? Math.round((t.abstand || 0) * 2) : '-'}`).join(',');
    },

    // Für Konsole und Prüfstein
    get zustand() { return g; },
    get ich() { return ich; },
    weltGruppe,
    modellGruppe,
    verbinden,
  };
}
