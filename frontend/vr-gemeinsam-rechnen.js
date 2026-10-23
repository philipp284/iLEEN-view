// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Gemeinsam in der Brille — die Rechnungen, ohne three.js und ohne Netz.
//
// Drei Rahmen, und jede Zahl gehört in genau einen:
//
//   physisch  der Raum einer Brille (WebXR `local-floor`): Ursprung, wo die
//             Sitzung begann, y = Boden. Jede Brille hat ihren eigenen.
//   Raum      der gemeinsame Rahmen aus der Kalibrierung: Ursprung an Marke 1,
//             x zeigt waagerecht zu Marke 2, y = Boden. Für alle Brillen gleich,
//             weil alle dieselben zwei Marken messen.
//   Modell    der Modellrahmen aus vr.js → ausrichten(): x Ost, y oben, z Süd,
//             Grundrissmitte auf der Unterkante. Für alle gleich, die dasselbe
//             Modell geladen haben.
//
// Übers Netz gehen Posen im Modellrahmen (dort stehen auch die Avatare) und,
// wenn kalibriert, zusätzlich im Raumrahmen (dort steht der Mensch wirklich).
// Die Gruppe teilt die Abbildung S: Raum → Modell. Wer mitgeht, stellt sich
// danach ein: im 1:1-Modus den Nutzer, im Tischmodell das Modell. Damit stehen
// die Avatare dort, wo die Menschen stehen, in beiden Modi und ohne Sonderfall.
//
// Eine Lage ist eine Ähnlichkeitsabbildung mit Drehung nur um die Hochachse:
//   p' = s · R_y(gier) · p + (x, y, z)
// R_y wie in three.js: x' = x·cos + z·sin, z' = −x·sin + z·cos. Gekippt wird
// nie — weder der Nutzer noch das Tischmodell (vr.js → halten).

export const PROTOKOLL = 1;
export const RAUM_PORT = 5446;
export const RAUM_VORGABE = 'labor';

// Farben der Teilnehmer, gut unterscheidbar und keine davon das Akzentgrün
// (das tragen die eigenen Strahlen).
export const FARBEN = ['#f28c28', '#3fa7f5', '#d651c6', '#f2c94c', '#2bb3a3', '#e5534b', '#8f7cf7', '#c9d2d9'];

export const KALIBRIER = {
  dauer: 500,           // ms Messung je Marke, der Mittelwert zählt
  mindestProben: 8,
  unruhe: 0.015,        // m: weiter darf keine Probe vom Mittel liegen
  mindestAbstand: 0.8,  // m zwischen den Marken — darunter wird die Richtung ungenau
  abweichung: 0.05,     // m: so weit dürfen die Abstände zweier Brillen auseinanderliegen
  hoehe: 0.08,          // m: ebenso die Höhe der Marken
};

// So weit hinter der Gegenwart werden fremde Posen und Gruppenlagen gezeigt —
// genug, dass zwischen zwei Paketen (20–30 je Sekunde) immer gemischt werden kann.
export const VERZOEGERUNG = 100;

const GRAD = Math.PI / 180;

// ─────────────────────────────────────────────────────────────────
// LAGEN
// ─────────────────────────────────────────────────────────────────

export function lage(x = 0, y = 0, z = 0, gier = 0, s = 1) {
  return { x, y, z, gier, s };
}

export const EINS = Object.freeze(lage());

/** Winkel auf [−π, π). */
export function winkel(w) {
  let r = (w + Math.PI) % (2 * Math.PI);
  if (r < 0) r += 2 * Math.PI;
  return r - Math.PI;
}

export function drehen(gier, x, z) {
  const c = Math.cos(gier);
  const s = Math.sin(gier);
  return [c * x + s * z, -s * x + c * z];
}

export function lagePunkt(L, p) {
  const [rx, rz] = drehen(L.gier, p[0], p[2]);
  return [L.s * rx + L.x, L.s * p[1] + L.y, L.s * rz + L.z];
}

/** A ∘ B: erst B, dann A. */
export function lageMal(A, B) {
  const [tx, tz] = drehen(A.gier, B.x, B.z);
  return {
    x: A.s * tx + A.x, y: A.s * B.y + A.y, z: A.s * tz + A.z,
    gier: winkel(A.gier + B.gier), s: A.s * B.s,
  };
}

