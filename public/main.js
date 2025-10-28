// main.js — Hybrid WebXR (hit-test) + GPS anchoring, preserves original logic + Firebase
import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  onChildAdded,
  onChildRemoved,
  get
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

/* ===== FIREBASE CONFIG (unchanged) ===== */
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

/* ===== DOM ELEMENTS (unchanged) ===== */
const homePage = document.getElementById("homePage");
const drawPage = document.getElementById("drawPage");
const arPage = document.getElementById("arPage");
const mapPage = document.getElementById("mapPage");
const aboutPage = document.getElementById("aboutPage");

const createStickerBtn = document.getElementById("createStickerBtn");
const exploreBtn = document.getElementById("exploreBtn");
const mapBtn = document.getElementById("mapBtn");
const aboutBtn = document.getElementById("aboutBtn");

const drawCanvas = document.getElementById("drawCanvas");
const colorPicker = document.getElementById("colorPicker");
const sizeRange = document.getElementById("sizeRange");
const clearDrawBtn = document.getElementById("clearDrawBtn");
const saveStickerBtn = document.getElementById("saveStickerBtn");
const backToHomeBtn = document.getElementById("backToHomeBtn");
const backFromMapBtn = document.getElementById("backFromMapBtn");
const backFromAboutBtn = document.getElementById("backFromAboutBtn");

const arVideo = document.getElementById("arVideo");
const threeCanvas = document.getElementById("three-canvas");
const arStatus = document.getElementById("arStatus");
const stickerCount = document.getElementById("stickerCount");
const placeStickerBtn = document.getElementById("placeStickerBtn");
const exitArBtn = document.getElementById("exitArBtn");

/* ===== STATE ===== */
let userGPS = null;
let gpsWatchId = null;
let cameraStream = null;
let pendingStickerImage = null;
let leafletMap = null;
let mapMarkers = [];
let allStickerData = [];

/* ===== Orientation & compass state ===== */
let lastDeviceOrientation = { alpha: null, beta: null, gamma: null, absolute: false };
let lastCompassHeading = null; // degrees (0 = north)
let lastDeviceQuaternion = new THREE.Quaternion();

/* ===== WEBXR / HIT-TEST STATE ===== */
let xrSession = null;
let xrRefSpace = null;
let xrHitTestSource = null;
let xrViewerSpace = null;
let lastHitPose = null; // last hit-test pose (for placing preview)
let xrSupported = false;

/* ===== UTIL: Unique user id ===== */
function getUniqueUserId() {
  let uid = localStorage.getItem("ar_stickers_uid");
  if (!uid) {
    uid = "user_" + Date.now().toString(36) + "_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("ar_stickers_uid", uid);
  }
  return uid;
}

/* ===== PAGE NAVIGATION ===== */
function showPage(pageName) {
  [homePage, drawPage, arPage, mapPage, aboutPage].forEach(p => p.classList.remove("active"));

  if (pageName === "home") homePage.classList.add("active");
  else if (pageName === "draw") drawPage.classList.add("active");
  else if (pageName === "ar") arPage.classList.add("active");
  else if (pageName === "map") {
    mapPage.classList.add("active");
    setTimeout(() => initMap(), 100);
  }
  else if (pageName === "about") aboutPage.classList.add("active");
}

/* ===== DRAWING CANVAS ===== */
const drawCtx = drawCanvas.getContext("2d");
drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

let isDrawing = false;
function getDrawPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  const x = (e.clientX || e.touches?.[0]?.clientX) - rect.left;
  const y = (e.clientY || e.touches?.[0]?.clientY) - rect.top;
  return {
    x: x * (drawCanvas.width / rect.width),
    y: y * (drawCanvas.height / rect.height)
  };
}

