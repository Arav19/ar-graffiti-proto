// main.js — Full hybrid GPS + visual AR, mobile-first, keeps original logic

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
let gpsWatchId = null;
let cameraStream = null;
let pendingStickerImage = null;
let leafletMap = null;
let mapMarkers = [];
let allStickerData = [];

/* ===== Orientation & compass state ===== */
let lastDeviceOrientation = { alpha: null, beta: null, gamma: null, absolute: false };
let lastCompassHeading = null;
let lastDeviceQuaternion = new THREE.Quaternion();

/* ===== UTILITIES ===== */
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
  return { x: x * (drawCanvas.width / rect.width), y: y * (drawCanvas.height / rect.height) };
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

clearDrawBtn.addEventListener("click", () => drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height));

/* ===== GPS UTILITIES ===== */
const EARTH_RADIUS = 6378137;
const WORLD_ORIGIN = { lat: 40.758896, lon: -73.985130 }; // Times Square

function gpsToAbsoluteWorldPosition(lat, lon) {
  const dLat = (lat - WORLD_ORIGIN.lat) * Math.PI / 180;
  const dLon = (lon - WORLD_ORIGIN.lon) * Math.PI / 180;
  const x = dLon * EARTH_RADIUS * Math.cos(WORLD_ORIGIN.lat * Math.PI / 180);
  const z = -dLat * EARTH_RADIUS;
  return { x, z };
}

function getCurrentGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not available"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  });
}

let targetCameraPos = new THREE.Vector3(0, 1.6, 0);
const cameraLerpFactor = 0.25;

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
      const worldPos = gpsToAbsoluteWorldPosition(userGPS.lat, userGPS.lon);
      targetCameraPos.set(worldPos.x, 1.6, worldPos.z);
    },
    (err) => console.warn("GPS watch error:", err),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
}

function stopGPSWatch() {
  if (gpsWatchId) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = null;
}

/* ===== THREE.JS SCENE ===== */
const renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1.6, 0);

const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
scene.add(light);

const stickerMeshes = new Map();

function createStickerMesh(base64Image, sizeMeters = 1.2) {
  const texture = new THREE.TextureLoader().load(base64Image);
  texture.encoding = THREE.sRGBEncoding;
  const geometry = new THREE.PlaneGeometry(sizeMeters, sizeMeters);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
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
  euler.set(beta * degToRad, alpha * degToRad, -gamma * degToRad, 'YXZ');
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
  if (event.alpha != null) updateCompassHeadingFromAlpha(event.alpha, event.absolute);
  if (event.alpha != null) setDeviceQuaternion(camera.quaternion, event.alpha, event.beta || 0, event.gamma || 0, screenOrientation);
  lastDeviceQuaternion.copy(camera.quaternion);
}

let screenOrientation = 0;
function getScreenOrientation() { return window.screen.orientation?.angle || window.orientation || 0; }
screenOrientation = getScreenOrientation();
window.addEventListener('orientationchange', () => { screenOrientation = getScreenOrientation(); });

function startOrientationTracking() {
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then(permission => {
      if (permission === "granted") window.addEventListener("deviceorientation", handleDeviceOrientation, true);
      else console.warn("DeviceOrientation permission not granted");
    }).catch(err => { window.addEventListener("deviceorientation", handleDeviceOrientation, true); });
  } else window.addEventListener("deviceorientation", handleDeviceOrientation, true);
}

function stopOrientationTracking() { window.removeEventListener("deviceorientation", handleDeviceOrientation, true); }

/* ===== STICKER VISIBILITY ===== */
function updateStickerVisibility() {
  if (!userGPS) return;
  let nearbyCount = 0;
  stickerMeshes.forEach((entry) => {
    const { mesh } = entry;
    const dx = mesh.position.x - camera.position.x;
    const dz = mesh.position.z - camera.position.z;
    const distance = Math.sqrt(dx*dx + dz*dz);
    mesh.visible = distance < 100;
    if (mesh.visible) nearbyCount++;
  });
  if (stickerCount) stickerCount.textContent = nearbyCount.toString();
}

/* ===== FIREBASE LISTENERS ===== */
onChildAdded(stickersRef, (snap) => {
  const id = snap.key;
  const data = snap.val();
  if (stickerMeshes.has(id) || !data.image || data.lat==null || data.lon==null) return;
  const mesh = createStickerMesh(data.image, data.sizeMeters || 1.2);
  const worldPos = gpsToAbsoluteWorldPosition(data.lat, data.lon);
  mesh.position.x = worldPos.x;
  mesh.position.z = worldPos.z;
  mesh.position.y = (data.alt || 0) + 0.02;
  if (data.heading != null) mesh.rotation.y = THREE.MathUtils.degToRad(data.heading);
  else if (data.orientationQuaternion) {
    try {
      const q = new THREE.Quaternion(data.orientationQuaternion._x, data.orientationQuaternion._y, data.orientationQuaternion._z, data.orientationQuaternion._w);
      mesh.rotation.y = new THREE.Euler().setFromQuaternion(q,'YXZ').y;
    } catch(e){}
  } else mesh.rotation.y = 0;
  mesh.updateMatrix();
  scene.add(mesh);
  stickerMeshes.set(id,{ mesh,data });
  allStickerData.push({ id,...data });
  tryVisualAnchorSync(id,mesh,data);
  updateMapMarkers();
});

onChildRemoved(stickersRef, (snap) => {
  const id = snap.key;
  const entry = stickerMeshes.get(id);
  if(entry){
    scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.map?.dispose();
    entry.mesh.material.dispose();
    stickerMeshes.delete(id);
  }
  allStickerData = allStickerData.filter(s=>s.id!==id);
  updateMapMarkers();
});

