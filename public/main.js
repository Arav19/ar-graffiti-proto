// main.js - GPS-anchored AR stickers with HYBRID positioning
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
const stickersRef = ref(db, "stickers");

/* ===== DOM ELEMENTS ===== */
const homePage = document.getElementById("homePage");
const drawPage = document.getElementById("drawPage");
const arPage = document.getElementById("arPage");
const mapPage = document.getElementById("mapPage");

const createStickerBtn = document.getElementById("createStickerBtn");
const exploreBtn = document.getElementById("exploreBtn");
const mapBtn = document.getElementById("mapBtn");

const drawCanvas = document.getElementById("drawCanvas");
const colorPicker = document.getElementById("colorPicker");
const sizeRange = document.getElementById("sizeRange");
const clearDrawBtn = document.getElementById("clearDrawBtn");
const saveStickerBtn = document.getElementById("saveStickerBtn");
const backToHomeBtn = document.getElementById("backToHomeBtn");
const backFromMapBtn = document.getElementById("backFromMapBtn");

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

// HYBRID POSITIONING SYSTEM
let localOrigin = null; // Local coordinate system origin (user's starting point)
let isLocalTrackingActive = false;
let deviceMotionTracker = {
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(0, 0, 0),
  lastTimestamp: 0
};

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
  [homePage, drawPage, arPage, mapPage].forEach(p => p.classList.remove("active"));
  
  if (pageName === "home") homePage.classList.add("active");
  else if (pageName === "draw") drawPage.classList.add("active");
  else if (pageName === "ar") arPage.classList.add("active");
  else if (pageName === "map") {
    mapPage.classList.add("active");
    setTimeout(() => initMap(), 100);
  }
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

/* ===== HYBRID POSITIONING SYSTEM ===== */
const EARTH_RADIUS = 6378137; // meters

// FIXED WORLD ORIGIN - Times Square, NYC (same for EVERYONE)
const WORLD_ORIGIN = {
  lat: 40.758896,
  lon: -73.985130
};

// Convert GPS coordinates to absolute world position in meters
function gpsToAbsoluteWorldPosition(lat, lon) {
  const earthRadius = 6378137; // meters
  
  // Convert latitude and longitude from degrees to radians
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const originLatRad = WORLD_ORIGIN.lat * Math.PI / 180;
  const originLonRad = WORLD_ORIGIN.lon * Math.PI / 180;
  
  // Calculate differences in radians
  const dLat = latRad - originLatRad;
  const dLon = lonRad - originLonRad;
  
  // Calculate Cartesian coordinates (X: East-West, Z: North-South)
  const x = dLon * earthRadius * Math.cos(originLatRad);
  const z = -dLat * earthRadius; // Negative because North should be -Z
  
  return { x, z };
}

// Convert absolute world position back to GPS
function absoluteWorldPositionToGPS(worldX, worldZ) {
  const earthRadius = 6378137;
  const originLatRad = WORLD_ORIGIN.lat * Math.PI / 180;
  
  const dLon = worldX / (earthRadius * Math.cos(originLatRad));
  const dLat = -worldZ / earthRadius;
  
  const lat = WORLD_ORIGIN.lat + (dLat * 180 / Math.PI);
  const lon = WORLD_ORIGIN.lon + (dLon * 180 / Math.PI);
  
  return { lat, lon };
}

// Initialize local coordinate system when user enters AR
function initializeLocalCoordinateSystem(userLat, userLon) {
  const worldPos = gpsToAbsoluteWorldPosition(userLat, userLon);
  localOrigin = {
    worldX: worldPos.x,
    worldZ: worldPos.z,
    localX: 0,
    localZ: 0,
    timestamp: Date.now()
  };
  
  console.log(`Local coordinate system initialized at GPS (${userLat}, ${userLon}) = World (${worldPos.x.toFixed(1)}, ${worldPos.z.toFixed(1)})`);
  return localOrigin;
}

// Convert between local and global coordinate systems
function localToGlobalPosition(localX, localZ) {
  if (!localOrigin) return { x: localX, z: localZ };
  
  return {
    x: localOrigin.worldX + localX,
    z: localOrigin.worldZ + localZ
  };
}

function globalToLocalPosition(globalX, globalZ) {
  if (!localOrigin) return { x: globalX, z: globalZ };
  
  return {
    x: globalX - localOrigin.worldX,
    z: globalZ - localOrigin.worldZ
  };
}

