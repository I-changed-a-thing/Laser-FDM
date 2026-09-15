/**
 * G-Code & Laser Kinematics Parser
 * Parses OrcaSlicer G-code + Laser Post-Processor Markers into a high-speed time-indexed timeline.
 * Supports full G0, G1 linear moves and G2, G3 circular arc interpolation with analytical precision.
 */

class GCodeParser {
  constructor() {
    this.segments = [];
    this.layers = [];
    this.laserPasses = [];
    const calLvl2 = (typeof window !== 'undefined' && window.LaserCalibration) ? window.LaserCalibration.getLevel(2) : null;
    this.laserSettings = {
      wall_offset_level: 2,
      wall_x_plus_offset: calLvl2 ? calLvl2.x1 : null,
      wall_x_minus_offset: calLvl2 ? calLvl2.x2 : null,
      wall_z_offset: calLvl2 ? calLvl2.z : 10.0,
      wall_power_plus: 0.08,
      wall_power_minus: 0.08,
      wall_mode_pass1: 'wobble',
      wall_smooth: true
    };
    this.totalTime = 0;
    this.maxZ = 0;
    this.bbox = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  }

  parse(gcodeText) {
    const lines = gcodeText.split(/\r?\n/);
    this.segments = [];
    this.layers = [];
    this.laserPasses = [];
    this.totalTime = 0;
    this.bbox = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };

    let currentX = 0, currentY = 0, currentZ = 0;
    let currentE = 0, currentF = 3000; // mm/min
    let isRelative = false;
    let isRelativeE = true;
    let currentLayer = 0;
    let currentWidth = 0.45;
    let currentHeight = 0.20;
    let currentFeature = 'Custom';
    let isInsideLaserBlock = false;
    
    // Strict Laser state
    let activeLaser = null; // 'laser_pwm1', 'laser_pwm2', 'laser_pwm3'
    let laserPower = 0.0;

    const calLvl2 = (typeof window !== 'undefined' && window.LaserCalibration) ? window.LaserCalibration.getLevel(2) : null;
    let offsetXPlus = (calLvl2 && calLvl2.x1 !== null) ? calLvl2.x1 : 0.0;
    let offsetXMinus = (calLvl2 && calLvl2.x2 !== null) ? calLvl2.x2 : 0.0;
    let offsetZ = calLvl2 ? calLvl2.z : 10.0;

    let smoothOffsetX = 34.0;
    let smoothOffsetY = 72.5;
    let smoothOffsetZ = 0.50;

    let cumulativeTime = 0;
    let currentPassObj = null;

