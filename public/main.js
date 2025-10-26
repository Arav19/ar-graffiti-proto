// public/main.js
// FIXED: Canvas locked to floor, 2D drawing on floor plane, proper device orientation
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
    console.log("Starting AR Graffiti app");

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
      console.error("Missing #three-canvas");
      return;
    }

    function updateStatus(text) {
      if (statusEl) statusEl.textContent = text;
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

    // Camera at eye level (1.6m above floor)
    const camera = new THREE.PerspectiveCamera(
      70, 
      window.innerWidth / window.innerHeight, 
      0.01, 
      1000
    );
    camera.position.set(0, 1.6, 0);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    scene.add(hemi);

    /* ===== Reticle on floor ===== */
    function makeReticle(r = 0.12) {
      const geo = new THREE.RingGeometry(r * 0.85, r, 32);
      geo.rotateX(-Math.PI / 2); // Lie flat on floor
      const mat = new THREE.MeshBasicMaterial({ 
        color: 0x00ffff, 
        transparent: true, 
        opacity: 0.9,
        side: THREE.DoubleSide
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      scene.add(m);
      return m;
    }

    const reticle = makeReticle(0.12);

    /* ===== Drawing plane (LOCKED TO FLOOR Y=0) ===== */
    function createDrawingPlaneMesh(widthMeters = 5, heightMeters = 5) {
      const texSize = 2048;
      const c = document.createElement("canvas");
      c.width = texSize;
      c.height = texSize;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, texSize, texSize);

      const tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.flipY = false;

      // Plane geometry lying flat
      const geom = new THREE.PlaneGeometry(widthMeters, heightMeters);
      const mat = new THREE.MeshBasicMaterial({ 
        map: tex, 
        transparent: true, 
        side: THREE.DoubleSide,
        depthWrite: false
      });
      
      const mesh = new THREE.Mesh(geom, mat);
      
      // CRITICAL: Rotate to lie flat on floor (XZ plane)
      mesh.rotation.x = -Math.PI / 2;
      
      // Position at floor level
      mesh.position.y = 0.001; // Slightly above floor to avoid z-fighting
      
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

    /* ===== Grid helper on floor ===== */
    function makeGridMesh(size = 5, divisions = 20) {
      const g = new THREE.GridHelper(size, divisions, 0x00ffff, 0x004444);
      g.material.opacity = 0.3;
      g.material.transparent = true;
      g.position.y = 0;
      return g;
    }

    /* ===== State ===== */
    const planeObjects = new Map();
    let localPlacedPlaneId = null;
    let lastStrokeId = null;

    let spraying = false;
    let samplingTimer = null;
    let strokeBuffer = [];
    let currentStrokeId = null;
    let lastSamplePoint = null;
    let flushTimeout = null;

    /* ===== Device Orientation (CAMERA ONLY, NOT CANVAS) ===== */
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
      // ONLY update camera orientation, NOT canvas
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

    /* ===== Ray cast from camera to floor (y=0) ===== */
    function computeReticlePointOnFloor() {
      const origin = new THREE.Vector3();
      camera.getWorldPosition(origin);
      
      // Cast ray straight down from camera center
      const dir = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(camera.quaternion)
        .normalize();
      
      // Check if looking down enough
      if (Math.abs(dir.y) < 0.1) return null; // Too horizontal
      
      // Intersect with floor plane (y=0)
      const t = -origin.y / dir.y;
      if (t <= 0) return null;
      
      return origin.clone().add(dir.multiplyScalar(t));
    }

    /* ===== Convert 3D world position to 2D canvas UV ===== */
    function worldToPlaneUV(mesh, worldPos) {
      // Convert world position to local mesh coordinates
      const local = mesh.worldToLocal(worldPos.clone());
      
      // Since plane is rotated -90° around X, local coords are:
      // local.x = world X (left-right)
      // local.z = world Z (forward-back) -> this becomes V
      // local.y = world Y (up-down, should be ~0 on floor)
      
      const halfW = mesh.userData.widthMeters / 2;
      const halfH = mesh.userData.heightMeters / 2;
      
      // Map local XZ to UV coordinates
      const u = (local.x + halfW) / mesh.userData.widthMeters;
      const v = (local.z + halfH) / mesh.userData.heightMeters;
      
      return { 
        u: THREE.MathUtils.clamp(u, 0, 1), 
        v: THREE.MathUtils.clamp(v, 0, 1)
      };
    }

    /* ===== Paint on canvas texture ===== */
    function paintCircleOnMesh(mesh, u, v, color, radiusPx) {
      if (!mesh || !mesh.userData || !mesh.userData.ctx) return;
      
      const ctx = mesh.userData.ctx;
      const x = Math.round(u * mesh.userData.w);
      const y = Math.round(v * mesh.userData.h);
      
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
      ctx.fill();
      
      mesh.userData.tex.needsUpdate = true;
    }

    /* ===== Firebase helpers ===== */
    async function createStrokeForPlane(planeId, color, width) {
      const strokesRef = ref(db, `planes/${planeId}/strokes`);
      const strokeRef = push(strokesRef);
      await set(strokeRef, { 
        color, 
        width, 
        ownerId: getUniqueUserId(),
        createdAt: Date.now() 
      });
      lastStrokeId = strokeRef.key;
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

    /* ===== Listen to strokes ===== */
    function listenStrokesForPlane(planeId, mesh) {
      const strokesRef = ref(db, `planes/${planeId}/strokes`);
      
      onChildAdded(strokesRef, (sSnap) => {
        const strokeId = sSnap.key;
        const meta = sSnap.val();
        
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

    /* ===== Firebase plane listeners ===== */
    onChildAdded(planesRef, (snap) => {
      const id = snap.key;
      const meta = snap.val();
      if (!meta) return;
      if (planeObjects.has(id)) return;

      const mesh = createDrawingPlaneMesh(meta.widthMeters || 5, meta.heightMeters || 5);
      mesh.name = `plane-${id}`;
      
      // CRITICAL: Place at stored position on FLOOR (y=0)
      if (meta.pos && typeof meta.pos.x === 'number') {
        mesh.position.set(meta.pos.x, 0.001, meta.pos.z);
      } else {
        // Fallback position in front of user
        mesh.position.set(0, 0.001, -2);
      }
      
      scene.add(mesh);
      
      const grid = makeGridMesh(mesh.userData.widthMeters, Math.round(mesh.userData.widthMeters * 4));
      grid.position.set(mesh.position.x, 0, mesh.position.z);
      scene.add(grid);
      
      planeObjects.set(id, { mesh, meta, grid });
      listenStrokesForPlane(id, mesh);
      
      if (id === localPlacedPlaneId && undoBtn) {
        undoBtn.style.display = '';
      }
      
      console.log(`Plane ${id} added at`, mesh.position);
    });

    onChildRemoved(planesRef, (snap) => {
      const id = snap.key;
      const obj = planeObjects.get(id);
      if (!obj) return;
      
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
      
      if (id === localPlacedPlaneId) {
        localPlacedPlaneId = null;
        if (undoBtn) undoBtn.style.display = 'none';
      }
    });

    /* ===== Network status ===== */
    const connectedRef = ref(db, '.info/connected');
    onValue(connectedRef, (snap) => {
      const connected = snap.val();
      if (networkStatusEl) {
        networkStatusEl.className = connected ? 'connected' : 'offline';
      }
    });

    /* ===== Create local plane ===== */
    async function createLocalPlaneAndPush() {
      if (localPlacedPlaneId && planeObjects.has(localPlacedPlaneId)) {
        return localPlacedPlaneId;
      }
      
      const rp = computeReticlePointOnFloor();
      const pos = rp 
        ? { x: rp.x, z: rp.z } 
        : { x: 0, z: -2 };
      
      const meta = {
        createdAt: Date.now(),
        ownerId: getUniqueUserId(),
        widthMeters: 5,
        heightMeters: 5,
        pos
      };
      
      const newRef = push(planesRef);
      await set(newRef, meta);
      localPlacedPlaneId = newRef.key;
      
      console.log("Created canvas at", pos);
      return localPlacedPlaneId;
    }

    /* ===== Draw on canvas (FIXED: 2D on floor) ===== */
    function sampleAndPaint() {
      if (!localPlacedPlaneId) return;
      
      const pt = computeReticlePointOnFloor();
      if (!pt) return;
      
      const planeObj = planeObjects.get(localPlacedPlaneId);
      if (!planeObj) return;
      
      // Convert 3D floor point to 2D canvas UV
      const uv = worldToPlaneUV(planeObj.mesh, pt);
      const brushPx = parseInt(brushRange?.value || 12, 10) || 12;
      const color = colorPicker?.value || "#00ffd0";
      
      if (lastSamplePoint) {
        // Interpolate for smooth lines
        const dist = Math.hypot(lastSamplePoint.u - uv.u, lastSamplePoint.v - uv.v);
        const steps = Math.max(1, Math.floor(dist * 300));
        
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
      
      // Debounced flush
      clearTimeout(flushTimeout);
      flushTimeout = setTimeout(() => {
        if (strokeBuffer.length > 0 && currentStrokeId) {
          const flush = strokeBuffer.splice(0, strokeBuffer.length);