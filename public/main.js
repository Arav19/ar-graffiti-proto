// main.js - GPS-anchored AR stickers with proper world-space positioning
import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  onChildAdded,
  onChildRemoved,
  onValue
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

const createStickerBtn = document.getElementById("createStickerBtn");
const exploreBtn = document.getElementById("exploreBtn");

const drawCanvas = document.getElementById("drawCanvas");
const colorPicker = document.getElementById("colorPicker");
const sizeRange = document.getElementById("sizeRange");
const clearDrawBtn = document.getElementById("clearDrawBtn");
const saveStickerBtn = document.getElementById("saveStickerBtn");
const backToHomeBtn = document.getElementById("backToHomeBtn");

const arVideo = document.getElementById("arVideo");
const threeCanvas = document.getElementById("three-canvas");
const arStatus = document.getElementById("arStatus");
const stickerCount = document.getElementById("stickerCount");
const placeStickerBtn = document.getElementById("placeStickerBtn");
const exitArBtn = document.getElementById("exitArBtn");

/* ===== STATE ===== */
let currentPage = "home";
let userGPS = null; // { lat, lon, alt, accuracy }
let userHeading = 0; // compass heading in degrees (0 = North)
let gpsWatchId = null;
let cameraStream = null;
let pendingStickerImage = null; // base64 image waiting to be placed

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
  homePage.classList.remove("active");
  drawPage.classList.remove("active");
  arPage.classList.remove("active");
  
  if (pageName === "home") homePage.classList.add("active");
  else if (pageName === "draw") drawPage.classList.add("active");
  else if (pageName === "ar") arPage.classList.add("active");
  
  currentPage = pageName;
}

/* ===== DRAWING CANVAS ===== */
const drawCtx = drawCanvas.getContext("2d");
drawCtx.fillStyle = "#ffffff";
drawCtx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);

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
  drawCtx.fillStyle = "#ffffff";
  drawCtx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
});

/* ===== GPS UTILITIES ===== */
// CRITICAL: Calculate world position from GPS coordinates
// Each sticker has absolute world coordinates based on its GPS
// We convert lat/lon to meters using a simple flat-earth approximation (good for local areas <100km)
const EARTH_RADIUS = 6378137; // meters

