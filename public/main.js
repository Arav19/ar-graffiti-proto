// main.js - GPS AR Stickers with Absolute World Positioning

console.log("🚀 AR Stickers App Starting...");

// ===== SIMPLE NAVIGATION SYSTEM =====
function showPage(pageName) {
  console.log("Navigating to:", pageName);
  
  const homePage = document.getElementById("homePage");
  const drawPage = document.getElementById("drawPage");
  const arPage = document.getElementById("arPage");
  const mapPage = document.getElementById("mapPage");
  
  // Hide all pages
  [homePage, drawPage, arPage, mapPage].forEach(p => {
    if (p) p.classList.remove("active");
  });
  
  // Show selected page
  if (pageName === "home" && homePage) {
    homePage.classList.add("active");
  } else if (pageName === "draw" && drawPage) {
    drawPage.classList.add("active");
  } else if (pageName === "ar" && arPage) {
    arPage.classList.add("active");
    // Start AR when showing AR page
    setTimeout(() => enterARMode(false), 100);
  } else if (pageName === "map" && mapPage) {
    mapPage.classList.add("active");
    // Initialize map when shown
    setTimeout(() => initMap(), 100);
  }
}

// ===== FIREBASE CONFIG =====
const firebaseConfig = {
  apiKey: "AIzaSyBCzRpUX5mexhGj5FzqEWKoFAdljNJdbHE",
  authDomain: "surfaceless-firebase.firebaseapp.com",
  databaseURL: "https://surfaceless-firebase-default-rtdb.firebaseio.com",
  projectId: "surfaceless-firebase",
  storageBucket: "surfaceless-firebase.firebasestorage.app",
  messagingSenderId: "91893983357",
  appId: "1:91893983357:web:a823ba9f5874bede8b6914"
};

// Initialize Firebase
let db, stickersRef;
try {
  firebase.initializeApp(firebaseConfig);
  db = firebase.database();
  stickersRef = db.ref("stickers");
  console.log("Firebase initialized successfully");
} catch (error) {
  console.error("Firebase initialization failed:", error);
}

// ===== STATE VARIABLES =====
let userGPS = null;
let gpsWatchId = null;
let cameraStream = null;
let pendingStickerImage = null;
let leafletMap = null;
let mapMarkers = [];
let allStickerData = [];
let isPlacingSticker = false;

// ===== THREE.JS VARIABLES =====
let renderer, scene, camera;
const stickerMeshes = new Map();

// ===== DRAWING FUNCTIONALITY =====
function setupDrawing() {
  const drawCanvas = document.getElementById("drawCanvas");
  const colorPicker = document.getElementById("colorPicker");
  const sizeRange = document.getElementById("sizeRange");
  
  if (!drawCanvas || !colorPicker || !sizeRange) {
    console.error("Drawing elements not found");
    return;
  }
  
  const drawCtx = drawCanvas.getContext("2d");
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  
  let isDrawing = false;

  function getDrawPos(e) {
    const rect = drawCanvas.getBoundingClientRect();
    const x = (e.clientX || e.touches?.[0]?.clientX) - rect.left;
    const y = (e.clientY || e.touches?.[0]?.clientY) - rect.top;
    return {
      x: x * (drawCanvas.width / rect.width),
      y: y * (drawCanvas.height / rect.height)
    };
  }

  drawCanvas.addEventListener("pointerdown", (e) => {
    isDrawing = true;
    drawCtx.strokeStyle = colorPicker.value;
    drawCtx.lineWidth = parseInt(sizeRange.value);
    drawCtx.lineCap = "round";
    drawCtx.lineJoin = "round";
    const pos = getDrawPos(e);
    drawCtx.beginPath();
    drawCtx.moveTo(pos.x, pos.y);
  });

  drawCanvas.addEventListener("pointermove", (e) => {
    if (!isDrawing) return;
    const pos = getDrawPos(e);
    drawCtx.lineTo(pos.x, pos.y);
    drawCtx.stroke();
  });

  drawCanvas.addEventListener("pointerup", () => isDrawing = false);
  drawCanvas.addEventListener("pointerleave", () => isDrawing = false);
}

// ===== GPS UTILITIES =====
const EARTH_RADIUS = 6378137;
const WORLD_ORIGIN = { lat: 40.758896, lon: -73.985130 };

