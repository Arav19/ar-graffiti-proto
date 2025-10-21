// main.js
// GPS-anchored 2D canvas drawing with touch, Firebase realtime sync, iOS camera fix
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

/* ===== FIREBASE CONFIG - your project ===== */
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

/* ===== UI Elements ===== */
const enableCameraBtn = document.getElementById("enableCameraBtn");
const placeCanvasBtn = document.getElementById("placeCanvasBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const colorPicker = document.getElementById("colorPicker");
const brushRange = document.getElementById("brushRange");

let camVideo = null; // video element for camera background
let camStream = null;

/* ===== THREE setup ===== */
const canvas = document.getElementById("three-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0); // transparent so video shows
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 1.6, 0);

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

/* ===== Globals: planes and strokes ===== */
const planeObjects = new Map(); // planeId -> { mesh, meta, strokesListeners }
let localPlacedPlaneId = null; // id of the plane this device placed (only if user placed)
let activePlaneId = null; // plane currently selected for drawing
let drawing = false;
let currentStrokeRef = null; // firebase ref path (string) for current stroke
let strokePushInterval = null; // throttle timer
let strokeLocalBuffer = []; // local points buffer to send in batches

/* ===== GPS + heading helpers ===== */
function getCurrentPositionPromise() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not available"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
  });
}

// take N GPS samples (fast) and return average lat/lon/alt
async function sampleAndAverageGPS(n = 5, delayMs = 250) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    try {
      /* eslint-disable no-await-in-loop */
      const pos = await getCurrentPositionPromise();
      samples.push(pos.coords);
      await new Promise(r => setTimeout(r, delayMs));
    } catch (e) {
      // continue; if we have none, throw later
    }
  }
  if (samples.length === 0) throw new Error("No GPS samples");
  const avg = samples.reduce((acc, s) => {
    acc.lat += s.latitude;
    acc.lon += s.longitude;
    acc.alt += (s.altitude ?? 0);
    return acc;
  }, { lat: 0, lon: 0, alt: 0 });
  avg.lat /= samples.length;
  avg.lon /= samples.length;
  avg.alt /= samples.length;
  return avg;
}

let lastHeading = 0;
function startHeadingWatcher() {
  function handle(e) {
    if (e.alpha != null) {
      lastHeading = e.alpha;
    }
  }
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission?.().then((p) => {
      if (p === "granted") window.addEventListener("deviceorientation", handle, true);
    }).catch(()=>{});
  } else {
    window.addEventListener("deviceorientation", handle, true);
  }
}

// Convert lat/lon difference to meters (approx)
function latLonToMetersDelta(lat0, lon0, lat1, lon1) {
  const R = 6378137.0;
  const dLat = (lat1 - lat0) * Math.PI / 180;
  const dLon = (lon1 - lon0) * Math.PI / 180;
  const meanLat = (lat0 + lat1) / 2 * Math.PI / 180;
  const north = dLat * R;
  const east = dLon * R * Math.cos(meanLat);
  return { east, north };
}

// Convert meter offsets (east,north) into local x,z based on device heading (degrees)
// headingDeg: 0 means facing north ; we rotate so that when device faces north, north maps to -Z
function metersToLocalXZ(east, north, headingDeg) {
  const theta = -headingDeg * Math.PI / 180;
  const x = east * Math.cos(theta) - north * Math.sin(theta);
  const z = east * Math.sin(theta) + north * Math.cos(theta);
  return { x, z: -z };
}

/* ===== Create a ground-locked drawing plane mesh with an HTML canvas texture ===== */
function createDrawingPlaneMesh(widthMeters = 3, heightMeters = 3, texSize = 1024) {
  const canvas2d = document.createElement("canvas");
  canvas2d.width = texSize;
  canvas2d.height = texSize;
  const ctx = canvas2d.getContext("2d");
  ctx.clearRect(0, 0, texSize, texSize);

  const tex = new THREE.CanvasTexture(canvas2d);
  tex.encoding = THREE.sRGBEncoding;
  tex.flipY = false;
  tex.anisotropy = 1;

  const geom = new THREE.PlaneGeometry(widthMeters, heightMeters);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
    roughness: 1,
    metalness: 0
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2; // flush to ground
  mesh.userData = { canvas: canvas2d, ctx, tex, w: texSize, h: texSize, widthMeters, heightMeters };
  return mesh;
}

