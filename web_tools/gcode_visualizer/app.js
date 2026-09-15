// =====================================================================
// THREE.JS SETUP & RENDER LOOP
// =====================================================================
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f111a);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(125, 200, 125);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.set(125, 125, 0); // Center of typical print bed
controls.update();

// Grid Helper (250x250 bed, 25mm divisions)
const gridHelper = new THREE.GridHelper(250, 25, 0x6276a8, 0x293552);
gridHelper.rotation.x = Math.PI / 2;
gridHelper.position.set(125, 125, 0);
gridHelper.material.opacity = 0.3;
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

// =====================================================================
// =====================================================================
// CALIBRATION LEVELS & INTERPOLATION
// =====================================================================
function getCalibrationLevels() {
    if (window.LaserCalibration) {
        const levels = window.LaserCalibration.getLevels();
        return levels.map(l => [l.z, l.x1 !== null ? l.x1 : 0, l.x2 !== null ? l.x2 : 0]);
    }
    return [
        [2.0, 0, 0],
        [5.0, 0, 0],
        [10.0, 0, 0],
        [15.0, 0, 0],
        [20.0, 0, 0]
    ];
}

function interpolateOffset(beamHeight, pin) {
    if (window.LaserCalibration && window.LaserCalibration.interpolateOffset) {
        return window.LaserCalibration.interpolateOffset(beamHeight, pin);
    }
    const col = (pin === 1) ? 1 : 2;
    const levels = getCalibrationLevels();
    for (let i = 0; i < levels.length - 1; i++) {
        const z0 = levels[i][0], z1 = levels[i + 1][0];
        if (z0 <= beamHeight && beamHeight <= z1) {
            const t = (beamHeight - z0) / (z1 - z0);
            return levels[i][col] + t * (levels[i + 1][col] - levels[i][col]);
        }
    }
    return levels[0][col];
}

// =====================================================================
// DATA STRUCTURES & COLOR DEFINITIONS
// =====================================================================
let currentX = 0, currentY = 0, currentZ = 0, currentE = 0, currentF = 0;
let currentLayer = 0;
let isAbsolute = true;
let isRelE = true;
let lastE = 0;

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

const fdmLines = { positions: [], layers: [] };
const travelLines = { positions: [], layers: [] };
const purgeLines = { positions: [], layers: [] };
const laserChunks = [];

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

let fdmMesh = null;
let travelMesh = null;
let purgeMesh = null;
let laserMeshes = [];

// UI Elements
const uiContainer = document.getElementById('ui-container');
const dropZone = document.getElementById('drop-zone');
const loading = document.getElementById('loading');
const fileInput = document.getElementById('file-input');

// Drop Zone & Drag-Drop Events
const dropContent = document.getElementById('drop-content');

window.addEventListener('dragover', (e) => {
    e.preventDefault();
});
window.addEventListener('drop', (e) => {
    e.preventDefault();
});

if (dropZone) {
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dropContent) dropContent.classList.add('dragover');
        });
    });

    ['dragleave', 'dragend'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dropContent) dropContent.classList.remove('dragover');
        });
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dropContent) dropContent.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFile(e.dataTransfer.files[0]);
        }
    });
}

if (fileInput) {
    fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });
}

function loadGCodeText(text) {
    if (!text || typeof text !== 'string') return;
    if (dropZone) dropZone.classList.add('hidden');
    if (loading) loading.classList.remove('hidden');
    
    // Reset Data
    fdmLines.positions = []; fdmLines.layers = [];
    travelLines.positions = []; travelLines.layers = [];
    purgeLines.positions = []; purgeLines.layers = [];
    laserChunks.length = 0;
    
    currentX = 0; currentY = 0; currentZ = 0; currentE = 0; lastE = 0;
    currentLayer = 0; isAbsolute = true; isRelE = true;
    laserPowers = { 1: 0, 2: 0, 3: 0 };
    maxPower = 0; minPower = 1.0; maxSpeed = 0; minSpeed = 99999;
    gcodeSettings = null;
    inLaserBlock = false; currentChunkIdx = -1;

    setTimeout(() => {
        try {
            parseGCode(text);
        } catch (err) {
            console.error("G-Code parsing error:", err);
            alert("Error parsing G-Code: " + (err && err.message ? err.message : err));
            if (loading) loading.classList.add('hidden');
            if (dropZone) dropZone.classList.remove('hidden');
        }
    }, 10);
}

