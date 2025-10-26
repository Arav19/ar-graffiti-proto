// public/main.js
// Full app: Floor-locked 2D canvas drawing anchored by GPS + realtime Firebase sync
// Uses Three.js (module) + Firebase Realtime DB (v11 modular).
// Replaces older main.js — single-file, defensive, DOMContentLoaded wrapper.

import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  update,
  remove,
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

/* ===== Prevent duplicate execution (extensions / HMR) ===== */
if (window.__surfaceless_main_loaded) {
  console.warn("main.js already executed — skipping");
} else {
  window.__surfaceless_main_loaded = true;

  window.addEventListener("DOMContentLoaded", () => {
    console.log("Starting AR Graffiti app (fixed anchor + yaw + 2D paint)");

    /* ===== DOM elements ===== */
    const enableCameraBtn = document.getElementById("enableCameraBtn");
    const cameraSelect = document.getElementById("cameraSelect");
    const placeCanvasBtn = document.getElementById("placeCanvasBtn");
    const clearBtn = document.getElementById("clearBtn");
    const undoBtn = document.getElementById("undoBtn");
    const colorPicker = document.getElementById("colorPicker");
    const brushRange = document.getElementById("brushRange");
    const statusEl = document.getElementById("status");
    const networkStatusEl = document.getElementById("networkStatus");
    const videoEl = document.getElementById("camera-feed");
    const canvasEl = document.getElementById("three-canvas");

    if (!canvasEl) {
      console.error("Missing #three-canvas in DOM. Aborting.");
      if (statusEl) statusEl.textContent = "Missing canvas element";
      return;
    }

    function updateStatus(text) { if (statusEl) statusEl.textContent = text; }

    /* ===== small helpers ===== */
    function getUniqueUserId() {
      let uid = localStorage.getItem("surfaceless_uid");
      if (!uid) {
        uid = "user_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
        localStorage.setItem("surfaceless_uid", uid);
      }
      return uid;
    }

    /* ===== Camera state ===== */
    let camVideo = videoEl || null;
    let camStream = null;
    let cameraEnabled = false;

    /* ===== Three.js setup ===== */
    const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
    camera.position.set(0, 1.6, 0);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    scene.add(hemi);

    /* ===== Reticle + crosshair + grid helpers ===== */
    function makeReticle(radius = 0.12) {
      const geo = new THREE.RingGeometry(radius * 0.85, radius, 32);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      scene.add(m);
      return m;
    }
    function makeCross(radius = 0.06) {
      const geo = new THREE.CircleGeometry(radius, 24);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ffd0, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      scene.add(m);
      return m;
    }
    function makeGridMesh(size = 5, divisions = 10) {
      const g = new THREE.GridHelper(size, divisions, 0x00ffff, 0x004444);
      g.material.opacity = 0.25;
      g.material.transparent = true;
      g.rotation.x = -Math.PI / 2;
      g.position.y = 0.001;
      return g;
    }

    const reticle = makeReticle(0.12);
    const crosshair = makeCross(0.06);

    /* ===== Drawing plane (canvas texture) ===== */
    function createDrawingPlaneMesh(widthMeters = 5, heightMeters = 5, texSize = 2048) {
      const c = document.createElement("canvas");
      c.width = texSize; c.height = texSize;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, texSize, texSize);

      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.flipY = false;

      const geom = new THREE.PlaneGeometry(widthMeters, heightMeters);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(geom, mat);

      // Force it flat on the ground and do NOT parent to camera
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.001; // slightly above floor to avoid z-fighting

      mesh.userData = {
        canvas: c,
        ctx,
        tex,
        w: texSize,
        h: texSize,
        widthMeters,
        heightMeters,
        renderedStrokes: new Set()
      };

      return mesh;
    }

    /* ===== State ===== */
    const planeObjects = new Map(); // id -> {mesh,meta,grid}
    let localPlacedPlaneId = null;
    let localPlaneMesh = null;
    let localGrid = null;

    let spraying = false;
    let samplingTimer = null;
    let strokeBuffer = [];
    let currentStrokeId = null;
    let lastSamplePoint = null;
    let lastStrokeId = null;
    let flushTimeout = null;

    /* ===== Device orientation (for camera aiming) ===== */
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

    let lastHeading = 0;
    function startHeadingWatcher() {
      function handler(e) { if (e.alpha != null) lastHeading = e.alpha; }
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        // requestPermission must be called from user gesture; we call it when enabling camera
        window.addEventListener("deviceorientation", handler, true);
      } else {
        window.addEventListener("deviceorientation", handler, true);
      }
    }
    function handleDeviceOrientationEvent(ev) {
      if (!ev) return;
      setObjectQuaternion(camera.quaternion, ev.alpha, ev.beta, ev.gamma, screenOrientation || 0);
    }
    function startOrientationWatcher() {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        // requestPermission previously attempted on enableCam click (user gesture)
        window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true);
      } else {
        window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true);
      }
    }

    /* ===== Raycast from camera center to floor y=0 ===== */
    function computeReticlePointOnFloor() {
      const origin = new THREE.Vector3();
      camera.getWorldPosition(origin);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

      // require some downward component (user must tilt a bit)
      if (Math.abs(dir.y) < 0.01) return null;

      const t = -origin.y / dir.y; // origin.y + t*dir.y = 0 => t = -origin.y/dir.y
      if (t <= 0) return null;
      return origin.clone().add(dir.multiplyScalar(t));
    }

    /* ===== World <-> Plane UV mapping (single definition) ===== */
    function worldToPlaneUV(mesh, worldPos) {
      const local = worldPos.clone();
      mesh.worldToLocal(local); // transform into mesh local space
      const halfW = mesh.userData.widthMeters / 2;
      const halfH = mesh.userData.heightMeters / 2;
      const u = (local.x + halfW) / mesh.userData.widthMeters;
      const v = (local.z + halfH) / mesh.userData.heightMeters;
      // v flip so canvas top maps consistently (we use stored coords as-is in push)
      return { u: THREE.MathUtils.clamp(u, 0, 1), v: THREE.MathUtils.clamp(1 - v, 0, 1) };
    }

    /* ===== Paint on plane canvas texture (small circle stamping) ===== */
    function paintCircleOnMesh(mesh, u, v, color, radiusPx) {
      if (!mesh || !mesh.userData || !mesh.userData.ctx) return;
      const ctx = mesh.userData.ctx;
      const x = Math.round(u * mesh.userData.w);
      const y = Math.round((1 - v) * mesh.userData.h); // flip back for canvas coordinates
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
      ctx.fill();
      mesh.userData.tex.needsUpdate = true;
    }

    /* ====== GPS helpers ====== */
    function getCurrentPositionPromise() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error("No geolocation"));
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
      });
    }
    async function sampleAndAverageGPS(n = 6, delayMs = 300) {
      const samples = [];
      for (let i = 0; i < n; i++) {
        try { const p = await getCurrentPositionPromise(); samples.push(p.coords); } catch (e) { /* ignore single failures */ }
        await new Promise(r => setTimeout(r, delayMs));
      }
      if (!samples.length) throw new Error("No GPS samples");
      const avg = samples.reduce((acc, s) => { acc.lat += s.latitude; acc.lon += s.longitude; acc.alt += (s.altitude || 0); return acc; }, { lat: 0, lon: 0, alt: 0 });
      avg.lat /= samples.length; avg.lon /= samples.length; avg.alt /= samples.length;
      return avg;
    }

    // Convert lat/lon deltas to metres (east/north)
    function latLonToMetersDelta(lat0, lon0, lat1, lon1) {
      const R = 6378137;
      const dLat = (lat1 - lat0) * Math.PI / 180;
      const dLon = (lon1 - lon0) * Math.PI / 180;
      const meanLat = (lat0 + lat1) / 2 * Math.PI / 180;
      const north = dLat * R;
      const east = dLon * R * Math.cos(meanLat);
      return { east, north };
    }

    // Map east/north meters into local XZ using device heading (viewer)
    function metersToLocalXZ(east, north, headingDeg) {
      const theta = -headingDeg * Math.PI / 180; // rotate by negative heading so that device forward aligns
      const x = east * Math.cos(theta) - north * Math.sin(theta);
      const z = east * Math.sin(theta) + north * Math.cos(theta);
      return { x, z: -z };
    }

    /* ===== Firebase stroke helpers ===== */
    async function createStrokeForPlane(planeId, color, width) {
      const strokesRef = ref(db, `planes/${planeId}/strokes`);
      const strokeRef = push(strokesRef);
      await set(strokeRef, { color, width, ownerId: getUniqueUserId(), createdAt: Date.now() });
      lastStrokeId = strokeRef.key;
      return strokeRef.key;
    }

    async function pushPointsForStroke(planeId, strokeId, points) {
      if (!points || points.length === 0) return;
      const pointsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
      const updates = {};
      for (const p of points) {
        const key = push(pointsRef).key;
        updates[key] = { u: p.u, v: p.v, t: Date.now() };
      }
      await update(ref(db, `planes/${planeId}/strokes/${strokeId}/points`), updates);
    }

    /* ===== Listen for strokes for a plane and render incremental points ===== */
    function listenStrokesForPlane(planeId, mesh) {
      const strokesRef = ref(db, `planes/${planeId}/strokes`);
      onChildAdded(strokesRef, (sSnap) => {
        const strokeId = sSnap.key;
        const meta = sSnap.val();
        // avoid re-rendering strokes twice
        if (mesh.userData.renderedStrokes.has(strokeId)) return;
        mesh.userData.renderedStrokes.add(strokeId);

        const ptsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
        onChildAdded(ptsRef, (ptSnap) => {
          const pt = ptSnap.val();
          if (!pt) return;
          paintCircleOnMesh(mesh, pt.u, pt.v, meta.color || '#ffffff', meta.width || 8);
        });
      });
    }

    /* ===== Listen for planes in DB and add to scene ===== */
    onChildAdded(planesRef, (snap) => {
      const id = snap.key;
      const meta = snap.val();
      if (!meta) return;
      if (planeObjects.has(id)) return;

      const mesh = createDrawingPlaneMesh(meta.widthMeters || 5, meta.heightMeters || 5);
      mesh.name = `plane-${id}`;

      // Place using saved lat/lon if available (reproject to local XZ)
      if (meta.lat != null && meta.lon != null) {
        getCurrentPositionPromise().then(pos => {
          try {
            const myLat = pos.coords.latitude, myLon = pos.coords.longitude;
            // east/north from viewer -> plane
            const { east, north } = latLonToMetersDelta(myLat, myLon, meta.lat, meta.lon);
            // convert to local x,z using viewer heading
            const { x, z } = metersToLocalXZ(east, north, lastHeading || 0);
            mesh.position.set(x, 0.001, z);
          } catch (e) {
            console.warn("Failed geo reprojection:", e);
            mesh.position.set(0, 0.001, -2 - planeObjects.size * 0.5);
          }
          scene.add(mesh);
          const grid = makeGridMesh(mesh.userData.widthMeters, Math.round(mesh.userData.widthMeters * 4));
          grid.position.set(mesh.position.x, 0.001, mesh.position.z);
          scene.add(grid);
          planeObjects.set(id, { mesh, meta, grid });
          listenStrokesForPlane(id, mesh);
        }).catch(() => {
          mesh.position.set(0, 0.001, -2 - planeObjects.size * 0.5);
          scene.add(mesh);
          const grid = makeGridMesh(mesh.userData.widthMeters, Math.round(mesh.userData.widthMeters * 4));
          grid.position.set(mesh.position.x, 0.001, mesh.position.z);
          scene.add(grid);
          planeObjects.set(id, { mesh, meta, grid });
          listenStrokesForPlane(id, mesh);
        });
      } else if (meta.pos && typeof meta.pos.x === 'number') {
        mesh.position.set(meta.pos.x, 0.001, meta.pos.z);
        scene.add(mesh);
        const grid = makeGridMesh(mesh.userData.widthMeters, Math.round(mesh.userData.widthMeters * 4));
        grid.position.set(mesh.position.x, 0.001, mesh.position.z);
        scene.add(grid);
        planeObjects.set(id, { mesh, meta, grid });
        listenStrokesForPlane(id, mesh);
      } else {
        mesh.position.set(0, 0.001, -2 - planeObjects.size * 0.5);
        scene.add(mesh);
        const grid = makeGridMesh(mesh.userData.widthMeters, Math.round(mesh.userData.widthMeters * 4));
        grid.position.set(mesh.position.x, 0.001, mesh.position.z);
        scene.add(grid);
        planeObjects.set(id, { mesh, meta, grid });
        listenStrokesForPlane(id, mesh);
      }
    });

    onChildRemoved(planesRef, (snap) => {
      const id = snap.key;
      const obj = planeObjects.get(id);
      if (!obj) return;
      if (obj.mesh) {
        obj.mesh.geometry.dispose();
        if (obj.mesh.material.map) obj.mesh.material.map.dispose();
        obj.mesh.material.dispose();
        scene.remove(obj.mesh);
      }
      if (obj.grid) {
        obj.grid.geometry.dispose();
        obj.grid.material.dispose();
        scene.remove(obj.grid);
      }
      planeObjects.delete(id);
      if (id === localPlacedPlaneId) {
        localPlacedPlaneId = null;
        localPlaneMesh = null;
      }
    });

    /* ===== Network status indicator (connected) ===== */
    const connectedRef = ref(db, '.info/connected');
    onValue(connectedRef, (snap) => {
      const connected = snap.val();
      if (networkStatusEl) networkStatusEl.className = connected ? 'connected' : 'offline';
    });

    /* ===== Create local plane (push metadata including GPS + heading) ===== */
    async function createLocalPlaneAndPush() {
      if (localPlacedPlaneId && planeObjects.has(localPlacedPlaneId)) return localPlacedPlaneId;
      const rp = computeReticlePointOnFloor();
      const pos = rp ? { x: rp.x, z: rp.z } : { x: 0, z: -2 };
      const gpsMeta = {};
      try {
        const avg = await sampleAndAverageGPS(5, 250);
        gpsMeta.lat = avg.lat; gpsMeta.lon = avg.lon; gpsMeta.alt = avg.alt;
      } catch (e) { /* ignore GPS failure */ }

      const meta = {
        createdAt: Date.now(),
        ownerId: getUniqueUserId(),
        widthMeters: 5,
        heightMeters: 5,
        pos,
        ...gpsMeta,
        headingAtPlace: lastHeading || 0
      };
      const newRef = push(planesRef);
      await set(newRef, meta);
      localPlacedPlaneId = newRef.key;

      // instantiate local visuals
      const mesh = createDrawingPlaneMesh(meta.widthMeters, meta.heightMeters);
      mesh.position.set(pos.x, 0.001, pos.z);
      scene.add(mesh);
      localPlaneMesh = mesh;
      const grid = makeGridMesh(mesh.userData.widthMeters, Math.round(mesh.userData.widthMeters * 4));
      grid.position.set(mesh.position.x, 0.001, mesh.position.z);
      scene.add(grid);
      localGrid = grid;
      planeObjects.set(localPlacedPlaneId, { mesh, meta, grid });
      listenStrokesForPlane(localPlacedPlaneId, mesh);
      console.log("Created local plane", localPlacedPlaneId, meta);
      return localPlacedPlaneId;
    }

    /* ===== Sampling loop: sample reticle and paint while spraying ===== */
    function sampleAndPaint() {
      if (!localPlacedPlaneId) return;
      const pt = computeReticlePointOnFloor();
      if (!pt) return;
      const planeObj = planeObjects.get(localPlacedPlaneId);
      if (!planeObj) return;
      const uv = worldToPlaneUV(planeObj.mesh, pt);
      const brushPx = parseInt(brushRange?.value || 12, 10) || 12;
      const color = colorPicker?.value || "#00ffd0";

      if (lastSamplePoint) {
        const dist = Math.hypot(lastSamplePoint.u - uv.u, lastSamplePoint.v - uv.v);
        const steps = Math.max(1, Math.floor(dist * 400));
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

      // Debounced flush of points (non-blocking)
      clearTimeout(flushTimeout);
      flushTimeout = setTimeout(() => {
        if (strokeBuffer.length > 0 && currentStrokeId) {
          const flush = strokeBuffer.splice(0, strokeBuffer.length);
          pushPointsForStroke(localPlacedPlaneId, currentStrokeId, flush).catch(e => console.warn("pushPoints failed", e));
        }
      }, 120);
    }

    async function startSpraying() {
      if (spraying) return;
      if (!cameraEnabled) { updateStatus("Enable camera first"); return; }
      if (!localPlacedPlaneId) {
        updateStatus("Placing canvas...");
        try {
          await createLocalPlaneAndPush();
          updateStatus("Canvas placed — hold to spray");
        } catch (e) {
          console.error("Failed to create plane:", e);
          updateStatus("Failed to place canvas");
          return;
        }
      }
      spraying = true;
      lastSamplePoint = null;
      strokeBuffer = [];
      const color = colorPicker?.value || "#00ffd0";
      const width = parseInt(brushRange?.value || 12, 10) || 12;
      try {
        currentStrokeId = await createStrokeForPlane(localPlacedPlaneId, color, width);
        samplingTimer = setInterval(sampleAndPaint, 50);
        updateStatus("Spraying...");
      } catch (e) {
        console.error("start stroke failed:", e);
        spraying = false;
        updateStatus("Failed to start stroke");
      }
    }

    async function stopSpraying() {
      if (!spraying) return;
      spraying = false;
      if (samplingTimer) { clearInterval(samplingTimer); samplingTimer = null; }
      clearTimeout(flushTimeout);
      if (strokeBuffer.length > 0 && currentStrokeId) {
        const buf = strokeBuffer.splice(0, strokeBuffer.length);
        await pushPointsForStroke(localPlacedPlaneId, currentStrokeId, buf).catch(e => console.warn("final push failed", e));
      }
      currentStrokeId = null;
      lastSamplePoint = null;
      updateStatus("Ready to draw");
    }

    /* ===== Undo last stroke (local) ===== */
    async function undoLastStroke() {
      if (!lastStrokeId || !localPlacedPlaneId) { updateStatus("Nothing to undo"); return; }
      try {
        await remove(ref(db, `planes/${localPlacedPlaneId}/strokes/${lastStrokeId}`));
        // Clear local canvas and re-render strokes from DB (coarse approach)
        const planeObj = planeObjects.get(localPlacedPlaneId);
        if (planeObj && planeObj.mesh && planeObj.mesh.userData && planeObj.mesh.userData.ctx) {
          const ctx = planeObj.mesh.userData.ctx;
          ctx.clearRect(0, 0, planeObj.mesh.userData.w, planeObj.mesh.userData.h);
          planeObj.mesh.userData.tex.needsUpdate = true;
          planeObj.mesh.userData.renderedStrokes.clear();
        }
        lastStrokeId = null;
        updateStatus("Undone");
      } catch (e) {
        console.warn("Undo failed", e);
        updateStatus("Undo failed");
      }
    }

    /* ===== Camera helpers (getUserMedia & iOS orientation permission) ===== */
    async function getCameras() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(d => d.kind === 'videoinput');
      } catch (e) { console.warn("enumerateDevices failed", e); return []; }
    }

    async function startCamera(deviceId = null) {
      try {
        if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
        const constraints = deviceId ? { video: { deviceId: { exact: deviceId }, facingMode: { ideal: "environment" } }, audio: false } : { video: { facingMode: { ideal: "environment" } }, audio: false };
        camStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!camVideo) {
          camVideo = document.getElementById("camera-feed") || null;
        }
        camVideo = document.getElementById("camera-feed");
        camVideo.srcObject = camStream;
        try { await camVideo.play(); } catch (e) { console.warn("video play blocked", e); }
        cameraEnabled = true;
        updateStatus("Camera ready — Place Canvas");
      } catch (err) {
        console.error("Camera start failed:", err);
        throw err;
      }
    }

    /* ===== Enable camera button behavior (user gesture required on iOS) ===== */
    if (enableCameraBtn) {
      enableCameraBtn.addEventListener("click", async () => {
        enableCameraBtn.disabled = true;
        updateStatus("Requesting camera & motion permission...");
        try {
          // On modern iOS, DeviceOrientationEvent.requestPermission needs user gesture:
          if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
            try {
              const p = await DeviceOrientationEvent.requestPermission();
              console.log("DeviceOrientation permission:", p);
            } catch (e) { console.warn("DeviceOrientation request failed", e); }
          }
          // Start camera and orientation watchers
          await startCamera(null);
          startHeadingWatcher();
          startOrientationWatcher();

          // populate camera select if multiple
          const cams = await getCameras();
          if (cameraSelect && cams.length > 1) {
            cameraSelect.style.display = "";
            cameraSelect.innerHTML = "";
            cams.forEach((c, i) => { const opt = document.createElement("option"); opt.value = c.deviceId; opt.text = c.label || ("Camera " + (i + 1)); cameraSelect.appendChild(opt); });
            cameraSelect.addEventListener("change", async () => {
              try { await startCamera(cameraSelect.value); updateStatus("Camera switched"); } catch (e) { console.warn("Camera switch failed", e); updateStatus("Camera switch failed"); }
            });
          }

          updateStatus("Camera & motion enabled — Place Canvas");
        } catch (e) {
          console.error("Enable camera failed", e);
          enableCameraBtn.disabled = false;
          updateStatus("Camera permission required");
          alert("Camera permission is required. Please allow camera access and try again.");
        }
      });
    } else {
      // attempt implicit camera start (may be blocked)
      (async () => {
        try {
          await startCamera(null);
          startHeadingWatcher();
          startOrientationWatcher();
          updateStatus("Camera ready — Place Canvas");
        } catch (e) {
          console.warn("Implicit camera start failed", e);
        }
      })();
    }

    /* ===== Place Canvas button ===== */
    if (placeCanvasBtn) {
      placeCanvasBtn.addEventListener("click", async () => {
        if (!cameraEnabled) { updateStatus("Enable camera first"); return; }
        placeCanvasBtn.disabled = true;
        updateStatus("Placing canvas (sampling GPS)...");
        try {
          await createLocalPlaneAndPush();
          updateStatus("Canvas placed! Hold screen to draw");
        } catch (e) {
          console.warn("createLocalPlane failed", e);
          updateStatus("Placed without geo");
        } finally {
          placeCanvasBtn.disabled = false;
        }
      });
    }

    /* ===== Clear button ===== */
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        if (!confirm("Clear all canvases? This will remove all drawings.")) return;
        clearBtn.disabled = true;
        updateStatus("Clearing all...");
        try {
          await set(ref(db, "planes"), null);
          planeObjects.forEach(p => {
            if (p.mesh) {
              p.mesh.geometry.dispose();
              if (p.mesh.material.map) p.mesh.material.map.dispose();
              p.mesh.material.dispose();
              scene.remove(p.mesh);
            }
            if (p.grid) { p.grid.geometry.dispose(); p.grid.material.dispose(); scene.remove(p.grid); }
          });
          planeObjects.clear();
          localPlacedPlaneId = null;
          localPlaneMesh = null;
          lastStrokeId = null;
          if (undoBtn) undoBtn.style.display = 'none';
          updateStatus("Cleared all");
        } catch (e) {
          console.warn("Clear failed", e);
          updateStatus("Clear failed");
        } finally {
          clearBtn.disabled = false;
        }
      });
    }

    /* ===== Undo button ===== */
    if (undoBtn) {
      undoBtn.addEventListener("click", () => undoLastStroke());
    }

    /* ===== Input handlers (press & hold + volume + keyboard) ===== */
    function onPointerDown(e) { e.preventDefault(); startSpraying().catch(err => console.warn(err)); }
    function onPointerUp(e) { e.preventDefault(); stopSpraying().catch(err => console.warn(err)); }

    canvasEl.addEventListener("pointerdown", onPointerDown);
    canvasEl.addEventListener("pointerup", onPointerUp);
    canvasEl.addEventListener("pointercancel", onPointerUp);
    canvasEl.addEventListener("pointerleave", onPointerUp);

    // keyboard + volume keys (best-effort)
    window.addEventListener("keydown", (ev) => {
      if ((ev.code === "Space" || ev.code === "ArrowUp" || ev.code === "ArrowDown") && !spraying && cameraEnabled) { ev.preventDefault(); startSpraying().catch(()=>{}); }
      if (ev.key === "AudioVolumeDown" || ev.key === "AudioVolumeUp") { if (!spraying && cameraEnabled) { ev.preventDefault(); startSpraying().catch(()=>{}); } }
    });
    window.addEventListener("keyup", (ev) => {
      if ((ev.code === "Space" || ev.code === "ArrowUp" || ev.code === "ArrowDown") && spraying) { ev.preventDefault(); stopSpraying().catch(()=>{}); }
      if (ev.key === "AudioVolumeDown" || ev.key === "AudioVolumeUp") { if (spraying) { ev.preventDefault(); stopSpraying().catch(()=>{}); } }
    });

    /* ===== Render loop: update reticle + draw ===== */
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

    /* ===== Visibility change: stop spraying when hidden ===== */
    document.addEventListener("visibilitychange", () => { if (document.hidden && spraying) stopSpraying().catch(()=>{}); });

    /* ===== Init status ===== */
    updateStatus("Tap Enable Cam to start");
    console.log("AR Graffiti app loaded (full).");
  }); // DOMContentLoaded
} // guard
