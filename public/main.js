// main.js - Gyro-aim brush on a flat GPS-anchored floor canvas + Firebase realtime sync
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

/* ====== FIREBASE CONFIG (your project) ====== */
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

/* ====== UI elements ====== */
const enableCameraBtn = document.getElementById("enableCameraBtn");
const cameraSelect = document.getElementById("cameraSelect");
const placeCanvasBtn = document.getElementById("placeCanvasBtn");
const startDrawBtn = document.getElementById("startDrawBtn");
const stopDrawBtn = document.getElementById("stopDrawBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const colorPicker = document.getElementById("colorPicker");
const brushRange = document.getElementById("brushRange");

/* ====== camera variables ====== */
let camVideo = null;
let camStream = null;
let chosenDeviceId = null;

/* ====== Three.js scene setup ====== */
const canvas = document.getElementById("three-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.01, 1000);
// camera represents the device camera (we overwrite orientation from deviceorientation)
camera.position.set(0, 1.6, 0);

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

/* ====== floor canvas + reticle + grid ====== */
function createDrawingPlaneMesh(widthMeters=3,heightMeters=3,texSize=2048){
  const c = document.createElement("canvas");
  c.width = texSize; c.height = texSize;
  const ctx = c.getContext("2d");
  ctx.clearRect(0,0,texSize,texSize);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  tex.flipY = false;

  const geom = new THREE.PlaneGeometry(widthMeters, heightMeters);
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent:true, side:THREE.DoubleSide, roughness:1, metalness:0 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI/2; // flat on ground
  mesh.userData = { canvas:c, ctx, tex, w:texSize, h:texSize, widthMeters, heightMeters };
  return mesh;
}

function makeReticle(radius=0.2){
  const geo = new THREE.RingGeometry(radius*0.9, radius, 32).rotateX(-Math.PI/2);
  const mat = new THREE.MeshBasicMaterial({ color:0x00ffff, transparent:true, opacity:0.9 });
  const r = new THREE.Mesh(geo, mat);
  r.visible = false;
  scene.add(r);
  return r;
}

function makeGlowingCircle(radius=0.25){
  const geo = new THREE.CircleGeometry(radius, 32).rotateX(-Math.PI/2);
  const mat = new THREE.MeshBasicMaterial({ color:0x00ffd0, transparent:true, opacity:0.35 });
  const m = new THREE.Mesh(geo, mat);
  m.visible = false;
  scene.add(m);
  return m;
}

/* ====== GPS helpers (average samples) ====== */
function getCurrentPositionPromise() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("No geolocation"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
  });
}
async function sampleAndAverageGPS(n=5, delayMs=250){
  const samples = [];
  for (let i=0;i<n;i++){
    try { const p = await getCurrentPositionPromise(); samples.push(p.coords); }
    catch(e){ /*ignore*/ }
    await new Promise(r=>setTimeout(r, delayMs));
  }
  if (!samples.length) throw new Error("No GPS samples");
  const avg = samples.reduce((acc,s)=>{acc.lat += s.latitude; acc.lon += s.longitude; acc.alt += (s.altitude||0); return acc;},{lat:0,lon:0,alt:0});
  avg.lat /= samples.length; avg.lon /= samples.length; avg.alt /= samples.length;
  return avg;
}
function latLonToMetersDelta(lat0,lon0,lat1,lon1){
  const R = 6378137;
  const dLat = (lat1 - lat0) * Math.PI/180;
  const dLon = (lon1 - lon0) * Math.PI/180;
  const meanLat = (lat0 + lat1)/2 * Math.PI/180;
  const north = dLat * R;
  const east = dLon * R * Math.cos(meanLat);
  return { east, north };
}
function metersToLocalXZ(east,north,headingDeg){
  const theta = -headingDeg * Math.PI/180;
  const x = east * Math.cos(theta) - north * Math.sin(theta);
  const z = east * Math.sin(theta) + north * Math.cos(theta);
  return { x, z: -z };
}