function gpsToAbsoluteWorldPosition(lat, lon) {
  const earthRadius = 6378137;
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const originLatRad = WORLD_ORIGIN.lat * Math.PI / 180;
  const originLonRad = WORLD_ORIGIN.lon * Math.PI / 180;
  
  const dLat = latRad - originLatRad;
  const dLon = lonRad - originLonRad;
  
  const x = dLon * earthRadius * Math.cos(originLatRad);
  const z = -dLat * earthRadius;
  
  return { x, z };
}

function getCurrentGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error("Geolocation not available"));
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      reject,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  });
}

function startGPSWatch() {
  if (!navigator.geolocation || gpsWatchId) return;
  
  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      userGPS = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        alt: pos.coords.altitude || 0,
        accuracy: pos.coords.accuracy
      };
      
      // Update camera position if in AR mode
      if (camera && document.getElementById("arPage").classList.contains("active")) {
        const worldPos = gpsToAbsoluteWorldPosition(userGPS.lat, userGPS.lon);
        camera.position.x = worldPos.x;
        camera.position.z = worldPos.z;
        camera.position.y = 1.6;
        
        console.log(`GPS Updated: Camera at world (${worldPos.x.toFixed(1)}, ${worldPos.z.toFixed(1)})`);
      }
    },
    (err) => console.warn("GPS watch error:", err),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
}

function stopGPSWatch() {
  if (gpsWatchId) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

// ===== THREE.JS SETUP =====
function initThreeJS() {
  const threeCanvas = document.getElementById("three-canvas");
  if (!threeCanvas) {
    console.error("Three.js canvas not found");
    return false;
  }
  
  try {
    // Create renderer
    renderer = new THREE.WebGLRenderer({
      canvas: threeCanvas,
      antialias: true,
      alpha: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    
    // Create scene
    scene = new THREE.Scene();
    scene.background = null;

    // Create camera
    camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    camera.position.set(0, 1.6, 0);

    // Add light
    const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    scene.add(light);

    console.log("Three.js initialized successfully");
    return true;
  } catch (error) {
    console.error("Three.js initialization failed:", error);
    return false;
  }
}

// ===== STICKER CREATION =====
function createStickerMesh(base64Image, sizeMeters = 1.0) {
  return new Promise((resolve, reject) => {
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      base64Image,
      (texture) => {
        const geometry = new THREE.PlaneGeometry(sizeMeters, sizeMeters);
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          opacity: 0.9
        });
        
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = 0;
        mesh.position.y = 0.5;
        mesh.matrixAutoUpdate = false;
        
        console.log("Sticker mesh created successfully");
        resolve(mesh);
      },
      undefined,
      (error) => {
        console.error("Error loading sticker texture:", error);
        reject(error);
      }
    );
  });
}

// ===== STICKER BILLBOARDING =====
function updateStickerBillboarding() {
  if (!camera) return;
  
  stickerMeshes.forEach((entry) => {
    const { mesh } = entry;
    
    // Make sticker face camera while keeping it upright
    const tempMatrix = new THREE.Matrix4();
    tempMatrix.lookAt(mesh.position, camera.position, mesh.up);
    const targetQuaternion = new THREE.Quaternion();
    targetQuaternion.setFromRotationMatrix(tempMatrix);
    
    // Only rotate around Y axis to keep sticker upright
    const euler = new THREE.Euler();
    euler.setFromQuaternion(targetQuaternion);
    euler.x = 0;
    euler.z = 0;
    mesh.quaternion.setFromEuler(euler);
    
    // Update the locked matrix
    mesh.updateMatrix();
  });
}

// ===== UPDATE STICKER VISIBILITY =====
function updateStickerVisibility() {
  if (!userGPS || !camera) return;
  
  let nearbyCount = 0;
  
  stickerMeshes.forEach((entry, id) => {
    const { mesh } = entry;
    
    // Calculate distance from camera to sticker in WORLD SPACE
    const dx = mesh.position.x - camera.position.x;
    const dz = mesh.position.z - camera.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    // Show only within 50m
    const isVisible = distance < 50;
    mesh.visible = isVisible;
    
    if (isVisible) nearbyCount++;
  });
  
  const stickerCount = document.getElementById("stickerCount");
  if (stickerCount) {
    stickerCount.textContent = nearbyCount.toString();
  }
}

// ===== RENDER LOOP =====
let isRendering = false;

function startRendering() {
  if (isRendering) return;
  isRendering = true;
  
  function animate() {
    if (!isRendering) return;
    requestAnimationFrame(animate);
    
    updateStickerVisibility();
    updateStickerBillboarding();
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }
  
  animate();
  console.log("Rendering started");
}

function stopRendering() {
  isRendering = false;
  console.log("Rendering stopped");
}

