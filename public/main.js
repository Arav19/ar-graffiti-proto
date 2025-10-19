import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.module.js';
import { ARButton } from 'https://cdn.jsdelivr.net/npm/three@0.159.0/examples/jsm/webxr/ARButton.js';

let camera, scene, renderer;
let floorPlane, floorCanvas, floorTexture;
let isSpraying = false;
let raycaster = new THREE.Raycaster();
let pointer = new THREE.Vector2(0, 0); // center of screen

init();
animate();

function init() {
  // Scene & camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  // AR Button
  document.body.appendChild(ARButton.createButton(renderer, { requiredFeatures: ['hit-test'] }));

  // Floor canvas
  floorCanvas = document.createElement('canvas');
  floorCanvas.width = 1024;
  floorCanvas.height = 1024;
  const ctx = floorCanvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, floorCanvas.width, floorCanvas.height);

  floorTexture = new THREE.CanvasTexture(floorCanvas);

  const geometry = new THREE.PlaneGeometry(5, 5); // 5x5 meters
  const material = new THREE.MeshBasicMaterial({ map: floorTexture, side: THREE.DoubleSide });
  floorPlane = new THREE.Mesh(geometry, material);
  floorPlane.rotation.x = -Math.PI / 2;
  floorPlane.position.y = 0;
  scene.add(floorPlane);

  // Event listeners
  const sprayBtn = document.getElementById('sprayBtn');
  sprayBtn.addEventListener('pointerdown', () => isSpraying = true);
  sprayBtn.addEventListener('pointerup', () => isSpraying = false);

  window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Draw spray dot on floor canvas at raycast intersection
function sprayDot() {
  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObject(floorPlane);

  if (intersects.length > 0) {
    const point = intersects[0].point;

    // Convert 3D point to canvas coordinates
    const localPoint = floorPlane.worldToLocal(point.clone());
    const x = ((localPoint.x + 2.5) / 5) * floorCanvas.width; // plane size = 5
    const y = ((-localPoint.z + 2.5) / 5) * floorCanvas.height; // invert Z for canvas

    const ctx = floorCanvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    floorTexture.needsUpdate = true;
  }
}

function animate() {
  renderer.setAnimationLoop(render);
}

function render() {
  if (isSpraying) sprayDot();
  renderer.render(scene, camera);
}

import { io } from "https://cdn.socket.io/4.7.2/socket.io.esm.min.js";

const socket = io(); // connects to the same host automatically

function sprayDot() {
  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObject(floorPlane);

  if (intersects.length > 0) {
    const point = intersects[0].point;
    const localPoint = floorPlane.worldToLocal(point.clone());
    const x = ((localPoint.x + 2.5) / 5) * floorCanvas.width;
    const y = ((-localPoint.z + 2.5) / 5) * floorCanvas.height;

    // Draw locally
    const ctx = floorCanvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    floorTexture.needsUpdate = true;

    // Send to server
    socket.emit('drawStroke', { x, y, color: '#ff0000', size: 5 });
  }
}

// Listen for strokes from other users
socket.on('drawStroke', (stroke) => {
  const ctx = floorCanvas.getContext('2d');
  ctx.fillStyle = stroke.color;
  ctx.beginPath();
  ctx.arc(stroke.x, stroke.y, stroke.size, 0, Math.PI * 2);
  ctx.fill();
  floorTexture.needsUpdate = true;
});
