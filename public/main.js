// main.js — Draw sticker, store to Firebase, place via WebXR or GPS, show stickers GPS-locked
import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { ARButton } from "https://unpkg.com/three@0.171.0/examples/jsm/webxr/ARButton.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  update,
  onChildAdded,
  onChildRemoved,
  onValue,
  remove
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

/* ========== CONFIG - paste your firebase config (same as previous) ========= */
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
const stickersRef = ref(db, "stickers");

/* ========== DOM ========== */
const drawCanvas = document.getElementById("drawCanvas");
const drawCtx = drawCanvas.getContext("2d");
const colorPicker = document.getElementById("colorPicker");
const sizeRange = document.getElementById("sizeRange");
const clearDrawBtn = document.getElementById("clearDrawBtn");
const saveBtn = document.getElementById("saveBtn");

const enterArBtn = document.getElementById("enterArBtn");
const placeBtn = document.getElementById("placeBtn");
const exitArBtn = document.getElementById("exitArBtn");
const clearAllBtn = document.getElementById("clearAllBtn");
const statusEl = document.getElementById("status");

const fallbackVideo = document.getElementById("fallbackVideo");
const threeCanvas = document.getElementById("three-canvas");

/* ========== app state ========== */
let localStickerId = null;
let viewerPos = null; // {lat, lon, alt}
let watcherId = null;
let viewerHeading = 0; // alpha
let isInXR = false;
let isFallbackCamera = false;

/* ========== helper: UI ========== */
function setStatus(t) { statusEl.textContent = t; }

/* ========== drawing UI (simple) ========== */
drawCtx.fillStyle = "#0000";
drawCtx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
drawCtx.lineJoin = "round";

let drawing = false;
drawCtx.lineCap = "round";
drawCtx.strokeStyle = colorPicker.value;
drawCtx.lineWidth = parseInt(sizeRange.value, 10);

function getPointerPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  const x = (e.clientX ?? (e.touches && e.touches[0].clientX)) - rect.left;
  const y = (e.clientY ?? (e.touches && e.touches[0].clientY)) - rect.top;
  // scale to canvas resolution
  const sx = x * (drawCanvas.width / rect.width);
  const sy = y * (drawCanvas.height / rect.height);
  return { x: sx, y: sy };
}

drawCanvas.addEventListener("pointerdown", (e) => {
  drawing = true;
  drawCtx.strokeStyle = colorPicker.value;
  drawCtx.lineWidth = parseInt(sizeRange.value, 10);
  const p = getPointerPos(e);
  drawCtx.beginPath();
  drawCtx.moveTo(p.x, p.y);
});
drawCanvas.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const p = getPointerPos(e);
  drawCtx.lineTo(p.x, p.y);
  drawCtx.stroke();
});
drawCanvas.addEventListener("pointerup", () => (drawing = false));
drawCanvas.addEventListener("pointerleave", () => (drawing = false));
clearDrawBtn.addEventListener("click", () => {
  drawCtx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
});

/* ========== create safe unique user id ========= */
function getUID(){
  let u = localStorage.getItem("sl_uid");
  if (!u) { u = "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2,8); localStorage.setItem("sl_uid", u); }
  return u;
}

/* ========== geo helpers ========== */
function getCurrentPositionPromise() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("no geolocation"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
  });
}
function startWatchingPosition(){
  if (!navigator.geolocation) return;
  if (watcherId) return;
  watcherId = navigator.geolocation.watchPosition((pos) => {
    viewerPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, alt: pos.coords.altitude ?? 0 };
  }, (err) => {
    console.warn("geo watch err", err);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
}
function stopWatchingPosition(){
  if (watcherId) { navigator.geolocation.clearWatch(watcherId); watcherId = null; viewerPos = null; }
}
// lat/lon -> meters delta (east,north) approximation
function latLonToMetersDelta(lat0, lon0, lat1, lon1){
  const R = 6378137;
  const dLat = (lat1 - lat0) * Math.PI/180;
  const dLon = (lon1 - lon0) * Math.PI/180;
  const meanLat = (lat0 + lat1)/2 * Math.PI/180;
  const north = dLat * R;
  const east = dLon * R * Math.cos(meanLat);
  return { east, north };
}
// convert east/north to local X,Z with respect to viewer heading (deg). returns {x,z}
function metersToLocalXZ(east, north, headingDeg){
  const theta = -headingDeg * Math.PI/180; // rotate by -heading to align world N with camera forward
  const x = east * Math.cos(theta) - north * Math.sin(theta);
  const z = east * Math.sin(theta) + north * Math.cos(theta);
  return { x, z: -z }; // flip z so north positive is forward (-z)
}

/* ========== device orientation (heading) ========== */
function startHeadingWatcher(){
  function handler(e){
    if (e.alpha != null) viewerHeading = e.alpha;
  }
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function"){
    // iOS: must request explicitly in a user gesture — we handle gracefully
    try {
      DeviceOrientationEvent.requestPermission?.().then(p => {
        if (p === "granted") window.addEventListener("deviceorientation", handler, true);
      }).catch(()=>{ /* ignore */ });
    } catch (e){ /* ignore */ }
  } else {
    window.addEventListener("deviceorientation", handler, true);
  }
}

