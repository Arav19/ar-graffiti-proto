// main.js - GPS AR Stickers - COMPLETE FIXED VERSION

console.log("🚀 AR Stickers App Starting...");

// ===== SIMPLE NAVIGATION SYSTEM =====
function showPage(pageName) {
    console.log("🔄 Navigating to:", pageName);
    
    // Get all pages
    const pages = {
        home: document.getElementById("homePage"),
        draw: document.getElementById("drawPage"), 
        ar: document.getElementById("arPage"),
        map: document.getElementById("mapPage")
    };
    
    // Hide all pages
    Object.values(pages).forEach(page => {
        if (page) page.classList.remove("active");
    });
    
    // Show requested page
    if (pages[pageName]) {
        pages[pageName].classList.add("active");
        console.log("✅ Page shown:", pageName);
        
        // Handle page-specific initialization
        if (pageName === 'ar') {
            setTimeout(() => initializeARMode(), 100);
        } else if (pageName === 'map') {
            setTimeout(() => initializeMap(), 100);
        }
    } else {
        console.error("❌ Page not found:", pageName);
    }
}

// ===== FIREBASE SETUP =====
const firebaseConfig = {
    apiKey: "AIzaSyBCzRpUX5mexhGj5FzqEWKoFAdljNJdbHE",
    authDomain: "surfaceless-firebase.firebaseapp.com",
    databaseURL: "https://surfaceless-firebase-default-rtdb.firebaseio.com",
    projectId: "surfaceless-firebase",
    storageBucket: "surfaceless-firebase.firebasestorage.app",
    messagingSenderId: "91893983357",
    appId: "1:91893983357:web:a823ba9f5874bede8b6914"
};

let db, stickersRef;
try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    stickersRef = db.ref("stickers");
    console.log("✅ Firebase initialized");
} catch (error) {
    console.error("❌ Firebase init failed:", error);
}

// ===== GLOBAL STATE =====
let userGPS = null;
let cameraStream = null;
let pendingStickerImage = null;
let leafletMap = null;
let mapMarkers = [];

// Three.js variables
let renderer, scene, camera;
const stickerMeshes = new Map();
let allStickerData = [];

// ===== DRAWING SYSTEM =====
function initializeDrawing() {
    console.log("🎨 Initializing drawing system...");
    
    const canvas = document.getElementById("drawCanvas");
    const ctx = canvas.getContext("2d");
    const colorPicker = document.getElementById("colorPicker");
    const sizeRange = document.getElementById("sizeRange");
    
    if (!canvas || !ctx) {
        console.error("❌ Drawing canvas not found");
        return;
    }
    
    // Clear canvas with white background
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    let isDrawing = false;
    let lastX = 0;
    let lastY = 0;
    
    function getPosition(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }
    
    function startDrawing(e) {
        isDrawing = true;
        const pos = getPosition(e);
        [lastX, lastY] = [pos.x, pos.y];
    }
    
    function draw(e) {
        if (!isDrawing) return;
        
        const pos = getPosition(e);
        ctx.strokeStyle = colorPicker.value;
        ctx.lineWidth = sizeRange.value;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
        
        [lastX, lastY] = [pos.x, pos.y];
    }
    
    function stopDrawing() {
        isDrawing = false;
    }
    
    // Mouse events
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseout', stopDrawing);
    
    // Touch events
    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startDrawing(e.touches[0]);
    });
    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        draw(e.touches[0]);
    });
    canvas.addEventListener('touchend', stopDrawing);
    
    console.log("✅ Drawing system ready");
}

// ===== GPS UTILITIES =====
const WORLD_ORIGIN = { lat: 40.758896, lon: -73.985130 };
const MAX_STICKER_DISTANCE = 100; // meters - only show stickers within 100m

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function gpsToWorldPosition(lat, lon) {
    const earthRadius = 6378137; // meters
    const dLat = (lat - WORLD_ORIGIN.lat) * Math.PI / 180;
    const dLon = (lon - WORLD_ORIGIN.lon) * Math.PI / 180;
    
    const x = dLon * earthRadius * Math.cos(WORLD_ORIGIN.lat * Math.PI / 180);
    const z = -dLat * earthRadius; // North is negative Z
    
    return { x, z };
}

function getCurrentLocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error("Geolocation not supported"));
            return;
        }
        
        navigator.geolocation.getCurrentPosition(
            position => resolve(position.coords),
            error => reject(error),
            { 
                enableHighAccuracy: true, 
                timeout: 10000, 
                maximumAge: 60000 
            }
        );
    });
}

// ===== THREE.JS SYSTEM =====
function initializeThreeJS() {
    console.log("🎮 Initializing Three.js...");
    
    const canvas = document.getElementById("three-canvas");
    if (!canvas) {
        console.error("❌ Three.js canvas not found");
        return false;
    }
    
    try {
        // Renderer - transparent for AR overlay
        renderer = new THREE.WebGLRenderer({ 
            canvas: canvas, 
            alpha: true, 
            antialias: true,
            premultipliedAlpha: false
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setClearColor(0x000000, 0); // Transparent background
        
        // Scene
        scene = new THREE.Scene();
        
        // Camera
        camera = new THREE.PerspectiveCamera(
            60, // Wide FOV for AR
            window.innerWidth / window.innerHeight, 
            0.1, 
            1000
        );
        camera.position.set(0, 1.6, 0);
        
        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
        scene.add(ambientLight);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
        directionalLight.position.set(1, 1, 1);
        scene.add(directionalLight);
        
        console.log("✅ Three.js initialized");
        return true;
    } catch (error) {
        console.error("❌ Three.js init failed:", error);
        return false;
    }
}

function createStickerMesh(imageData, size = 3.0) {
    return new Promise((resolve, reject) => {
        const textureLoader = new THREE.TextureLoader();
        textureLoader.load(imageData, 
            (texture) => {
                console.log("✅ Texture loaded successfully");
                
                const geometry = new THREE.PlaneGeometry(size, size);
                const material = new THREE.MeshBasicMaterial({
                    map: texture,
                    transparent: true,
                    side: THREE.DoubleSide,
                    opacity: 0.95,
                    depthTest: false, // Critical for AR overlay
                    depthWrite: false // Critical for AR overlay
                });
                
                const mesh = new THREE.Mesh(geometry, material);
                
                // Make sticker vertical and face camera
                mesh.rotation.x = 0; // Vertical, not flat
                mesh.position.y = 1.5; // Eye level height
                
                console.log("✅ Sticker mesh created");
                resolve(mesh);
            },
            undefined,
            (error) => {
                console.error("❌ Texture loading failed:", error);
                reject(error);
            }
        );
    });
}

function updateStickerBillboarding() {
    if (!camera) return;
    
    stickerMeshes.forEach(({ mesh }) => {
        // Make sticker always face camera (billboard effect)
        mesh.lookAt(camera.position);
        
        // Keep it upright - only rotate around Y axis
        mesh.rotation.x = 0;
        mesh.rotation.z = 0;
    });
}

function updateStickerVisibility() {
    if (!userGPS || !camera) return;
    
    let nearbyCount = 0;
    
    stickerMeshes.forEach(({ mesh, data }) => {
        // Calculate distance from user to sticker
        const distance = calculateDistance(
            userGPS.lat, userGPS.lon,
            data.lat, data.lon
        );
        
        // Only show stickers within 100 meters
        const isNearby = distance <= MAX_STICKER_DISTANCE;
        mesh.visible = isNearby;
        
        if (isNearby) {
            nearbyCount++;
        }
    });
    
    // Update nearby sticker count
    const stickerCount = document.getElementById("stickerCount");
    if (stickerCount) {
        stickerCount.textContent = nearbyCount.toString();
    }
    
    return nearbyCount;
}

// ===== AR SYSTEM =====
async function initializeARMode() {
    console.log("📱 Initializing AR Mode...");
    
    const arStatus = document.getElementById("arStatus");
    if (arStatus) arStatus.textContent = "Starting camera...";
    
    // Initialize Three.js if needed
    if (!renderer && !initializeThreeJS()) {
        if (arStatus) arStatus.textContent = "3D engine failed";
        return;
    }
    
    // Clear existing stickers first
    stickerMeshes.forEach(({ mesh }) => {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
    });
    stickerMeshes.clear();
    allStickerData = [];
    
    // Start camera
    try {
        if (cameraStream) {
            cameraStream.getTracks().forEach(track => track.stop());
        }
        
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { 
                facingMode: 'environment',
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        
        const arVideo = document.getElementById("arVideo");
        arVideo.srcObject = cameraStream;
        
        await new Promise((resolve) => {
            arVideo.onloadedmetadata = () => {
                arVideo.play().then(resolve).catch(console.error);
            };
        });
        
        console.log("✅ Camera started");
        if (arStatus) arStatus.textContent = "Camera ready. Getting location...";
    } catch (error) {
        console.error("❌ Camera failed:", error);
        if (arStatus) arStatus.textContent = "Camera access denied";
        return;
    }
    
    // Get location
    try {
        const coords = await getCurrentLocation();
        userGPS = {
            lat: coords.latitude,
            lon: coords.longitude,
            accuracy: coords.accuracy
        };
        
        // Position camera in world space
        const worldPos = gpsToWorldPosition(userGPS.lat, userGPS.lon);
        camera.position.set(worldPos.x, 1.6, worldPos.z);
        
        console.log("📍 Location acquired:", userGPS);
        console.log("🎯 Camera world position:", camera.position);
        if (arStatus) arStatus.textContent = `Location ready! Accuracy: ${Math.round(userGPS.accuracy)}m`;
        
    } catch (error) {
        console.error("❌ Location failed:", error);
        if (arStatus) arStatus.textContent = "Location access denied";
        // Continue anyway with demo location
        userGPS = { lat: 40.7589, lon: -73.9851, accuracy: 100 };
        const worldPos = gpsToWorldPosition(userGPS.lat, userGPS.lon);
        camera.position.set(worldPos.x, 1.6, worldPos.z);
    }
    
    // Load stickers
    await loadStickers();
    
    // Start rendering
    startRendering();
    
    // Show place sticker button if we have a pending sticker
    const placeBtn = document.getElementById("placeStickerBtn");
    if (placeBtn && pendingStickerImage) {
        placeBtn.style.display = "block";
        if (arStatus) arStatus.textContent = "Tap 'Place Here' to place your sticker!";
    }
    
    console.log("✅ AR Mode ready");
}

function startRendering() {
    function animate() {
        requestAnimationFrame(animate);
        
        if (renderer && scene && camera) {
            updateStickerBillboarding();
            updateStickerVisibility();
            renderer.render(scene, camera);
        }
    }
    animate();
    console.log("🔄 Rendering started");
}

function exitARMode() {
    console.log("👋 Exiting AR Mode");
    
    // Stop camera
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
    
    const arVideo = document.getElementById("arVideo");
    if (arVideo) arVideo.srcObject = null;
    
    // Hide place sticker button
    const placeBtn = document.getElementById("placeStickerBtn");
    if (placeBtn) placeBtn.style.display = "none";
    
    // Clear pending sticker if we're exiting
    pendingStickerImage = null;
    
    showPage("home");
}

// ===== STICKER MANAGEMENT =====
async function loadStickers() {
    console.log("📦 Loading stickers...");
    
    if (!stickersRef) {
        console.error("❌ Firebase not available");
        return;
    }
    
    try {
        const snapshot = await stickersRef.once('value');
        const data = snapshot.val();
        
        if (!data) {
            console.log("ℹ️ No stickers found in database");
            const arStatus = document.getElementById("arStatus");
            if (arStatus) arStatus.textContent = "No stickers found. Be the first to place one!";
            return;
        }
        
        allStickerData = Object.entries(data).map(([id, sticker]) => ({
            id,
            ...sticker
        }));
        
        console.log(`📊 Found ${allStickerData.length} total stickers in database`);
        
        // Filter stickers by distance BEFORE creating meshes
        let nearbyStickers = [];
        if (userGPS) {
            nearbyStickers = allStickerData.filter(sticker => {
                const distance = calculateDistance(
                    userGPS.lat, userGPS.lon,
                    sticker.lat, sticker.lon
                );
                return distance <= MAX_STICKER_DISTANCE;
            });
            console.log(`📍 ${nearbyStickers.length} stickers within ${MAX_STICKER_DISTANCE}m`);
        } else {
            nearbyStickers = allStickerData; // Show all if no GPS
        }
        
        // Create Three.js meshes only for nearby stickers
        let loadedCount = 0;
        for (const sticker of nearbyStickers) {
            if (sticker.image && sticker.lat && sticker.lon) {
                try {
                    console.log(`🔄 Creating mesh for nearby sticker at (${sticker.lat.toFixed(4)}, ${sticker.lon.toFixed(4)})`);
                    
                    const mesh = await createStickerMesh(sticker.image, 3.0);
                    const worldPos = gpsToWorldPosition(sticker.lat, sticker.lon);
                    
                    // Position in world space
                    mesh.position.set(worldPos.x, 1.5, worldPos.z);
                    
                    // Add to scene
                    scene.add(mesh);
                    
                    // Store reference
                    stickerMeshes.set(sticker.id, { mesh, data: sticker });
                    
                    loadedCount++;
                    console.log(`✅ Loaded nearby sticker ${loadedCount}/${nearbyStickers.length}`);
                    
                } catch (error) {
                    console.error(`❌ Failed to load sticker ${sticker.id}:`, error);
                }
            }
        }
        
        // Update UI with accurate counts
        const stickerCount = document.getElementById("stickerCount");
        if (stickerCount) {
            stickerCount.textContent = loadedCount.toString();
        }
        
        const arStatus = document.getElementById("arStatus");
        if (arStatus && !arStatus.textContent.includes("Place")) {
            arStatus.textContent = `Found ${loadedCount} stickers nearby! Look around.`;
        }
        
        console.log(`🎉 Successfully loaded ${loadedCount} nearby stickers`);
        
        // DEBUG: Log positions and distances
        if (camera && loadedCount > 0 && userGPS) {
            console.log("🎯 Your position:", userGPS.lat, userGPS.lon);
            stickerMeshes.forEach(({ mesh, data }, id) => {
                const distance = calculateDistance(userGPS.lat, userGPS.lon, data.lat, data.lon);
                console.log(`📍 Sticker ${id} at ${distance.toFixed(1)}m - World:`, mesh.position);
            });
        }
        
    } catch (error) {
        console.error("❌ Error loading stickers:", error);
    }
}

async function placeSticker() {
    console.log("📍 Placing sticker...");
    
    if (!pendingStickerImage || !userGPS || !stickersRef) {
        alert("Cannot place sticker - missing data");
        return;
    }
    
    const arStatus = document.getElementById("arStatus");
    const placeBtn = document.getElementById("placeStickerBtn");
    
    try {
        if (arStatus) arStatus.textContent = "Placing sticker...";
        if (placeBtn) placeBtn.disabled = true;
        
        const stickerData = {
            image: pendingStickerImage,
            lat: userGPS.lat,
            lon: userGPS.lon,
            accuracy: userGPS.accuracy,
            owner: getUserId(),
            createdAt: Date.now()
        };
        
        console.log("📤 Saving sticker to Firebase...");
        await stickersRef.push(stickerData);
        
        if (arStatus) arStatus.textContent = "✅ Sticker placed!";
        if (placeBtn) {
            placeBtn.style.display = "none";
            placeBtn.disabled = false;
        }
        
        // Clear the drawing
        const canvas = document.getElementById("drawCanvas");
        if (canvas) {
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        
        pendingStickerImage = null;
        
        console.log("✅ Sticker placed successfully");
        
    } catch (error) {
        console.error("❌ Failed to place sticker:", error);
        if (arStatus) arStatus.textContent = "Failed to place sticker";
        if (placeBtn) placeBtn.disabled = false;
    }
}

function getUserId() {
    let userId = localStorage.getItem('arStickersUserId');
    if (!userId) {
        userId = 'user_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('arStickersUserId', userId);
    }
    return userId;
}

// ===== MAP SYSTEM =====
function initializeMap() {
    console.log("🗺️ Initializing map...");
    
    const mapElement = document.getElementById('map');
    if (!mapElement) {
        console.error("❌ Map element not found");
        return;
    }
    
    try {
        // Create map centered on user or default location
        const center = userGPS ? [userGPS.lat, userGPS.lon] : [40.7589, -73.9851];
        leafletMap = L.map('map').setView(center, 16);
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap',
            maxZoom: 19
        }).addTo(leafletMap);
        
        // Add user marker
        if (userGPS) {
            L.marker([userGPS.lat, userGPS.lon])
                .addTo(leafletMap)
                .bindPopup('You are here')
                .openPopup();
            
            // Add circle showing 100m radius
            L.circle([userGPS.lat, userGPS.lon], {
                color: 'blue',
                fillColor: '#30f',
                fillOpacity: 0.1,
                radius: MAX_STICKER_DISTANCE
            }).addTo(leafletMap).bindPopup('100m visibility radius');
        }
        
        // Add sticker markers
        updateMapMarkers();
        
        console.log("✅ Map initialized");
    } catch (error) {
        console.error("❌ Map initialization failed:", error);
    }
}

function updateMapMarkers() {
    if (!leafletMap) return;
    
    // Clear existing markers
    mapMarkers.forEach(marker => leafletMap.removeLayer(marker));
    mapMarkers = [];
    
    // Add markers for stickers
    allStickerData.forEach(sticker => {
        if (sticker.lat && sticker.lon) {
            const distance = userGPS ? calculateDistance(userGPS.lat, userGPS.lon, sticker.lat, sticker.lon) : 0;
            const isNearby = distance <= MAX_STICKER_DISTANCE;
            
            const marker = L.marker([sticker.lat, sticker.lon]).addTo(leafletMap);
            
            let popupContent = `<div style="text-align: center;">`;
            if (sticker.image) {
                popupContent += `<img src="${sticker.image}" style="width: 100px; height: 100px; object-fit: contain; border-radius: 10px;"/>`;
            }
            if (userGPS) {
                popupContent += `<p style="margin-top: 8px; font-size: 12px; color: ${isNearby ? 'green' : 'red'};">`;
                popupContent += `${Math.round(distance)}m away ${isNearby ? '✅ Visible in AR' : '❌ Too far'}`;
                popupContent += `</p>`;
            }
            popupContent += `</div>`;
            
            marker.bindPopup(popupContent);
            mapMarkers.push(marker);
        }
    });
}

// ===== EVENT HANDLERS =====
function setupEventHandlers() {
    console.log("🔗 Setting up event handlers...");
    
    // Home page buttons
    document.getElementById("createStickerBtn").addEventListener("click", () => {
        showPage("draw");
    });
    
    document.getElementById("exploreBtn").addEventListener("click", () => {
        showPage("ar");
    });
    
    document.getElementById("mapBtn").addEventListener("click", () => {
        showPage("map");
    });
    
    // Draw page buttons
    document.getElementById("saveStickerBtn").addEventListener("click", () => {
        const canvas = document.getElementById("drawCanvas");
        if (canvas) {
            pendingStickerImage = canvas.toDataURL("image/png");
            console.log("✅ Sticker saved, going to AR placement");
            showPage("ar");
        }
    });
    
    document.getElementById("clearDrawBtn").addEventListener("click", () => {
        const canvas = document.getElementById("drawCanvas");
        if (canvas) {
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    });
    
    document.getElementById("backToHomeBtn").addEventListener("click", () => {
        showPage("home");
    });
    
    // AR page buttons
    document.getElementById("placeStickerBtn").addEventListener("click", placeSticker);
    document.getElementById("exitArBtn").addEventListener("click", exitARMode);
    
    // Map page buttons
    document.getElementById("backFromMapBtn").addEventListener("click", () => {
        showPage("home");
    });
    
    // Window resize
    window.addEventListener("resize", () => {
        if (renderer && camera) {
            renderer.setSize(window.innerWidth, window.innerHeight);
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
        }
    });
    
    console.log("✅ Event handlers ready");
}

// ===== FIREBASE LISTENERS =====
function setupFirebaseListeners() {
    if (!stickersRef) return;
    
    // Listen for new stickers
    stickersRef.on('child_added', async (snapshot) => {
        const stickerId = snapshot.key;
        const stickerData = snapshot.val();
        
        if (stickerMeshes.has(stickerId)) return;
        
        if (stickerData.image && stickerData.lat && stickerData.lon) {
            try {
                // Check if sticker is nearby before creating mesh
                let shouldCreate = true;
                if (userGPS) {
                    const distance = calculateDistance(
                        userGPS.lat, userGPS.lon,
                        stickerData.lat, stickerData.lon
                    );
                    shouldCreate = distance <= MAX_STICKER_DISTANCE;
                    console.log(`🆕 New sticker ${distance.toFixed(1)}m away - ${shouldCreate ? 'Creating' : 'Skipping (too far)'}`);
                }
                
                if (shouldCreate) {
                    const mesh = await createStickerMesh(stickerData.image, 3.0);
                    const worldPos = gpsToWorldPosition(stickerData.lat, stickerData.lon);
                    
                    mesh.position.set(worldPos.x, 1.5, worldPos.z);
                    if (scene) scene.add(mesh);
                    
                    stickerMeshes.set(stickerId, { mesh, data: stickerData });
                    allStickerData.push({ id: stickerId, ...stickerData });
                    
                    // Update UI
                    const nearbyCount = updateStickerVisibility();
                    updateMapMarkers();
                    
                    console.log("🆕 New sticker added in real-time:", stickerId);
                }
            } catch (error) {
                console.error("❌ Failed to load new sticker:", error);
            }
        }
    });
    
    // Listen for removed stickers
    stickersRef.on('child_removed', (snapshot) => {
        const stickerId = snapshot.key;
        const stickerEntry = stickerMeshes.get(stickerId);
        
        if (stickerEntry) {
            if (scene) scene.remove(stickerEntry.mesh);
            stickerEntry.mesh.geometry.dispose();
            stickerEntry.mesh.material.dispose();
            stickerMeshes.delete(stickerId);
        }
        
        allStickerData = allStickerData.filter(sticker => sticker.id !== stickerId);
        
        // Update UI
        updateStickerVisibility();
        updateMapMarkers();
        
        console.log("🗑️ Sticker removed:", stickerId);
    });
}

// ===== INITIALIZATION =====
function initializeApp() {
    console.log("🎯 Initializing AR Stickers App...");
    
    // Setup core systems
    initializeDrawing();
    setupEventHandlers();
    setupFirebaseListeners();
    
    console.log("✅ AR Stickers App Ready!");
    console.log("🎉 All systems go! Try creating a sticker or exploring existing ones.");
}

// Start the app when ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}