/* ===== Convert plane UV to canvas pixels ===== */
function uvToPixel(uv, mesh) {
  const u = uv.x;
  const v = uv.y;
  const x = Math.round(u * mesh.userData.w);
  const y = Math.round((1 - v) * mesh.userData.h);
  return { x, y };
}

/* ===== Draw points into plane canvas locally ===== */
function drawPointsOnPlaneLocal(planeId, points, colorHex, widthPx) {
  const obj = planeObjects.get(planeId);
  if (!obj) return;
  const { mesh } = obj;
  const ctx = mesh.userData.ctx;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = colorHex;
  ctx.lineWidth = widthPx;

  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const px = Math.round(p.u * mesh.userData.w);
    const py = Math.round((1 - p.v) * mesh.userData.h);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  mesh.userData.tex.needsUpdate = true;
}

/* ======= Firebase: listen for remote planes and strokes ======= */

onChildAdded(planesRef, (snap) => {
  const id = snap.key;
  const meta = snap.val();
  if (!meta) return;
  if (planeObjects.has(id)) return;
  const width = meta.widthMeters || 3;
  const height = meta.heightMeters || 3;
  const mesh = createDrawingPlaneMesh(width, height);
  mesh.name = `plane-${id}`;

  // compute position using current device GPS + heading to reproject plane lat/lon -> local x,z
  if (meta.lat != null && meta.lon != null) {
    getCurrentPositionPromise().then((pos) => {
      const myLat = pos.coords.latitude;
      const myLon = pos.coords.longitude;
      const { east, north } = latLonToMetersDelta(myLat, myLon, meta.lat, meta.lon);
      const { x, z } = metersToLocalXZ(east, north, lastHeading || 0);
      mesh.position.set(x, 0, z);
      scene.add(mesh);
      planeObjects.set(id, { mesh, meta, strokesListeners: new Map() });
      listenForStrokesForPlane(id);
    }).catch(() => {
      // fallback: place in front
      mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
      scene.add(mesh);
      planeObjects.set(id, { mesh, meta, strokesListeners: new Map() });
      listenForStrokesForPlane(id);
    });
  } else {
    // no geo: fallback in front
    mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
    scene.add(mesh);
    planeObjects.set(id, { mesh, meta, strokesListeners: new Map() });
    listenForStrokesForPlane(id);
  }
});

onChildRemoved(planesRef, (snap) => {
  const id = snap.key;
  const obj = planeObjects.get(id);
  if (obj) {
    scene.remove(obj.mesh);
    // detach listeners if implemented
    planeObjects.delete(id);
  }
});

// Listen strokes for a plane and draw incoming points
function listenForStrokesForPlane(planeId) {
  const strokesRef = ref(db, `planes/${planeId}/strokes`);
  onChildAdded(strokesRef, (strokeSnap) => {
    const strokeId = strokeSnap.key;
    const strokeMeta = strokeSnap.val();
    if (!strokeMeta) return;
    // draw existing points (if any) and listen for added points
    const pointsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
    // attach onValue to pull current points then listen to new ones incrementally
    onValue(pointsRef, (ptsSnap) => {
      const ptsObj = ptsSnap.val();
      if (!ptsObj) return;
      // flatten to ordered array by push key order (not guaranteed sorted by time, but okay)
      const arr = Object.values(ptsObj).map(p => ({ u: p.u, v: p.v }));
      drawPointsOnPlaneLocal(planeId, arr, strokeMeta.color || "#ffffff", strokeMeta.width || 8);
    });
  });
}

