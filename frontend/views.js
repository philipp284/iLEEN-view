// views.js — Saved Views mit „Fake-Kamera" (DoF pro View).
// Persistiert Kamera + DoF-Parameter in localStorage.
// API: window.Views.{init, list, save, apply, remove, setDofLive, getStage, DEFAULT_DOF}.

(function () {
    'use strict';

    const STORE_KEY = 'bimviewer.views.v1';

    const DEFAULT_DOF = Object.freeze({
        enabled: false,
        focusDistance: 30.0,
        focusRange: 6.0,
        bokehStrength: 1.5,
        maxBlur: 8.0,
    });

    let viewer = null;
    let scene = null;
    let dofStage = null;

    function ensureStage() {
        if (dofStage) return dofStage;
        if (!scene) throw new Error('Views: not initialized (call Views.init first)');
        if (!window.__MIB_DOF_FRAG) throw new Error('Views: dof-shader.js missing');
        dofStage = scene.postProcessStages.add(new Cesium.PostProcessStage({
            name: 'mib_dof',
            fragmentShader: window.__MIB_DOF_FRAG,
            uniforms: { ...DEFAULT_DOF },
        }));
        dofStage.enabled = false;
        return dofStage;
    }

    function captureCamera() {
        const c = scene.camera;
        return {
            destination: [c.positionWC.x, c.positionWC.y, c.positionWC.z],
            orientation: { heading: c.heading, pitch: c.pitch, roll: c.roll },
        };
    }

    function captureFocusFromPick() {
        const w = scene.canvas.clientWidth;
        const h = scene.canvas.clientHeight;
        const center = new Cesium.Cartesian2(w / 2, h / 2);
        const picked = scene.pickPosition(center);
        if (!picked) return DEFAULT_DOF.focusDistance;
        return Cesium.Cartesian3.distance(scene.camera.positionWC, picked);
    }

    function load() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
        catch { return []; }
    }
    function persist(views) {
        localStorage.setItem(STORE_KEY, JSON.stringify(views));
    }

    function save(name, opts = {}) {
        const cam = captureCamera();
        const focusDistance = opts.autoFocus !== false ? captureFocusFromPick() : DEFAULT_DOF.focusDistance;
        const view = {
            id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
            name: name || `View ${new Date().toLocaleTimeString()}`,
            createdAt: Date.now(),
            camera: cam,
            dof: {
                ...DEFAULT_DOF,
                ...(opts.dof || {}),
                focusDistance,
                enabled: opts.dof?.enabled ?? true,
            },
        };
        const views = load();
        views.push(view);
        persist(views);
        document.dispatchEvent(new CustomEvent('views:changed', { detail: { view, action: 'save' } }));
        return view;
    }

    function apply(view, { duration = 1.5 } = {}) {
        ensureStage();
        const dest = new Cesium.Cartesian3(...view.camera.destination);
        const applyDof = () => {
            dofStage.enabled = !!view.dof.enabled;
            // Nur bekannte Uniforms setzen
            for (const k of Object.keys(DEFAULT_DOF)) {
                if (k === 'enabled') continue;
                if (view.dof[k] !== undefined) dofStage.uniforms[k] = view.dof[k];
            }
        };
        if (duration > 0) {
            if (typeof WalkMode !== 'undefined' && WalkMode.isEnabled()) WalkMode.toggle(false);
            scene.camera.flyTo({
                destination: dest,
                orientation: view.camera.orientation,
                duration,
                complete: applyDof,
            });
        } else {
            scene.camera.setView({ destination: dest, orientation: view.camera.orientation });
            applyDof();
        }
    }

    function remove(id) {
        persist(load().filter(v => v.id !== id));
        document.dispatchEvent(new CustomEvent('views:changed', { detail: { id, action: 'remove' } }));
    }

    function setDofLive(partial = {}) {
        ensureStage();
        if (partial.enabled !== undefined) dofStage.enabled = !!partial.enabled;
        for (const k of Object.keys(DEFAULT_DOF)) {
            if (k === 'enabled') continue;
            if (partial[k] !== undefined) dofStage.uniforms[k] = partial[k];
        }
    }

    window.Views = {
        DEFAULT_DOF,
        init(bimViewer) {
            const v = bimViewer?.viewer || bimViewer;
            if (!v || !v.scene) throw new Error('Views.init: BimViewer.viewer missing');
            viewer = v;
            scene = v.scene;
            ensureStage();
            return this;
        },
        list: load,
        save,
        apply,
        remove,
        setDofLive,
        getStage: () => dofStage,
    };
})();
