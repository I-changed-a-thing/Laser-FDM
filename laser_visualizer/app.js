// Three.js Setup
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f111a);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(125, 200, 125);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.set(125, 125, 0); // Center of typical print bed
controls.update();

// Grid
const gridHelper = new THREE.GridHelper(250, 25);
gridHelper.rotation.x = Math.PI / 2;
gridHelper.position.set(125, 125, 0);
gridHelper.material.opacity = 0.2;
gridHelper.material.transparent = true;
scene.add(gridHelper);

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Render Loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

// --- G-Code Parser & Data Structures ---
let currentX = 0, currentY = 0, currentZ = 0, currentF = 0;
let currentLayer = 0;
let isAbsolute = true;
let laserPowers = { 1: 0, 2: 0, 3: 0 };
let maxPower = 0;
let minPower = 1.0;
let maxSpeed = 0;
let minSpeed = 99999;
let gcodeSettings = null;
let inLaserBlock = false;
let inPurgeBlock = false;
let currentChunkLabel = "";
let currentChunkType = "";
let currentChunkIdx = 0;
let currentZDrop = 0;

// We will store line segments as flat arrays: [x1, y1, z1, x2, y2, z2, ...]
const fdmLines = { positions: [], layers: [] };
const travelLines = { positions: [], layers: [] };
const purgeLines = { positions: [], layers: [] };
const laserChunks = []; // array of { type, label, layer, idx, pins: { 1: {positions:[], layers:[]}, ... } }

// Colors
const COLORS = {
    fdm: new THREE.Color(0xa4b0be),
    travel: new THREE.Color(0x4b6584),
    'Wall Smooth': new THREE.Color(0xff4757),
    'Deep Wall': new THREE.Color(0xff6b81),
    'Top Surface': new THREE.Color(0x2ed573),
    'Anneal': new THREE.Color(0xeccc68),
    'Rivet': new THREE.Color(0xeccc68),
    'Wobble': new THREE.Color(0xff7f50),
    'Connectivity': new THREE.Color(0x7bed9f),
    'Preheat': new THREE.Color(0xf39c12)
};

// Scene Objects
let fdmMesh = null;
let travelMesh = null;
let purgeMesh = null;
let laserMeshes = [];

// UI Elements
const uiContainer = document.getElementById('ui-container');
const dropZone = document.getElementById('drop-zone');
const loading = document.getElementById('loading');
const fileInput = document.getElementById('file-input');

// Drop Zone Events
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.getElementById('drop-content').classList.add('dragover');
});
dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    document.getElementById('drop-content').classList.remove('dragover');
});
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    document.getElementById('drop-content').classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
});

function handleFile(file) {
    if (!file) return;
    dropZone.classList.add('hidden');
    loading.classList.remove('hidden');
    
    // Reset Data
    fdmLines.positions = []; fdmLines.layers = [];
    travelLines.positions = []; travelLines.layers = [];
    purgeLines.positions = []; purgeLines.layers = [];
    laserChunks.length = 0;
    
    currentX = 0; currentY = 0; currentZ = 0;
    currentLayer = 0; isAbsolute = true; laserPowers = { 1: 0, 2: 0, 3: 0 };
    inLaserBlock = false; currentChunkIdx = -1;

    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target.result;
        setTimeout(() => parseGCode(text), 10);
    };
    reader.readAsText(file);
}

