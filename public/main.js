// main.js - PROPER GPS + COMPASS + ORIENTATION AR ANCHORING
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
let userGPS = null; // Current GPS position
let userCompassHeading = 0; // Compass heading (0-360, 0 = North)
let deviceOrientation = { alpha: 0, beta: 0, gamma: 0 }; // Phone tilt
let gpsWatchId = null;
let cameraStream = null;
let pendingStickerImage = null;
let leafletMap = null;
let mapMarkers = [];
let allStickerData = [];
let isARTrackingActive = false;

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

/* ===== GPS + COMPASS POSITIONING SYSTEM ===== */
const EARTH_RADIUS = 6378137; // meters

// Convert GPS to absolute world position (meters from equator/prime meridian)
function gpsToWorldPosition(lat, lon) {
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  
  // X = East-West (longitude), Z = North-South (latitude)
  const x = lonRad * EARTH_RADIUS * Math.cos(latRad);
  const z = -latRad * EARTH_RADIUS; // Negative because North is -Z in THREE.js
  
  return { x, z };
}

// Calculate where the phone is POINTING based on GPS, compass, and camera tilt
function calculateLookAtPoint(userGPS, compassHeading, pitch, distance = 2) {
  // Get user's world position
  const userWorld = gpsToWorldPosition(userGPS.lat, userGPS.lon);
  
  // Compass heading: 0° = North, 90° = East, 180° = South, 270° = West
  // Convert to radians and adjust for THREE.js coordinate system
  const headingRad = (compassHeading) * Math.PI / 180;
  
  // Pitch (up/down tilt) - beta from device orientation
  // When looking at ground, pitch is ~90°, when looking forward pitch is ~0°
  const pitchRad = pitch * Math.PI / 180;
  
  // Calculate how far forward the camera is looking on the ground
  const groundDistance = distance * Math.cos(pitchRad);
  
  // Calculate the point on the ground where phone is looking
  const lookAtX = userWorld.x + Math.sin(headingRad) * groundDistance;
  const lookAtZ = userWorld.z - Math.cos(headingRad) * groundDistance;
  
  return { x: lookAtX, z: lookAtZ, y: 0 };
}

// Calculate GPS coordinates from world position (for placement)
function worldPositionToGPS(worldX, worldZ) {
  const latRad = -worldZ / EARTH_RADIUS;
  const lat = latRad * 180 / Math.PI;
  
  const latRadForLon = lat * Math.PI / 180;
  const lonRad = worldX / (EARTH_RADIUS * Math.cos(latRadForLon));
  const lon = lonRad * 180 / Math.PI;
  
  return { lat, lon };
}

function getCurrentGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error("Geolocation not available"));
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      reject,
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
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
        accuracy: pos.coords.accuracy,
        heading: pos.coords.heading // GPS-based heading (when moving)
      };
      
      console.log(`GPS: (${userGPS.lat.toFixed(6)}, ${userGPS.lon.toFixed(6)}) ±${userGPS.accuracy.toFixed(0)}m`);
    },
    (err) => console.warn("GPS error:", err),
    { 
      enableHighAccuracy: true, 
      maximumAge: 500,
      timeout: 10000
    }
  );
}

