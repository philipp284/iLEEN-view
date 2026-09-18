// ui-views-extension.js — Event-Listener für den VIEW-Tab (Saved Views + DoF).
// getViewTabContent() in ui.js rendert das HTML — diese Datei bindet nur die Listener.
// MiB_black-Theme: nutzt vorhandene .modern-* Klassen.

'use strict';

(function () {
    if (typeof BimViewerUI === 'undefined') {
        console.error('ui-views-extension: BimViewerUI missing (load after ui.js)');
        return;
    }
    if (!window.Views) {
        console.warn('ui-views-extension: window.Views missing (views.js not loaded?)');
    }

    function $(id) { return document.getElementById(id); }

    function renderList() {
        const container = $('viewsList');
        if (!container || !window.Views) return;
        const items = window.Views.list();
        if (!items.length) {
            container.innerHTML = `<div class="modern-hint" style="opacity:.7;">No views saved yet.</div>`;
            return;
        }
        container.innerHTML = items.map(v => {
            const date = new Date(v.createdAt).toLocaleString();
            const dofTxt = v.dof.enabled ? `DoF ${v.dof.focusDistance.toFixed(1)}m ±${(v.dof.focusRange / 2).toFixed(1)}` : 'DoF off';
            return `
        <div class="modern-view-item" data-id="${v.id}" style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.03);margin-bottom:6px;">
          <span style="flex:1;min-width:0;">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(v.name)}</div>
            <div style="font-size:11px;opacity:.65;">${date} · ${dofTxt}</div>
          </span>
          <button class="modern-btn modern-btn-small viewsApply" data-id="${v.id}" title="Fly to view">▶</button>
          <button class="modern-btn modern-btn-small viewsRemove" data-id="${v.id}" title="Remove">✕</button>
        </div>
      `;
        }).join('');

        container.querySelectorAll('.viewsApply').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = b.dataset.id;
                const v = window.Views.list().find(x => x.id === id);
                if (v) window.Views.apply(v);
            });
        });
        container.querySelectorAll('.viewsRemove').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('Remove this view?')) window.Views.remove(b.dataset.id);
            });
        });
        container.querySelectorAll('.modern-view-item').forEach(row => {
            row.addEventListener('click', () => {
                const id = row.dataset.id;
                const v = window.Views.list().find(x => x.id === id);
                if (v) window.Views.apply(v);
            });
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function syncDofUiFromStage() {
        if (!window.Views) return;
        const stage = window.Views.getStage && window.Views.getStage();
        if (!stage) return;
        const u = stage.uniforms;
        const fd = $('viewsDofFd'), fr = $('viewsDofFr'), bs = $('viewsDofBs');
        if (fd) { fd.value = u.focusDistance; $('viewsDofFdVal').textContent = `${Number(u.focusDistance).toFixed(1)} m`; }
        if (fr) { fr.value = u.focusRange; $('viewsDofFrVal').textContent = `${Number(u.focusRange).toFixed(1)} m`; }
        if (bs) { bs.value = u.bokehStrength; $('viewsDofBsVal').textContent = `${Number(u.bokehStrength).toFixed(2)}`; }
        const t = $('viewsDofToggle');
        if (t) {
            const on = !!stage.enabled;
            t.classList.toggle('active', on);
            t.querySelector('span:last-child').textContent = on ? 'DoF ON' : 'Enable DoF';
        }
    }

    function bindListeners() {
        if (!$('viewsSaveBtn')) return; // Section noch nicht im DOM
        if (!window.Views) return;

        $('viewsSaveBtn').addEventListener('click', () => {
            const name = prompt('Name für diese View?', `View ${new Date().toLocaleTimeString()}`);
            if (name === null) return;
            window.Views.save(name);
            BimViewer?.updateStatus?.(`View saved: ${name}`, 'success');
        });

        $('viewsDofToggle').addEventListener('click', function () {
            const stage = window.Views.getStage();
            const next = !(stage && stage.enabled);
            window.Views.setDofLive({ enabled: next });
            syncDofUiFromStage();
        });

        const fd = $('viewsDofFd'), fr = $('viewsDofFr'), bs = $('viewsDofBs');
        fd.addEventListener('input', () => {
            $('viewsDofFdVal').textContent = `${Number(fd.value).toFixed(1)} m`;
            window.Views.setDofLive({ focusDistance: parseFloat(fd.value) });
        });
        fr.addEventListener('input', () => {
            $('viewsDofFrVal').textContent = `${Number(fr.value).toFixed(1)} m`;
            window.Views.setDofLive({ focusRange: parseFloat(fr.value) });
        });
        bs.addEventListener('input', () => {
            $('viewsDofBsVal').textContent = `${Number(bs.value).toFixed(2)}`;
            window.Views.setDofLive({ bokehStrength: parseFloat(bs.value) });
        });

        $('viewsDofPick').addEventListener('click', () => {
            const scene = BimViewer?.viewer?.scene;
            if (!scene) return;
            const c = scene.canvas;
            const px = new Cesium.Cartesian2(c.clientWidth / 2, c.clientHeight / 2);
            const p = scene.pickPosition(px);
            if (!p) { BimViewer?.updateStatus?.('Auto-Focus: nothing picked at center', 'warning'); return; }
            const dist = Cesium.Cartesian3.distance(scene.camera.positionWC, p);
            window.Views.setDofLive({ enabled: true, focusDistance: dist });
            syncDofUiFromStage();
            BimViewer?.updateStatus?.(`Focus distance set to ${dist.toFixed(1)} m`, 'success');
        });

        renderList();
        syncDofUiFromStage();
    }

    document.addEventListener('views:changed', renderList);

    // Section wird erst beim ersten Öffnen / oder bei UI-Init in DOM eingehängt.
    // Wir binden lazy: MutationObserver auf den Sidebar-Container, oder Polling beim ersten Klick.
    function tryBind() {
        if ($('viewsSaveBtn')) { bindListeners(); return true; }
        return false;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(tryBind, 50));
    } else {
        setTimeout(tryBind, 50);
    }

    // Falls Section später gerendert wird (z. B. erst beim Aufklappen), beobachten
    const mo = new MutationObserver(() => { if (tryBind()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
})();
