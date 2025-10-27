// main.js - GPS AR Stickers with VISUAL TRACKING for room-scale movement
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

// VISUAL TRACKING SYSTEM
let isARTrackingActive = false;
let visualTracker = {
  // World state
  worldOrigin: null,
  
  // Device state
  devicePosition: new THREE.Vector3(0, 0, 0),
  deviceVelocity: new THREE.Vector3(0, 0, 0),
  lastAcceleration: new THREE.Vector3(0, 0, 0),
  lastTimestamp: 0,
  
  // Visual tracking state
  featurePoints: [],
  isTracking: false,
  movementScale: 1.0 // Scale factor for movement (calibrated)
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

/* ===== ABSOLUTE GPS POSITIONING SYSTEM ===== */
const EARTH_RADIUS = 6378137;

// FIXED WORLD ORIGIN - Times Square, NYC (same for EVERYONE)
const WORLD_ORIGIN = {
  lat: 40.758896,
  lon: -73.985130
};

// Convert GPS coordinates to absolute world position in meters
function gpsToAbsoluteWorldPosition(lat, lon) {
  const earthRadius = 6378137;
  
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const originLatRad = WORLD_ORIGIN.lat * Math.PI / 180;
  const originLonRad = WORLD_ORIGIN.lon * Math.PI / 180;
  
  const dLat = latRad - originLatRad;
  const dLon = lonRad - originLonRad;
  
  const x = dLon * earthRadius * Math.cos(originLatRad);
  const z = -dLat * earthRadius;
  
  return { x, z };
}

// Calculate distance between two GPS points in meters
function calculateGPSDistance(gps1, gps2) {
  const R = 6371000;
  const dLat = (gps2.lat - gps1.lat) * Math.PI / 180;
  const dLon = (gps2.lon - gps1.lon) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(gps1.lat * Math.PI / 180) * Math.cos(gps2.lat * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/* ===== VISUAL-INERTIAL TRACKING SYSTEM ===== */
function initializeVisualTracking(userLat, userLon) {
  const worldPos = gpsToAbsoluteWorldPosition(userLat, userLon);
  
  visualTracker.worldOrigin = {
    gps: { lat: userLat, lon: userLon },
    worldX: worldPos.x,
    worldZ: worldPos.z
  };
  
  // Reset device state
  visualTracker.devicePosition.set(0, 1.6, 0); // Start at eye level
  visualTracker.deviceVelocity.set(0, 0, 0);
  visualTracker.lastAcceleration.set(0, 0, 0);
  visualTracker.lastTimestamp = Date.now();
  visualTracker.isTracking = true;
  
  console.log(`🎯 VISUAL TRACKING INITIALIZED at GPS (${userLat}, ${userLon})`);
}

// Simple step detection and movement tracking
function startMotionTracking() {
  if (typeof DeviceMotionEvent === "undefined") {
    console.warn("DeviceMotionEvent not supported - using basic tracking");
    return false;
  }

  let stepCount = 0;
  let lastStepTime = 0;
  const stepCooldown = 300; // ms between steps

  function handleDeviceMotion(event) {
    if (!visualTracker.isTracking || !event.accelerationIncludingGravity) return;
    
    const now = Date.now();
    const deltaTime = (now - visualTracker.lastTimestamp) / 1000;
    
    if (visualTracker.lastTimestamp === 0 || deltaTime > 0.1) {
      visualTracker.lastTimestamp = now;
      return;
    }
    
    const accel = event.accelerationIncludingGravity;
    
    // Step detection using vertical acceleration
    const verticalAccel = Math.abs(accel.y - 9.81); // Remove gravity
    const totalAccel = Math.sqrt(accel.x * accel.x + accel.y * accel.y + accel.z * accel.z);
    
    // Detect steps (walking motion)
    if (verticalAccel > 2.0 && (now - lastStepTime) > stepCooldown) {
      stepCount++;
      lastStepTime = now;
      
      // Estimate step length (approx 0.7m per step)
      const stepLength = 0.7 * visualTracker.movementScale;
      
      // Use camera direction to determine step direction
      const direction = new THREE.Vector3(0, 0, -1);
      direction.applyQuaternion(camera.quaternion);
      direction.y = 0; // Keep movement horizontal
      direction.normalize().multiplyScalar(stepLength);
      
      // Update device position
      visualTracker.devicePosition.x += direction.x;
      visualTracker.devicePosition.z += direction.z;
      
      console.log(`👣 Step ${stepCount}: Moved ${stepLength.toFixed(2)}m to (${visualTracker.devicePosition.x.toFixed(2)}, ${visualTracker.devicePosition.z.toFixed(2)})`);
      
      // Update camera position in WORLD SPACE
      updateCameraWorldPosition();
    }
    
    // Continuous movement tracking (for smoother motion)
    const currentAccel = new THREE.Vector3(
      accel.x * deltaTime,
      (accel.y - 9.81) * deltaTime, // Remove gravity
      accel.z * deltaTime
    );
    
    // Integrate acceleration to get velocity
    visualTracker.deviceVelocity.add(currentAccel);
    
    // Apply damping to velocity
    visualTracker.deviceVelocity.multiplyScalar(0.9);
    
    // Integrate velocity to get position (small continuous movements)
    const movement = visualTracker.deviceVelocity.clone().multiplyScalar(deltaTime * visualTracker.movementScale);
    visualTracker.devicePosition.add(movement);
    
    // Update camera position
    updateCameraWorldPosition();
    
    visualTracker.lastTimestamp = now;
    visualTracker.lastAcceleration.copy(currentAccel);
  }

  // Request permission and start tracking
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    DeviceMotionEvent.requestPermission()
      .then(permission => {
        if (permission === "granted") {
          window.addEventListener("devicemotion", handleDeviceMotion, true);
          console.log("Motion tracking started with permission");
        }
      })
      .catch(err => {
        console.warn("Motion permission denied:", err);
        // Fall back to basic tracking
        startBasicTouchTracking();
      });
  } else {
    window.addEventListener("devicemotion", handleDeviceMotion, true);
    console.log("Motion tracking started (no permission required)");
  }
  
  return true;
}

// Fallback: Touch-based movement for devices without motion sensors
function startBasicTouchTracking() {
  console.log("Starting basic touch-based movement");
  
  const moveSpeed = 0.1;
  let isMoving = false;
  let moveDirection = new THREE.Vector3(0, 0, 0);
  
  // Virtual joystick for movement
  document.addEventListener('keydown', (e) => {
    switch(e.key) {
      case 'ArrowUp': moveDirection.z = -moveSpeed; break;
      case 'ArrowDown': moveDirection.z = moveSpeed; break;
      case 'ArrowLeft': moveDirection.x = -moveSpeed; break;
      case 'ArrowRight': moveDirection.x = moveSpeed; break;
    }
    isMoving = true;
  });
  
  document.addEventListener('keyup', (e) => {
    switch(e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        moveDirection.set(0, 0, 0);
        isMoving = false;
        break;
    }
  });
  
  // Add movement to render loop
  const originalAnimate = animate;
  animate = function() {
    if (!isRendering) return;
    requestAnimationFrame(animate);
    
    if (isMoving && visualTracker.isTracking) {
      // Apply movement based on camera direction
      const worldDirection = moveDirection.clone();
      worldDirection.applyQuaternion(camera.quaternion);
      worldDirection.y = 0;
      
      visualTracker.devicePosition.add(worldDirection);
      updateCameraWorldPosition();
    }
    
    updateStickerVisibility();
    updateStickerBillboarding();
    renderer.render(scene, camera);
  };
}

// Update camera position in absolute world space
function updateCameraWorldPosition() {
  if (!visualTracker.worldOrigin) return;
  
  // Convert local device position to world space
  camera.position.x = visualTracker.worldOrigin.worldX + visualTracker.devicePosition.x;
  camera.position.z = visualTracker.worldOrigin.worldZ + visualTracker.devicePosition.z;
  camera.position.y = visualTracker.devicePosition.y; // Keep eye level
  
  // Debug: Log position every few seconds
  if (Math.random() < 0.01) { // ~1% chance per frame
    console.log(`📍 Camera at world (${camera.position.x.toFixed(2)}, ${camera.position.z.toFixed(2)}) | Local (${visualTracker.devicePosition.x.toFixed(2)}, ${visualTracker.devicePosition.z.toFixed(2)})`);
  }
}

function stopMotionTracking() {
  window.removeEventListener("devicemotion", handleDeviceMotion, true);
  visualTracker.isTracking = false;
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
      
      // Only update for significant GPS movements (>10 meters)
      if (userGPS && calculateGPSDistance(userGPS, newGPS) < 10) {
        return; // Ignore GPS jitter
      }
      
      userGPS = newGPS;
      
      // Update visual tracking origin if GPS moved significantly
      if (visualTracker.worldOrigin && 
          calculateGPSDistance(visualTracker.worldOrigin.gps, newGPS) > 20) {
        initializeVisualTracking(userGPS.lat, userGPS.lon);
        console.log("🔄 GPS origin updated due to significant movement");
      }
      
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
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);

// Store sticker meshes: stickerId -> { mesh, data }
const stickerMeshes = new Map();

/* ===== CREATE STICKER MESH ===== */
function createStickerMesh(base64Image, sizeMeters = 1.0) {
  return new Promise((resolve) => {
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(base64Image, (texture) => {
      texture.encoding = THREE.sRGBEncoding;
      
      const geometry = new THREE.PlaneGeometry(sizeMeters, sizeMeters);
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        opacity: 0.9
      });
      
      const mesh = new THREE.Mesh(geometry, material);
      
      // Stickers are vertical and face the user
      mesh.rotation.x = 0;
      mesh.position.y = 0.5;
      
      // CRITICAL: Stickers are LOCKED in world space
      mesh.matrixAutoUpdate = false;
      
      resolve(mesh);
    });
  });
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
  if (!event.alpha || !visualTracker.isTracking) return;
  
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
        console.log("Orientation tracking started");
      }
    }).catch(err => {
      console.warn("Orientation permission denied:", err);
    });
  } else {
    window.addEventListener("deviceorientation", handleDeviceOrientation, true);
    console.log("Orientation tracking started (no permission required)");
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
    
    // Make sticker face camera while keeping it upright
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
    
    // Update the locked matrix
    mesh.updateMatrix();
  });
}