drawCanvas.addEventListener("pointerdown", (e) => {
  isDrawing = true;
  drawCtx.strokeStyle = colorPicker.value;
  drawCtx.lineWidth = parseInt(sizeRange.value);
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  const pos = getDrawPos(e);
  drawCtx.beginPath();
  drawCtx.moveTo(pos.x, pos.y);
});
drawCanvas.addEventListener("pointermove", (e) => {
  if (!isDrawing) return;
  const pos = getDrawPos(e);
  drawCtx.lineTo(pos.x, pos.y);
  drawCtx.stroke();
});
drawCanvas.addEventListener("pointerup", () => isDrawing = false);
drawCanvas.addEventListener("pointerleave", () => isDrawing = false);
clearDrawBtn.addEventListener("click", () => {
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
});

/* ===== GPS UTILITIES ===== */
const EARTH_RADIUS = 6378137; // meters
const WORLD_ORIGIN = { lat: 40.758896, lon: -73.985130 }; // Times Square, fixed origin everyone uses

function gpsToAbsoluteWorldPosition(lat, lon) {
  const dLat = (lat - WORLD_ORIGIN.lat) * Math.PI / 180;
  const dLon = (lon - WORLD_ORIGIN.lon) * Math.PI / 180;
  const x = dLon * EARTH_RADIUS * Math.cos(WORLD_ORIGIN.lat * Math.PI / 180);
  const z = -dLat * EARTH_RADIUS; // North is negative Z in your setup
  return { x, z };
}

function getCurrentGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not available"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      reject,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  });
}

/* ===== SMOOTH CAMERA (reduce jitter) ===== */
let targetCameraPos = new THREE.Vector3(0, 1.6, 0);
const cameraLerpFactor = 0.25; // lower = smoother
const gpsSmoothFactor = 0.15;
let cameraSmoothTemp = new THREE.Vector3().copy(targetCameraPos);

function smoothGPSUpdate(lat, lon) {
  const world = gpsToAbsoluteWorldPosition(lat, lon);
  const newTarget = new THREE.Vector3(world.x, 1.6, world.z);
  cameraSmoothTemp.lerp(newTarget, gpsSmoothFactor);
  targetCameraPos.copy(cameraSmoothTemp);
}

/* start/stop GPS watch (unchanged logic aside from smoothing) */
let prevGPS = null;
function startGPSWatch() {
  if (!navigator.geolocation || gpsWatchId) return;
  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      userGPS = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        alt: pos.coords.altitude || 0,
        accuracy: pos.coords.accuracy
      };
      // smoothing update
      smoothGPSUpdate(userGPS.lat, userGPS.lon);
    },
    (err) => console.warn("GPS watch error:", err),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
}

