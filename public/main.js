// main.js - AR graffiti with a pinned 2D canvas + realtime Firebase sync
import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { ARButton } from "https://unpkg.com/three@0.171.0/examples/jsm/webxr/ARButton.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  onChildAdded,
  onValue,
  onChildRemoved,
  remove
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

/* ======= THREE / Renderer / Scene ======= */
const canvas = document.getElementById("three-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.xr.enabled = false; // enable when AR session starts

const scene = new THREE.Scene();
scene.background = null; // camera feed or black

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 1.6, 0);

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

/* ===== UI ===== */
const enterArBtn = document.getElementById("enterArBtn");
const placePlaneBtn = document.getElementById("placePlaneBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");

/* ===== Globals ===== */
let xrSession = null;
let xrRefSpace = null;
let hitTestSource = null;
let viewerSpace = null;
let reticle = null;

const planeObjects = new Map(); // planeId -> { mesh, canvas, ctx }
let localPlaneId = null; // the plane this client created/owns (optional)
let drawing = false;
let currentStroke = null;

// Basic fallback video background element (for non-WebXR)
let fallbackVideo = null;

/* ===== Utility: get device location & heading ===== */
function getCurrentPositionPromise() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("No geolocation"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
  });
}

let lastHeading = 0;
function startHeadingWatcher() {
  // Best-effort heading via DeviceOrientation; iOS needs permission
  const handler = (ev) => {
    if (ev.absolute === true || ev.alpha != null) {
      lastHeading = ev.alpha || lastHeading;
    }
  };

  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    // iOS 13+ permission requirement
    DeviceOrientationEvent.requestPermission?.().then((perm) => {
      if (perm === "granted") window.addEventListener("deviceorientation", handler, true);
    }).catch(()=>{/* ignore */});
  } else {
    window.addEventListener("deviceorientation", handler, true);
  }
}

/* ===== Helpers for canvas-on-plane creation ===== */
function createDrawingPlaneMesh(widthMeters = 2, heightMeters = 2, texWidth = 1024, texHeight = 1024) {
  // Create HTML canvas and texture
  const canvas2d = document.createElement("canvas");
  canvas2d.width = texWidth;
  canvas2d.height = texHeight;
  const ctx = canvas2d.getContext("2d");
  // initialize transparent background
  ctx.clearRect(0, 0, texWidth, texHeight);

  const texture = new THREE.CanvasTexture(canvas2d);
  texture.encoding = THREE.sRGBEncoding;
  texture.flipY = false;

  const geom = new THREE.PlaneGeometry(widthMeters, heightMeters);
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    metalness: 0,
    roughness: 1
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData.canvas = canvas2d;
  mesh.userData.ctx = ctx;
  mesh.userData.texture = texture;
  mesh.userData.w = texWidth;
  mesh.userData.h = texHeight;

  return mesh;
}

/* ===== Raycast helpers: find uv on plane for pointer events ===== */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// Convert THREE.Intersection uv to canvas pixel coords
function uvToCanvasXY(uv, mesh) {
  const u = uv.x;
  const v = uv.y;
  const x = Math.round(u * mesh.userData.w);
  const y = Math.round((1 - v) * mesh.userData.h); // v=0 bottom => y=height
  return { x, y };
}

/* ===== Firebase: handle planes and strokes ===== */

/*
Data structure:
planes/
  <planeId> : {
    createdAt,
    creatorId (optional),
    arPose: {x,y,z,qx,qy,qz,qw}  // local AR pose when placed (if available)
    lat, lon, alt, headingAtPlace // fallback geo info
    widthMeters, heightMeters
  }
planes/<planeId>/strokes/
  <strokeId> : {
    color, width, createdAt,
    points: [ {u, v}, {u,v}, ... ]  // normalized UV coords [0..1]
  }
*/