/* ======= Place Canvas: sample GPS & create plane meta (no AR hit-test) ======= */

placeCanvasBtn.addEventListener("click", async () => {
  statusEl.textContent = "Sampling GPS (please hold still)...";
  placeCanvasBtn.disabled = true;
  try {
    const avg = await sampleAndAverageGPS(5, 300);
    // plane meta: lat/lon + heading + sizes
    const meta = {
      createdAt: Date.now(),
      lat: avg.lat,
      lon: avg.lon,
      alt: avg.alt,
      headingAtPlace: lastHeading || 0,
      widthMeters: 3.0,
      heightMeters: 3.0,
      creator: "anonymous"
    };
    // push plane, firebase will trigger onChildAdded to render locally & remote
    const newPlaneRef = push(planesRef);
    await set(newPlaneRef, meta);
    localPlacedPlaneId = newPlaneRef.key;
    statusEl.textContent = "Canvas placed!";
  } catch (err) {
    console.warn("GPS sample failed:", err);
    statusEl.textContent = "GPS failed. Try again.";
  } finally {
    placeCanvasBtn.disabled = false;
  }
});

/* ======= Enable camera (iOS fix) ======= */
enableCameraBtn.addEventListener("click", async () => {
  enableCameraBtn.disabled = true;
  statusEl.textContent = "Requesting camera permission...";
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    camVideo = document.createElement("video");
    camVideo.id = "camVideo";
    camVideo.autoplay = true;
    camVideo.playsInline = true;
    camVideo.muted = true;
    camVideo.srcObject = camStream;
    // append video behind canvas
    document.body.appendChild(camVideo);
    await camVideo.play(); // must be inside user gesture on iOS
    statusEl.textContent = "Camera ready — place canvas";
    placeCanvasBtn.disabled = false;
    startHeadingWatcher();
  } catch (err) {
    console.error("Camera error:", err);
    statusEl.textContent = "Camera permission denied or unavailable";
    enableCameraBtn.disabled = false;
  }
});

/* ======= Pointer drawing mapped to plane UV; stream points to Firebase ======= */

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// helper: find plane intersect and uv
function getPlaneIntersectAtPointer(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = [];
  planeObjects.forEach((v) => {
    meshes.push(v.mesh);
  });
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length === 0) return null;
  return hits[0]; // contains uv and object
}

async function startStrokeForPlane(planeId, uv) {
  // create stroke record under planes/<planeId>/strokes
  const strokesRef = ref(db, `planes/${planeId}/strokes`);
  const strokeRef = push(strokesRef);
  const meta = {
    color: colorPicker.value,
    width: parseInt(brushRange.value, 10) || 8,
    createdAt: Date.now(),
    complete: false
  };
  await set(strokeRef, meta);
  currentStrokeRef = strokeRef; // firebase ref object
  // initial point
  const firstPointRef = push(ref(db, `${strokeRef.toString().replace(/https?:\/\/[^/]+/,'')}/points`)); // workaround but not ideal
  // Note: above conversion to path uses ref path; simpler approach below: use push with path built via database root ref
  // We'll instead use push with a child ref:
  const pointsRef = ref(db, `planes/${planeId}/strokes/${strokeRef.key}/points`);
  await push(pointsRef, { u: uv.x, v: uv.y, t: Date.now() });
  // start local buffer
  strokeLocalBuffer = [{ u: uv.x, v: uv.y }];
  // start streaming interval (send buffered points every 120ms)
  strokePushInterval = setInterval(async () => {
    if (strokeLocalBuffer.length === 0) return;
    const buf = strokeLocalBuffer.splice(0, strokeLocalBuffer.length);
    // push all points
    for (const p of buf) {
      await push(pointsRef, { u: p.u, v: p.v, t: Date.now() });
    }
  }, 120);
  return { strokeRef, pointsRef };
}