function stopGPSWatch() {
  if (gpsWatchId) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

/* ===== THREE.JS SETUP ===== */
const renderer = new THREE.WebGLRenderer({
  canvas: threeCanvas,
  antialias: true,
  alpha: true
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1.6, 0);

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

// Store sticker meshes: stickerId -> { mesh, data, anchorResolved }
const stickerMeshes = new Map();

function createStickerMesh(base64Image, sizeMeters = 1.2) {
  const texture = new THREE.TextureLoader().load(base64Image);
  texture.encoding = THREE.sRGBEncoding;

  const geometry = new THREE.PlaneGeometry(sizeMeters, sizeMeters);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2; // flat on ground by default
  mesh.position.y = 0.02;
  mesh.matrixAutoUpdate = false;
  mesh.userData.lerpTarget = null; // used to smoothly move to anchor when resolved
  return mesh;
}

/* ===== DEVICE ORIENTATION (unchanged + used for compass) ===== */
const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

function setDeviceQuaternion(quaternion, alpha, beta, gamma, orient) {
  const degToRad = Math.PI / 180;
  euler.set(
    beta * degToRad,
    alpha * degToRad,
    -gamma * degToRad,
    'YXZ'
  );
  quaternion.setFromEuler(euler);
  quaternion.multiply(q1);
  quaternion.multiply(q0.setFromAxisAngle(zee, -orient * degToRad));
}

function updateCompassHeadingFromAlpha(alpha, absolute) {
  if (alpha == null) return;
  lastCompassHeading = alpha;
}

function handleDeviceOrientation(event) {
  lastDeviceOrientation.alpha = event.alpha;
  lastDeviceOrientation.beta = event.beta;
  lastDeviceOrientation.gamma = event.gamma;
  lastDeviceOrientation.absolute = !!event.absolute;

  if (event.alpha != null) {
    updateCompassHeadingFromAlpha(event.alpha, event.absolute);
    setDeviceQuaternion(camera.quaternion, event.alpha, event.beta || 0, event.gamma || 0, screenOrientation);
  }
  lastDeviceQuaternion.copy(camera.quaternion);
}

let screenOrientation = 0;
function getScreenOrientation() {
  return window.screen.orientation?.angle || window.orientation || 0;
}
screenOrientation = getScreenOrientation();
window.addEventListener('orientationchange', () => {
  screenOrientation = getScreenOrientation();
});

function startOrientationTracking() {
  // iOS requires explicit permission for device orientation events
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then(permission => {
      if (permission === "granted") {
        window.addEventListener("deviceorientation", handleDeviceOrientation, true);
      } else {
        console.warn("DeviceOrientation permission not granted");
      }
    }).catch(err => {
      // fallback to listening if requestPermission throws
      window.addEventListener("deviceorientation", handleDeviceOrientation, true);
    });
  } else {
    window.addEventListener("deviceorientation", handleDeviceOrientation, true);
  }
}
function stopOrientationTracking() {
  window.removeEventListener("deviceorientation", handleDeviceOrientation, true);
}

/* ===== UPDATE STICKER VISIBILITY & SMOOTH TRANSFORMS ===== */
function updateStickerVisibility() {
  if (!userGPS) return;

  let nearbyCount = 0;
  stickerMeshes.forEach((entry, id) => {
    const mesh = entry.mesh;

    // If this mesh has a lerpTarget (e.g. resolved anchor / hit position), smooth toward it
    if (mesh.userData.lerpTarget) {
      const tgt = mesh.userData.lerpTarget;
      // Position lerp
      mesh.position.lerp(tgt.position, 0.15);
      // Rotation slerp
      mesh.quaternion.slerp(tgt.quaternion, 0.15);
      mesh.updateMatrix();
    }

    // Distance check (based on world coordinates)
    const dx = mesh.position.x - camera.position.x;
    const dz = mesh.position.z - camera.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    mesh.visible = distance < 100;
    if (mesh.visible) nearbyCount++;
  });

  if (stickerCount) stickerCount.textContent = nearbyCount.toString();
}

/* ===== FIREBASE LISTENERS (preserve original behaviour) ===== */
onChildAdded(stickersRef, (snap) => {
  const id = snap.key;
  const data = snap.val();

  if (stickerMeshes.has(id)) return;
  if (!data.image || (data.lat == null) || (data.lon == null)) return;

  const sizeMeters = data.sizeMeters || 1.2;
  const mesh = createStickerMesh(data.image, sizeMeters);

  // Set at ABSOLUTE world position (fallback)
  const worldPos = gpsToAbsoluteWorldPosition(data.lat, data.lon);
  mesh.position.x = worldPos.x;
  mesh.position.z = worldPos.z;
  mesh.position.y = (data.alt || 0) + 0.02;

  // Apply saved heading/orientation (and convert to radians)
  if (data.heading != null) {
    // heading stored in degrees, 0 = north
    mesh.rotation.y = THREE.MathUtils.degToRad(data.heading);
    mesh.updateMatrix();
  } else if (data.orientationQuaternion) {
    try {
      const q = new THREE.Quaternion(
        data.orientationQuaternion._x,
        data.orientationQuaternion._y,
        data.orientationQuaternion._z,
        data.orientationQuaternion._w
      );
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      mesh.rotation.y = e.y;
      mesh.updateMatrix();
    } catch (e) {
      mesh.rotation.y = 0;
      mesh.updateMatrix();
    }
  } else {
    mesh.rotation.y = 0;
    mesh.updateMatrix();
  }

  // Keep meta for later (anchor resolving)
  scene.add(mesh);
  stickerMeshes.set(id, { mesh, data, anchorResolved: false });
  allStickerData.push({ id, ...data });

  console.log(`Sticker ${id} LOADED at GPS (${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}) => World (${worldPos.x.toFixed(1)}, ${worldPos.z.toFixed(1)})`);

  // Try to resolve a visual anchor for this sticker if possible
  tryVisualAnchorSync(id, mesh, data);

  updateMapMarkers();
});

onChildRemoved(stickersRef, (snap) => {
  const id = snap.key;
  const entry = stickerMeshes.get(id);

  if (entry) {
    scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.map?.dispose();
    entry.mesh.material.dispose();
    stickerMeshes.delete(id);
  }

  allStickerData = allStickerData.filter(s => s.id !== id);
  updateMapMarkers();
});

/* ===== TRY VISUAL ANCHOR SYNC =====
   If sticker has an anchorTransform saved, attempt to use it.
   Otherwise this remains a hook for future Cloud Anchor resolution.
*/
function tryVisualAnchorSync(id, mesh, data) {
  // If the database entry included an anchorTransform (x,y,z + quaternion),
  // we can use it as a precise transform when in an XR session and gradually lerp to it.
  if (!data.anchorTransform) return;

  // Convert stored anchor transform (world coords) into three.js target
  // NOTE: anchorTransform should be in world coordinates relative to WORLD_ORIGIN
  const t = data.anchorTransform;
  const tgtPos = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
  const tgtQuat = new THREE.Quaternion(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);

  // If XR active, set lerp target so mesh will smoothly move to resolved anchor in update loop
  mesh.userData.lerpTarget = { position: tgtPos, quaternion: tgtQuat };
  // mark anchorResolved true — other devices could store anchor ID to attempt true XR anchor resolution
  const entry = stickerMeshes.get(id);
  if (entry) entry.anchorResolved = true;
}

/* ===== MAP INTEGRATION (unchanged behavior) ===== */
async function initMap() {
  if (allStickerData.length === 0) {
    try {
      const snapshot = await get(stickersRef);
      const data = snapshot.val();
      if (data) {
        allStickerData = Object.entries(data).map(([id, val]) => ({ id, ...val }));
      }
    } catch (e) {
      console.warn("Failed to load stickers for map:", e);
    }
  }

  if (leafletMap) {
    leafletMap.invalidateSize();
    updateMapMarkers();
    return;
  }

  if (!userGPS) {
    try {
      const coords = await getCurrentGPS();
      userGPS = {
        lat: coords.latitude,
        lon: coords.longitude,
        alt: coords.altitude || 0,
        accuracy: coords.accuracy
      };
    } catch (e) {
      console.warn("GPS not available, using default location");
      userGPS = { lat: 40.7589, lon: -73.9851, alt: 0, accuracy: 999 };
    }
  }

  leafletMap = L.map('map', {
    zoomControl: false,
    attributionControl: false
  }).setView([userGPS.lat, userGPS.lon], 16);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '',
    maxZoom: 19,
    minZoom: 13
  }).addTo(leafletMap);

  L.marker([userGPS.lat, userGPS.lon], {
    icon: L.divIcon({
      className: 'user-marker-custom',
      html: '<div style="font-size:40px">📍</div>',
      iconSize: [40, 40],
      iconAnchor: [20, 40]
    })
  }).addTo(leafletMap).bindPopup("📍 You are here");

  updateMapMarkers();
}

