// main.js
// WebXR + fallback camera + geo-locking + Firebase realtime sync
import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { XRControllerModelFactory } from "https://unpkg.com/three@0.171.0/examples/jsm/webxr/XRControllerModelFactory.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  onChildAdded,
  onChildRemoved,
  remove
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

// ====== FIREBASE CONFIG (your values) ======
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
const cubesRef = ref(db, "cubes");

// ====== Three.js base scene (shared between AR & fallback) ======
const canvas = document.getElementById("three-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.xr.enabled = false; // enabled when entering AR

const scene = new THREE.Scene();
scene.background = null; // use camera feed or black if fallback

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 1.6, 0);

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

// tiny grid for fallback view
const grid = new THREE.GridHelper(10, 10, 0x333333, 0x111111);
grid.visible = false; // show only in non-AR fallback
scene.add(grid);

// store placed cubes (Three objects)
const cubeMap = new Map();

// helper to create a cube mesh
function makeCubeMesh(color = 0xff0000) {
  const g = new THREE.BoxGeometry(0.35, 0.35, 0.35);
  const m = new THREE.MeshStandardMaterial({ color });
  return new THREE.Mesh(g, m);
}

// ====== Utilities: geo math ======
// convert small lat/lon differences to meters (equirectangular approx)
function latLonToMetersOffset(lat0, lon0, lat1, lon1) {
  // approximate conversions
  const R = 6378137; // earth radius in meters
  const dLat = (lat1 - lat0) * Math.PI / 180;
  const dLon = (lon1 - lon0) * Math.PI / 180;
  const meanLat = (lat0 + lat1) / 2 * Math.PI / 180;
  const north = dLat * R;
  const east = dLon * R * Math.cos(meanLat);
  return { east, north }; // meters
}

// convert meters offset (east,north) to Three.js local x/z relative to device heading
// deviceHeadingDeg = 0 when device facing magnetic north? DeviceOrientation alpha semantics vary.
// We'll assume deviceHeadingDeg is compass heading (0 = north), and camera looks toward -Z in Three.
function metersOffsetToLocalXYZ(east, north, deviceHeadingDeg) {
  // rotate east/north by -heading so that when device faces north, north-> -Z
  const theta = -deviceHeadingDeg * Math.PI / 180;
  const x = east * Math.cos(theta) - north * Math.sin(theta);
  const z = east * Math.sin(theta) + north * Math.cos(theta);
  // in our scene, +x is right, -z is forward. We'll use y = 0
  return new THREE.Vector3(x, 0, -z);
}

// request geolocation once (wrap in promise)
function getCurrentPositionPromise() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not available"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
  });
}

// device heading via DeviceOrientationEvent (alpha), best-effort
let lastHeading = 0;
function startHeadingWatcher() {
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    // iOS 13+ requires permission
    DeviceOrientationEvent.requestPermission().then((perm) => {
      if (perm === "granted") {
        window.addEventListener("deviceorientation", handleOrientation, true);
      }
    }).catch(()=>{/* ignore */});
  } else {
    window.addEventListener("deviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation", handleOrientation, true);
  }

  function handleOrientation(ev) {
    let alpha = ev.alpha;
    if (alpha == null) return;
    // On many devices alpha is compass heading; you may need to convert using screen orientation.
    lastHeading = alpha; // best-effort
  }
}