function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        loadGCodeText(e.target.result);
    };
    reader.onerror = (err) => {
        console.error("FileReader error:", err);
        alert("Failed to read G-Code file.");
        if (loading) loading.classList.add('hidden');
        if (dropZone) dropZone.classList.remove('hidden');
    };
    reader.readAsText(file);
}

const btnLoadSample = document.getElementById('btn-load-sample');
if (btnLoadSample) {
    btnLoadSample.addEventListener('click', () => {
        if (window.DEFAULT_GCODE) {
            loadGCodeText(window.DEFAULT_GCODE);
        } else {
            alert("Default sample G-code is not loaded.");
        }
    });
}

// =====================================================================
// G-CODE PARSER
// =====================================================================
function parseGCode(text) {
    text = text.replace(/\\n/g, '\n');
    const lines = text.split(/\r?\n/);
    const t0 = performance.now();
    
    const WORD_REGEX = /([A-Za-z])\s*([-+]?\d*\.?\d+(?:[Ee][-+]?\d+)?)/g;
    
    for (let i = 0; i < lines.length; i++) {
        let fullStr = lines[i].trim();
        if (fullStr.length === 0) continue;
        
        let commentIdx = fullStr.indexOf(';');
        let str = commentIdx !== -1 ? fullStr.substring(0, commentIdx).trim() : fullStr;
        let upperFull = fullStr.toUpperCase();
        let upperCmd = str.toUpperCase();
        
        // Coordinate mode
        if (upperCmd.includes("G90")) isAbsolute = true;
        if (upperCmd.includes("G91")) isAbsolute = false;
        if (upperCmd.includes("M82")) isRelE = false;
        if (upperCmd.includes("M83")) isRelE = true;
        
        // Layer detection
        if (upperFull.startsWith(";LAYER:")) {
            const l = parseInt(fullStr.split(":")[1]);
            if (!isNaN(l)) currentLayer = l;
        } else if (upperFull.startsWith(";LAYER_CHANGE")) {
            currentLayer++;
        }
        
        // Mid-Air Purge detection
        if (fullStr.includes("[Mid-Air Purge]")) {
            inPurgeBlock = true;
            window.purgeLineCount = 0;
        }
        if (inPurgeBlock) {
            window.purgeLineCount++;
            if (fullStr.includes("unretract the snap") || fullStr.includes("restore fan") || window.purgeLineCount > 20) {
                inPurgeBlock = false;
            }
        }
        
        // Settings detection
        if (fullStr.startsWith("; LASER_SETTINGS: ") || fullStr.startsWith("; VOXEL_WALL_SETTINGS: ") || fullStr.startsWith("; VOXEL_WALL_V11_SETTINGS: ")) {
            try {
                const jsonText = fullStr.substring(fullStr.indexOf('{'));
                gcodeSettings = JSON.parse(jsonText);
                populateSettingsTable();
                
                if (gcodeSettings.offset_level !== undefined) {
                    const wallLevelEl = document.getElementById('wall-level');
                    if (wallLevelEl) {
                        wallLevelEl.value = String(gcodeSettings.offset_level);
                        if (String(gcodeSettings.offset_level).toLowerCase() === 'custom') {
                            const custom = window.LaserCalibration && window.LaserCalibration.getCustomLevel ? window.LaserCalibration.getCustomLevel() : null;
                            if (custom && custom.x1 !== null && custom.x2 !== null) {
                                setWallOffsets(custom.x1, custom.x2, custom.z !== null ? custom.z : 0);
                            }
                        } else {
                            const lvl = window.LaserCalibration ? window.LaserCalibration.getLevel(gcodeSettings.offset_level) : null;
                            if (lvl && lvl.x1 !== null && lvl.x2 !== null) setWallOffsets(lvl.x1, lvl.x2, lvl.z);
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to parse settings JSON", e);
            }
        }
        
        // Laser Chunk Header Detection
        if (fullStr.startsWith("; ==") && (fullStr.includes("Start") || fullStr.includes("chunk"))) {
            inLaserBlock = true;
            let labelParts = fullStr.match(/\[(.*?)\]/);
            let rawLabel = labelParts ? labelParts[1] : "Unknown";
            
            let isSubPass = /Pass\s+\d+\/\d+/i.test(rawLabel);
            
            if (!isSubPass) {
                currentChunkLabel = rawLabel;
                
                let zDropMatch = fullStr.match(/Z Drop:\s*([\d.]+)mm/i);
                currentZDrop = zDropMatch ? parseFloat(zDropMatch[1]) : 0;

                let ox1Match = fullStr.match(/OffsetX1:\s*([-\d.]+)/i);
                let ox2Match = fullStr.match(/OffsetX2:\s*([-\d.]+)/i);
                let ozMatch = fullStr.match(/OffsetZ:\s*([-\d.]+)/i);
                let topZMatch = fullStr.match(/top_z=([-\d.]+)/i);
                let opZMatch = fullStr.match(/operating_z=([-\d.]+)/i);
                let levelMatch = fullStr.match(/level=([a-zA-Z0-9]+)/i);

                let currentOffsetX1 = ox1Match ? parseFloat(ox1Match[1]) : null;
                let currentOffsetX2 = ox2Match ? parseFloat(ox2Match[1]) : null;
                let currentOffsetZ = ozMatch ? parseFloat(ozMatch[1]) : null;
                let topZ = topZMatch ? parseFloat(topZMatch[1]) : null;
                let operatingZ = opZMatch ? parseFloat(opZMatch[1]) : null;
                let levelVal = levelMatch ? levelMatch[1].toLowerCase() : null;
                
                if (levelVal === 'custom') {
                    const custom = window.LaserCalibration && window.LaserCalibration.getCustomLevel ? window.LaserCalibration.getCustomLevel() : null;
                    if (custom) {
                        if (currentOffsetX1 === null) currentOffsetX1 = custom.x1 !== null ? custom.x1 : 0;
                        if (currentOffsetX2 === null) currentOffsetX2 = custom.x2 !== null ? custom.x2 : 0;
                        if (currentOffsetZ === null) currentOffsetZ = custom.z !== null ? custom.z : 0;
                    }
                } else if (levelVal !== null && !isNaN(parseInt(levelVal, 10))) {
                    const lvl = window.LaserCalibration ? window.LaserCalibration.getLevel(parseInt(levelVal, 10)) : null;
                    if (lvl) {
                        if (currentOffsetX1 === null) currentOffsetX1 = lvl.x1 !== null ? lvl.x1 : 0;
                        if (currentOffsetX2 === null) currentOffsetX2 = lvl.x2 !== null ? lvl.x2 : 0;
                        if (currentOffsetZ === null) currentOffsetZ = lvl.z;
                    }
                }

                if (fullStr.includes("VOXEL") || fullStr.includes("Voxel") || fullStr.includes("Wobble") || fullStr.includes("wobble")) {
                    currentChunkType = "Wobble";
                } else if (currentChunkLabel.includes("Wall Smooth") && /DeepMode\s*:?\s*True/i.test(fullStr)) {
                    currentChunkType = "Deep Wall";
                } else if (currentChunkLabel.includes("Wall Smooth")) {
                    currentChunkType = "Wall Smooth";
                } else if (currentChunkLabel.includes("Smooth Pass") || currentChunkLabel.includes("Top Surface") || currentChunkLabel.includes("Grouped Slope") || currentChunkLabel.includes("Global")) {
                    currentChunkType = "Top Surface";
                } else if (currentChunkLabel.includes("Anneal")) {
                    currentChunkType = "Anneal";
                } else if (currentChunkLabel.includes("Rivet")) {
                    currentChunkType = "Rivet";
                } else if (currentChunkLabel.includes("Cut")) {
                    currentChunkType = "Cut";
                } else if (currentChunkLabel.includes("Connectivity")) {
                    currentChunkType = "Connectivity";
                } else {
                    currentChunkType = "Wall Smooth";
                }
                
                let isAdaptiveSlope = /AdaptiveSlope\s*:\s*True/i.test(fullStr);
                let isIslandChunk = /IslandChunk\s*:\s*True/i.test(fullStr);
                let isVoxelWall = /VOXEL|Voxel/i.test(fullStr);
                let isVoxelRaycast = /VOXEL RAYCAST|voxel_raycast/i.test(fullStr) || (gcodeSettings && (gcodeSettings.wall_mode_pass1 === "voxel_raycast" || gcodeSettings.mode === "voxel_raycast"));

                currentChunkIdx++;
                laserChunks.push({
                    label: fullStr.replace(/^;\s*==\s*/, "").replace(/\s*==$/, "").trim(),
                    type: currentChunkType,
                    layer: currentLayer,
                    idx: currentChunkIdx,
                    zDrop: currentZDrop,
                    offsetX1: currentOffsetX1,
                    offsetX2: currentOffsetX2,
                    offsetZ: currentOffsetZ,
                    topZ: topZ,
                    operatingZ: operatingZ,
                    level: levelVal,
                    isVoxelWall: isVoxelWall,
                    isVoxelRaycast: isVoxelRaycast,
                    adaptiveSlope: isAdaptiveSlope,
                    islandChunk: isIslandChunk,
                    pins: {}
                });
            } else if (laserChunks.length === 0) {
                currentChunkIdx++;
                laserChunks.push({
                    label: fullStr.replace(/^;\s*==\s*/, "").replace(/\s*==$/, "").trim(),
                    type: currentChunkType || "Wall Smooth",
                    layer: currentLayer,
                    idx: currentChunkIdx,
                    zDrop: currentZDrop,
                    offsetX1: null,
                    offsetX2: null,
                    offsetZ: null,
                    topZ: null,
                    operatingZ: null,
                    level: null,
                    isVoxelWall: false,
                    pins: {}
                });
            }
        }

        if (fullStr.startsWith("; ==") && fullStr.includes("End")) {
            inLaserBlock = false;
            laserPowers = { 1: 0, 2: 0, 3: 0 };
        }
        
        // Laser PWM & Pin Commands
        if (upperCmd.startsWith("SET_PIN")) {
            const valMatch = str.match(/VALUE=([\d.]+)/i);
            let lPower = valMatch ? parseFloat(valMatch[1]) : 0;
            const pinMatch = str.match(/PIN=([^\s]+)/i);
            if (pinMatch) {
                const pinName = pinMatch[1];
                if (pinName.includes('1')) laserPowers[1] = lPower;
                else if (pinName.includes('2')) laserPowers[2] = lPower;
                else if (pinName.includes('3')) laserPowers[3] = lPower;
            }
        } else if (upperCmd.startsWith("LASER_ON")) {
            const laserMatch = str.match(/LASER=([123])/i);
            const pwrMatch = str.match(/POWER=([\d.]+)/i);
            const p = laserMatch ? parseInt(laserMatch[1]) : 1;
            const pwr = pwrMatch ? parseFloat(pwrMatch[1]) : 0.2;
            laserPowers[p] = pwr;
        } else if (upperCmd.startsWith("LASER_OFF")) {
            laserPowers = { 1: 0, 2: 0, 3: 0 };
        } else if (upperCmd.startsWith("LASER_SET")) {
            const dirMatch = str.match(/DIRECTION=([A-Za-z]+)/i);
            const pwrMatch = str.match(/POWER=([\d.]+)/i);
            const pwr = pwrMatch ? parseFloat(pwrMatch[1]) : 0.2;
            if (dirMatch && dirMatch[1].toUpperCase() === "MINUS") {
                laserPowers[2] = pwr; laserPowers[1] = 0;
            } else {
                laserPowers[1] = pwr; laserPowers[2] = 0;
            }
        }
        
        // Dwell Commands (G4 Riveting / Heating)
        if (upperCmd.startsWith("G4 ")) {
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
                        chunk.pins[p].positions.push(
                            currentX - s, currentY - s, currentZ, currentX + s, currentY + s, currentZ,
                            currentX - s, currentY + s, currentZ, currentX + s, currentY - s, currentZ,
                            currentX, currentY, currentZ, currentX, currentY, currentZ + s * 2
                        );
                        chunk.pins[p].layers.push(currentLayer, currentLayer, currentLayer, currentLayer, currentLayer, currentLayer);
                        chunk.pins[p].powers.push(lPower, lPower, lPower, lPower, lPower, lPower);
                        chunk.pins[p].speeds.push(0, 0, 0, 0, 0, 0);
                        if (lPower > maxPower) maxPower = lPower;
                        if (lPower > 0 && lPower < minPower) minPower = lPower;
                    }
                }
            }
        }
        
        // Motion Commands (G0, G1, G2, G3)
        if (upperCmd.startsWith("G0") || upperCmd.startsWith("G1") || upperCmd.startsWith("G2") || upperCmd.startsWith("G3")) {
            const isArc = upperCmd.startsWith("G2") || upperCmd.startsWith("G3");
            const isCW = upperCmd.startsWith("G2");
            
            let x = currentX, y = currentY, z = currentZ, e = currentE;
            let moveX = false, moveY = false, moveZ = false, hasE = false;
            let iOffset = 0, jOffset = 0, pRotations = 0;
            
            WORD_REGEX.lastIndex = 0;
            let match;
            while ((match = WORD_REGEX.exec(str)) !== null) {
                const char = match[1].toUpperCase();
                const val = parseFloat(match[2]);
                if (char === 'X') { x = isAbsolute ? val : currentX + val; moveX = true; }
                else if (char === 'Y') { y = isAbsolute ? val : currentY + val; moveY = true; }
                else if (char === 'Z') { z = isAbsolute ? val : currentZ + val; moveZ = true; }
                else if (char === 'E') { e = isRelE ? val : val - lastE; hasE = true; }
                else if (char === 'F') { currentF = val; }
                else if (char === 'I') { iOffset = val; }
                else if (char === 'J') { jOffset = val; }
                else if (char === 'P') { pRotations = parseInt(val); }
            }
            
            let isMove = moveX || moveY || moveZ;
            let dE = hasE ? (isRelE ? e : e) : 0;
            if (hasE && !isRelE) lastE = currentE + e;
            
            if (inPurgeBlock) {
                purgeLines.positions.push(currentX, currentY, currentZ, x, y, z);
                purgeLines.layers.push(currentLayer, currentLayer);
                if (fullStr.includes("unretract the snap")) {
                    inPurgeBlock = false;
                }
            } else if (isMove && (x !== currentX || y !== currentY || z !== currentZ)) {
                let anyLaser = laserPowers[1] > 0 || laserPowers[2] > 0 || laserPowers[3] > 0;
                
                const addSegment = (px, py, pz, nx, ny, nz) => {
                    if (hasE && dE > 1e-5) {
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
                                    topZ: null,
                                    operatingZ: null,
                                    level: null,
                                    isVoxelWall: false,
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
                    
                    const angleDiff = Math.abs(endAngle - startAngle);
                    const radius = Math.hypot(iOffset, jOffset);
                    const arcLen = radius * angleDiff;
                    const segments = Math.max(1, Math.ceil(arcLen / 1.0));
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
            if (moveX) currentX = x;
            if (moveY) currentY = y;
            if (moveZ) currentZ = z;
        }
    }
    
    console.log(`Parsed G-code in ${(performance.now() - t0).toFixed(1)}ms. Chunks: ${laserChunks.length}`);
    updateLegend();
    buildScene();
}

// =====================================================================
// SCENE BUILDING & RENDERING
// =====================================================================
function buildScene() {
    if (fdmMesh) scene.remove(fdmMesh);
    if (travelMesh) scene.remove(travelMesh);
    if (purgeMesh) scene.remove(purgeMesh);
    laserMeshes.forEach(m => scene.remove(m));
    laserMeshes = [];
    
    // Create FDM mesh
    if (fdmLines.positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(fdmLines.positions, 3));
        const mat = new THREE.LineBasicMaterial({ color: COLORS.fdm, transparent: true, opacity: 0.25 });
        fdmMesh = new THREE.LineSegments(geo, mat);
        scene.add(fdmMesh);
    }
    
    // Create Travel mesh
    if (travelLines.positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(travelLines.positions, 3));
        const mat = new THREE.LineBasicMaterial({ color: COLORS.travel, transparent: true, opacity: 0.1 });
        travelMesh = new THREE.LineSegments(geo, mat);
        travelMesh.visible = false;
        scene.add(travelMesh);
    }

    // Create Purge mesh
    if (purgeLines.positions.length > 0) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(purgeLines.positions, 3));
        const mat = new THREE.LineBasicMaterial({ color: 0x9b59b6, linewidth: 1 });
        purgeMesh = new THREE.LineSegments(geo, mat);
        scene.add(purgeMesh);
    }
    
    // Create Laser Chunk Meshes
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
                if (parseInt(pinKey) === 1) color = new THREE.Color(0xff4757); // Red (X+)
                else if (parseInt(pinKey) === 2) color = new THREE.Color(0x2ed573); // Green (X-)
                else if (parseInt(pinKey) === 3) color = new THREE.Color(0x3742fa); // Blue (Top)
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
                offsetZ: chunk.offsetZ,
                topZ: chunk.topZ,
                operatingZ: chunk.operatingZ,
                level: chunk.level,
                isVoxelWall: chunk.isVoxelWall,
                isVoxelRaycast: chunk.isVoxelRaycast,
                label: chunk.label
            };
            laserMeshes.push(mesh);
            scene.add(mesh);
        });
    });
    
    updateUI();
    applyOffsets();
    loading.classList.add('hidden');
    uiContainer.classList.remove('hidden');
    
    // Fit camera
    if (fdmMesh) {
        fdmMesh.geometry.computeBoundingSphere();
        const center = fdmMesh.geometry.boundingSphere.center;
        controls.target.copy(center);
        camera.position.set(center.x, center.y + 120, center.z + 120);
        controls.update();
    }
}

