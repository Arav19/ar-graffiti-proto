// main.js - GPS-anchored AR stickers with fixed real-world positioning
import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
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
const drawCanvas = document.getElementById("drawCanvas");
const colorPicker = document.getElementById("colorPicker");
const sizeRange = document.getElementById("sizeRange");
const clearDrawBtn = document.getElementById("clearDrawBtn");
const saveStickerBtn = document.getElementById("saveStickerBtn");

const arVideo = document.getElementById("arVideo");
const threeCanvas = document.getElementById("three-canvas");
const arStatus = document.getElementById("arStatus");
const stickerCount = document.getElementById("stickerCount");
const placeStickerBtn = document.getElementById("placeStickerBtn");

let userGPS = null;
let gpsWatchId = null;
let cameraStream = null;
let pendingStickerImage = null;
let gpsOrigin = null;
let stickerMeshes = new Map();
let allStickerData = [];

/* ===== UTILITIES ===== */
const EARTH_RADIUS = 6378137; // meters

function gpsToMeters(lat, lon, originLat, originLon) {
  const dLat = (lat - originLat) * Math.PI / 180;
  const dLon = (lon - originLon) * Math.PI / 180;
  const x = dLon * EARTH_RADIUS * Math.cos(originLat * Math.PI / 180);
  const z = -dLat * EARTH_RADIUS;
  return { x, z };
}

function getCurrentGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject("No GPS available");
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

/* ===== THREE.JS SETUP ===== */
const renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1.6, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));

function createStickerMesh(base64Image, sizeMeters = 1.2) {
  const texture = new THREE.TextureLoader().load(base64Image);
  texture.encoding = THREE.sRGBEncoding;

  const geometry = new THREE.PlaneGeometry(sizeMeters, sizeMeters);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  return mesh;
}

/* ===== DEVICE ORIENTATION ===== */
let screenOrientation = 0;
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const zee = new THREE.Vector3(0, 0, 1);

function setDeviceQuaternion(quaternion, alpha, beta, gamma, orient) {
  const degToRad = Math.PI / 180;
  euler.set(beta * degToRad, alpha * degToRad, -gamma * degToRad, 'YXZ');
  quaternion.setFromEuler(euler);
  quaternion.multiply(q1);
  quaternion.multiply(q0.setFromAxisAngle(zee, -orient * degToRad));
}

function handleDeviceOrientation(event) {
  if (!event.alpha) return;
  setDeviceQuaternion(camera.quaternion, event.alpha, event.beta, event.gamma, screenOrientation);
}