async function appendPointToStroke(pointsRef, u, v) {
  strokeLocalBuffer.push({ u, v });
  // also draw incremental locally immediately
  drawPointsOnPlaneLocal(activePlaneId, [{ u, v }], colorPicker.value, parseInt(brushRange.value, 10));
}

// pointer handlers
canvas.addEventListener("pointerdown", async (ev) => {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const hit = getPlaneIntersectAtPointer(ev.clientX, ev.clientY);
  if (!hit) return;
  const planeMesh = hit.object;
  const planeId = [...planeObjects.entries()].find(([id, val]) => val.mesh === planeMesh)?.[0];
  if (!planeId) return;
  activePlaneId = planeId;
  drawing = true;
  const uv = hit.uv;
  // start stroke in Firebase
  const { pointsRef } = await startStrokeForPlane(planeId, uv);
  // store pointsRef for append
  canvas._currentPointsRef = pointsRef;
});

canvas.addEventListener("pointermove", (ev) => {
  if (!drawing || !activePlaneId) return;
  const hit = getPlaneIntersectAtPointer(ev.clientX, ev.clientY);
  if (!hit) return;
  // only if same plane
  const planeMesh = hit.object;
  const planeId = [...planeObjects.entries()].find(([id, val]) => val.mesh === planeMesh)?.[0];
  if (planeId !== activePlaneId) return;
  const uv = hit.uv;
  // append to buffer and draw locally
  if (canvas._currentPointsRef) {
    appendPointToStroke(canvas._currentPointsRef, uv.x, uv.y);
  }
});

canvas.addEventListener("pointerup", async (ev) => {
  if (!drawing || !activePlaneId) return;
  drawing = false;
  // flush buffer immediately
  if (strokePushInterval) {
    clearInterval(strokePushInterval);
    strokePushInterval = null;
  }
  // push any remaining buffered points
  if (canvas._currentPointsRef && strokeLocalBuffer.length > 0) {
    const pointsRef = canvas._currentPointsRef;
    const buf = strokeLocalBuffer.splice(0, strokeLocalBuffer.length);
    for (const p of buf) {
      await push(pointsRef, { u: p.u, v: p.v, t: Date.now() });
    }
  }
  // mark stroke complete
  // we cannot easily get strokeRef key from pointsRef path; we rely on client-side not needing to set complete flag
  canvas._currentPointsRef = null;
  activePlaneId = null;
});

/* ======= Clear All ======= */
clearBtn.addEventListener("click", async () => {
  // WARNING: clears all planes & strokes
  try {
    await set(ref(db, "planes"), null);
    planeObjects.forEach((p) => scene.remove(p.mesh));
    planeObjects.clear();
    statusEl.textContent = "Cleared all planes";
  } catch (e) {
    console.error("Clear failed", e);
  }
});

/* ======= Render loop ======= */
function animate() {
  requestAnimationFrame(animate);
  // optional: orient/scale plane meshes based on camera distance or smoothing
  renderer.render(scene, camera);
}
animate();

/* ======= Window resize ======= */
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

/* ======= Startup ======= */
statusEl.textContent = "Tap 'Enable Camera' then 'Place Canvas' to create floor canvas. Others will see it anchored by GPS.";

/* ======= Notes & Limitations =======
- This implementation anchors a planar canvas to (lat, lon) with width/height in meters.
- When placing, we average several GPS samples for better accuracy.
- Other devices reprojection: convert lat/lon -> east/north meters relative to their current position then rotate using device heading. That yields meter-level alignment (GPS-limited).
- We stream stroke points to Firebase in small batches to create live drawing updates.
- For high-precision persistent anchors across many users/time, integrate AR Cloud (Lightship or Cloud Anchors).
- DB structure:
  planes/
    <planeId> : { lat, lon, widthMeters, heightMeters, headingAtPlace, createdAt }
    planes/<planeId>/strokes/<strokeId>/points/: {u, v, t}
============================================ */