/* ====== keep state ====== */
const planeObjects = new Map(); // planeId -> { mesh, meta, grid }
let localPlacedPlaneId = null;
let reticle = makeReticle();
let circleMarker = makeGlowingCircle(0.25);
let brushActive = false;
let brushSamplingTimer = null;
let brushPath = []; // accumulated points (world x,z)
let strokePointsBuffer = []; // for streaming to firebase
let currentStrokeRefPath = null; // string "planes/<id>/strokes/<strokeId>"
let currentPointsRef = null;

let lastHeading = 0;
function startHeadingWatcher(){
  function handler(e){
    if (e.alpha != null) lastHeading = e.alpha;
  }
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function"){
    DeviceOrientationEvent.requestPermission?.().then(p => { if (p === "granted") window.addEventListener("deviceorientation", handler, true); }).catch(()=>{});
  } else {
    window.addEventListener("deviceorientation", handler, true);
  }
}

/* ====== Device orientation -> quaternion helper (from three.js DeviceOrientationControls) ====== */
const zee = new THREE.Vector3(0,0,1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5),0,0,Math.sqrt(0.5)); // - PI/2 around X

function setObjectQuaternion(quaternion, alpha, beta, gamma, orient){
  const degToRad = Math.PI / 180;
  const _x = beta ? beta * degToRad : 0;
  const _y = alpha ? alpha * degToRad : 0;
  const _z = gamma ? gamma * degToRad : 0;
  euler.set(_x, _y, _z, 'ZXY');
  quaternion.setFromEuler(euler);
  quaternion.multiply(q1);
  quaternion.multiply(q0.setFromAxisAngle(zee, - orient ));
}

/* ====== orientation handling: set camera quaternion from device orientation ====== */
let screenOrientation = window.orientation || 0;
window.addEventListener('orientationchange', ()=> screenOrientation = window.orientation || 0);

function handleDeviceOrientationEvent(ev){
  if (!ev) return;
  const alpha = ev.alpha, beta = ev.beta, gamma = ev.gamma;
  // screen orientation in degrees: convert to radians for helper
  const orient = (screenOrientation || 0) * (Math.PI/180);
  const quaternion = new THREE.Quaternion();
  setObjectQuaternion(quaternion, alpha, beta, gamma, screenOrientation || 0);
  // set camera rotation to this quaternion so that camera forward vector matches device pointing
  camera.quaternion.copy(quaternion);
}

/* listen to deviceorientation (must request permission on iOS) */
function startOrientationWatcher(){
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function"){
    DeviceOrientationEvent.requestPermission?.().then(p => {
      if (p === "granted") window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true);
    }).catch(()=>{ /* ignore */});
  } else {
    window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true);
  }
}

/* ====== ray from camera center to ground y=0 -> compute aim point ====== */
function computeReticlePoint(){
  // cast a ray through screen center (0,0 NDC)
  const origin = new THREE.Vector3();
  camera.getWorldPosition(origin);
  const dir = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion).normalize();
  // intersect with plane y=0
  if (Math.abs(dir.y) < 1e-4) return null; // almost parallel
  const t = - (origin.y / dir.y); // origin.y + t*dir.y = 0 -> t = -origin.y/dir.y
  if (t <= 0) return null; // pointing upward
  const point = origin.clone().add(dir.multiplyScalar(t));
  return point;
}

