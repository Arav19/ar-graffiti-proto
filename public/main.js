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

/* ---------------- FIREBASE ---------------- */
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

/* ---------------- ELEMENTS ---------------- */
const drawSection = document.getElementById("drawSection");
const arSection = document.getElementById("arSection");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("drawCanvas");
const ctx = canvas.getContext("2d");
const clearBtn = document.getElementById("clearBtn");
const saveBtn = document.getElementById("saveBtn");
const placeBtn = document.getElementById("placeBtn");

let drawing = false;
let currentStickerId = null;

/* ---------------- DRAW MODE ---------------- */
function startDrawMode() {
  drawSection.style.display = "flex";
  arSection.style.display = "none";
  statusEl.textContent = "Draw your sticker!";

  ctx.lineWidth = 5;
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

  ["pointerup", "pointerleave"].forEach((ev) =>
    canvas.addEventListener(ev, () => (drawing = false))
  );

  clearBtn.onclick = () => ctx.clearRect(0, 0, canvas.width, canvas.height);

  saveBtn.onclick = async () => {
    const dataURL = canvas.toDataURL("image/png");
    const newStickerRef = push(stickersRef);
    await update(newStickerRef, {
      image: dataURL,
      placed: false,
      timestamp: Date.now()
    });
    currentStickerId = newStickerRef.key;
    localStorage.setItem("lastStickerId", currentStickerId);
    startARMode();
  };
}

/* ---------------- AR MODE ---------------- */
function startARMode() {
  drawSection.style.display = "none";
  arSection.style.display = "block";
  statusEl.textContent = "Loading AR mode...";

  // Fallback for iPhone
  if (!navigator.xr) {
    statusEl.textContent = "WebXR not supported. Showing camera fallback.";
    startFallbackAR();
    return;
  }

  initWebXR();
}

/* ---------------- WebXR INITIALIZATION ---------------- */
async function initWebXR() {
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

  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  scene.add(light);

  document.body.appendChild(
    ARButton.createButton(renderer, { requiredFeatures: ["hit-test"] })
  );

  // Listen for stickers in database
  onValue(stickersRef, (snapshot) => {
    const data = snapshot.val();
    if (data) {
      Object.entries(data).forEach(([id, s]) => {
        if (s.placed && s.image && s.lat && s.lon) {
          addStickerToScene(scene, s);
        }
      });
    }
  });

  // Show Place Button
  placeBtn.style.display = "block";
  placeBtn.onclick = async () => {
    if (!currentStickerId) {
      alert("No sticker to place.");
      return;
    }
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude, longitude } = pos.coords;
      update(ref(db, "stickers/" + currentStickerId), {
        lat: latitude,
        lon: longitude,
        placed: true
      });
      alert("Sticker placed and saved!");
    });
  };

  renderer.setAnimationLoop(() => renderer.render(scene, camera));
}

/* ---------------- FALLBACK AR (for iPhone) ---------------- */
function startFallbackAR() {
  arSection.style.display = "block";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.style.position = "fixed";
  video.style.top = "0";
  video.style.left = "0";
  video.style.width = "100%";
  video.style.height = "100%";
  video.style.objectFit = "cover";
  document.body.appendChild(video);

  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: "environment" } })
    .then((stream) => (video.srcObject = stream));

  placeBtn.style.display = "block";
  placeBtn.onclick = async () => {
    if (!currentStickerId) {
      alert("No sticker to place.");
      return;
    }
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude, longitude } = pos.coords;
      update(ref(db, "stickers/" + currentStickerId), {
        lat: latitude,
        lon: longitude,
        placed: true
      });
      alert("Sticker placed!");
    });
  };
}

/* ---------------- STICKER ADDER ---------------- */
function addStickerToScene(scene, sticker) {
  const texture = new THREE.TextureLoader().load(sticker.image);
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.6, 0.6),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide
    })
  );
  // Rough GPS positioning (convert lat/lon to relative)
  plane.position.set(
    ((sticker.lon % 1) - 0.5) * 50,
    0,
    ((sticker.lat % 1) - 0.5) * 50
  );
  scene.add(plane);
}

/* ---------------- INIT ---------------- */
startDrawMode();
