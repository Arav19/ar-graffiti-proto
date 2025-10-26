// public/main.js
// Full app: Gyro-aim brush on a flat ground canvas + Firebase realtime sync
// Defensive, single-file, DOMContentLoaded wrapper.

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

/* ================ MAIN ENTRY ================ */
window.addEventListener("DOMContentLoaded", () => {
  console.log("DOM loaded — starting app bootstrap");

  /* ================= DOM (safe) ================= */
  const enableCameraBtn = document.getElementById("enableCameraBtn"); // optional
  const cameraSelect = document.getElementById("cameraSelect"); // optional
  const startBtn = document.getElementById("startBtn"); // required in your HTML
  const stopBtn = document.getElementById("stopBtn"); // required
  const clearBtn = document.getElementById("clearBtn"); // required
  const statusEl = document.getElementById("status") || document.createElement("div");
  const colorPicker = document.getElementById("colorPicker"); // optional
  const brushRange = document.getElementById("brushRange"); // optional
  const videoEl = document.getElementById("camera-feed"); // optional but present in your HTML
  const canvasEl = document.getElementById("three-canvas"); // required in your HTML

  if (!startBtn || !stopBtn || !clearBtn || !canvasEl) {
    console.error("Required UI elements missing (startBtn/stopBtn/clearBtn/three-canvas). Check index.html");
    if (statusEl) statusEl.textContent = "UI missing - check console";
    return;
  }

  // Disable start until camera ready
  startBtn.disabled = true;
  stopBtn.style.display = "none";

  /* ================= Camera state ================= */
  let camVideo = videoEl || null;
  let camStream = null;
  let chosenDeviceId = null;

  /* ================= Three.js scene ================= */
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.outputEncoding = THREE.sRGBEncoding;

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
  camera.position.set(0, 1.6, 0);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
  scene.add(hemi);

  /* ====== reticle + glowing circle + plane maker ====== */
  function makeReticle(radius = 0.2) {
    const geo = new THREE.RingGeometry(radius * 0.85, radius, 32).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.95 });
    const ring = new THREE.Mesh(geo, mat);
    ring.visible = false;
    scene.add(ring);
    return ring;
  }
  function makeGlowingCircle(radius = 0.25) {
    const geo = new THREE.CircleGeometry(radius, 32).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ffd0, transparent: true, opacity: 0.35 });
    const c = new THREE.Mesh(geo, mat);
    c.visible = false;
    scene.add(c);
    return c;
  }
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
    mesh.rotation.x = -Math.PI / 2; // lie flat on ground
    mesh.userData = { canvas: c, ctx, tex, w: texSize, h: texSize, widthMeters, heightMeters };
    return mesh;
  }

  const reticle = makeReticle();
  const glowingCircle = makeGlowingCircle(0.25);

  /* ================= State ================= */
  const planeObjects = new Map(); // planeId -> { mesh, meta, grid }
  let localPlacedPlaneId = null;
  let localPlaneMesh = null;

  let brushActive = false;
  let brushSamplingTimer = null;
  let brushPath = [];
  let strokePointsBuffer = [];
  let currentStrokeId = null;

  /* ================= Device orientation (for aiming) ================= */
  let lastHeading = 0;
  function startHeadingWatcher() {
    function h(e) { if (e.alpha != null) lastHeading = e.alpha; }
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission?.().then(p => { if (p === "granted") window.addEventListener("deviceorientation", h, true); }).catch(() => {});
    } else {
      window.addEventListener("deviceorientation", h, true);
    }
  }

  // DeviceOrientation -> camera quaternion (adapted from DeviceOrientationControls)
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
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission?.().then(p => { if (p === "granted") window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true); }).catch(() => {});
    } else {
      window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true);
    }
  }

  /* ================= Ray / reticle math ================= */
  function computeReticlePoint() {
    const origin = new THREE.Vector3();
    camera.getWorldPosition(origin);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    if (Math.abs(dir.y) < 1e-5) return null;
    const t = - (origin.y / dir.y);
    if (t <= 0) return null;
    return origin.clone().add(dir.multiplyScalar(t));
  }

  /* ================= Drawing on plane texture ================= */
  function drawSegmentOnPlaneMesh(mesh, pts, color = '#ffffff', widthPx = 12) {
    if (!mesh || !mesh.userData || !mesh.userData.ctx) return;
    const ctx = mesh.userData.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (!pts.length) return;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const u = pts[i].u, v = pts[i].v;
      const x = Math.round(u * mesh.userData.w);
      const y = Math.round((1 - v) * mesh.userData.h);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    mesh.userData.tex.needsUpdate = true;
  }

  // world -> uv mapping on the single plane mesh
  function worldToPlaneUV(mesh, worldPos) {
    const clone = worldPos.clone();
    mesh.worldToLocal(clone);
    const halfW = mesh.userData.widthMeters / 2;
    const halfH = mesh.userData.heightMeters / 2;
    const u = (clone.x + halfW) / mesh.userData.widthMeters;
    const v = (clone.z + halfH) / mesh.userData.heightMeters;
    return { u: THREE.MathUtils.clamp(u, 0, 1), v: THREE.MathUtils.clamp(1 - v, 0, 1) };
  }

  /* ================= Firebase listeners for planes & strokes ================= */
  function listenStrokesForPlane(planeId, mesh) {
    const strokesRef = ref(db, `planes/${planeId}/strokes`);
    onChildAdded(strokesRef, (sSnap) => {
      const strokeId = sSnap.key;
      const meta = sSnap.val();
      const ptsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
      onValue(ptsRef, (ptsSnap) => {
        const ptsObj = ptsSnap.val();
        if (!ptsObj) return;
        const arr = Object.values(ptsObj).map(p => ({ u: p.u, v: p.v }));
        drawSegmentOnPlaneMesh(mesh, arr, meta.color || '#ffffff', meta.width || 12);
      });
    });
  }

  onChildAdded(planesRef, (snap) => {
    const id = snap.key;
    const meta = snap.val();
    if (!meta) return;
    if (planeObjects.has(id)) return;
    const mesh = createDrawingPlaneMesh(meta.widthMeters || 3, meta.heightMeters || 3);
    mesh.name = `plane-${id}`;

    // If meta has lat/lon, we try georeference (best-effort). If not, place at provided pos in meta or fallback.
    if (meta.pos && typeof meta.pos.x === 'number') {
      mesh.position.set(meta.pos.x, 0, meta.pos.z);
      scene.add(mesh);
      planeObjects.set(id, { mesh, meta, grid: null });
      listenStrokesForPlane(id, mesh);
    } else {
      // fallback: place slightly in front of the camera
      const rp = computeReticlePoint();
      if (rp) mesh.position.set(rp.x, 0, rp.z); else mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
      scene.add(mesh);
      planeObjects.set(id, { mesh, meta, grid: null });
      listenStrokesForPlane(id, mesh);
    }
  });

  onChildRemoved(planesRef, (snap) => {
    const id = snap.key; const obj = planeObjects.get(id);
    if (obj) { scene.remove(obj.mesh); if (obj.grid) scene.remove(obj.grid); planeObjects.delete(id); }
  });

  /* ================= Create new plane (auto-place) and push to Firebase ================= */
  async function createLocalPlaneAndPush() {
    // if we already placed one locally, return id
    if (localPlacedPlaneId && planeObjects.has(localPlacedPlaneId)) return localPlacedPlaneId;

    // try to get a reticle point on ground
    const rp = computeReticlePoint();
    const mesh = createDrawingPlaneMesh(3, 3);
    if (rp) mesh.position.set(rp.x, 0, rp.z);
    else mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);

    scene.add(mesh);
    localPlaneMesh = mesh;

    // push meta (no geolocation now) — we include pos so remote devices can position roughly
    const meta = { createdAt: Date.now(), widthMeters: 3.0, heightMeters: 3.0, pos: { x: mesh.position.x, z: mesh.position.z } };
    const newRef = push(planesRef);
    await set(newRef, meta);
    localPlacedPlaneId = newRef.key;
    planeObjects.set(localPlacedPlaneId, { mesh, meta, grid: null });
    listenStrokesForPlane(localPlacedPlaneId, mesh);
    console.log("Created plane", localPlacedPlaneId, meta);
    return localPlacedPlaneId;
  }

  /* ================= Firebase stroke helpers ================= */
  async function createStrokeForPlane(planeId, color, width) {
    const strokesRef = ref(db, `planes/${planeId}/strokes`);
    const strokeRef = push(strokesRef);
    await set(strokeRef, { color, width, createdAt: Date.now() });
    return strokeRef.key;
  }
  async function pushPointsForStroke(planeId, strokeId, points) {
    const pointsRefPath = `planes/${planeId}/strokes/${strokeId}/points`;
    for (const p of points) {
      await push(ref(db, pointsRefPath), { u: p.u, v: p.v, t: Date.now() });
    }
  }

  /* ================= Drawing lifecycle ================= */
  async function startDrawing() {
    // create plane if none
    if (!localPlacedPlaneId) {
      if (statusEl) statusEl.textContent = "Placing canvas...";
      await createLocalPlaneAndPush();
      if (statusEl) statusEl.textContent = "Canvas placed — drawing enabled";
    }

    if (!localPlacedPlaneId) { if (statusEl) statusEl.textContent = "No canvas"; return; }
    brushActive = true;
    startBtn.style.display = "none";
    stopBtn.style.display = "";
    if (statusEl) statusEl.textContent = "Drawing — move the phone to spray";

    const strokeId = await createStrokeForPlane(localPlacedPlaneId, (colorPicker && colorPicker.value) ? colorPicker.value : "#ffffff", (brushRange && parseInt(brushRange.value, 10)) || 12);
    currentStrokeId = strokeId;
    brushPath = [];
    strokePointsBuffer = [];

    brushSamplingTimer = setInterval(() => {
      const pt = computeReticlePoint();
      if (!pt) return;
      const planeObj = planeObjects.get(localPlacedPlaneId);
      if (!planeObj) return;
      const uv = worldToPlaneUV(planeObj.mesh, pt);
      strokePointsBuffer.push(uv);
      brushPath.push(uv);
      const recent = brushPath.slice(-3);
      drawSegmentOnPlaneMesh(planeObj.mesh, recent, (colorPicker && colorPicker.value) ? colorPicker.value : "#ffffff", (brushRange && parseInt(brushRange.value, 10)) || 12);
      if (strokePointsBuffer.length >= 6) {
        const flush = strokePointsBuffer.splice(0, strokePointsBuffer.length);
        pushPointsForStroke(localPlacedPlaneId, strokeId, flush).catch(e => console.warn(e));
      }
    }, 60);
  }

  async function stopDrawing() {
    if (!brushActive) return;
    brushActive = false;
    startBtn.style.display = "";
    stopBtn.style.display = "none";
    if (statusEl) statusEl.textContent = "Stopped";
    if (brushSamplingTimer) { clearInterval(brushSamplingTimer); brushSamplingTimer = null; }
    if (strokePointsBuffer.length > 0 && currentStrokeId) {
      const buf = strokePointsBuffer.splice(0, strokePointsBuffer.length);
      await pushPointsForStroke(localPlacedPlaneId, currentStrokeId, buf);
    }
    currentStrokeId = null;
    brushPath = [];
  }

  /* ================= Camera helpers (getUserMedia & iOS) ================= */
  async function getCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'videoinput');
    } catch (e) { return []; }
  }
  async function startCamera(deviceId = null) {
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    const constraints = deviceId ? { video: { deviceId: { exact: deviceId } }, audio: false } : { video: { facingMode: { ideal: "environment" } }, audio: false };
    camStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (!camVideo) {
      camVideo = document.createElement("video");
      camVideo.id = "camVideo";
      camVideo.autoplay = true;
      camVideo.playsInline = true;
      camVideo.muted = true;
      camVideo.style.zIndex = '0';
      camVideo.style.position = 'absolute';
      camVideo.style.top = 0;
      camVideo.style.left = 0;
      camVideo.style.width = '100%';
      camVideo.style.height = '100%';
      document.getElementById("ar-container")?.appendChild(camVideo);
    }
    camVideo.srcObject = camStream;
    try { await camVideo.play(); } catch (e) { console.warn("video autoplay blocked", e); }
  }

  /* ================= UI button wiring (defensive) ================= */
  if (enableCameraBtn) {
    enableCameraBtn.addEventListener("click", async () => {
      try {
        enableCameraBtn.disabled = true;
        if (statusEl) statusEl.textContent = "Requesting camera...";
        await startCamera(null);
        const cams = await getCameras();
        if (cameraSelect && cams.length > 1) {
          cameraSelect.style.display = "";
          cameraSelect.innerHTML = "";
          cams.forEach(c => {
            const opt = document.createElement("option");
            opt.value = c.deviceId; opt.text = c.label || ("Camera " + (cameraSelect.length + 1));
            cameraSelect.appendChild(opt);
          });
          cameraSelect.addEventListener("change", async () => {
            chosenDeviceId = cameraSelect.value;
            try { await startCamera(chosenDeviceId); if (statusEl) statusEl.textContent = "Camera switched"; } catch (e) { console.warn(e); }
          });
        }
        if (statusEl) statusEl.textContent = "Camera ready — start drawing";
        startHeadingWatcher(); startOrientationWatcher();
        startBtn.disabled = false;
      } catch (err) {
        console.error("Camera fail", err);
        if (statusEl) statusEl.textContent = "Camera permission required";
        if (enableCameraBtn) enableCameraBtn.disabled = false;
      }
    });
  } else {
    // If there's no enable button, start camera implicitly (attempt)
    (async () => {
      try {
        if (statusEl) statusEl.textContent = "Starting camera...";
        await startCamera(null);
        if (statusEl) statusEl.textContent = "Camera ready — start drawing";
        startHeadingWatcher(); startOrientationWatcher();
        startBtn.disabled = false;
      } catch (e) {
        console.warn("implicit camera start failed", e);
        if (statusEl) statusEl.textContent = "Tap Enable Camera";
      }
    })();
  }

  // start/stop/clear handlers (safe)
  startBtn.addEventListener("click", async () => {
    try {
      startBtn.disabled = true;
      await startDrawing();
    } catch (e) {
      console.error("startDrawing errored", e);
    } finally {
      startBtn.disabled = false;
    }
  });
  stopBtn.addEventListener("click", async () => { await stopDrawing(); });
  clearBtn.addEventListener("click", async () => {
    try {
      await set(ref(db, "planes"), null);
      planeObjects.forEach(p => { scene.remove(p.mesh); if (p.grid) scene.remove(p.grid); });
      planeObjects.clear();
      localPlacedPlaneId = null;
      localPlaneMesh = null;
      if (statusEl) statusEl.textContent = "Cleared all";
    } catch (e) { console.warn("clear failed", e); }
  });

  /* ================= Render loop ================= */
  function renderLoop() {
    requestAnimationFrame(renderLoop);
    const aim = computeReticlePoint();
    if (aim) {
      reticle.visible = true;
      reticle.position.copy(aim);
      glowingCircle.position.copy(aim);
      glowingCircle.visible = true;
    } else {
      reticle.visible = false;
      if (localPlacedPlaneId && planeObjects.has(localPlacedPlaneId)) {
        const obj = planeObjects.get(localPlacedPlaneId);
        glowingCircle.position.copy(obj.mesh.position);
        glowingCircle.visible = true;
      } else {
        glowingCircle.visible = false;
      }
    }
    renderer.render(scene, camera);
  }
  renderLoop();

  /* ================= Window resize ================= */
  window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  /* ================= Init status ================= */
  if (statusEl) statusEl.textContent = "Ready — enable camera, then Start Drawing";

  /* ================= Safety note for injected content scripts ================= */
  // If browser extensions inject content scripts that re-run your module, you might see duplicate-execution problems.
  // If you encounter "Identifier '...' has already been declared" errors in the console, test in Incognito (extensions off).
  console.log("Main module loaded successfully");
});
