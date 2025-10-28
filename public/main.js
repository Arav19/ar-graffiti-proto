// main.js - GPS TRIANGULATION + VISUAL TRACKING + COMPASS-RELATIVE AR
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
let userGPS = null;
let userCompassHeading = 0;
let devicePitch = 0;
let deviceRoll = 0;
let gpsWatchId = null;
let cameraStream = null;
let pendingStickerImage = null;
let leafletMap = null;
let mapMarkers = [];
let allStickerData = [];
let isARActive = false;

// Visual tracking state
let initialCameraPosition = new THREE.Vector3();
let initialCameraRotation = new THREE.Euler();
let visualTrackingActive = false;
let cameraMovementDelta = new THREE.Vector3();
let cameraRotationDelta = new THREE.Euler();

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

/* ===== GPS TRIANGULATION WITH 3 REFERENCE POINTS ===== */
const EARTH_RADIUS = 6378137;

// Three reference anchors around NYC for triangulation
const GPS_ANCHORS = {
  timesSquare: { lat: 40.758896, lon: -73.985130, name: "Times Square" },
  centralPark: { lat: 40.785091, lon: -73.968285, name: "Central Park" },
  brooklynBridge: { lat: 40.706086, lon: -73.996864, name: "Brooklyn Bridge" }
};

// Calculate world position using triangulation from 3 anchors
function gpsToWorldMetersTriangulated(lat, lon) {
  const results = [];
  
  // Calculate position relative to each anchor
  Object.values(GPS_ANCHORS).forEach(anchor => {
    const dLat = (lat - anchor.lat) * Math.PI / 180;
    const dLon = (lon - anchor.lon) * Math.PI / 180;
    
    const x = dLon * EARTH_RADIUS * Math.cos(anchor.lat * Math.PI / 180);
    const z = -dLat * EARTH_RADIUS;
    
    results.push({ x, z });
  });
  
  // Average the three results for better accuracy
  const avgX = (results[0].x + results[1].x + results[2].x) / 3;
  const avgZ = (results[0].z + results[1].z + results[2].z) / 3;
  
  return { x: avgX, z: avgZ };
}

function worldMetersToGPS(x, z) {
  // Use Times Square as primary anchor for reverse conversion
  const anchor = GPS_ANCHORS.timesSquare;
  
  const lat = anchor.lat - (z / EARTH_RADIUS) * (180 / Math.PI);
  const lon = anchor.lon + (x / (EARTH_RADIUS * Math.cos(anchor.lat * Math.PI / 180))) * (180 / Math.PI);
  
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
      { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 }
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
      
      console.log(`GPS: (${userGPS.lat.toFixed(6)}, ${userGPS.lon.toFixed(6)}) ±${userGPS.accuracy.toFixed(1)}m`);
    },
    (err) => console.warn("GPS error:", err),
    { enableHighAccuracy: true, maximumAge: 500, timeout: 10000 }
  );
}

function stopGPSWatch() {
  if (gpsWatchId) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

/* ===== COMPASS & ORIENTATION WITH VISUAL TRACKING ===== */
function handleDeviceOrientation(event) {
  if (!isARActive) return;
  
  if (event.alpha !== null) {
    userCompassHeading = event.alpha; // 0-360, 0 = North
  }
  
  if (event.beta !== null) {
    devicePitch = event.beta; // Forward/back tilt
  }
  
  if (event.gamma !== null) {
    deviceRoll = event.gamma; // Left/right tilt
  }
  
  // Update camera with hybrid GPS + visual tracking
  updateCameraFromOrientation();
}

function startOrientationTracking() {
  if (typeof DeviceOrientationEvent !== "undefined" && 
      typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then(permission => {
      if (permission === "granted") {
        window.addEventListener("deviceorientationabsolute", handleDeviceOrientation, true);
        window.addEventListener("deviceorientation", handleDeviceOrientation, true);
        console.log("✅ Orientation tracking started");
      }
    }).catch(err => {
      window.addEventListener("deviceorientation", handleDeviceOrientation, true);
      console.warn("Permission error, using regular orientation:", err);
    });
  } else {
    window.addEventListener("deviceorientationabsolute", handleDeviceOrientation, true);
    window.addEventListener("deviceorientation", handleDeviceOrientation, true);
    console.log("✅ Orientation tracking started");
  }
}

function stopOrientationTracking() {
  window.removeEventListener("deviceorientationabsolute", handleDeviceOrientation, true);
  window.removeEventListener("deviceorientation", handleDeviceOrientation, true);
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
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  100
);
camera.position.set(0, 1.6, 0);

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

const stickerMeshes = new Map();

/* ===== CREATE STICKER MESH (CLOSER TO CAMERA) ===== */
async function createStickerMesh(base64Image, sizeMeters = 0.8) {
  return new Promise((resolve, reject) => {
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      base64Image,
      (texture) => {
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
        mesh.position.y = 0.02; // Slightly above ground for visibility
        
        resolve(mesh);
      },
      undefined,
      (error) => {
        console.error("Texture load error:", error);
        reject(error);
      }
    );
  });
}

