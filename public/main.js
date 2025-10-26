// public/main.js
// Flat-floor AR graffiti with press-and-hold spray + Firebase realtime sync
// Uses THREE r0.171 and Firebase JS modular 11.x
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

/* ===== FIREBASE CONFIG (your project) ===== */
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

/* ===== Prevent double execution via extension injection ===== */
if (window.__surfaceless_main_loaded) {
  console.warn("main.js already executed; skipping re-run.");
} else {
  window.__surfaceless_main_loaded = true;

  window.addEventListener("DOMContentLoaded", () => {
    // DOM
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

    // Basic checks
    if (!canvasEl) {
      console.error("three-canvas not found");
      if (statusEl) statusEl.textContent = "Error: missing canvas";
      return;
    }

    // initial UI state
    if (statusEl) statusEl.textContent = "Ready — enable camera, place canvas";
    hintEl && (hintEl.style.display = '');

    // Camera state
    let camVideo = videoEl || null;
    let camStream = null;
    let chosenDeviceId = null;

    // Three.js setup
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

    // Reticle & glowing crosshair
    function makeReticle(radius = 0.15) {
      const geo = new THREE.RingGeometry(radius * 0.85, radius, 32).rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.95 });
      const r = new THREE.Mesh(geo, mat);
      r.visible = false;
      scene.add(r);
      return r;
    }
    function makeCross(radius = 0.06) {
      const geo = new THREE.CircleGeometry(radius, 24).rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ffd0, transparent: true, opacity: 0.45 });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      scene.add(m);
      return m;
    }

    const reticle = makeReticle(0.18);
    const crosshair = makeCross(0.06);

    // Floor plane (drawing plane)
    function createDrawingPlaneMesh(widthMeters = 3, heightMeters = 3, texSize = 2048) {
      const c = document.createElement("canvas");
      c.width = texSize; c.height = texSize;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, texSize, texSize);
      // subtle grid background for texture
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillRect(0, 0, texSize, texSize);

      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.flipY = false;

      const geom = new THREE.PlaneGeometry(widthMeters, heightMeters);
      const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, roughness: 1, metalness: 0 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2; // flat
      mesh.position.y = 0;
      mesh.userData = { canvas: c, ctx, tex, w: texSize, h: texSize, widthMeters, heightMeters };
      return mesh;
    }

    // Grid helper overlay (visualization)
    function makeGridMesh(size = 3, divisions = 12) {
      const g = new THREE.GridHelper(size, divisions, 0x999999, 0x333333);
      g.material.opacity = 0.35;
      g.material.transparent = true;
      g.rotation.x = -Math.PI / 2; // already grid lies in xz but ensure orientation
      g.position.y = 0.001; // slightly above plane to avoid z-fighting
      return g;
    }

    // State
    const planeObjects = new Map();
    let localPlacedPlaneId = null;
    let localPlaneMesh = null;
    let localGrid = null;

    // Drawing state
    let spraying = false; // press and hold state
    let samplingTimer = null;
    let strokeBuffer = [];
    let currentStrokeId = null;
    let lastSamplePoint = null;

    // Device orientation -> camera quaternion helper
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
        DeviceOrientationEvent.requestPermission?.().then(p => { if (p === "granted") window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true); }).catch(()=>{});
      } else {
        window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true);
      }
    }

    // Ray from camera center -> intersect floor y=0
    function computeReticlePointOnFloor() {
      const origin = new THREE.Vector3();
      camera.getWorldPosition(origin);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      if (Math.abs(dir.y) < 1e-6) return null;
      const t = - origin.y / dir.y;
      if (t <= 0) return null;
      return origin.clone().add(dir.multiplyScalar(t));
    }

    // Draw on mesh texture: spray as filled circles (gives spray look and allows thickness)
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

    // Map world pos -> plane UV (relative to mesh center)
    function worldToPlaneUV(mesh, worldPos) {
      const local = worldPos.clone();
      mesh.worldToLocal(local);
      const halfW = mesh.userData.widthMeters / 2;
      const halfH = mesh.userData.heightMeters / 2;
      const u = (local.x + halfW) / mesh.userData.widthMeters;
      const v = (local.z + halfH) / mesh.userData.heightMeters;
      return { u: THREE.MathUtils.clamp(u, 0, 1), v: THREE.MathUtils.clamp(1 - v, 0, 1) };
    }

    /* ======= Firebase stroke helpers (create stroke, push points in batches) ======= */
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

    /* ======= Listen remote planes & strokes ======= */
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
          // draw as series of small circles for visual consistency
          for (let i = 0; i < arr.length; i++) {
            paintCircleOnMesh(mesh, arr[i].u, arr[i].v, meta.color || '#ffffff', meta.width || 8);
          }
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
      // place using pos if available (we store pos on create), otherwise place at reticle/fallback
      if (meta.pos && typeof meta.pos.x === 'number') {
        mesh.position.set(meta.pos.x, 0, meta.pos.z);
      } else {
        const rp = computeReticlePointOnFloor();
        if (rp) mesh.position.set(rp.x, 0, rp.z); else mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
      }
      scene.add(mesh);
      // grid overlay for remote planes
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

    /* ======= Create & push local plane (Place Canvas) ======= */
    async function createLocalPlaneAndPush() {
      if (localPlacedPlaneId && planeObjects.has(localPlacedPlaneId)) return localPlacedPlaneId;
      const rp = computeReticlePointOnFloor();
      const mesh = createDrawingPlaneMesh(3, 3);
      if (rp) mesh.position.set(rp.x, 0, rp.z);
      else mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
      scene.add(mesh);
      localPlaneMesh = mesh;
      // add grid overlay locally
      localGrid = makeGridMesh(mesh.userData.widthMeters, Math.round(mesh.userData.widthMeters * 4));
      localGrid.position.copy(mesh.position);
      scene.add(localGrid);

      // push minimal meta (pos included)
      const meta = { createdAt: Date.now(), widthMeters: mesh.userData.widthMeters, heightMeters: mesh.userData.heightMeters, pos: { x: mesh.position.x, z: mesh.position.z } };
      const newRef = push(planesRef);
      await set(newRef, meta);
      localPlacedPlaneId = newRef.key;
      planeObjects.set(localPlacedPlaneId, { mesh, meta, grid: localGrid });
      listenStrokesForPlane(localPlacedPlaneId, mesh);
      console.log("Local plane created:", localPlacedPlaneId, meta);
      return localPlacedPlaneId;
    }

    /* ======= Drawing lifecycle: sampling & smoothing ======= */
    function sampleAndPaint() {
      if (!localPlacedPlaneId) return;
      const pt = computeReticlePointOnFloor();
      if (!pt || !planeObjects.has(localPlacedPlaneId)) return;
      const planeObj = planeObjects.get(localPlacedPlaneId);
      const uv = worldToPlaneUV(planeObj.mesh, pt);
      // brush size px: convert brushRange (meters->pixels). We'll keep it simple: use brushRange as px.
      const brushPx = parseInt(brushRange?.value || 12, 10) || 12;
      const color = (colorPicker?.value) ? colorPicker.value : "#00ffd0";
      // smoothing: if lastSamplePoint exists, interpolate N steps
      if (lastSamplePoint) {
        const steps = Math.max(1, Math.floor(THREE.MathUtils.euclideanDistance(lastSamplePoint.u, lastSamplePoint.v, uv.u, uv.v) * 60));
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

      // flush in small batches
      if (strokeBuffer.length >= 8 && currentStrokeId) {
        const flush = strokeBuffer.splice(0, strokeBuffer.length);
        pushPointsForStroke(localPlacedPlaneId, currentStrokeId, flush).catch(e => console.warn(e));
      }
    }

    async function startSpraying() {
      if (spraying) return;
      // ensure plane exists (auto-place if not)
      if (!localPlacedPlaneId) {
        statusEl && (statusEl.textContent = "Placing canvas...");
        await createLocalPlaneAndPush();
        statusEl && (statusEl.textContent = "Canvas placed — hold to spray");
      }
      if (!localPlacedPlaneId) { statusEl && (statusEl.textContent = "No canvas"); return; }
      spraying = true;
      lastSamplePoint = null;
      strokeBuffer = [];
      // create stroke node in Firebase
      const color = (colorPicker?.value) ? colorPicker.value : "#00ffd0";
      const width = parseInt(brushRange?.value || 12, 10) || 12;
      currentStrokeId = await createStrokeForPlane(localPlacedPlaneId, color, width);
      // sampling loop (aim-driven) every 60ms
      samplingTimer = setInterval(sampleAndPaint, 60);
      statusEl && (statusEl.textContent = "Spraying...");
    }

    async function stopSpraying() {
      if (!spraying) return;
      spraying = false;
      if (samplingTimer) { clearInterval(samplingTimer); samplingTimer = null; }
      // flush remaining
      if (strokeBuffer.length > 0 && currentStrokeId) {
        const buf = strokeBuffer.splice(0, strokeBuffer.length);
        await pushPointsForStroke(localPlacedPlaneId, currentStrokeId, buf).catch(e => console.warn(e));
      }
      currentStrokeId = null;
      lastSamplePoint = null;
      statusEl && (statusEl.textContent = "Stopped");
    }

    /* ======= Camera helpers ======= */
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
      }
      camVideo.srcObject = camStream;
      try { await camVideo.play(); } catch (e) { console.warn("video autoplay blocked", e); }
      statusEl && (statusEl.textContent = "Camera ready");
    }

    // If enable camera button exists, wire it, else try implicit start
    if (enableCameraBtn) {
      enableCameraBtn.addEventListener("click", async () => {
        enableCameraBtn.disabled = true;
        statusEl && (statusEl.textContent = "Requesting camera...");
        try {
          await startCamera(null);
          const cams = await getCameras();
          if (cameraSelect && cams.length > 1) {
            cameraSelect.style.display = "";
            cameraSelect.innerHTML = "";
            cams.forEach((c, idx) => {
              const opt = document.createElement('option'); opt.value = c.deviceId; opt.text = c.label || ("Camera " + (idx+1));
              cameraSelect.appendChild(opt);
            });
            cameraSelect.addEventListener('change', async () => {
              chosenDeviceId = cameraSelect.value;
              try { await startCamera(chosenDeviceId); statusEl && (statusEl.textContent = "Camera switched"); } catch (e) { console.warn(e); }
            });
          }
          startOrientationWatcher();
          startHeadingWatcher && startHeadingWatcher();
          statusEl && (statusEl.textContent = "Camera ready — Place canvas or hold to spray");
        } catch (e) {
          console.error("camera error", e);
          enableCameraBtn.disabled = false;
          statusEl && (statusEl.textContent = "Camera permission required");
        }
      });
    } else {
      (async () => {
        try { await startCamera(null); startOrientationWatcher(); statusEl && (statusEl.textContent = "Camera ready"); } catch (e) { console.warn("implicit camera start failed", e); statusEl && (statusEl.textContent = "Tap Enable Cam"); }
      })();
    }

    /* ======= UI wiring: Place, Clear ======= */
    if (placeCanvasBtn) {
      placeCanvasBtn.addEventListener("click", async () => {
        placeCanvasBtn.disabled = true;
        statusEl && (statusEl.textContent = "Sampling GPS — hold still...");
        // sample averaged GPS (best-effort) and push meta (lat/lon) — but plane pos still set to reticle
        try {
          // small inline sample routine
          async function sampleAndAverageGPS(n = 5, delayMs = 300) {
            const samples = [];
            function getCurrentPositionPromise() {
              return new Promise((resolve, reject) => {
                if (!navigator.geolocation) return reject(new Error("No geolocation"));
                navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
              });
            }
            for (let i = 0; i < n; i++) {
              try { const p = await getCurrentPositionPromise(); samples.push(p.coords); } catch (e) {}
              await new Promise(r => setTimeout(r, delayMs));
            }
            if (!samples.length) throw new Error("No GPS samples");
            const avg = samples.reduce((acc, s) => { acc.lat += s.latitude; acc.lon += s.longitude; acc.alt += (s.altitude || 0); return acc; }, { lat: 0, lon: 0, alt: 0 });
            avg.lat /= samples.length; avg.lon /= samples.length; avg.alt /= samples.length;
            return avg;
          }

          const avg = await sampleAndAverageGPS(5, 300);
          // create plane at reticle
          const rp = computeReticlePointOnFloor();
          await createLocalPlaneAndPush();
          // store geo info for future alignment if desired
          const meta = { createdAt: Date.now(), lat: avg.lat, lon: avg.lon, alt: avg.alt, widthMeters: 3.0, heightMeters: 3.0, heading: 0 };
          const newRef = push(planesRef);
          await set(newRef, meta);
          // localPlacedPlaneId set by createLocalPlaneAndPush; if you want the GPS-backed plane to be the new ID replace logic accordingly
          statusEl && (statusEl.textContent = "Canvas placed (geo saved). Hold to spray");
        } catch (e) {
          console.warn("GPS failed", e);
          statusEl && (statusEl.textContent = "GPS failed — canvas placed without geo");
          await createLocalPlaneAndPush();
        } finally {
          placeCanvasBtn.disabled = false;
        }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        try {
          await set(ref(db, "planes"), null);
          // remove local meshes
          planeObjects.forEach(p => { scene.remove(p.mesh); if (p.grid) scene.remove(p.grid); });
          planeObjects.clear();
          if (localPlaneMesh) { scene.remove(localPlaneMesh); localPlaneMesh = null; }
          if (localGrid) { scene.remove(localGrid); localGrid = null; }
          localPlacedPlaneId = null;
          statusEl && (statusEl.textContent = "Cleared all");
        } catch (e) { console.warn("clear failed", e); }
      });
    }

    /* ======= Input: press-and-hold for spray (pointer, touch, keyboard & volume fallback) ======= */
    // Pointer/touch handlers on the canvas
    function onPointerDown(e) {
      e.preventDefault();
      startSpraying().catch(err => console.warn(err));
    }
    function onPointerUp(e) {
      e.preventDefault();
      stopSpraying().catch(err => console.warn(err));
    }

    // Attach to canvas and video container so whole area can be used
    canvasEl.addEventListener("pointerdown", onPointerDown);
    canvasEl.addEventListener("pointerup", onPointerUp);
    canvasEl.addEventListener("pointercancel", onPointerUp);
    canvasEl.addEventListener("pointerleave", onPointerUp);

    // keyboard fallback: Space or ArrowUp to spray (useful for debugging)
    window.addEventListener("keydown", (ev) => {
      // volume keys rarely map in browsers; use ArrowUp/ArrowDown/Space as practical fallback
      if (ev.code === "Space" || ev.code === "ArrowUp" || ev.code === "ArrowDown") {
        if (!spraying) { ev.preventDefault(); startSpraying().catch(() => {}); }
      }
    });
    window.addEventListener("keyup", (ev) => {
      if (ev.code === "Space" || ev.code === "ArrowUp" || ev.code === "ArrowDown") {
        if (spraying) { ev.preventDefault(); stopSpraying().catch(() => {}); }
      }
    });

    // Attempt to capture physical volume buttons on mobile: some browsers expose them as key events
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "AudioVolumeDown" || ev.key === "AudioVolumeUp") {
        if (!spraying) startSpraying().catch(()=>{});
      }
    });
    window.addEventListener("keyup", (ev) => {
      if (ev.key === "AudioVolumeDown" || ev.key === "AudioVolumeUp") {
        if (spraying) stopSpraying().catch(()=>{});
      }
    });

    /* ======= Render loop & UI reticle updates ======= */
    function renderLoop() {
      requestAnimationFrame(renderLoop);
      // update reticle/crosshair position from aim ray
      const aim = computeReticlePointOnFloor();
      if (aim) {
        reticle.visible = true;
        reticle.position.copy(aim);
        crosshair.visible = true;
        crosshair.position.copy(aim);
      } else {
        reticle.visible = false;
        if (localPlacedPlaneId && planeObjects.has(localPlacedPlaneId)) {
          const obj = planeObjects.get(localPlacedPlaneId);
          crosshair.visible = true;
          crosshair.position.copy(obj.mesh.position);
        } else {
          crosshair.visible = false;
        }
      }

      renderer.render(scene, camera);
    }
    renderLoop();

    /* ======= Resize handling ======= */
    window.addEventListener("resize", () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    });

    // initial message
    statusEl && (statusEl.textContent = "Ready — Enable Cam, Place Canvas, then hold screen to spray");

    // End of DOMContentLoaded
  }); // end DOMContentLoaded
} // end double-run guard