export function lageInvers(A) {
  const s = 1 / A.s;
  const [tx, tz] = drehen(-A.gier, -A.x, -A.z);
  return { x: s * tx, y: -s * A.y, z: s * tz, gier: winkel(-A.gier), s };
}

export function lageGueltig(L) {
  return !!L && ['x', 'y', 'z', 'gier', 's'].every(k => Number.isFinite(L[k]))
    && L.s > 1e-4 && L.s < 1e4 && Math.abs(L.x) < 1e7 && Math.abs(L.y) < 1e7 && Math.abs(L.z) < 1e7;
}

export function lageRunden(L) {
  return {
    x: runden(L.x, 4), y: runden(L.y, 4), z: runden(L.z, 4),
    gier: runden(winkel(L.gier), 6), s: Number(L.s.toPrecision(8)),
  };
}

/** Gleich bis auf Rauschen — zum Erkennen, ob der Nutzer selbst etwas bewegt hat. */
export function lageGleich(a, b, eps = 1e-5) {
  return !!a && !!b && Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps
    && Math.abs(winkel(a.gier - b.gier)) < eps && Math.abs(a.s / b.s - 1) < eps;
}

/** Zwischen zwei Lagen: Weg linear, Drehung auf dem kurzen Weg, Maßstab geometrisch. */
export function lageMischen(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
    gier: winkel(a.gier + winkel(b.gier - a.gier) * t),
    s: a.s * (b.s / a.s) ** t,
  };
}

/** Ein Sprung (Teleport, Drehschritt, Kartensprung) wird nicht gemischt, sondern gesetzt. */
export function lageSprung(a, b) {
  const weg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / Math.max(a.s, b.s);
  return weg > 1.5 || Math.abs(winkel(b.gier - a.gier)) > 20 * GRAD || Math.max(b.s / a.s, a.s / b.s) > 1.5;
}

// ─────────────────────────────────────────────────────────────────
// DIE GRUPPE — S: Raum → Modell
// ─────────────────────────────────────────────────────────────────
//
// N = Nutzer (physisch → Welt), M = Modell (Modell → Welt), L = physisch → Raum.
//   S = M⁻¹ ∘ N ∘ L⁻¹
// 1:1-Modus: das Modell bleibt, der Nutzer folgt   N = M ∘ S ∘ L
// Tisch:     der Nutzer bleibt, das Modell folgt    M = N ∘ L⁻¹ ∘ S⁻¹

export function gruppeAus(modellLage, nutzerLage, physNachRaum) {
  return lageMal(lageInvers(modellLage), lageMal(nutzerLage, lageInvers(physNachRaum)));
}

export function nutzerAusGruppe(modellLage, S, physNachRaum) {
  return lageMal(modellLage, lageMal(S, physNachRaum));
}

export function modellAusGruppe(nutzerLage, S, physNachRaum) {
  return lageMal(nutzerLage, lageMal(lageInvers(physNachRaum), lageInvers(S)));
}

// ─────────────────────────────────────────────────────────────────
// KALIBRIERUNG — zwei Marken, gemessen mit der Spitze des Controllers
// ─────────────────────────────────────────────────────────────────

/** Mittel und Unruhe einer Messung (Proben = [[x, y, z], …]). */
export function stichprobe(proben) {
  const n = proben.length;
  if (!n) return { n: 0, mitte: null, unruhe: Infinity };
  const mitte = [0, 0, 0];
  for (const p of proben) { mitte[0] += p[0]; mitte[1] += p[1]; mitte[2] += p[2]; }
  mitte[0] /= n; mitte[1] /= n; mitte[2] /= n;
  let unruhe = 0;
  for (const p of proben) unruhe = Math.max(unruhe, Math.hypot(p[0] - mitte[0], p[1] - mitte[1], p[2] - mitte[2]));
  return { n, mitte, unruhe };
}

/** Taugt die Messung einer Marke? null = ja, sonst der Grund. */
export function stichprobeFehler(s) {
  if (s.n < KALIBRIER.mindestProben) return 'kurz';
  if (s.unruhe > KALIBRIER.unruhe) return 'unruhig';
  return null;
}

/**
 * Aus zwei Marken (physisch, in Metern) den Raumrahmen. Waagerecht gerechnet:
 * die Höhe kommt bei allen Brillen aus ihrem eigenen Boden (local-floor), sie
 * ist genauer als eine Spitze, die mal auf dem Boden, mal in der Luft war.
 */
