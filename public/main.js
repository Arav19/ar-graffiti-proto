import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.module.js';
import { ARButton } from './js/ARButton.js';

const db = window.firebaseDB;
const addDoc = window.firebaseAddDoc;
const collectionRef = window.firebaseCollection;
const onSnapshot = window.firebaseOnSnapshot;

let camera, scene, renderer;
let floorPlane, floorCanvas, floorTexture;
let isSpraying = false;
let raycaster = new THREE.Raycaster();
let pointer = new THREE.Vector2(0, 0); // center of screen

let hitTestSource = null;
let localReferenceSpace = null;

const strokesCol = collectionRef(db, 'strokes');

init();
animate();

function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.01, 20);

  renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  const arButton = ARButton.createButton(renderer, { requiredFeatures: ['hit-test'] });
  document.body.appendChild(arButton);

  // Floor canvas
  floorCanvas = document.createElement('canvas');
  floorCanvas.width = 1024;
  floorCanvas.height = 1024;
  const ctx = floorCanvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0,0,floorCanvas.width,floorCanvas.height);
  floorTexture = new THREE.CanvasTexture(floorCanvas);

  const geometry = new THREE.PlaneGeometry(5,5);
  const material = new THREE.MeshBasicMaterial({ map: floorTexture, side: THREE.DoubleSide });
  floorPlane = new THREE.Mesh(geometry, material);
  floorPlane.rotation.x = -Math.PI/2;
  scene.add(floorPlane);

  const sprayBtn = document.getElementById('sprayBtn');
  sprayBtn.addEventListener('pointerdown', ()=> isSpraying=true);
  sprayBtn.addEventListener('pointerup', ()=> isSpraying=false);

  window.addEventListener('resize', onWindowResize);

  // Firestore listener for other users
  onSnapshot(strokesCol, (snapshot)=>{
    snapshot.docChanges().forEach(change=>{
      if(change.type==='added'){
        drawOnCanvas(change.doc.data());
      }
    });
  });

  // AR hit-test setup
  renderer.xr.addEventListener('sessionstart', async ()=>{
    const session = renderer.xr.getSession();
    const viewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    localReferenceSpace = await session.requestReferenceSpace('local');
  });
}

function onWindowResize(){
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Draw locally and push to Firestore
function sprayDot(frame){
  if(!hitTestSource || !localReferenceSpace) return;

  raycaster.setFromCamera(pointer,camera);
  const intersects = raycaster.intersectObject(floorPlane);

  if(intersects.length>0){
    const point = intersects[0].point;
    const localPoint = floorPlane.worldToLocal(point.clone());
    const x = ((localPoint.x+2.5)/5)*floorCanvas.width;
    const y = ((-localPoint.z+2.5)/5)*floorCanvas.height;

    const stroke = {x,y,color:'#ff0000',size:5};
    drawOnCanvas(stroke);

    // Add to Firestore
    addDoc(strokesCol, stroke);
  }
}

function drawOnCanvas(stroke){
  const ctx = floorCanvas.getContext('2d');
  ctx.fillStyle = stroke.color;
  ctx.beginPath();
  ctx.arc(stroke.x, stroke.y, stroke.size,0,Math.PI*2);
  ctx.fill();
  floorTexture.needsUpdate = true;
}

// Update floor plane to AR hit-test
function updatePlaneWithHitTest(frame){
  if(!hitTestSource || !localReferenceSpace) return;
  const hitResults = frame.getHitTestResults(hitTestSource);
  if(hitResults.length>0){
    const hit = hitResults[0];
    const pose = hit.getPose(localReferenceSpace);
    floorPlane.position.set(pose.transform.position.x,pose.transform.position.y,pose.transform.position.z);
    floorPlane.quaternion.set(
      pose.transform.orientation.x,
      pose.transform.orientation.y,
      pose.transform.orientation.z,
      pose.transform.orientation.w
    );
  }
}

function animate(){
  renderer.setAnimationLoop((timestamp, frame)=>{
    if(isSpraying) sprayDot(frame);
    if(frame) updatePlaneWithHitTest(frame);
    renderer.render(scene,camera);
  });
}