    for (let i = 0; i < lines.length; i++) {
      let rawLine = lines[i].trim();
      if (!rawLine) continue;

      // 1. Check for LASER_SETTINGS JSON header
      if (rawLine.startsWith('; LASER_SETTINGS:')) {
        try {
          const jsonStr = rawLine.substring('; LASER_SETTINGS:'.length).trim();
          const settings = JSON.parse(jsonStr);
          this.laserSettings = { ...this.laserSettings, ...settings };

          if (settings.wall_offset_level !== undefined && settings.wall_offset_level !== null) {
            if (String(settings.wall_offset_level).toLowerCase() === 'custom') {
              if (typeof window !== 'undefined' && window.LaserCalibration) {
                const customCal = window.LaserCalibration.getCustomLevel();
                if (customCal && customCal.z > 0) {
                  offsetZ = customCal.z;
                  if (customCal.x1 !== null && customCal.x1 !== undefined) offsetXPlus = customCal.x1;
                  if (customCal.x2 !== null && customCal.x2 !== undefined) offsetXMinus = customCal.x2;
                }
              }
            } else {
              const lvl = parseInt(settings.wall_offset_level, 10);
              if (typeof window !== 'undefined' && window.LaserCalibration) {
                const cal = window.LaserCalibration.getLevel(lvl);
                if (cal) {
                  offsetZ = cal.z;
                  if (cal.x1 !== null && cal.x1 !== undefined) offsetXPlus = cal.x1;
                  if (cal.x2 !== null && cal.x2 !== undefined) offsetXMinus = cal.x2;
                }
              }
            }
          }

          if (settings.wall_x_plus_offset !== null && settings.wall_x_plus_offset !== undefined) offsetXPlus = settings.wall_x_plus_offset;
          if (settings.wall_x_minus_offset !== null && settings.wall_x_minus_offset !== undefined) offsetXMinus = settings.wall_x_minus_offset;
          if (settings.wall_z_offset !== null && settings.wall_z_offset !== undefined) offsetZ = settings.wall_z_offset;

          if (settings.smooth_offset_x !== null && settings.smooth_offset_x !== undefined) smoothOffsetX = settings.smooth_offset_x;
          if (settings.smooth_offset_y !== null && settings.smooth_offset_y !== undefined) smoothOffsetY = settings.smooth_offset_y;
          if (settings.smooth_z_hop !== null && settings.smooth_z_hop !== undefined) smoothOffsetZ = settings.smooth_z_hop;
        } catch (e) {
          console.warn('Failed to parse LASER_SETTINGS header:', e);
        }
        continue;
      }

      // 2. Check for Layer changes
      if (rawLine.startsWith(';LAYER:')) {
        const layerNum = parseInt(rawLine.substring(7).trim(), 10);
        if (!isNaN(layerNum)) {
          if (this.layers.length > 0) {
            this.layers[this.layers.length - 1].endSegment = this.segments.length;
          }
          currentLayer = layerNum;
          this.layers.push({
            layerIndex: currentLayer,
            startSegment: this.segments.length,
            endSegment: this.segments.length,
            zHeight: currentZ
          });
        }
        continue;
      }

      // 2b. Check for Layer Height & Line Width metadata
      if (rawLine.startsWith(';HEIGHT:')) {
        const hVal = parseFloat(rawLine.substring(8).trim());
        if (!isNaN(hVal) && hVal > 0) currentHeight = hVal;
        continue;
      }
      if (rawLine.startsWith(';WIDTH:')) {
        const wVal = parseFloat(rawLine.substring(7).trim());
        if (!isNaN(wVal) && wVal > 0) currentWidth = wVal;
        continue;
      }

      // 3. Check for Feature type comments
      if (rawLine.startsWith(';TYPE:')) {
        currentFeature = rawLine.substring(6).trim();
        continue;
      }

      // 4. Check for Laser Smoothing block markers (Wall Smooth & Top Surface Smooth)
      const isWallSmoothMarker = rawLine.includes('[Wall Smooth]') || rawLine.includes('[Wobble]') || rawLine.includes('Wall Smooth Pass');
      const isTopSmoothMarker = rawLine.includes('[Smooth Pass') || rawLine.includes('[Smooth]') || rawLine.includes('Top Surface Smooth') || rawLine.includes('Top Surface');
      const isLaserBlockMarker = isWallSmoothMarker || isTopSmoothMarker || rawLine.includes('[Rivet]');

      // Parse inline offsets from comments if present
      if (rawLine.includes('[Wall Smooth]') || rawLine.includes('Wobble')) {
        const ox1 = rawLine.match(/OffsetX1:\s*([-+]?[\d\.]+)/i);
        const ox2 = rawLine.match(/OffsetX2:\s*([-+]?[\d\.]+)/i);
        const oz  = rawLine.match(/OffsetZ:\s*([-+]?[\d\.]+)/i);
        if (ox1) offsetXPlus = parseFloat(ox1[1]);
        if (ox2) offsetXMinus = parseFloat(ox2[1]);
        if (oz)  offsetZ = parseFloat(oz[1]);
      }

      if (isLaserBlockMarker) {
        if (rawLine.includes('Start')) {
          isInsideLaserBlock = true;
          if (!currentPassObj) {
            let pType = 'wall_smooth';
            if (rawLine.includes('Wobble')) pType = 'wobble';
            else if (isTopSmoothMarker) pType = 'top_smooth';
            else if (rawLine.includes('Rivet')) pType = 'rivet';

            currentPassObj = {
              startSegment: this.segments.length,
              layerIndex: currentLayer,
              type: pType
            };
            this.laserPasses.push(currentPassObj);
          }
        } else if (rawLine.includes('End')) {
          isInsideLaserBlock = false;
          activeLaser = null;
          laserPower = 0.0;
          if (currentPassObj) {
            currentPassObj.endSegment = this.segments.length;
            currentPassObj = null;
          }
        }
      }

      // 5. Check for Laser SET_PIN commands (Strict ON/OFF tracking)
      if (rawLine.startsWith('SET_PIN')) {
        const pinMatch = rawLine.match(/PIN=([\w\d_]+)/);
        const valMatch = rawLine.match(/VALUE=([\d\.]+)/);
        if (pinMatch && valMatch) {
          const pin = pinMatch[1];
          const val = parseFloat(valMatch[1]);
          if (val > 0.001) {
            activeLaser = pin;
            laserPower = val;
          } else {
            if (activeLaser === pin || val === 0) {
              activeLaser = null;
              laserPower = 0.0;
            }
          }
        }
        continue;
      }

      // Strip comment from code for clean parameter evaluation
      const codePart = rawLine.split(';')[0].trim();
      if (!codePart) continue;

      // 6. Check for Positioning Modes
      if (codePart.startsWith('G90')) {
        isRelative = false;
        continue;
      }
      if (codePart.startsWith('G91')) {
        isRelative = true;
        continue;
      }
      if (codePart.startsWith('M82')) {
        isRelativeE = false;
        continue;
      }
      if (codePart.startsWith('M83')) {
        isRelativeE = true;
        continue;
      }
      if (codePart.startsWith('G92')) {
        const eVal = this._getVal(codePart, 'E');
        if (eVal !== null) currentE = eVal;
        continue;
      }

      // 7. Check for Linear Moves (G0, G1) and Arc Moves (G2, G3)
      if (codePart.startsWith('G0') || codePart.startsWith('G1') || codePart.startsWith('G2') || codePart.startsWith('G3')) {
        const cmd = codePart.substring(0, 2);
        const isG0 = (cmd === 'G0');
        const isArc = (cmd === 'G2' || cmd === 'G3');
        const isCW = (cmd === 'G2');

        const xVal = this._getVal(codePart, 'X');
        const yVal = this._getVal(codePart, 'Y');
        const zVal = this._getVal(codePart, 'Z');
        const eVal = this._getVal(codePart, 'E');
        const fVal = this._getVal(codePart, 'F');
        const iVal = this._getVal(codePart, 'I');
        const jVal = this._getVal(codePart, 'J');
        const rVal = this._getVal(codePart, 'R');

        if (fVal !== null) currentF = fVal;

        let targetX = currentX;
        let targetY = currentY;
        let targetZ = currentZ;
        let targetE = currentE;
        let deltaE = 0;

        if (isRelative) {
          if (xVal !== null) targetX = currentX + xVal;
          if (yVal !== null) targetY = currentY + yVal;
          if (zVal !== null) targetZ = currentZ + zVal;
          if (eVal !== null) {
            targetE = currentE + eVal;
            deltaE = eVal;
          }
        } else {
          if (xVal !== null) targetX = xVal;
          if (yVal !== null) targetY = yVal;
          if (zVal !== null) targetZ = zVal;
          if (eVal !== null) {
            if (isRelativeE) {
              targetE = currentE + eVal;
              deltaE = eVal;
            } else {
              deltaE = eVal - currentE;
              targetE = eVal;
            }
          }
        }

        const speedMms = currentF / 60.0;

        // An extrusion move must have deltaE > 0
        const isExtruding = deltaE > 0.0001;
        const isRetract = deltaE < -0.0001;

        // Laser is ONLY active when NOT a rapid G0 travel AND activeLaser is set AND laserPower > 0
        const isLaserActive = !isG0 && activeLaser !== null && laserPower > 0.001;

        // Classify move type with full OrcaSlicer fidelity
        let moveType = 'travel';
        if (isG0) {
          moveType = 'travel';
        } else if (isLaserActive) {
          moveType = (activeLaser === 'laser_pwm3') ? 'top_smooth' : 'wall_smooth';
        } else if (isExtruding) {
          const fLow = currentFeature.toLowerCase();
          if (fLow.includes('outer wall') || fLow.includes('external perimeter')) {
            moveType = 'outer_wall';
          } else if (fLow.includes('inner wall') || fLow.includes('internal perimeter') || fLow.includes('perimeter') || fLow.includes('overhang wall')) {
            moveType = 'inner_wall';
          } else if (fLow.includes('top surface') || fLow.includes('top solid infill') || fLow.includes('top solid') || fLow.startsWith('top')) {
            moveType = 'top_surface';
          } else if (fLow.includes('sparse infill')) {
            moveType = 'sparse_infill';
          } else if (fLow.includes('internal solid') || fLow.includes('solid infill') || fLow.includes('bridge') || fLow.includes('gap infill')) {
            moveType = 'solid_infill';
          } else if (fLow.includes('bottom surface')) {
            moveType = 'bottom_surface';
          } else if (fLow.includes('infill')) {
            moveType = 'sparse_infill';
          } else {
            moveType = 'extrusion';
          }
        } else if (isRetract) {
          moveType = 'retract';
        } else {
          moveType = 'travel';
        }

        // Helper to compute laser targets
        const calcLaserTargets = (startX, startY, startZ, endX, endY, endZ) => {
          let lTargetX = null, lTargetY = null, lTargetZ = null;
          let lTargetStartX = null, lTargetStartY = null, lTargetStartZ = null;

          if (isLaserActive || isInsideLaserBlock) {
            const effLaser = activeLaser || (currentPassObj ? (currentPassObj.type === 'top_smooth' ? 'laser_pwm3' : 'laser_pwm1') : null);
            if (effLaser === 'laser_pwm1') {
              lTargetX = endX - offsetXPlus;
              lTargetY = endY;
              lTargetZ = endZ - offsetZ;
              lTargetStartX = startX - offsetXPlus;
              lTargetStartY = startY;
              lTargetStartZ = startZ - offsetZ;
            } else if (effLaser === 'laser_pwm2') {
              lTargetX = endX - offsetXMinus;
              lTargetY = endY;
              lTargetZ = endZ - offsetZ;
              lTargetStartX = startX - offsetXMinus;
              lTargetStartY = startY;
              lTargetStartZ = startZ - offsetZ;
            } else if (effLaser === 'laser_pwm3') {
              lTargetX = endX - smoothOffsetX;
              lTargetY = endY - smoothOffsetY;
              lTargetZ = endZ - smoothOffsetZ;
              lTargetStartX = startX - smoothOffsetX;
              lTargetStartY = startY - smoothOffsetY;
              lTargetStartZ = startZ - smoothOffsetZ;
            }
          }
          return { lTargetX, lTargetY, lTargetZ, lTargetStartX, lTargetStartY, lTargetStartZ };
        };

        const updateBBox = (x, y, z) => {
          if (x < this.bbox.minX) this.bbox.minX = x;
          if (x > this.bbox.maxX) this.bbox.maxX = x;
          if (y < this.bbox.minY) this.bbox.minY = y;
          if (y > this.bbox.maxY) this.bbox.maxY = y;
          if (z < this.bbox.minZ) this.bbox.minZ = z;
          if (z > this.bbox.maxZ) this.bbox.maxZ = z;
        };

        if (isArc) {
          // =========================================================================
          // G2 / G3 ARC INTERPOLATION
          // =========================================================================
          let cx, cy, r;
          if (iVal !== null || jVal !== null) {
            const offI = iVal || 0;
            const offJ = jVal || 0;
            cx = currentX + offI;
            cy = currentY + offJ;
            r = Math.hypot(offI, offJ);
          } else if (rVal !== null) {
            const chord = Math.hypot(targetX - currentX, targetY - currentY);
            r = Math.abs(rVal);
            if (chord > 2 * r) r = chord / 2;
            const mx = (currentX + targetX) * 0.5;
            const my = (currentY + targetY) * 0.5;
            const h = Math.sqrt(Math.max(0, r * r - (chord * 0.5) ** 2));
            const nx = -(targetY - currentY) / (chord || 1);
            const ny = (targetX - currentX) / (chord || 1);
            const dir = (rVal > 0 === isCW) ? 1 : -1;
            cx = mx + nx * h * dir;
            cy = my + ny * h * dir;
          } else {
            cx = (currentX + targetX) * 0.5;
            cy = (currentY + targetY) * 0.5;
            r = Math.hypot(targetX - currentX, targetY - currentY) * 0.5;
          }

          const v0x = currentX - cx, v0y = currentY - cy;
          const v1x = targetX - cx, v1y = targetY - cy;
          const th0 = Math.atan2(v0y, v0x);
          const th1 = Math.atan2(v1y, v1x);

          let dTh;
          if (isCW) {
            dTh = th0 - th1;
            if (dTh <= 1e-6) dTh += Math.PI * 2;
          } else {
            dTh = th1 - th0;
            if (dTh <= 1e-6) dTh += Math.PI * 2;
          }

          const arcDist = r * dTh;
          const totalDist = Math.hypot(arcDist, targetZ - currentZ);
          const numSteps = Math.max(1, Math.ceil(totalDist / 0.35), Math.ceil(dTh / (Math.PI / 18)));

          let lastX = currentX, lastY = currentY, lastZ = currentZ;

          for (let step = 1; step <= numSteps; step++) {
            const t = step / numSteps;
            const phi = isCW ? (th0 - t * dTh) : (th0 + t * dTh);
            const subEndX = (step === numSteps) ? targetX : (cx + r * Math.cos(phi));
            const subEndY = (step === numSteps) ? targetY : (cy + r * Math.sin(phi));
            const subEndZ = currentZ + t * (targetZ - currentZ);

            const subDist = Math.hypot(subEndX - lastX, subEndY - lastY, subEndZ - lastZ);
            const subDur = speedMms > 0 ? (subDist / speedMms) : 0.001;

            updateBBox(subEndX, subEndY, subEndZ);

            const lt = calcLaserTargets(lastX, lastY, lastZ, subEndX, subEndY, subEndZ);

            this.segments.push({
              index: this.segments.length,
              startX: lastX,
              startY: lastY,
              startZ: lastZ,
              endX: subEndX,
              endY: subEndY,
              endZ: subEndZ,
              distance: subDist,
              speed: speedMms,
              duration: subDur,
              startTime: cumulativeTime,
              endTime: cumulativeTime + subDur,
              layerIndex: currentLayer,
              feature: currentFeature,
              type: moveType,
              width: currentWidth,
              height: currentHeight,
              isExtruding: isExtruding && subDist > 0.005,
              isTravel: isG0 || (!isExtruding && !isLaserActive && !isRetract),
              isLaserPass: isLaserActive,
              activeLaser: isLaserActive ? activeLaser : null,
              laserPower: isLaserActive ? laserPower : 0.0,
              laserTargetX: lt.lTargetX,
              laserTargetY: lt.lTargetY,
              laserTargetZ: lt.lTargetZ,
              laserTargetStartX: lt.lTargetStartX,
              laserTargetStartY: lt.lTargetStartY,
              laserTargetStartZ: lt.lTargetStartZ,
              rawLine: rawLine
            });

            cumulativeTime += subDur;
            lastX = subEndX;
            lastY = subEndY;
            lastZ = subEndZ;
          }
        } else {
          // =========================================================================
          // G0 / G1 LINEAR MOVE
          // =========================================================================
          const dx = targetX - currentX;
          const dy = targetY - currentY;
          const dz = targetZ - currentZ;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const duration = speedMms > 0 ? (dist / speedMms) : 0.001;

          updateBBox(targetX, targetY, targetZ);

          const lt = calcLaserTargets(currentX, currentY, currentZ, targetX, targetY, targetZ);

          this.segments.push({
            index: this.segments.length,
            startX: currentX,
            startY: currentY,
            startZ: currentZ,
            endX: targetX,
            endY: targetY,
            endZ: targetZ,
            distance: dist,
            speed: speedMms,
            duration: duration,
            startTime: cumulativeTime,
            endTime: cumulativeTime + duration,
            layerIndex: currentLayer,
            feature: currentFeature,
            type: moveType,
            width: currentWidth,
            height: currentHeight,
            isExtruding: isExtruding && dist > 0.005,
            isTravel: isG0 || (!isExtruding && !isLaserActive && !isRetract),
            isLaserPass: isLaserActive,
            activeLaser: isLaserActive ? activeLaser : null,
            laserPower: isLaserActive ? laserPower : 0.0,
            laserTargetX: lt.lTargetX,
            laserTargetY: lt.lTargetY,
            laserTargetZ: lt.lTargetZ,
            laserTargetStartX: lt.lTargetStartX,
            laserTargetStartY: lt.lTargetStartY,
            laserTargetStartZ: lt.lTargetStartZ,
            rawLine: rawLine
          });

          cumulativeTime += duration;
        }

        currentX = targetX;
        currentY = targetY;
        currentZ = targetZ;
        currentE = targetE;
      }
    }

    if (this.layers.length > 0) {
      this.layers[this.layers.length - 1].endSegment = this.segments.length;
    }

    this.totalTime = cumulativeTime;
    this.maxZ = this.bbox.maxZ;

    console.log(`[GCodeParser] Parsed ${this.segments.length} segments, ${this.layers.length} layers, ${this.laserPasses.length} laser passes. Total sim time: ${this.totalTime.toFixed(1)}s`);
    return {
      segments: this.segments,
      layers: this.layers,
      laserPasses: this.laserPasses,
      laserSettings: this.laserSettings,
      totalTime: this.totalTime,
      bbox: this.bbox
    };
  }

  _getVal(line, char) {
    const regex = new RegExp(`[\\s]${char}([-+]?[0-9]*\\.?[0-9]+)`);
    const match = line.match(regex);
    return match ? parseFloat(match[1]) : null;
  }
}

window.GCodeParser = GCodeParser;