function parseGCode(text) {
    // FIX: The user's Python script sometimes writes literal '\n' sequences into the file instead of actual newlines.
    // Replace them with actual newlines so the parser can process them line by line.
    text = text.replace(/\\n/g, '\n');
    const lines = text.split('\n');
    const t0 = performance.now();
    
    for (let i = 0; i < lines.length; i++) {
        let fullStr = lines[i].trim();
        if (fullStr.length === 0) continue;
        
        let commentIdx = fullStr.indexOf(';');
        let str = commentIdx !== -1 ? fullStr.substring(0, commentIdx).trim() : fullStr;
        
        if (str.includes("G90")) isAbsolute = true;
        if (str.includes("G91")) isAbsolute = false;
        
        if (fullStr.startsWith(";LAYER:")) {
            const l = parseInt(fullStr.split(":")[1]);
            if (!isNaN(l)) currentLayer = l;
        }

        if (fullStr.includes("[Mid-Air Purge]")) {
            inPurgeBlock = true;
            window.purgeLineCount = 0; // use window to keep it simple and accessible
        }
        if (inPurgeBlock) {
            window.purgeLineCount++;
            if (fullStr.includes("unretract the snap") || fullStr.includes("restore fan") || window.purgeLineCount > 15) {
                inPurgeBlock = false;
            }
        }
        
        if (fullStr.startsWith("; ==") && fullStr.includes("Start")) {
            inLaserBlock = true;
            let labelParts = fullStr.match(/\[(.*?)\]/);
            currentChunkLabel = labelParts ? labelParts[1] : "Unknown";
            
            let zDropMatch = fullStr.match(/Z Drop:\s*([\d.]+)mm/);
            currentZDrop = zDropMatch ? parseFloat(zDropMatch[1]) : 0;

            let ox1Match = fullStr.match(/OffsetX1:\s*([-\d.]+)/);
            let ox2Match = fullStr.match(/OffsetX2:\s*([-\d.]+)/);
            let ozMatch = fullStr.match(/OffsetZ:\s*([-\d.]+)/);
            let currentOffsetX1 = ox1Match ? parseFloat(ox1Match[1]) : null;
            let currentOffsetX2 = ox2Match ? parseFloat(ox2Match[1]) : null;
            let currentOffsetZ = ozMatch ? parseFloat(ozMatch[1]) : null;
            
            if (fullStr.includes("Wobble") || fullStr.includes("wobble")) currentChunkType = "Wobble";
            else if (
                currentChunkLabel.includes("Wall Smooth") &&
                /DeepMode\s*:?\s*True/i.test(fullStr)
            ) currentChunkType = "Deep Wall";
            else if (currentChunkLabel.includes("Wall Smooth")) currentChunkType = "Wall Smooth";
            else if (currentChunkLabel.includes("Smooth Pass") || currentChunkLabel.includes("Top Surface") || currentChunkLabel.includes("Grouped Slope") || currentChunkLabel.includes("Global")) currentChunkType = "Top Surface";
            else if (currentChunkLabel.includes("Anneal")) currentChunkType = "Anneal";
            else if (currentChunkLabel.includes("Rivet")) currentChunkType = "Rivet";
            else if (currentChunkLabel.includes("Cut")) currentChunkType = "Cut";
            else if (currentChunkLabel.includes("Connectivity")) currentChunkType = "Connectivity";
            else currentChunkType = "Wall Smooth"; // fallback
            
            currentChunkIdx++;
            laserChunks.push({
                label: fullStr.replace("; ==", "").replace("==", "").trim(),
                type: currentChunkType,
                layer: currentLayer,
                idx: currentChunkIdx,
                zDrop: currentZDrop,
                offsetX1: currentOffsetX1,
                offsetX2: currentOffsetX2,
                offsetZ: currentOffsetZ,
                pins: {}
            });
        }
        if (fullStr.startsWith("; LASER_SETTINGS: ")) {
            try {
                gcodeSettings = JSON.parse(fullStr.substring(18));
                populateSettingsTable();
            } catch (e) {
                console.error("Failed to parse settings", e);
            }
        }
        if (fullStr.startsWith("; ==") && fullStr.includes("End")) {
            inLaserBlock = false;
            laserPowers = { 1: 0, 2: 0, 3: 0 }; // ensure it resets just in case
        }
        
        if (str.startsWith("SET_PIN")) {
            const valMatch = str.match(/VALUE=([\d.]+)/);
            let lPower = 0;
            if (valMatch) lPower = parseFloat(valMatch[1]);
            const pinMatch = str.match(/PIN=([^\s]+)/);
            if (pinMatch) {
                if (pinMatch[1].includes('1')) laserPowers[1] = lPower;
                else if (pinMatch[1].includes('2')) laserPowers[2] = lPower;
                else if (pinMatch[1].includes('3')) laserPowers[3] = lPower;
            }
        }
        
        if (str.startsWith("G4 ")) {
            let anyLaser = laserPowers[1] > 0 || laserPowers[2] > 0 || laserPowers[3] > 0;
            if (anyLaser && laserChunks.length > 0) {
                let chunk = laserChunks[laserChunks.length - 1];
                const s = 1.5;
                for (let p = 1; p <= 3; p++) {
                    let lPower = laserPowers[p];
                    if (lPower > 0) {
                        if (!chunk.pins[p]) {
                            chunk.pins[p] = { positions: [], layers: [], powers: [], speeds: [] };
                        }
                        // Visualize rivet/dwell as a 3D star (X cross + vertical spike) for maximum visibility
                        chunk.pins[p].positions.push(
                            currentX - s, currentY - s, currentZ, currentX + s, currentY + s, currentZ,
                            currentX - s, currentY + s, currentZ, currentX + s, currentY - s, currentZ,
                            currentX, currentY, currentZ, currentX, currentY, currentZ + s * 2
                        );
                        chunk.pins[p].layers.push(
                            currentLayer, currentLayer, currentLayer, currentLayer, currentLayer, currentLayer
                        );
                        chunk.pins[p].powers.push(
                            lPower, lPower, lPower, lPower, lPower, lPower
                        );
                        chunk.pins[p].speeds.push(0, 0, 0, 0, 0, 0);
                        if (lPower > maxPower) maxPower = lPower;
                        if (lPower > 0 && lPower < minPower) minPower = lPower;
                    }
                }
            }
        }
        
        if (str.startsWith("G0 ") || str.startsWith("G1 ") || str.startsWith("G2 ") || str.startsWith("G3 ")) {
            const isArc = str.startsWith("G2 ") || str.startsWith("G3 ");
            const isCW = str.startsWith("G2 ");
            
            const args = str.split(/\s+/);
            let x = currentX, y = currentY, z = currentZ, e = 0;
            let moveX = false, moveY = false, moveZ = false, hasE = false;
            let iOffset = 0, jOffset = 0, pRotations = 0;
            
            for(let j=1; j<args.length; j++) {
                let arg = args[j];
                if (arg.startsWith("X")) { x = isAbsolute ? parseFloat(arg.substring(1)) : currentX + parseFloat(arg.substring(1)); moveX = true; }
                else if (arg.startsWith("Y")) { y = isAbsolute ? parseFloat(arg.substring(1)) : currentY + parseFloat(arg.substring(1)); moveY = true; }
                else if (arg.startsWith("Z")) { z = isAbsolute ? parseFloat(arg.substring(1)) : currentZ + parseFloat(arg.substring(1)); moveZ = true; }
                else if (arg.startsWith("E")) { e = parseFloat(arg.substring(1)); hasE = true; }
                else if (arg.startsWith("F")) { currentF = parseFloat(arg.substring(1)); }
                else if (arg.startsWith("I")) { iOffset = parseFloat(arg.substring(1)); }
                else if (arg.startsWith("J")) { jOffset = parseFloat(arg.substring(1)); }
                else if (arg.startsWith("P")) { pRotations = parseInt(arg.substring(1)); }
            }
            
            let isMove = moveX || moveY || moveZ;
            
            if (inPurgeBlock) {
                purgeLines.positions.push(currentX, currentY, currentZ, x, y, z);
                purgeLines.layers.push(currentLayer, currentLayer);
                if (fullStr.includes("unretract the snap")) {
                    inPurgeBlock = false;
                }
            } else {
                if (isMove && (x !== currentX || y !== currentY || z !== currentZ)) {
                    let anyLaser = laserPowers[1] > 0 || laserPowers[2] > 0 || laserPowers[3] > 0;
                    
                    const addSegment = (px, py, pz, nx, ny, nz) => {
                        if (hasE && e > 0) {
                            fdmLines.positions.push(px, py, pz, nx, ny, nz);
                            fdmLines.layers.push(currentLayer, currentLayer);
                        } else if (!anyLaser) {
                            travelLines.positions.push(px, py, pz, nx, ny, nz);
                            travelLines.layers.push(currentLayer, currentLayer);
                        }
                        
                        if (anyLaser) {
                            if (!inLaserBlock) {
                                if (laserChunks.length === 0 || laserChunks[laserChunks.length - 1].type !== "Preheat" || laserChunks[laserChunks.length - 1].layer !== currentLayer) {
                                    currentChunkIdx++;
                                    laserChunks.push({
                                        label: "Preheat Layer " + currentLayer,
                                        type: "Preheat",
                                        layer: currentLayer,
                                        idx: currentChunkIdx,
                                        zDrop: 0,
                                        offsetX1: 0,
                                        offsetX2: 0,
                                        offsetZ: 0,
                                        pins: {}
                                    });
                                }
                            }
                            
                            if (laserChunks.length > 0) {
                                let chunk = laserChunks[laserChunks.length - 1];
                                for (let p = 1; p <= 3; p++) {
                                    let lPower = laserPowers[p];
                                    if (lPower > 0) {
                                        if (!chunk.pins[p]) {
                                            chunk.pins[p] = { positions: [], layers: [], powers: [], speeds: [] };
                                        }
                                        chunk.pins[p].positions.push(px, py, pz, nx, ny, nz);
                                        chunk.pins[p].layers.push(currentLayer, currentLayer);
                                        chunk.pins[p].powers.push(lPower, lPower);
                                        chunk.pins[p].speeds.push(currentF, currentF);
                                        
                                        if (lPower > maxPower) maxPower = lPower;
                                        if (lPower > 0 && lPower < minPower) minPower = lPower;
                                    }
                                }
                                if (currentF > maxSpeed) maxSpeed = currentF;
                                if (currentF > 0 && currentF < minSpeed) minSpeed = currentF;
                            }
                        }
                    };
                    
                    if (isArc && (iOffset !== 0 || jOffset !== 0)) {
                        const cx = currentX + iOffset;
                        const cy = currentY + jOffset;
                        const startAngle = Math.atan2(currentY - cy, currentX - cx);
                        let endAngle = Math.atan2(y - cy, x - cx);
                        
                        if (isCW) {
                            if (endAngle > startAngle) endAngle -= 2 * Math.PI;
                            if (pRotations > 0) endAngle -= 2 * Math.PI * pRotations;
                        } else {
                            if (endAngle < startAngle) endAngle += 2 * Math.PI;
                            if (pRotations > 0) endAngle += 2 * Math.PI * pRotations;
                        }
                        
                        if (Math.abs(endAngle - startAngle) < 0.0001 && pRotations > 0) {
                            endAngle = startAngle + (isCW ? -2 * Math.PI * pRotations : 2 * Math.PI * pRotations);
                        }
                        
                        const angleDiff = Math.abs(endAngle - startAngle);
                        const radius = Math.sqrt(iOffset * iOffset + jOffset * jOffset);
                        const arcLen = radius * angleDiff;
                        const segments = Math.max(1, Math.ceil(arcLen / 1.0)); // 1mm segments
                        
                        const zDiff = z - currentZ;
                        
                        let px = currentX, py = currentY, pz = currentZ;
                        for (let step = 1; step <= segments; step++) {
                            const t = step / segments;
                            const angle = startAngle + (endAngle - startAngle) * t;
                            const nx = cx + radius * Math.cos(angle);
                            const ny = cy + radius * Math.sin(angle);
                            const nz = currentZ + zDiff * t;
                            addSegment(px, py, pz, nx, ny, nz);
                            px = nx; py = ny; pz = nz;
                        }
                    } else {
                        addSegment(currentX, currentY, currentZ, x, y, z);
                    }
                }
            }
            if (moveX) currentX = x; currentY = y; currentZ = z;
        }
    }
    
    console.log(`Parsed in ${performance.now() - t0}ms`);
    updateLegend();
    buildScene();
}

