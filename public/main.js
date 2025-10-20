import * as THREE from "https://unpkg.com/three@0.171.0/build/three.module.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  onChildAdded,
  onChildRemoved,
  remove
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-database.js";

// ---------------- FIREBASE SETUP ----------------
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
const cubesRef = ref(db, "cubes");

// ---------------- THREE.JS SETUP ----------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Lighting
const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(0, 1, 1).normalize();
scene.add(light);

// Store cubes locally for easy reference
const cubeMap = new Map();

// ---------------- FUNCTIONS ----------------
function createCube(x, y, z, color = 0xff0000) {
  const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const material = new THREE.MeshStandardMaterial({ color });
  const cube = new THREE.Mesh(geometry, material);
  cube.position.set(x, y, z);
  scene.add(cube);
  return cube;
}

// Sync new cubes from Firebase
onChildAdded(cubesRef, (snapshot) => {
  const data = snapshot.val();
  const id = snapshot.key;
  if (!cubeMap.has(id)) {
    const cube = createCube(data.x, data.y, data.z, data.color);
    cubeMap.set(id, cube);
  }
});

// Sync cube removals
onChildRemoved(cubesRef, (snapshot) => {
  const id = snapshot.key;
  const cube = cubeMap.get(id);
  if (cube) {
    scene.remove(cube);
    cubeMap.delete(id);
  }
});

// Add cube on click
renderer.domElement.addEventListener("click", (event) => {
  const mouse = new THREE.Vector2(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1
  );

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);

  const distance = 3;
  const point = raycaster.ray.origin
    .clone()
    .add(raycaster.ray.direction.multiplyScalar(distance));

  const color = Math.random() * 0xffffff;
  push(cubesRef, {
    x: point.x,
    y: point.y,
    z: point.z,
    color
  });
});

// Clear all cubes
document.getElementById("clearBtn").addEventListener("click", async () => {
  await remove(cubesRef);
  cubeMap.forEach((cube) => scene.remove(cube));
  cubeMap.clear();
});

// ---------------- ANIMATION LOOP ----------------
function animate() {
  requestAnimationFrame(animate);
  cubeMap.forEach((cube) => {
    cube.rotation.x += 0.01;
    cube.rotation.y += 0.01;
  });
  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