export function kalibrierung(p1, p2) {
  const dx = p2[0] - p1[0];
  const dz = p2[2] - p1[2];
  const abstand = Math.hypot(dx, dz);
  if (!(abstand >= KALIBRIER.mindestAbstand)) return { fehler: 'nah', abstand };
  const gier = Math.atan2(-dz, dx);   // dreht die Raum-x-Achse auf die Richtung 1 → 2
  const raumNachPhys = lage(p1[0], 0, p1[2], gier, 1);
  return {
    physNachRaum: lageInvers(raumNachPhys),
    raumNachPhys,
    abstand,
    hoehe: (p1[1] + p2[1]) / 2,
    schraeg: Math.abs(p2[1] - p1[1]),
  };
}

/**
 * Passen die Messungen der anderen zur eigenen? Alle messen dieselben zwei
 * Marken; liegen ihre Abstände weiter auseinander, hat jemand eine andere
 * Marke getroffen oder gewackelt. Zurück: der schlimmste Fall oder null.
 */
export function kalibrierVergleich(eigen, andere) {
  let schlimmste = null;
  for (const a of andere) {
    if (!a || !(a.abstand > 0)) continue;
    const d = Math.abs(a.abstand - eigen.abstand);
    const h = Math.abs((a.hoehe ?? 0) - (eigen.hoehe ?? 0));
    const fall = { name: a.name, abstand: d, hoehe: h, passt: d <= KALIBRIER.abweichung && h <= KALIBRIER.hoehe };
    if (!schlimmste || (schlimmste.passt && !fall.passt) || (schlimmste.passt === fall.passt && d + h > schlimmste.abstand + schlimmste.hoehe)) {
      schlimmste = fall;
    }
  }
  return schlimmste;
}

// ─────────────────────────────────────────────────────────────────
// POSEN — [x, y, z, qx, qy, qz, qw]
// ─────────────────────────────────────────────────────────────────

export function runden(v, stellen) {
  const f = 10 ** stellen;
  return Math.round(v * f) / f;
}

export function poseRunden(p) {
  return p ? [runden(p[0], 3), runden(p[1], 3), runden(p[2], 3),
    runden(p[3], 4), runden(p[4], 4), runden(p[5], 4), runden(p[6], 4)] : null;
}

export function poseGueltig(p) {
  if (!Array.isArray(p) || p.length !== 7 || !p.every(Number.isFinite)) return false;
  const q = Math.hypot(p[3], p[4], p[5], p[6]);
  return q > 0.9 && q < 1.1 && Math.abs(p[0]) < 1e7 && Math.abs(p[1]) < 1e7 && Math.abs(p[2]) < 1e7;
}

export function gierQuat(g) {
  return [0, Math.sin(g / 2), 0, Math.cos(g / 2)];
}