function buildScene() {
    // Clear old meshes
    if (fdmMesh) scene.remove(fdmMesh);
    if (travelMesh) scene.remove(travelMesh);
    if (purgeMesh) scene.remove(purgeMesh);
    laserMeshes.forEach(m => scene.remove(m));
    laserMeshes = [];
    
    // Create FDM
    if (fdmLines.positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(fdmLines.positions, 3));
        const mat = new THREE.LineBasicMaterial({ color: COLORS.fdm, transparent: true, opacity: 0.25 });
        fdmMesh = new THREE.LineSegments(geo, mat);
        scene.add(fdmMesh);
    }
    
    // Create Travel
    if (travelLines.positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(travelLines.positions, 3));
        const mat = new THREE.LineBasicMaterial({ color: COLORS.travel, transparent: true, opacity: 0.1 });
        travelMesh = new THREE.LineSegments(geo, mat);
        travelMesh.visible = false; // default off
        scene.add(travelMesh);
    }

    // Create Purge
    if (purgeLines.positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(purgeLines.positions, 3));
        const mat = new THREE.LineBasicMaterial({ color: 0x9b59b6, linewidth: 1 });
        purgeMesh = new THREE.LineSegments(geo, mat);
        scene.add(purgeMesh);
    }
    
    // Create Laser Chunks
    laserChunks.forEach(chunk => {
        Object.keys(chunk.pins).forEach(pinKey => {
            const pinData = chunk.pins[pinKey];
            if (pinData.positions.length === 0) return;
                          const geo = new THREE.BufferGeometry();
              geo.setAttribute('position', new THREE.Float32BufferAttribute(pinData.positions, 3));
              geo.userData = { originalPositions: new Float32Array(pinData.positions) };
              
              const colorModeSelect = document.querySelector('input[name="colorMode"]:checked');
              const colorMode = colorModeSelect ? colorModeSelect.value : 'pin';
              let mat;
              
              if (colorMode === 'pin') {
                  const color = COLORS[chunk.type] || new THREE.Color(0xffffff);
                  mat = new THREE.LineBasicMaterial({ color: color, linewidth: 2 });
              } else if (colorMode === 'laser_pin') {
                  let color;
                  if (parseInt(pinKey) === 1) color = new THREE.Color(0xff4757); // Red
                  else if (parseInt(pinKey) === 2) color = new THREE.Color(0x2ed573); // Green
                  else if (parseInt(pinKey) === 3) color = new THREE.Color(0x3742fa); // Blue
                  else color = new THREE.Color(0xffffff);
                  mat = new THREE.LineBasicMaterial({ color: color, linewidth: 2 });
              } else {
                  const colors = [];
                  const c1 = new THREE.Color();
                  const c2 = new THREE.Color();
                  
                  const isPower = colorMode === 'power';
                  const isSequence = colorMode === 'sequence';
                  const minVal = isPower ? minPower : minSpeed;
                  const maxVal = isPower ? maxPower : maxSpeed;
                  const valArray = isPower ? pinData.powers : pinData.speeds;
                  
                  for (let i = 0; i < valArray.length; i += 2) {
                      const v1 = valArray[i];
                      const v2 = valArray[i+1];
                      
                      let t1 = isSequence ? (i / valArray.length) : (maxVal > minVal ? (v1 - minVal) / (maxVal - minVal) : 1.0);
                      let t2 = isSequence ? ((i+2) / valArray.length) : (maxVal > minVal ? (v2 - minVal) / (maxVal - minVal) : 1.0);
                      
                      // Map t from 0 to 1 to hue from 240 (blue) to 0 (red)
                      c1.setHSL((1.0 - t1) * 240 / 360, 1.0, 0.5);
                      c2.setHSL((1.0 - t2) * 240 / 360, 1.0, 0.5);
                      
                      colors.push(c1.r, c1.g, c1.b);
                      colors.push(c2.r, c2.g, c2.b);
                  }
                  
                  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
                  mat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2 });
              }
              
              const mesh = new THREE.LineSegments(geo, mat);
            mesh.userData = { 
                type: chunk.type, 
                layer: chunk.layer, 
                idx: chunk.idx, 
                pin: parseInt(pinKey), 
                zDrop: chunk.zDrop || 0,
                offsetX1: chunk.offsetX1,
                offsetX2: chunk.offsetX2,
                offsetZ: chunk.offsetZ
            };
            laserMeshes.push(mesh);
            scene.add(mesh);
        });
    });
    
    updateUI();
    applyOffsets();
    loading.classList.add('hidden');
    uiContainer.classList.remove('hidden');
    
    // Center camera on the model
    if (fdmMesh) {
        fdmMesh.geometry.computeBoundingSphere();
        const center = fdmMesh.geometry.boundingSphere.center;
        controls.target.copy(center);
        camera.position.set(center.x, center.y + 100, center.z + 100);
        controls.update();
    }
}