// ===== CAMERA STREAM =====
async function startCamera() {
  try {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
    }
    
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { 
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    
    const arVideo = document.getElementById("arVideo");
    arVideo.srcObject = cameraStream;
    
    // Wait for video to be ready
    return new Promise((resolve) => {
      arVideo.onloadedmetadata = () => {
        arVideo.play().then(() => {
          console.log("Camera started successfully");
          resolve(true);
        }).catch(err => {
          console.error("Video play failed:", err);
          resolve(false);
        });
      };
    });
    
  } catch (e) {
    console.error("Camera error:", e);
    const arStatus = document.getElementById("arStatus");
    if (arStatus) {
      arStatus.textContent = "Camera permission required";
    }
    return false;
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  const arVideo = document.getElementById("arVideo");
  if (arVideo) {
    arVideo.srcObject = null;
  }
}

// ===== AR MODE FUNCTIONS =====
async function enterARMode(placingSticker = false) {
  console.log("Entering AR mode... placingSticker:", placingSticker);
  const arStatus = document.getElementById("arStatus");
  if (arStatus) {
    arStatus.textContent = "Starting camera...";
  }

  // Set placing mode
  isPlacingSticker = placingSticker;

  // Initialize Three.js if not already done
  if (!renderer) {
    if (!initThreeJS()) {
      if (arStatus) arStatus.textContent = "3D engine failed to start";
      return;
    }
  }

  // Start camera
  const cameraOk = await startCamera();
  if (!cameraOk) {
    if (arStatus) arStatus.textContent = "Camera failed to start";
    return;
  }

  // Get GPS
  try {
    if (arStatus) arStatus.textContent = "Getting GPS...";
    const coords = await getCurrentGPS();
    userGPS = {
      lat: coords.latitude,
      lon: coords.longitude,
      alt: coords.altitude || 0,
      accuracy: coords.accuracy
    };

    // Set camera position based on GPS
    const worldPos = gpsToAbsoluteWorldPosition(userGPS.lat, userGPS.lon);
    camera.position.x = worldPos.x;
    camera.position.z = worldPos.z;
    camera.position.y = 1.6;

    if (arStatus) {
      arStatus.textContent = `GPS locked! Position: ${userGPS.lat.toFixed(4)}, ${userGPS.lon.toFixed(4)}`;
    }
    console.log("Camera positioned at world coordinates:", worldPos);

  } catch (e) {
    console.error("GPS error:", e);
    if (arStatus) arStatus.textContent = "GPS required for AR";
    return;
  }

  // Start GPS tracking and rendering
  startGPSWatch();
  startRendering();

  // Show/hide place sticker button
  const placeStickerBtn = document.getElementById("placeStickerBtn");
  if (placeStickerBtn) {
    if (isPlacingSticker && pendingStickerImage) {
      placeStickerBtn.style.display = "";
      if (arStatus) arStatus.textContent = "Ready to place sticker! Look around and tap Place when ready.";
    } else {
      placeStickerBtn.style.display = "none";
      if (arStatus) arStatus.textContent = "AR mode active. Look around to see stickers!";
    }
  }

  // Load existing stickers
  loadStickers();
}

function exitARMode() {
  console.log("Exiting AR mode");
  
  // Stop camera
  stopCamera();
  
  // Stop GPS and rendering
  stopGPSWatch();
  stopRendering();
  
  // Clear pending sticker
  pendingStickerImage = null;
  isPlacingSticker = false;
  
  // Return to home
  showPage("home");
}

// ===== STICKER MANAGEMENT =====
async function loadStickers() {
  if (!stickersRef) {
    console.error("Firebase not initialized");
    return;
  }
  
  try {
    console.log("Loading stickers from Firebase...");
    const snapshot = await stickersRef.once('value');
    const data = snapshot.val();
    
    if (data) {
      console.log("Found stickers data:", data);
      allStickerData = Object.entries(data).map(([id, val]) => ({ id, ...val }));
      
      // Create meshes for each sticker
      for (const sticker of allStickerData) {
        if (sticker.image && sticker.lat && sticker.lon && !stickerMeshes.has(sticker.id)) {
          console.log("Creating sticker mesh for:", sticker.id);
          try {
            const mesh = await createStickerMesh(sticker.image, 1.0);
            const worldPos = gpsToAbsoluteWorldPosition(sticker.lat, sticker.lon);
            
            mesh.position.x = worldPos.x;
            mesh.position.z = worldPos.z;
            mesh.position.y = 0.5;
            mesh.updateMatrix();
            
            scene.add(mesh);
            stickerMeshes.set(sticker.id, { mesh, data: sticker });
            
            console.log(`✅ Loaded sticker at world position: (${worldPos.x.toFixed(1)}, ${worldPos.z.toFixed(1)})`);
          } catch (error) {
            console.error(`Failed to create sticker mesh for ${sticker.id}:`, error);
          }
        }
      }
      
      const stickerCount = document.getElementById("stickerCount");
      const arStatus = document.getElementById("arStatus");
      if (stickerCount) stickerCount.textContent = allStickerData.length;
      if (arStatus) arStatus.textContent = `Loaded ${allStickerData.length} stickers! Look around to see them.`;
      
      console.log(`✅ Total stickers loaded: ${allStickerData.length}`);
    } else {
      console.log("No stickers found in database");
      const arStatus = document.getElementById("arStatus");
      if (arStatus) arStatus.textContent = "No stickers found. Be the first to place one!";
    }
  } catch (error) {
    console.error("Error loading stickers:", error);
    const arStatus = document.getElementById("arStatus");
    if (arStatus) arStatus.textContent = "Error loading stickers";
  }
}

async function placeSticker() {
  if (!pendingStickerImage || !userGPS) {
    alert("No sticker image or GPS available");
    return;
  }

  if (!stickersRef) {
    alert("Database not available");
    return;
  }

  try {
    const stickerData = {
      image: pendingStickerImage,
      lat: userGPS.lat,
      lon: userGPS.lon,
      alt: userGPS.alt,
      accuracy: userGPS.accuracy,
      owner: getUniqueUserId(),
      createdAt: Date.now()
    };
    
    console.log("Placing sticker at:", userGPS.lat, userGPS.lon);
    await stickersRef.push(stickerData);
    
    const arStatus = document.getElementById("arStatus");
    const placeStickerBtn = document.getElementById("placeStickerBtn");
    if (arStatus) arStatus.textContent = "Sticker placed successfully!";
    if (placeStickerBtn) placeStickerBtn.style.display = "none";
    pendingStickerImage = null;
    isPlacingSticker = false;
    
    // Clear drawing
    const drawCanvas = document.getElementById("drawCanvas");
    if (drawCanvas) {
      const drawCtx = drawCanvas.getContext("2d");
      drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    }
    
  } catch (error) {
    console.error("Error placing sticker:", error);
    const arStatus = document.getElementById("arStatus");
    if (arStatus) arStatus.textContent = "Failed to place sticker";
  }
}

function getUniqueUserId() {
  let uid = localStorage.getItem("ar_stickers_uid");
  if (!uid) {
    uid = "user_" + Date.now().toString(36) + "_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("ar_stickers_uid", uid);
  }
  return uid;
}

// ===== MAP FUNCTIONALITY =====
function initMap() {
  console.log("Initializing map...");
  const mapElement = document.getElementById('map');
  if (!mapElement) {
    console.error("Map element not found");
    return;
  }
  
  try {
    // Create map centered on user location or default
    const center = userGPS ? [userGPS.lat, userGPS.lon] : [40.7589, -73.9851];
    leafletMap = L.map('map').setView(center, 15);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19
    }).addTo(leafletMap);
    
    // Add user marker if GPS available
    if (userGPS) {
      L.marker([userGPS.lat, userGPS.lon]).addTo(leafletMap)
        .bindPopup('Your Location')
        .openPopup();
    }
    
    // Add sticker markers
    updateMapMarkers();
    
    console.log("Map initialized successfully");
  } catch (error) {
    console.error("Map initialization failed:", error);
  }
}

