/**
 * Laser FX — High-Precision 445nm Blue Diode Laser Optics & Contact Spot
 * Supports:
 * 1. Realistic Optical Gaussian / Conical Beam Waist (wide at lens aperture, converging to tight focal waist, diverging past it)
 * 2. Focus Distance Adjustment (calibratable via UI, like rotating physical laser lens focus ring)
 * 3. Dynamic in-focus / out-of-focus spot sizing and intensity on hit surfaces
 */

class LaserEffects {
  constructor(scene) {
    this.scene = scene;
    this.visible = true;

    // Optical parameters
    this.realisticBeam = true;     // Realistic Gaussian hourglass beam profile
    this.focalDistance = 100.0;     // Nominal focal distance in mm from lens aperture

    this.currentLevel = 2;
    this.spotDimensions = {
      0: { w: 1.0, h: 1.0 },
      1: { w: 1.0, h: 1.0 },
      2: { w: 1.0, h: 1.0 }
    };

    this._buildHitSpot();
    this._buildBeamMesh();
  }

  _buildHitSpot() {
    this.spotGroup = new THREE.Group();
    this.spotGroup.renderOrder = 20; // Renders after opaque geometry, properly occluded by depth buffer

    // 1. Precision Outer Focus Halo (Soft deep royal blue aura)
    const haloGeo = new THREE.RingGeometry(0.30, 0.70, 32);
    this.haloMat = new THREE.MeshBasicMaterial({
      color: 0x1d4ed8,          // Deep 445nm Royal Blue
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2.0,
      polygonOffsetUnits: -4.0
    });
    this.haloMesh = new THREE.Mesh(haloGeo, this.haloMat);
    this.haloMesh.renderOrder = 20;
    this.spotGroup.add(this.haloMesh);

    // 2. High-Intensity 445nm Blue Laser Waist (Vivid blue focus ring)
    const spotGeo = new THREE.RingGeometry(0.12, 0.36, 32);
    this.spotMat = new THREE.MeshBasicMaterial({
      color: 0x2563eb,          // Saturated 445nm Royal Blue
      transparent: true,
      opacity: 0.90,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2.0,
      polygonOffsetUnits: -4.0
    });
    this.spotMesh = new THREE.Mesh(spotGeo, this.spotMat);
    this.spotMesh.position.z = 0.005;
    this.spotMesh.renderOrder = 21;
    this.spotGroup.add(this.spotMesh);

    // 3. Focused Optical Core (Crisp blue-cyan center)
    const coreGeo = new THREE.CircleGeometry(0.14, 32);
    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xbfdbfe,          // Clean blue-cyan core
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2.0,
      polygonOffsetUnits: -4.0
    });
    this.coreMesh = new THREE.Mesh(coreGeo, this.coreMat);
    this.coreMesh.position.z = 0.01;
    this.coreMesh.renderOrder = 22;
    this.spotGroup.add(this.coreMesh);

    // 4. Calibrated Point Light (Soft localized blue radiance)
    this.spotLight = new THREE.PointLight(0x1d4ed8, 0, 8);
    this.spotGroup.add(this.spotLight);

    this.spotGroup.visible = false;
    this.scene.add(this.spotGroup);
  }

  _createLoftedBeamGeometry(numRings = 16, numRadial = 16) {
    const geo = new THREE.BufferGeometry();
    const vertCount = (numRings + 1) * numRadial;
    const positions = new Float32Array(vertCount * 3);
    const indices = [];

    for (let r = 0; r < numRings; r++) {
      for (let s = 0; s < numRadial; s++) {
        const i0 = r * numRadial + s;
        const i1 = r * numRadial + ((s + 1) % numRadial);
        const i2 = (r + 1) * numRadial + s;
        const i3 = (r + 1) * numRadial + ((s + 1) % numRadial);
        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    return geo;
  }

  _updateLoftedBeamVertices(geo, hitLen, focalDist, baseRadiusAperture, waistRadius, divergenceSlope) {
    const pos = geo.attributes.position.array;
    const numRings = 16;
    const numRadial = 16;

    for (let r = 0; r <= numRings; r++) {
      const u = r / numRings;
      const z = hitLen * u; // Distance along beam axis (+Z)

      let rad;
      if (z <= focalDist) {
        // Converging from lens aperture to narrow focal waist
        const t = z / (focalDist || 1.0);
        rad = waistRadius + (baseRadiusAperture - waistRadius) * Math.pow(1.0 - t, 1.8);
      } else {
        // Diverging past focal waist
        const d = z - focalDist;
        rad = waistRadius + d * divergenceSlope;
      }

      for (let s = 0; s < numRadial; s++) {
        const theta = (s / numRadial) * Math.PI * 2;
        const idx = (r * numRadial + s) * 3;
        pos[idx]     = Math.cos(theta) * rad;
        pos[idx + 1] = Math.sin(theta) * rad;
        pos[idx + 2] = z;
      }
    }
    geo.attributes.position.needsUpdate = true;
  }

  _buildBeamMesh() {
    this.beamGroup = new THREE.Group();
    this.beamGroup.renderOrder = 10; // Renders after opaque geometry, properly occluded by depth buffer

    // 1. Realistic Hourglass Optical Core
    this.coreLoftedGeo = this._createLoftedBeamGeometry(16, 16);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x93c5fd,          // Bright focused cyan-blue core
      transparent: true,
      opacity: 0.90,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true
    });
    this.beamCore = new THREE.Mesh(this.coreLoftedGeo, coreMat);
    this.beamCore.renderOrder = 11;
    this.beamGroup.add(this.beamCore);

    // 2. Realistic Hourglass Gaussian Atmospheric Glow
    this.glowLoftedGeo = this._createLoftedBeamGeometry(16, 16);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x1d4ed8,          // Rich 445nm Deep Blue
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true
    });
    this.beamGlow = new THREE.Mesh(this.glowLoftedGeo, glowMat);
    this.beamGlow.renderOrder = 10;
    this.beamGroup.add(this.beamGlow);

    this.beamGroup.visible = false;
    this.scene.add(this.beamGroup);
  }

  setRealisticBeam(enabled) {
    this.realisticBeam = !!enabled;
  }

  setFocalDistance(distMm) {
    const f = parseFloat(distMm);
    if (!isNaN(f) && f >= 40.0 && f <= 150.0) {
      this.focalDistance = f;
    }
  }

  setOffsetLevel(level) {
    this.currentLevel = level in this.spotDimensions ? level : 2;
  }

  /**
   * Returns live focal status & distance from emitter to hit point
   */
  getFocusStatus(emitterPos, hitPos) {
    if (!emitterPos || !hitPos) return null;
    const dist = emitterPos.distanceTo(hitPos);
    const defocus = dist - this.focalDistance;
    return {
      distance: dist,
      focalDistance: this.focalDistance,
      defocus: defocus,
      inFocus: Math.abs(defocus) <= 1.0
    };
  }

  /**
   * Place the circular laser spot at hitPos, perfectly planar to the surface normal with safety offset,
   * and draw a continuous 445nm glowing laser beam between emitterPos and hitPos.
   */
  update(emitterPos, hitPos, laserPower, activeLaser, hitNormal) {
    if (!this.visible || !laserPower || laserPower < 0.005 || !hitPos || !activeLaser) {
      this.spotGroup.visible = false;
      this.beamGroup.visible = false;
      this.spotLight.intensity = 0;
      return;
    }

    this.spotGroup.visible = true;

    // Normal vector
    let norm = new THREE.Vector3(0, 0, 1);
    if (hitNormal && hitNormal.lengthSq() > 0.5) {
      norm = hitNormal.clone().normalize();
    } else {
      if (activeLaser === 'laser_pwm1') {
        norm = new THREE.Vector3(1, 0, 0);
      } else if (activeLaser === 'laser_pwm2') {
        norm = new THREE.Vector3(-1, 0, 0);
      } else {
        norm = new THREE.Vector3(0, 1, 0);
      }
    }

    // Offset slightly along normal (+0.04mm) to eliminate Z-fighting against wall triangles
    this.spotGroup.position.copy(hitPos).addScaledVector(norm, 0.04);

    // Orient circle plane (+Z) to surface normal
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), norm);
    this.spotGroup.setRotationFromQuaternion(q);

    // Calculate optical defocus if emitterPos is known
    let defocus = 0;
    let hitDistance = this.focalDistance;
    if (emitterPos) {
      hitDistance = emitterPos.distanceTo(hitPos);
      defocus = Math.abs(hitDistance - this.focalDistance);
    }

    // Dynamic spot sizing based on optical focus
    if (this.realisticBeam) {
      // In focus: tight sharp spot (1.0x); Out of focus: spreads out smoothly
      const spotScale = Math.max(0.6, Math.min(3.2, 1.0 + defocus * 0.055));
      this.spotGroup.scale.set(spotScale, spotScale, spotScale);
      this.coreMat.opacity = Math.max(0.35, 0.95 - defocus * 0.025);
      this.haloMat.opacity = Math.min(0.75, 0.40 + defocus * 0.020);
    } else {
      this.spotGroup.scale.set(1.0, 1.0, 1.0);
      this.coreMat.opacity = 0.95;
      this.haloMat.opacity = 0.45;
    }

    // Scale spot light intensity with laser power & focus
    const focusIntensityFactor = this.realisticBeam ? Math.max(0.4, 1.0 - defocus * 0.03) : 1.0;
    this.spotLight.intensity = laserPower * 1.5 * focusIntensityFactor;

    // Update Glowing Laser Beam Ray (Emitter -> Hit Spot)
    if (emitterPos) {
      this.beamGroup.visible = true;
      this.beamGroup.position.copy(emitterPos);

      const dir = hitPos.clone().sub(emitterPos);
      const len = dir.length();
      if (len > 0.001) {
        dir.normalize();
        const beamQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        this.beamGroup.setRotationFromQuaternion(beamQ);

        if (this.realisticBeam) {
          // Parametric Gaussian hourglass geometry:
          // Core: aperture 0.7mm -> waist 0.07mm -> diverging slope 0.022
          // Glow: aperture 2.2mm -> waist 0.22mm -> diverging slope 0.055
          this._updateLoftedBeamVertices(this.coreLoftedGeo, len, this.focalDistance, 0.70, 0.07, 0.022);
          this._updateLoftedBeamVertices(this.glowLoftedGeo, len, this.focalDistance, 2.20, 0.22, 0.055);
        } else {
          // Collimated thin cylinder
          this._updateLoftedBeamVertices(this.coreLoftedGeo, len, len * 2, 0.06, 0.06, 0.0);
          this._updateLoftedBeamVertices(this.glowLoftedGeo, len, len * 2, 0.20, 0.20, 0.0);
        }
      }
    } else {
      this.beamGroup.visible = false;
    }
  }

  setVisible(visible) {
    this.visible = visible;
    if (!visible) {
      this.spotGroup.visible = false;
      this.beamGroup.visible = false;
      this.spotLight.intensity = 0;
    }
  }

  clear() {
    this.spotGroup.visible = false;
    this.beamGroup.visible = false;
    this.spotLight.intensity = 0;
  }
}

window.LaserEffects = LaserEffects;