/* ===== DEVICE MOTION TRACKING ===== */
function startDeviceMotionTracking() {
  if (typeof DeviceMotionEvent === "undefined") {
    console.warn("DeviceMotionEvent not supported");
    return false;
  }

  function handleDeviceMotion(event) {
    if (!event.accelerationIncludingGravity || !localOrigin) return;
    
    const now = Date.now();
    const deltaTime = (now - deviceMotionTracker.lastTimestamp) / 1000;
    
    if (deviceMotionTracker.lastTimestamp === 0 || deltaTime > 1) {
      deviceMotionTracker.lastTimestamp = now;
      return;
    }
    
    // Basic pedometer: detect steps from acceleration
    const accel = event.accelerationIncludingGravity;
    const totalAccel = Math.sqrt(
      accel.x * accel.x + 
      accel.y * accel.y + 
      accel.z * accel.z
    );
    
    // Simple step detection (you'd want more sophisticated algorithms in production)
    if (totalAccel > 15) {
      // Estimate step length (approx 0.7m per step)
      const stepLength = 0.7;
      
      // Use camera direction to determine step direction
      const direction = new THREE.Vector3(0, 0, -1);
      direction.applyQuaternion(camera.quaternion);
      direction.y = 0; // Keep movement horizontal
      direction.normalize().multiplyScalar(stepLength);
      
      // Update local position based on steps
      deviceMotionTracker.position.x += direction.x;
      deviceMotionTracker.position.z += direction.z;
      
      // Update camera position in local coordinates
      const localCamPos = globalToLocalPosition(camera.position.x, camera.position.z);
      localCamPos.x = deviceMotionTracker.position.x;
      localCamPos.z = deviceMotionTracker.position.z;
      
      const globalPos = localToGlobalPosition(localCamPos.x, localCamPos.z);
      camera.position.x = globalPos.x;
      camera.position.z = globalPos.z;
      
      console.log(`Step detected: Moved to local (${deviceMotionTracker.position.x.toFixed(2)}, ${deviceMotionTracker.position.z.toFixed(2)})`);
    }
    
    deviceMotionTracker.lastTimestamp = now;
  }

  // Request permission and start tracking
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    DeviceMotionEvent.requestPermission()
      .then(permission => {
        if (permission === "granted") {
          window.addEventListener("devicemotion", handleDeviceMotion, true);
          isLocalTrackingActive = true;
          console.log("Device motion tracking started");
        }
      })
      .catch(err => {
        console.warn("Device motion permission denied:", err);
      });
  } else {
    window.addEventListener("devicemotion", handleDeviceMotion, true);
    isLocalTrackingActive = true;
    console.log("Device motion tracking started (no permission required)");
  }
  
  return true;
}

function stopDeviceMotionTracking() {
  window.removeEventListener("devicemotion", handleDeviceMotion, true);
  isLocalTrackingActive = false;
  deviceMotionTracker.position.set(0, 0, 0);
  deviceMotionTracker.velocity.set(0, 0, 0);
  deviceMotionTracker.lastTimestamp = 0;
}

/* ===== GPS UTILITIES ===== */
function getCurrentGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error("Geolocation not available"));
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      reject,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  });
}

function startGPSWatch() {
  if (!navigator.geolocation || gpsWatchId) return;
  
  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const newGPS = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        alt: pos.coords.altitude || 0,
        accuracy: pos.coords.accuracy
      };
      
      // Only update if we've moved significantly (more than 10 meters)
      if (userGPS && calculateGPSDistance(userGPS, newGPS) < 10) {
        return; // Ignore small movements that cause jitter
      }
      
      userGPS = newGPS;
      
      // Update local origin if we've moved significantly
      if (localOrigin && calculateGPSDistance(
        { lat: localOrigin.lat, lon: localOrigin.lon }, 
        newGPS
      ) > 20) {
        initializeLocalCoordinateSystem(userGPS.lat, userGPS.lon);
      }
      
      console.log(`GPS Updated: Accuracy ±${Math.round(userGPS.accuracy)}m`);
      
    },
    (err) => console.warn("GPS watch error:", err),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
}

