// --- Firebase setup ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getDatabase, ref, push, onValue } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-database.js";

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

// --- Elements ---
const homeScreen = document.getElementById('homeScreen');
const drawScreen = document.getElementById('drawScreen');
const arScreen = document.getElementById('arScreen');
const drawCanvas = document.getElementById('drawCanvas');
const ctx = drawCanvas.getContext('2d');
let drawing = false;

// --- Navigation ---
document.getElementById('drawBtn').onclick = () => {
  homeScreen.classList.add('hidden');
  drawScreen.classList.remove('hidden');
};

document.getElementById('arBtn').onclick = () => {
  homeScreen.classList.add('hidden');
  arScreen.classList.remove('hidden');
  loadStickersInAR();
};

document.getElementById('backHome1').onclick = () => {
  drawScreen.classList.add('hidden');
  homeScreen.classList.remove('hidden');
};

document.getElementById('backHome2').onclick = () => {
  arScreen.classList.add('hidden');
  homeScreen.classList.remove('hidden');
};

// --- Drawing Functionality ---
drawCanvas.addEventListener('mousedown', startDraw);
drawCanvas.addEventListener('mousemove', draw);
drawCanvas.addEventListener('mouseup', stopDraw);
drawCanvas.addEventListener('touchstart', startDraw);
drawCanvas.addEventListener('touchmove', draw);
drawCanvas.addEventListener('touchend', stopDraw);

function getPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function startDraw(e) {
  e.preventDefault();
  drawing = true;
  const { x, y } = getPos(e);
  ctx.beginPath();
  ctx.moveTo(x, y);
}

function draw(e) {
  if (!drawing) return;
  e.preventDefault();
  const { x, y } = getPos(e);
  ctx.lineTo(x, y);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function stopDraw(e) {
  drawing = false;
  ctx.closePath();
}

// --- Save Sticker ---
document.getElementById('saveStickerBtn').onclick = async () => {
  if (!navigator.geolocation) {
    alert("Geolocation not supported");
    return;
  }

  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const imgData = drawCanvas.toDataURL('image/png');
    push(ref(db, 'stickers'), { lat, lon, imgData });
    alert("Sticker saved at your location!");
    ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  });
};

// --- Load Stickers in AR Mode ---
function loadStickersInAR() {
  const scene = document.querySelector('a-scene');
  const stickersRef = ref(db, 'stickers');

  onValue(stickersRef, snapshot => {
    const data = snapshot.val();
    if (!data) return;

    Object.values(data).forEach(sticker => {
      const el = document.createElement('a-image');
      el.setAttribute('src', sticker.imgData);
      el.setAttribute('gps-entity-place', `latitude: ${sticker.lat}; longitude: ${sticker.lon};`);
      el.setAttribute('scale', '10 10 10');
      el.setAttribute('look-at', '[gps-camera]');
      scene.appendChild(el);
    });
  });
}