function updateMapMarkers() {
  if (!leafletMap) return;

  mapMarkers.forEach(m => leafletMap.removeLayer(m));
  mapMarkers = [];

  allStickerData.forEach((data) => {
    if (!data.lat || !data.lon) return;

    const marker = L.marker([data.lat, data.lon], {
      icon: L.divIcon({
        className: 'sticker-marker-custom',
        html: `<img src="${data.image}" style="width:50px;height:50px;object-fit:contain;" />`,
        iconSize: [50, 50],
        iconAnchor: [25, 25]
      })
    }).addTo(leafletMap);

    if (data.image) {
      marker.bindPopup(`<img src="${data.image}" style="width:150px;height:150px;object-fit:contain;background:white;border-radius:10px;padding:5px;"/>`);
    }

    mapMarkers.push(marker);
  });

  console.log(`Map: ${mapMarkers.length} stickers`);
}

/* ===== RENDER LOOP (supports both XR and non-XR rendering) ===== */
let isRendering = false;
let nonXrAnimId = null;

function startRendering() {
  if (isRendering) return;
  isRendering = true;

  // If XR session running, rendering handled by XR animation loop (see startWebXRSession)
  if (xrSession) {
    // XR renderer loop will be active already
    return;
  }

  // Non-XR rendering loop (fallback)
  (function animate() {
    if (!isRendering) return;
    nonXrAnimId = requestAnimationFrame(animate);
    camera.position.lerp(targetCameraPos, cameraLerpFactor);
    updateStickerVisibility();
    renderer.render(scene, camera);
  })();
}

