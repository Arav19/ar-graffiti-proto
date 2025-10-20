import * as THREE from 'three';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, push, onChildAdded, onChildRemoved, remove } from 'firebase/database';

// 🔥 Your Firebase project configuration
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
const cubesRef = ref(db, 'cubes');

// 🎨 Setup Three.js
const canvas = document.getElementById('three-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1.5, 3);

const light = new THREE.HemisphereLight(0xffffff, 0x222222, 1);
scene.add(light);

// Add a simple grid to visualize space
const grid = new THREE.GridHelper(10, 10, 0x333333, 0x111111);
scene.add(grid);

// Track window resizing
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// Store all cubes in memory
const cubes = {};

// 👀 Listen for cubes added by any user
onChildAdded(cubesRef, (snapshot) => {
  const data = snapshot.val();
  const id = snapshot.key;
  if (!data) return;

  const geometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
  const material = new THREE.MeshStandardMaterial({ color: data.color || 0xffffff });
  const cube = new THREE.Mesh(geometry, material);
  cube.position.set(data.x, data.y, data.z);

  scene.add(cube);
  cubes[id] = cube;
});

// 👀 Listen for cubes removed
onChildRemoved(cubesRef, (snapshot) => {
  const id = snapshot.key;
  if (cubes[id]) {
    scene.remove(cubes[id]);
    delete cubes[id];
  }
});

// ✨ Clear button
document.getElementById('clearBtn').addEventListener('click', async () => {
  await remove(cubesRef);
  document.getElementById('status').textContent = 'Cleared all cubes';
});

// 🧱 Add cube when user taps/clicks
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

canvas.addEventListener('click', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pos = new THREE.Vector3();
  raycaster.ray.intersectPlane(plane, pos);

  const color = new THREE.Color(Math.random(), Math.random(), Math.random());
  push(cubesRef, {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    color: color.getHex()
  });
});

// 🔁 Render loop
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();

document.getElementById('status').textContent = 'Tap to place cubes';