function startOrientationTracking() {
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then(p => {
      if (p === "granted") window.addEventListener("deviceorientation", handleDeviceOrientation, true);
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
  if (!gpsOrigin) gpsOrigin = { lat: userGPS.lat, lon: userGPS.lon };
  const pos = gpsToMeters(userGPS.lat, userGPS.lon, gpsOrigin.lat, gpsOrigin.lon);
  camera.position.set(pos.x, 1.6, pos.z);
}

function updateStickerPositions() {
  if (!userGPS || !gpsOrigin) return;
  let nearbyCount = 0;

  stickerMeshes.forEach(({ mesh, data }) => {
    const pos = gpsToMeters(data.lat, data.lon, gpsOrigin.lat, gpsOrigin.lon);
    mesh.position.x = pos.x;
    mesh.position.z = pos.z;
    mesh.position.y = 0.02;

    const dx = pos.x - camera.position.x;
    const dz = pos.z - camera.position.z;
    const distance = Math.sqrt(dx*dx + dz*dz);
    mesh.visible = distance < 100;
    if (mesh.visible) nearbyCount++;
  });

  stickerCount.textContent = nearbyCount.toString();
}

/* ===== FIREBASE LISTENERS ===== */
onChildAdded(stickersRef, (snap) => {
  const id = snap.key;
  const data = snap.val();
  if (!data.image || !data.lat || !data.lon) return;
  if (stickerMeshes.has(id)) return;

  const mesh = createStickerMesh(data.image);
  scene.add(mesh);
  stickerMeshes.set(id, { mesh, data });
  allStickerData.push({ id, ...data });

  updateStickerPositions();
});

onChildRemoved(stickersRef, (snap) => {
  const id = snap.key;
  const entry = stickerMeshes.get(id);
  if (!entry) return;
  scene.remove(entry.mesh);
  entry.mesh.geometry.dispose();
  entry.mesh.material.map?.dispose();
  entry.mesh.material.dispose();
  stickerMeshes.delete(id);
  allStickerData = allStickerData.filter(s => s.id !== id);
});

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

function stopRendering() { isRendering = false; }

/* ===== CAMERA ===== */
async function startCamera() {
  try {
    if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    arVideo.srcObject = cameraStream;
    await arVideo.play();
    return true;
  } catch (e) {
    arStatus.textContent = "Camera required";
    return false;
  }
}

function stopCamera() {
  if (!cameraStream) return;
  cameraStream.getTracks().forEach(t => t.stop());
  cameraStream = null;
  arVideo.srcObject = null;
}

/* ===== PLACE STICKER ===== */
placeStickerBtn.addEventListener("click", async () => {
  if (!pendingStickerImage || !userGPS) return;

  placeStickerBtn.disabled = true;
  arStatus.textContent = "Placing sticker...";

  const stickerData = {
    image: pendingStickerImage,
    lat: userGPS.lat,
    lon: userGPS.lon,
    alt: userGPS.alt,
    accuracy: userGPS.accuracy,
    owner: localStorage.getItem("ar_stickers_uid") || "anon",
    createdAt: Date.now()
  };

  await push(stickersRef, stickerData);

  pendingStickerImage = null;
  placeStickerBtn.style.display = "none";
  arStatus.textContent = `Sticker placed! ±${Math.round(userGPS.accuracy)}m`;
});

/* ===== ENTER AR ===== */
async function enterARMode(placingSticker = false) {
  startCamera();
  try {
    const coords = await getCurrentGPS();
    userGPS = { lat: coords.latitude, lon: coords.longitude, alt: coords.altitude || 0, accuracy: coords.accuracy };
    updateCameraPosition();
  } catch { arStatus.textContent = "GPS required"; return; }

  startGPSWatch();
  startOrientationTracking();
  startRendering();

  if (placingSticker && pendingStickerImage) {
    placeStickerBtn.style.display = "";
    placeStickerBtn.disabled = false;
    arStatus.textContent = "Point & place sticker";
  } else {
    placeStickerBtn.style.display = "none";
    arStatus.textContent = "Exploring stickers";
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

/* ===== DRAW CANVAS ===== */
const drawCtx = drawCanvas.getContext("2d");
let isDrawing = false;

function getDrawPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  const x = (e.clientX || e.touches?.[0]?.clientX) - rect.left;
  const y = (e.clientY || e.touches?.[0]?.clientY) - rect.top;
  return { x: x * (drawCanvas.width/rect.width), y: y * (drawCanvas.height/rect.height) };
}

drawCanvas.addEventListener("pointerdown", e => { isDrawing = true; drawCtx.beginPath(); drawCtx.moveTo(getDrawPos(e).x, getDrawPos(e).y); });
drawCanvas.addEventListener("pointermove", e => { if (!isDrawing) return; const pos = getDrawPos(e); drawCtx.lineTo(pos.x,pos.y); drawCtx.stroke(); });
drawCanvas.addEventListener("pointerup", () => isDrawing = false);
drawCanvas.addEventListener("pointerleave", () => isDrawing = false);
clearDrawBtn.addEventListener("click", () => drawCtx.clearRect(0,0,drawCanvas.width,drawCanvas.height));
saveStickerBtn.addEventListener("click", () => { pendingStickerImage = drawCanvas.toDataURL(); enterARMode(true); });

window.addEventListener("resize", () => { renderer.setSize(window.innerWidth,window.innerHeight); camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); });

console.log("GPS AR Stickers loaded");