/* ====== draw stroke into plane canvas (mesh.userData.ctx) ====== */
function drawSegmentOnPlaneMesh(mesh, pts, color, widthPx){
  const ctx = mesh.userData.ctx;
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (pts.length === 0) return;
  ctx.beginPath();
  for (let i=0;i<pts.length;i++){
    const u = pts[i].u, v = pts[i].v;
    const x = Math.round(u * mesh.userData.w);
    const y = Math.round((1 - v) * mesh.userData.h);
    if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
  mesh.userData.tex.needsUpdate = true;
}

/* helper convert world XZ to plane normalized UV given plane meta (placed lat/lon -> mesh position) */
/* but we store and stream strokes as UV coordinates relative to plane texture for portability */
function worldToPlaneUV(mesh, worldPos){
  // convert worldPos (Vector3) into mesh local coordinates
  const local = worldPos.clone();
  mesh.worldToLocal(local);
  // plane is widthMeters x heightMeters centered
  const halfW = mesh.userData.widthMeters / 2;
  const halfH = mesh.userData.heightMeters / 2;
  const u = (local.x + halfW) / (mesh.userData.widthMeters);
  const v = (local.z + halfH) / (mesh.userData.heightMeters); // since plane rotated, z corresponds to v
  return { u: THREE.MathUtils.clamp(u,0,1), v: THREE.MathUtils.clamp(1 - v,0,1) }; // v flip so uv maps as earlier
}

/* ====== Firebase stroke streaming: create stroke node and push points in batches ====== */
async function createStrokeForPlane(planeId, color, width){
  const strokesRef = ref(db, `planes/${planeId}/strokes`);
  const strokeRef = push(strokesRef);
  await set(strokeRef, { color, width, createdAt: Date.now() });
  return strokeRef.key;
}
async function pushPointsForStroke(planeId, strokeId, points){
  const pointsRefPath = `planes/${planeId}/strokes/${strokeId}/points`;
  for (const p of points){
    // push each point
    await push(ref(db, pointsRefPath), { u: p.u, v: p.v, t: Date.now() });
  }
}

/* ====== Place canvas flow (averaged GPS), push meta to Firebase ====== */
placeCanvasBtn.addEventListener("click", async ()=>{
  placeCanvasBtn.disabled = true;
  statusEl.textContent = 'Sampling GPS — hold still...';
  try {
    const avg = await sampleAndAverageGPS(5, 300);
    const meta = {
      createdAt: Date.now(),
      lat: avg.lat, lon: avg.lon, alt: avg.alt,
      headingAtPlace: lastHeading || 0,
      widthMeters: 3.0, heightMeters: 3.0,
      creator: "anon"
    };
    const newRef = push(planesRef);
    await set(newRef, meta);
    localPlacedPlaneId = newRef.key;
    statusEl.textContent = 'Canvas placed. You can start drawing.';
    startDrawBtn.disabled = false;
  } catch(e){
    console.warn('GPS sampling failed', e);
    statusEl.textContent = 'GPS failed — try again';
  } finally {
    placeCanvasBtn.disabled = false;
  }
});

/* ====== Listen for remote planes and strokes ====== */
onChildAdded(planesRef, (snap)=>{
  const id = snap.key;
  const meta = snap.val();
  if (!meta) return;
  if (planeObjects.has(id)) return;
  const mesh = createDrawingPlaneMesh(meta.widthMeters || 3, meta.heightMeters || 3);
  mesh.name = `plane-${id}`;
  // place using lat/lon reprojection relative to current device GPS
  if (meta.lat != null && meta.lon != null){
    getCurrentPositionPromise().then(pos => {
      const myLat = pos.coords.latitude, myLon = pos.coords.longitude;
      const { east, north } = latLonToMetersDelta(myLat,myLon, meta.lat, meta.lon);
      const { x, z } = metersToLocalXZ(east, north, lastHeading || 0);
      mesh.position.set(x,0,z);
      scene.add(mesh);
      // place circle marker as subtle indicator on remote devices too
      const grid = makeReticle(); // reuse reticle mesh but separate instance not needed; create small ring
      grid.position.copy(mesh.position);
      grid.visible = true;
      scene.add(grid);
      planeObjects.set(id, { mesh, meta, grid });
      // listen strokes
      listenStrokesForPlane(id, mesh);
    }).catch(() => {
      mesh.position.set(0,0,-2 - planeObjects.size*0.5);
      scene.add(mesh);
      planeObjects.set(id, { mesh, meta, grid:null });
      listenStrokesForPlane(id, mesh);
    });
  } else {
    mesh.position.set(0,0,-2 - planeObjects.size*0.5);
    scene.add(mesh);
    planeObjects.set(id, { mesh, meta, grid:null });
    listenStrokesForPlane(id, mesh);
  }
});
onChildRemoved(planesRef, (snap) => {
  const id = snap.key; const obj = planeObjects.get(id);
  if (obj) { scene.remove(obj.mesh); if (obj.grid) scene.remove(obj.grid); planeObjects.delete(id); }
});

function listenStrokesForPlane(planeId, mesh){
  const strokesRef = ref(db, `planes/${planeId}/strokes`);
  onChildAdded(strokesRef, (sSnap) => {
    const strokeId = sSnap.key;
    const meta = sSnap.val();
    const ptsRef = ref(db, `planes/${planeId}/strokes/${strokeId}/points`);
    onValue(ptsRef, (ptsSnap) => {
      const ptsObj = ptsSnap.val();
      if (!ptsObj) return;
      const arr = Object.values(ptsObj).map(p => ({ u: p.u, v: p.v }));
      // draw the whole stroke on the plane texture (idempotent)
      drawSegmentOnPlaneMesh(mesh, arr, meta.color||'#ffffff', meta.width||12);
    });
  });
}

/* ====== Brush: sample reticle position periodically while drawing, smooth, push to DB ====== */
async function startDrawing(){
  if (!localPlacedPlaneId) { statusEl.textContent = "Place a canvas first"; return; }
  brushActive = true;
  startDrawBtn.style.display = 'none';
  stopDrawBtn.style.display = '';
  statusEl.textContent = 'Drawing... move the phone to spray';
  // create stroke in firebase
  const strokeId = await createStrokeForPlane(localPlacedPlaneId, colorPicker.value, parseInt(brushRange.value,10) || 12);
  currentStrokeRefPath = `planes/${localPlacedPlaneId}/strokes/${strokeId}`;
  currentPointsRef = ref(db, `${currentStrokeRefPath}/points`);
  brushPath = [];
  strokePointsBuffer = [];
  // sampling loop: sample reticle every 60ms and accumulate
  brushSamplingTimer = setInterval(()=> {
    const pt = computeReticlePoint();
    if (!pt) return;
    // convert world point to plane uv on local plane mesh
    const planeObj = planeObjects.get(localPlacedPlaneId);
    if (!planeObj) return;
    const uv = worldToPlaneUV(planeObj.mesh, pt);
    // push to local buffer
    strokePointsBuffer.push(uv);
    brushPath.push(uv);
    // draw locally small segment (immediate)
    const recent = brushPath.slice(-3); // draw last 3 for smoothness
    drawSegmentOnPlaneMesh(planeObj.mesh, recent, colorPicker.value, parseInt(brushRange.value,10) || 12);
    // flush buffer to Firebase periodically
    if (strokePointsBuffer.length >= 6) {
      const flush = strokePointsBuffer.splice(0, strokePointsBuffer.length);
      // push flush to firebase (async but don't await to keep sampling smooth)
      pushPointsForStroke(localPlacedPlaneId, strokeId, flush).catch(e=>console.warn(e));
    }
  }, 60);
}

async function stopDrawing(){
  if (!brushActive) return;
  brushActive = false;
  startDrawBtn.style.display = '';
  stopDrawBtn.style.display = 'none';
  statusEl.textContent = 'Stopped drawing';
  if (brushSamplingTimer) { clearInterval(brushSamplingTimer); brushSamplingTimer = null; }
  // flush remaining
  if (strokePointsBuffer.length > 0 && currentStrokeRefPath){
    const strokeId = currentStrokeRefPath.split('/').pop();
    const buf = strokePointsBuffer.splice(0, strokePointsBuffer.length);
    await pushPointsForStroke(localPlacedPlaneId, strokeId, buf);
  }
  currentStrokeRefPath = null;
  currentPointsRef = null;
  brushPath = [];
}

/* ====== Helper worldToPlaneUV implemented here (same as earlier mapping) ====== */
function worldToPlaneUV(mesh, worldPos){
  const clone = worldPos.clone();
  mesh.worldToLocal(clone);
  const halfW = mesh.userData.widthMeters/2;
  const halfH = mesh.userData.heightMeters/2;
  const u = (clone.x + halfW) / mesh.userData.widthMeters;
  const v = (clone.z + halfH) / mesh.userData.heightMeters;
  return { u: THREE.MathUtils.clamp(u,0,1), v: THREE.MathUtils.clamp(1 - v,0,1) };
}

/* ====== Camera device helpers & iPhone fix ====== */
async function getCameras(){
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d=> d.kind === 'videoinput');
  } catch(e){ return []; }
}
async function startCamera(deviceId = null){
  if (camStream) { camStream.getTracks().forEach(t=>t.stop()); camStream = null; }
  const constraints = deviceId ? { video: { deviceId: { exact: deviceId } } } : { video: { facingMode: { ideal: 'environment' } } };
  camStream = await navigator.mediaDevices.getUserMedia(constraints);
  if (!camVideo){
    camVideo = document.createElement('video');
    camVideo.id = 'camVideo';
    camVideo.autoplay = true;
    camVideo.playsInline = true;
    camVideo.muted = true; // required for iOS autoplay in some cases
    camVideo.style.zIndex = '0';
    document.body.appendChild(camVideo);
  }
  camVideo.srcObject = camStream;
  await camVideo.play();
  camVideo.muted = false;
}