// =====================================================================
// UI LOGIC & CONTROLS
// =====================================================================
let maxLayer = 0;
let totalChunks = 0;

function updateUI() {
    maxLayer = 0;
    for (let i = 0; i < fdmLines.layers.length; i++) {
        if (fdmLines.layers[i] > maxLayer) maxLayer = fdmLines.layers[i];
    }
    laserChunks.forEach(c => {
        if (c.layer > maxLayer) maxLayer = c.layer;
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
    chunkS.max = Math.max(0, totalChunks - 1);
    chunkS.value = -1;
    document.getElementById('chunk-idx-val').innerText = "All";
    document.getElementById('chunk-info').innerText = "Showing all chunks (" + totalChunks + " total).";
    
    const chunkSelect = document.getElementById('chunk-select');
    if (chunkSelect) {
        chunkSelect.innerHTML = '<option value="-1">All Chunks (' + totalChunks + ' total)</option>' +
            laserChunks.map((c, i) => `<option value="${i}">Chunk ${i + 1} (Layer ${c.layer}): ${c.type} ${c.zDrop > 0 ? '(Z Drop: ' + c.zDrop.toFixed(2) + 'mm)' : ''}${c.adaptiveSlope ? ' [Adaptive]' : ''}</option>`).join('');
        chunkSelect.value = "-1";
    }
    
    updateVisibility();
}

// Sliders
document.getElementById('min-layer').addEventListener('input', (e) => {
    document.getElementById('min-layer-val').innerText = e.target.value;
    updateVisibility();
});
document.getElementById('max-layer').addEventListener('input', (e) => {
    document.getElementById('max-layer-val').innerText = e.target.value;
    updateVisibility();
});

const chunkSliderEl = document.getElementById('chunk-slider');
const chunkSelectEl = document.getElementById('chunk-select');

function setChunkIndex(val) {
    if (chunkSliderEl) chunkSliderEl.value = val;
    if (chunkSelectEl) chunkSelectEl.value = val;
    if (val === -1) {
        document.getElementById('chunk-idx-val').innerText = "All";
        document.getElementById('chunk-info').innerText = "Showing all chunks (" + totalChunks + " total).";
    } else {
        document.getElementById('chunk-idx-val').innerText = val + 1;
        if (laserChunks[val]) {
            document.getElementById('chunk-info').innerText = laserChunks[val].label;
        }
    }
    updateVisibility();
}

if (chunkSliderEl) chunkSliderEl.addEventListener('input', (e) => setChunkIndex(parseInt(e.target.value)));
if (chunkSelectEl) chunkSelectEl.addEventListener('change', (e) => setChunkIndex(parseInt(e.target.value)));

// Feature toggles
['fdm', 'travel', 'purge', 'wall-smooth', 'deep-wall', 'top-smooth', 'anneal', 'wobble', 'connectivity', 'preheat', 'pin-1', 'pin-2', 'pin-3'].forEach(id => {
    const el = document.getElementById('show-' + id);
    if (el) el.addEventListener('change', updateVisibility);
});

// Offset Level Preset selector
const wallLevel = document.getElementById('wall-level');
if (wallLevel) {
    wallLevel.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === 'custom' && window.LaserCalibration && window.LaserCalibration.getCustomLevel) {
            const custom = window.LaserCalibration.getCustomLevel();
            if (custom) {
                setWallOffsets(custom.x1 !== null ? custom.x1 : 0, custom.x2 !== null ? custom.x2 : 0, custom.z !== null ? custom.z : 0);
            }
            return;
        }
        const lvlIdx = parseInt(val, 10);
        if (!isNaN(lvlIdx) && window.LaserCalibration) {
            const lvl = window.LaserCalibration.getLevel(lvlIdx);
            if (lvl) {
                setWallOffsets(lvl.x1 !== null ? lvl.x1 : 0, lvl.x2 !== null ? lvl.x2 : 0, lvl.z);
            }
        }
    });
}

