// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Der Schalter 🥽 VR in iLEEN: eine Ebene über dem Viewer, in der vr.html läuft.
//
// Warum eine Ebene und kein neuer Tab: In der Brille öffnet man iLEEN selbst im
// Quest-Browser, und der Schalter soll dort gleich die Sitzung beginnen. Cesium
// kann kein WebXR — also lebt die Brillenansicht (vr.js, three.js) in einem
// `<iframe>` derselben Herkunft, über iLEEN gelegt.
//
// Warum vorab geladen: `navigator.xr.requestSession()` verlangt eine Geste
// (Klick), und die gilt nur Sekunden. Käme der iframe erst beim Klick, wäre sie
// abgelaufen, bevor vr.js geladen ist. Deshalb wird er unsichtbar vorbereitet,
// sobald die Brille VR kann; der Klick ruft dann `ILeenVR.betreten()` im
// selben Zug auf. Eine Geste gilt für gleich-ursprüngliche Unterfenster mit.
//
// Ohne WebXR (Mac, kein sicherer Kontext) geht dieselbe Ebene als Vorschau auf:
// Modell wählen, Bauteile anklicken. Die VR-Knöpfe bleiben dort gesperrt, und
// die Seite sagt, warum.

(function () {
  'use strict';

  const SEITE = 'vr.html?eingebettet=1';

  let rahmen = null;      // <iframe>
  let ebene = null;       // der Container samt ✕
  let xrMoeglich = false;
  let vorbereitet = false;

  function bauen() {
    if (ebene) return;
    ebene = document.createElement('div');
    ebene.id = 'vrEbene';
    ebene.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#0f0f0f;display:none;';

    rahmen = document.createElement('iframe');
    rahmen.src = SEITE;
    rahmen.title = 'iLEEN in der Brille';
    rahmen.setAttribute('allow', 'xr-spatial-tracking; fullscreen; accelerometer; gyroscope');
    rahmen.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    rahmen.addEventListener('load', () => { vorbereitet = true; });

    const zu = document.createElement('button');
    zu.type = 'button';
    zu.textContent = '✕';
    zu.title = 'Zurück zu iLEEN (Esc)';
    zu.setAttribute('aria-label', 'VR schließen');
    zu.style.cssText = 'position:absolute;top:6px;right:10px;width:36px;height:36px;border:1px solid rgba(255,255,255,.25);' +
      'border-radius:18px;background:rgba(20,20,20,.92);color:#e8e8e8;font-size:16px;cursor:pointer;z-index:1;';
    zu.addEventListener('click', schliessen);

    ebene.append(rahmen, zu);
    document.body.appendChild(ebene);
  }

  function vr() {
    try { return rahmen && rahmen.contentWindow && rahmen.contentWindow.ILeenVR; } catch (e) { return null; }
  }

  /** Den iframe unsichtbar laden, sobald die Brille VR kann. */
  async function vorbereiten() {
    if (!window.isSecureContext || !navigator.xr) return;
    try { xrMoeglich = await navigator.xr.isSessionSupported('immersive-vr'); } catch (e) { return; }
    if (xrMoeglich) bauen();
  }

  /**
   * Der Schalter. Läuft im Klick: `betreten()` fragt die Sitzung an, ehe etwas
   * anderes passiert.
   */
  function oeffnen(job, name, modus) {
    bauen();
    ebene.style.display = 'block';
    const seite = vr();
    if (xrMoeglich && vorbereitet && seite && seite.betreten) {
      seite.betreten(modus || 'vr', job || null);
      return 'sitzung';
    }
    // Keine Sitzung möglich oder die Seite ist noch nicht da: als Vorschau mit
    // dem Modell öffnen. Der Nutzer drückt dort selbst.
    if (job) {
      if (seite && seite.ladeModell) seite.ladeModell(job, name || job);
      else rahmen.src = `${SEITE}&job=${encodeURIComponent(job)}`;
    }
    return 'vorschau';
  }

  function schliessen() {
    if (!ebene) return;
    const seite = vr();
    try {
      const sitzung = seite && seite.renderer.xr.getSession();
      if (sitzung) sitzung.end();
    } catch (e) { /* schon beendet */ }
    ebene.style.display = 'none';
  }

  function offen() { return !!ebene && ebene.style.display !== 'none'; }

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && offen()) schliessen(); });

  window.ILeenVRFenster = { oeffnen, schliessen, offen, vorbereiten, get moeglich() { return xrMoeglich; } };

  // Erst wenn die Szene steht: der iframe kostet Speicher und Netz.
  window.addEventListener('load', () => setTimeout(vorbereiten, 4000));
})();