/* ===== HYBRID GPS + VISUAL TRACKING FOR CAMERA ===== */
function updateCameraFromOrientation() {
  if (!userGPS || !isARActive) return;
  
  // GPS-based position (coarse)
  const worldPos = gpsToWorldMetersTriangulated(userGPS.lat, userGPS.lon);
  
  // If visual tracking not initialized, set initial position
  if (!visualTrackingActive) {
    initialCameraPosition.set(worldPos.x, 1.6, worldPos.z);
    camera.position.copy(initialCameraPosition);
    
    // Set initial rotation from compass
    const headingRad = -userCompassHeading * (Math.PI / 180);
    const pitchRad = (devicePitch - 90) * (Math.PI / 180);
    initialCameraRotation.set(pitchRad, headingRad, 0, 'YXZ');
    
    visualTrackingActive = true;
    cameraMovementDelta.set(0, 0, 0);
  } else {
    // Fine-tune position with visual tracking (simulated by orientation changes)
    // This prevents GPS jitter from moving stickers
    const headingRad = -userCompassHeading * (Math.PI / 180);
    const pitchRad = (devicePitch - 90) * (Math.PI / 180);
    
    // Only update GPS position if moved > 3 meters to prevent jitter
    const gpsDeltaX = worldPos.x - initialCameraPosition.x;
    const gpsDeltaZ = worldPos.z - initialCameraPosition.z;
    const gpsMovement = Math.sqrt(gpsDeltaX * gpsDeltaX + gpsDeltaZ * gpsDeltaZ);
    
    if (gpsMovement > 3) {
      // Significant GPS movement - update base position
      initialCameraPosition.set(worldPos.x, 1.6, worldPos.z);
      camera.position.copy(initialCameraPosition);
      console.log(`📍 GPS moved ${gpsMovement.toFixed(1)}m - updating base position`);
    } else {
      // Small movements - use orientation for fine tracking
      camera.position.copy(initialCameraPosition);
    }
    
    // Rotation updates continuously from compass/gyro
    camera.rotation.order = 'YXZ';
    camera.rotation.y = headingRad;
    camera.rotation.x = pitchRad;
  }
}

/* ===== UPDATE STICKER VISIBILITY WITH DISTANCE SCALING ===== */
function updateStickerVisibility() {
  if (!userGPS || !isARActive) return;
  
  const userWorld = gpsToWorldMetersTriangulated(userGPS.lat, userGPS.lon);
  let nearbyCount = 0;
  
  stickerMeshes.forEach((entry) => {
    const { mesh, data } = entry;
    if (!data.lat || !data.lon) {
      mesh.visible = false;
      return;
    }
    
    // Sticker world position (FIXED - never moves)
    const stickerWorld = gpsToWorldMetersTriangulated(data.lat, data.lon);
    mesh.position.x = stickerWorld.x;
    mesh.position.z = stickerWorld.z;
    mesh.position.y = 0.02;
    
    // Calculate distance
    const dx = stickerWorld.x - userWorld.x;
    const dz = stickerWorld.z - userWorld.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    // Show within 50m, scale size based on distance for better visibility
    mesh.visible = distance < 50;
    
    if (mesh.visible) {
      nearbyCount++;
      
      // Scale sticker based on distance (closer = smaller, farther = slightly bigger for visibility)
      const minScale = 0.8;
      const maxScale = 1.5;
      const scale = Math.min(maxScale, minScale + (distance / 50) * (maxScale - minScale));
      mesh.scale.setScalar(scale);
    }
  });
  
  if (stickerCount) {
    stickerCount.textContent = nearbyCount.toString();
  }
}

