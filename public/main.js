import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { ARButton } from "https://unpkg.com/three@0.171.0/examples/jsm/webxr/ARButton.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase, ref, push, set, onChildAdded, onChildRemoved, remove
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
const planesRef = ref(db, "planes");

/* ===== THREE SETUP ===== */
const canvas = document.getElementById("three-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
scene.add(light);

const enterArBtn = document.getElementById("enterArBtn");
const placePlaneBtn = document.getElementById("placePlaneBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");

let xrSession = null;
let xrRefSpace = null;
let hitTestSource = null;
let viewerSpace = null;
let reticle = null;
let localPlaneId = null;

const planeObjects = new Map();
let drawing = false;
let currentStroke = null;
let activePlaneId = null;

/* ===== GEO + HEADING ===== */
let lastHeading = 0;
function startHeadingWatcher() {
  const handler = (ev) => {
    if (ev.absolute === true || ev.alpha != null) {
      lastHeading = ev.alpha || lastHeading;
    }
  };
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then((p) => {
      if (p === "granted") window.addEventListener("deviceorientation", handler, true);
    });
  } else {
    window.addEventListener("deviceorientation", handler, true);
  }
}

function getCurrentPositionPromise() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true });
  });
}

/* ===== HELPER: Plane Creation ===== */
function createDrawingPlaneMesh(size = 2, texSize = 1024) {
  const cvs = document.createElement("canvas");
  cvs.width = texSize; cvs.height = texSize;
  const ctx = cvs.getContext("2d");
  const tex = new THREE.CanvasTexture(cvs);
  const geom = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2; // floor lock
  mesh.userData = { cvs, ctx, tex, texSize };
  return mesh;
}

function uvToCanvasXY(uv, mesh) {
  const { texSize } = mesh.userData;
  return { x: uv.x * texSize, y: (1 - uv.y) * texSize };
}

/* ===== FIREBASE SYNC ===== */
onChildAdded(planesRef, (snap) => {
  const id = snap.key;
  const meta = snap.val();
  if (!meta) return;
  createRemotePlane(id, meta);
});
onChildRemoved(planesRef, (snap) => {
  const id = snap.key;
  const p = planeObjects.get(id);
  if (p) { scene.remove(p.mesh); planeObjects.delete(id); }
});

async function createRemotePlane(planeId, meta) {
  if (planeObjects.has(planeId)) return;
  const mesh = createDrawingPlaneMesh();
  const plane = { mesh, meta };
  planeObjects.set(planeId, plane);
  scene.add(mesh);

  try {
    const pos = await getCurrentPositionPromise();
    const myLat = pos.coords.latitude;
    const myLon = pos.coords.longitude;
    const R = 6378137;
    const dLat = (meta.lat - myLat) * Math.PI / 180;
    const dLon = (meta.lon - myLon) * Math.PI / 180;
    const north = dLat * R;
    const east = dLon * R * Math.cos(((meta.lat + myLat)/2) * Math.PI/180);
    const theta = - (meta.headingAtPlace || 0) * Math.PI/180;
    const x = east * Math.cos(theta) - north * Math.sin(theta);
    const z = east * Math.sin(theta) + north * Math.cos(theta);
    mesh.position.set(x, 0, -z);
  } catch (e) { mesh.position.set(0, 0, -2); }

  // strokes
  const strokesRef = ref(db, `planes/${planeId}/strokes`);
  onChildAdded(strokesRef, (snap) => {
    const s = snap.val(); if (s) drawStroke(planeId, s);
  });
}

function drawStroke(planeId, stroke) {
  const plane = planeObjects.get(planeId);
  if (!plane) return;
  const { ctx, tex, texSize } = plane.mesh.userData;
  ctx.strokeStyle = stroke.color || "#fff";
  ctx.lineWidth = stroke.width || 5;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  const pts = stroke.points || [];
  if (pts.length < 2) return;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = p.u * texSize, y = (1 - p.v) * texSize;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  tex.needsUpdate = true;
}

