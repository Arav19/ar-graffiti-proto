// main.js
// Surfaceless — Draw a sticker, Save, Enter AR, Place sticker at GPS location
import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { ARButton } from "https://unpkg.com/three@0.171.0/examples/jsm/webxr/ARButton.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  onChildAdded,
  onChildRemoved,
  onValue,
  update
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

/* ====== FIREBASE CONFIG (use your project) ====== */
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

/* ===== UI refs ===== */
const statusEl = document.getElementById("status");
const gpsStatusEl = document.getElementById("gpsStatus");
const cameraFallback = document.getElementById("cameraFallback");
const enterArBtn = document.getElementById("enterAr");
const placeStickerBtn = document.getElementById("placeStickerBtn");
const cancelPlaceBtn = document.getElementById("cancelPlaceBtn");
const placeControls = document.getElementById("placeControls");
const drawCanvas = document.getElementById("drawCanvas");
const drawCtx = drawCanvas.getContext("2d");
const clearDrawBtn = document.getElementById("clearDraw");
const saveStickerBtn = document.getElementById("saveSticker");
const threeCanvas = document.getElementById("three-canvas");

/* ===== state ===== */
let lastSavedStickerId = null;   // id in firebase for sticker created in session (image stored on save but placed later)
let localPlacedStickerId = null; // id after placement (same as saved)
let myPosition = null;           // {lat, lon, alt}
let myHeading = 0;               // alpha from deviceorientation
let isXRSupported = false;
let xrSession = null;

/* ===== THREE setup (shared for XR and fallback view) ===== */
const renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true, alpha: true });
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

/* ===== reticle (visual placement guide) ===== */
function makeReticle() {
  const geo = new THREE.RingGeometry(0.12 * 0.85, 0.12, 32);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x00ffd0, transparent:true, opacity:0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  mesh.matrixAutoUpdate = true;
  scene.add(mesh);
  return mesh;
}
const reticle = makeReticle();

/* ===== sticker objects in scene: id -> {mesh, meta} ===== */
const stickerObjects = new Map();

/* ===== helper: GPS utilities ===== */
function getCurrentPositionPromise() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not available"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
  });
}
function updateGPSStatus() {
  if (!myPosition) gpsStatusEl.textContent = "GPS: unknown";
  else gpsStatusEl.textContent = `GPS: ${myPosition.lat.toFixed(5)}, ${myPosition.lon.toFixed(5)}`;
}

/* small-equirectangular delta (meters) */
function latLonToMetersDelta(lat0, lon0, lat1, lon1){
  const R = 6378137;
  const dLat = (lat1 - lat0) * Math.PI/180;
  const dLon = (lon1 - lon0) * Math.PI/180;
  const meanLat = (lat0 + lat1)/2 * Math.PI/180;
  const north = dLat * R;
  const east = dLon * R * Math.cos(meanLat);
  return { east, north };
}
function metersToLocalXZ(east, north, headingDeg){
  const theta = -headingDeg * Math.PI/180;
  const x = east * Math.cos(theta) - north * Math.sin(theta);
  const z = east * Math.sin(theta) + north * Math.cos(theta);
  return { x, z: -z };
}

/* ===== device orientation (heading) ===== */
function startHeadingWatcher(){
  function handler(e){
    if (e.alpha != null) myHeading = e.alpha;
  }
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function"){
    // iOS
    DeviceOrientationEvent.requestPermission?.().then(p => { if (p === "granted") window.addEventListener("deviceorientation", handler, true); }).catch(()=>{/*ignore*/});
  } else {
    window.addEventListener("deviceorientation", handler, true);
  }
}

/* ===== drawing UI: simple paint on canvas ===== */
function initDrawCanvas(){
  // clear background transparent
  drawCtx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
  drawCtx.fillStyle = "rgba(0,0,0,0)";
  drawCtx.fillRect(0,0,drawCanvas.width, drawCanvas.height);

  drawCtx.strokeStyle = "#00ffd0";
  drawCtx.lineWidth = 6;
  drawCtx.lineJoin = "round";
  drawCtx.lineCap = "round";

  let drawing = false;
  let lastX = 0, lastY = 0;

  function getPos(e){
    const r = drawCanvas.getBoundingClientRect();
    let x = 0, y = 0;
    if (e.touches && e.touches.length) { x = e.touches[0].clientX; y = e.touches[0].clientY; }
    else { x = e.clientX; y = e.clientY; }
    return { x: (x - r.left) * (drawCanvas.width / r.width), y: (y - r.top) * (drawCanvas.height / r.height) };
  }

  drawCanvas.addEventListener("pointerdown", (ev)=>{
    ev.preventDefault();
    drawing = true;
    const p = getPos(ev);
    lastX = p.x; lastY = p.y;
    drawCtx.beginPath();
    drawCtx.moveTo(lastX, lastY);
  });
  window.addEventListener("pointermove", (ev)=>{
    if (!drawing) return;
    const p = getPos(ev);
    drawCtx.lineTo(p.x, p.y);
    drawCtx.stroke();
    lastX = p.x; lastY = p.y;
  }, {passive:false});
  window.addEventListener("pointerup", ()=> drawing = false);
  window.addEventListener("pointercancel", ()=> drawing = false);
}