function createRemotePlane(planeId, meta) {
  if (planeObjects.has(planeId)) return;
  const width = meta.widthMeters || 2;
  const height = meta.heightMeters || 2;
  const mesh = createDrawingPlaneMesh(width, height);
  mesh.name = `plane-${planeId}`;

  // set initial transform: either use arPose (local) or reproject from lat/lon
  if (meta.arPose && renderer.xr.isPresenting) {
    // place roughly at pose; note cross-device AR alignment WITHOUT anchors is not reliable.
    mesh.position.set(meta.arPose.x, meta.arPose.y, meta.arPose.z);
    mesh.quaternion.set(meta.arPose.qx, meta.arPose.qy, meta.arPose.qz, meta.arPose.qw);
    mesh.scale.set(1,1,1);
    scene.add(mesh);
    planeObjects.set(planeId, { mesh, meta });
  } else if (meta.lat != null && meta.lon != null) {
    // reproject based on local GPS: best effort
    getCurrentPositionPromise().then((pos) => {
      const myLat = pos.coords.latitude;
      const myLon = pos.coords.longitude;
      // small-equirectangular approximation
      const R = 6378137;
      const dLat = (meta.lat - myLat) * Math.PI / 180;
      const dLon = (meta.lon - myLon) * Math.PI / 180;
      const north = dLat * R;
      const east = dLon * R * Math.cos(((meta.lat + myLat)/2) * Math.PI/180);
      // convert east/north to local x,z using heading
      const theta = - (meta.headingAtPlace || 0) * Math.PI/180;
      const x = east * Math.cos(theta) - north * Math.sin(theta);
      const z = east * Math.sin(theta) + north * Math.cos(theta);
      mesh.position.set(x, 0, -z); // approximate placement on ground
      scene.add(mesh);
      planeObjects.set(planeId, { mesh, meta });
    }).catch(()=> {
      // fallback place in front of camera
      mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
      scene.add(mesh);
      planeObjects.set(planeId, { mesh, meta });
    });
  } else {
    // fallback: put in front of camera
    mesh.position.set(0, 0, -2 - planeObjects.size * 0.5);
    scene.add(mesh);
    planeObjects.set(planeId, { mesh, meta });
  }

  // listen for strokes under this plane
  const strokesRef = ref(db, `planes/${planeId}/strokes`);
  onChildAdded(strokesRef, (snap) => {
    const s = snap.val();
    if (!s) return;
    drawStrokeOnPlane(planeId, s, false);
  });
}

// draw stroke on plane canvas; if local==true, update texture; if remote==true, don't re-broadcast
function drawStrokeOnPlane(planeId, stroke, local = false) {
  const p = planeObjects.get(planeId);
  if (!p) return;
  const { mesh } = p;
  const ctx = mesh.userData.ctx;
  const w = mesh.userData.w;
  const h = mesh.userData.h;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = stroke.color || "#ffffff";
  ctx.lineWidth = (stroke.width || 8);

  ctx.beginPath();
  const pts = stroke.points || [];
  if (pts.length === 0) return;
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    const x = pt.u * w;
    const y = (1 - pt.v) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  mesh.userData.texture.needsUpdate = true;
}

/* ===== Create plane flow (user places canvas) ===== */

async function placeNewPlaneAtPose(pose, optionalGeo) {
  // pose: {position: {x,y,z}, orientation: {x,y,z,w}} in local XR coordinates
  // optionalGeo: {lat,lon,alt,heading}
  const planeMeta = {
    createdAt: Date.now(),
    widthMeters: 2.0,
    heightMeters: 2.0,
    arPose: pose ? {
      x: pose.position.x,
      y: pose.position.y,
      z: pose.position.z,
      qx: pose.orientation.x,
      qy: pose.orientation.y,
      qz: pose.orientation.z,
      qw: pose.orientation.w
    } : null,
    lat: optionalGeo?.lat ?? null,
    lon: optionalGeo?.lon ?? null,
    alt: optionalGeo?.alt ?? null,
    headingAtPlace: optionalGeo?.heading ?? null
  };
  // push plane meta to firebase
  const newPlaneRef = push(planesRef);
  await set(newPlaneRef, planeMeta);
  localPlaneId = newPlaneRef.key;
  statusEl.textContent = "Placed canvas — draw now";
}

/* ====== AR: reticle and hit-test logic ====== */
function makeReticle() {
  const geometry = new THREE.RingGeometry(0.12, 0.15, 32).rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.8, transparent: true });
  const ring = new THREE.Mesh(geometry, material);
  ring.matrixAutoUpdate = false;
  ring.visible = false;
  scene.add(ring);
  return ring;
}

/* ====== Clipboard of firebase plane creation: listen for remote planes ====== */
onChildAdded(planesRef, (snap) => {
  const id = snap.key;
  const meta = snap.val();
  if (!meta) return;
  createRemotePlane(id, meta);
});

