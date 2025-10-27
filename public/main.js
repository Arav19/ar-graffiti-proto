// main.js - GPS AR Stickers - COMPLETE REWRITE

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
    
    // Clear canvas
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
    
    // Event listeners
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseout', stopDrawing);
    
    // Touch support
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
        // Renderer
        renderer = new THREE.WebGLRenderer({ 
            canvas: canvas, 
            alpha: true, 
            antialias: true 
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        
        // Scene
        scene = new THREE.Scene();
        
        // Camera
        camera = new THREE.PerspectiveCamera(
            75, 
            window.innerWidth / window.innerHeight, 
            0.1, 
            1000
        );
        camera.position.set(0, 1.6, 0);
        
        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(1, 1, 1);
        scene.add(directionalLight);
        
        console.log("✅ Three.js initialized");
        return true;
    } catch (error) {
        console.error("❌ Three.js init failed:", error);
        return false;
    }
}

function createStickerMesh(imageData, size = 2.0) {
    return new Promise((resolve) => {
        const textureLoader = new THREE.TextureLoader();
        textureLoader.load(imageData, (texture) => {
            const geometry = new THREE.PlaneGeometry(size, size);
            const material = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                side: THREE.DoubleSide,
                opacity: 0.9
            });
            
            const mesh = new THREE.Mesh(geometry, material);
            mesh.rotation.x = -Math.PI / 2; // Lay flat on ground
            
            resolve(mesh);
        });
    });
}

function updateStickerBillboarding() {
    stickerMeshes.forEach(({ mesh }) => {
        mesh.lookAt(camera.position);
    });
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
        if (arStatus) arStatus.textContent = `Location ready! Accuracy: ${Math.round(userGPS.accuracy)}m`;
        
    } catch (error) {
        console.error("❌ Location failed:", error);
        if (arStatus) arStatus.textContent = "Location access denied";
        // Continue anyway with demo location
        userGPS = { lat: 40.7589, lon: -73.9851, accuracy: 100 };
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
            renderer.render(scene, camera);
        }
    }
    animate();
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
            return;
        }
        
        allStickerData = Object.entries(data).map(([id, sticker]) => ({
            id,
            ...sticker
        }));
        
        console.log(`📊 Found ${allStickerData.length} stickers`);
        
        // Create Three.js meshes for each sticker
        for (const sticker of allStickerData) {
            if (sticker.image && sticker.lat && sticker.lon) {
                try {
                    const mesh = await createStickerMesh(sticker.image, 2.0);
                    const worldPos = gpsToWorldPosition(sticker.lat, sticker.lon);
                    
                    mesh.position.set(worldPos.x, 0.1, worldPos.z);
                    scene.add(mesh);
                    
                    stickerMeshes.set(sticker.id, { mesh, data: sticker });
                    
                    console.log(`✅ Loaded sticker at (${sticker.lat.toFixed(4)}, ${sticker.lon.toFixed(4)})`);
                } catch (error) {
                    console.error(`❌ Failed to load sticker ${sticker.id}:`, error);
                }
            }
        }
        
        // Update UI
        const stickerCount = document.getElementById("stickerCount");
        if (stickerCount) {
            stickerCount.textContent = allStickerData.length.toString();
        }
        
        const arStatus = document.getElementById("arStatus");
        if (arStatus && !arStatus.textContent.includes("Place")) {
            arStatus.textContent = `Loaded ${allStickerData.length} stickers! Look around.`;
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
            const marker = L.marker([sticker.lat, sticker.lon]).addTo(leafletMap);
            
            if (sticker.image) {
                marker.bindPopup(`
                    <div style="text-align: center;">
                        <img src="${sticker.image}" style="width: 100px; height: 100px; object-fit: contain; border-radius: 10px;"/>
                        <p style="margin-top: 8px; font-size: 12px;">Sticker placed here</p>
                    </div>
                `);
            }
            
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
                const mesh = await createStickerMesh(stickerData.image, 2.0);
                const worldPos = gpsToWorldPosition(stickerData.lat, stickerData.lon);
                
                mesh.position.set(worldPos.x, 0.1, worldPos.z);
                if (scene) scene.add(mesh);
                
                stickerMeshes.set(stickerId, { mesh, data: stickerData });
                allStickerData.push({ id: stickerId, ...stickerData });
                
                // Update UI
                const stickerCount = document.getElementById("stickerCount");
                if (stickerCount) {
                    stickerCount.textContent = allStickerData.length.toString();
                }
                
                updateMapMarkers();
                
                console.log("🆕 New sticker added in real-time:", stickerId);
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
        const stickerCount = document.getElementById("stickerCount");
        if (stickerCount) {
            stickerCount.textContent = allStickerData.length.toString();
        }
        
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