/* ========== Firebase: save sticker ========== */
saveBtn.addEventListener("click", async () => {
  try {
    // get image data
    const dataURL = drawCanvas.toDataURL("image/png");
    setStatus("Saving sticker...");
    const newRef = push(stickersRef);
    const payload = {
      image: dataURL,
      placed: false,
      owner: getUID(),
      timestamp: Date.now()
    };
    await set(newRef, payload);
    localStickerId = newRef.key;
    localStorage.setItem("lastStickerId", localStickerId);
    setStatus("Saved. Enter AR to place.");
    // open AR mode automatically
    enterAR();
  } catch (e) {
    console.error("save failed", e);
    setStatus("Save failed");
  }
});

/* ========== create THREE scene ========== */
const renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias:true, alpha:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.xr.enabled = false;

const scene = new THREE.Scene();
scene.background = null;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.01, 1000);
camera.position.set(0, 1.6, 0);
const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
scene.add(light);

/* hold created sticker meshes: id -> mesh */
const stickerMeshes = new Map();

/* helper: create plane mesh from base64 image */
function createStickerMeshFromBase64(base64, sizeMeters=0.6){
  const tex = new THREE.TextureLoader().load(base64);
  const geo = new THREE.PlaneGeometry(sizeMeters, sizeMeters);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent:true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI/2; // lay flat on floor
  mesh.position.y = 0.001;
  return mesh;
}

/* ========== Place sticker: save lat/lon + optionally arPose ========= */
async function placeLocalStickerByGeo(stickerId){
  if (!stickerId) { setStatus("No sticker to place"); return; }
  try {
    setStatus("Getting location...");
    const pos = await getCurrentPositionPromise();
    const payload = { lat: pos.coords.latitude, lon: pos.coords.longitude, alt: pos.coords.altitude ?? 0, placed:true, placedAt: Date.now(), ownerPlace: getUID() };
    await update(ref(db, `stickers/${stickerId}`), payload);
    setStatus("Sticker placed at GPS");
  } catch (e) {
    console.error("place geo failed", e);
    setStatus("Failed to get GPS");
  }
}

/* ========== WebXR start (immersive AR) ========= */
let xrSession = null;
let xrRefSpace = null;
let hitTestSource = null;
let viewerSpace = null;

async function startARSession(){
  if (!navigator.xr) throw new Error("no navigator.xr");
  const supported = await navigator.xr.isSessionSupported("immersive-ar");
  if (!supported) throw new Error("immersive-ar not supported");
  xrSession = await navigator.xr.requestSession("immersive-ar", { requiredFeatures: ["hit-test","local-floor"], optionalFeatures: ["dom-overlay"], domOverlay: { root: document.body }});
  renderer.xr.enabled = true;
  await renderer.xr.setSession(xrSession);
  xrRefSpace = await xrSession.requestReferenceSpace("local-floor");
  viewerSpace = await xrSession.requestReferenceSpace("viewer");
  // create hit test
  const hitSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  hitTestSource = hitSource;
  // events
  xrSession.addEventListener("end", () => {
    renderer.xr.enabled = false;
    xrSession = null;
    isInXR = false;
    placeBtn.style.display = "none";
    exitArBtn.style.display = "none";
    enterArBtn.style.display = "";
    setStatus("AR session ended");
  });
  // show UI
  placeBtn.style.display = "";
  exitArBtn.style.display = "";
  enterArBtn.style.display = "none";
  isInXR = true;
  setStatus("AR active — tap Place Sticker (saves GPS) or tap object to place via hit-test");
  startHeadingWatcher();
  startWatchingPosition();
  renderer.setAnimationLoop((time, xrFrame) => {
    // update reticle from hit test
    if (hitTestSource && xrFrame) {
      const hitResults = xrFrame.getHitTestResults(hitTestSource);
      if (hitResults.length > 0) {
        // we could show a reticle based on first hit
        // Not strictly necessary for GPS placement; showing reticle omitted for brevity
      }
    }
    // update sticker meshes positions (reproject) each frame using viewerPos + heading
    updateAllStickerPositions();
    renderer.render(scene, camera);
  });
}