// remove plane handler
onChildRemoved(planesRef, (snap) => {
  const id = snap.key;
  const p = planeObjects.get(id);
  if (p) {
    scene.remove(p.mesh);
    planeObjects.delete(id);
  }
});

/* ====== Input: place plane with AR hit-test or fallback ====== */
enterArBtn.addEventListener("click", async () => {
  // try immersive-ar first
  if (navigator.xr && navigator.xr.isSessionSupported) {
    try {
      const supported = await navigator.xr.isSessionSupported("immersive-ar");
      if (supported) {
        await startARSession();
        return;
      }
    } catch (e) { /* continue to fallback */ }
  }
  // fallback: start camera background + allow placement at fixed distance and capture geo
  startFallbackMode();
});

placePlaneBtn.addEventListener("click", async () => {
  // when user clicks Place Canvas in non-AR fallback OR after reticle appears in AR
  if (renderer.xr.isPresenting && reticle && reticle.visible) {
    // use reticle matrix to get pose
    const m = new THREE.Matrix4().copy(reticle.matrix);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    m.decompose(pos, quat, new THREE.Vector3());
    // attach plane there
    const geo = await tryGetGeo();
    await placeNewPlaneAtPose({ position: pos, orientation: quat }, geo);
    // createRemotePlane will be triggered by Firebase onChildAdded; but for immediate feedback create local plane too
  } else {
    // fallback placement: put in front of camera at 2.5m and record geo
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const pos = camera.position.clone().add(forward.multiplyScalar(2.5));
    const quat = camera.quaternion.clone();
    const geo = await tryGetGeo();
    await placeNewPlaneAtPose({ position: pos, orientation: quat }, geo);
  }
});

clearBtn.addEventListener("click", async () => {
  // WARNING: this removes all planes & strokes in DB
  try {
    await remove(planesRef);
    planeObjects.forEach(p => scene.remove(p.mesh));
    planeObjects.clear();
    statusEl.textContent = "Cleared all planes";
  } catch (e) {
    console.error(e);
  }
});

async function tryGetGeo() {
  try {
    const pos = await getCurrentPositionPromise();
    return {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      alt: pos.coords.altitude ?? 0,
      heading: lastHeading || 0
    };
  } catch (e) {
    return null;
  }
}

/* ======= XR Session Start/Loop/Hit-Test ======= */
async function startARSession() {
  try {
    xrSession = await navigator.xr.requestSession("immersive-ar", { requiredFeatures: ["hit-test", "local-floor"], optionalFeatures: ["dom-overlay"], domOverlay: { root: document.body } });
  } catch (err) {
    console.error("XR request failed", err);
    statusEl.textContent = "AR start failed";
    return;
  }

  renderer.xr.enabled = true;
  await renderer.xr.setSession(xrSession);
  statusEl.textContent = "AR active — look around and tap 'Place Canvas' when reticle appears";

  // create reticle if missing
  if (!reticle) reticle = makeReticle();

  // reference spaces
  xrRefSpace = await xrSession.requestReferenceSpace("local-floor");
  viewerSpace = await xrSession.requestReferenceSpace("viewer");

  // hit-test source
  const hitSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  hitTestSource = hitSource;

  // events
  xrSession.addEventListener("end", () => {
    renderer.xr.enabled = false;
    xrSession = null;
    hitTestSource = null;
    statusEl.textContent = "AR ended";
    enterArBtn.style.display = "";
    placePlaneBtn.style.display = "none";
  });

  // show place button
  placePlaneBtn.style.display = "";

  // start heading watcher
  startHeadingWatcher();

  // render loop (with frame's hit test)
  renderer.setAnimationLoop((time, xrFrame) => {
    if (xrFrame && hitTestSource) {
      const hitResults = xrFrame.getHitTestResults(hitTestSource);
      if (hitResults.length > 0) {
        const hit = hitResults[0];
        const pose = hit.getPose(xrRefSpace);
        if (pose) {
          // put reticle at hit pose
          reticle.visible = true;
          const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
          reticle.matrix.copy(m);
        }
      } else {
        reticle.visible = false;
      }
    }
    renderer.render(scene, camera);
  });
}