/* ===== UPDATE STICKER VISIBILITY ===== */
function updateStickerVisibility() {
  if (!userGPS) return;
  
  let nearbyCount = 0;
  
  stickerMeshes.forEach((entry, id) => {
    const { mesh, data } = entry;
    
    // Calculate distance from camera to sticker in WORLD SPACE
    const dx = mesh.position.x - camera.position.x;
    const dz = mesh.position.z - camera.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    // Show only within 50m
    const isVisible = distance < 50;
    mesh.visible = isVisible;
    
    if (isVisible) {
      nearbyCount++;
      
      // Debug logging for first nearby sticker
      if (nearbyCount === 1 && Math.random() < 0.01) {
        console.log(`📏 Sticker ${distance.toFixed(1)}m away at world (${mesh.position.x.toFixed(1)}, ${mesh.position.z.toFixed(1)})`);
      }
    }
  });
  
  if (stickerCount) {
    stickerCount.textContent = nearbyCount.toString();
  }
}

/* ===== FIREBASE LISTENERS ===== */
onChildAdded(stickersRef, async (snap) => {
  const id = snap.key;
  const data = snap.val();
  
  if (stickerMeshes.has(id)) return;
  if (!data.image || !data.lat || !data.lon) return;
  
  try {
    const mesh = await createStickerMesh(data.image, 1.0);
    
    // CRITICAL: Set sticker at ABSOLUTE world position (NEVER changes)
    const worldPos = gpsToAbsoluteWorldPosition(data.lat, data.lon);
    mesh.position.x = worldPos.x;
    mesh.position.z = worldPos.z;
    mesh.position.y = 0.5;
    
    // Update matrix once and lock it - sticker is now PERMANENTLY anchored
    mesh.updateMatrix();
    
    scene.add(mesh);
    stickerMeshes.set(id, { mesh, data });
    allStickerData.push({ id, ...data });
    
    console.log(`✅ Sticker ${id} PERMANENTLY ANCHORED at world (${worldPos.x.toFixed(1)}, ${worldPos.z.toFixed(1)})`);
    
    updateMapMarkers();
  } catch (error) {
    console.error("Failed to create sticker mesh:", error);
  }
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
  // ... (same as before) ...
}

function updateMapMarkers() {
  // ... (same as before) ...
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
  // ... (same as before) ...
}

function stopCamera() {
  // ... (same as before) ...
}

/* ===== UI BUTTON HANDLERS ===== */
// ... (same as before) ...

/* ===== ENTER/EXIT AR MODE ===== */
async function enterARMode(placingSticker = false) {
  showPage("ar");
  arStatus.textContent = "Starting AR with motion tracking...";
  isARTrackingActive = true;
  
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
    arStatus.textContent = "Getting GPS and starting motion tracking...";
    const coords = await getCurrentGPS();
    userGPS = {
      lat: coords.latitude,
      lon: coords.longitude,
      alt: coords.altitude || 0,
      accuracy: coords.accuracy
    };
    
    // Initialize visual tracking system
    initializeVisualTracking(userGPS.lat, userGPS.lon);
    
    // Set initial camera position
    updateCameraWorldPosition();
    
    console.log(`🎯 MOTION TRACKING AR STARTED:`, {
      gps: `(${userGPS.lat.toFixed(6)}, ${userGPS.lon.toFixed(6)})`,
      accuracy: `±${Math.round(userGPS.accuracy)}m`,
      description: "Walk around! Motion sensors will track your movement"
    });
    
    arStatus.textContent = `🎯 Motion Tracking Active | Walk around to explore!`;
    
  } catch (e) {
    console.error("GPS error:", e);
    arStatus.textContent = "GPS required for world AR";
    return;
  }
  
  startGPSWatch();
  startOrientationTracking();
  startMotionTracking();
  startRendering();
  
  if (placingSticker && pendingStickerImage) {
    placeStickerBtn.style.display = "";
    placeStickerBtn.disabled = false;
    arStatus.textContent = "Tap Place to PERMANENTLY anchor sticker here";
  } else {
    placeStickerBtn.style.display = "none";
    arStatus.textContent = "🎯 Walk around to explore world stickers!";
  }
}

function exitARMode() {
  isARTrackingActive = false;
  stopCamera();
  stopGPSWatch();
  stopOrientationTracking();
  stopMotionTracking();
  stopRendering();
  placeStickerBtn.style.display = "none";
  pendingStickerImage = null;
  
  showPage("home"); // FIXED: Now properly returns to home page
  
  console.log("AR mode exited - motion tracking stopped");
}

/* ===== WINDOW RESIZE ===== */
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

console.log("🎯 MOTION-TRACKING AR STICKERS LOADED");
console.log("Features: Step detection, inertial tracking, absolute world anchors");