enableCameraBtn.addEventListener('click', async ()=>{
  enableCameraBtn.disabled = true;
  statusEl.textContent = 'Requesting camera...';
  try {
    await startCamera(null);
    const cams = await getCameras();
    if (cams.length > 1){ cameraSelect.style.display = ''; cameraSelect.innerHTML = ''; cams.forEach(c=>{ const opt = document.createElement('option'); opt.value = c.deviceId; opt.text = c.label || ('Camera '+(cameraSelect.length+1)); cameraSelect.appendChild(opt); }); cameraSelect.addEventListener('change', async ()=>{ chosenDeviceId = cameraSelect.value; try{ await startCamera(chosenDeviceId); statusEl.textContent = 'Camera switched'; }catch(e){ console.warn(e); } }); }
    placeCanvasBtn.disabled = false;
    statusEl.textContent = 'Camera ready — Place canvas when at location';
    startHeadingWatcher(); startOrientationWatcher();
  } catch(e){
    console.error('Camera fail', e);
    enableCameraBtn.disabled = false;
    statusEl.textContent = 'Camera permission required';
  }
});

/* ====== Start/stop draw buttons ====== */
startDrawBtn.addEventListener('click', async ()=>{
  if (!localPlacedPlaneId){
    statusEl.textContent = 'Place canvas first';
    return;
  }
  startDrawBtn.disabled = true;
  stopDrawBtn.style.display = '';
  await startDrawing();
});
stopDrawBtn.addEventListener('click', async ()=>{ await stopDrawing(); startDrawBtn.disabled = false; });

