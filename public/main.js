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

/* ---------------- UI ELEMENTS ---------------- */
const statusEl = document.getElementById("status");
const drawSection = document.getElementById("drawSection");
const arSection = document.getElementById("arSection");
const canvas = document.getElementById("drawCanvas");
const ctx = canvas.getContext("2d");
const clearBtn = document.getElementById("clearBtn");
const saveBtn = document.getElementById("saveBtn");
const placeBtn = document.getElementById("placeBtn");
const cameraFeed = document.getElementById("cameraFeed");

let drawing = false;
let currentStickerId = null;
let myLat = null;
let myLon = null;

/* ---------------- DRAW MODE ---------------- */
function goDrawMode(){
  drawSection.classList.add("active");
  arSection.classList.remove("active");
  statusEl.textContent = "Draw your sticker!";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#fff";

  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", endDrawing);
  canvas.addEventListener("pointerleave", endDrawing);

  clearBtn.onclick = () => {
    ctx.clearRect(0,0,canvas.width,canvas.height);
  };
  saveBtn.onclick = async () => {
    const dataURL = canvas.toDataURL("image/png");
    const newRef = push(stickersRef);
    await update(newRef, {
      image: dataURL,
      placed: false,
      timestamp: Date.now()
    });
    currentStickerId = newRef.key;
    localStorage.setItem("lastStickerId", currentStickerId);
    goARMode();
  };
}

function pointerDown(e){
  drawing = true;
  ctx.beginPath();
  ctx.moveTo(e.offsetX, e.offsetY);
}
function pointerMove(e){
  if (!drawing) return;
  ctx.lineTo(e.offsetX, e.offsetY);
  ctx.stroke();
}
function endDrawing(){
  drawing = false;
}

/* ---------------- AR MODE ---------------- */
function goARMode(){
  drawSection.classList.remove("active");
  arSection.classList.add("active");
  statusEl.textContent = "Preparing AR…";

  navigator.geolocation.getCurrentPosition(pos=>{
    myLat = pos.coords.latitude;
    myLon = pos.coords.longitude;
  });

  if (!navigator.xr){
    statusEl.textContent = "WebXR not supported. Camera fallback.";
    startFallback();
    return;
  }
  navigator.xr.isSessionSupported('immersive-ar').then((supported)=>{
    if (supported){
      initWebXR();
    } else {
      statusEl.textContent = "AR not supported on this device. Camera fallback.";
      startFallback();
    }
  }).catch((err)=>{
    console.warn(err);
    statusEl.textContent = "Error checking AR support. Camera fallback.";
    startFallback();
  });
}

/* ---------------- WebXR / AR Setup ---------------- */
async function initWebXR(){
  statusEl.textContent = "Entering AR. Move your device to scan surface.";

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.01, 20);
  const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  scene.add(light);

  const reticleGeom = new THREE.RingGeometry(0.15,0.2,32).rotateX(-Math.PI/2);
  const reticleMat = new THREE.MeshBasicMaterial({color:0xffffff});
  const reticle = new THREE.Mesh(reticleGeom, reticleMat);
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const xrRefSpace = await renderer.xr.getSession().requestReferenceSpace('local-floor');
  const viewerSpace = await renderer.xr.getSession().requestReferenceSpace('viewer');
  const hitTestSource = await renderer.xr.getSession().requestHitTestSource({ space: viewerSpace });

  // Show AR button
  document.body.appendChild(ARButton.createButton(renderer, { requiredFeatures: ['hit-test'] }));

  // Handle tap to place sticker
  const controller = renderer.xr.getController(0);
  controller.addEventListener('select', ()=> {
    if (!reticle.visible) return;
    // Place sticker now at reticle position
    const pos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
    // Upload sticker position
    update(ref(db, "stickers/" + currentStickerId), {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      placed: true
    });
    statusEl.textContent = "Sticker placed!";
    placeBtn.style.display = "none";
  });
  scene.add(controller);

  // Show place button
  placeBtn.style.display = "block";
  placeBtn.onclick = ()=> {
    if (!reticle.visible) {
      alert("Move your device until the reticle appears on a flat surface.");
      return;
    }
    controller.dispatchEvent({ type:'select' });
  };

  // Load existing stickers
  onValue(stickersRef, snapshot=>{
    const data = snapshot.val();
    if (!data) return;
    // Clear previous sticker meshes
    scene.traverse(obj=>{
      if (obj.userData && obj.userData.isSticker) {
        scene.remove(obj);
      }
    });
    // Add stickers
    Object.entries(data).forEach(([id, s])=>{
      if (s.placed && s.image && (s.x!=null)){
        const texture = new THREE.TextureLoader().load(s.image);
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(0.5,0.5),
          new THREE.MeshBasicMaterial({map:texture, transparent:true, side:THREE.DoubleSide})
        );
        plane.position.set(s.x, s.y, s.z);
        plane.userData.isSticker = true;
        scene.add(plane);
      }
    });
  });

  renderer.setAnimationLoop((time, frame)=>{
    if (frame){
      const hitResults = frame.getHitTestResults(hitTestSource);
      if (hitResults.length){
        const hit = hitResults[0];
        const pose = hit.getPose(xrRefSpace);
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        reticle.visible = false;
      }
    }
    renderer.render(scene, camera);
  });
}

/* ---------------- Camera Fallback ---------------- */
async function startFallback(){
  cameraFeed.style.display = 'block';
  const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}, audio:false});
  cameraFeed.srcObject = stream;

  placeBtn.style.display = 'block';
  placeBtn.onclick = ()=>{
    navigator.geolocation.getCurrentPosition(pos=>{
      update(ref(db, "stickers/" + currentStickerId), {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        placed:true
      });
      alert("Sticker placed at your location.");
      statusEl.textContent = "Sticker placed.";
      placeBtn.style.display = 'none';
    });
  };
}

/* ---------------- INIT ---------------- */
goDrawMode();