// ====== Firebase listeners: when others add cubes, render them ======
onChildAdded(cubesRef, (snap) => {
  const data = snap.val();
  const id = snap.key;
  if (!data) return;
  // data may include either arPose (x,y,z,w, ...), or geo (lat,lon,alt,headingAtPlace)
  // If it has arPose and this client is in an AR session with the same reference space we could use anchors.
  // For simplicity: if arPose present and we are in AR and have xr reference space, we could create anchored object.
  // Otherwise, project via geo coords into local space as best-effort.
  if (cubeMap.has(id)) return;

  const color = data.color ?? 0xff0000;
  const mesh = makeCubeMesh(color);
  mesh.userData._meta = data;

  if (data.arPose && renderer.xr.isPresenting) {
    // try to place using XR anchor transform if we have xr frame available (best-effort)
    // We'll save the transform now and attempt to place in XR render loop when xrFrame is available.
    mesh.userData._arPose = data.arPose;
    mesh.visible = false; // will be shown when positioned
  } else if (data.lat != null && data.lon != null) {
    // Use geolocation re-projection
    getCurrentPositionPromise().then((pos) => {
      const latNow = pos.coords.latitude;
      const lonNow = pos.coords.longitude;
      const { east, north } = latLonToMetersOffset(data.lat, data.lon, latNow, lonNow);
      // east/north is vector from placed location -> current location; we want placed_location relative to current
      // invert: placed relative to me = (placedLat,placedLon) - (myLat,myLon)
      const { east: e2, north: n2 } = latLonToMetersOffset(latNow, lonNow, data.lat, data.lon);
      const local = metersOffsetToLocalXYZ(e2, n2, lastHeading || 0);
      mesh.position.copy(local);
      scene.add(mesh);
      cubeMap.set(id, mesh);
    }).catch((err)=>{
      // fallback: place at some fixed distance in front
      mesh.position.set(0, 0, -2 - (cubeMap.size * 0.4));
      scene.add(mesh);
      cubeMap.set(id, mesh);
    });
  } else {
    // no geo, no AR pose: place in front of camera with offset
    mesh.position.set(0, 0, -2 - (cubeMap.size * 0.4));
    scene.add(mesh);
    cubeMap.set(id, mesh);
  }
});

onChildRemoved(cubesRef, (snap) => {
  const id = snap.key;
  const mesh = cubeMap.get(id);
  if (mesh) {
    scene.remove(mesh);
    cubeMap.delete(id);
  }
});

// ====== Interaction: placing cubes ======
const enterArBtn = document.getElementById("enterArBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");

let xrSession = null;
let xrRefSpace = null;
let xrHitTestSource = null;
let localReferenceSpace = null;

enterArBtn.addEventListener("click", async () => {
  // try WebXR immersive-ar first
  if (navigator.xr && await navigator.xr.isSessionSupported && await navigator.xr.isSessionSupported("immersive-ar")) {
    enterARSession();
  } else {
    // fallback: request camera + geolocation + device orientation and use screen taps
    startHeadingWatcher();
    try {
      await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      // show fallback camera: we'll render the scene and overlay camera with CSS behind canvas (simpler approach)
      startFallbackMode();
    } catch (err) {
      console.warn("Camera permission denied or not available:", err);
      statusEl.textContent = "Camera access needed for AR fallback";
    }
  }
});

clearBtn.addEventListener("click", async () => {
  await remove(cubesRef);
  cubeMap.forEach((m) => scene.remove(m));
  cubeMap.clear();
});

// ====== WebXR AR: start session, create hit-test, handle taps ======
async function enterARSession() {
  try {
    xrSession = await navigator.xr.requestSession("immersive-ar", { requiredFeatures: ["hit-test", "dom-overlay"], domOverlay: { root: document.body } });
    renderer.xr.enabled = true;
    await renderer.xr.setSession(xrSession);
    statusEl.textContent = "AR session started";
    enterArBtn.style.display = "none";
    grid.visible = false;
    // reference space
    xrRefSpace = await xrSession.requestReferenceSpace("local");
    const viewerSpace = await xrSession.requestReferenceSpace("viewer");
    // create hit test source
    const xrHitTest = await xrSession.requestHitTestSource({ space: viewerSpace });
    xrHitTestSource = xrHitTest;

    // listen for select (tap) events on XR input source
    xrSession.addEventListener("select", onXRSelect);

    // on session end
    xrSession.addEventListener("end", () => {
      renderer.xr.enabled = false;
      xrSession = null;
      xrHitTestSource = null;
      statusEl.textContent = "AR session ended";
      enterArBtn.style.display = "";
    });

    // start heading watcher and permissions
    startHeadingWatcher();

    // for AR, request geolocation when placing (optional)
  } catch (err) {
    console.error("Failed to start AR session", err);
    statusEl.textContent = "AR start failed";
  }
}

