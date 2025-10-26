import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  onValue,
  update
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";
import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { ARButton } from "https://unpkg.com/three@0.171.0/examples/jsm/webxr/ARButton.js";

/* ----------------- FIREBASE SETUP ----------------- */
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

/* ----------------- ELEMENTS ----------------- */
const drawSection = document.getElementById("drawSection");
const arSection = document.getElementById("arSection");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("drawCanvas");
const ctx = canvas.getContext("2d");
const clearBtn = document.getElementById("clearBtn");
const saveBtn = document.getElementById("saveBtn");
const enterARBtn = document.getElementById("enterAR");
const placeBtn = document.getElementById("placeBtn");

let drawing = false;
let stickerId = null;

/* ----------------- STAGE 1: DRAW MODE ----------------- */
function startDrawMode() {
  drawSection.style.display = "flex";
  arSection.style.display = "none";
  statusEl.textContent = "Draw your sticker";

  resizeCanvas();
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#fff";

  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    ctx.beginPath();
    ctx.moveTo(e.offsetX, e.offsetY);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    ctx.lineTo(e.offsetX, e.offsetY);
    ctx.stroke();
  });

  canvas.addEventListener("pointerup", () => (drawing = false));
  canvas.addEventListener("pointerleave", () => (drawing = false));

  clearBtn.onclick = () => ctx.clearRect(0, 0, canvas.width, canvas.height);

  saveBtn.onclick = () => {
    const dataURL = canvas.toDataURL("image/png");
    const newStickerRef = push(stickersRef);

    update(newStickerRef, {
      image: dataURL,
      placed: false,
      timestamp: Date.now()
    }).then(() => {
      stickerId = newStickerRef.key;
      localStorage.setItem("lastStickerId", stickerId);
      startARMode();
    });
  };
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

/* ----------------- STAGE 2: AR MODE ----------------- */
function startARMode() {
  drawSection.style.display = "none";
  arSection.style.display = "flex";
  statusEl.textContent = "Tap Enter AR to view/place stickers.";
}

/* ----------------- WEBXR AR RENDERING ----------------- */
enterARBtn.onclick = async () => {
  statusEl.style.display = "none";
  arSection.style.display = "block";

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    20
  );
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);
  document.body.appendChild(ARButton.createButton(renderer, { requiredFeatures: ["hit-test"] }));

  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  scene.add(light);

  const userStickerId = localStorage.getItem("lastStickerId");
  placeBtn.style.display = "block";

  // GPS placement
  placeBtn.onclick = async () => {
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude, longitude } = pos.coords;
      update(ref(db, "stickers/" + userStickerId), {
        lat: latitude,
        lon: longitude,
        placed: true
      });
      alert("Sticker placed!");
    });
  };

  // Listen for stickers in range
  navigator.geolocation.watchPosition((pos) => {
    const { latitude, longitude } = pos.coords;
    onValue(stickersRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;
      Object.entries(data).forEach(([id, s]) => {
        if (!s.placed || !s.image) return;
        const dist = getDistanceFromLatLon(latitude, longitude, s.lat, s.lon);
        if (dist < 50) addStickerToScene(scene, s);
      });
    });
  });

  renderer.setAnimationLoop(() => renderer.render(scene, camera));
};

/* ----------------- HELPERS ----------------- */
function addStickerToScene(scene, sticker) {
  const texture = new THREE.TextureLoader().load(sticker.image);
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.8),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide
    })
  );
  plane.position.set(
    (sticker.lon % 1) * 10 - 5,
    0,
    (sticker.lat % 1) * 10 - 5
  );
  scene.add(plane);
}

function getDistanceFromLatLon(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ----------------- INIT ----------------- */
window.addEventListener("resize", resizeCanvas);
startDrawMode();