// --- UI Logic ---
let maxLayer = 0;
let totalChunks = 0;

function updateUI() {
    // Safely find max layer without hitting call stack limits
    maxLayer = 0;
    for(let i=0; i<fdmLines.layers.length; i++) {
        if(fdmLines.layers[i] > maxLayer) maxLayer = fdmLines.layers[i];
    }
    laserChunks.forEach(c => {
        if(c.layer > maxLayer) maxLayer = c.layer;
    });
    
    totalChunks = laserChunks.length;
    
    document.getElementById('stat-layers').innerText = maxLayer;
    document.getElementById('stat-chunks').innerText = totalChunks;
    const totalLaserLines = laserChunks.reduce((acc, c) => {
        let lines = 0;
        Object.values(c.pins).forEach(p => lines += p.positions.length / 6);
        return acc + lines;
    }, 0);
    document.getElementById('stat-passes').innerText = totalLaserLines;
    
    const minL = document.getElementById('min-layer');
    const maxL = document.getElementById('max-layer');
    minL.max = maxLayer; maxL.max = maxLayer;
    minL.value = 0; maxL.value = maxLayer;
    
    document.getElementById('min-layer-val').innerText = 0;
    document.getElementById('max-layer-val').innerText = maxLayer;
    
    const chunkS = document.getElementById('chunk-slider');
    chunkS.max = totalChunks - 1;
    chunkS.value = -1;
    document.getElementById('chunk-idx-val').innerText = "All";
    
    updateVisibility();
}