clearDrawBtn.addEventListener("click", ()=>{
  drawCtx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
});

/* ===== Save sticker (store image in Firebase but placed=false until user places) ===== */
saveStickerBtn.addEventListener("click", async ()=>{
  try {
    statusEl.textContent = "Saving sticker...";
    const dataURL = drawCanvas.toDataURL("image/png");
    const newRef = push(stickersRef);
    // Use set(newRef, {...}) (push returns a ref object)
    await set(newRef, {
      image: dataURL,
      placed: false,
      timestamp: Date.now()
    });
    lastSavedStickerId = newRef.key;
    statusEl.textContent = "Saved sticker — enter AR to place it";
    // auto-enter AR after saving for convenience
    enterAR();
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Save failed";
  }
});

/* ===== Load stickers from Firebase; we will place them on scene when we have our GPS location ===== */
onChildAdded(stickersRef, (snap) => {
  const id = snap.key;
  const meta = snap.val();
  // We create object only when meta.placed==true and if not already created
  if (meta && meta.placed && meta.lat != null && meta.lon != null) {
    // if already exists, skip
    if (stickerObjects.has(id)) return;
    // we'll attempt to create when we have myPosition (otherwise will create fallback in onValue below when myPosition updates)
    createStickerObject(id, meta).catch(e=>console.warn("createStickerObject fail:", e));
  }
});
onChildRemoved(stickersRef, (snap) => {
  const id = snap.key;
  const obj = stickerObjects.get(id);
  if (obj) {
    scene.remove(obj.mesh);
    stickerObjects.delete(id);
  }
});

/* also listen to value so we can refresh existing placed stickers after initial load (handles updates) */
onValue(stickersRef, (snap) => {
  const data = snap.val();
  if (!data) return;
  Object.entries(data).forEach(([id, meta])=>{
    if (meta && meta.placed && meta.lat != null && meta.lon != null) {
      if (!stickerObjects.has(id)) createStickerObject(id, meta).catch(e=>console.warn(e));
      else {
        // if exists, update image if changed
        const existing = stickerObjects.get(id);
        if (existing && meta.image && meta.image !== existing.meta.image) {
          // update texture
          const tex = new THREE.TextureLoader().load(meta.image, ()=>{
            existing.mesh.material.map = tex;
            existing.mesh.material.needsUpdate = true;
          });
          existing.meta = meta;
        }
      }
    }
  });
});

/* ===== create sticker mesh and place at lat/lon given our current position & heading ===== */
async function createStickerObject(id, meta) {
  if (!meta || meta.placed !== true) return;
  // ensure we have a position to convert lat/lon to local coords; if not, wait until we fetch position
  if (!myPosition) {
    // re-try after some time (simple backoff)
    setTimeout(()=>createStickerObject(id, meta), 1200);
    return;
  }

  // filter by distance (only load stickers within radius to save load)
  const RADIUS_M = 1000; // load stickers within 1km; tune as needed
  const delta = latLonToMetersDelta(myPosition.lat, myPosition.lon, meta.lat, meta.lon);
  const dist = Math.hypot(delta.east, delta.north);
  if (dist > RADIUS_M) {
    // skip creating but still keep no-op; will be created if user moves closer (we could implement dynamic load)
    return;
  }

  // Compute local x,z relative to us using heading recorded at place and our current heading
  // Approach: use meta.headingAtPlace to rotate east/north into the coordinate system used during placement.
  // We'll convert (east,north) from our location to the sticker's location and then rotate by -myHeading
  const { east, north } = latLonToMetersDelta(myPosition.lat, myPosition.lon, meta.lat, meta.lon);
  // Use the sticker's recorded headingAtPlace — this was the heading of the placer when they saved orientation.
  const headingAtPlace = meta.headingAtPlace || 0;
  const local = metersToLocalXZ(east, north, headingAtPlace || myHeading || 0);

  // create plane with sticker texture (flat on floor)
  const w = meta.widthMeters || 0.6;
  const h = meta.heightMeters || 0.6;
  const geom = new THREE.PlaneGeometry(w, h);
  const tex = new THREE.TextureLoader().load(meta.image, () => { renderer.render(scene, camera); });
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthTest:true });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI/2; // flat on floor
  mesh.position.set(local.x, 0.01, local.z);

  scene.add(mesh);
  stickerObjects.set(id, { mesh, meta });
}