// XR select handler (user taps)
async function onXRSelect(evt) {
  const frame = evt.frame;
  if (!xrHitTestSource) return;
  const hitTestResults = frame.getHitTestResults(xrHitTestSource);
  if (hitTestResults.length > 0) {
    const hit = hitTestResults[0];
    const pose = hit.getPose(xrRefSpace);
    if (!pose) return;

    // pose.transform.position (x,y,z) and orientation quaternion
    const p = pose.transform.position;
    const q = pose.transform.orientation;
    // push to Firebase: include arPose and geo if available
    let lat = null, lon = null, alt = null, headingAtPlace = lastHeading || 0;
    try {
      const pos = await getCurrentPositionPromise();
      lat = pos.coords.latitude;
      lon = pos.coords.longitude;
      alt = pos.coords.altitude ?? 0;
    } catch (err) {
      // ignore if geolocation fails
    }

    const color = Math.floor(Math.random() * 0xffffff);
    const record = {
      arPose: { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w },
      lat, lon, alt, headingAtPlace,
      color
    };
    push(cubesRef, record);
  }
}

// ====== Fallback Mode (no WebXR): camera + tap on screen + geo projection ======
let fallbackVideoStream = null;
async function startFallbackMode() {
  // show grid so users have orientation in non-AR mode
  grid.visible = true;
  // attach camera as background video via CSS on body element
  try {
    fallbackVideoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = fallbackVideoStream;
    video.style.position = "fixed";
    video.style.left = "0";
    video.style.top = "0";
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "cover";
    video.style.zIndex = "-1";
    document.body.appendChild(video);

    statusEl.textContent = "Fallback AR: tap to place (approx geo-locked)";
    enterArBtn.style.display = "none";

    // On tap, raycast from camera into virtual world at a fixed distance OR compute geo based on device location + heading
    renderer.domElement.addEventListener("click", onFallbackClick);
    startHeadingWatcher();
  } catch (err) {
    console.error("Fallback camera failed", err);
    statusEl.textContent = "Camera not available";
  }
}

async function onFallbackClick(evt) {
  // attempt to get GPS + heading and save lat/lon of placed point:
  // Approach: place cube a fixed distance forward in camera space, but also record device lat/lon.
  // Other devices will use lat/lon + heading to reproject the cube.
  let lat = null, lon = null, alt = null;
  try {
    const pos = await getCurrentPositionPromise();
    lat = pos.coords.latitude;
    lon = pos.coords.longitude;
    alt = pos.coords.altitude ?? 0;
  } catch (err) {
    console.warn("Geolocation error:", err);
  }

  // compute a point in front of camera at ~3 meters
  const rect = renderer.domElement.getBoundingClientRect();
  const ndcX = (evt.clientX - rect.left) / rect.width * 2 - 1;
  const ndcY = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
  const vec = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
  const dir = vec.sub(camera.position).normalize();
  const distance = 3.0;
  const point = camera.position.clone().add(dir.multiplyScalar(distance));

  const color = Math.floor(Math.random() * 0xffffff);
  const headingAtPlace = lastHeading || 0;

  push(cubesRef, {
    x: point.x,
    y: point.y,
    z: point.z,
    lat, lon, alt,
    headingAtPlace,
    color
  });
}

// ====== XR frame loop: used to place AR-synced mesh transforms when AR is active ======
renderer.setAnimationLoop((time, xrFrame) => {
  // If AR session and we have frames, we can resolve arPose items waiting to be placed
  if (xrFrame && xrRefSpace) {
    // Try to position any meshes that had arPose saved by other devices.
    cubeMap.forEach((mesh) => {
      if (!mesh.userData._arPose || mesh.visible) return;
      // Without anchors, we can't directly convert other-device local poses into this session's reference frame.
      // Anchors would be required for robust cross-device AR alignment (or a shared AR cloud).
      // We'll fallback to showing them near the camera if arPose exists but cannot be resolved.
      mesh.position.set(0, 0, -2 - (Math.random() * 0.5));
      mesh.visible = true;
    });
  }

  // rotate cubes slightly for visual interest
  cubeMap.forEach((m) => {
    m.rotation.x += 0.005;
    m.rotation.y += 0.007;
  });

  renderer.render(scene, camera);
});

// ====== Basic fallbacks & startup behavior ======
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// start heading watcher passively
startHeadingWatcher();

// on page load: set status
statusEl.textContent = "Tap 'Enter AR' to start (Android: full AR, iPhone: fallback)";