// Add event listeners
document.getElementById('min-layer').addEventListener('input', (e) => {
    document.getElementById('min-layer-val').innerText = e.target.value;
    updateVisibility();
});
document.getElementById('max-layer').addEventListener('input', (e) => {
    document.getElementById('max-layer-val').innerText = e.target.value;
    updateVisibility();
});
document.getElementById('chunk-slider').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    if (val === -1) {
        document.getElementById('chunk-idx-val').innerText = "All";
        document.getElementById('chunk-info').innerText = "Showing all chunks.";
    } else {
        document.getElementById('chunk-idx-val').innerText = val;
        if (laserChunks[val]) {
            document.getElementById('chunk-info').innerText = laserChunks[val].label;
        }
    }
    updateVisibility();
});

// Toggles
['fdm', 'travel', 'purge', 'wall-smooth', 'deep-wall', 'top-smooth', 'anneal', 'wobble', 'connectivity', 'preheat', 'pin-1', 'pin-2', 'pin-3'].forEach(id => {
    const el = document.getElementById('show-' + id);
    if (el) el.addEventListener('change', updateVisibility);
});

const wallLevel = document.getElementById('wall-level');
if (wallLevel) {
    wallLevel.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === '0') { setWallOffsets(5.0, -5.5, 2.8); }
        else if (val === '1') { setWallOffsets(11.5, -12.6, 5.8); }
        else if (val === '2') { setWallOffsets(21.2, -23.8, 10.0); }
        else if (val === '3') { setWallOffsets(31.9, -35.7, 15.0); }
        else if (val === '4') { setWallOffsets(42.5, -47.6, 20.0); }
    });
}

