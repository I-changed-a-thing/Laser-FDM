/**
 * laser-heatmap.js - Laser Energy Dose & Thermal Fluence Calculation Engine
 * 
 * Computes exact cumulative energy (J/mm² / relative thermal dose) received
 * across every point on the 3D model, incorporating:
 *  1. Kinematic acceleration / deceleration trapezoidal profiles (toolhead dwell time)
 *  2. Commanded laser power P (PWM 0..1 or Watts)
 *  3. Gaussian radial beam profile I(r) = I0 * exp(-2 * r^2 / w^2) (center vs side beam)
 *  4. Cumulative overlap integration across multi-pass & Z-wobble sweeps
 *  5. Turbo / Inferno high-contrast thermal colormap generation
 */

class LaserHeatmap {
  /**
   * Evaluates trapezoidal motion profile for all segments to determine
   * local instantaneous velocity v(s) and dwell time dt/ds under acceleration limit a.
   */
  static planKinematics(segments, acceleration = 5000.0, junctionDeviation = 0.05) {
    const numSegs = segments.length;
    const profiles = new Array(numSegs);

    // 1. Initial pass: compute segment nominal speed and junction max entry speed
    for (let i = 0; i < numSegs; i++) {
      const seg = segments[i];
      const targetSpeed = Math.max(1.0, seg.speed || 20.0);
      const dist = Math.max(0.0001, seg.distance || 0.0001);

      profiles[i] = {
        distance: dist,
        targetSpeed: targetSpeed,
        entrySpeed: 0.0,
        exitSpeed: 0.0,
        accel: acceleration
      };

      // Calculate corner junction speed with next segment
      if (i < numSegs - 1) {
        const nextSeg = segments[i + 1];
        const dx0 = seg.endX - seg.startX, dy0 = seg.endY - seg.startY, dz0 = seg.endZ - seg.startZ;
        const dx1 = nextSeg.endX - nextSeg.startX, dy1 = nextSeg.endY - nextSeg.startY, dz1 = nextSeg.endZ - nextSeg.startZ;
        const len0 = Math.hypot(dx0, dy0, dz0), len1 = Math.hypot(dx1, dy1, dz1);

        if (len0 > 0.001 && len1 > 0.001 && !seg.isTravel && !nextSeg.isTravel) {
          const dot = (dx0 * dx1 + dy0 * dy1 + dz0 * dz1) / (len0 * len1);
          const cosTheta = Math.max(-1.0, Math.min(1.0, dot));
          const sinHalfTheta = Math.sqrt(Math.max(0.0, (1.0 - cosTheta) * 0.5));

          if (sinHalfTheta > 0.001) {
            // Classical junction deviation velocity limit
            const r = (junctionDeviation * (1.0 - sinHalfTheta)) / sinHalfTheta;
            const maxJunctionSpeed = Math.sqrt(Math.max(0.0, acceleration * r));
            profiles[i].exitSpeed = Math.min(targetSpeed, nextSeg.speed || 20.0, maxJunctionSpeed);
          } else {
            profiles[i].exitSpeed = Math.min(targetSpeed, nextSeg.speed || 20.0);
          }
        } else {
          profiles[i].exitSpeed = Math.min(targetSpeed, 5.0); // Stop or slow at travels/retracts
        }
      } else {
        profiles[i].exitSpeed = 0.0;
      }
    }

    // 2. Reverse pass: apply deceleration limits
    for (let i = numSegs - 1; i >= 0; i--) {
      const p = profiles[i];
      const nextEntry = (i < numSegs - 1) ? profiles[i + 1].entrySpeed : 0.0;
      const maxReachableExit = Math.sqrt(nextEntry * nextEntry + 2.0 * acceleration * p.distance);
      p.exitSpeed = Math.min(p.exitSpeed, maxReachableExit, p.targetSpeed);

      const maxReachableEntry = Math.sqrt(p.exitSpeed * p.exitSpeed + 2.0 * acceleration * p.distance);
      p.entrySpeed = Math.min(p.targetSpeed, maxReachableEntry);
    }

    // 3. Forward pass: apply acceleration limits
    let currentSpeed = 0.0;
    for (let i = 0; i < numSegs; i++) {
      const p = profiles[i];
      p.entrySpeed = Math.min(p.entrySpeed, currentSpeed);
      const maxReachableExit = Math.sqrt(p.entrySpeed * p.entrySpeed + 2.0 * acceleration * p.distance);
      p.exitSpeed = Math.min(p.exitSpeed, maxReachableExit);
      currentSpeed = p.exitSpeed;
    }

    return profiles;
  }

