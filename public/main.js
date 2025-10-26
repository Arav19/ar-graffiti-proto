// public/main.js
// Merged final: AR graffiti with pinned 2D canvases + realtime Firebase sync.
// - Uses WebXR hit-test when available, fallback camera otherwise.
// - Stores arPose + geo in Firebase so other users can reconstruct canvases.
// - True 2D HTML canvas textures (UV mapping) and smooth strokes.
// - Press-and-hold to spray, DeviceOrientation heading capture for stable orientation.

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

/* ===== FIREBASE CONFIG (use your config provided) ===== */
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

/* ===== Prevent double execution (hot reload / extensions) ===== */
if (window.__surfaceless_main_loaded) {
  console.warn("main.js already loaded - skipping second run");
} else {
  window.__surfaceless_main_loaded = true;

  window.addEventListener("DOMContentLoaded", () => {
    console.log("DOM loaded — starting AR Graffiti app");

    /* ===== DOM ===== */
    const enterArBtn = document.getElementById("enterArBtn");
    const placePlaneBtn = document.getElementById("placePlaneBtn");
    const clearBtn = document.getElementById("clearBtn");
    const undoBtn = document.getElementById("undoBtn");
    const statusEl = document.getElementById("status");
    const networkStatusEl = document.getElementById("networkStatus");
    const colorPicker = document.getElementById("colorPicker");
    const brushRange = document.getElementById("brushRange");
    const canvasEl = document.getElementById("three-canvas");
    const fallbackVideoEl = document.getElementById("camera-feed");

    function setStatus(s) { if (statusEl) statusEl.textContent = s; }

    /* ===== State & helpers ===== */
    let xrSession = null;
    let xrRefSpace = null;
    let viewerSpace = null;
    let hitTestSource = null;
    let renderer, scene, camera;
    let reticle = null;
    let rendererStarted = false;

    const planeObjects = new Map(); // planeId -> { mesh, meta, grid, renderedStrokes:Set }
    let localPlaneId = null; // id of plane created by this client (if any)
    let lastStrokeId = null;

    // drawing state
    let drawing = false;
    let currentStroke = null;
    let currentStrokeTmp = []; // points buffered before push
    let samplingTimer = null;
    let sprayIntervalMs = 50;
    let lastSampleUV = null;
    let currentStrokeRef = null;

    // heading (alpha) used for geo reprojection / orientation stabilization
    let lastHeading = 0;
    function startHeadingWatcher() {
      const handler = (ev) => {
        if (ev && ev.alpha != null) lastHeading = ev.alpha;
      };
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        // try to request on iOS when user interacts
        DeviceOrientationEvent.requestPermission?.().then(p => {
          if (p === "granted") window.addEventListener("deviceorientation", handler, true);
        }).catch(()=>{});
      } else {
        window.addEventListener("deviceorientation", handler, true);
      }
    }

    /* ===== THREE setup ===== */
    function initThree() {
      renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.xr.enabled = false; // becomes true when AR session starts

      scene = new THREE.Scene();
      scene.background = null;

      camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
      camera.position.set(0, 1.6, 0);

      const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
      scene.add(hemi);
    }

    initThree();

    /* ===== Reticle + grid + helper functions ===== */
    function makeReticle() {
      const geo = new THREE.RingGeometry(0.12 * 0.85, 0.12, 32).rotateX(-Math.PI/2);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(geo, mat);
      ring.matrixAutoUpdate = false;
      ring.visible = false;
      scene.add(ring);
      return ring;
    }
    function makeGridMesh(size = 2, divisions = 8) {
      const grid = new THREE.GridHelper(size, divisions, 0x00ffff, 0x004444);
      grid.material.opacity = 0.25;
      grid.material.transparent = true;
      grid.visible = true;
      grid.position.y = 0;
      return grid;
    }

    // create a drawing plane (HTML canvas -> texture)
    function createDrawingPlaneMesh(widthMeters = 2, heightMeters = 2, texSize = 2048) {
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
      mesh.rotation.x = -Math.PI/2; // flat on floor
      mesh.position.y = 0.001; // tiny lift to avoid z-fighting
      mesh.userData = { canvas: c, ctx, tex, w: texSize, h: texSize, widthMeters, heightMeters, renderedStrokes: new Set() };
      return mesh;
    }

    /* ===== Geo helpers (meters <-> latlon) ===== */
    function latLonToMetersDelta(lat0, lon0, lat1, lon1) {
      const R = 6378137;
      const dLat = (lat1 - lat0) * Math.PI/180;
      const dLon = (lon1 - lon0) * Math.PI/180;
      const meanLat = (lat0 + lat1) / 2 * Math.PI/180;
      const north = dLat * R;
      const east = dLon * R * Math.cos(meanLat);
      return { east, north };
    }
    function metersToLocalXZ(east, north, headingDeg) {
      const theta = -headingDeg * Math.PI/180;
      const x = east * Math.cos(theta) - north * Math.sin(theta);
      const z = east * Math.sin(theta) + north * Math.cos(theta);
      return { x, z: -z };
    }

    function getCurrentPositionPromise() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error("No geolocation"));
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
      });
    }

    /* ===== Firebase: remote plane creation listener ===== */
    onChildAdded(planesRef, (snap) => {
      const id = snap.key;
      const meta = snap.val();
      if (!meta) return;
      if (planeObjects.has(id)) return;
      createRemotePlane(id, meta);
    });
    onChildRemoved(planesRef, (snap) => {
      const id = snap.key;
      const obj = planeObjects.get(id);
      if (!obj) return;
      // cleanup
      try { obj.mesh.geometry.dispose(); } catch(e){}
      try { obj.mesh.material.map?.dispose(); obj.mesh.material.dispose(); } catch(e){}
      scene.remove(obj.mesh);
      if (obj.grid) { scene.remove(obj.grid); }
      planeObjects.delete(id);
    });

    /* ===== Create remote plane (from DB meta) ===== */
    async function createRemotePlane(planeId, meta) {
      const width = meta.widthMeters || 2;
      const height = meta.heightMeters || 2;
      const mesh = createDrawingPlaneMesh(width, height);
      mesh.name = `plane-${planeId}`;

      // if AR session active AND meta.arPose available, place via arPose (best effort)
      if (meta.arPose && renderer && renderer.xr && renderer.xr.isPresenting) {
        try {
          mesh.position.set(meta.arPose.x, meta.arPose.y, meta.arPose.z);
          mesh.quaternion.set(meta.arPose.qx, meta.arPose.qy, meta.arPose.qz, meta.arPose.qw);
          scene.add(mesh);
        } catch (e) {
          mesh.position.set(0, 0.001, -2 - planeObjects.size*0.5);
          scene.add(mesh);
        }
      } else if (meta.lat != null && meta.lon != null) {
        // reproject using current GPS to approximate local XZ
        try {
          const pos = await getCurrentPositionPromise();
          const myLat = pos.coords.latitude, myLon = pos.coords.longitude;
          const { east, north } = latLonToMetersDelta(myLat, myLon, meta.lat, meta.lon);
          const { x, z } = metersToLocalXZ(east, north, meta.headingAtPlace || 0);
          mesh.position.set(x, 0.001, z);
          scene.add(mesh);
        } catch (e) {
          mesh.position.set(0, 0.001, -2 - planeObjects.size*0.5);
          scene.add(mesh);
        }
      } else {
        mesh.position.set(0, 0.001, -2 - planeObjects.size*0.5);
        scene.add(mesh);
      }

      // optional grid for visibility
      const grid = makeGridMesh(Math.max(width, height), Math.round(Math.max(width, height)*4));
      grid.position.set(mesh.position.x, 0, mesh.position.z);
      scene.add(grid);

      planeObjects.set(planeId, { mesh, meta, grid });

      // listen strokes for this plane
      const strokesRef = ref(db, `planes/${planeId}/strokes`);
      onChildAdded(strokesRef, (sSnap) => {
        const stroke = sSnap.val();
        if (!stroke) return;
        // avoid re-rendering stroke twice if already rendered
        if (mesh.userData.renderedStrokes.has(sSnap.key)) return;
        mesh.userData.renderedStrokes.add(sSnap.key);
        drawStrokeOnPlane(planeId, stroke, false);
      });
    }

    /* ===== Draw stroke on plane's canvas texture ===== */
    function drawStrokeOnPlane(planeId, stroke, local = false) {
      const p = planeObjects.get(planeId);
      if (!p) return;
      const mesh = p.mesh;
      const ctx = mesh.userData.ctx;
      const w = mesh.userData.w;
      const h = mesh.userData.h;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = stroke.color || "#ffffff";
      ctx.lineWidth = stroke.width || 8;

      const pts = stroke.points || [];
      if (pts.length === 0) return;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = Math.round(pts[i].u * w);
        const y = Math.round((1 - pts[i].v) * h);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      mesh.userData.tex.needsUpdate = true;
    }

    /* ===== world -> plane UV helper (correct handling of rotated plane) ===== */
    function worldToPlaneUV(mesh, worldPos) {
      const local = worldPos.clone();
      mesh.worldToLocal(local);
      const halfW = mesh.userData.widthMeters / 2;
      const halfH = mesh.userData.heightMeters / 2;
      // local.x -> left/right maps to U
      // local.z -> forward/back maps to V (since plane rotated -90 around X)
      const u = (local.x + halfW) / mesh.userData.widthMeters;
      const v = (local.z + halfH) / mesh.userData.heightMeters;
      return { u: THREE.MathUtils.clamp(u, 0, 1), v: THREE.MathUtils.clamp(v, 0, 1) };
    }

    /* ===== UV -> canvas XY (for pointer-based drawing) ===== */
    function uvToCanvasXY(uv, mesh) {
      const u = uv.x, v = uv.y;
      const x = Math.round(u * mesh.userData.w);
      const y = Math.round((1 - v) * mesh.userData.h);
      return { x, y };
    }

    /* ===== Place a plane: push meta to Firebase (arPose + geo if available) ===== */
    async function placeNewPlaneAtPose(pose, optionalGeo) {
      const meta = {
        createdAt: Date.now(),
        widthMeters: 2.5,
        heightMeters: 2.5,
        arPose: pose ? {
          x: pose.position.x, y: pose.position.y, z: pose.position.z,
          qx: pose.orientation.x, qy: pose.orientation.y, qz: pose.orientation.z, qw: pose.orientation.w
        } : null,
        lat: optionalGeo?.lat ?? null,
        lon: optionalGeo?.lon ?? null,
        alt: optionalGeo?.alt ?? null,
        headingAtPlace: optionalGeo?.heading ?? null
      };
      const newRef = push(planesRef);
      await set(newRef, meta);
      localPlaneId = newRef.key;
      setStatus("Canvas placed — draw now (hold to spray)");
      // create immediate local plane for responsiveness; DB listener will also create (duplicate guarded)
      createRemotePlane(localPlaneId, meta);
      return localPlaneId;
    }

    /* ===== Try get geo helper ===== */
    async function tryGetGeo() {
      try {
        const p = await getCurrentPositionPromise();
        return { lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude || 0, heading: lastHeading || 0 };
      } catch (e) {
        return null;
      }
    }

    /* ======= AR session support & hit-test ======= */
    async function startARSession() {
      if (!navigator.xr) {
        setStatus("WebXR not available on this device — using fallback camera");
        startFallbackMode();
        return;
      }

      try {
        const supported = await navigator.xr.isSessionSupported("immersive-ar");
        if (!supported) {
          setStatus("AR not supported — using fallback camera");
          startFallbackMode();
          return;
        }
      } catch (e) {
        console.warn("XR support check failed", e);
        startFallbackMode();
        return;
      }

      try {
        xrSession = await navigator.xr.requestSession("immersive-ar", {
          requiredFeatures: ["hit-test", "local-floor"],
          optionalFeatures: ["dom-overlay", "bounded-floor"],
          domOverlay: { root: document.body }
        });
      } catch (err) {
        console.error("XR request failed", err);
        setStatus("AR start failed — using fallback");
        startFallbackMode();
        return;
      }

      renderer.xr.enabled = true;
      await renderer.xr.setSession(xrSession);

      // reticle
      if (!reticle) reticle = makeReticle();

      xrRefSpace = await xrSession.requestReferenceSpace("local-floor");
      viewerSpace = await xrSession.requestReferenceSpace("viewer");

      // hit test source
      try {
        const hitSource = await xrSession.requestHitTestSource({ space: viewerSpace });
        hitTestSource = hitSource;
      } catch (e) {
        console.warn("hit-test source request failed", e);
        hitTestSource = null;
      }

      xrSession.addEventListener("end", () => {
        renderer.xr.enabled = false;
        xrSession = null;
        hitTestSource = null;
        setStatus("AR ended");
        placePlaneBtn.style.display = "none";
        enterArBtn.style.display = "";
      });

      placePlaneBtn.style.display = "";

      // start heading watcher
      startHeadingWatcher();

      // render loop with hit-test updates
      renderer.setAnimationLoop((time, xrFrame) => {
        if (xrFrame && hitTestSource && xrRefSpace) {
          const hitResults = xrFrame.getHitTestResults(hitTestSource);
          if (hitResults.length > 0) {
            const hit = hitResults[0];
            const pose = hit.getPose(xrRefSpace);
            if (pose) {
              reticle.visible = true;
              const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
              reticle.matrix.copy(m);
            } else {
              reticle.visible = false;
            }
          } else {
            reticle.visible = false;
          }
        }
        renderer.render(scene, camera);
      });

      setStatus("AR active — look around; tap 'Place Canvas' when reticle appears");
      enterArBtn.style.display = "none";
    }

    /* ===== Fallback camera mode (non-XR) ===== */
    async function startFallbackMode() {
      // show place button
      placePlaneBtn.style.display = "";
      // request camera stream to video element
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        fallbackVideoEl.srcObject = stream;
        try { await fallbackVideoEl.play(); } catch (e) { console.warn("video.play blocked", e); }
        setStatus("Camera active (fallback) — press Place Canvas");
        startHeadingWatcher();
      } catch (e) {
        console.warn("fallback camera failed", e);
        setStatus("Camera access required");
      }
    }

    /* ===== Place canvas button handler (AR or fallback) ===== */
    placePlaneBtn.addEventListener("click", async () => {
      setStatus("Placing canvas...");
      // If in AR and reticle visible, use reticle pose
      if (renderer.xr.enabled && xrSession && reticle && reticle.visible) {
        // reticle.matrix contains world transform in reference space; decompose
        const m = new THREE.Matrix4().copy(reticle.matrix);
        const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
        m.decompose(pos, quat, scl);
        const geo = await tryGetGeo();
        await placeNewPlaneAtPose({ position: pos, orientation: quat }, geo);
      } else {
        // fallback: place in front of camera ~2.5m
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const pos = camera.position.clone().add(forward.multiplyScalar(2.5));
        const quat = camera.quaternion.clone();
        const geo = await tryGetGeo();
        await placeNewPlaneAtPose({ position: pos, orientation: quat }, geo);
      }
    });

    /* ===== Pointer / touch drawing (press-and-hold to spray) ===== */
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let activePlaneId = null;

    // helper: attempt to find plane under screen point (client coords)
    function pickPlaneAtClientXY(clientX, clientY) {
      pointer.x = (clientX / window.innerWidth) * 2 - 1;
      pointer.y = -(clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // gather plane meshes
      const meshes = [];
      planeObjects.forEach(v => { if (v.mesh) meshes.push(v.mesh); });
      if (meshes.length === 0) return null;
      const ints = raycaster.intersectObjects(meshes, false);
      if (ints.length === 0) return null;
      return ints[0]; // intersection
    }

    async function beginStrokeAtIntersection(int) {
      if (!int) return;
      const mesh = int.object;
      // find planeId
      let planeId = null;
      for (const [k,v] of planeObjects) { if (v.mesh === mesh) { planeId = k; break; } }
      if (!planeId) return;
      activePlaneId = planeId;
      const uv = int.uv;
      currentStroke = { color: colorPicker.value || "#00ffd0", width: parseInt(brushRange.value || 12, 10) || 12, points: [{ u: uv.x, v: uv.y }] };
      currentStrokeTmp = [{ u: uv.x, v: uv.y }];
      lastSampleUV = { u: uv.x, v: uv.y };
      // draw immediate point locally
      drawStrokeOnPlane(planeId, { color: currentStroke.color, width: currentStroke.width, points: [currentStroke.points[0]] }, true);
      // create stroke record in DB
      const strokesRef = ref(db, `planes/${planeId}/strokes`);
      const sRef = push(strokesRef);
      await set(sRef, { color: currentStroke.color, width: currentStroke.width, createdAt: Date.now(), points: currentStroke.points });
      currentStrokeRef = sRef;
      lastStrokeId = sRef.key;
    }

    async function extendStrokeAtIntersection(int) {
      if (!int || !activePlaneId || !currentStrokeRef) return;
      const uv = int.uv;
      // interpolate smooth between lastSampleUV and uv
      const prev = lastSampleUV || { u: uv.x, v: uv.y };
      const dx = uv.x - prev.u, dy = uv.y - prev.v;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.floor(dist * 300));
      for (let i=1;i<=steps;i++){
        const t = i/Math.max(1,steps);
        const iu = THREE.MathUtils.lerp(prev.u, uv.x, t);
        const iv = THREE.MathUtils.lerp(prev.v, uv.y, t);
        currentStroke.points.push({ u: iu, v: iv });
        currentStrokeTmp.push({ u: iu, v: iv });
      }
      lastSampleUV = { u: uv.x, v: uv.y };
      // draw incremental locally
      const planeObj = planeObjects.get(activePlaneId);
      if (planeObj) {
        // draw small segment immediately
        const pts = currentStrokeTmp.splice(0, currentStrokeTmp.length);
        drawStrokeOnPlane(activePlaneId, { color: currentStroke.color, width: currentStroke.width, points: pts }, true);
      }
      // flush small batches to DB (append)
      if (currentStrokeRef) {
        // push points under points/ child under stroke (we'll use updates)
        const pointsPath = `planes/${activePlaneId}/strokes/${currentStrokeRef.key}/points`;
        // Do batched update to avoid many pushes (but keep payload small)
        const updates = {};
        for (const p of currentStroke.points.slice(-32)) {
          const key = push(ref(db, pointsPath)).key;
          updates[key] = { u: p.u, v: p.v, t: Date.now() };
        }
        try {
          await update(ref(db, pointsPath), updates);
        } catch(e) { /* ignore */ }
      }
    }

    async function finishStroke() {
      if (!currentStroke || !activePlaneId || !currentStrokeRef) {
        // reset state
        drawing = false; activePlaneId = null; currentStroke = null; currentStrokeRef = null; lastSampleUV = null;
        return;
      }
      // final flush: write remaining points (if server-side points structure used)
      try {
        // write remaining small buffer as updates
        if (currentStrokeTmp.length > 0) {
          const pointsPath = `planes/${activePlaneId}/strokes/${currentStrokeRef.key}/points`;
          const updates = {};
          for (const p of currentStrokeTmp.splice(0, currentStrokeTmp.length)) {
            const key = push(ref(db, pointsPath)).key;
            updates[key] = { u: p.u, v: p.v, t: Date.now() };
          }
          await update(ref(db, pointsPath), updates);
        }
      } catch(e) { console.warn("final stroke flush failed", e); }
      drawing = false;
      currentStroke = null;
      currentStrokeRef = null;
      activePlaneId = null;
      lastSampleUV = null;
      setStatus("Ready — hold screen to spray");
    }

    // pointer handlers (press-and-hold)
    let pressHoldActive = false;
    function onPointerDown(e) {
      e.preventDefault();
      pressHoldActive = true;
      setStatus("Drawing...");
      // pick immediate intersection
      const int = pickPlaneAtClientXY(e.clientX, e.clientY);
      if (int) {
        beginStrokeAtIntersection(int).catch(console.warn);
        // start sampling loop to continue sampling center reticle intersection while holding (use center crosshair)
        samplingTimer = setInterval(() => {
          // use center point (screen center) as aim when in AR; else continue using pointer coords
          const cx = window.innerWidth/2, cy = window.innerHeight/2;
          const i = pickPlaneAtClientXY(cx, cy);
          if (i) extendStrokeAtIntersection(i).catch(console.warn);
        }, sprayIntervalMs);
      } else {
        // if no plane hit at pointer down, try checking center reticle (AR) if available
        const cx = window.innerWidth/2, cy = window.innerHeight/2;
        const i = pickPlaneAtClientXY(cx, cy);
        if (i) {
          beginStrokeAtIntersection(i).catch(console.warn);
          samplingTimer = setInterval(() => { const j = pickPlaneAtClientXY(cx, cy); if (j) extendStrokeAtIntersection(j).catch(console.warn); }, sprayIntervalMs);
        } else {
          setStatus("Aim at a placed canvas to draw");
          pressHoldActive = false;
        }
      }
    }
    function onPointerUp(e) {
      e.preventDefault();
      pressHoldActive = false;
      clearInterval(samplingTimer); samplingTimer = null;
      finishStroke().catch(console.warn);
    }

    canvasEl.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    canvasEl.addEventListener("touchstart", (ev) => { if (ev.touches && ev.touches[0]) onPointerDown(ev.touches[0]); });
    canvasEl.addEventListener("touchend", (ev) => onPointerUp(ev));

    // keyboard / volume fallback for triggering spray (helpful on some devices)
    window.addEventListener("keydown", (ev) => {
      if ((ev.code === "Space" || ev.code === "KeyZ") && !pressHoldActive) {
        const fake = { clientX: window.innerWidth/2, clientY: window.innerHeight/2, preventDefault: ()=>{} };
        onPointerDown(fake);
      }
    });
    window.addEventListener("keyup", (ev) => {
      if (ev.code === "Space" || ev.code === "KeyZ") onPointerUp(ev);
    });

    /* ===== Clear / Undo ===== */
    clearBtn.addEventListener("click", async () => {
      if (!confirm("Clear all canvases and strokes for everyone? This cannot be undone.")) return;
      setStatus("Clearing...");
      try {
        await set(ref(db, "planes"), null);
        planeObjects.forEach(p => {
          try { p.mesh.geometry.dispose(); } catch(e){}
          try { p.mesh.material.map?.dispose(); p.mesh.material.dispose(); } catch(e){}
          scene.remove(p.mesh);
          if (p.grid) scene.remove(p.grid);
        });
        planeObjects.clear();
        localPlaneId = null;
        setStatus("Cleared all");
      } catch (e) {
        console.warn("clear failed", e);
        setStatus("Clear failed");
      }
    });

    undoBtn.addEventListener("click", async () => {
      if (!localPlaneId) { setStatus("No local canvas to undo"); return; }
      if (!lastStrokeId) { setStatus("No stroke to undo"); return; }
      try {
        await remove(ref(db, `planes/${localPlaneId}/strokes/${lastStrokeId}`));
        setStatus("Undone last stroke");
        lastStrokeId = null;
      } catch (e) {
        console.warn("undo failed", e);
        setStatus("Undo failed");
      }
    });

    /* ===== Render loop (non-XR fallback) ===== */
    function renderLoop() {
      requestAnimationFrame(renderLoop);
      // update reticle position for non-XR: none
      renderer.render(scene, camera);
    }
    renderLoop();

    /* ===== Window resize ===== */
    window.addEventListener("resize", () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    });

    /* ===== Network connection indicator ===== */
    const connectedRef = ref(db, ".info/connected");
    onValue(connectedRef, (snap) => {
      const c = snap.val();
      if (networkStatusEl) {
        networkStatusEl.className = c ? "connected" : "offline";
        networkStatusEl.style.background = c ? "#0f0" : "#f44";
      }
    });

    /* ===== UI wiring: Enter AR button ===== */
    enterArBtn.addEventListener("click", async () => {
      setStatus("Starting AR...");
      await startARSession();
    });

    // initial UI state
    setStatus("Ready — Enter AR or place a canvas (fallback camera)");
    placePlaneBtn.style.display = "none";

    // try to start fallback camera implicitly (so Android/iOS can get camera)
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        // attach to fallback video element (hidden if AR)
        if (fallbackVideoEl) {
          fallbackVideoEl.srcObject = stream;
          try { await fallbackVideoEl.play(); } catch(e){ /* ignore autoplay block */ }
        }
        setStatus("Camera ready — press Enter AR or Place Canvas");
      } catch (e) {
        // user will need to tap Enter AR to grant permissions for XR or camera
        console.warn("implicit camera start failed (user may need to tap):", e);
      }
    })();

    console.log("AR Graffiti module loaded");
  }); // DOMContentLoaded
} // double-run guard