function stopGPSWatch() {
  if (gpsWatchId) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

/* ===== COMPASS HEADING (CRITICAL FOR DIRECTION) ===== */
function startCompassWatch() {
  // Use deviceorientationabsolute for true compass heading
  const handleOrientation = (event) => {
    if (event.alpha !== null) {
      // Alpha = compass heading (0-360°)
      // 0° = North, 90° = East, 180° = South, 270° = West
      userCompassHeading = event.alpha;
      deviceOrientation.alpha = event.alpha;
      deviceOrientation.beta = event.beta || 0; // Pitch (forward/back tilt)
      deviceOrientation.gamma = event.gamma || 0; // Roll (left/right tilt)
      
      // Update camera orientation in AR
      if (isARTrackingActive && camera) {
        updateCameraOrientation();
      }
    }
  };
  
  if (typeof DeviceOrientationEvent !== "undefined" && 
      typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then(permission => {
      if (permission === "granted") {
        window.addEventListener("deviceorientationabsolute", handleOrientation, true);
        window.addEventListener("deviceorientation", handleOrientation, true);
        console.log("Compass tracking started");
      }
    }).catch(console.warn);
  } else {
    window.addEventListener("deviceorientationabsolute", handleOrientation, true);
    window.addEventListener("deviceorientation", handleOrientation, true);
    console.log("Compass tracking started (no permission needed)");
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
  0.01,
  100
);
camera.position.set(0, 1.6, 0);

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

// Store sticker meshes: stickerId -> { mesh, data, worldPos }
const stickerMeshes = new Map();

/* ===== CREATE STICKER MESH ===== */
function createStickerMesh(base64Image, sizeMeters = 0.3) {
  return new Promise((resolve) => {
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(base64Image, (texture) => {
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
      
      resolve(mesh);
    });
  });
}

/* ===== UPDATE CAMERA POSITION AND ORIENTATION ===== */
function updateCameraOrientation() {
  if (!userGPS || !isARTrackingActive) return;
  
  // Set camera at user's GPS position
  const userWorld = gpsToWorldPosition(userGPS.lat, userGPS.lon);
  camera.position.x = userWorld.x;
  camera.position.z = userWorld.z;
  camera.position.y = 1.6; // Eye level
  
  // Rotate camera based on compass heading
  // Alpha = compass heading (0° = North)
  const headingRad = userCompassHeading * Math.PI / 180;
  
  // Apply rotation - Y axis for compass, X axis for pitch
  camera.rotation.order = 'YXZ';
  camera.rotation.y = -headingRad; // Negative to match THREE.js coordinates
  
  // Apply pitch (looking up/down)
  const pitch = deviceOrientation.beta || 0;
  camera.rotation.x = (pitch - 90) * Math.PI / 180; // Adjust for phone orientation
}

/* ===== UPDATE STICKER POSITIONS RELATIVE TO CAMERA ===== */
function updateStickerVisibility() {
  if (!userGPS || !camera) return;
  
  const userWorld = gpsToWorldPosition(userGPS.lat, userGPS.lon);
  let nearbyCount = 0;
  
  stickerMeshes.forEach((entry) => {
    const { mesh, data } = entry;
    if (!data.lat || !data.lon) {
      mesh.visible = false;
      return;
    }
    
    // Get sticker's FIXED world position
    const stickerWorld = gpsToWorldPosition(data.lat, data.lon);
    
    // Position sticker in world (NEVER changes)
    mesh.position.x = stickerWorld.x;
    mesh.position.z = stickerWorld.z;
    mesh.position.y = 0.01;
    
    // Calculate distance
    const dx = stickerWorld.x - userWorld.x;
    const dz = stickerWorld.z - userWorld.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    // Show only within 30m
    mesh.visible = distance < 30;
    if (mesh.visible) nearbyCount++;
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
    const mesh = await createStickerMesh(data.image, 0.3);
    const worldPos = gpsToWorldPosition(data.lat, data.lon);
    
    mesh.position.x = worldPos.x;
    mesh.position.z = worldPos.z;
    mesh.position.y = 0.01;
    
    scene.add(mesh);
    stickerMeshes.set(id, { mesh, data, worldPos });
    allStickerData.push({ id, ...data });
    
    console.log(`Sticker ${id} at GPS (${data.lat.toFixed(6)}, ${data.lon.toFixed(6)})`);
    
    updateMapMarkers();
  } catch (error) {
    console.error("Failed to create sticker:", error);
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

/* ===== MAP ===== */
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
      userGPS = { lat: 40.7589, lon: -73.9851, alt: 0, accuracy: 999 };
    }
  }
  
  leafletMap = L.map('map', {
    zoomControl: false,
    attributionControl: false
  }).setView([userGPS.lat, userGPS.lon], 17);
  
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
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
}

/* ===== RENDER LOOP ===== */
let isRendering = false;

function startRendering() {
  if (isRendering) return;
  isRendering = true;
  
  function animate() {
    if (!isRendering) return;
    requestAnimationFrame(animate);
    
    updateCameraOrientation();
    updateStickerVisibility();
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

/* ===== UI HANDLERS ===== */
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
  await enterARMode(true);
});

placeStickerBtn.addEventListener("click", async () => {
  if (!pendingStickerImage || !userGPS) {
    arStatus.textContent = "Waiting for GPS...";
    return;
  }
  
  placeStickerBtn.disabled = true;
  arStatus.textContent = "Calculating placement...";
  
  try {
    // Calculate WHERE the phone is POINTING using compass + pitch
    const pitch = deviceOrientation.beta || 45; // Default 45° down if no data
    const lookAtPoint = calculateLookAtPoint(userGPS, userCompassHeading, pitch, 2);
    
    // Convert world position back to GPS
    const placementGPS = worldPositionToGPS(lookAtPoint.x, lookAtPoint.z);
    
    const stickerData = {
      image: pendingStickerImage,
      lat: placementGPS.lat,
      lon: placementGPS.lon,
      alt: 0,
      accuracy: userGPS.accuracy,
      owner: getUniqueUserId(),
      createdAt: Date.now()
    };
    
    await push(stickersRef, stickerData);
    
    arStatus.textContent = `Placed at (${placementGPS.lat.toFixed(6)}, ${placementGPS.lon.toFixed(6)})`;
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

/* ===== ENTER/EXIT AR ===== */
async function enterARMode(placingSticker = false) {
  showPage("ar");
  arStatus.textContent = "Starting AR...";
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
    arStatus.textContent = "Getting GPS...";
    const coords = await getCurrentGPS();
    userGPS = {
      lat: coords.latitude,
      lon: coords.longitude,
      alt: coords.altitude || 0,
      accuracy: coords.accuracy
    };
    
    arStatus.textContent = `GPS: ±${Math.round(coords.accuracy)}m | Compass: ${Math.round(userCompassHeading)}°`;
    
  } catch (e) {
    console.error("GPS error:", e);
    arStatus.textContent = "GPS required";
    return;
  }
  
  startGPSWatch();
  startCompassWatch();
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
  isARTrackingActive = false;
  stopCamera();
  stopGPSWatch();
  stopRendering();
  placeStickerBtn.style.display = "none";
  pendingStickerImage = null;
}

/* ===== RESIZE ===== */
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

console.log("Surfaceless NYC - GPS + Compass AR loaded");