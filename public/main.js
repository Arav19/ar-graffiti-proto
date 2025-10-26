// public/main.js
// Surfaceless AR Graffiti — floor-locked 2D canvas, press-and-hold spray, Firebase realtime sync.
// Single-file, defensive, DOMContentLoaded wrapper.

import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  onChildAdded,
  onChildRemoved,
  onValue
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

/* ================= FIREBASE CONFIG ================= */
const firebaseConfig = {
  apiKey: "AIzaSyBCzRpUX5mexhGj5FzqEWKoFAdljNJdbHE",
  authDomain: "surfaceless-firebase.firebaseapp.com",
  databaseURL: "https://surfaceless-firebase-default-rtdb.firebaseio.com",
  projectId: "surfaceless-firebase",
  storageBucket: "surfaceless-firebase.firebasestorage.app",
  messagingSenderId: "91893983357",
  appId: "1:91893983357:web:a823ba9f5874bede8b6914"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const planesRef = ref(db, "planes");

/* ===== Prevent duplicate execution (extensions/HMR) ===== */
if (window.__surfaceless_main_loaded) {
  console.warn("main.js already executed; skipping re-run.");
} else {
  window.__surfaceless_main_loaded = true;

  window.addEventListener("DOMContentLoaded", () => {
    console.log("DOM loaded — starting app bootstrap");

    // DOM elements
    const enableCameraBtn = document.getElementById("enableCameraBtn");
    const cameraSelect = document.getElementById("cameraSelect");
    const placeCanvasBtn = document.getElementById("placeCanvasBtn");
    const clearBtn = document.getElementById("clearBtn");
    const colorPicker = document.getElementById("colorPicker");
    const brushRange = document.getElementById("brushRange");
    const statusEl = document.getElementById("status");
    const hintEl = document.getElementById("hint");
    const videoEl = document.getElementById("camera-feed");
    const canvasEl = document.getElementById("three-canvas");

    if (!canvasEl) {
      console.error("three-canvas not found in DOM");
      if (statusEl) statusEl.textContent = "Error: canvas missing";
      return;
    }

    // initial UI text
    statusEl && (statusEl.textContent = "Ready — Enable Cam, Place Canvas, then hold to spray");

    /* ===== Camera state ===== */
    let camVideo = videoEl || null;
    let camStream = null;
    let chosenDeviceId = null;

    /* ===== THREE.js setup ===== */
    const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0); // transparent
    renderer.outputEncoding = THREE.sRGBEncoding;

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
    camera.position.set(0, 1.6, 0);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    scene.add(hemi);

    /* ===== Helpers: reticle, crosshair, plane construction ===== */
    function makeReticle(radius = 0.18) {
      const geo = new THREE.RingGeometry(radius * 0.85, radius, 32).rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.95 });
      const r = new THREE.Mesh(geo, mat); r.visible = false; scene.add(r); return r;
    }
    function makeCross(radius = 0.06) {
      const geo = new THREE.CircleGeometry(radius, 24).rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ffd0, transparent: true, opacity: 0.45 });
      const m = new THREE.Mesh(geo, mat); m.visible = false; scene.add(m); return m;
    }
    const reticle = makeReticle();
    const crosshair = makeCross();

    function createDrawingPlaneMesh(widthMeters = 3, heightMeters = 3, texSize = 2048) {
      const c = document.createElement("canvas");
      c.width = texSize; c.height = texSize;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, texSize, texSize);
      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.flipY = false;
      const geom = new THREE.PlaneGeometry(widthMeters, heightMeters);
      const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, roughness: 1, metalness: 0 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0;
      mesh.userData = { canvas: c, ctx, tex, w: texSize, h: texSize, widthMeters, heightMeters };
      return mesh;
    }

    function makeGridMesh(size = 3, divisions = 12) {
      const g = new THREE.GridHelper(size, divisions, 0x999999, 0x333333);
      g.material.opacity = 0.35; g.material.transparent = true; g.rotation.x = -Math.PI / 2; g.position.y = 0.002;
      return g;
    }

    /* ===== State ===== */
    const planeObjects = new Map(); // planeId -> {mesh,meta,grid}
    let localPlacedPlaneId = null;
    let localPlaneMesh = null;
    let localGrid = null;

    let spraying = false;
    let samplingTimer = null;
    let strokeBuffer = [];
    let currentStrokeId = null;
    let lastSamplePoint = null;

    /* ===== Device orientation -> camera quaternion helper ===== */
    const zee = new THREE.Vector3(0, 0, 1);
    const euler = new THREE.Euler();
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    function setObjectQuaternion(quaternion, alpha, beta, gamma, orient) {
      const degToRad = Math.PI / 180;
      const _x = beta ? beta * degToRad : 0;
      const _y = alpha ? alpha * degToRad : 0;
      const _z = gamma ? gamma * degToRad : 0;
      euler.set(_x, _y, _z, 'ZXY');
      quaternion.setFromEuler(euler);
      quaternion.multiply(q1);
      quaternion.multiply(q0.setFromAxisAngle(zee, -orient));
    }
    let screenOrientation = window.orientation || 0;
    window.addEventListener('orientationchange', () => screenOrientation = window.orientation || 0);

    function handleDeviceOrientationEvent(ev) {
      if (!ev) return;
      setObjectQuaternion(camera.quaternion, ev.alpha, ev.beta, ev.gamma, screenOrientation || 0);
    }
    function startOrientationWatcher() {
      // Some iOS versions require requestPermission from a user gesture; we attempt it when enabling camera.
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        // Do not call here (must be inside user gesture). We'll call requestPermission() from the Enable Cam click.
        window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true);
      } else {
        window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true);
      }
    }

    /* ===== Ray to floor (y = 0) ===== */
    function computeReticlePointOnFloor() {
      const origin = new THREE.Vector3(); camera.getWorldPosition(origin);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      if (Math.abs(dir.y) < 1e-6) return null;
      const t = - origin.y / dir.y;
      if (t <= 0) return null;
      return origin.clone().add(dir.multiplyScalar(t));
    }

    /* ===== Painting to canvas texture ===== */
    function paintCircleOnMesh(mesh, u, v, color, radiusPx) {
      if (!mesh || !mesh.userData || !mesh.userData.ctx) return;
      const ctx = mesh.userData.ctx;
      const x = Math.round(u * mesh.userData.w);
      const y = Math.round((1 - v) * mesh.userData.h);
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
      ctx.fill();
      mesh.userData.tex.needsUpdate = true;
    }

    function worldToPlaneUV(mesh, worldPos) {
      const local = worldPos.clone();
      mesh.worldToLocal(local);
      const halfW = mesh.userData.widthMeters / 2;
      const halfH = mesh.userData.heightMeters / 2;
      const u = (local.x + halfW) / mesh.userData.widthMeters;
      const v = (local.z + halfH) / mesh.userData.heightMeters;
      return { u: THREE.MathUtils.clamp(u, 0, 1), v: THREE.MathUtils.clamp(1 - v, 0, 1) };
    }

    /* ===== Firebase helpers ===== */
    async function createStrokeForPlane(planeId, color, width) {
      const strokesRef = ref(db, `planes/${planeId}/strokes`);
      const strokeRef = push(strokesRef);
      await set(strokeRef, { color, width, createdAt: Date.now() });
      return strokeRef.key;
    }
    async function pushPointsForStroke(planeId, strokeId, points) {
      const pointsRefPath = `planes/${planeId}/strokes/${strokeId}/points`;
      for (const p of points) await push(ref(db, pointsRefPath), { u: p.u, v: p.v, t: Date.now() });
    }

    function listenStrokesForPlane(planeId, mesh) {
      const strokesRef = ref(db, `planes/${planeId}/strokes`);
      onChildAdded(strokesRef, (sSnap) => {
        const meta = sSnap.val();
        const strokeId = sSnap.key;
        const ptsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
        onValue(ptsRef, (ptsSnap) => {
          const ptsObj = ptsSnap.val(); if (!ptsObj) return;
          const arr = Object.values(ptsObj).map(p => ({ u: p.u, v: p.v }));
          // draw small circles for each point
          for (let i = 0; i < arr.length; i++) paintCircleOnMesh(mesh, arr[i].u, arr[i].v, meta.color || "#ffffff", meta.width || 8);
        });
      });
    }

    /* ===== Handle incoming planes (remote) ===== */
    onChildAdded(planesRef, (snap) => {
      const id = snap.key; const meta = snap.val(); if (!meta) return; if (planeObjects.has(id)) return;
      const mesh = createDrawingPlaneMesh(meta.widthMeters || 3, meta.heightMeters || 3);
      mesh.name = `plane-${id}`;
      if (meta.pos && typeof meta.pos.x === 'number') mesh.position.set(meta.pos.x, 0, meta.pos.z);
      else {
        const rp = computeReticlePointOnFloor();
        if (rp) mesh.position.set(rp.x, 0, rp.z); else mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
      }
      scene.add(mesh);
      const grid = makeGridMesh(mesh.userData.widthMeters, Math.round(mesh.userData.widthMeters * 4));
      grid.position.copy(mesh.position);
      scene.add(grid);
      planeObjects.set(id, { mesh, meta, grid });
      listenStrokesForPlane(id, mesh);
    });

    onChildRemoved(planesRef, (snap) => {
      const id = snap.key; const obj = planeObjects.get(id);
      if (obj) { scene.remove(obj.mesh); if (obj.grid) scene.remove(obj.grid); planeObjects.delete(id); }
    });

    /* ===== Create local plane and push (Place Canvas) ===== */
    async function createLocalPlaneAndPush() {
      if (localPlacedPlaneId && planeObjects.has(localPlacedPlaneId)) return localPlacedPlaneId;
      const rp = computeReticlePointOnFloor();
      const mesh = createDrawingPlaneMesh(3, 3);
      if (rp) mesh.position.set(rp.x, 0, rp.z); else mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
      scene.add(mesh); localPlaneMesh = mesh;
      localGrid = makeGridMesh(mesh.userData.widthMeters, Math.round(mesh.userData.widthMeters * 4)); localGrid.position.copy(mesh.position); scene.add(localGrid);
      const meta = { createdAt: Date.now(), widthMeters: mesh.userData.widthMeters, heightMeters: mesh.userData.heightMeters, pos: { x: mesh.position.x, z: mesh.position.z } };
      const newRef = push(planesRef); await set(newRef, meta);
      localPlacedPlaneId = newRef.key; planeObjects.set(localPlacedPlaneId, { mesh, meta, grid: localGrid });
      listenStrokesForPlane(localPlacedPlaneId, mesh);
      console.log("Created local plane:", localPlacedPlaneId, meta);
      return localPlacedPlaneId;
    }

    /* ===== Sampling & paint loop ===== */
    function sampleAndPaint() {
      if (!localPlacedPlaneId) return;
      const pt = computeReticlePointOnFloor(); if (!pt) return;
      const planeObj = planeObjects.get(localPlacedPlaneId); if (!planeObj) return;
      const uv = worldToPlaneUV(planeObj.mesh, pt);
      const brushPx = parseInt(brushRange?.value || 12, 10) || 12;
      const color = (colorPicker?.value) ? colorPicker.value : "#00ffd0";
      if (lastSamplePoint) {
        const dist = Math.hypot(lastSamplePoint.u - uv.u, lastSamplePoint.v - uv.v);
        const steps = Math.max(1, Math.floor(dist * 200));
        for (let i = 0; i <= steps; i++) {
          const t = i / Math.max(1, steps);
          const iu = THREE.MathUtils.lerp(lastSamplePoint.u, uv.u, t);
          const iv = THREE.MathUtils.lerp(lastSamplePoint.v, uv.v, t);
          paintCircleOnMesh(planeObj.mesh, iu, iv, color, brushPx);
          strokeBuffer.push({ u: iu, v: iv });
        }
      } else {
        paintCircleOnMesh(planeObj.mesh, uv.u, uv.v, color, brushPx);
        strokeBuffer.push({ u: uv.u, v: uv.v });
      }
      lastSamplePoint = uv;
      if (strokeBuffer.length >= 8 && currentStrokeId) {
        const flush = strokeBuffer.splice(0, strokeBuffer.length);
        pushPointsForStroke(localPlacedPlaneId, currentStrokeId, flush).catch(e => console.warn(e));
      }
    }

    async function startSpraying() {
      if (spraying) return;
      if (!localPlacedPlaneId) { statusEl && (statusEl.textContent = "Placing canvas..."); await createLocalPlaneAndPush(); statusEl && (statusEl.textContent = "Canvas placed — hold to spray"); }
      spraying = true; lastSamplePoint = null; strokeBuffer = [];
      const color = (colorPicker?.value) ? colorPicker.value : "#00ffd0"; const width = parseInt(brushRange?.value || 12, 10) || 12;
      currentStrokeId = await createStrokeForPlane(localPlacedPlaneId, color, width);
      samplingTimer = setInterval(sampleAndPaint, 60);
      statusEl && (statusEl.textContent = "Spraying...");
    }

    async function stopSpraying() {
      if (!spraying) return;
      spraying = false;
      if (samplingTimer) { clearInterval(samplingTimer); samplingTimer = null; }
      if (strokeBuffer.length > 0 && currentStrokeId) {
        const buf = strokeBuffer.splice(0, strokeBuffer.length);
        await pushPointsForStroke(localPlacedPlaneId, currentStrokeId, buf).catch(e => console.warn(e));
      }
      currentStrokeId = null;
      lastSamplePoint = null;
      statusEl && (statusEl.textContent = "Stopped");
    }

    /* ===== Camera helpers ===== */
    async function getCameras() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(d => d.kind === 'videoinput');
      } catch (e) { console.warn("enumerateDevices failed", e); return []; }
    }

    async function startCamera(deviceId = null) {
      try {
        if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
        const constraints = deviceId ? { video: { deviceId: { exact: deviceId } }, audio: false } : { video: { facingMode: { ideal: "environment" } }, audio: false };
        camStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!camVideo) {
          camVideo = document.createElement('video');
          camVideo.id = "camVideo";
          camVideo.autoplay = true;
          camVideo.playsInline = true;
          camVideo.muted = true;
          camVideo.style.position = 'absolute';
          camVideo.style.inset = '0';
          camVideo.style.width = '100%';
          camVideo.style.height = '100%';
          camVideo.style.objectFit = 'cover';
          document.getElementById("ar-container")?.appendChild(camVideo);
          // keep reference in variable
          camVideo = document.getElementById("camera-feed");
        }
        // link to existing video element
        camVideo = document.getElementById("camera-feed");
        camVideo.srcObject = camStream;
        try { await camVideo.play(); } catch (e) { console.warn("video play failed", e); }
        statusEl && (statusEl.textContent = "Camera ready");
      } catch (err) {
        console.error("startCamera error", err);
        statusEl && (statusEl.textContent = "Camera error — see console");
        throw err;
      }
    }

    /* ===== Enable Cam button: must be user gesture on mobile ===== */
    if (enableCameraBtn) {
      enableCameraBtn.addEventListener("click", async () => {
        enableCameraBtn.disabled = true;
        statusEl && (statusEl.textContent = "Requesting camera & motion permission...");
        try {
          // On iOS 13+ DeviceOrientationEvent.requestPermission must be called from user gesture:
          if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
            try {
              const perm = await DeviceOrientationEvent.requestPermission();
              console.log("DeviceOrientation permission:", perm);
              if (perm !== "granted") console.warn("DeviceOrientation permission denied");
            } catch (e) {
              console.warn("DeviceOrientation requestPermission failed", e);
            }
          }
          // Start camera
          await startCamera(null);
          // Fill camera select if multiple cameras
          const cams = await getCameras();
          if (cameraSelect && cams.length > 1) {
            cameraSelect.style.display = "";
            cameraSelect.innerHTML = "";
            cams.forEach((c, idx) => {
              const opt = document.createElement("option");
              opt.value = c.deviceId;
              opt.text = c.label || ("Camera " + (idx + 1));
              cameraSelect.appendChild(opt);
            });
            cameraSelect.addEventListener("change", async () => {
              chosenDeviceId = cameraSelect.value;
              try { await startCamera(chosenDeviceId); statusEl && (statusEl.textContent = "Camera switched"); } catch (e) { console.warn(e); }
            });
          }
          startOrientationWatcher();
          statusEl && (statusEl.textContent = "Camera & motion ready — place canvas or hold to spray");
        } catch (e) {
          console.error("Enable Cam failed", e);
          enableCameraBtn.disabled = false;
          statusEl && (statusEl.textContent = "Camera permission required");
        }
      });
    } else {
      // try implicit camera start (only works on some browsers)
      (async () => {
        try {
          await startCamera(null);
          startOrientationWatcher();
          statusEl && (statusEl.textContent = "Camera ready — place canvas or hold to spray");
        } catch (e) {
          console.warn("implicit camera start failed", e);
          statusEl && (statusEl.textContent = "Tap Enable Cam");
        }
      })();
    }

    /* ===== Place Canvas button: sample GPS & push meta ===== */
    if (placeCanvasBtn) {
      placeCanvasBtn.addEventListener("click", async () => {
        placeCanvasBtn.disabled = true;
        statusEl && (statusEl.textContent = "Sampling GPS — hold still...");
        try {
          // sample averaged GPS
          async function sampleAndAverageGPS(n = 5, delayMs = 300) {
            const samples = [];
            function getCurrentPositionPromise() {
              return new Promise((resolve, reject) => {
                if (!navigator.geolocation) return reject(new Error("No geolocation"));
                navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
              });
            }
            for (let i = 0; i < n; i++) {
              try { const p = await getCurrentPositionPromise(); samples.push(p.coords); } catch (e) { /* ignore */ }
              await new Promise(r => setTimeout(r, delayMs));
            }
            if (!samples.length) throw new Error("No GPS samples");
            const avg = samples.reduce((acc, s) => { acc.lat += s.latitude; acc.lon += s.longitude; acc.alt += (s.altitude || 0); return acc; }, { lat: 0, lon: 0, alt: 0 });
            avg.lat /= samples.length; avg.lon /= samples.length; avg.alt /= samples.length; return avg;
          }

          const avg = await sampleAndAverageGPS(5, 300);
          // create plane visually & push metadata
          await createLocalPlaneAndPush();
          const meta = { createdAt: Date.now(), lat: avg.lat, lon: avg.lon, alt: avg.alt, widthMeters: 3.0, heightMeters: 3.0 };
          const newRef = push(planesRef); await set(newRef, meta);
          statusEl && (statusEl.textContent = "Canvas placed (geo saved). Hold to spray");
        } catch (e) {
          console.warn("GPS failed", e);
          statusEl && (statusEl.textContent = "GPS failed — placed without geo");
          await createLocalPlaneAndPush();
        } finally {
          placeCanvasBtn.disabled = false;
        }
      });
    }

    /* ===== Clear All ===== */
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        try {
          await set(ref(db, "planes"), null);
          planeObjects.forEach(p => { scene.remove(p.mesh); if (p.grid) scene.remove(p.grid); });
          planeObjects.clear();
          if (localPlaneMesh) { scene.remove(localPlaneMesh); localPlaneMesh = null; }
          if (localGrid) { scene.remove(localGrid); localGrid = null; }
          localPlacedPlaneId = null;
          statusEl && (statusEl.textContent = "Cleared all");
        } catch (e) { console.warn("clear failed", e); }
      });
    }

    /* ===== Input: press-and-hold for spray (pointer & keyboard & volume fallback) ===== */
    function onPointerDown(e) { e.preventDefault(); startSpraying().catch(err => console.warn(err)); }
    function onPointerUp(e) { e.preventDefault(); stopSpraying().catch(err => console.warn(err)); }

    canvasEl.addEventListener("pointerdown", onPointerDown);
    canvasEl.addEventListener("pointerup", onPointerUp);
    canvasEl.addEventListener("pointercancel", onPointerUp);
    canvasEl.addEventListener("pointerleave", onPointerUp);

    // keyboard fallback
    window.addEventListener("keydown", (ev) => {
      if (ev.code === "Space" || ev.code === "ArrowUp" || ev.code === "ArrowDown") {
        if (!spraying) { ev.preventDefault(); startSpraying().catch(()=>{}); }
      }
      if (ev.key === "AudioVolumeDown" || ev.key === "AudioVolumeUp") {
        if (!spraying) startSpraying().catch(()=>{});
      }
    });
    window.addEventListener("keyup", (ev) => {
      if (ev.code === "Space" || ev.code === "ArrowUp" || ev.code === "ArrowDown") {
        if (spraying) { ev.preventDefault(); stopSpraying().catch(()=>{}); }
      }
      if (ev.key === "AudioVolumeDown" || ev.key === "AudioVolumeUp") {
        if (spraying) stopSpraying().catch(()=>{});
      }
    });

    /* ===== Render loop & reticle update ===== */
    function renderLoop() {
      requestAnimationFrame(renderLoop);
      const aim = computeReticlePointOnFloor();
      if (aim) {
        reticle.visible = true; reticle.position.copy(aim);
        crosshair.visible = true; crosshair.position.copy(aim);
      } else {
        reticle.visible = false;
        if (localPlacedPlaneId && planeObjects.has(localPlacedPlaneId)) {
          const obj = planeObjects.get(localPlacedPlaneId);
          crosshair.visible = true; crosshair.position.copy(obj.mesh.position);
        } else {
          crosshair.visible = false;
        }
      }
      renderer.render(scene, camera);
    }
    renderLoop();

    /* ===== Window resize ===== */
    window.addEventListener("resize", () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    });

    // init done
    statusEl && (statusEl.textContent = "Ready — Enable Cam, Place Canvas, then hold to spray");
    console.log("Main module loaded successfully");
  }); // DOMContentLoaded
} // double-run guard