function stopRendering() {
  isRendering = false;
  if (nonXrAnimId) cancelAnimationFrame(nonXrAnimId);
  nonXrAnimId = null;
}

/* ===== CAMERA STREAM (unchanged) ===== */
async function startCamera() {
  try {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
    }

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });

    arVideo.srcObject = cameraStream;
    await arVideo.play();

    return true;
  } catch (e) {
    console.error("Camera error:", e);
    arStatus.textContent = "Camera permission required";
    return false;
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  arVideo.srcObject = null;
}

/* ===== UI BUTTON HANDLERS (preserve behaviour, but show/hide place button) ===== */
createStickerBtn.addEventListener("click", () => {
  showPage("draw");
});

exploreBtn.addEventListener("click", async () => {
  await enterARMode(false);
});

mapBtn.addEventListener("click", () => {
  showPage("map");
});

aboutBtn.addEventListener("click", () => {
  showPage("about");
});

backFromMapBtn.addEventListener("click", () => {
  showPage("home");
});

backFromAboutBtn.addEventListener("click", () => {
  showPage("home");
});

backToHomeBtn.addEventListener("click", () => {
  showPage("home");
});

saveStickerBtn.addEventListener("click", async () => {
  pendingStickerImage = drawCanvas.toDataURL("image/png");
  await enterARMode(true); // place mode
});

placeStickerBtn.addEventListener("click", async () => {
  if (!pendingStickerImage || !userGPS) {
    arStatus.textContent = "Waiting for GPS...";
    return;
  }

  placeStickerBtn.disabled = true;
  arStatus.textContent = "Placing sticker...";

  try {
    // Compose sticker data (hybrid metadata)
    const stickerData = {
      image: pendingStickerImage,
      lat: userGPS.lat,
      lon: userGPS.lon,
      alt: userGPS.alt,
      accuracy: userGPS.accuracy,
      owner: getUniqueUserId(),
      createdAt: Date.now(),
      heading: (lastCompassHeading != null) ? lastCompassHeading : null,
      orientationQuaternion: {
        _x: lastDeviceQuaternion.x || 0,
        _y: lastDeviceQuaternion.y || 0,
        _z: lastDeviceQuaternion.z || 0,
        _w: lastDeviceQuaternion.w || 1
      },
      world: gpsToAbsoluteWorldPosition(userGPS.lat, userGPS.lon),
      sizeMeters: 1.2
    };

    // If we have a lastHitPose from XR, include anchorTransform (world coordinates)
    if (lastHitPose && xrRefSpace) {
      // Transform XR pose to app world coordinates (we assume xr space roughly aligns with world origin
      // For a simple approach, save the hit pose's position/quaternion as anchorTransform.
      const p = lastHitPose.transform.position;
      const o = lastHitPose.transform.orientation;
      // store as anchorTransform (relative to current device coordinate space)
      stickerData.anchorTransform = {
        position: { x: p.x, y: p.y, z: p.z },
        quaternion: { x: o.x, y: o.y, z: o.z, w: o.w }
      };
    }

    // Push to Firebase
    const newRef = push(stickersRef);
    await set(newRef, stickerData);

    // Reset
    pendingStickerImage = null;
    arStatus.textContent = `Placed at (${userGPS.lat.toFixed(6)}, ${userGPS.lon.toFixed(6)})`;
    // Hide place button and stop placing state
    placeStickerBtn.style.display = "none";
  } catch (e) {
    console.error("Failed to place sticker:", e);
    arStatus.textContent = "Failed to place sticker";
  }

  placeStickerBtn.disabled = false;
});