/* ====== Clear all ====== */
clearBtn.addEventListener('click', async ()=>{
  try { await set(ref(db, 'planes'), null); planeObjects.forEach(p=>{ scene.remove(p.mesh); if (p.grid) scene.remove(p.grid); }); planeObjects.clear(); statusEl.textContent = 'Cleared all'; } catch(e){ console.warn(e); }
});

/* ====== Render loop: update reticle from device aiming (camera quaternion), show glowing circle if local placed plane exists ====== */
function renderLoop(){
  requestAnimationFrame(renderLoop);
  // compute reticle point from camera orientation (center ray)
  const aim = computeReticlePoint();
  if (aim){
    reticle.visible = true;
    reticle.position.copy(aim);
    circleMarker.position.copy(aim); // indicator follows reticle until placed
    circleMarker.visible = true;
  } else {
    reticle.visible = false;
    // if no aim and we have a placed plane we still show circle at plane location
    if (localPlacedPlaneId && planeObjects.has(localPlacedPlaneId)){
      const obj = planeObjects.get(localPlacedPlaneId);
      circleMarker.position.copy(obj.mesh.position);
      circleMarker.visible = true;
    } else {
      circleMarker.visible = false;
    }
  }

  renderer.render(scene, camera);
}
renderLoop();

/* ====== Resize handling ====== */
window.addEventListener('resize', ()=>{ renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); });

/* ====== Initial Firebase load indicator ====== */
statusEl.textContent = "Ready — Enable camera, Place canvas, then Start Drawing.";

/* ====== Notes ======
- This implementation:
  - Sets camera orientation from deviceorientation so tilting/aiming moves the center ray.
  - The user aims (center reticle) and presses Start Drawing to record continuous UV points mapped to the ground plane.
  - Strokes are created in Firebase under planes/<planeId>/strokes/<strokeId>/points as {u,v,t}.
  - Other devices fetch strokes and render them onto the plane texture.
- Limitations:
  - GPS alignment is meter-level (GPS and heading dependent). For precise wall anchoring, integrate Lightship or Cloud Anchors next.
  - We use sample+average GPS on placement to improve stability.
================================= */