function setWallOffsets(x1, x2, z) {
    document.getElementById('l1-x').value = x1;
    document.getElementById('l1-z').value = z;
    document.getElementById('l2-x').value = x2;
    document.getElementById('l2-z').value = z;
    applyOffsets();
}

['l1-x', 'l1-y', 'l1-z', 'l2-x', 'l2-y', 'l2-z', 'l3-x', 'l3-y', 'l3-z'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', applyOffsets);
});

const projectWobbleEl = document.getElementById('project-wobble');
if (projectWobbleEl) projectWobbleEl.addEventListener('change', applyOffsets);

const reverseZHopEl = document.getElementById('reverse-z-hop');
if (reverseZHopEl) reverseZHopEl.addEventListener('change', applyOffsets);

const topZHopValEl = document.getElementById('top-z-hop-val');
if (topZHopValEl) topZHopValEl.addEventListener('input', applyOffsets);

const randomColorsEl = document.getElementById('random-colors');
if (randomColorsEl) {
    randomColorsEl.addEventListener('change', () => {
        laserMeshes.forEach(m => {
            if (randomColorsEl.checked) {
                const hue = (m.userData.idx * 137.5) % 360;
                m.material.color.setHSL(hue / 360, 0.8, 0.6);
            } else {
                const c = COLORS[m.userData.type] || new THREE.Color(0xffffff);
                m.material.color.copy(c);
            }
        });
    });
}