/* ========== fallback camera mode (non-WebXR, used by iPhone) ========= */
async function startFallbackCamera(){
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    fallbackVideo.srcObject = stream;
    fallbackVideo.style.display = "";
    isFallbackCamera = true;
    enterArBtn.style.display = "none";
    placeBtn.style.display = "";
    exitArBtn.style.display = "";
    setStatus("Fallback camera active — Place by GPS");
    startHeadingWatcher();
    startWatchingPosition();
    // start simple render loop (no XR)
    function loop(){
      requestAnimationFrame(loop);
      updateAllStickerPositions();
      renderer.render(scene, camera);
    }
    loop();
  } catch (e){
    console.error("fallback camera failed", e);
    setStatus("Camera required for fallback");
  }
}

/* ========== update positions for all sticker meshes based on viewerPos/heading - GPS-locked ========= */
function updateAllStickerPositions(){
  if (!viewerPos) return;
  // compute for each sticker with lat/lon
  stickerMeshes.forEach((meta, id) => {
    const { data } = meta; // data is sticker DB snapshot (object)
    if (!data || !meta.mesh) return;
    if (data.lat == null || data.lon == null) return;
    // compute meters east/north from viewer to sticker
    const { east, north } = latLonToMetersDelta(viewerPos.lat, viewerPos.lon, data.lat, data.lon);
    const local = metersToLocalXZ(east, north, viewerHeading || 0);
    // place mesh
    meta.mesh.position.set(local.x, 0.001, local.z);
    // ensure plane remains flat (no roll/pitch) — only lay flat
    meta.mesh.rotation.set(-Math.PI/2, 0, 0);
  });
}

/* ========== load stickers live from Firebase ========= */
onChildAdded(stickersRef, (snap) => {
  const id = snap.key;
  const data = snap.val();
  // create mesh only when not already created
  if (stickerMeshes.has(id)) return;
  const mesh = createStickerMeshFromBase64(data.image || "", 0.6);
  scene.add(mesh);
  stickerMeshes.set(id, { mesh, data });
  // Immediately position if we have viewerPos
  updateAllStickerPositions();
});
onChildRemoved(stickersRef, (snap) => {
  const id = snap.key;
  const entry = stickerMeshes.get(id);
  if (entry) {
    scene.remove(entry.mesh);
    if (entry.mesh.geometry) entry.mesh.geometry.dispose();
    if (entry.mesh.material && entry.mesh.material.map) entry.mesh.material.map.dispose();
    if (entry.mesh.material) entry.mesh.material.dispose();
    stickerMeshes.delete(id);
  }
});

/* periodic DB refresh so placed property updates reflect quickly */
onValue(stickersRef, (snap) => {
  const val = snap.val() || {};
  // update cached meta objects for stickers (image unchanged)
  Object.entries(val).forEach(([id, obj]) => {
    const cur = stickerMeshes.get(id);
    if (cur) cur.data = obj;
  });
  updateAllStickerPositions();
});