function calculateGPSDistance(gps1, gps2) {
  const R = 6371000; // Earth radius in meters
  const dLat = (gps2.lat - gps1.lat) * Math.PI / 180;
  const dLon = (gps2.lon - gps1.lon) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(gps1.lat * Math.PI / 180) * Math.cos(gps2.lat * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function stopGPSWatch() {
  if (gpsWatchId) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

/* ===== THREE.JS SCENE ===== */
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

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(0, 1.6, 0);

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

// Store sticker meshes: stickerId -> { mesh, data }
const stickerMeshes = new Map();

/* ===== CREATE STICKER MESH ===== */
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
  
  // Make sticker vertical (facing user)
  mesh.rotation.x = 0;
  mesh.position.y = 0.5;
  
  // Lock the position - stickers should NEVER move once placed
  mesh.matrixAutoUpdate = false;
  
  return mesh;
}

/* ===== DEVICE ORIENTATION ===== */
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

let screenOrientation = 0;

function getScreenOrientation() {
  return screen.orientation?.angle || window.orientation || 0;
}

screenOrientation = getScreenOrientation();
window.addEventListener('orientationchange', () => {
  screenOrientation = getScreenOrientation();
});

function handleDeviceOrientation(event) {
  if (!event.alpha || !isLocalTrackingActive) return;
  
  setDeviceQuaternion(
    camera.quaternion,
    event.alpha,
    event.beta,
    event.gamma,
    screenOrientation
  );
}

function startOrientationTracking() {
  if (typeof DeviceOrientationEvent !== "undefined" && 
      typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then(permission => {
      if (permission === "granted") {
        window.addEventListener("deviceorientation", handleDeviceOrientation, true);
      }
    }).catch(err => {
      console.warn("Orientation permission denied:", err);
    });
  } else {
    window.addEventListener("deviceorientation", handleDeviceOrientation, true);
  }
}

function stopOrientationTracking() {
  window.removeEventListener("deviceorientation", handleDeviceOrientation, true);
}

/* ===== STICKER BILLBOARDING ===== */
function updateStickerBillboarding() {
  if (!camera) return;
  
  stickerMeshes.forEach((entry) => {
    const { mesh } = entry;
    
    // Make sticker face camera (billboard behavior)
    const tempMatrix = new THREE.Matrix4();
    tempMatrix.lookAt(mesh.position, camera.position, mesh.up);
    const targetQuaternion = new THREE.Quaternion();
    targetQuaternion.setFromRotationMatrix(tempMatrix);
    
    // Only rotate around Y axis to keep sticker upright
    const euler = new THREE.Euler();
    euler.setFromQuaternion(targetQuaternion);
    euler.x = 0;
    euler.z = 0;
    mesh.quaternion.setFromEuler(euler);
    
    mesh.updateMatrix();
  });
}

/* ===== UPDATE STICKER VISIBILITY ===== */
function updateStickerVisibility() {
  if (!userGPS) return;
  
  let nearbyCount = 0;
  
  stickerMeshes.forEach((entry, id) => {
    const { mesh } = entry;
    
    // Calculate distance from camera to sticker
    const dx = mesh.position.x - camera.position.x;
    const dz = mesh.position.z - camera.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    // Show only within 50m (reduced for better performance)
    mesh.visible = distance < 50;
    if (mesh.visible) nearbyCount++;
  });
  
  if (stickerCount) {
    stickerCount.textContent = nearbyCount.toString();
  }
}

/* ===== FIREBASE LISTENERS ===== */
onChildAdded(stickersRef, (snap) => {
  const id = snap.key;
  const data = snap.val();
  
  if (stickerMeshes.has(id)) return;
  if (!data.image || !data.lat || !data.lon) return;
  
  const mesh = createStickerMesh(data.image, 1.2);
  
  // CRITICAL: Set sticker at ABSOLUTE world position (NEVER changes)
  const worldPos = gpsToAbsoluteWorldPosition(data.lat, data.lon);
  mesh.position.x = worldPos.x;
  mesh.position.z = worldPos.z;
  mesh.position.y = 0.5;
  
  // Update matrix once and lock it
  mesh.updateMatrix();
  
  scene.add(mesh);
  stickerMeshes.set(id, { mesh, data });
  allStickerData.push({ id, ...data });
  
  console.log(`Sticker ${id} LOCKED at:`, {
    gps: `(${data.lat.toFixed(6)}, ${data.lon.toFixed(6)})`,
    world: `(${worldPos.x.toFixed(1)}m, ${worldPos.z.toFixed(1)}m)`,
    distanceFromOrigin: Math.sqrt(worldPos.x**2 + worldPos.z**2).toFixed(1) + 'm'
  });
  
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

/* ===== MAP INTEGRATION ===== */
async function initMap() {
  if (allStickerData.length === 0) {
    const snapshot = await get(stickersRef);
    const data = snapshot.val();
    if (data) {
      allStickerData = Object.entries(data).map(([id, val]) => ({ id, ...val }));
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
      console.warn("GPS not available");
      userGPS = { lat: 40.7589, lon: -73.9851, alt: 0, accuracy: 999 };
    }
  }
  
  leafletMap = L.map('map').setView([userGPS.lat, userGPS.lon], 15);
  
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19
  }).addTo(leafletMap);
  
  L.marker([userGPS.lat, userGPS.lon], {
    icon: L.divIcon({
      className: 'user-marker',
      html: '<div style="font-size:30px">📍</div>',
      iconSize: [30, 30],
      iconAnchor: [15, 30]
    })
  }).addTo(leafletMap).bindPopup("You are here");
  
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
        className: 'sticker-marker',
        html: '<div style="font-size:25px">🎨</div>',
        iconSize: [25, 25],
        iconAnchor: [12, 25]
      })
    }).addTo(leafletMap);
    
    if (data.image) {
      marker.bindPopup(`<img src="${data.image}" style="width:100px;height:100px;object-fit:contain;"/>`);
    }
    
    mapMarkers.push(marker);
  });
  
  console.log(`Map: ${mapMarkers.length} stickers`);
}