function updateMapMarkers() {
  if (!leafletMap) return;
  
  // Clear existing markers
  mapMarkers.forEach(m => leafletMap.removeLayer(m));
  mapMarkers = [];
  
  // Add markers for each sticker
  allStickerData.forEach((data) => {
    if (!data.lat || !data.lon) return;
    
    const marker = L.marker([data.lat, data.lon]).addTo(leafletMap);
    
    if (data.image) {
      marker.bindPopup(`<img src="${data.image}" style="width:100px;height:100px;object-fit:contain;"/>`);
    }
    
    mapMarkers.push(marker);
  });
}

// ===== BUTTON EVENT LISTENERS =====
function setupEventListeners() {
  const createStickerBtn = document.getElementById("createStickerBtn");
  const exploreBtn = document.getElementById("exploreBtn");
  const mapBtn = document.getElementById("mapBtn");
  const saveStickerBtn = document.getElementById("saveStickerBtn");
  const placeStickerBtn = document.getElementById("placeStickerBtn");
  const exitArBtn = document.getElementById("exitArBtn");
  const backToHomeBtn = document.getElementById("backToHomeBtn");
  const backFromMapBtn = document.getElementById("backFromMapBtn");
  const clearDrawBtn = document.getElementById("clearDrawBtn");

  if (createStickerBtn) {
    createStickerBtn.addEventListener("click", () => {
      console.log("Create Sticker clicked");
      showPage("draw");
    });
  }

  if (exploreBtn) {
    exploreBtn.addEventListener("click", () => {
      console.log("Explore clicked");
      showPage("ar");
    });
  }

  if (mapBtn) {
    mapBtn.addEventListener("click", () => {
      console.log("Map clicked");
      showPage("map");
    });
  }

  if (saveStickerBtn) {
    saveStickerBtn.addEventListener("click", () => {
      console.log("Save Sticker clicked");
      const drawCanvas = document.getElementById("drawCanvas");
      if (drawCanvas) {
        pendingStickerImage = drawCanvas.toDataURL("image/png");
        console.log("Sticker image saved, entering AR placement mode");
        enterARMode(true); // This should show the place sticker button
      }
    });
  }

  if (placeStickerBtn) {
    placeStickerBtn.addEventListener("click", () => {
      console.log("Place Sticker clicked");
      placeSticker();
    });
  }

  if (exitArBtn) {
    exitArBtn.addEventListener("click", () => {
      console.log("Exit AR clicked");
      exitARMode();
    });
  }

  if (backToHomeBtn) {
    backToHomeBtn.addEventListener("click", () => {
      console.log("Back to Home clicked");
      showPage("home");
    });
  }

  if (backFromMapBtn) {
    backFromMapBtn.addEventListener("click", () => {
      console.log("Back from Map clicked");
      showPage("home");
    });
  }

  if (clearDrawBtn) {
    clearDrawBtn.addEventListener("click", () => {
      console.log("Clear drawing");
      const drawCanvas = document.getElementById("drawCanvas");
      if (drawCanvas) {
        const drawCtx = drawCanvas.getContext("2d");
        drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      }
    });
  }
}