/* ======= Fallback: camera background + click placement ======= */
async function startFallbackMode() {
  // show place button
  placePlaneBtn.style.display = "";

  // request camera
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    fallbackVideo = document.createElement("video");
    fallbackVideo.autoplay = true;
    fallbackVideo.playsInline = true;
    fallbackVideo.srcObject = stream;
    fallbackVideo.style.position = "fixed";
    fallbackVideo.style.left = "0";
    fallbackVideo.style.top = "0";
    fallbackVideo.style.width = "100%";
    fallbackVideo.style.height = "100%";
    fallbackVideo.style.objectFit = "cover";
    fallbackVideo.style.zIndex = "-1";
    document.body.appendChild(fallbackVideo);
    statusEl.textContent = "Fallback camera active — press 'Place Canvas' to create canvas and draw";
    startHeadingWatcher();
  } catch (err) {
    console.warn("Camera fallback failed", err);
    statusEl.textContent = "Camera required for fallback";
  }
}

/* ======= Pointer / drawing interactions ======= */

// When a plane is available (localPlaneId or remote ones), enable pointer events to draw into whichever plane is tapped on.
// We'll support: tap plane to select, then drawing with pointerdown/move/up

let activePlaneId = null;

renderer.domElement.addEventListener("pointerdown", async (ev) => {
  // find intersection with any plane mesh
  pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  // gather plane meshes
  const meshes = [];
  planeObjects.forEach((v, k) => {
    if (v && v.mesh) meshes.push(v.mesh);
  });

  const intersects = raycaster.intersectObjects(meshes, false);
  if (intersects.length > 0) {
    const hit = intersects[0];
    const mesh = hit.object;
    // pick this plane as active
    const planeId = [...planeObjects.entries()].find(([id, val]) => val.mesh === mesh)?.[0];
    if (!planeId) return;
    activePlaneId = planeId;

    // start stroke with normalized uv
    const uv = hit.uv;
    const { x, y } = uvToCanvasXY(uv, mesh);
    currentStroke = {
      color: "#ffffff",
      width: 8,
      points: [{ u: uv.x, v: uv.y }]
    };
    drawing = true;
    // draw first instant locally
    drawStrokeOnPlane(planeId, currentStroke, true);
  } else {
    // not hitting plane: ignore (or place new plane if user has local ownership)
  }
});

renderer.domElement.addEventListener("pointermove", (ev) => {
  if (!drawing || !activePlaneId || !currentStroke) return;
  pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const mesh = planeObjects.get(activePlaneId).mesh;
  const inter = raycaster.intersectObject(mesh, false);
  if (inter.length === 0) return;
  const uv = inter[0].uv;
  currentStroke.points.push({ u: uv.x, v: uv.y });
  // draw incremental
  drawStrokeOnPlane(activePlaneId, { color: currentStroke.color, width: currentStroke.width, points: [currentStroke.points[currentStroke.points.length-2], currentStroke.points[currentStroke.points.length-1]] }, true);
});

renderer.domElement.addEventListener("pointerup", async (ev) => {
  if (!drawing || !activePlaneId || !currentStroke) return;
  drawing = false;
  // broadcast stroke to Firebase under the activePlaneId
  const strokesRef = ref(db, `planes/${activePlaneId}/strokes`);
  // push stroke record
  await push(strokesRef, {
    color: currentStroke.color,
    width: currentStroke.width,
    createdAt: Date.now(),
    points: currentStroke.points
  });
  currentStroke = null;
});

/* ======= Initial render loop to show scene even if not in AR ======= */
function renderLoop() {
  requestAnimationFrame(renderLoop);
  // small animation: rotate visible plane meshes slightly for life (optional)
  planeObjects.forEach((p) => {
    // no rotation in AR; keep static
  });
  renderer.render(scene, camera);
}
renderLoop();

/* ======= Start a small initialization: load existing planes (handled via onChildAdded) ======= */
statusEl.textContent = "Ready — press Enter AR";

/* ===== Notes & Limitations =====
 - This implementation creates a canvas texture per plane and syncs strokes (arrays of UV points).
 - On AR devices, we save arPose at creation time but **do not** implement a robust cross-device anchor system (that requires AR Cloud / VPS or cloud anchors).
 - Fallback uses camera feed + geo info; re-projection is approximate.
 - For production, optimize stroke payloads (chunk points), add authentication, and tighten DB rules.
======================================== */

