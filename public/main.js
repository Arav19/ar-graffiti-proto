// public/main.js
// Refactored AR graffiti with Firebase realtime sync - Fixed duplicate planes & optimized performance
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

/* ===== FIREBASE CONFIG ===== */
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

/* ===== Prevent double execution ===== */
if (window.__surfaceless_main_loaded) {
  console.warn("main.js already executed — skipping");
} else {
  window.__surfaceless_main_loaded = true;

  window.addEventListener("DOMContentLoaded", () => {
    console.log("DOM loaded — starting app bootstrap");

    /* ===== DOM elements ===== */
    const enableCameraBtn = document.getElementById("enableCameraBtn");
    const cameraSelect = document.getElementById("cameraSelect");
    const placeCanvasBtn = document.getElementById("placeCanvasBtn");
    const clearBtn = document.getElementById("clearBtn");
    const undoBtn = document.getElementById("undoBtn");
    const colorPicker = document.getElementById("colorPicker");
    const brushRange = document.getElementById("brushRange");
    const statusEl = document.getElementById("status");
    const hintEl = document.getElementById("hint");
    const networkStatusEl = document.getElementById("networkStatus");
    const videoEl = document.getElementById("camera-feed");
    const canvasEl = document.getElementById("three-canvas");

    if (!canvasEl) {
      console.error("Missing #three-canvas in HTML");
      if (statusEl) statusEl.textContent = "UI error: canvas missing";
      return;
    }

    // Initial UI state
    updateStatus("Ready — enable camera to begin");

    /* ===== Utility Functions ===== */
    function updateStatus(text, type = "normal") {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.className = type === "offline" ? "offline" : "connected";
    }

    function getUniqueUserId() {
      let uid = localStorage.getItem("surfaceless_uid");
      if (!uid) {
        uid = "user_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
        localStorage.setItem("surfaceless_uid", uid);
      }
      return uid;
    }

    /* ===== Camera state ===== */
    let camVideo = videoEl || null;
    let camStream = null;
    let chosenDeviceId = null;
    let cameraEnabled = false;

    /* ===== THREE.js setup ===== */
    const renderer = new THREE.WebGLRenderer({ 
      canvas: canvasEl, 
      antialias: true, 
      alpha: true 
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(
      70, 
      window.innerWidth / window.innerHeight, 
      0.01, 
      1000
    );
    camera.position.set(0, 1.6, 0);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    scene.add(hemi);

    /* ===== Reticle & crosshair ===== */
    function makeReticle(r = 0.15) {
      const geo = new THREE.RingGeometry(r * 0.85, r, 32).rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ 
        color: 0x00ffff, 
        transparent: true, 
        opacity: 0.95 
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      scene.add(m);
      return m;
    }

    function makeCross(r = 0.06) {
      const geo = new THREE.CircleGeometry(r, 24).rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ 
        color: 0x00ffd0, 
        transparent: true, 
        opacity: 0.45 
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      scene.add(m);
      return m;
    }

    const reticle = makeReticle(0.18);
    const crosshair = makeCross(0.06);

    /* ===== Drawing plane (canvas texture) ===== */
    function createDrawingPlaneMesh(widthMeters = 3, heightMeters = 3) {
      const texSize = window.devicePixelRatio > 2 ? 2048 : 1024;
      const c = document.createElement("canvas");
      c.width = texSize;
      c.height = texSize;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, texSize, texSize);

      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.flipY = false;

      const geom = new THREE.PlaneGeometry(widthMeters, heightMeters);
      const mat = new THREE.MeshStandardMaterial({ 
        map: tex, 
        transparent: true, 
        side: THREE.DoubleSide, 
        roughness: 1, 
        metalness: 0 
      });
      
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0;
      mesh.userData = { 
        canvas: c, 
        ctx, 
        tex, 
        w: texSize, 
        h: texSize, 
        widthMeters, 
        heightMeters,
        renderedStrokes: new Set() // Track which strokes we've already painted
      };
      
      return mesh;
    }

    /* ===== Grid overlay helper ===== */
    function makeGridMesh(size = 3, divisions = 12) {
      const g = new THREE.GridHelper(size, divisions, 0x999999, 0x333333);
      g.material.opacity = 0.35;
      g.material.transparent = true;
      g.rotation.x = -Math.PI / 2;
      g.position.y = 0.002;
      return g;
    }

    /* ===== State ===== */
    const planeObjects = new Map(); // planeId -> {mesh, meta, grid}
    let localPlacedPlaneId = null;
    let lastStrokeId = null;

    let spraying = false;
    let samplingTimer = null;
    let strokeBuffer = [];
    let currentStrokeId = null;
    let lastSamplePoint = null;
    let flushTimeout = null;

    /* ===== DeviceOrientation helpers ===== */
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
    window.addEventListener('orientationchange', () => {
      screenOrientation = window.orientation || 0;
    });

    function handleDeviceOrientationEvent(ev) {
      if (!ev) return;
      setObjectQuaternion(
        camera.quaternion, 
        ev.alpha, 
        ev.beta, 
        ev.gamma, 
        screenOrientation || 0
      );
    }

    function startOrientationWatcher() {
      window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true);
    }

    /* ===== Reticle ray -> floor (y=0) intersection ===== */
    function computeReticlePointOnFloor() {
      const origin = new THREE.Vector3();
      camera.getWorldPosition(origin);
      const dir = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(camera.quaternion)
        .normalize();
      
      if (Math.abs(dir.y) < 1e-6) return null;
      
      const t = -origin.y / dir.y;
      if (t <= 0) return null;
      
      return origin.clone().add(dir.multiplyScalar(t));
    }

    /* ===== Painting primitives ===== */
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
      return { 
        u: THREE.MathUtils.clamp(u, 0, 1), 
        v: THREE.MathUtils.clamp(1 - v, 0, 1) 
      };
    }

    /* ===== Firebase stroke helpers (OPTIMIZED) ===== */
    async function createStrokeForPlane(planeId, color, width) {
      const strokesRef = ref(db, `planes/${planeId}/strokes`);
      const strokeRef = push(strokesRef);
      await set(strokeRef, { 
        color, 
        width, 
        ownerId: getUniqueUserId(),
        createdAt: Date.now() 
      });
      lastStrokeId = strokeRef.key; // Track for undo
      return strokeRef.key;
    }

    async function pushPointsForStroke(planeId, strokeId, points) {
      if (!points || points.length === 0) return;
      
      const pointsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
      const updates = {};
      
      points.forEach(p => {
        const key = push(pointsRef).key;
        updates[key] = { u: p.u, v: p.v, t: Date.now() };
      });
      
      await update(ref(db, `planes/${planeId}/strokes/${strokeId}/points`), updates);
    }

    /* ===== Listen remote planes & strokes (OPTIMIZED) ===== */
    function listenStrokesForPlane(planeId, mesh) {
      const strokesRef = ref(db, `planes/${planeId}/strokes`);
      
      onChildAdded(strokesRef, (sSnap) => {
        const strokeId = sSnap.key;
        const meta = sSnap.val();
        
        if (mesh.userData.renderedStrokes.has(strokeId)) return;
        mesh.userData.renderedStrokes.add(strokeId);
        
        const ptsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
        
        // Listen for individual point additions instead of full snapshots
        onChildAdded(ptsRef, (ptSnap) => {
          const pt = ptSnap.val();
          if (!pt) return;
          paintCircleOnMesh(mesh, pt.u, pt.v, meta.color || '#ffffff', meta.width || 8);
        });
      });
    }

    /* ===== Firebase plane listeners ===== */
    onChildAdded(planesRef, (snap) => {
      const id = snap.key;
      const meta = snap.val();
      if (!meta) return;
      if (planeObjects.has(id)) return;

      const mesh = createDrawingPlaneMesh(
        meta.widthMeters || 3, 
        meta.heightMeters || 3
      );
      mesh.name = `plane-${id}`;
      
      // Place from stored position or fallback
      if (meta.pos && typeof meta.pos.x === 'number') {
        mesh.position.set(meta.pos.x, 0, meta.pos.z);
      } else {
        const rp = computeReticlePointOnFloor();
        if (rp) {
          mesh.position.set(rp.x, 0, rp.z);
        } else {
          mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
        }
      }
      
      scene.add(mesh);
      
      const grid = makeGridMesh(
        mesh.userData.widthMeters, 
        Math.round(mesh.userData.widthMeters * 4)
      );
      grid.position.copy(mesh.position);
      scene.add(grid);
      
      planeObjects.set(id, { mesh, meta, grid });
      listenStrokesForPlane(id, mesh);
      
      // Show undo button if this is our local plane
      if (id === localPlacedPlaneId && undoBtn) {
        undoBtn.style.display = '';
      }
    });

    onChildRemoved(planesRef, (snap) => {
      const id = snap.key;
      const obj = planeObjects.get(id);
      if (!obj) return;
      
      // Dispose THREE.js resources properly
      obj.mesh.geometry.dispose();
      obj.mesh.material.map.dispose();
      obj.mesh.material.dispose();
      scene.remove(obj.mesh);
      
      if (obj.grid) {
        obj.grid.geometry.dispose();
        obj.grid.material.dispose();
        scene.remove(obj.grid);
      }
      
      planeObjects.delete(id);
      
      // Hide undo button if we removed our local plane
      if (id === localPlacedPlaneId) {
        localPlacedPlaneId = null;
        if (undoBtn) undoBtn.style.display = 'none';
      }
    });

    /* ===== Network status monitoring ===== */
    const connectedRef = ref(db, '.info/connected');
    onValue(connectedRef, (snap) => {
      const connected = snap.val();
      if (networkStatusEl) {
        networkStatusEl.className = connected ? 'connected' : 'offline';
      }
      if (statusEl && !spraying && !connected) {
        updateStatus("OFFLINE - Changes will sync when reconnected", "offline");
      }
    });

    /* ===== Create local plane (FIXED - no duplicate) ===== */
    async function createLocalPlaneAndPush() {
      if (localPlacedPlaneId && planeObjects.has(localPlacedPlaneId)) {
        return localPlacedPlaneId;
      }
      
      const rp = computeReticlePointOnFloor();
      const pos = rp 
        ? { x: rp.x, z: rp.z } 
        : { x: 0, z: -2 - planeObjects.size * 0.5 };
      
      // Only push metadata - let onChildAdded create the mesh
      const meta = {
        createdAt: Date.now(),
        ownerId: getUniqueUserId(),
        widthMeters: 3,
        heightMeters: 3,
        pos
      };
      
      const newRef = push(planesRef);
      await set(newRef, meta);
      localPlacedPlaneId = newRef.key;
      
      console.log("Created local plane", localPlacedPlaneId, meta);
      return localPlacedPlaneId;
    }

    /* ===== Sampling & painting loop (with debounced flush) ===== */
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
        // Interpolate between last point and current
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
      
      // Debounced flush to reduce Firebase writes
      clearTimeout(flushTimeout);
      flushTimeout = setTimeout(() => {
        if (strokeBuffer.length > 0 && currentStrokeId) {
          const flush = strokeBuffer.splice(0, strokeBuffer.length);
          pushPointsForStroke(localPlacedPlaneId, currentStrokeId, flush)
            .catch(e => console.warn("Failed to push points:", e));
        }
      }, 100);
    }

    async function startSpraying() {
      if (spraying) return;
      
      if (!localPlacedPlaneId) {
        updateStatus("Placing canvas...");
        try {
          await createLocalPlaneAndPush();
          updateStatus("Canvas placed — spraying...");
        } catch (e) {
          console.error("Failed to create plane:", e);
          updateStatus("Failed to create canvas");
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
        samplingTimer = setInterval(sampleAndPaint, 60);
        updateStatus("Spraying...");
        
        // Visual feedback on crosshair
        crosshair.material.opacity = 0.8;
      } catch (e) {
        console.error("Failed to start stroke:", e);
        spraying = false;
        updateStatus("Failed to start spraying");
      }
    }

    async function stopSpraying() {
      if (!spraying) return;
      
      spraying = false;
      
      if (samplingTimer) {
        clearInterval(samplingTimer);
        samplingTimer = null;
      }
      
      clearTimeout(flushTimeout);
      
      // Final flush
      if (strokeBuffer.length > 0 && currentStrokeId) {
        const buf = strokeBuffer.splice(0, strokeBuffer.length);
        await pushPointsForStroke(localPlacedPlaneId, currentStrokeId, buf)
          .catch(e => console.warn("Failed to flush stroke:", e));
      }
      
      currentStrokeId = null;
      lastSamplePoint = null;
      
      // Reset crosshair opacity
      crosshair.material.opacity = 0.45;
      
      updateStatus("Ready to spray");
    }

    /* ===== Undo last stroke ===== */
    async function undoLastStroke() {
      if (!lastStrokeId || !localPlacedPlaneId) {
        updateStatus("Nothing to undo");
        return;
      }
      
      try {
        const strokeRef = ref(db, `planes/${localPlacedPlaneId}/strokes/${lastStrokeId}`);
        await remove(strokeRef);
        
        // Clear and redraw canvas from remaining strokes
        const planeObj = planeObjects.get(localPlacedPlaneId);
        if (planeObj && planeObj.mesh.userData.ctx) {
          const ctx = planeObj.mesh.userData.ctx;
          ctx.clearRect(0, 0, planeObj.mesh.userData.w, planeObj.mesh.userData.h);
          planeObj.mesh.userData.tex.needsUpdate = true;
          planeObj.mesh.userData.renderedStrokes.clear();
        }
        
        lastStrokeId = null;
        updateStatus("Stroke undone");
      } catch (e) {
        console.warn("Failed to undo:", e);
        updateStatus("Undo failed");
      }
    }

    /* ===== Camera helpers ===== */
    async function getCameras() {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        return devs.filter(d => d.kind === 'videoinput');
      } catch (e) {
        console.warn("Failed to enumerate devices:", e);
        return [];
      }
    }

    async function startCamera(deviceId = null) {
      if (camStream) {
        camStream.getTracks().forEach(t => t.stop());
        camStream = null;
      }
      
      const constraints = deviceId 
        ? { video: { deviceId: { exact: deviceId } }, audio: false }
        : { video: { facingMode: { ideal: "environment" } }, audio: false };
      
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
      
      try {
        await camVideo.play();
      } catch (e) {
        console.warn("Video autoplay blocked:", e);
      }
      
      cameraEnabled = true;
      updateStatus("Camera ready — place canvas or hold to spray");
    }

    /* ===== Enable Camera button ===== */
    if (enableCameraBtn) {
      enableCameraBtn.addEventListener("click", async () => {
        enableCameraBtn.disabled = true;
        updateStatus("Requesting camera & motion permissions...");
        
        try {
          // Request device orientation permission on iOS (must be from user gesture)
          if (typeof DeviceMotionEvent !== "undefined" && 
              typeof DeviceMotionEvent.requestPermission === "function") {
            try {
              const p = await DeviceMotionEvent.requestPermission();
              if (p === "granted") {
                console.log("Device motion permission granted");
              } else {
                console.warn("Device motion permission denied");
              }
            } catch (e) {
              console.warn("Device motion permission error:", e);
            }
          }
          
          // Request device orientation permission on iOS
          if (typeof DeviceOrientationEvent !== "undefined" && 
              typeof DeviceOrientationEvent.requestPermission === "function") {
            try {
              const p = await DeviceOrientationEvent.requestPermission();
              if (p === "granted") {
                console.log("Device orientation permission granted");
              }
            } catch (e) {
              console.warn("Device orientation permission error:", e);
            }
          }
          
          await startCamera(null);
          
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
              try {
                await startCamera(chosenDeviceId);
                updateStatus("Camera switched");
              } catch (e) {
                console.warn("Failed to switch camera:", e);
                updateStatus("Camera switch failed");
              }
            });
          }
          
          startOrientationWatcher();
          updateStatus("Camera ready — place canvas or hold to spray");
          
        } catch (err) {
          console.error("Camera/motion permission failed:", err);
          enableCameraBtn.disabled = false;
          updateStatus("Camera permission required — tap Enable Cam");
        }
      });
    }

    /* ===== Place Canvas button (with GPS sampling) ===== */
    if (placeCanvasBtn) {
      placeCanvasBtn.addEventListener("click", async () => {
        placeCanvasBtn.disabled = true;
        updateStatus("Sampling GPS — hold still...");
        
        try {
          // Sample averaged GPS
          async function sampleAndAverageGPS(n = 5, delayMs = 300) {
            const samples = [];
            
            function getCurrentPositionPromise() {
              return new Promise((resolve, reject) => {
                if (!navigator.geolocation) {
                  return reject(new Error("Geolocation not available"));
                }
                navigator.geolocation.getCurrentPosition(
                  resolve, 
                  reject, 
                  { 
                    enableHighAccuracy: true, 
                    maximumAge: 2000, 
                    timeout: 10000 
                  }
                );
              });
            }
            
            for (let i = 0; i < n; i++) {
              try {
                const p = await getCurrentPositionPromise();
                samples.push(p.coords);
                updateStatus(`GPS sample ${i + 1}/${n}...`);
              } catch (e) {
                console.warn("GPS sample failed:", e);
              }
              await new Promise(r => setTimeout(r, delayMs));
            }
            
            if (!samples.length) {
              throw new Error("No GPS samples obtained");
            }
            
            const avg = samples.reduce(
              (acc, s) => {
                acc.lat += s.latitude;
                acc.lon += s.longitude;
                acc.alt += (s.altitude || 0);
                acc.acc += (s.accuracy || 0);
                return acc;
              }, 
              { lat: 0, lon: 0, alt: 0, acc: 0 }
            );
            
            avg.lat /= samples.length;
            avg.lon /= samples.length;
            avg.alt /= samples.length;
            avg.acc /= samples.length;
            
            return avg;
          }
          
          const avg = await sampleAndAverageGPS(5, 300);
          
          // Create plane and update with GPS data
          await createLocalPlaneAndPush();
          
          // Update the plane metadata with GPS info
          if (localPlacedPlaneId) {
            const planeMetaRef = ref(db, `planes/${localPlacedPlaneId}`);
            await update(planeMetaRef, {
              lat: avg.lat,
              lon: avg.lon,
              alt: avg.alt,
              accuracy: avg.acc
            });
          }
          
          updateStatus(`Canvas placed (GPS: ±${Math.round(avg.acc)}m) — hold to spray`);
          
        } catch (e) {
          console.warn("GPS sampling failed:", e);
          updateStatus("GPS failed — placing without location");
          
          // Place canvas without GPS
          try {
            await createLocalPlaneAndPush();
            updateStatus("Canvas placed (no GPS) — hold to spray");
          } catch (e2) {
            console.error("Failed to create plane:", e2);
            updateStatus("Failed to place canvas");
          }
          
        } finally {
          placeCanvasBtn.disabled = false;
        }
      });
    }

    /* ===== Clear All button ===== */
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        const confirmed = confirm("Clear all canvases? This cannot be undone.");
        if (!confirmed) return;
        
        clearBtn.disabled = true;
        updateStatus("Clearing all...");
        
        try {
          await set(ref(db, "planes"), null);
          
          planeObjects.forEach(p => {
            p.mesh.geometry.dispose();
            p.mesh.material.map.dispose();
            p.mesh.material.dispose();
            scene.remove(p.mesh);
            
            if (p.grid) {
              p.grid.geometry.dispose();
              p.grid.material.dispose();
              scene.remove(p.grid);
            }
          });
          
          planeObjects.clear();
          localPlacedPlaneId = null;
          lastStrokeId = null;
          
          if (undoBtn) undoBtn.style.display = 'none';
          
          updateStatus("All cleared");
          
        } catch (e) {
          console.warn("Clear failed:", e);
          updateStatus("Clear failed");
        } finally {
          clearBtn.disabled = false;
        }
      });
    }

    /* ===== Undo button ===== */
    if (undoBtn) {
      undoBtn.addEventListener("click", () => {
        undoLastStroke();
      });
    }

    /* ===== Input: press-and-hold (pointer & keyboard) ===== */
    function onPointerDown(e) {
      e.preventDefault();
      if (!cameraEnabled) {
        updateStatus("Enable camera first");
        return;
      }
      startSpraying().catch(err => console.warn("Start spray failed:", err));
    }
    
    function onPointerUp(e) {
      e.preventDefault();
      stopSpraying().catch(err => console.warn("Stop spray failed:", err));
    }

    canvasEl.addEventListener("pointerdown", onPointerDown);
    canvasEl.addEventListener("pointerup", onPointerUp);
    canvasEl.addEventListener("pointercancel", onPointerUp);
    canvasEl.addEventListener("pointerleave", onPointerUp);

    // Keyboard fallback (Space, Arrow keys)
    window.addEventListener("keydown", (ev) => {
      if (ev.code === "Space" || ev.code === "ArrowUp" || ev.code === "ArrowDown") {
        if (!spraying && cameraEnabled) {
          ev.preventDefault();
          startSpraying().catch(() => {});
        }
      }
    });
    
    window.addEventListener("keyup", (ev) => {
      if (ev.code === "Space" || ev.code === "ArrowUp" || ev.code === "ArrowDown") {
        if (spraying) {
          ev.preventDefault();
          stopSpraying().catch(() => {});
        }
      }
    });

    // Volume key attempts (some browsers expose these)
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "AudioVolumeDown" || ev.key === "AudioVolumeUp") {
        if (!spraying && cameraEnabled) {
          ev.preventDefault();
          startSpraying().catch(() => {});
        }
      }
    });
    
    window.addEventListener("keyup", (ev) => {
      if (ev.key === "AudioVolumeDown" || ev.key === "AudioVolumeUp") {
        if (spraying) {
          ev.preventDefault();
          stopSpraying().catch(() => {});
        }
      }
    });

    /* ===== Plane culling & visibility (optimization) ===== */
    const VISIBILITY_RADIUS = 20; // meters
    
    function updatePlaneVisibility() {
      const camPos = new THREE.Vector3();
      camera.getWorldPosition(camPos);
      
      planeObjects.forEach((obj, id) => {
        const dist = camPos.distanceTo(obj.mesh.position);
        const visible = dist < VISIBILITY_RADIUS;
        
        obj.mesh.visible = visible;
        if (obj.grid) obj.grid.visible = visible;
      });
    }

    /* ===== Render loop (with throttled reticle updates) ===== */
    let lastReticleUpdate = 0;
    const RETICLE_THROTTLE = 33; // ~30fps
    
    function renderLoop(timestamp) {
      requestAnimationFrame(renderLoop);
      
      // Throttled reticle position update
      if (timestamp - lastReticleUpdate > RETICLE_THROTTLE) {
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
        
        // Visual feedback when spraying
        if (spraying) {
          crosshair.material.opacity = 0.8 + Math.sin(timestamp * 0.01) * 0.2;
          crosshair.scale.setScalar(1 + Math.sin(timestamp * 0.015) * 0.1);
        } else {
          crosshair.material.opacity = 0.45;
          crosshair.scale.setScalar(1);
        }
        
        lastReticleUpdate = timestamp;
      }
      
      // Update plane visibility based on distance
      updatePlaneVisibility();
      
      renderer.render(scene, camera);
    }
    
    renderLoop(0);

    /* ===== Window resize handler ===== */
    window.addEventListener("resize", () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    });

    /* ===== Visibility change handler (pause when hidden) ===== */
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && spraying) {
        stopSpraying().catch(() => {});
      }
    });

    // Final ready state
    updateStatus("Ready — tap Enable Cam to begin");
    console.log("AR Graffiti app loaded successfully");
    
  }); // DOMContentLoaded
} // double-run guard