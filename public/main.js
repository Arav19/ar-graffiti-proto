// public/main.js
// Full AR-first app: WebXR hit-test placement + fallback camera/GPS + 2D canvas textures + Firebase realtime sync
// Prioritize WebXR (immersive-ar). Fallback for iPhone uses camera + geolocation + deviceorientation.
// IMPORTANT: Ensure this file is served from the same origin as your firebase hosting config.

import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  onChildAdded,
  onChildRemoved,
  onValue,
  update,
  remove
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

/* ===== FIREBASE CONFIG — replace with your project (you already provided yours) ===== */
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

/* ===== Defensive single-run guard ===== */
if (window.__surfaceless_loaded) {
  console.warn("main.js already loaded — skipping duplicate execution");
} else {
  window.__surfaceless_loaded = true;

  /**********************
   * DOM references
   **********************/
  const canvasEl = document.getElementById("three-canvas");
  const enterArBtn = document.getElementById("enterArBtn");
  const placePlaneBtn = document.getElementById("placePlaneBtn");
  const clearBtn = document.getElementById("clearBtn");
  const statusEl = document.getElementById("status");
  const netEl = document.getElementById("networkStatus");
  const cameraVideo = document.getElementById("camera-feed");
  const colorPicker = document.getElementById("colorPicker");
  const brushRange = document.getElementById("brushRange");

  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  setStatus("Initializing...");

  /**********************
   * THREE.JS setup
   **********************/
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.xr.enabled = false;

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
  camera.position.set(0, 1.6, 0);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
  scene.add(hemi);

  /**********************
   * Reticle & crosshair helpers
   **********************/
  function makeReticle(radius = 0.12) {
    const geo = new THREE.RingGeometry(radius * 0.85, radius, 32).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.95 });
    const ring = new THREE.Mesh(geo, mat);
    ring.matrixAutoUpdate = false;
    ring.visible = false;
    scene.add(ring);
    return ring;
  }
  const reticle = makeReticle();

  function makeGrid(size = 2, divisions = 10) {
    const g = new THREE.GridHelper(size, divisions, 0x00ffff, 0x004444);
    g.material.transparent = true; g.material.opacity = 0.25;
    g.position.y = 0.001;
    return g;
  }

  /**********************
   * Canvas-on-plane factory (2D drawing surface)
   **********************/
  function createDrawingPlaneMesh(widthMeters = 2, heightMeters = 2, texWidth = 2048, texHeight = 2048) {
    const c = document.createElement("canvas");
    c.width = texWidth;
    c.height = texHeight;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, texWidth, texHeight);

    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.flipY = false;

    const geom = new THREE.PlaneGeometry(widthMeters, heightMeters);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      side: THREE.DoubleSide,
      metalness: 0,
      roughness: 1
    });

    const mesh = new THREE.Mesh(geom, mat);
    // place flat on y=0 plane (XZ)
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.001; // slight lift to avoid z-fighting

    mesh.userData = {
      canvas2d: c,
      ctx,
      tex,
      w: texWidth,
      h: texHeight,
      widthMeters,
      heightMeters,
      renderedStrokes: new Set()
    };

    return mesh;
  }

  /**********************
   * Ray helpers for center-aim (used for spray) and pointer-based drawing
   **********************/
  const centerRay = new THREE.Ray();
  const tmpVec = new THREE.Vector3();

  function computeCenterAimPointOnFloor() {
    // origin = camera world pos, dir = camera forward
    const origin = new THREE.Vector3();
    camera.getWorldPosition(origin);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    // require some downward component (tilt down)
    if (Math.abs(dir.y) < 0.02) return null;
    const t = - origin.y / dir.y;
    if (t <= 0) return null;
    return origin.clone().add(dir.multiplyScalar(t));
  }

  // world point -> plane UV (normalized 0..1) for a plane mesh that is flat on ground
  function worldPointToPlaneUV(mesh, worldPos) {
    // convert world position to mesh local
    const local = worldPos.clone();
    mesh.worldToLocal(local);
    // because mesh rotated -90deg about X, local.x => u, local.z => v
    const halfW = mesh.userData.widthMeters / 2;
    const halfH = mesh.userData.heightMeters / 2;
    const u = (local.x + halfW) / mesh.userData.widthMeters;
    const v = (local.z + halfH) / mesh.userData.heightMeters;
    return { u: THREE.MathUtils.clamp(u, 0, 1), v: THREE.MathUtils.clamp(1 - v, 0, 1) }; // flip v so v=0 bottom
  }

  /**********************
   * Firestore listeners & plane bookkeeping
   **********************/
  const planeObjects = new Map(); // planeId -> { mesh, meta, grid }
  let localPlaneId = null; // ID of plane we created (if any)
  let lastCreatedStrokeId = null;

  function createRemotePlane(planeId, meta) {
    if (planeObjects.has(planeId)) return;
    const width = meta.widthMeters || 2;
    const height = meta.heightMeters || 2;
    const mesh = createDrawingPlaneMesh(width, height);
    mesh.name = `plane-${planeId}`;

    // Place using saved arPose when possible (best for WebXR)
    if (meta.arPose && renderer.xr.enabled && renderer.xr.isPresenting) {
      mesh.position.set(meta.arPose.x, meta.arPose.y, meta.arPose.z);
      mesh.quaternion.set(meta.arPose.qx, meta.arPose.qy, meta.arPose.qz, meta.arPose.qw);
      scene.add(mesh);
      const grid = makeGrid(Math.max(width, height), Math.round(Math.max(width, height) * 6));
      grid.position.set(mesh.position.x, 0, mesh.position.z);
      scene.add(grid);
      planeObjects.set(planeId, { mesh, meta, grid });
    } else if (meta.lat != null && meta.lon != null) {
      // fallback: reproject using lat/lon + headingAtPlace (best-effort)
      getCurrentPositionPromise().then((pos) => {
        const myLat = pos.coords.latitude;
        const myLon = pos.coords.longitude;
        const R = 6378137;
        const dLat = (meta.lat - myLat) * Math.PI / 180;
        const dLon = (meta.lon - myLon) * Math.PI / 180;
        const north = dLat * R;
        const east = dLon * R * Math.cos(((meta.lat + myLat) / 2) * Math.PI / 180);
        const theta = - (meta.headingAtPlace || 0) * Math.PI / 180;
        const x = east * Math.cos(theta) - north * Math.sin(theta);
        const z = east * Math.sin(theta) + north * Math.cos(theta);
        mesh.position.set(x, 0.001, -z);
        scene.add(mesh);
        const grid = makeGrid(Math.max(width, height), Math.round(Math.max(width, height) * 6));
        grid.position.set(mesh.position.x, 0, mesh.position.z);
        scene.add(grid);
        planeObjects.set(planeId, { mesh, meta, grid });
      }).catch(() => {
        // fallback: place in front
        mesh.position.set(0, 0.001, -2 - planeObjects.size * 0.5);
        scene.add(mesh);
        const grid = makeGrid(Math.max(width, height), Math.round(Math.max(width, height) * 6));
        grid.position.set(mesh.position.x, 0, mesh.position.z);
        scene.add(grid);
        planeObjects.set(planeId, { mesh, meta, grid });
      });
    } else {
      // default fallback
      mesh.position.set(0, 0.001, -2 - planeObjects.size * 0.5);
      scene.add(mesh);
      const grid = makeGrid(Math.max(width, height), Math.round(Math.max(width, height) * 6));
      grid.position.set(mesh.position.x, 0, mesh.position.z);
      scene.add(grid);
      planeObjects.set(planeId, { mesh, meta, grid });
    }

    // Listen strokes under this plane and paint incremental points
    const strokesRef = ref(db, `planes/${planeId}/strokes`);
    onChildAdded(strokesRef, (snap) => {
      const stroke = snap.val();
      if (!stroke) return;
      // many strokes will arrive; to avoid re-drawing a stroke twice, track stroke ids
      const strokeId = snap.key;
      const obj = planeObjects.get(planeId);
      if (!obj) return;
      if (obj.mesh.userData.renderedStrokes.has(strokeId)) return;
      obj.mesh.userData.renderedStrokes.add(strokeId);

      // If stroke contains points as array (older backups), draw directly; else watch points child list
      if (Array.isArray(stroke.points) && stroke.points.length) {
        drawStrokeOnPlane(planeId, stroke);
      } else {
        // new-style: points are added as child nodes (listen to added points)
        const ptsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
        onChildAdded(ptsRef, (pSnap) => {
          const p = pSnap.val();
          if (!p) return;
          // draw single circle for each point
          paintPointOnMesh(obj.mesh, p.u, p.v, stroke.color || "#ffffff", stroke.width || 8);
        });
      }
    });
  }

  onChildAdded(planesRef, (snap) => {
    const id = snap.key;
    const meta = snap.val();
    if (!meta) return;
    createRemotePlane(id, meta);
  });

  onChildRemoved(planesRef, (snap) => {
    const id = snap.key;
    const obj = planeObjects.get(id);
    if (!obj) return;
    // dispose
    try {
      obj.mesh.geometry.dispose();
      obj.mesh.material.map?.dispose();
      obj.mesh.material.dispose();
    } catch (e) { /* ignore */ }
    scene.remove(obj.mesh);
    if (obj.grid) {
      try { obj.grid.geometry.dispose(); obj.grid.material.dispose(); } catch (e) {}
      scene.remove(obj.grid);
    }
    planeObjects.delete(id);
    if (id === localPlaneId) localPlaneId = null;
  });

  /**********************
   * Drawing & stroke helpers
   **********************/
  function paintPointOnMesh(mesh, u, v, color, radiusPx) {
    if (!mesh?.userData?.ctx) return;
    const ctx = mesh.userData.ctx;
    const x = Math.round(u * mesh.userData.w);
    const y = Math.round((1 - v) * mesh.userData.h);
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
    ctx.fill();
    mesh.userData.tex.needsUpdate = true;
  }

  function drawStrokeOnPlane(planeId, stroke) {
    const obj = planeObjects.get(planeId);
    if (!obj) return;
    const mesh = obj.mesh;
    const ctx = mesh.userData.ctx;
    const w = mesh.userData.w, h = mesh.userData.h;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = stroke.color || "#ffffff";
    ctx.lineWidth = stroke.width || 8;
    const pts = stroke.points || [];
    if (pts.length === 0) return;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = p.u * w;
      const y = (1 - p.v) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    mesh.userData.tex.needsUpdate = true;
  }

  async function createStrokeNode(planeId, color, width) {
    const strokesRef = ref(db, `planes/${planeId}/strokes`);
    const newStrokeRef = push(strokesRef);
    await set(newStrokeRef, { color, width, createdAt: Date.now() });
    lastCreatedStrokeId = newStrokeRef.key;
    return newStrokeRef.key;
  }

  async function pushPointsForStroke(planeId, strokeId, points) {
    if (!points || points.length === 0) return;
    const ptsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
    // batch update using push keys
    const updates = {};
    points.forEach(p => {
      const key = push(ptsRef).key;
      updates[key] = { u: p.u, v: p.v, t: Date.now() };
    });
    await update(ref(db, `planes/${planeId}/strokes/${strokeId}/points`), updates);
  }

  /**********************
   * Geolocation & heading helpers
   **********************/
  function getCurrentPositionPromise() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("No geolocation available"));
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 });
    });
  }

  let lastHeading = 0;
  function startHeadingWatcher() {
    // read alpha from DeviceOrientationEvent
    const handler = (ev) => {
      if (ev && (ev.absolute === true || ev.alpha != null)) {
        lastHeading = ev.alpha || lastHeading;
      }
    };
    // iOS permissions
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission?.().then(p => {
        if (p === "granted") window.addEventListener("deviceorientation", handler, true);
      }).catch(() => { /* ignore */ });
    } else {
      window.addEventListener("deviceorientation", handler, true);
    }
  }

  /**********************
   * Plane placement flows
   **********************/
  async function placeNewPlaneAtPose(pose, geoOpt) {
    // pose: { position: Vector3, quaternion: Quaternion } in world coordinates (three.js)
    // geoOpt: { lat, lon, alt, heading }
    const meta = {
      createdAt: Date.now(),
      widthMeters: 2.5,
      heightMeters: 2.5,
      arPose: pose ? {
        x: pose.position.x, y: pose.position.y, z: pose.position.z,
        qx: pose.quaternion.x, qy: pose.quaternion.y, qz: pose.quaternion.z, qw: pose.quaternion.w
      } : null,
      lat: geoOpt?.lat ?? null,
      lon: geoOpt?.lon ?? null,
      alt: geoOpt?.alt ?? null,
      headingAtPlace: geoOpt?.heading ?? null
    };
    const newRef = push(planesRef);
    await set(newRef, meta);
    localPlaneId = newRef.key;
    setStatus("Canvas placed");
    return localPlaneId;
  }

  async function createLocalPlaneImmediate(posVec3, quat, geoOpt) {
    // For immediate local feedback (we still rely on Firebase onChildAdded to create fully)
    const mesh = createDrawingPlaneMesh(2.5, 2.5);
    mesh.position.copy(posVec3);
    mesh.quaternion.copy(quat);
    scene.add(mesh);
    const grid = makeGrid(2.5, 8);
    grid.position.set(mesh.position.x, 0, mesh.position.z);
    scene.add(grid);
    // create metadata and push to DB
    const meta = {
      createdAt: Date.now(),
      widthMeters: 2.5,
      heightMeters: 2.5,
      arPose: {
        x: posVec3.x, y: posVec3.y, z: posVec3.z,
        qx: quat.x, qy: quat.y, qz: quat.z, qw: quat.w
      },
      lat: geoOpt?.lat ?? null,
      lon: geoOpt?.lon ?? null,
      alt: geoOpt?.alt ?? null,
      headingAtPlace: geoOpt?.heading ?? null
    };
    const newRef = push(planesRef);
    await set(newRef, meta);
    localPlaneId = newRef.key;
    planeObjects.set(localPlaneId, { mesh, meta, grid });
    return localPlaneId;
  }

  /**********************
   * WebXR: start session & hit-test
   **********************/
  let xrSession = null;
  let xrRefSpace = null;
  let viewerSpace = null;
  let hitTestSource = null;

  async function startARSession() {
    try {
      xrSession = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test", "local-floor"],
        optionalFeatures: ["dom-overlay", "local"]
      });
    } catch (e) {
      console.error("XR requestSession failed:", e);
      setStatus("AR session failed");
      return;
    }

    renderer.xr.enabled = true;
    await renderer.xr.setSession(xrSession);
    setStatus("AR active — look around until reticle appears");

    xrRefSpace = await xrSession.requestReferenceSpace("local-floor");
    viewerSpace = await xrSession.requestReferenceSpace("viewer");
    hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });

    xrSession.addEventListener("end", () => {
      renderer.xr.enabled = false;
      hitTestSource = null;
      xrSession = null;
      setStatus("AR session ended");
      placePlaneBtn.style.display = "none";
    });

    // show place button
    placePlaneBtn.style.display = "";

    // heading watcher for geo fallback
    startHeadingWatcher();

    // render loop with frame hit-tests
    renderer.setAnimationLoop((time, frame) => {
      // hit test
      if (frame && hitTestSource) {
        const hitResults = frame.getHitTestResults(hitTestSource);
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
  }

  /**********************
   * Fallback camera mode (non-WebXR) — works on iPhone Safari
   **********************/
  let fallbackStream = null;
  async function startFallbackCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Camera not available");
      throw new Error("No getUserMedia");
    }
    try {
      fallbackStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      cameraVideo.srcObject = fallbackStream;
      cameraVideo.style.display = "";
      try { await cameraVideo.play(); } catch (e) { console.warn("video.play blocked", e); }
      setStatus("Camera active — Place Canvas");
      startHeadingWatcher();
    } catch (e) {
      console.error("startFallbackCamera failed:", e);
      setStatus("Camera permission required");
      throw e;
    }
  }

  /**********************
   * UI wiring
   **********************/
  enterArBtn.addEventListener("click", async () => {
    setStatus("Starting AR...");
    // Try immersive-ar first
    if (navigator.xr && navigator.xr.isSessionSupported) {
      try {
        const supported = await navigator.xr.isSessionSupported("immersive-ar");
        if (supported) {
          await startARSession();
          return;
        }
      } catch (e) {
        console.warn("isSessionSupported error", e);
      }
    }
    // otherwise fallback: camera + geo placement
    try {
      await startFallbackCamera();
      placePlaneBtn.style.display = "";
      setStatus("Fallback ready — Place Canvas");
    } catch (e) {
      setStatus("Could not start camera");
    }
  });

  placePlaneBtn.addEventListener("click", async () => {
    setStatus("Placing canvas...");
    // If AR session & reticle visible -> use reticle pose
    if (xrSession && reticle.visible) {
      const m = new THREE.Matrix4().copy(reticle.matrix);
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      m.decompose(pos, quat, new THREE.Vector3());
      try {
        const geo = await (async () => { try { const p = await getCurrentPositionPromise(); return { lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude ?? 0, heading: lastHeading || 0 }; } catch { return null; } })();
        await placeNewPlaneAtPose({ position: pos, quaternion: quat }, geo);
        setStatus("Canvas placed (AR)");
      } catch (e) {
        console.warn("placeNewPlaneAtPose failed", e);
        setStatus("Placement failed");
      }
    } else {
      // fallback: place in front of camera at fixed distance
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const pos = camera.position.clone().add(forward.multiplyScalar(2.5));
      const quat = camera.quaternion.clone();
      try {
        const geo = await (async () => { try { const p = await getCurrentPositionPromise(); return { lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude ?? 0, heading: lastHeading || 0 }; } catch { return null; } })();
        await placeNewPlaneAtPose({ position: pos, quaternion: quat }, geo);
        setStatus("Canvas placed (fallback)");
      } catch (e) {
        console.warn("fallback place failed", e);
        setStatus("Placement failed");
      }
    }
  });

  clearBtn.addEventListener("click", async () => {
    if (!confirm("Clear ALL canvases and strokes in the database? This cannot be undone.")) return;
    try {
      await remove(planesRef);
      planeObjects.forEach(obj => {
        try { obj.mesh.geometry.dispose(); obj.mesh.material.map?.dispose(); obj.mesh.material.dispose(); } catch (e) {}
        scene.remove(obj.mesh);
        if (obj.grid) { try { obj.grid.geometry.dispose(); obj.grid.material.dispose(); } catch (e) {} scene.remove(obj.grid); }
      });
      planeObjects.clear();
      localPlaneId = null;
      setStatus("Cleared all canvases");
    } catch (e) {
      console.error("clear failed", e);
      setStatus("Clear failed");
    }
  });

  /**********************
   * Interaction: spraying via center aim (tilt phone) — press-and-hold + volume/space keys
   **********************/
  let spraying = false;
  let sampleTimer = null;
  let currentStrokeId = null;
  let sampleBuffer = [];
  let lastUV = null;

  async function startSpray() {
    if (spraying) return;
    // need a local plane to draw on
    if (!localPlaneId) {
      setStatus("Place canvas first");
      return;
    }
    spraying = true;
    sampleBuffer = [];
    lastUV = null;
    // create stroke on server
    const color = colorPicker?.value || "#00ffd0";
    const width = parseInt(brushRange?.value || 12, 10) || 12;
    try {
      currentStrokeId = await createStrokeNode(localPlaneId, color, width);
      // sample every 50ms
      sampleTimer = setInterval(() => {
        // compute center aim point on floor
        const pt = computeCenterAimPointOnFloor();
        if (!pt) return;
        const obj = planeObjects.get(localPlaneId);
        if (!obj) return;
        const uv = worldPointToPlaneUV(obj.mesh, pt);
        // smoothing + interpolation to avoid 1D lines: interpolate between lastUV and uv
        if (lastUV) {
          const dist = Math.hypot(lastUV.u - uv.u, lastUV.v - uv.v);
          const steps = Math.max(1, Math.floor(dist * 200));
          for (let i = 1; i <= steps; i++) {
            const t = i / Math.max(1, steps);
            const iu = THREE.MathUtils.lerp(lastUV.u, uv.u, t);
            const iv = THREE.MathUtils.lerp(lastUV.v, uv.v, t);
            paintPointOnMesh(obj.mesh, iu, iv, color, width * 0.6);
            sampleBuffer.push({ u: iu, v: iv });
          }
        } else {
          paintPointOnMesh(obj.mesh, uv.u, uv.v, color, width * 0.6);
          sampleBuffer.push({ u: uv.u, v: uv.v });
        }
        lastUV = uv;
        // flush periodically to server
        if (sampleBuffer.length >= 8) {
          const flush = sampleBuffer.splice(0, sampleBuffer.length);
          pushPointsForStroke(localPlaneId, currentStrokeId, flush).catch(e => console.warn("pushPoints error", e));
        }
      }, 50);
      setStatus("Spraying...");
    } catch (e) {
      console.warn("startSpray failed", e);
      setStatus("Failed to start stroke");
      spraying = false;
    }
  }

  async function stopSpray() {
    if (!spraying) return;
    spraying = false;
    if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
    // flush remaining
    if (sampleBuffer.length > 0 && currentStrokeId) {
      const buf = sampleBuffer.splice(0, sampleBuffer.length);
      await pushPointsForStroke(localPlaneId, currentStrokeId, buf).catch(e => console.warn(e));
    }
    currentStrokeId = null;
    lastUV = null;
    setStatus("Ready");
  }

  // Press & hold on canvas to spray
  canvasEl.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    startSpray().catch(e => console.warn(e));
  });
  window.addEventListener("pointerup", (ev) => {
    ev.preventDefault();
    stopSpray().catch(e => console.warn(e));
  });

  // keyboard / space triggers
  window.addEventListener("keydown", (ev) => {
    if (ev.code === "Space") {
      ev.preventDefault();
      startSpray().catch(()=>{});
    }
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.code === "Space") {
      ev.preventDefault();
      stopSpray().catch(()=>{});
    }
  });

  // volume keys (some browsers deliver them as key events, others don't)
  window.addEventListener("keydown", (ev) => {
    if (ev.code === "AudioVolumeDown" || ev.code === "AudioVolumeUp") {
      ev.preventDefault();
      startSpray().catch(()=>{});
    }
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.code === "AudioVolumeDown" || ev.code === "AudioVolumeUp") {
      ev.preventDefault();
      stopSpray().catch(()=>{});
    }
  });

  /**********************
   * Pointer/touch drawing on placed plane (non-center-aim) — optional (tap to draw directly)
   **********************/
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerActivePlane = null;
  let pointerCurrentStroke = null;

  canvasEl.addEventListener("pointerdown", async (ev) => {
    // calculate pointer intersection
    pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
    pointer.y = - (ev.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    // gather plane meshes
    const meshes = [];
    planeObjects.forEach((v) => { if (v && v.mesh) meshes.push(v.mesh); });
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      const hit = hits[0];
      const mesh = hit.object;
      const planeId = [...planeObjects.entries()].find(([id, val]) => val.mesh === mesh)?.[0];
      if (!planeId) return;
      pointerActivePlane = planeId;
      const uv = hit.uv;
      pointerCurrentStroke = { color: colorPicker?.value || "#00ffd0", width: parseInt(brushRange?.value||12,10) || 12, points: [{ u: uv.x, v: uv.y }] };
      // draw immediate
      drawStrokeOnPlane(planeId, pointerCurrentStroke);
    }
  });

  canvasEl.addEventListener("pointermove", (ev) => {
    if (!pointerActivePlane || !pointerCurrentStroke) return;
    pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
    pointer.y = - (ev.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const mesh = planeObjects.get(pointerActivePlane).mesh;
    const inter = raycaster.intersectObject(mesh, false);
    if (inter.length === 0) return;
    const uv = inter[0].uv;
    pointerCurrentStroke.points.push({ u: uv.x, v: uv.y });
    // draw incremental last segment
    const len = pointerCurrentStroke.points.length;
    if (len >= 2) {
      drawStrokeOnPlane(pointerActivePlane, { color: pointerCurrentStroke.color, width: pointerCurrentStroke.width, points: [pointerCurrentStroke.points[len-2], pointerCurrentStroke.points[len-1]] });
    }
  });

  canvasEl.addEventListener("pointerup", async (ev) => {
    if (!pointerActivePlane || !pointerCurrentStroke) { pointerActivePlane = null; pointerCurrentStroke = null; return; }
    // push stroke to DB
    const strokesRef = ref(db, `planes/${pointerActivePlane}/strokes`);
    const newStrokeRef = push(strokesRef);
    await set(newStrokeRef, {
      color: pointerCurrentStroke.color,
      width: pointerCurrentStroke.width,
      createdAt: Date.now()
    });
    // push points as child nodes
    const ptsRef = ref(db, `planes/${pointerActivePlane}/strokes/${newStrokeRef.key}/points`);
    const updates = {};
    pointerCurrentStroke.points.forEach(p => {
      const k = push(ptsRef).key;
      updates[k] = { u: p.u, v: p.v, t: Date.now() };
    });
    await update(ref(db, `planes/${pointerActivePlane}/strokes/${newStrokeRef.key}/points`), updates);
    pointerActivePlane = null;
    pointerCurrentStroke = null;
  });

  /**********************
   * Render loop + UI housekeeping
   **********************/
  function renderLoop() {
    requestAnimationFrame(renderLoop);
    // update reticle position when XR not active? reticle used in XR only.
    // keep crosshair visible (center dot)
    renderer.render(scene, camera);
  }
  renderLoop();

  // resize
  window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  /**********************
   * Network status
   **********************/
  const connectedRef = ref(db, ".info/connected");
  onValue(connectedRef, (snap) => {
    const val = snap.val();
    if (!netEl) return;
    if (val) {
      netEl.className = "connected";
      netEl.style.background = "#0f0";
      netEl.style.boxShadow = "0 0 8px rgba(0,255,0,0.45)";
    } else {
      netEl.className = "offline";
      netEl.style.background = "#f44";
      netEl.style.boxShadow = "0 0 8px rgba(255,68,68,0.45)";
    }
  });

  /**********************
   * Initial UI state
   **********************/
  setStatus("Ready — Enter AR (preferred) or use fallback");
  // expose a helper to test: window.__surfaceless_state = { planeObjects, db } etc
  window.__surfaceless_state = { planeObjects, db };

  console.log("SurfaceLess main module loaded");
} // end guard