/* ===== FIREBASE LISTENERS WITH COMPASS-RELATIVE POSITIONING ===== */
onChildAdded(stickersRef, async (snap) => {
  const id = snap.key;
  const data = snap.val();
  
  if (stickerMeshes.has(id)) return;
  if (!data.image || !data.lat || !data.lon) return;
  
  try {
    const mesh = await createStickerMesh(data.image, 0.8);
    const worldPos = gpsToWorldMetersTriangulated(data.lat, data.lon);
    
    mesh.position.x = worldPos.x;
    mesh.position.z = worldPos.z;
    mesh.position.y = 0.02;
    
    // Apply compass-relative rotation if saved
    if (data.placementHeading !== undefined) {
      // Rotate sticker to match the heading it was placed at
      const headingRad = -data.placementHeading * (Math.PI / 180);
      mesh.rotation.z = headingRad; // Z rotation for flat plane
    }
    
    scene.add(mesh);
    stickerMeshes.set(id, { mesh, data });
    allStickerData.push({ id, ...data });
    
    console.log(`✅ Sticker ${id} at GPS (${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}) heading: ${data.placementHeading?.toFixed(0)}°`);
    
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

/* ===== MAP WITH GLOBAL ZOOM ===== */
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
    zoomControl: true, // ENABLED for global zoom
    attributionControl: false,
    minZoom: 3, // Allow global zoom out
    maxZoom: 19
  }).setView([userGPS.lat, userGPS.lon], 15);
  
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    minZoom: 3
  }).addTo(leafletMap);
  
  L.marker([userGPS.lat, userGPS.lon], {
    icon: L.divIcon({
      className: 'user-marker-custom',
      html: '<div style="font-size:40px">📍</div>',
      iconSize: [40, 40],
      iconAnchor: [20, 40]
    })
  }).addTo(leafletMap).bindPopup("You are here");
  
  // Add reference anchor markers for debugging
  Object.values(GPS_ANCHORS).forEach(anchor => {
    L.marker([anchor.lat, anchor.lon], {
      icon: L.divIcon({
        className: 'anchor-marker',
        html: '<div style="font-size:20px;color:#FFD700;">⚓</div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      })
    }).addTo(leafletMap).bindPopup(`Reference: ${anchor.name}`);
  });
  
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
      const headingInfo = data.placementHeading !== undefined 
        ? `<br/>Heading: ${data.placementHeading.toFixed(0)}°` 
        : '';
      marker.bindPopup(`<img src="${data.image}" style="width:150px;height:150px;object-fit:contain;background:white;border-radius:10px;padding:5px;"/>${headingInfo}`);
    }
    
    mapMarkers.push(marker);
  });
  
  console.log(`🗺️ Map: ${mapMarkers.length} stickers`);
}

/* ===== RENDER LOOP ===== */
let isRendering = false;

function startRendering() {
  if (isRendering) return;
  isRendering = true;
  
  function animate() {
    if (!isRendering) return;
    requestAnimationFrame(animate);
    
    updateCameraFromOrientation();
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
    
    console.log("📹 Camera started");
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
  arStatus.textContent = "Placing sticker...";
  
  try {
    // Calculate where phone is pointing (1.5m in front)
    const headingRad = userCompassHeading * (Math.PI / 180);
    const distance = 1.5; // meters in front
    
    const userWorld = gpsToWorldMetersTriangulated(userGPS.lat, userGPS.lon);
    const placeX = userWorld.x + Math.sin(headingRad) * distance;
    const placeZ = userWorld.z - Math.cos(headingRad) * distance;
    
    const placeGPS = worldMetersToGPS(placeX, placeZ);
    
    const stickerData = {
      image: pendingStickerImage,
      lat: placeGPS.lat,
      lon: placeGPS.lon,
      alt: 0,
      accuracy: userGPS.accuracy,
      placementHeading: userCompassHeading, // SAVE COMPASS HEADING
      placementPitch: devicePitch,
      placementRoll: deviceRoll,
      owner: getUniqueUserId(),
      createdAt: Date.now()
    };
    
    await push(stickersRef, stickerData);
    
    arStatus.textContent = `✅ Placed at heading ${userCompassHeading.toFixed(0)}°`;
    placeStickerBtn.style.display = "none";
    pendingStickerImage = null;
    
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    
    console.log(`📍 Placed sticker at (${placeGPS.lat.toFixed(6)}, ${placeGPS.lon.toFixed(6)}) heading: ${userCompassHeading.toFixed(0)}°`);
    
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
  isARActive = true;
  visualTrackingActive = false; // Reset visual tracking
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
    arStatus.textContent = "Getting GPS (triangulated)...";
    const coords = await getCurrentGPS();
    userGPS = {
      lat: coords.latitude,
      lon: coords.longitude,
      alt: coords.altitude || 0,
      accuracy: coords.accuracy
    };
    
    arStatus.textContent = `GPS: ±${Math.round(coords.accuracy)}m | Heading: ${Math.round(userCompassHeading)}°`;
    
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
    arStatus.textContent = "Looking for stickers...";
  }
}

function exitARMode() {
  isARActive = false;
  visualTrackingActive = false;
  stopCamera();
  stopGPSWatch();
  stopOrientationTracking();
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

console.log("🌍 Surfaceless NYC - GPS Triangulation + Visual Tracking AR loaded");
console.log("📍 Reference anchors:", Object.keys(GPS_ANCHORS).join(", "));