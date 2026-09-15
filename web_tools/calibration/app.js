/**
 * Laser 3D Suite — Offset Calibration Tool Application Logic
 * Manages physical laser offset calibration, 10mm cube alignment, 
 * custom positive-Z level management, and an interactive 3-step visual showcase.
 */

document.addEventListener('DOMContentLoaded', () => {
    const tableBody = document.getElementById('calibration-tbody');
    const customTableBody = document.getElementById('custom-calibration-tbody');
    const statusBanner = document.getElementById('status-banner');
    const statusBadge = document.getElementById('status-badge');
    const statusText = document.getElementById('status-text');
    const quickExportBtn = document.getElementById('btn-quick-export');
    
    const btnSaveBrowser = document.getElementById('btn-save-browser');
    const btnExportFile = document.getElementById('btn-export-file');
    const fileImportInput = document.getElementById('file-import-input');
    const btnClearCal = document.getElementById('btn-clear-cal');
    
    const canvas = document.getElementById('beam-canvas');
    const showcaseDescBox = document.getElementById('showcase-desc-box');
    const btnLaser1 = document.getElementById('btn-showcase-laser1');
    const btnLaser2 = document.getElementById('btn-showcase-laser2');
    const stepBtns = document.querySelectorAll('.showcase-step-btn');

    // Good vs Bad Alignment Toggle in HTML Instructions (Step 8)
    const btnGoodAlign = document.getElementById('btn-good-align');
    const btnBadAlign = document.getElementById('btn-bad-align');
    const laserSpotDemo = document.getElementById('laser-spot-demo');
    const alignDemoText = document.getElementById('align-demo-text');

    if (btnGoodAlign && btnBadAlign && laserSpotDemo && alignDemoText) {
        btnGoodAlign.addEventListener('click', () => {
            laserSpotDemo.style.top = '63px';
            alignDemoText.innerHTML = '<strong style="color: #10b981;">Correct:</strong> The exact center of the laser spot perfectly aligns with the center of the top layer (the middle of the layer\'s thickness).';
            btnGoodAlign.className = 'btn btn-success';
            btnBadAlign.className = 'btn btn-secondary';
        });

        btnBadAlign.addEventListener('click', () => {
            laserSpotDemo.style.top = '60px';
            alignDemoText.innerHTML = '<strong style="color: #ef4444;">Incorrect:</strong> Do not align the spot center to the absolute top edge of the part. It must be centered on the top layer itself.';
            btnGoodAlign.className = 'btn btn-secondary';
            btnBadAlign.className = 'btn btn-danger';
        });
    }

    // Visual Showcase State
    let currentShowcaseStep = 1; // 1: Touch-off, 2: Elevate Z, 3: Shift X & Beam Hit
    let currentShowcaseLaser = 1; // 1: Laser 1 (X+), 2: Laser 2 (X-)

    // 1. Render Table Rows (5 Fixed Levels + 1 Custom Level)
    function renderTable() {
        const levels = window.LaserCalibration.getLevels();
        tableBody.innerHTML = '';

        levels.forEach((lvl, idx) => {
            const tr = document.createElement('tr');
            
            const isRowCalibrated = (lvl.x1 !== null && !isNaN(lvl.x1) && lvl.x2 !== null && !isNaN(lvl.x2));
            const statusHtml = isRowCalibrated
                ? '<span style="color:#10b981; font-weight:600;">Calibrated</span>'
                : '<span style="color:#f59e0b; font-weight:600;">Missing</span>';

            tr.innerHTML = `
                <td><strong>Level ${lvl.level}</strong></td>
                <td><span class="z-badge">${lvl.z.toFixed(1)} mm</span></td>
                <td>
                    <input type="number" step="0.1" class="offset-input laser1" 
                           data-level="${idx}" data-laser="1" 
                           placeholder="e.g. +21.2"
                           value="${lvl.x1 !== null ? lvl.x1 : ''}">
                </td>
                <td>
                    <input type="number" step="0.1" class="offset-input laser2" 
                           data-level="${idx}" data-laser="2" 
                           placeholder="e.g. -21.2"
                           value="${lvl.x2 !== null ? lvl.x2 : ''}">
                </td>
                <td>${statusHtml}</td>
            `;
            tableBody.appendChild(tr);
        });

        // Render Custom Level Row
        const custom = window.LaserCalibration.getCustomLevel();
        const isCustomCal = window.LaserCalibration.isCustomCalibrated();
        const customStatusHtml = isCustomCal
            ? '<span style="color:#10b981; font-weight:600;">Calibrated</span>'
            : '<span style="color:#f59e0b; font-weight:600;">Incomplete</span>';

        customTableBody.innerHTML = `
            <tr style="background: rgba(139, 92, 246, 0.05);">
                <td><span class="custom-z-badge">Custom</span></td>
                <td>
                    <div style="display:flex; align-items:center; gap:4px;">
                        <input type="number" step="0.1" min="0.1" id="custom-z-input" 
                               class="offset-input" style="width: 75px; border-color: rgba(168, 85, 247, 0.4);"
                               value="${custom.z > 0 ? custom.z.toFixed(1) : '10.0'}"
                               title="Z standoff must be strictly positive (Z > 0 mm)">
                        <span style="font-size:0.8rem; color:#94a3b8;">mm</span>
                    </div>
                </td>
                <td>
                    <input type="number" step="0.1" id="custom-x1-input" class="offset-input laser1" 
                           placeholder="e.g. +21.2"
                           value="${custom.x1 !== null ? custom.x1 : ''}">
                </td>
                <td>
                    <input type="number" step="0.1" id="custom-x2-input" class="offset-input laser2" 
                           placeholder="e.g. -21.2"
                           value="${custom.x2 !== null ? custom.x2 : ''}">
                </td>
                <td id="custom-status-cell">${customStatusHtml}</td>
            </tr>
        `;

        // Attach input listeners for live showcase sync
        tableBody.querySelectorAll('.offset-input').forEach(inp => {
            inp.addEventListener('input', () => {
                drawShowcase();
            });
        });

        const customZInp = document.getElementById('custom-z-input');
        if (customZInp) {
            customZInp.addEventListener('input', () => {
                const val = parseFloat(customZInp.value);
                if (isNaN(val) || val <= 0) {
                    customZInp.style.borderColor = '#ef4444';
                    customZInp.style.boxShadow = '0 0 6px rgba(239, 68, 68, 0.5)';
                } else {
                    customZInp.style.borderColor = 'rgba(168, 85, 247, 0.4)';
                    customZInp.style.boxShadow = 'none';
                }
                drawShowcase();
            });
        }

        const customX1 = document.getElementById('custom-x1-input');
        const customX2 = document.getElementById('custom-x2-input');
        if (customX1) customX1.addEventListener('input', drawShowcase);
        if (customX2) customX2.addEventListener('input', drawShowcase);

        updateStatusBanner();
        drawShowcase();
    }

    // 2. Status Banner Update
    function updateStatusBanner() {
        const isCal = window.LaserCalibration.isCalibrated();
        const isCustomCal = window.LaserCalibration.isCustomCalibrated();
        if (isCal) {
            statusBanner.className = 'status-banner calibrated';
            statusBadge.className = 'status-badge calibrated';
            statusBadge.textContent = 'Calibrated';
            statusText.textContent = 'All 5 fixed Z standoff heights are calibrated and active. Your post-processor will receive these exact coordinates.';
            quickExportBtn.style.display = 'inline-flex';
        } else if (isCustomCal) {
            statusBanner.className = 'status-banner calibrated';
            statusBadge.className = 'status-badge calibrated';
            statusBadge.textContent = 'Custom Ready';
            statusText.textContent = 'Custom level is calibrated and ready. Fixed levels still require completion for standard presets.';
            quickExportBtn.style.display = 'inline-flex';
        } else {
            statusBanner.className = 'status-banner uncalibrated';
            statusBadge.className = 'status-badge uncalibrated';
            statusBadge.textContent = 'Uncalibrated';
            statusText.textContent = 'Zero default offsets are shipped for safety. Measure your machine offsets using the 10mm cube paper method.';
            quickExportBtn.style.display = 'none';
        }
    }

    // 3. Read current table values into arrays
    function readTableValues() {
        const levels = window.LaserCalibration.getLevels();
        tableBody.querySelectorAll('tr').forEach((tr, idx) => {
            const inp1 = tr.querySelector('.offset-input.laser1');
            const inp2 = tr.querySelector('.offset-input.laser2');
            const val1 = inp1 && inp1.value !== '' ? parseFloat(inp1.value) : null;
            const val2 = inp2 && inp2.value !== '' ? parseFloat(inp2.value) : null;
            levels[idx].x1 = (val1 !== null && !isNaN(val1)) ? val1 : null;
            levels[idx].x2 = (val2 !== null && !isNaN(val2)) ? val2 : null;
        });

        // Read custom level
        const czInp = document.getElementById('custom-z-input');
        const cx1Inp = document.getElementById('custom-x1-input');
        const cx2Inp = document.getElementById('custom-x2-input');
        let customZ = czInp ? parseFloat(czInp.value) : 10.0;
        if (isNaN(customZ) || customZ <= 0) customZ = 10.0;
        const customX1 = cx1Inp && cx1Inp.value !== '' ? parseFloat(cx1Inp.value) : null;
        const customX2 = cx2Inp && cx2Inp.value !== '' ? parseFloat(cx2Inp.value) : null;

        return {
            levels: levels,
            custom: {
                z: customZ,
                x1: (customX1 !== null && !isNaN(customX1)) ? customX1 : null,
                x2: (customX2 !== null && !isNaN(customX2)) ? customX2 : null
            }
        };
    }

    // Save Action
    function saveCurrentState() {
        const data = readTableValues();
        window.LaserCalibration.saveLevels(data.levels);
        try {
            window.LaserCalibration.saveCustomLevel(data.custom.z, data.custom.x1, data.custom.x2);
        } catch (err) {
            alert('Custom Level Error: ' + err.message);
            return false;
        }
        return true;
    }

    // Save to Browser Storage Button
    btnSaveBrowser.addEventListener('click', () => {
        if (saveCurrentState()) {
            renderTable();
            const orig = btnSaveBrowser.textContent;
            btnSaveBrowser.textContent = 'Saved to Browser!';
            btnSaveBrowser.style.background = '#10b981';
            setTimeout(() => {
                btnSaveBrowser.textContent = orig;
                btnSaveBrowser.style.background = '';
            }, 1800);
        }
    });

    // Hard-Save / Export File Button
    btnExportFile.addEventListener('click', () => {
        if (saveCurrentState()) {
            renderTable();
            window.LaserCalibration.exportJSON();
        }
    });

    // Import File
    fileImportInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                window.LaserCalibration.importJSON(evt.target.result);
                renderTable();
                alert('Calibration profile successfully imported!');
            } catch (err) {
                alert('Failed to import calibration file: ' + err.message);
            }
        };
        reader.readAsText(file);
    });

    // Reset / Clear Calibration
    btnClearCal.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear all calibrated offsets? Wall smoothing will be blocked until re-calibrated.')) {
            window.LaserCalibration.clearCalibration();
            renderTable();
        }
    });

    // 4. Interactive Step-by-Step Visual Showcase Logic
    stepBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            stepBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentShowcaseStep = parseInt(btn.getAttribute('data-step'), 10);
            drawShowcase();
        });
    });

    btnLaser1.addEventListener('click', () => {
        btnLaser1.classList.add('active');
        btnLaser2.classList.remove('active');
        currentShowcaseLaser = 1;
        drawShowcase();
    });

    btnLaser2.addEventListener('click', () => {
        btnLaser2.classList.add('active');
        btnLaser1.classList.remove('active');
        currentShowcaseLaser = 2;
        drawShowcase();
    });

    function drawShowcase() {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;

        ctx.clearRect(0, 0, W, H);

        // Ground / Print Bed
        const groundY = H - 35;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(25, groundY);
        ctx.lineTo(W - 25, groundY);
        ctx.stroke();

        // Print Bed Grid lines
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        for (let gx = 30; gx < W - 30; gx += 20) {
            ctx.beginPath();
            ctx.moveTo(gx, groundY);
            ctx.lineTo(gx - 10, groundY + 12);
            ctx.stroke();
        }

        // 10mm Cube Representation
        // Scale: 4.5 pixels = 1mm
        const scale = 4.5;
        const cubeW = 10 * scale; // 45px
        const cubeH = 10 * scale; // 45px
        const cubeX = W / 2 - cubeW / 2; // 257.5
        const cubeY = groundY - cubeH; // 200

        if (currentShowcaseStep === 1 || currentShowcaseStep === 2) {
            // In Steps 1 & 2: User prints the 10mm cube, then REMOVES it from the bed before homing!
            // Bed center has dashed outline showing cleared print area ready for G28 homing
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(cubeX, cubeY, cubeW, cubeH);
            ctx.setLineDash([]);
            
            ctx.fillStyle = '#64748b';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Bed Cleared for Safe Homing', W / 2, groundY - cubeH / 2 + 4);

            // Removed cube shown off-bed on holding staging area
            const offBedX = 45;
            const offBedY = groundY - cubeH;
            ctx.fillStyle = 'rgba(30, 41, 59, 0.95)';
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 1.5;
            ctx.fillRect(offBedX, offBedY, cubeW, cubeH);
            ctx.strokeRect(offBedX, offBedY, cubeW, cubeH);

            ctx.fillStyle = '#38bdf8';
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('10mm Cube', offBedX + cubeW / 2, offBedY + 18);
            ctx.fillStyle = '#94a3b8';
            ctx.font = '9px Inter, sans-serif';
            ctx.fillText('(Removed from Bed)', offBedX + cubeW / 2, offBedY + 31);

            // Motion arrow from bed to off-bed indicating removal
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(cubeX, cubeY + cubeH / 2);
            ctx.quadraticCurveTo((cubeX + offBedX + cubeW) / 2, cubeY - 18, offBedX + cubeW + 6, offBedY + cubeH / 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // Arrowhead pointing left
            ctx.fillStyle = '#38bdf8';
            ctx.beginPath();
            ctx.moveTo(offBedX + cubeW + 6, offBedY + cubeH / 2);
            ctx.lineTo(offBedX + cubeW + 12, offBedY + cubeH / 2 - 4);
            ctx.lineTo(offBedX + cubeW + 12, offBedY + cubeH / 2 + 4);
            ctx.closePath();
            ctx.fill();

            ctx.font = '9px Inter, sans-serif';
            ctx.fillStyle = '#38bdf8';
            ctx.textAlign = 'center';
            ctx.fillText('Remove part before G28 homing', (cubeX + offBedX + cubeW) / 2, cubeY - 24);
        } else {
            // Steps 3 through 9: 10mm Cube is placed on the bed
            ctx.fillStyle = 'rgba(30, 41, 59, 0.9)';
            ctx.strokeStyle = '#64748b';
            ctx.lineWidth = 1.5;
            ctx.fillRect(cubeX, cubeY, cubeW, cubeH);

            // Draw top layer (e.g. 3px thick)
            ctx.fillStyle = '#64748b';
            ctx.fillRect(cubeX, cubeY, cubeW, 3);
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.moveTo(cubeX, cubeY + 3);
            ctx.lineTo(cubeX + cubeW, cubeY + 3);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.strokeStyle = '#64748b';
            ctx.strokeRect(cubeX, cubeY, cubeW, cubeH);

            // Cube Label
            ctx.fillStyle = '#94a3b8';
            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('10mm Cube', W / 2, groundY - cubeH / 2 + 4);
        }

        // Paper Sheet on top of cube:
        // STRICT REQUIREMENT: Only render paper sheet in Step 4 (Paper Drag Touch-Off).
        // For all other steps, the paper sheet is NOT drawn.
        const paperThickness = 4;
        const paperX = cubeX - 18;
        const paperW = cubeW + 36;
        const paperY = cubeY - paperThickness;

        if (currentShowcaseStep === 4) {
            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(paperX, paperY, paperW, paperThickness);
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 1;
            ctx.strokeRect(paperX, paperY, paperW, paperThickness);

            // Paper Label
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('A4 Paper (0.1mm)', paperX - 95, paperY + 3);
            ctx.strokeStyle = 'rgba(203, 213, 225, 0.4)';
            ctx.beginPath();
            ctx.moveTo(paperX - 8, paperY + 2);
            ctx.lineTo(paperX + 2, paperY + 2);
            ctx.stroke();
        }

        // Target Calibration Edge (Top right outer corner for Laser 1 X+, Top left outer corner for Laser 2 X-)
        const targetX = (currentShowcaseLaser === 1) ? (cubeX + cubeW) : cubeX;
        const targetY = cubeY;

        // Target Marker Dot on Edge (Steps 4 through 6)
        if (currentShowcaseStep >= 4 && currentShowcaseStep <= 6) {
            ctx.fillStyle = '#eab308';
            ctx.beginPath();
            ctx.arc(targetX, targetY, 4, 0, Math.PI * 2);
            ctx.fill();
        }

        // Standoff Z & Lateral Shift X
        // For showcase, use fixed Level 2 (10mm Z) as reference
        const zOffMm = 10.0;
        const zOffPx = zOffMm * scale; // 45px
        
        // Lookup or default X offset
        const levels = window.LaserCalibration.getLevels();
        let xOffMm = (currentShowcaseLaser === 1) ? levels[2].x1 : levels[2].x2;
        if (xOffMm === null || isNaN(xOffMm)) {
            xOffMm = (currentShowcaseLaser === 1) ? 21.2 : -21.2;
        }
        const xOffPx = Math.abs(xOffMm) * scale; // 95.4px

        const laserColor = (currentShowcaseLaser === 1) ? '#00f0ff' : '#ef4444';
        const laserName = (currentShowcaseLaser === 1) ? 'Laser 1 (X+ Right Diode)' : 'Laser 2 (X- Left Diode)';
        const signStr = (currentShowcaseLaser === 1) ? `+${Math.abs(xOffMm).toFixed(1)}` : `-${Math.abs(xOffMm).toFixed(1)}`;
        const offsetSign = (currentShowcaseLaser === 1) ? '+ΔX' : '-ΔX';

        let headX = W / 2;
        let headY = 55;

        // Determine toolhead position & step specific decorations
        if (currentShowcaseStep === 1) {
            // Step 1: Print & Remove Cube from Bed (Toolhead parked high up)
            headX = W / 2;
            headY = 55;

            ctx.fillStyle = '#38bdf8';
            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Toolhead Parked / Bed Cleared', headX, headY - 45);

            showcaseDescBox.innerHTML = `
                <strong style="color: #38bdf8;">Step 1: Print &amp; Remove Cube</strong><br>
                Print the 10x10x10 mm cube. <strong>Crucial Safety Rule:</strong> Once done, remove the cube from the bed! Do not home the printer while the cube is on the bed.
            `;
        } else if (currentShowcaseStep === 2) {
            // Step 2: Home Printer on Empty Bed
            headX = W / 2;
            headY = groundY - 40; // Homed close to empty bed

            // Motion Arrow from park to homed
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(headX, 55);
            ctx.lineTo(headX, headY - 42);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = '#38bdf8';
            ctx.beginPath();
            ctx.moveTo(headX - 4, headY - 46); ctx.lineTo(headX + 4, headY - 46); ctx.lineTo(headX, headY - 40); ctx.fill();

            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Homed on Empty Bed', headX, headY - 50);

            showcaseDescBox.innerHTML = `
                <strong style="color: #38bdf8;">Step 2: Home Printer (Empty Bed)</strong><br>
                Use your printer's menu to home all axes while the bed is empty. This ensures the printer finds its true zero safely.
            `;
        } else if (currentShowcaseStep === 3) {
            // Step 3: Move Up and Place Cube Under Nozzle (+20mm clearance)
            headX = W / 2;
            headY = cubeY - 20 * scale; // 200 - 90 = 110

            // Motion Arrow from homed to clearance height
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(headX, groundY - 40);
            ctx.lineTo(headX, headY + 32); // arrow pointing up
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = '#38bdf8';
            ctx.beginPath();
            ctx.moveTo(headX - 4, headY + 36); ctx.lineTo(headX + 4, headY + 36); ctx.lineTo(headX, headY + 30); ctx.fill();

            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Elevated +20mm Clearance & Cube Placed', headX, headY - 50);

            showcaseDescBox.innerHTML = `
                <strong style="color: #38bdf8;">Step 3: Place Cube Under Nozzle</strong><br>
                Move the toolhead up to give you clearance, then place the 10mm cube back on the bed, directly under the nozzle.
            `;
        } else if (currentShowcaseStep === 4) {
            // Step 4: Paper Drag Touch-Off Baseline
            headX = W / 2;
            headY = paperY; // tip touches paper

            // Touch-off highlight circle
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.arc(headX, headY, 12, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = '#34d399';
            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = (currentShowcaseLaser === 1) ? 'left' : 'right';
            ctx.fillText('Paper Friction Contact (Z₀ Baseline)', headX + (currentShowcaseLaser === 1 ? 18 : -18), headY - 4);

            showcaseDescBox.innerHTML = `
                <strong style="color: #34d399;">Step 4: Find Z Baseline</strong><br>
                Place a paper sheet on the cube. Use the printer's menu to slowly lower the nozzle until you feel light friction. This sets your Z baseline.
            `;
        } else if (currentShowcaseStep === 5) {
            // Step 5: Align Nozzle Tip to Cube Outer Wall Edge (Paper Removed!)
            headX = targetX;
            headY = cubeY; // Nozzle tip flush with outer wall corner

            // Alignment guide vertical line
            ctx.strokeStyle = '#eab308';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(targetX, groundY);
            ctx.lineTo(targetX, headY - 45);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = '#fbbf24';
            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = (currentShowcaseLaser === 1) ? 'left' : 'right';
            ctx.fillText('Nozzle Tip Flush with Wall Edge (X₀ Baseline)', targetX + (currentShowcaseLaser === 1 ? 16 : -16), headY - 6);

            showcaseDescBox.innerHTML = `
                <strong style="color: #eab308;">Step 5: Align Nozzle to Cube Edge</strong><br>
                <strong>Remove the paper sheet.</strong> Move the toolhead along X until the nozzle tip aligns perfectly flush with the cube's vertical edge. This sets your X baseline.
            `;
        } else if (currentShowcaseStep === 6) {
            // Step 6: Select Target Laser Diode & Standoff Level
            headX = targetX;
            headY = cubeY;

            // Show selected diode angle indicator
            const selDiodeX = (currentShowcaseLaser === 1) ? (headX + 42) : (headX - 42);
            const selDiodeY = headY - 23;

            ctx.strokeStyle = laserColor;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(selDiodeX, selDiodeY);
            // Project inward at 22 deg
            const angleProjX = (currentShowcaseLaser === 1) ? (selDiodeX - 42) : (selDiodeX + 42);
            ctx.lineTo(angleProjX, headY);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = laserColor;
            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = (currentShowcaseLaser === 1) ? 'left' : 'right';
            ctx.fillText(`${laserName} Selected (22° Inward Incline)`, selDiodeX + (currentShowcaseLaser === 1 ? 14 : -14), selDiodeY - 8);

            showcaseDescBox.innerHTML = `
                <strong style="color: ${laserColor};">Step 6: Select Laser &amp; Height</strong><br>
                Selected <strong>${laserName}</strong> and your chosen Z standoff height (e.g., Level 2, 10mm). Because the laser is angled, the beam will strike further away the higher you go.
            `;
        } else if (currentShowcaseStep === 7) {
            // Step 7: Elevate to Standoff & Execute Calibration Command
            headX = targetX;
            headY = cubeY - zOffPx;

            // Vertical Dimension Line for +Z
            const dimX = headX + (currentShowcaseLaser === 1 ? 28 : -28);
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(dimX, cubeY);
            ctx.lineTo(dimX, headY);
            ctx.stroke();
            ctx.setLineDash([]);

            // Z Dimension Arrow Caps
            ctx.fillStyle = '#38bdf8';
            ctx.beginPath();
            ctx.moveTo(dimX - 4, cubeY); ctx.lineTo(dimX + 4, cubeY); ctx.lineTo(dimX, cubeY - 5); ctx.fill();
            ctx.beginPath();
            ctx.moveTo(dimX - 4, headY); ctx.lineTo(dimX + 4, headY); ctx.lineTo(dimX, headY + 5); ctx.fill();

            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = (currentShowcaseLaser === 1) ? 'left' : 'right';
            ctx.fillText(`+Z Standoff (${zOffMm.toFixed(1)} mm)`, dimX + (currentShowcaseLaser === 1 ? 8 : -8), (cubeY + headY) / 2 + 3);

            // Active elevated diode coordinates
            const actDX = (currentShowcaseLaser === 1) ? (headX + 42) : (headX - 42);
            const actDY = headY - 23;
            // Angled beam projects toward bed surface far laterally
            const bedHitX = (currentShowcaseLaser === 1) ? (actDX - (42 + 95.4 - 42)) : (actDX + (42 + 95.4 - 42));

            // Dashed pulsing beam
            ctx.strokeStyle = laserColor;
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(actDX, actDY);
            ctx.lineTo(bedHitX, groundY);
            ctx.stroke();
            ctx.setLineDash([]);

            // Spot on bed
            ctx.fillStyle = laserColor;
            ctx.beginPath();
            ctx.arc(bedHitX, groundY, 4, 0, Math.PI * 2);
            ctx.fill();

            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('0.08 Pulse Hits Bed', bedHitX, groundY + 16);

            showcaseDescBox.innerHTML = `
                <strong style="color: #38bdf8;">Step 7: Move Z Up &amp; Turn on Laser</strong><br>
                Use the printer menu to move up by your chosen height (e.g. <strong>+10mm</strong>). Then, run your laser test macro to turn the laser on at low power. The beam will hit the bed off to the side.
            `;
        } else if (currentShowcaseStep === 8) {
            // Step 8: Shift X Axis & Align Rectangular Beam Mean Center Dead-Center
            headX = (currentShowcaseLaser === 1) ? (targetX + xOffPx) : (targetX - xOffPx);
            headY = cubeY - zOffPx;

            // Horizontal Dimension Line for ΔX
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(targetX, headY - 42);
            ctx.lineTo(headX, headY - 42);
            ctx.stroke();
            ctx.setLineDash([]);

            // Arrow Caps
            ctx.fillStyle = '#f59e0b';
            ctx.beginPath();
            ctx.moveTo(targetX, headY - 46); ctx.lineTo(targetX, headY - 38); ctx.lineTo(targetX + (currentShowcaseLaser === 1 ? 5 : -5), headY - 42); ctx.fill();
            ctx.beginPath();
            ctx.moveTo(headX, headY - 46); ctx.lineTo(headX, headY - 38); ctx.lineTo(headX - (currentShowcaseLaser === 1 ? 5 : -5), headY - 42); ctx.fill();

            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`ΔX Offset (${signStr} mm)`, (targetX + headX) / 2, headY - 50);

            // Defocused Beam Centroid Annotation on canvas
            const annotX = (currentShowcaseLaser === 1) ? (targetX - 70) : (targetX + 70);
            const annotAlign = (currentShowcaseLaser === 1) ? 'right' : 'left';
            ctx.textAlign = annotAlign;
            ctx.fillStyle = '#34d399';
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.fillText('✓ Layer Center Aligned', annotX, targetY - 10);
            ctx.fillStyle = '#f87171';
            ctx.font = '9px Inter, sans-serif';
            ctx.fillText('✗ Do NOT align by absolute top edge', annotX, targetY + 3);
            ctx.fillStyle = '#94a3b8';
            ctx.font = '9px Inter, sans-serif';
            ctx.fillText('Rectangular Spot', annotX, targetY + 15);

            showcaseDescBox.innerHTML = `
                <strong style="color: ${laserColor};">Step 8: Find the X Offset</strong><br>
                Move the carriage sideways until the exact <strong>center</strong> of the laser spot perfectly aligns with the <strong>center of the top layer</strong> on the side wall, not the absolute top edge. Carriage travel distance is your offset: <strong>${signStr} mm</strong>.
            `;
        } else if (currentShowcaseStep === 9) {
            // Step 9: Record Calibrated Values & Save Configuration
            headX = (currentShowcaseLaser === 1) ? (targetX + xOffPx) : (targetX - xOffPx);
            headY = cubeY - zOffPx;

            // Show both dimensions
            // Horizontal ΔX
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(targetX, headY - 42);
            ctx.lineTo(headX, headY - 42);
            ctx.stroke();
            ctx.fillStyle = '#f59e0b';
            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`ΔX = ${signStr} mm`, (targetX + headX) / 2, headY - 50);

            // Calibrated Status Tag
            ctx.fillStyle = '#10b981';
            const badgeX = (currentShowcaseLaser === 1) ? targetX - 75 : targetX + 10;
            // Place it high up away from the cube and beam!
            ctx.fillRect(badgeX, headY + 15, 65, 18);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('✓ SAVED', badgeX + 32, headY + 27);

            showcaseDescBox.innerHTML = `
                <strong style="color: #10b981;">Step 9: Save Your Values</strong><br>
                Enter <strong>${signStr} mm</strong> into the table for ${laserName}. Click <strong>Save to Browser</strong> and <strong>Hard-Save Config (JSON)</strong>.
            `;
        }

        // Draw Brass Nozzle
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.moveTo(headX, headY);
        ctx.lineTo(headX - 9, headY - 18);
        ctx.lineTo(headX + 9, headY - 18);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Draw Toolhead Carriage Bar
        ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.fillRect(headX - 55, headY - 28, 110, 10);
        ctx.strokeRect(headX - 55, headY - 28, 110, 10);

        // Diode Positions on Toolhead Carriage
        // Laser 1 is on +X (right side, +42px), Laser 2 is on -X (left side, -42px)
        const d1X = headX + 42;
        const d1Y = headY - 23;
        const d2X = headX - 42;
        const d2Y = headY - 23;

        // Draw Laser 1 Diode Box
        const isL1Active = (currentShowcaseLaser === 1 && currentShowcaseStep >= 5);
        ctx.fillStyle = isL1Active ? '#00f0ff' : 'rgba(0, 240, 255, 0.3)';
        ctx.fillRect(d1X - 5, d1Y - 5, 10, 10);
        ctx.strokeStyle = isL1Active ? '#00f0ff' : 'rgba(0, 240, 255, 0.6)';
        ctx.strokeRect(d1X - 5, d1Y - 5, 10, 10);

        // Draw Laser 2 Diode Box
        const isL2Active = (currentShowcaseLaser === 2 && currentShowcaseStep >= 5);
        ctx.fillStyle = isL2Active ? '#ef4444' : 'rgba(239, 68, 68, 0.3)';
        ctx.fillRect(d2X - 5, d2Y - 5, 10, 10);
        ctx.strokeStyle = isL2Active ? '#ef4444' : 'rgba(239, 68, 68, 0.6)';
        ctx.strokeRect(d2X - 5, d2Y - 5, 10, 10);

        // Diode Labels
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#00f0ff';
        ctx.fillText('L1 (X+)', d1X, d1Y - 9);
        ctx.fillStyle = '#ef4444';
        ctx.fillText('L2 (X-)', d2X, d2Y - 9);

        // Draw Focused Laser Beam if Step 7 or Step 8 (Striking the Outer Wall Corner)
        if (currentShowcaseStep === 7 || currentShowcaseStep === 8) {
            const activeDiodeX = (currentShowcaseLaser === 1) ? d1X : d2X;
            const activeDiodeY = (currentShowcaseLaser === 1) ? d1Y : d2Y;

            // Glowing Angled Laser Beam
            ctx.strokeStyle = laserColor;
            ctx.lineWidth = 3;
            ctx.shadowColor = laserColor;
            ctx.shadowBlur = 12;
            ctx.beginPath();
            ctx.moveTo(activeDiodeX, activeDiodeY);
            ctx.lineTo(targetX, targetY);
            ctx.stroke();
            ctx.shadowBlur = 0; // reset shadow

            // Core beam
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(activeDiodeX, activeDiodeY);
            ctx.lineTo(targetX, targetY + 1.5);
            ctx.stroke();

            // Rectangular Beam Spot (Defocused Diode Profile)
            // Diode lasers produce a rectangular/elliptical emitter shape. The user wants it vertical on the wall.
            const rectW = 9;
            const rectH = 20;
            const spotCenterY = targetY + 1.5; // shift down 1.5px to align with center of 3px thick top layer

            // Outer glowing diffuse halo
            ctx.fillStyle = (currentShowcaseLaser === 1) ? 'rgba(0, 240, 255, 0.25)' : 'rgba(239, 68, 68, 0.25)';
            ctx.shadowColor = laserColor;
            ctx.shadowBlur = 14;
            ctx.fillRect(targetX - rectW / 2 - 3, spotCenterY - rectH / 2 - 2, rectW + 6, rectH + 4);

            // Solid rectangular core spot
            ctx.fillStyle = laserColor;
            ctx.shadowBlur = 8;
            ctx.fillRect(targetX - rectW / 2, spotCenterY - rectH / 2, rectW, rectH);
            ctx.shadowBlur = 0;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.strokeRect(targetX - rectW / 2, spotCenterY - rectH / 2, rectW, rectH);

            // Crosshairs bisecting the EXACT MEAN CENTER (centroid)
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(targetX - 16, spotCenterY); ctx.lineTo(targetX + 16, spotCenterY);
            ctx.moveTo(targetX, spotCenterY - 10); ctx.lineTo(targetX, spotCenterY + 10);
            ctx.stroke();

            // Centroid Dot
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(targetX, spotCenterY, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Initial render
    renderTable();
});