  /**
   * Computes instantaneous speed v(u) at fractional distance u in [0, 1] along segment.
   */
  static getSpeedAt(profile, u) {
    const v0 = profile.entrySpeed;
    const v1 = profile.exitSpeed;
    const vmax = profile.targetSpeed;
    const d = profile.distance;
    const a = profile.accel;

    const dAccel = Math.max(0.0, (vmax * vmax - v0 * v0) / (2.0 * a));
    const dDecel = Math.max(0.0, (vmax * vmax - v1 * v1) / (2.0 * a));

    if (dAccel + dDecel > d) {
      // Triangular profile (does not reach vmax)
      const dTop = Math.max(0.0, (2.0 * a * d + v1 * v1 - v0 * v0) / (4.0 * a));
      const dist = u * d;
      if (dist <= dTop) {
        return Math.sqrt(Math.max(1.0, v0 * v0 + 2.0 * a * dist));
      } else {
        const dFromExit = d - dist;
        return Math.sqrt(Math.max(1.0, v1 * v1 + 2.0 * a * dFromExit));
      }
    } else {
      // Trapezoidal profile
      const dist = u * d;
      if (dist < dAccel) {
        return Math.sqrt(Math.max(1.0, v0 * v0 + 2.0 * a * dist));
      } else if (dist > d - dDecel) {
        const dFromExit = d - dist;
        return Math.sqrt(Math.max(1.0, v1 * v1 + 2.0 * a * dFromExit));
      } else {
        return vmax;
      }
    }
  }

