// main.js
// Version B: 2D floor canvas anchored by GPS + heading, finger draw mapped to plane texture,
// camera background compatible with iPhone, camera device chooser, transparent grid, realtime sync

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

/* ===== UI refs ===== */
const enableCameraBtn = document.getElementById("enableCameraBtn");
const cameraSelect = document.getElementById("cameraSelect");
const placeCanvasBtn = document.getElementById("placeCanvasBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const colorPicker = document.getElementById("colorPicker");
const brushRange = document.getElementById("brushRange");

/* ===== Camera & device selection ===== */
let camVideo = null;
let camStream = null;
let chosenDeviceId = null;

async function getCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "videoinput");
  } catch (e) {
    return [];
  }
}

async function startCameraWithDevice(deviceId) {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  const constraints = {
    video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } },
    audio: false
  };
  camStream = await navigator.mediaDevices.getUserMedia(constraints);
  if (!camVideo) {
    camVideo = document.createElement("video");
    camVideo.id = "camVideo";
    camVideo.autoplay = true;
    camVideo.playsInline = true;
    camVideo.muted = true; // needed for autoplay on iOS
    document.body.appendChild(camVideo);
  }
  camVideo.srcObject = camStream;
  await camVideo.play();
  camVideo.muted = false; // unmute if you need audio (not needed)
}

/* ===== THREE setup ===== */
const threeCanvas = document.getElementById("three-canvas");
const overlayCanvas = document.getElementById("overlay-canvas");
overlayCanvas.width = window.innerWidth;
overlayCanvas.height = window.innerHeight;

const renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0); // transparent so camera shows through
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 1.6, 0);
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(hemi);

/* ===== Grid (transparent) to show ground orientation ===== */
function makeGridMesh(size = 3, divisions = 12) {
  // create a grid texture
  const canvas2 = document.createElement("canvas");
  canvas2.width = 512;
  canvas2.height = 512;
  const ctx = canvas2.getContext("2d");
  ctx.clearRect(0,0,512,512);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  const step = 512 / divisions;
  for (let i = 0; i <= divisions; i++) {
    const x = i * step;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,x); ctx.lineTo(512,x); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas2);
  tex.encoding = THREE.sRGBEncoding;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1,1);

  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.9, depthTest: true });
  const geo = new THREE.PlaneGeometry(size, size);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/* ===== Create plane mesh with canvas texture for drawing ===== */
function createDrawingPlane(widthMeters = 3, heightMeters = 3, texSize = 2048) {
  const canvas2 = document.createElement("canvas");
  canvas2.width = texSize;
  canvas2.height = texSize;
  const ctx = canvas2.getContext("2d");
  ctx.clearRect(0,0,texSize,texSize);

  const tex = new THREE.CanvasTexture(canvas2);
  tex.encoding = THREE.sRGBEncoding;
  tex.flipY = false;
  tex.anisotropy = 1;

  const geo = new THREE.PlaneGeometry(widthMeters, heightMeters);
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, metalness: 0, roughness: 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2; // flush to ground
  mesh.userData = { canvas: canvas2, ctx, tex, w: texSize, h: texSize, widthMeters, heightMeters };
  return mesh;
}

/* ===== Utility: lat/lon -> meters & reprojection ===== */
function latLonToMetersDelta(lat0, lon0, lat1, lon1) {
  const R = 6378137;
  const dLat = (lat1 - lat0) * Math.PI / 180;
  const dLon = (lon1 - lon0) * Math.PI / 180;
  const meanLat = (lat0 + lat1) / 2 * Math.PI / 180;
  const north = dLat * R;
  const east = dLon * R * Math.cos(meanLat);
  return { east, north };
}
function metersToLocalXZ(east, north, headingDeg) {
  const theta = -headingDeg * Math.PI / 180;
  const x = east * Math.cos(theta) - north * Math.sin(theta);
  const z = east * Math.sin(theta) + north * Math.cos(theta);
  return { x, z: -z };
}