export function quatMal(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatDrehen(q, v) {
  const [x, y, z, w] = q;
  // v + 2w(q×v) + 2 q×(q×v)
  const cx = y * v[2] - z * v[1];
  const cy = z * v[0] - x * v[2];
  const cz = x * v[1] - y * v[0];
  return [
    v[0] + 2 * (w * cx + y * cz - z * cy),
    v[1] + 2 * (w * cy + z * cx - x * cz),
    v[2] + 2 * (w * cz + x * cy - y * cx),
  ];
}

/** Blickrichtung waagerecht als Gierwinkel (three.js schaut nach −z). */
export function quatGier(q) {
  const f = quatDrehen(q, [0, 0, -1]);
  return Math.atan2(-f[0], -f[2]);
}

export function slerp(a, b, t) {
  let [bx, by, bz, bw] = b;
  let c = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (c < 0) { c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let ka = 1 - t;
  let kb = t;
  if (c < 0.9995) {
    const w = Math.acos(c);
    const s = Math.sin(w);
    ka = Math.sin((1 - t) * w) / s;
    kb = Math.sin(t * w) / s;
  }
  const r = [ka * a[0] + kb * bx, ka * a[1] + kb * by, ka * a[2] + kb * bz, ka * a[3] + kb * bw];
  const n = Math.hypot(...r) || 1;
  return r.map(v => v / n);
}

/** Eine Pose durch eine Lage schicken (Maßstab wirkt nur auf den Ort). */
export function poseLage(L, pose) {
  const p = lagePunkt(L, pose);
  const q = quatMal(gierQuat(L.gier), pose.slice(3, 7));
  return [p[0], p[1], p[2], q[0], q[1], q[2], q[3]];
}

export function poseMischen(a, b, t) {
  if (!a || !b) return t < 0.5 ? a : b;
  const q = slerp(a.slice(3, 7), b.slice(3, 7), t);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, ...q];
}

/**
 * Ein Posenpaket mischen: Kopf, Hände, die Raumposen und der Fuß. Strahlen,
 * Modus und Maßstab kommen vom näheren der beiden.
 */
export function paketMischen(a, b, t) {
  const naeher = t < 0.5 ? a : b;
  const haende = (ha, hb) => [0, 1].map(i => poseMischen(ha && ha[i], hb && hb[i], t));
  return {
    ...naeher,
    k: poseMischen(a.k, b.k, t),
    h: haende(a.h, b.h),
    f: Number.isFinite(a.f) && Number.isFinite(b.f) ? a.f + (b.f - a.f) * t : naeher.f,
    r: a.r && b.r ? { k: poseMischen(a.r.k, b.r.k, t), h: haende(a.r.h, b.r.h) } : naeher.r,
  };
}

/** Ist der Kopf zwischen zwei Paketen gesprungen (Teleport des anderen)? */
export function paketSprung(a, b) {
  if (!a.k || !b.k || a.m !== b.m || Math.max(a.s / b.s, b.s / a.s) > 1.2) return true;
  return Math.hypot(b.k[0] - a.k[0], b.k[1] - a.k[1], b.k[2] - a.k[2]) * (a.s || 1) > 1.5;
}

/**
 * Ein eingehendes Posenpaket prüfen und auf das zurechtstutzen, was gezeichnet
 * wird. Fremde Daten: alles, was nicht passt, fällt weg.
 */
export function paketSauber(n) {
  if (!n || typeof n !== 'object' || !poseGueltig(n.k)) return null;
  const haende = h => (Array.isArray(h) ? [0, 1].map(i => (poseGueltig(h[i]) ? h[i] : null)) : [null, null]);
  const strahl = z => (Array.isArray(z) && z.length === 6 && z.every(Number.isFinite) ? z : null);
  const s = Number.isFinite(n.s) && n.s > 1e-4 && n.s < 1e4 ? n.s : 1;
  return {
    k: n.k,
    h: haende(n.h),
    z: Array.isArray(n.z) ? [strahl(n.z[0]), strahl(n.z[1])] : [null, null],
    s,
    m: ['vr', 'tisch', 'vorschau'].includes(n.m) ? n.m : 'vorschau',
    f: Number.isFinite(n.f) ? n.f : null,
    r: n.r && poseGueltig(n.r.k) ? { k: n.r.k, h: haende(n.r.h) } : null,
  };
}

/**
 * Wie groß ein fremder Avatar hier steht: Ein Meter des anderen sind 1/s_fremd
 * Modelleinheiten, hier also s_eigen/s_fremd Weltmeter. Am Tisch steht der
 * Begeher als Figur im Modell, im 1:1 der Tischnutzer als Riese darüber —
 * gekappt, damit kein Kopf das Gebäude verdeckt.
 */
export function avatarMassstab(eigen, fremd) {
  const f = (eigen || 1) / (fremd || 1);
  return Math.min(4, Math.max(0.01, f));
}

// ─────────────────────────────────────────────────────────────────
// PUFFER — Pakete mit ihrer Ankunftszeit, gelesen etwas in der Vergangenheit
// ─────────────────────────────────────────────────────────────────
//
// Die Ankunftszeit statt der Uhr des Senders: zwei Brillen haben zwei Uhren,
// und im selben WLAN schwankt die Laufzeit nur um Millisekunden.

export class Puffer {
  constructor(max = 16) {
    this.max = max;
    this.eintraege = [];
  }

  neu(t, wert, seq = 0) {
    const letzter = this.eintraege[this.eintraege.length - 1];
    this.eintraege.push({ t: letzter && t < letzter.t ? letzter.t : t, wert, seq });
    if (this.eintraege.length > this.max) this.eintraege.shift();
  }

  get letzter() {
    return this.eintraege[this.eintraege.length - 1] || null;
  }

  get leer() {
    return !this.eintraege.length;
  }

  leeren() {
    this.eintraege = [];
  }

  /** Alles verwerfen, was älter ist als `seq` (eigene Bewegung hat es überholt). */
  abSeq(seq) {
    this.eintraege = this.eintraege.filter(e => e.seq > seq);
  }

  lesen(t, mischen, sprung) {
    const e = this.eintraege;
    if (!e.length) return null;
    if (t <= e[0].t) return e[0].wert;
    for (let i = e.length - 1; i >= 0; i--) {
      if (e[i].t > t) continue;
      const b = e[i + 1];
      if (!b) return e[i].wert;
      if (sprung && sprung(e[i].wert, b.wert)) return e[i].wert;
      return mischen(e[i].wert, b.wert, (t - e[i].t) / Math.max(1e-6, b.t - e[i].t));
    }
    return e[0].wert;
  }
}

// ─────────────────────────────────────────────────────────────────
// ANSICHT — Ebenen und Schnitt als Daten (vr-ebenen.js → filter)
// ─────────────────────────────────────────────────────────────────

export function filterAlsDaten(f) {
  const liste = s => [...s].filter(x => typeof x === 'string').sort();
  return { klassen: liste(f.klassen), geschosse: liste(f.geschosse), guids: liste(f.guids), nur: f.nur ? liste(f.nur) : null };
}

export function filterAusDaten(d) {
  const menge = a => new Set(Array.isArray(a) ? a.filter(x => typeof x === 'string').slice(0, 20000) : []);
  return {
    klassen: menge(d && d.klassen), geschosse: menge(d && d.geschosse), guids: menge(d && d.guids),
    nur: d && Array.isArray(d.nur) ? menge(d.nur) : null,
  };
}

export function ansichtSauber(a) {
  if (!a || typeof a !== 'object') return null;
  const s = a.schnitt || {};
  return {
    filter: filterAlsDaten(filterAusDaten(a.filter)),
    modell: a.modell !== false,
    schnitt: { an: !!s.an, hoehe: Number.isFinite(s.hoehe) ? s.hoehe : 3 },
  };
}

export function ansichtLeer(a) {
  const f = a.filter;
  return a.modell && !a.schnitt.an && !f.nur && !f.klassen.length && !f.geschosse.length && !f.guids.length;
}

// ─────────────────────────────────────────────────────────────────
// TEILNEHMER, ADRESSE, NAMEN
// ─────────────────────────────────────────────────────────────────

export function raumName(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : RAUM_VORGABE;
}

export function kennungGueltig(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(s);
}

export function kennungNeu() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

/** Ein selbst gewählter Name: ohne Steuerzeichen, höchstens 24 Zeichen. */
export function nameSauber(s) {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) : '';
}