function syncVisualizerCalibration() {
    if (!window.LaserCalibration) return;
    const levels = window.LaserCalibration.getLevels();
    const select = document.getElementById('wall-level');
    if (!select) return;
    Array.from(select.options).forEach(opt => {
        if (opt.value === 'custom' && window.LaserCalibration.getCustomLevel) {
            const custom = window.LaserCalibration.getCustomLevel();
            if (custom && custom.z !== null && custom.x1 !== null && custom.x2 !== null) {
                opt.textContent = `Custom Level (Z=${custom.z.toFixed(1)}, X1=${custom.x1 > 0 ? '+' : ''}${custom.x1.toFixed(1)}, X2=${custom.x2.toFixed(1)})`;
            } else {
                opt.textContent = `Custom Level [Uncalibrated]`;
            }
            return;
        }
        const idx = parseInt(opt.value, 10);
        if (!isNaN(idx)) {
            const l = levels[idx];
            if (l) {
                if (l.x1 !== null && l.x2 !== null) {
                    opt.textContent = `Level ${l.level} (Z=${l.z.toFixed(1)}, X1=${l.x1 > 0 ? '+' : ''}${l.x1.toFixed(1)}, X2=${l.x2.toFixed(1)})`;
                } else {
                    opt.textContent = `Level ${l.level} (Z=${l.z.toFixed(1)}) [Uncalibrated]`;
                }
            }
        }
    });

    const currentVal = select.value;
    if (currentVal === 'custom' && window.LaserCalibration.getCustomLevel) {
        const custom = window.LaserCalibration.getCustomLevel();
        if (custom && custom.z !== null && custom.x1 !== null && custom.x2 !== null) {
            setWallOffsets(custom.x1, custom.x2, custom.z);
        } else {
            setWallOffsets(0, 0, custom && custom.z !== null ? custom.z : 0);
        }
    } else {
        const lvlIdx = parseInt(currentVal, 10);
        if (!isNaN(lvlIdx)) {
            const lvl = levels[lvlIdx];
            if (lvl && lvl.x1 !== null && lvl.x2 !== null) {
                setWallOffsets(lvl.x1, lvl.x2, lvl.z);
            } else {
                setWallOffsets(0, 0, lvl ? lvl.z : 0);
            }
        }
    }
}
window.addEventListener('laser-calibration-updated', syncVisualizerCalibration);
syncVisualizerCalibration();

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