/* ===== Globals: planes map and selected plane for drawing ===== */
const planeObjects = new Map(); // planeId -> { mesh, meta }
let localPlacedPlaneId = null;
let activePlaneId = null;

/* ===== GPS & heading helpers ===== */
function getCurrentPositionPromise() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("No geolocation"));
    navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
  });
}
async function sampleAndAverageGPS(n = 4, delay = 300) {
  const samples = [];
  for (let i=0;i<n;i++){
    try {
      /* eslint-disable no-await-in-loop */
      const p = await getCurrentPositionPromise();
      samples.push(p.coords);
      await new Promise(r=>setTimeout(r, delay));
    } catch(e) { /* ignore */ }
  }
  if (samples.length === 0) throw new Error("no gps samples");
  const avg = samples.reduce((acc,s)=>{acc.lat+=s.latitude;acc.lon+=s.longitude;acc.alt+= (s.altitude||0); return acc;},{lat:0,lon:0,alt:0});
  avg.lat/=samples.length; avg.lon/=samples.length; avg.alt/=samples.length;
  return avg;
}
let lastHeading = 0;
function startHeadingWatcher() {
  function handle(e) {
    if (e.alpha != null) lastHeading = e.alpha;
  }
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission?.().then(p => { if (p === "granted") window.addEventListener("deviceorientation", handle, true); }).catch(()=>{});
  } else {
    window.addEventListener("deviceorientation", handle, true);
  }
}

/* ===== Firebase listeners: planes & strokes ===== */
onChildAdded(planesRef, (snap) => {
  const id = snap.key;
  const meta = snap.val();
  if (!meta) return;
  if (planeObjects.has(id)) return;
  // create mesh
  const mesh = createDrawingPlane(meta.widthMeters || 3, meta.heightMeters || 3);
  mesh.name = `plane-${id}`;
  // compute placement from meta.lat/lon using current GPS
  if (meta.lat != null && meta.lon != null) {
    getCurrentPositionPromise().then(pos => {
      const myLat = pos.coords.latitude, myLon = pos.coords.longitude;
      const { east, north } = latLonToMetersDelta(myLat, myLon, meta.lat, meta.lon);
      const { x, z } = metersToLocalXZ(east, north, lastHeading || 0);
      mesh.position.set(x, 0, z);
      scene.add(mesh);
      // add faint grid overlay
      const grid = makeGridMesh(meta.widthMeters || 3, 12);
      grid.position.copy(mesh.position);
      grid.rotation.copy(mesh.rotation);
      grid.material.opacity = 0.18;
      scene.add(grid);
      planeObjects.set(id, { mesh, grid, meta });
      listenForStrokes(id);
    }).catch(() => {
      // fallback in front
      mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
      scene.add(mesh);
      const grid = makeGridMesh(meta.widthMeters || 3, 12);
      grid.position.copy(mesh.position);
      grid.rotation.copy(mesh.rotation);
      grid.material.opacity = 0.18;
      scene.add(grid);
      planeObjects.set(id, { mesh, grid, meta });
      listenForStrokes(id);
    });
  } else {
    mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
    scene.add(mesh);
    const grid = makeGridMesh(meta.widthMeters || 3, 12);
    grid.position.copy(mesh.position);
    grid.rotation.copy(mesh.rotation);
    grid.material.opacity = 0.18;
    scene.add(grid);
    planeObjects.set(id, { mesh, grid, meta });
    listenForStrokes(id);
  }
});
onChildRemoved(planesRef, (snap) => {
  const id = snap.key;
  const p = planeObjects.get(id);
  if (p) {
    scene.remove(p.mesh);
    if (p.grid) scene.remove(p.grid);
    planeObjects.delete(id);
  }
});

function listenForStrokes(planeId) {
  const strokesRef = ref(db, `planes/${planeId}/strokes`);
  onChildAdded(strokesRef, (sSnap) => {
    const strokeId = sSnap.key;
    // read all points under this stroke and draw
    const ptsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
    onValue(ptsRef, (pts) => {
      const val = pts.val();
      if (!val) return;
      const arr = Object.values(val).map(p => ({ u: p.u, v: p.v }));
      // meta color & width
      const meta = sSnap.val();
      if (!meta) return;
      drawPointsOnPlaneLocal(planeId, arr, meta.color || "#ffffff", meta.width || 10);
    });
  });
}