/* ===== AR + fallback logic ===== */

async function enterAR() {
  // Try WebXR immersive-ar
  statusEl.textContent = "Starting AR...";
  // ensure we have permission requests for device sensors on iOS
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      await DeviceOrientationEvent.requestPermission().catch(()=>{});
    }
  } catch(e){/*ignore*/}

  // get current GPS first (best-effort)
  try {
    const pos = await getCurrentPositionPromise();
    myPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude, alt: pos.coords.altitude || 0 };
    updateGPSStatus();
  } catch (e) {
    console.warn("gps failed on enterAR", e);
    statusEl.textContent = "Warning: GPS unavailable";
  }

  // try WebXR
  if (navigator.xr && navigator.xr.isSessionSupported) {
    try {
      const supported = await navigator.xr.isSessionSupported("immersive-ar");
      if (supported) {
        startXRSession();
        return;
      }
    } catch (e) {
      console.warn("xr check failed", e);
    }
  }

  // fallback camera + deviceorientation + three.js view
  startFallbackARMode();
}

/* ===== start WebXR session and use hit-test reticle for placement ===== */
async function startXRSession() {
  try {
    xrSession = await navigator.xr.requestSession("immersive-ar", { requiredFeatures:["hit-test","local-floor"], optionalFeatures:["dom-overlay"], domOverlay:{ root: document.body } });
  } catch (e) {
    console.warn("XR request failed", e);
    statusEl.textContent = "AR not available — using fallback";
    startFallbackARMode();
    return;
  }

  renderer.xr.enabled = true;
  await renderer.xr.setSession(xrSession);
  statusEl.textContent = "AR active — move device until reticle appears, then Place Sticker";
  placeControls.style.display = "flex";
  enterArBtn.style.display = "none";

  // reticle visibility will be controlled by hit-test
  if (!reticle) reticle = makeReticle();

  const refSpace = await xrSession.requestReferenceSpace("local-floor");
  const viewerSpace = await xrSession.requestReferenceSpace("viewer");
  const hitSource = await xrSession.requestHitTestSource({ space: viewerSpace });

  // ensure we start heading watch
  startHeadingWatcher();

  xrSession.addEventListener("end", ()=>{
    renderer.xr.enabled = false;
    xrSession = null;
    placeControls.style.display = "none";
    enterArBtn.style.display = "";
    statusEl.textContent = "AR ended";
    // show camera fallback again
    cameraFallback.style.display = "";
  });

  renderer.setAnimationLoop((time, xrFrame) => {
    if (xrFrame && hitSource) {
      const hits = xrFrame.getHitTestResults(hitSource);
      if (hits.length > 0) {
        const hit = hits[0];
        const pose = hit.getPose(refSpace);
        if (pose) {
          reticle.visible = true;
          const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
          // place reticle at hit pose
          reticle.matrix.copy(m);
          reticle.matrix.decompose(reticle.position, reticle.quaternion, reticle.scale);
        }
      } else reticle.visible = false;
    }
    renderer.render(scene, camera);
  });
}

/* ===== fallback AR mode: camera feed + deviceorientation-driven camera for aiming + reticle at floor (y=0) ===== */
let fallbackCamStream = null;
function startFallbackARMode(){
  // show controls
  placeControls.style.display = "flex";
  enterArBtn.style.display = "none";
  // start camera video
  startCameraFallback().catch(e=>{
    console.warn("camera fallback fail", e);
    statusEl.textContent = "Camera failed";
  });
  // use deviceorientation to set camera quaternion; we will compute reticle intersection with floor y=0
  startHeadingWatcher();
  // ensure render loop for fallback
  renderer.setAnimationLoop(()=> {
    // compute reticle point in world using camera quaternion
    // camera is at (0,1.6,0) in our scene space; its quaternion will be updated by deviceorientation handler
    const origin = new THREE.Vector3();
    camera.getWorldPosition(origin);
    const dir = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion).normalize();
    if (Math.abs(dir.y) > 1e-4) {
      const t = -origin.y / dir.y;
      if (t > 0) {
        const pt = origin.clone().add(dir.multiplyScalar(t));
        reticle.visible = true;
        reticle.position.copy(pt);
        reticle.rotation.y = camera.rotation.y;
      } else reticle.visible = false;
    } else reticle.visible = false;

    renderer.render(scene, camera);
  });
}