function applyOffsets() {
    const getVal = (id) => parseFloat(document.getElementById(id).value.replace(',', '.')) || 0;
    const l1x = getVal('l1-x');
    const l1y = getVal('l1-y');
    const l1z = getVal('l1-z');
    const l2x = getVal('l2-x');
    const l2y = getVal('l2-y');
    const l2z = getVal('l2-z');
    const l3x = getVal('l3-x');
    const l3y = getVal('l3-y');
    let l3z = getVal('l3-z');
    
    if (document.getElementById('reverse-z-hop') && document.getElementById('reverse-z-hop').checked) {
        const zHop = getVal('top-z-hop-val');
        l3z += zHop;
    }

    const projectWobble = document.getElementById('project-wobble') && document.getElementById('project-wobble').checked;

laserMeshes.forEach(m => {
        let lx = 0, ly = 0, lz = 0;
        if (m.userData.pin === 1) { lx = l1x; ly = l1y; lz = l1z; }
        if (m.userData.pin === 2) { lx = l2x; ly = l2y; lz = l2z; }
        if (m.userData.pin === 3) { lx = l3x; ly = l3y; lz = l3z; }
        
        // Override with exact offsets from G-code if available
        if (m.userData.pin === 1 && m.userData.offsetX1 !== null && m.userData.offsetX1 !== undefined) {
            lx = m.userData.offsetX1;
        } else if (m.userData.pin === 2 && m.userData.offsetX2 !== null && m.userData.offsetX2 !== undefined) {
            lx = m.userData.offsetX2;
        }
        
        if (m.userData.offsetZ !== null && m.userData.offsetZ !== undefined) {
            lz = m.userData.offsetZ;
        }

        if (m.geometry.userData && m.geometry.userData.originalPositions) {
            const orig = m.geometry.userData.originalPositions;
            const pos = m.geometry.attributes.position.array;
            
            let wobbleCache = new Map();
            for (let i = 0; i < orig.length; i += 3) {
                let ox = orig[i], oy = orig[i+1], oz = orig[i+2];
                
                if (projectWobble && lx !== 0 && m.userData.type === "Wobble") {
                    // Pre-segment the mesh into continuous strokes so the sliding window 
                    // doesn't average across disconnected walls or corners.
                    if (!wobbleCache.has('_strokes')) {
                        let strokes = [];
                        let currentStroke = [0]; // stores vertex indices (i/3)
                        for (let k = 3; k < orig.length; k += 3) {
                            // Check if the previous segment connects to this segment
                            // In LineSegments, k-3 is the start of the prev pair, k is the start of current
                            // But actually, vertices are pairs: (0,1), (2,3), (4,5)
                            // A continuous stroke means vertex 1 == vertex 2.
                            let isContiguous = false;
                            if (k % 6 === 0) {
                                // k is the start of a new segment pair. check if it connects to the end of the previous pair (k-3)
                                let dx = orig[k] - orig[k-3];
                                let dy = orig[k+1] - orig[k-2];
                                let dz = orig[k+2] - orig[k-1];
                                if (Math.hypot(dx, dy, dz) < 0.1) {
                                    isContiguous = true;
                                }
                            } else {
                                // k is the end of a segment pair (k=3, 9, 15...). It trivially connects to its start (k-3)
                                isContiguous = true;
                            }
                            
                            if (isContiguous) {
                                currentStroke.push(k/3);
                            } else {
                                strokes.push(currentStroke);
                                currentStroke = [k/3];
                            }
                        }
                        if (currentStroke.length > 0) strokes.push(currentStroke);
                        
                        // Map each vertex index to its stroke
                        let vertexToStroke = new Int32Array(orig.length / 3);
                        for (let s = 0; s < strokes.length; s++) {
                            for (let idx of strokes[s]) {
                                vertexToStroke[idx] = s;
                            }
                        }
                        wobbleCache.set('_strokes', { strokes, vertexToStroke });
                    }
                    
                    const strokeData = wobbleCache.get('_strokes');
                    const vIdx = i / 3;
                    const strokeIdx = strokeData.vertexToStroke[vIdx];
                    const stroke = strokeData.strokes[strokeIdx];
                    
                    // Wobble sweeps 0 → A (one-sided), so amplitude A = zDrop * (lx/lz)
                    let A = Math.abs(m.userData.zDrop * (lx / lz));
                    let key = `${ox.toFixed(4)}_${oy.toFixed(4)}_${oz.toFixed(4)}`;
                    let wobble_x = 0;
                    
                    if (wobbleCache.has(key)) {
                        wobble_x = wobbleCache.get(key);
                    } else {
                        let sumX = 0, count = 0;
                        // Find where we are in the stroke array
                        let strokePos = stroke.indexOf(vIdx);
                        // Average over a window of exactly 8 vertices (multiple of 4) to avoid oscillation
                        let startPos = strokePos - 3;
                        let endPos = strokePos + 4;
                        // Clamp to array bounds while trying to keep window size 8
                        if (startPos < 0) { endPos -= startPos; startPos = 0; }
                        if (endPos >= stroke.length) { startPos -= (endPos - stroke.length + 1); endPos = stroke.length - 1; }
                        startPos = Math.max(0, startPos); // final safety clamp

                        for (let p = startPos; p <= endPos; p++) {
                            let idx = stroke[p] * 3;
                            sumX += orig[idx];
                            count++;
                        }
                        
                        if (count > 0) {
                            let avgX = sumX / count;
                            wobble_x = ox - avgX;
                        }
                        wobbleCache.set(key, wobble_x);
                    }
                    
                    if (Math.abs(wobble_x) > 0.01) {
                        // Reverse the X wobble back to beam center
                        ox -= wobble_x;
                        oz -= wobble_x * (lz / lx);
                        
                        // Remove DC offset: one-sided sweep means center is shifted by A/2
                        ox -= (A / 2.0) * Math.sign(lx);
                        oz -= (A / 2.0) * (lz / Math.abs(lx));
                    }
                }
                
                pos[i] = ox - lx;
                pos[i+1] = oy - ly;
                pos[i+2] = oz - lz;
            }
            m.geometry.attributes.position.needsUpdate = true;
            m.geometry.computeBoundingSphere();
            m.position.set(0, 0, 0); // ensure global transform is reset
        } else {
            if (m.userData.pin === 1) m.position.set(-l1x, -l1y, -l1z);
            if (m.userData.pin === 2) m.position.set(-l2x, -l2y, -l2z);
            if (m.userData.pin === 3) m.position.set(-l3x, -l3y, -l3z);
        }
    });
}

document.getElementById('reset-btn').addEventListener('click', () => {
    uiContainer.classList.add('hidden');
    dropZone.classList.remove('hidden');
    if (fdmMesh) scene.remove(fdmMesh);
    if (travelMesh) scene.remove(travelMesh);
    if (purgeMesh) scene.remove(purgeMesh);
    laserMeshes.forEach(m => scene.remove(m));
    fdmMesh = null; travelMesh = null; purgeMesh = null; laserMeshes = [];
});

