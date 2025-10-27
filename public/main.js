import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  onValue
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

/* ---------- FIREBASE ---------- */
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

/* ---------- ELEMENTS ---------- */
const drawSection = document.getElementById("drawSection");
const arSection = document.getElementById("arSection");
const cameraFeed = document.getElementById("cameraFeed");
const overlayCanvas = document.getElementById("overlayCanvas");
const ctxOverlay = overlayCanvas.getContext("2d");
const drawCanvas = document.getElementById("drawCanvas");
const ctx = drawCanvas.getContext("2d");
const clearBtn = document.getElementById("clearBtn");
const saveBtn = document.getElementById("saveBtn");
const placeBtn = document.getElementById("placeBtn");
const backBtn = document.getElementById("backBtn");
const statusEl = document.getElementById("status");

let drawing = false;
let currentStickerId = null;

/* ---------- DRAW MODE ---------- */
function startDrawMode() {
  drawSection.style.display = "flex";
  arSection.style.display = "none";
  statusEl.textContent = "Draw your graffiti sticker!";

  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#fff";

  drawCanvas.onpointerdown = (e) => {
    drawing = true;
    ctx.beginPath();
    ctx.moveTo(e.offsetX, e.offsetY);
  };

  drawCanvas.onpointermove = (e) => {
    if (!drawing) return;
    ctx.lineTo(e.offsetX, e.offsetY);
    ctx.stroke();
  };

  drawCanvas.onpointerup = () => (drawing = false);
  drawCanvas.onpointerleave = () => (drawing = false);

  clearBtn.onclick = () => ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

  saveBtn.onclick = async () => {
    const imageData = drawCanvas.toDataURL("image/png");
    const newStickerRef = push(stickersRef);
    await set(newStickerRef, {
      image: imageData,
      placed: false,
      timestamp: Date.now()
    });
    currentStickerId = newStickerRef.key;
    startARMode();
  };
}

/* ---------- AR MODE ---------- */
function startARMode() {
  drawSection.style.display = "none";
  arSection.style.display = "flex";
  statusEl.textContent = "Move your camera and tap 'Place Sticker'.";

  startCamera();

  placeBtn.onclick = () => {
    if (!currentStickerId) return;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      await set(ref(db, `stickers/${currentStickerId}/position`), {
        lat: latitude,
        lon: longitude
      });
      await set(ref(db, `stickers/${currentStickerId}/placed`), true);
      alert("Sticker placed successfully!");
    });
  };

  backBtn.onclick = startDrawMode;
}

/* ---------- CAMERA BACKGROUND ---------- */
function startCamera() {
  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: "environment" } })
    .then((stream) => {
      cameraFeed.srcObject = stream;
      overlayCanvas.width = window.innerWidth;
      overlayCanvas.height = window.innerHeight;
      renderOverlay();
    })
    .catch((err) => {
      console.error("Camera failed:", err);
      statusEl.textContent = "Camera access failed. Try refreshing or allow permissions.";
    });
}

/* ---------- OVERLAY ---------- */
function renderOverlay() {
  ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  onValue(stickersRef, (snapshot) => {
    const data = snapshot.val();
    if (data) {
      Object.values(data).forEach((s) => {
        if (s.placed && s.image && s.position) {
          const img = new Image();
          img.src = s.image;
          img.onload = () => {
            // rough GPS visualization
            const x = ((s.position.lon % 1) * overlayCanvas.width) / 2;
            const y = ((s.position.lat % 1) * overlayCanvas.height) / 2;
            ctxOverlay.drawImage(img, x, y, 100, 100);
          };
        }
      });
    }
  });
}

/* ---------- INIT ---------- */
startDrawMode();