/* ========== UI button wiring ========= */
async function enterAR(){
  setStatus("Entering AR...");
  // prefer WebXR if available
  try {
    if (navigator.xr && navigator.xr.isSessionSupported) {
      const ok = await navigator.xr.isSessionSupported("immersive-ar");
      if (ok) {
        await startARSession();
        return;
      }
    }
    // fallback camera
    await startFallbackCamera();
  } catch (e){
    console.warn("enterAR fallback", e);
    // fallback camera
    try {
      await startFallbackCamera();
    } catch (err) {
      setStatus("AR / Camera not available");
    }
  }
}
enterArBtn.addEventListener("click", async () => {
  // request device motion permission on iOS first (needed for deviceorientation)
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function"){
    try { await DeviceMotionEvent.requestPermission(); } catch (e){ /* ignore */ }
  }
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function"){
    try { await DeviceOrientationEvent.requestPermission(); } catch (e) { /* ignore */ }
  }
  // also request geolocation watch
  try { const p = await getCurrentPositionPromise(); viewerPos = { lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude ?? 0 }; startWatchingPosition(); } catch(e){ console.warn("initial geo fail", e); }
  enterAR();
});

placeBtn.addEventListener("click", async () => {
  // place last saved sticker by GPS
  const stickerId = localStickerId || localStorage.getItem("lastStickerId");
  if (!stickerId) { setStatus("No sticker saved yet"); return; }
  // If in XR and hit-test gives a good pose, we also capture AR pose
  if (isInXR && xrSession && xrRefSpace && hitTestSource){
    // take a single frame's hit test
    const xrFrame = renderer.xr.getFrame();
    if (xrFrame){
      const hits = xrFrame.getHitTestResults(hitTestSource);
      if (hits.length > 0){
        const pose = hits[0].getPose(xrRefSpace);
        if (pose){
          // decompose matrix
          const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
          const pos = new THREE.Vector3(); const quat = new THREE.Quaternion();
          m.decompose(pos, quat, new THREE.Vector3());
          // Get GPS as well (best-effort)
          try {
            const g = await getCurrentPositionPromise();
            await update(ref(db, `stickers/${stickerId}`), {
              lat: g.coords.latitude,
              lon: g.coords.longitude,
              alt: g.coords.altitude ?? 0,
              placed: true,
              arPose: { x: pos.x, y: pos.y, z: pos.z, qx: quat.x, qy: quat.y, qz: quat.z, qw: quat.w },
              placedAt: Date.now()
            });
            setStatus("Placed sticker (AR + GPS)");
            return;
          } catch (e) {
            // fallback: still save AR pose
            await update(ref(db, `stickers/${stickerId}`), {
              arPose: { x: pos.x, y: pos.y, z: pos.z, qx: quat.x, qy: quat.y, qz: quat.z, qw: quat.w },
              placed: true,
              placedAt: Date.now()
            });
            setStatus("Placed sticker (AR pose saved)");
            return;
          }
        }
      }
    }
    // if no hit or no frame, fallback to GPS place
  }
  // fallback GPS place
  await placeLocalStickerByGeo(stickerId);
});

exitArBtn.addEventListener("click", async () => {
  if (xrSession) {
    await xrSession.end();
    xrSession = null;
  }
  if (isFallbackCamera) {
    // stop camera
    try {
      const stream = fallbackVideo.srcObject;
      if (stream && stream.getTracks) stream.getTracks().forEach(t => t.stop());
      fallbackVideo.srcObject = null;
    } catch (e){ }
    fallbackVideo.style.display = "none";
    isFallbackCamera = false;
  }
  stopWatchingPosition();
  enterArBtn.style.display = "";
  placeBtn.style.display = "none";
  exitArBtn.style.display = "none";
  setStatus("Exited AR");
});

clearAllBtn.addEventListener("click", async () => {
  if (!confirm("Clear ALL stickers in DB? This is destructive.")) return;
  try {
    await set(stickersRef, null);
    setStatus("Cleared database");
  } catch (e) {
    console.warn("clear failed", e);
    setStatus("Clear failed");
  }
});

/* On load: resume last saved sticker if any */
(function init(){
  // if there's a previously saved sticker, keep id
  localStickerId = localStorage.getItem("lastStickerId") || null;
  // warm up heading watcher and position watch (but don't force permissions)
  startHeadingWatcher();
  // start watching position quietly if permission already granted
  try { if (navigator.permissions) { navigator.permissions.query({name:"geolocation"}).then(p => { if (p.state === "granted") startWatchingPosition(); }); } } catch(e){}
  setStatus("Ready — draw & save sticker, then enter AR");
})();

/* Resize handling */
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
});