function gpsToWorldPosition(lat, lon) {
  // Convert lat/lon to meters (XZ plane)
  // Use lat=0, lon=0 as origin (can be any reference point)
  const x = lon * (Math.PI / 180) * EARTH_RADIUS * Math.cos(lat * Math.PI / 180);
  const z = -lat * (Math.PI / 180) * EARTH_RADIUS; // negative Z for north
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

// Compass heading (deviceorientation)
function startHeadingWatch() {
  function handleOrientation(e) {
    if (e.alpha !== null) {
      userHeading = e.alpha; // 0-360, 0 = North
      updateCameraRotation();
    }
  }
  
  if (typeof DeviceOrientationEvent !== "undefined" && 
      typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then(permission => {
      if (permission === "granted") {
        window.addEventListener("deviceorientationabsolute", handleOrientation, true);
      }
    }).catch(console.warn);
  } else {
    window.addEventListener("deviceorientationabsolute", handleOrientation, true);
    window.addEventListener("deviceorientation", handleOrientation, true);
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
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  1000
);
camera.position.set(0, 1.6, 0); // Eye level

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

// Store sticker meshes: stickerId -> { mesh, data }
const stickerMeshes = new Map();

/* ===== CREATE STICKER MESH ===== */
function createStickerMesh(base64Image, sizeMeters = 0.4) {
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
  
  // CRITICAL: Sticker always faces up (billboard effect would be added in update loop)
  mesh.rotation.x = -Math.PI / 2; // Lie flat on ground
  mesh.position.y = 0.01; // Slightly above ground
  
  return mesh;
}

/* ===== UPDATE CAMERA POSITION (GPS-based) ===== */
function updateCameraPosition() {
  if (!userGPS) return;
  
  // Convert user GPS to world position
  const worldPos = gpsToWorldPosition(userGPS.lat, userGPS.lon);
  camera.position.x = worldPos.x;
  camera.position.z = worldPos.z;
  camera.position.y = 1.6; // Eye level
  
  console.log("Camera world pos:", worldPos.x.toFixed(2), worldPos.z.toFixed(2));
}

/* ===== UPDATE CAMERA ROTATION (Compass-based) ===== */
function updateCameraRotation() {
  // Rotate camera to face forward based on compass heading
  const headingRad = -userHeading * (Math.PI / 180);
  camera.rotation.y = headingRad;
}

/* ===== UPDATE STICKER VISIBILITY ===== */
function updateStickerVisibility() {
  if (!userGPS) return;
  
  const userWorldPos = gpsToWorldPosition(userGPS.lat, userGPS.lon);
  let nearbyCount = 0;
  
  stickerMeshes.forEach((entry) => {
    const { mesh, data } = entry;
    if (!data.lat || !data.lon) {
      mesh.visible = false;
      return;
    }
    
    // Calculate distance from user to sticker
    const stickerWorldPos = gpsToWorldPosition(data.lat, data.lon);
    const dx = stickerWorldPos.x - userWorldPos.x;
    const dz = stickerWorldPos.z - userWorldPos.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    // Show only if within 100 meters
    mesh.visible = distance < 100;
    if (mesh.visible) nearbyCount++;
  });
  
  stickerCount.textContent = nearbyCount.toString();
}

/* ===== FIREBASE LISTENERS ===== */
onChildAdded(stickersRef, (snap) => {
  const id = snap.key;
  const data = snap.val();
  
  if (stickerMeshes.has(id)) return;
  if (!data.image || !data.lat || !data.lon) return;
  
  const mesh = createStickerMesh(data.image, 0.4);
  
  // CRITICAL: Set absolute world position based on GPS
  const worldPos = gpsToWorldPosition(data.lat, data.lon);
  mesh.position.x = worldPos.x;
  mesh.position.z = worldPos.z;
  mesh.position.y = 0.01;
  
  scene.add(mesh);
  stickerMeshes.set(id, { mesh, data });
  
  console.log(`Sticker ${id} placed at world pos:`, worldPos.x.toFixed(2), worldPos.z.toFixed(2));
  
  updateStickerVisibility();
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
  
  updateStickerVisibility();
});

/* ===== RENDER LOOP ===== */
let isRendering = false;

function startRendering() {
  if (isRendering) return;
  isRendering = true;
  
  function animate() {
    if (!isRendering) return;
    requestAnimationFrame(animate);
    
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
      video: { facingMode: { ideal: "environment" } },
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
  await enterARMode(false); // Explore without placing
});

backToHomeBtn.addEventListener("click", () => {
  showPage("home");
});

saveStickerBtn.addEventListener("click", async () => {
  // Save drawing to base64
  pendingStickerImage = drawCanvas.toDataURL("image/png");
  
  // Enter AR mode to place it
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
    // Create sticker in Firebase with current GPS
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
    
    // Clear the drawing
    drawCtx.fillStyle = "#ffffff";
    drawCtx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
    
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
    console.warn("Permission request failed:", e);
  }
  
  // Start camera
  const cameraOk = await startCamera();
  if (!cameraOk) return;
  
  // Get initial GPS
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
    arStatus.textContent = "GPS required for AR";
    return;
  }
  
  // Start watching GPS and heading
  startGPSWatch();
  startHeadingWatch();
  
  // Start rendering
  startRendering();
  
  // Show place button if we're placing a sticker
  if (placingSticker && pendingStickerImage) {
    placeStickerBtn.style.display = "";
    placeStickerBtn.disabled = false;
    arStatus.textContent = "Point camera at ground & tap Place";
  } else {
    placeStickerBtn.style.display = "none";
    arStatus.textContent = "Exploring stickers...";
  }
}

function exitARMode() {
  stopCamera();