/* ===== AR SESSION ===== */
async function startARSession() {
  xrSession = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["hit-test", "local-floor"],
    optionalFeatures: ["dom-overlay", "camera-access"],
    domOverlay: { root: document.body }
  });
  renderer.xr.enabled = true;
  await renderer.xr.setSession(xrSession);
  xrRefSpace = await xrSession.requestReferenceSpace("local-floor");
  viewerSpace = await xrSession.requestReferenceSpace("viewer");
  const hitSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  hitTestSource = hitSource;
  if (!reticle) {
    const g = new THREE.RingGeometry(0.12, 0.15, 32).rotateX(-Math.PI / 2);
    reticle = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.8, transparent: true }));
    reticle.matrixAutoUpdate = false;
    scene.add(reticle);
  }
  placePlaneBtn.style.display = "";
  startHeadingWatcher();
  renderer.setAnimationLoop((time, frame) => {
    if (frame && hitTestSource) {
      const hits = frame.getHitTestResults(hitTestSource);
      if (hits.length > 0) {
        const hit = hits[0];
        const pose = hit.getPose(xrRefSpace);
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
      } else reticle.visible = false;
    }
    renderer.render(scene, camera);
  });
}

/* ===== UI EVENTS ===== */
enterArBtn.onclick = async () => {
  if (navigator.xr && await navigator.xr.isSessionSupported("immersive-ar")) {
    startARSession();
  } else {
    startFallback();
  }
};

placePlaneBtn.onclick = async () => {
  const geo = await getCurrentPositionPromise();
  const planeMeta = {
    lat: geo.coords.latitude,
    lon: geo.coords.longitude,
    alt: geo.coords.altitude ?? 0,
    headingAtPlace: lastHeading,
    createdAt: Date.now()
  };
  const newRef = push(planesRef);
  await set(newRef, planeMeta);
  localPlaneId = newRef.key;
  statusEl.textContent = "Canvas placed — draw!";
};

clearBtn.onclick = async () => {
  await remove(planesRef);
  planeObjects.forEach(p => scene.remove(p.mesh));
  planeObjects.clear();
  statusEl.textContent = "Cleared all";
};

/* ===== POINTER DRAWING ===== */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener("pointerdown", (ev) => {
  pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = [...planeObjects.values()].map(v => v.mesh);
  const inter = raycaster.intersectObjects(meshes);
  if (!inter.length) return;
  const hit = inter[0];
  activePlaneId = [...planeObjects.entries()].find(([id, val]) => val.mesh === hit.object)?.[0];
  currentStroke = { color: "#fff", width: 6, points: [{ u: hit.uv.x, v: hit.uv.y }] };
  drawing = true;
});
renderer.domElement.addEventListener("pointermove", (ev) => {
  if (!drawing || !activePlaneId) return;
  pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const mesh = planeObjects.get(activePlaneId)?.mesh;
  const inter = raycaster.intersectObject(mesh);
  if (!inter.length) return;
  const uv = inter[0].uv;
  currentStroke.points.push({ u: uv.x, v: uv.y });
  drawStroke(activePlaneId, { color: "#fff", width: 6, points: currentStroke.points.slice(-2) });
});
renderer.domElement.addEventListener("pointerup", async () => {
  if (!drawing || !activePlaneId) return;
  drawing = false;
  await push(ref(db, `planes/${activePlaneId}/strokes`), {
    ...currentStroke, createdAt: Date.now()
  });
  currentStroke = null;
});

/* ===== FALLBACK MODE ===== */
async function startFallback() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = document.createElement("video");
    video.autoplay = true; video.playsInline = true;
    video.srcObject = stream;
    video.style.position = "fixed"; video.style.zIndex = "-1";
    video.style.width = "100%"; video.style.height = "100%"; video.style.objectFit = "cover";
    document.body.appendChild(video);
    placePlaneBtn.style.display = "";
    startHeadingWatcher();
    statusEl.textContent = "Fallback camera active";
  } catch (e) {
    statusEl.textContent = "Camera permission denied";
  }
}

/* ===== RENDER LOOP ===== */
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