/* ===== Drawing: raycast pointer -> plane UV -> paint plane canvas & stream ===== */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function getPlaneHitFromClient(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = [];
  planeObjects.forEach(v => meshes.push(v.mesh));
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? hits[0] : null;
}

function uvToPixel(uv, mesh) {
  const u = uv.x, v = uv.y;
  const x = Math.round(u * mesh.userData.w);
  const y = Math.round((1 - v) * mesh.userData.h);
  return { x, y };
}
function drawPointsOnPlaneLocal(planeId, points, colorHex, widthPx) {
  const obj = planeObjects.get(planeId);
  if (!obj) return;
  const mesh = obj.mesh;
  const ctx = mesh.userData.ctx;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = colorHex;
  ctx.lineWidth = widthPx;
  if (points.length === 0) return;
  ctx.beginPath();
  for (let i=0;i<points.length;i++){
    const p = points[i];
    const x = Math.round(p.u * mesh.userData.w);
    const y = Math.round((1 - p.v) * mesh.userData.h);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
  mesh.userData.tex.needsUpdate = true;
}

/* ===== Stroke streaming utilities ===== */
async function startStroke(planeId, initialUV) {
  const strokesRef = ref(db, `planes/${planeId}/strokes`);
  const strokeRef = push(strokesRef);
  const meta = { color: colorPicker.value, width: parseInt(brushRange.value,10) || 10, createdAt: Date.now() };
  await set(strokeRef, meta);
  const pointsRef = ref(db, `planes/${planeId}/strokes/${strokeRef.key}/points`);
  await push(pointsRef, { u: initialUV.x, v: initialUV.y, t: Date.now() });
  return { strokeRef, pointsRef };
}
async function pushPoints(pointsRef, pts) {
  for (const p of pts) {
    await push(pointsRef, { u: p.u, v: p.v, t: Date.now() });
  }
}

/* ===== Pointer event handling (touch & mouse) ===== */
let isDrawing = false;
let currentPoints = [];
let currentPointsRef = null;
let strokePushTimer = null;
threeCanvas.addEventListener("pointerdown", async (ev) => {
  ev.preventDefault();
  const hit = getPlaneHitFromClient(ev.clientX, ev.clientY);
  if (!hit) return;
  const planeId = [...planeObjects.entries()].find(([id,val])=> val.mesh === hit.object)?.[0];
  if (!planeId) return;
  activePlaneId = planeId;
  isDrawing = true;
  const uv = hit.uv;
  // start stroke on db
  const res = await startStroke(planeId, uv);
  currentPointsRef = res.pointsRef;
  currentPoints = [{ u: uv.x, v: uv.y }];
  // also draw locally immediate
  drawPointsOnPlaneLocal(planeId, currentPoints, colorPicker.value, parseInt(brushRange.value,10));
  // start interval to flush points
  strokePushTimer = setInterval(async ()=>{
    if (!currentPointsRef || currentPoints.length === 0) return;
    const buf = currentPoints.splice(0, currentPoints.length);
    await pushPoints(currentPointsRef, buf);
  }, 180);
});
threeCanvas.addEventListener("pointermove", (ev) => {
  if (!isDrawing || !activePlaneId) return;
  const hit = getPlaneHitFromClient(ev.clientX, ev.clientY);
  if (!hit) return;
  const planeId = [...planeObjects.entries()].find(([id,val])=> val.mesh === hit.object)?.[0];
  if (planeId !== activePlaneId) return;
  const uv = hit.uv;
  currentPoints.push({ u: uv.x, v: uv.y });
  // immediate local draw small segment
  drawPointsOnPlaneLocal(activePlaneId, currentPoints.slice(-2), colorPicker.value, parseInt(brushRange.value,10));
});
threeCanvas.addEventListener("pointerup", async (ev) => {
  if (!isDrawing) return;
  isDrawing = false;
  if (strokePushTimer) { clearInterval(strokePushTimer); strokePushTimer = null; }
  if (currentPointsRef && currentPoints.length > 0) {
    const buf = currentPoints.splice(0, currentPoints.length);
    await pushPoints(currentPointsRef, buf);
  }
  currentPointsRef = null;
  currentPoints = [];
  activePlaneId = null;
});

/* ===== Place canvas: sample GPS and push plane meta ===== */
placeCanvasBtn.addEventListener("click", async () => {
  placeCanvasBtn.disabled = true;
  statusEl.textContent = "Sampling GPS, hold still...";
  try {
    const avg = await sampleAndAverageGPS(5, 300);
    const meta = {
      createdAt: Date.now(),
      lat: avg.lat,
      lon: avg.lon,
      alt: avg.alt,
      headingAtPlace: lastHeading || 0,
      widthMeters: 3.0,
      heightMeters: 3.0,
      creator: "anon"
    };
    const newRef = push(planesRef);
    await set(newRef, meta);
    localPlacedPlaneId = newRef.key;
    statusEl.textContent = "Canvas placed!";
  } catch (e) {
    console.warn(e);
    statusEl.textContent = "GPS failed. Try again";
  } finally {
    placeCanvasBtn.disabled = false;
  }
});

/* ===== Enable Camera flow (iPhone fix + device listing) ===== */
enableCameraBtn.addEventListener("click", async () => {
  enableCameraBtn.disabled = true;
  statusEl.textContent = "Requesting camera permission...";
  try {
    // start default camera first (must be user gesture)
    await startCameraWithDevice(null);
    // list cameras
    const cams = await getCameras();
    if (cams.length > 1) {
      cameraSelect.style.display = "";
      cameraSelect.innerHTML = "";
      cams.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c.deviceId;
        opt.text = c.label || `Camera ${cameraSelect.length+1}`;
        cameraSelect.appendChild(opt);
      });
      cameraSelect.addEventListener("change", async () => {
        chosenDeviceId = cameraSelect.value;
        try { await startCameraWithDevice(chosenDeviceId); statusEl.textContent = "Switched camera"; } catch(e){ console.warn(e); }
      });
    }
    placeCanvasBtn.disabled = false;
    statusEl.textContent = "Camera ready — place canvas";
    startHeadingWatcher();
  } catch (err) {
    console.error("Camera error:", err);
    statusEl.textContent = "Camera not available";
    enableCameraBtn.disabled = false;
  }
});