// =====================================================================
// OPTICAL REVERSE PROJECTION & OFFSETS
// =====================================================================
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
            
            const isWobble = (m.userData.type === "Wobble" || (m.userData.label && m.userData.label.toUpperCase().includes("VOXEL")));
            
            if (projectWobble && lx !== 0 && lz !== 0 && isWobble) {
                const ratio = lx / lz;
                const isVoxelRaycast = m.userData.isVoxelRaycast || (m.userData.label && /VOXEL RAYCAST|voxel_raycast/i.test(m.userData.label));
                
                if (isVoxelRaycast) {
                    // NEW EXACT VOXEL RAYCAST 3D SURFACE PROJECTION
                    for (let k = 0; k < orig.length; k += 6) {
                        const sx = orig[k], sy = orig[k+1], sz = orig[k+2];
                        const ex = orig[k+3], ey = orig[k+4], ez = orig[k+5];
                        
                        let s_is_apex = false, e_is_apex = false;
                        if (lx > 0) {
                            s_is_apex = (sx > ex + 0.05);
                            e_is_apex = (ex > sx + 0.05);
                        } else {
                            s_is_apex = (sx < ex - 0.05);
                            e_is_apex = (ex < sx - 0.05);
                        }
                        
                        const s_disp = s_is_apex ? (sx - ex) : 0;
                        const e_disp = e_is_apex ? (ex - sx) : 0;
                        
                        const s_touchZ = s_is_apex ? (sz - lz - Math.abs(s_disp) / Math.abs(ratio)) : (sz - lz);
                        const e_touchZ = e_is_apex ? (ez - lz - Math.abs(e_disp) / Math.abs(ratio)) : (ez - lz);
                        
                        const s_touchX = s_is_apex ? (sx - lx - s_disp) : (sx - lx);
                        const e_touchX = e_is_apex ? (ex - lx - e_disp) : (ex - lx);
                        
                        pos[k]     = s_touchX;
                        pos[k + 1] = sy - ly;
                        pos[k + 2] = s_touchZ;
                        
                        pos[k + 3] = e_touchX;
                        pos[k + 4] = ey - ly;
                        pos[k + 5] = e_touchZ;
                    }
                } else {
                    // LEGACY SYSTEM (UNCHANGED)
                    for (let k = 0; k < orig.length; k += 6) {
                        const sx = orig[k], sy = orig[k+1], sz = orig[k+2];
                        const ex = orig[k+3], ey = orig[k+4], ez = orig[k+5];
                        
                        let s_baseX, e_baseX, s_dx, e_dx;
                        if (lx > 0) {
                            // Laser 1 (+X): Apex expands towards +X (larger X), Base is at smaller X
                            const baseX = Math.min(sx, ex);
                            s_dx = Math.max(0, sx - baseX);
                            e_dx = Math.max(0, ex - baseX);
                            s_baseX = baseX;
                            e_baseX = baseX;
                        } else {
                            // Laser 2 (-X): Apex expands towards -X (smaller X), Base is at larger X
                            const baseX = Math.max(sx, ex);
                            s_dx = Math.min(0, sx - baseX);
                            e_dx = Math.min(0, ex - baseX);
                            s_baseX = baseX;
                            e_baseX = baseX;
                        }
                        
                        pos[k]     = s_baseX - lx;
                        pos[k + 1] = sy - ly;
                        pos[k + 2] = sz - lz - (s_dx / ratio);
                        
                        pos[k + 3] = e_baseX - lx;
                        pos[k + 4] = ey - ly;
                        pos[k + 5] = ez - lz - (e_dx / ratio);
                    }
                }
            } else {
                for (let i = 0; i < orig.length; i += 3) {
                    pos[i]     = orig[i] - lx;
                    pos[i + 1] = orig[i + 1] - ly;
                    pos[i + 2] = orig[i + 2] - lz;
                }
            }
            
            m.geometry.attributes.position.needsUpdate = true;
            m.geometry.computeBoundingSphere();
            m.position.set(0, 0, 0);
        }
    });
}

document.getElementById('reset-btn').addEventListener('click', () => {
    uiContainer.classList.add('hidden');
    dropZone.classList.remove('hidden');
    if (fileInput) fileInput.value = '';
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
        
        if (data.layer < minL || data.layer > maxL) visible = false;
        if (chunkIdx !== -1 && data.idx !== chunkIdx) visible = false;
        
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
        mesh.geometry.setIndex(null);
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
    
    let html = '<table class="settings-table" style="width: 100%; border-collapse: collapse; font-size: 13px;"><tbody>';
    for (const [key, value] of Object.entries(gcodeSettings)) {
        html += `<tr style="border-bottom: 1px solid var(--panel-border);"><th style="text-align: left; padding: 6px; color: var(--text-muted);">${key}</th><td style="text-align: right; padding: 6px; color: #fff;">${value}</td></tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
}