function tryVisualAnchorSync(id, mesh, data) {
  // placeholder for plane/anchor sync in future
}

/* ===== MAP INTEGRATION ===== */
async function initMap(){
  if(allStickerData.length===0){
    try{
      const snapshot = await get(stickersRef);
      const data = snapshot.val();
      if(data) allStickerData = Object.entries(data).map(([id,val])=>({id,...val}));
    }catch(e){console.warn("Failed to load stickers for map:", e);}
  }
  if(leafletMap){leafletMap.invalidateSize(); updateMapMarkers(); return;}
  if(!userGPS){
    try{
      const coords = await getCurrentGPS();
      userGPS = { lat: coords.latitude, lon: coords.longitude, alt: coords.altitude||0, accuracy: coords.accuracy };
    }catch(e){userGPS={lat:40.7589,lon:-73.9851,alt:0,accuracy:999};}
  }
  leafletMap = L.map('map',{ zoomControl:false, attributionControl:false }).setView([userGPS.lat,userGPS.lon],16);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution:'', maxZoom:19, minZoom:13 }).addTo(leafletMap);
  L.marker([userGPS.lat,userGPS.lon],{icon:L.divIcon({className:'user-marker-custom', html:'<div style="font-size:40px">📍</div>', iconSize:[40,40], iconAnchor:[20,40]})}).addTo(leafletMap).bindPopup("📍 You are here");
  updateMapMarkers();
}

function updateMapMarkers(){
  if(!leafletMap) return;
  mapMarkers.forEach(m=>leafletMap.removeLayer(m));
  mapMarkers=[];
  allStickerData.forEach(data=>{
    if(!data.lat||!data.lon) return;
    const marker=L.marker([data.lat,data.lon],{icon:L.divIcon({className:'sticker-marker-custom', html:`<img src="${data.image}" style="width:50px;height:50px;object-fit:contain;" />`, iconSize:[50,50], iconAnchor:[25,25]})}).addTo(leafletMap);
    if(data.image) marker.bindPopup(`<img src="${data.image}" style="width:150px;height:150px;object-fit:contain;background:white;border-radius:10px;padding:5px;" />`);
    mapMarkers.push(marker);
  });
}

/* ===== RENDER LOOP ===== */
let isRendering=false;
function startRendering(){
  if(isRendering) return;
  isRendering=true;
  (function animate(){
    if(!isRendering) return;
    requestAnimationFrame(animate);
    camera.position.lerp(targetCameraPos,cameraLerpFactor);
    updateStickerVisibility();
    renderer.render(scene,camera);
  })();
}
function stopRendering(){isRendering=false;}

/* ===== CAMERA STREAM ===== */
async function startCamera(){
  try{
    if(cameraStream) cameraStream.getTracks().forEach(t=>t.stop());
    cameraStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:"environment" }, width:{ideal:1920}, height:{ideal:1080} }, audio:false });
    arVideo.srcObject=cameraStream;
    await arVideo.play();
    return true;
  }catch(e){console.error("Camera error:",e); arStatus.textContent="Camera permission required"; return false;}
}
function stopCamera(){if(cameraStream) cameraStream.getTracks().forEach(t=>t.stop()); cameraStream=null; arVideo.srcObject=null;}

/* ===== UI BUTTONS ===== */
createStickerBtn.addEventListener("click",()=>showPage("draw"));
exploreBtn.addEventListener("click",async()=>await enterARMode(false));
mapBtn.addEventListener("click",()=>showPage("map"));
aboutBtn.addEventListener("click",()=>showPage("about"));
backFromMapBtn.addEventListener("click",()=>showPage("home"));
backFromAboutBtn.addEventListener("click",()=>showPage("home"));
backToHomeBtn.addEventListener("click",()=>showPage("home"));

saveStickerBtn.addEventListener("click",async()=>{
  pendingStickerImage = drawCanvas.toDataURL("image/png");
  await enterARMode(true);
});

placeStickerBtn.addEventListener("click",async()=>{
  if(!pendingStickerImage||!userGPS){arStatus.textContent="Waiting for GPS..."; return;}
  placeStickerBtn.disabled=true; arStatus.textContent="Placing sticker...";
  try{
    const stickerData={
      image: pendingStickerImage,
      lat: userGPS.lat,
      lon: userGPS.lon,
      alt: userGPS.alt,
      accuracy: userGPS.accuracy,
      owner:getUniqueUserId(),
      createdAt:Date.now(),
      heading:lastCompassHeading!=null?lastCompassHeading:null,
      orientationQuaternion:{_x:lastDeviceQuaternion.x||0,_y:lastDeviceQuaternion.y||0,_z:lastDeviceQuaternion.z||0,_w:lastDeviceQuaternion.w||1},
      sizeMeters:1.2
    };
    const newRef = push(stickersRef);
    await set(newRef,stickerData);
    pendingStickerImage=null;
    arStatus.textContent="Sticker placed!";
  }catch(e){console.error(e); arStatus.textContent="Failed to place sticker";}
  placeStickerBtn.disabled=false;
});

/* ===== ENTER AR MODE ===== */
async function enterARMode(isPlacingSticker){
  showPage("ar");
  startGPSWatch();
  startOrientationTracking();
  await startCamera();
  startRendering();
  if(isPlacingSticker) arStatus.textContent="Pan camera to place sticker, then tap 'Place Sticker'";
  else arStatus.textContent="Explore nearby stickers";
}

/* ===== EXIT AR MODE ===== */
function exitARMode(){
  stopGPSWatch();
  stopOrientationTracking();
  stopRendering();
  stopCamera();
  showPage("home");
  arStatus.textContent="";
}
exitArBtn.addEventListener("click",exitARMode);

/* ===== INITIAL ===== */
showPage("home");