/* ===== WEBXR: start session + hit test (mobile only) ===== */
async function startWebXRSession() {
  // Ensure WebXR exists and immersive-ar supported
  try {
    if (!navigator.xr) return false;
    xrSupported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!xrSupported) return false;
  } catch (e) {
    xrSupported = false;
    return false;
  }

  try {
    xrSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local-floor']
    });

    const gl = renderer.getContext();
    await gl.makeXRCompatible();
    renderer.xr.enabled = true;
    await renderer.xr.setSession(xrSession);

    xrRefSpace = await xrSession.requestReferenceSpace('local');
    xrViewerSpace = await xrSession.requestReferenceSpace('viewer');
    xrHitTestSource = await xrSession.requestHitTestSource({ space: xrViewerSpace });

    xrSession.addEventListener('end', () => {
      xrSession = null;
      xrRefSpace = null;
      xrHitTestSource = null;
      lastHitPose = null;
      renderer.xr.enabled = false;
      // restart non-XR rendering loop if needed
      if (!isRendering) startRendering();
    });

    // XR animation loop
    renderer.setAnimationLoop((time, frame) => {
      if (!frame) return;
      const session = frame.session;

      // update device pose and camera from XR pose
      const pose = frame.getViewerPose(xrRefSpace);
      if (pose) {
        const view = pose.views[0];
        const viewMatrix = new THREE.Matrix4().fromArray(view.transform.inverse.matrix);
        // Transform camera from XR pose
        // In WebXR, the renderer will handle camera pose; still, we can use hit-test below.
      }

      // Hit-test: look for a plane in front of camera
      if (xrHitTestSource) {
        const hitTestResults = frame.getHitTestResults(xrHitTestSource);
        if (hitTestResults.length > 0) {
          const hit = hitTestResults[0];
          const hitPose = hit.getPose(xrRefSpace);
          if (hitPose) {
            lastHitPose = hitPose;
            // Optionally show a small preview reticle at the hit pose.
            // Convert pose position to world coordinates and update a preview target for placing objects.
            // We'll set camera/preview behavior via a DOM reticle for user clarity.
            // No DOM reticle movement here; keep lastHitPose used when placing.
          }
        } else {
          lastHitPose = null;
        }
      }

      // render scene (camera pose provided by WebXR)
      updateStickerVisibility(); // still update visibility and lerp targets
      renderer.render(scene, camera);
    });

    return true;
  } catch (e) {
    console.warn("Failed to start WebXR session:", e);
    xrSession = null;
    xrRefSpace = null;
    xrHitTestSource = null;
    renderer.setAnimationLoop(null);
    return false;
  }
}

async function endWebXRSession() {
  try {
    if (xrSession) await xrSession.end();
  } catch (e) {
    console.warn("Failed to end XR session:", e);
  } finally {
    xrSession = null;
    xrRefSpace = null;
    xrHitTestSource = null;
    lastHitPose = null;
    renderer.setAnimationLoop(null);
  }
}