export function anzeigeName(t) {
  if (!t) return '';
  return t.name || `${t.geraet === 'brille' ? 'Brille' : 'Bildschirm'} ${t.nummer || ''}`.trim();
}

/** Kleinste freie Nummer, die frühere bevorzugt. */
export function nummerWaehlen(belegt, frueher) {
  if (frueher && !belegt.has(frueher)) return frueher;
  let n = 1;
  while (belegt.has(n)) n++;
  return n;
}

/** Freie Farbe (Index in FARBEN), die frühere bevorzugt; sind alle belegt, reihum. */
export function farbeWaehlen(belegt, frueher) {
  if (Number.isInteger(frueher) && frueher >= 0 && frueher < FARBEN.length && !belegt.has(frueher)) return frueher;
  for (let i = 0; i < FARBEN.length; i++) if (!belegt.has(i)) return i;
  return belegt.size % FARBEN.length;
}

/**
 * Wohin die Seite sich verbindet.
 *   https (Quest über tools/quest-wlan.sh)  → wss://<derselbe Ursprung>/vr-raum, der Dev-Server reicht durch
 *   http://localhost (Mac)                  → ws://127.0.0.1:5446/vr-raum, direkt zum Relais
 *   http im WLAN                            → keins: dort gibt es ohnehin kein WebXR
 */
export function raumAdresse({ protokoll, host, hostname, port = RAUM_PORT, vorgabe = null }) {
  if (vorgabe && /^wss?:\/\//.test(vorgabe)) return vorgabe;
  if (protokoll === 'https:') return `wss://${host}/vr-raum`;
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return `ws://127.0.0.1:${port}/vr-raum`;
  return null;
}
