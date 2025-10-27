// main.js - GPS-anchored AR stickers with FIXED orientation tracking
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
let allStickerData = []; // Store all stickers for map

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

/* ===== DRAWING CANVAS WITH TRANSPARENT BACKGROUND ===== */
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

// FIXED WORLD ORIGIN - Times Square, NYC (everyone uses this same origin)
const WORLD_ORIGIN = {
  lat: 40.758896,  // Times Square latitude
  lon: -73.985130  // Times Square longitude
};

// Convert GPS to absolute world meters (relative to fixed world origin)
function gpsToWorldMeters(lat, lon) {
  const dLat = (lat - WORLD_ORIGIN.lat) * Math.PI / 180;
  const dLon = (lon - WORLD_ORIGIN.lon) * Math.PI / 180;
  
  const x = dLon * EARTH_RADIUS * Math.cos(WORLD_ORIGIN.lat * Math.PI / 180);
  const z = -dLat * EARTH_RADIUS; // North is negative Z
  
  return { x, z };
}

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
      userGPS = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        alt: pos.coords.altitude || 0,
        accuracy: pos.coords.accuracy
      };
      updateCameraPosition();
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
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(0, 1.6, 0);

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

// Store sticker meshes: stickerId -> { mesh, data, worldPos }
const stickerMeshes = new Map();

// GPS origin point (first user GPS becomes origin)
let gpsOrigin = null;

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
  mesh.rotation.x = -Math.PI / 2; // Flat on ground
  mesh.position.y = 0.02;
  
  return mesh;
}

/* ===== DEVICE ORIENTATION (FIXED) ===== */
const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

function setDeviceQuaternion(quaternion, alpha, beta, gamma, orient) {
  const degToRad = Math.PI / 180;
  
  euler.set(
    beta * degToRad,   // X axis (pitch)
    alpha * degToRad,  // Y axis (yaw/compass)
    -gamma * degToRad, // Z axis (roll)
    'YXZ'              // Rotation order
  );
  
  quaternion.setFromEuler(euler);
  quaternion.multiply(q1);
  quaternion.multiply(q0.setFromAxisAngle(zee, -orient * degToRad));
}

let screenOrientation = 0;

function getScreenOrientation() {
  const angle = screen.orientation?.angle || window.orientation || 0;
  return angle;
}

screenOrientation = getScreenOrientation();
window.addEventListener('orientationchange', () => {
  screenOrientation = getScreenOrientation();
});

function handleDeviceOrientation(event) {
  if (!event.alpha) return;
  
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

/* ===== UPDATE CAMERA & STICKERS ===== */
function updateCameraPosition() {
  if (!userGPS) return;
  
  // Set GPS origin on first position
  if (!gpsOrigin) {
    gpsOrigin = { lat: userGPS.lat, lon: userGPS.lon };
    console.log("GPS origin set:", gpsOrigin);
  }
  
  // Convert user GPS to local position relative to origin
  const localPos = gpsToMeters(userGPS.lat, userGPS.lon, gpsOrigin.lat, gpsOrigin.lon);
  camera.position.x = localPos.x;
  camera.position.z = localPos.z;
  camera.position.y = 1.6;
}

function updateStickerPositions() {
  if (!userGPS || !gpsOrigin) return;
  
  let nearbyCount = 0;
  
  stickerMeshes.forEach((entry) => {
    const { mesh, data } = entry;
    if (!data.lat || !data.lon) {
      mesh.visible = false;
      return;
    }
    
    // Convert sticker GPS to local position relative to origin
    const stickerLocal = gpsToMeters(data.lat, data.lon, gpsOrigin.lat, gpsOrigin.lon);
    
    mesh.position.x = stickerLocal.x;
    mesh.position.z = stickerLocal.z;
    mesh.position.y = 0.02;
    
    // Calculate distance from camera
    const dx = mesh.position.x - camera.position.x;
    const dz = mesh.position.z - camera.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    // Show only within 100m
    mesh.visible = distance < 100;
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
  scene.add(mesh);
  
  stickerMeshes.set(id, { mesh, data });
  allStickerData.push({ id, ...data });
  
  console.log(`Sticker ${id} loaded at GPS (${data.lat.toFixed(6)}, ${data.lon.toFixed(6)})`);
  
  updateStickerPositions();
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
  // Load all stickers first
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
  
  // Get user GPS if not available
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
  
  // Initialize map
  leafletMap = L.map('map').setView([userGPS.lat, userGPS.lon], 15);
  
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19
  }).addTo(leafletMap);
  
  // User marker
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
  
  // Clear old markers
  mapMarkers.forEach(m => leafletMap.removeLayer(m));
  mapMarkers = [];
  
  // Add sticker markers
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
  
  console.log(`Map updated with ${mapMarkers.length} stickers`);
}

/* ===== RENDER LOOP ===== */
let isRendering = false;

function startRendering() {
  if (isRendering) return;
  isRendering = true;
  
  function animate() {
    if (!isRendering) return;
    requestAnimationFrame(animate);
    
    updateStickerPositions();
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
    
    arStatus.textContent = `Sticker placed! (±${Math.round(userGPS.accuracy)}m)`;
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
  
  // Request permissions
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
  
  // Start camera
  const cameraOk = await startCamera();
  if (!cameraOk) return;
  
  // Get GPS
  try {
    arStatus.textContent = "Getting GPS...";
    const coords = await getCurrentGPS();
    userGPS = {
      lat: coords.latitude,
      lon: coords.longitude,
      alt: coords.altitude || 0,
      accuracy: coords.accuracy
    };
    
    updateCameraPosition();
    arStatus.textContent = `GPS: ±${Math.round(coords.accuracy)}m`;
    
  } catch (e) {
    console.error("GPS error:", e);
    arStatus.textContent = "GPS required";
    return;
  }
  
  startGPSWatch();
  startOrientationTracking();
  startRendering();
  
  if (placingSticker && pendingStickerImage) {
    placeStickerBtn.style.display = "";
    placeStickerBtn.disabled = false;
    arStatus.textContent = "Point at ground & tap Place";
  } else {
    placeStickerBtn.style.display = "none";
    arStatus.textContent = "Exploring...";
  }
}

function exitARMode() {
  stopCamera();
  stopGPSWatch();
  stopOrientationTracking();
  stopRendering();
  placeStickerBtn.style.display = "none";
  pendingStickerImage = null;
}

/* ===== WINDOW RESIZE ===== */
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

console.log("AR Stickers app loaded");