/* ===== ENTER/EXIT AR MODE (integrated WebXR + GPS fallback) ===== */
async function enterARMode(placingSticker = false) {
  showPage("ar");
  arStatus.textContent = "Starting AR...";
  // Request orientation permissions on iOS (handled in startOrientationTracking)
  try {
    if (typeof DeviceMotionEvent !== "undefined" &&
      typeof DeviceMotionEvent.requestPermission === "function") {
      await DeviceMotionEvent.requestPermission();
    }
    if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch (e) {
    console.warn("Permission request error:", e);
  }

  // Start camera feed for background video (works as fallback)
  const cameraOk = await startCamera();
  if (!cameraOk) {
    arStatus.textContent = "Camera permission required";
    return;
  }

  // Try to get initial GPS
  try {
    arStatus.textContent = "Getting GPS...";
    const coords = await getCurrentGPS();
    userGPS = {
      lat: coords.latitude,
      lon: coords.longitude,
      alt: coords.altitude || 0,
      accuracy: coords.accuracy
    };
    const worldPos = gpsToAbsoluteWorldPosition(userGPS.lat, userGPS.lon);
    // set immediate camera position (non-smoothed)
    targetCameraPos.set(worldPos.x, 1.6, worldPos.z);
    camera.position.copy(targetCameraPos);
    arStatus.textContent = `GPS: ±${Math.round(coords.accuracy)}m`;
  } catch (e) {
    console.warn("GPS error:", e);
    arStatus.textContent = "GPS required";
    // proceed anyway — XR might still run
  }

  // Start GPS watch & orientation tracking (orientation used by XR + fallback camera)
  startGPSWatch();
  startOrientationTracking();

  // Show/hide place button depending on placingSticker
  if (placingSticker) {
    placeStickerBtn.style.display = ""; // show (HTML had display:none initially)
    placeStickerBtn.disabled = false;
    arStatus.textContent = "Pan camera to place sticker, then tap 'Place Here'";
  } else {
    placeStickerBtn.style.display = "none";
    arStatus.textContent = "Looking for stickers...";
  }

  // Try WebXR session (mobile only)
  const xrStarted = await startWebXRSession();
  if (!xrStarted) {
    // fallback: start non-XR rendering + rely on GPS
    startRendering();
    arStatus.textContent = placingSticker ? "No WebXR — placing at GPS location" : "No WebXR — exploring (GPS fallback)";
  } else {
    // XR session rendering is active; ensure flag and UI are consistent
    isRendering = true;
    arStatus.textContent = placingSticker ? "WebXR ready — pan and tap Place" : "WebXR ready — exploring";
  }
}

/* ===== EXIT AR MODE ===== */
async function exitARMode() {
  // Hide place button
  placeStickerBtn.style.display = "none";
  // Stop XR session if active
  if (xrSession) {
    await endWebXRSession();
  }
  stopRendering();
  stopCamera();
  stopGPSWatch();
  stopOrientationTracking();
  showPage("home");
  arStatus.textContent = "";
}
exitArBtn.addEventListener("click", exitARMode);

/* ===== WINDOW RESIZE ===== */
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

/* ===== INITIAL LOAD: fetch stickers for map and cache ===== */
(async function initialLoad() {
  try {
    const snapshot = await get(stickersRef);
    const data = snapshot.val();
    if (data) {
      allStickerData = Object.entries(data).map(([id, val]) => ({ id, ...val }));
    }
  } catch (e) {
    console.warn("Could not fetch initial stickers:", e);
  }
})();

/* ===== UI button wiring (preserve existing) ===== */
createStickerBtn.addEventListener("click", () => showPage("draw"));
exploreBtn.addEventListener("click", async () => await enterARMode(false));
mapBtn.addEventListener("click", () => showPage("map"));
aboutBtn.addEventListener("click", () => showPage("about"));
backFromMapBtn.addEventListener("click", () => showPage("home"));
backFromAboutBtn.addEventListener("click", () => showPage("home"));
backToHomeBtn.addEventListener("click", () => showPage("home"));

/* ===== Final log ===== */
console.log("AR Stickers loaded - World Origin: Times Square (absolute) — Hybrid WebXR + GPS enabled");