/* ===== Clear all ===== */
clearBtn.addEventListener("click", async () => {
  try {
    await set(ref(db, "planes"), null);
    planeObjects.forEach(p => { scene.remove(p.mesh); if (p.grid) scene.remove(p.grid); });
    planeObjects.clear();
    statusEl.textContent = "Cleared all planes";
  } catch (e) {
    console.error(e);
  }
});

/* ===== Render loop ===== */
function animate() {
  requestAnimationFrame(animate);
  // optionally update plane transforms based on device movement smoothing
  renderer.render(scene, camera);
}
animate();

/* ===== Resize ===== */
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  overlayCanvas.width = window.innerWidth;
  overlayCanvas.height = window.innerHeight;
});

/* ===== Startup ===== */
statusEl.textContent = "Tap 'Enable Camera' (iPhone requires tap). Then 'Place Canvas' to drop a floor canvas. Draw with finger.";

/* ===== Notes =====
- This version:
  - shows camera feed in background (video element appended to body)
  - places a ground-aligned plane anchored by averaged GPS lat/lon + heading
  - draws directly into the plane's texture via raycast mapping of touch to uv
  - streams strokes as small batches to Firebase so others see them live
  - shows a faint grid at the plane for orientation
- Limitations:
  - GPS-based placement = meter-level accuracy. For centimeter alignment use AR Cloud (Lightship / Cloud Anchors).
  - Drawing quality: you can add smoothing, interpolation, compression (delta threshold) later.
================================= */