function updateVisibility() {
    const minL = parseInt(document.getElementById('min-layer').value);
    const maxL = parseInt(document.getElementById('max-layer').value);
    const chunkIdx = parseInt(document.getElementById('chunk-slider').value);
    
    const sFdm = document.getElementById('show-fdm').checked;
    const sTravel = document.getElementById('show-travel').checked;
    const sPurge = document.getElementById('show-purge').checked;
    const sWall = document.getElementById('show-wall-smooth').checked;
    const sDeepWall = document.getElementById('show-deep-wall').checked;
    const sTop = document.getElementById('show-top-smooth').checked;
    const sAnneal = document.getElementById('show-anneal').checked;
    const sWobble = document.getElementById('show-wobble').checked;
    const sConn = document.getElementById('show-connectivity').checked;
    const sPreheatEl = document.getElementById('show-preheat');
    const sPreheat = sPreheatEl ? sPreheatEl.checked : true;
    
    filterMeshByLayer(fdmMesh, fdmLines, minL, maxL, sFdm);
    filterMeshByLayer(travelMesh, travelLines, minL, maxL, sTravel);
    filterMeshByLayer(purgeMesh, purgeLines, minL, maxL, sPurge);
    
    // Filter Laser Chunks
    laserMeshes.forEach(mesh => {
        let visible = true;
        const data = mesh.userData;
        
        // Filter by layer
        if (data.layer < minL || data.layer > maxL) visible = false;
        
        // Filter by specific chunk
        if (chunkIdx !== -1 && data.idx !== chunkIdx) visible = false;
        
        // Filter by toggle
        if (data.type === 'Wall Smooth' && !sWall) visible = false;
        if (data.type === 'Deep Wall' && !sDeepWall) visible = false;
        if (data.type === 'Top Surface' && !sTop) visible = false;
        if ((data.type === 'Anneal' || data.type === 'Rivet') && !sAnneal) visible = false;
        if (data.type === 'Wobble' && !sWobble) visible = false;
        if (data.type === 'Connectivity' && !sConn) visible = false;
        if (data.type === 'Preheat' && !sPreheat) visible = false;
        
        const sPin1El = document.getElementById('show-pin-1');
        const sPin1 = sPin1El ? sPin1El.checked : true;
        const sPin2El = document.getElementById('show-pin-2');
        const sPin2 = sPin2El ? sPin2El.checked : true;
        const sPin3El = document.getElementById('show-pin-3');
        const sPin3 = sPin3El ? sPin3El.checked : true;
        
        if (data.pin === 1 && !sPin1) visible = false;
        if (data.pin === 2 && !sPin2) visible = false;
        if (data.pin === 3 && !sPin3) visible = false;
        
        mesh.visible = visible;
    });
}

function filterMeshByLayer(mesh, lineData, minL, maxL, isEnabled) {
    if (!mesh) return;
    if (!isEnabled) {
        mesh.visible = false;
        return;
    }
    
    if (minL === 0 && maxL === maxLayer) {
        mesh.visible = true;
        mesh.geometry.setIndex(null); // use all vertices
        return;
    }
    
    mesh.visible = true;
    
    const indices = [];
    for (let i = 0; i < lineData.layers.length; i += 2) {
        const l = lineData.layers[i];
        if (l >= minL && l <= maxL) {
            indices.push(i, i+1);
        }
    }
    mesh.geometry.setIndex(indices);
}

document.querySelectorAll('input[name="colorMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
        updateLegend();
        buildScene();
    });
});

function updateLegend() {
    const colorModeSelect = document.querySelector('input[name="colorMode"]:checked');
    if (!colorModeSelect) return;
    const colorMode = colorModeSelect.value;
    const legend = document.getElementById('color-legend');
    if (colorMode === 'pin' || colorMode === 'laser_pin') {
        legend.classList.add('hidden');
    } else {
        legend.classList.remove('hidden');
        if (colorMode === 'power') {
            document.getElementById('legend-min').innerText = minPower.toFixed(2);
            document.getElementById('legend-max').innerText = maxPower.toFixed(2);
        } else if (colorMode === 'speed') {
            document.getElementById('legend-min').innerText = minSpeed.toFixed(0) + " mm/min";
            document.getElementById('legend-max').innerText = maxSpeed.toFixed(0) + " mm/min";
        }
    }
}


document.getElementById('toggle-settings-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('hidden');
});

document.getElementById('close-settings-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.add('hidden');
});

function populateSettingsTable() {
    const container = document.getElementById('settings-table-container');
    if (!gcodeSettings) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No settings found in this file.</p>';
        return;
    }
    
    let html = '<table class="settings-table"><tbody>';
    for (const [key, value] of Object.entries(gcodeSettings)) {
        html += `<tr><th>${key}</th><td>${value}</td></tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
}