async function startCameraFallback(){
  if (fallbackCamStream) {
    fallbackCamStream.getTracks().forEach(t => t.stop());
    fallbackCamStream = null;
  }
  try {
    const constraints = { video: { facingMode: { ideal: "environment" } }, audio:false };
    fallbackCamStream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraFallback.srcObject = fallbackCamStream;
    await cameraFallback.play();
    cameraFallback.style.display = "";
    statusEl.textContent = "Camera active — position reticle and Place Sticker";
    // hide enter button while active
    enterArBtn.style.display = "none";
    // ensure we have current GPS
    try {
      const pos = await getCurrentPositionPromise();
      myPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude, alt: pos.coords.altitude || 0 };
      updateGPSStatus();
    } catch(e){
      console.warn("gps fail", e);
    }
  } catch (e) {
    console.error("start camera failed", e);
    statusEl.textContent = "Camera access denied or unavailable";
    throw e;
  }
}

/* ===== place sticker action: writes lat/lon and heading to the sticker record in firebase ===== */
placeStickerBtn.addEventListener("click", async ()=>{
  if (!lastSavedStickerId) {
    statusEl.textContent = "No saved sticker to place. Draw and Save first.";
    return;
  }

  // if in XR session, derive world pose from reticle matrix; else use current GPS & heading
  let lat=null, lon=null, heading=null;
  try {
    const pos = await getCurrentPositionPromise();
    lat = pos.coords.latitude; lon = pos.coords.longitude;
    heading = myHeading || 0;
    myPosition = { lat, lon, alt: pos.coords.altitude || 0 };
    updateGPSStatus();
  } catch(e){
    console.warn("gps on place failed", e);
    statusEl.textContent = "GPS required to anchor sticker. Try again.";
    return;
  }

  // update sticker record: set placed true and lat/lon and headingAtPlace
  try {
    const targetRef = ref(db, `stickers/${lastSavedStickerId}`);
    await update(targetRef, {
      placed: true,
      lat: lat,
      lon: lon,
      headingAtPlace: heading,
      widthMeters: 0.6,
      heightMeters: 0.6,
      placedTimestamp: Date.now()
    });
    localPlacedStickerId = lastSavedStickerId;
    statusEl.textContent = "Sticker placed!";
    // optionally hide place button
    placeControls.style.display = "none";
    // ensure sticker is added locally immediately
    // createStickerObject will be triggered by database listener; but create proactively:
    const metaSnap = { placed:true, lat, lon, headingAtPlace: heading, image: (await getStickerImage(lastSavedStickerId)), widthMeters:0.6, heightMeters:0.6 };
    createStickerObject(lastSavedStickerId, metaSnap).catch(()=>{});
  } catch(e){
    console.error("place update failed", e);
    statusEl.textContent = "Placement failed";
  }
});

/* Cancel placement */
cancelPlaceBtn.addEventListener("click", ()=>{
  placeControls.style.display = "none";
  enterArBtn.style.display = "";
  statusEl.textContent = "Placement canceled";
  // end XR if active
  if (xrSession) xrSession.end();
  // stop fallback camera if needed
  if (fallbackCamStream) fallbackCamStream.getTracks().forEach(t=>t.stop());
});

/* helper: fetch image of sticker id directly (one-time read) */
function getStickerImage(id){
  return new Promise((resolve)=>{
    onValue(ref(db, `stickers/${id}`), snap=>{
      const v = snap.val();
      if (v && v.image) resolve(v.image);
      else resolve(null);
    }, {onlyOnce:true});
  });
}

/* ===== start up ===== */
function init(){
  initDrawCanvas();
  // try to obtain current GPS and start heading watcher
  (async ()=>{
    try {
      const pos = await getCurrentPositionPromise();
      myPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude, alt: pos.coords.altitude || 0};
      updateGPSStatus();
      statusEl.textContent = "Ready — draw then Save & Enter AR";
    } catch (e) {
      statusEl.textContent = "Tap Enable AR / Save sticker. GPS may be unavailable until you allow it.";
    }
  })();

  startHeadingWatcher();

  // detect XR support early
  if (navigator.xr && navigator.xr.isSessionSupported) {
    navigator.xr.isSessionSupported("immersive-ar").then(s=>{
      isXRSupported = !!s;
      if (isXRSupported) console.log("WebXR immersive-ar supported");
    }).catch(()=>{});
  }

  // wire enter button
  enterArBtn.addEventListener("click", ()=>enterAR());

  // convenience: update render on resize
  window.addEventListener("resize", ()=> {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  // render loop baseline (renders even before AR)
  function baseLoop(){
    requestAnimationFrame(baseLoop);
    renderer.render(scene, camera);
  }
  baseLoop();
}

init();

/* ===== NOTES =====
 - This implementation uses GPS+heading to anchor stickers across devices.
 - It attempts WebXR first (hit-test placement in AR). If not available, it falls back to camera + deviceorientation.
 - Stickers are stored as base64 PNG in /stickers/<id>. This is simple and works for prototyping. For many users or large images, consider storing in Firebase Storage and saving a URL reference in the DB.
 - Placement accuracy will be GPS-limited. For high precision AR anchors, integrate cloud anchors (ARCore/ARKit services).
================================= */