/* ===== RENDER LOOP ===== */
let isRendering = false;

function startRendering() {
  if (isRendering) return;
  isRendering = true;
  
  function animate() {
    if (!isRendering) return;
    requestAnimationFrame(animate);
    
    updateStickerVisibility();
    updateStickerBillboarding();
    renderer.render(scene, camera);
  }
  
  animate();
}

function stopRendering() {
  isRendering = false;
}

/* ===== CAMERA STREAM ===== */
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

/* ===== UI BUTTON HANDLERS ===== */
createStickerBtn.addEventListener("click", () => {
  showPage("draw");
});

exploreBtn.addEventListener("click", async () => {
  await enterARMode(false);
});

mapBtn.addEventListener("click", () => {
  showPage("map");
});

backFromMapBtn.addEventListener("click", () => {
  showPage("home");
});

backToHomeBtn.addEventListener("click", () => {
  showPage("home");
});

saveStickerBtn.addEventListener("click", async () => {
  pendingStickerImage = drawCanvas.toDataURL("image/png");
  await enterARMode(true);
});

placeStickerBtn.addEventListener("click", async () => {
  if (!pendingStickerImage || !userGPS) {
    arStatus.textContent = "Waiting for GPS...";
    return;
  }
  
  placeStickerBtn.disabled = true;
  arStatus.textContent = "Placing sticker...";
  
  try {
    const stickerData = {
      image: pendingStickerImage,
      lat: userGPS.lat,
      lon: userGPS.lon,
      alt: userGPS.alt,
      accuracy: userGPS.accuracy,
      owner: getUniqueUserId(),
      createdAt: Date.now()
    };
    
    await push(stickersRef, stickerData);
    
    arStatus.textContent = `Placed at (${userGPS.lat.toFixed(6)}, ${userGPS.lon.toFixed(6)})`;
    placeStickerBtn.style.display = "none";
    pendingStickerImage = null;
    
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    
  } catch (e) {
    console.error("Failed to place sticker:", e);
    arStatus.textContent = "Failed to place sticker";
    placeStickerBtn.disabled = false;
  }
});

exitArBtn.addEventListener("click", () => {
  exitARMode();
  showPage("home");
});

/* ===== ENTER/EXIT AR MODE ===== */
async function enterARMode(placingSticker = false) {
  showPage("ar");
  arStatus.textContent = "Starting AR...";
  
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
    console.warn("Permission request:", e);
  }
  
  const cameraOk = await startCamera();
  if (!cameraOk) return;
  
  try {
    arStatus.textContent = "Getting GPS...";
    const coords = await getCurrentGPS();
    userGPS = {
      lat: coords.latitude,
      lon: coords.longitude,
      alt: coords.altitude || 0,
      accuracy: coords.accuracy
    };
    
    // Initialize hybrid positioning system
    initializeLocalCoordinateSystem(userGPS.lat, userGPS.lon);
    
    // Set initial camera position
    const worldPos = gpsToAbsoluteWorldPosition(userGPS.lat, userGPS.lon);
    camera.position.x = worldPos.x;
    camera.position.z = worldPos.z;
    camera.position.y = 1.6;
    
    console.log(`Hybrid AR started:`, {
      gps: `(${userGPS.lat.toFixed(6)}, ${userGPS.lon.toFixed(6)})`,
      world: `(${worldPos.x.toFixed(1)}m, ${worldPos.z.toFixed(1)}m)`,
      accuracy: `±${Math.round(userGPS.accuracy)}m`
    });
    
    arStatus.textContent = `GPS locked ±${Math.round(coords.accuracy)}m | Local tracking active`;
    
  } catch (e) {
    console.error("GPS error:", e);
    arStatus.textContent = "GPS required";
    return;
  }
  
  startGPSWatch();
  startOrientationTracking();
  startDeviceMotionTracking();
  startRendering();
  
  if (placingSticker && pendingStickerImage) {
    placeStickerBtn.style.display = "";
    placeStickerBtn.disabled = false;
    arStatus.textContent = "Tap Place to anchor sticker here";
  } else {
    placeStickerBtn.style.display = "none";
    arStatus.textContent = "Looking for stickers...";
  }
}

function exitARMode() {
  stopCamera();
  stopGPSWatch();
  stopOrientationTracking();
  stopDeviceMotionTracking();
  stopRendering();
  placeStickerBtn.style.display = "none";
  pendingStickerImage = null;
  localOrigin = null;
  isLocalTrackingActive = false;
}

/* ===== WINDOW RESIZE ===== */
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

console.log("AR Stickers loaded - Hybrid Positioning System Ready");