// ===== WINDOW RESIZE HANDLER =====
window.addEventListener("resize", () => {
  if (renderer && camera) {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
});

// ===== FIREBASE LISTENERS =====
if (stickersRef) {
  stickersRef.on('child_added', async (snap) => {
    const id = snap.key;
    const data = snap.val();
    
    if (stickerMeshes.has(id)) return;
    if (!data.image || !data.lat || !data.lon) return;
    
    try {
      console.log("New sticker added to Firebase, creating mesh...");
      const mesh = await createStickerMesh(data.image, 1.0);
      const worldPos = gpsToAbsoluteWorldPosition(data.lat, data.lon);
      
      mesh.position.x = worldPos.x;
      mesh.position.z = worldPos.z;
      mesh.position.y = 0.5;
      mesh.updateMatrix();
      
      if (scene) scene.add(mesh);
      stickerMeshes.set(id, { mesh, data });
      allStickerData.push({ id, ...data });
      
      console.log(`✅ New sticker placed at world position: (${worldPos.x.toFixed(1)}, ${worldPos.z.toFixed(1)})`);
      
      updateMapMarkers();
      
      // Update sticker count
      const stickerCount = document.getElementById("stickerCount");
      if (stickerCount) stickerCount.textContent = allStickerData.length;
    } catch (error) {
      console.error("Failed to create sticker mesh:", error);
    }
  });

  stickersRef.on('child_removed', (snap) => {
    const id = snap.key;
    const entry = stickerMeshes.get(id);
    
    if (entry) {
      if (scene) scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.map?.dispose();
      entry.mesh.material.dispose();
      stickerMeshes.delete(id);
    }
    
    allStickerData = allStickerData.filter(s => s.id !== id);
    updateMapMarkers();
    
    // Update sticker count
    const stickerCount = document.getElementById("stickerCount");
    if (stickerCount) stickerCount.textContent = allStickerData.length;
  });
}

// ===== INITIALIZE APP =====
function initApp() {
  console.log("Initializing AR Stickers App...");
  
  // Setup event listeners
  setupEventListeners();
  setupDrawing();
  
  console.log("✅ AR Stickers App Fully Loaded!");
  console.log("All buttons should now work:");
  console.log("- Create Sticker → Draw page");
  console.log("- Explore Stickers → AR mode");
  console.log("- View Map → Map page");
  console.log("- Save & Place → Creates sticker and enters AR placement mode");
}

// Start the app when the page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}