  /**
   * Computes cumulative laser energy fluence across outer wall and top surface microsegments.
   */
  static computeEnergyMap(options) {
    const {
      segments,
      outerWallMicroSegments,
      topSurfaceMicroSegments,
      sceneManager,
      toolhead,
      acceleration = 5000.0,
      beamWaist = 0.35,          // mm (focal waist radius w0)
      laserRatedPowerWatts = 10.0 // Rated laser optical power in Watts (e.g. 10W diode)
    } = options;

    if (!segments || !segments.length) return null;

    const t0 = performance.now();

    // 1. Plan trapezoidal kinematics for realistic corner deceleration
    const profiles = this.planKinematics(segments, acceleration);

    const laserMoves = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s.isLaserPass && s.laserPower > 0.001 && profiles[i]) {
        laserMoves.push({ seg: s, profile: profiles[i] });
      }
    }

    // Reset energy doses
    for (let i = 0; i < outerWallMicroSegments.length; i++) {
      outerWallMicroSegments[i].energyDose = 0.0;
    }
    for (let i = 0; i < topSurfaceMicroSegments.length; i++) {
      topSurfaceMicroSegments[i].energyDose = 0.0;
    }

    if (!laserMoves.length) {
      return { maxDose: 0, avgDose: 0, totalJoules: 0, outerColors: null, topColors: null };
    }

    const diodeSettings = toolhead && typeof toolhead.getDiodeSettings === 'function'
      ? toolhead.getDiodeSettings()
      : { h1: 27.8, h2: 29.0, angleDeg: 23.0 };

    const angleRad = (diodeSettings.angleDeg * Math.PI) / 180.0;
    const apertures = {
      laser_pwm1: { x: 68.45, y: diodeSettings.h1, z: -0.18, dir: { x: -Math.cos(angleRad), y: -Math.sin(angleRad), z: 0 } },
      laser_pwm2: { x: -68.45, y: diodeSettings.h2, z: -0.18, dir: { x: Math.cos(angleRad), y: -Math.sin(angleRad), z: 0 } },
      laser_pwm3: { x: -34.08, y: 87.52, z: 72.80, dir: { x: 0, y: -1, z: 0 } }
    };

    const w0Sq = beamWaist * beamWaist;
    const cutoffRadius = beamWaist * 2.2; // 99% Gaussian energy cutoff
    const cutoffRadiusSq = cutoffRadius * cutoffRadius;
    const cs = 4.0;

    // 2. Build 2D layer grids for outer walls
    const layerGrids = [];
    const layerHeights = [];

    for (let i = 0; i < outerWallMicroSegments.length; i++) {
      const m = outerWallMicroSegments[i];
      if (m.surfX === undefined || m.surfZ === undefined || m.normalX === undefined) {
        const p0 = sceneManager.toWorld(m.startX, m.startY, m.startZ);
        const p1 = sceneManager.toWorld(m.endX, m.endY, m.endZ);
        const mDx = p1.x - p0.x, mDz = p1.z - p0.z;
        const mLen = Math.hypot(mDx, mDz);
        let nx = 1.0, nz = 0.0;
        if (mLen > 0.0001) {
          nx = -mDz / mLen;
          nz = mDx / mLen;
        }
        m.surfX = (p0.x + p1.x) * 0.5 + nx * 0.21;
        m.surfZ = (p0.z + p1.z) * 0.5 + nz * 0.21;
        m.normalX = nx;
        m.normalZ = nz;
      }

      const layIdx = m.layerIndex;
      if (!layerGrids[layIdx]) {
        layerGrids[layIdx] = new Map();
        layerHeights[layIdx] = m.startZ;
      }
      const grid = layerGrids[layIdx];
      const cx = Math.floor(m.surfX / cs);
      const cz = Math.floor(m.surfZ / cs);
      const key = `${cx},${cz}`;
      let cell = grid.get(key);
      if (!cell) {
        cell = [];
        grid.set(key, cell);
      }
      cell.push(m);
    }

    // 3. Build 2D spatial grid for top surfaces
    const topGrid = new Map();
    for (let i = 0; i < topSurfaceMicroSegments.length; i++) {
      const m = topSurfaceMicroSegments[i];
      const cx = Math.floor(m.surfX / cs);
      const cz = Math.floor(m.surfZ / cs);
      const key = `${cx},${cz}`;
      let cell = topGrid.get(key);
      if (!cell) {
        cell = [];
        topGrid.set(key, cell);
      }
      cell.push(m);
    }

    // 4. Integrate Gaussian laser fluence along every laser move
    let totalJoulesDelivered = 0.0;
    const approxLh = 0.20;

    for (let l = 0; l < laserMoves.length; l++) {
      const { seg: lm, profile } = laserMoves[l];
      const ap = apertures[lm.activeLaser];
      if (!ap) continue;

      const powerFraction = Math.max(0.0, Math.min(1.0, lm.laserPower || 0.0));
      const opticalPowerW = powerFraction * laserRatedPowerWatts;

      const th0 = sceneManager.toWorld(lm.startX, lm.startY, lm.startZ);
      const th1 = sceneManager.toWorld(lm.endX, lm.endY, lm.endZ);

      const E0 = { x: th0.x + ap.x, y: th0.y + ap.y, z: th0.z + ap.z };
      const E1 = { x: th1.x + ap.x, y: th1.y + ap.y, z: th1.z + ap.z };
      const dir = ap.dir;
      const invDy = 1.0 / (dir.y || -0.0001);

      const moveDist = profile.distance;
      totalJoulesDelivered += opticalPowerW * (lm.duration || 0.0);

      if (lm.activeLaser === 'laser_pwm1' || lm.activeLaser === 'laser_pwm2') {
        const zMin = Math.min(lm.startX !== undefined ? lm.startZ : lm.endZ, lm.endZ);
        const zMax = Math.max(lm.startX !== undefined ? lm.startZ : lm.endZ, lm.endZ);

        const minTargetZ = zMin - 18.0;
        const maxTargetZ = zMax + 6.0;

        const minLayIdx = Math.max(0, Math.floor(minTargetZ / approxLh) - 2);
        const maxLayIdx = Math.min(layerGrids.length - 1, Math.ceil(maxTargetZ / approxLh) + 2);

        const candidateHits = [];

        for (let layIdx = minLayIdx; layIdx <= maxLayIdx; layIdx++) {
          const grid = layerGrids[layIdx];
          if (!grid) continue;

          const layZ = layerHeights[layIdx];
          if (layZ < minTargetZ || layZ > maxTargetZ) continue;

          const layWorldY = layZ;
          const tHit0 = (layWorldY - E0.y) * invDy;
          const tHit1 = (layWorldY - E1.y) * invDy;

          if (tHit0 <= 0 && tHit1 <= 0) continue;

          const B0 = { x: E0.x + tHit0 * dir.x, y: layWorldY, z: E0.z + tHit0 * dir.z };
          const B1 = { x: E1.x + tHit1 * dir.x, y: layWorldY, z: E1.z + tHit1 * dir.z };

          const bDx = B1.x - B0.x, bDz = B1.z - B0.z;
          const bLenSq = bDx * bDx + bDz * bDz;

          const minX = Math.min(B0.x, B1.x) - cutoffRadius;
          const maxX = Math.max(B0.x, B1.x) + cutoffRadius;
          const minZ = Math.min(B0.z, B1.z) - cutoffRadius;
          const maxZ = Math.max(B0.z, B1.z) + cutoffRadius;

          const minCX = Math.floor(minX / cs), maxCX = Math.floor(maxX / cs);
          const minCZ = Math.floor(minZ / cs), maxCZ = Math.floor(maxZ / cs);

          for (let cx = minCX; cx <= maxCX; cx++) {
            for (let cz = minCZ; cz <= maxCZ; cz++) {
              const cell = grid.get(`${cx},${cz}`);
              if (!cell) continue;

              for (let c = 0; c < cell.length; c++) {
                const m = cell[c];

                // Backface culling: laser cannot strike interior / reverse-facing walls
                if (m.normalX !== undefined && m.normalZ !== undefined) {
                  const facing = dir.x * m.normalX + dir.z * m.normalZ;
                  if (facing > -0.01) continue;
                }

                const sX = m.surfX, sZ = m.surfZ;

                let u = 0;
                if (bLenSq > 0.00001) {
                  u = Math.max(0.0, Math.min(1.0, ((sX - B0.x) * bDx + (sZ - B0.z) * bDz) / bLenSq));
                }
                const closeX = B0.x + u * bDx;
                const closeZ = B0.z + u * bDz;

                const distSq = (sX - closeX) * (sX - closeX) + (sZ - closeZ) * (sZ - closeZ);
                if (distSq <= cutoffRadiusSq) {
                  const tHitAtU = (1.0 - u) * tHit0 + u * tHit1;
                  candidateHits.push({
                    m,
                    u,
                    tHit: tHitAtU,
                    distSq
                  });
                }
              }
            }
          }
        }

        // Ray Occlusion Filter: Only deposit energy to the outermost surface hit along the ray path
        if (candidateHits.length > 0) {
          const NUM_BINS = Math.max(4, Math.min(32, Math.ceil(moveDist / 0.25) + 1));
          const minTPerBin = new Float32Array(NUM_BINS);
          minTPerBin.fill(1e9);

          for (let i = 0; i < candidateHits.length; i++) {
            const ch = candidateHits[i];
            const binIdx = Math.max(0, Math.min(NUM_BINS - 1, Math.floor(ch.u * NUM_BINS)));
            if (ch.tHit < minTPerBin[binIdx]) {
              minTPerBin[binIdx] = ch.tHit;
            }
          }

          const depthTol = Math.max(0.4, beamWaist * 1.5);
          for (let i = 0; i < candidateHits.length; i++) {
            const ch = candidateHits[i];
            const binIdx = Math.max(0, Math.min(NUM_BINS - 1, Math.floor(ch.u * NUM_BINS)));
            const minT = minTPerBin[binIdx];

            if (ch.tHit <= minT + depthTol) {
              const currentSpeed = Math.max(1.0, this.getSpeedAt(profile, ch.u));
              const gaussianFactor = Math.exp(-2.0 * (ch.distSq / w0Sq));
              const spotWidth = beamWaist * 2.0;
              const dose = (opticalPowerW / (currentSpeed * spotWidth)) * gaussianFactor;

              ch.m.energyDose += dose;
            }
          }
        }
      } else if (lm.activeLaser === 'laser_pwm3') {
        const B0 = { x: E0.x, y: th0.y, z: E0.z };
        const B1 = { x: E1.x, y: th1.y, z: E1.z };
        const bDx = B1.x - B0.x, bDz = B1.z - B0.z;
        const bLenSq = bDx * bDx + bDz * bDz;

        const minX = Math.min(B0.x, B1.x) - cutoffRadius;
        const maxX = Math.max(B0.x, B1.x) + cutoffRadius;
        const minZ = Math.min(B0.z, B1.z) - cutoffRadius;
        const maxZ = Math.max(B0.z, B1.z) + cutoffRadius;

        const minCX = Math.floor(minX / cs), maxCX = Math.floor(maxX / cs);
        const minCZ = Math.floor(minZ / cs), maxCZ = Math.floor(maxZ / cs);

        for (let cx = minCX; cx <= maxCX; cx++) {
          for (let cz = minCZ; cz <= maxCZ; cz++) {
            const cell = topGrid.get(`${cx},${cz}`);
            if (!cell) continue;

            for (let c = 0; c < cell.length; c++) {
              const m = cell[c];
              const sX = m.surfX, sZ = m.surfZ;

              let u = 0;
              if (bLenSq > 0.00001) {
                u = Math.max(0.0, Math.min(1.0, ((sX - B0.x) * bDx + (sZ - B0.z) * bDz) / bLenSq));
              }
              const closeX = B0.x + u * bDx;
              const closeZ = B0.z + u * bDz;

              const distSq = (sX - closeX) * (sX - closeX) + (sZ - closeZ) * (sZ - closeZ);
              if (distSq <= cutoffRadiusSq) {
                const currentSpeed = Math.max(1.0, this.getSpeedAt(profile, u));
                const gaussianFactor = Math.exp(-2.0 * (distSq / w0Sq));
                const spotWidth = beamWaist * 2.0;
                const dose = (opticalPowerW / (currentSpeed * spotWidth)) * gaussianFactor;

                m.energyDose += dose;
              }
            }
          }
        }
      }
    }

    // 5. Calculate statistics and normalize energy doses into colors
    let maxDose = 0.0;
    let sumDose = 0.0;
    let exposedCount = 0;

    for (let i = 0; i < outerWallMicroSegments.length; i++) {
      const d = outerWallMicroSegments[i].energyDose;
      if (d > maxDose) maxDose = d;
      if (d > 0.001) {
        sumDose += d;
        exposedCount++;
      }
    }
    for (let i = 0; i < topSurfaceMicroSegments.length; i++) {
      const d = topSurfaceMicroSegments[i].energyDose;
      if (d > maxDose) maxDose = d;
      if (d > 0.001) {
        sumDose += d;
        exposedCount++;
      }
    }

    const avgDose = exposedCount > 0 ? (sumDose / exposedCount) : 0.0;
    const effectiveMaxDose = maxDose > 0.0001 ? maxDose : 1.0;

    // 6. Generate Turbo / Thermal colormap vertex arrays
    const outerColors = new Float32Array(outerWallMicroSegments.length * 16 * 3);
    for (let i = 0; i < outerWallMicroSegments.length; i++) {
      const dose = outerWallMicroSegments[i].energyDose;
      const normalizedDose = Math.min(1.0, dose / effectiveMaxDose);
      const rgb = this.getTurboHeatmapColor(normalizedDose, dose > 0.001);

      const offset = i * 16 * 3;
      for (let v = 0; v < 16; v++) {
        outerColors[offset + v * 3]     = rgb[0];
        outerColors[offset + v * 3 + 1] = rgb[1];
        outerColors[offset + v * 3 + 2] = rgb[2];
      }
    }

    const topColors = new Float32Array(topSurfaceMicroSegments.length * 16 * 3);
    for (let i = 0; i < topSurfaceMicroSegments.length; i++) {
      const dose = topSurfaceMicroSegments[i].energyDose;
      const normalizedDose = Math.min(1.0, dose / effectiveMaxDose);
      const rgb = this.getTurboHeatmapColor(normalizedDose, dose > 0.001);

      const offset = i * 16 * 3;
      for (let v = 0; v < 16; v++) {
        topColors[offset + v * 3]     = rgb[0];
        topColors[offset + v * 3 + 1] = rgb[1];
        topColors[offset + v * 3 + 2] = rgb[2];
      }
    }

    const t1 = performance.now();
    console.log(`[LaserHeatmap] Computed energy map in ${(t1 - t0).toFixed(1)}ms. Max Dose: ${maxDose.toFixed(2)} J/mm², Total Joules: ${totalJoulesDelivered.toFixed(1)}J`);

    return {
      maxDose,
      avgDose,
      totalJoules: totalJoulesDelivered,
      exposedCount,
      outerColors,
      topColors
    };
  }

  /**
   * Converts normalized thermal intensity [0, 1] to Turbo/Inferno thermal RGB.
   * Unexposed areas (isExposed = false) render as dark slate-blue base tone.
   */
  static getTurboHeatmapColor(t, isExposed) {
    if (!isExposed || t <= 0.0001) {
      return [0.12, 0.15, 0.22]; // Neutral dark unheated base tone
    }

    // High-contrast 6-Stop Turbo/Inferno Thermal Gradient
    // 0.0 -> Deep Royal Blue (0.10, 0.25, 0.85)
    // 0.2 -> Cyan (0.05, 0.80, 0.90)
    // 0.4 -> Emerald Green (0.10, 0.85, 0.25)
    // 0.6 -> Bright Gold / Yellow (0.95, 0.90, 0.10)
    // 0.8 -> Intense Orange-Red (0.95, 0.30, 0.05)
    // 1.0 -> White-Hot Magenta (1.0, 0.95, 0.90)

    let r = 0, g = 0, b = 0;
    if (t < 0.20) {
      const u = t / 0.20;
      r = 0.10 + u * (0.05 - 0.10);
      g = 0.25 + u * (0.80 - 0.25);
      b = 0.85 + u * (0.90 - 0.85);
    } else if (t < 0.40) {
      const u = (t - 0.20) / 0.20;
      r = 0.05 + u * (0.10 - 0.05);
      g = 0.80 + u * (0.85 - 0.80);
      b = 0.90 + u * (0.25 - 0.90);
    } else if (t < 0.60) {
      const u = (t - 0.40) / 0.20;
      r = 0.10 + u * (0.95 - 0.10);
      g = 0.85 + u * (0.90 - 0.85);
      b = 0.25 + u * (0.10 - 0.25);
    } else if (t < 0.80) {
      const u = (t - 0.60) / 0.20;
      r = 0.95 + u * (0.95 - 0.95);
      g = 0.90 + u * (0.30 - 0.90);
      b = 0.10 + u * (0.05 - 0.10);
    } else {
      const u = (t - 0.80) / 0.20;
      r = 0.95 + u * (1.0 - 0.95);
      g = 0.30 + u * (0.95 - 0.30);
      b = 0.05 + u * (0.90 - 0.05);
    }

    return [r, g, b];
  }
}

// Attach to global window
if (typeof window !== 'undefined') {
  window.LaserHeatmap = LaserHeatmap;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LaserHeatmap;
}
