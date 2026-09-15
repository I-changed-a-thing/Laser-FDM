/**
 * 3D Toolhead Assembly loading the authentic CAD model with Cooling Fans (Laser holder with lasers and hotend and cooling fans.step)
 * - Complete CAD assembly:
 *   - Golden brass nozzle
 *   - Black middle heater block / silicone sock
 *   - 3 Black cooling fans (left, right, center)
 *   - Vibrant anodized red laser heatsinks with Black front focus rings
 *   - Bright silver titanium mounting bracket (NOT black)
 *   - Aluminum coldend heatsink
 * - 180° Corrected Orientation: Laser 3 on X = -34mm offset, Laser 1 on Right, Laser 2 on Left
 * - Calibrated Emitter Positions:
 *   - Laser 1: 57mm back along 22° path (X: +96.27, Y: 36.65, Z: -0.18)
 *   - Laser 2: 57mm back along 22° path (X: -96.27, Y: 38.25, Z: -0.18)
 *   - Laser 3: 60mm up (X: -34.08, Y: 87.52, Z: +72.80)
 * - Decoupled optical beam angle: adjusting beam angle changes optical ray vector without rotating physical CAD housing
 */

class ToolheadAssembly {
  constructor(scene, sceneManager) {
    this.scene = scene;
    this.sceneManager = sceneManager;
    this.group = new THREE.Group();

    // Physical mounting angle in CAD is 23.0° (optical beam angle defaults to 23.0°)
    this.laserAngleDeg = 23.0;
    this.laserAngleRad = (this.laserAngleDeg * Math.PI) / 180;

    // Diode Heights above nozzle tip (mm)
    // Laser 1: 30mm forward along beam path -> X: +68.45 mm, Y: 27.8 mm
    // Laser 2: 30mm forward along beam path -> X: -68.45 mm, Y: 29.0 mm
    // Laser 3: 60mm up -> Y = 87.52 mm
    this.laser1Height = 27.8;
    this.laser2Height = 29.0;
    this.laser3Height = 87.52;

    // Laser Aperture Local Offsets from Nozzle Tip (0, 0, 0)
    this.apertures = {
      laser_pwm1: new THREE.Vector3(68.45, this.laser1Height, -0.18),
      laser_pwm2: new THREE.Vector3(-68.45, this.laser2Height, -0.18),
      laser_pwm3: new THREE.Vector3(-34.08, this.laser3Height, 72.80)
    };

    this.lensApertures = {};
    this.cadModel = null;
    this.isLoaded = false;

    this._initApertureIndicators();
    this._loadCADModel();
    this.scene.add(this.group);
  }

  _initApertureIndicators() {
    // Glowing optical lens indicators inside the laser diode apertures
    ['laser_pwm1', 'laser_pwm2', 'laser_pwm3'].forEach(pin => {
      const apertureGroup = new THREE.Group();
      const pos = this.apertures[pin];
      apertureGroup.position.copy(pos);

      // Optical lens glass ring
      const lensGeo = new THREE.CylinderGeometry(2.2, 2.2, 0.8, 16);
      if (pin === 'laser_pwm1' || pin === 'laser_pwm2') {
        lensGeo.rotateZ(pin === 'laser_pwm1' ? (22.0 * Math.PI / 180) : (-22.0 * Math.PI / 180));
      }
      const lensMat = new THREE.MeshStandardMaterial({
        color: 0x0ea5e9,
        roughness: 0.2,
        metalness: 0.3,
        emissive: 0x000000,
        emissiveIntensity: 0.0
      });
      const lensMesh = new THREE.Mesh(lensGeo, lensMat);
      lensMesh.name = `lens_${pin}`;
      apertureGroup.add(lensMesh);

      // Lens Glow Flare Light
      const glowGeo = new THREE.SphereGeometry(1.6, 12, 12);
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 0.0
      });
      const glowMesh = new THREE.Mesh(glowGeo, glowMat);
      glowMesh.name = `glow_${pin}`;
      apertureGroup.add(glowMesh);

      this.group.add(apertureGroup);
      this.lensApertures[pin] = {
        group: apertureGroup,
        lens: lensMesh,
        glow: glowMesh,
        basePos: pos.clone()
      };
    });
  }

  _base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  _loadCADModel() {
    if (typeof THREE.GLTFLoader === 'undefined') {
      console.warn('GLTFLoader not found, building fallback CAD geometry.');
      this._buildFallbackGeometry();
      return;
    }

    const loader = new THREE.GLTFLoader();
    const handleGLTF = (gltf) => {
      this.cadModel = gltf.scene;
      this.cadModel.traverse(child => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;

          // Recompute vertex normals for smooth, flawless shading
          if (child.geometry) {
            child.geometry.computeVertexNormals();
          }

          const name = child.name || '';
          let mat;
          if (name.includes('nozzle')) {
            // Rich Golden Brass for Nozzle Tip
            mat = new THREE.MeshStandardMaterial({
              color: 0xf59e0b,
              roughness: 0.25,
              metalness: 0.2,
              side: THREE.DoubleSide
            });
          } else if (name.includes('heater') || name.includes('fan') || name.includes('ring_black')) {
            // Technical Matte Black / Charcoal for Heater Block, Cooling Fans, & Laser Front Focus Rings
            mat = new THREE.MeshStandardMaterial({
              color: 0x27272a,
              roughness: 0.55,
              metalness: 0.1,
              side: THREE.DoubleSide
            });
          } else if (name.includes('module_red')) {
            // Vibrant Anodized Rose / Crimson Red Laser Module Heatsinks
            mat = new THREE.MeshStandardMaterial({
              color: 0xf43f5e,
              roughness: 0.3,
              metalness: 0.15,
              side: THREE.DoubleSide
            });
          } else if (name.includes('mounting')) {
            // Bright Clean Silver Titanium / Light Slate for Main Bracket (100% visible, NOT black!)
            mat = new THREE.MeshStandardMaterial({
              color: 0x94a3b8,
              roughness: 0.35,
              metalness: 0.15,
              side: THREE.DoubleSide
            });
          } else if (name.includes('heatsink')) {
            // Bright Clean Brushed Aluminum Silver for Hotend Coldend
            mat = new THREE.MeshStandardMaterial({
              color: 0xe2e8f0,
              roughness: 0.25,
              metalness: 0.2,
              side: THREE.DoubleSide
            });
          } else {
            // Fasteners, Screws, and Hardware Parts
            mat = new THREE.MeshStandardMaterial({
              color: 0xcfd8dc,
              roughness: 0.35,
              metalness: 0.15,
              side: THREE.DoubleSide
            });
          }

          child.material = mat;
        }
      });

      this.group.add(this.cadModel);
      this.isLoaded = true;
    };

    if (window.TOOLHEAD_MODEL_BASE64) {
      try {
        const buffer = this._base64ToArrayBuffer(window.TOOLHEAD_MODEL_BASE64);
        loader.parse(buffer, '', handleGLTF, (err) => {
          console.warn('Error parsing bundled CAD toolhead, falling back to URL:', err);
          this._loadFromUrl(loader, handleGLTF);
        });
        return;
      } catch (e) {
        console.warn('Failed to parse bundled model base64, falling back to URL:', e);
      }
    }

    this._loadFromUrl(loader, handleGLTF);
  }

  _loadFromUrl(loader, handleGLTF) {
    loader.load(
      'models/toolhead_final.glb',
      handleGLTF,
      undefined,
      (err) => {
        console.error('Error loading CAD toolhead GLB from URL:', err);
        this._buildFallbackGeometry();
      }
    );
  }

  _buildFallbackGeometry() {
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.2, metalness: 0.2, side: THREE.DoubleSide });
    const coneGeo = new THREE.CylinderGeometry(3.0, 0.25, 1.5, 24);
    const coneMesh = new THREE.Mesh(coneGeo, brassMat);
    coneMesh.position.y = 0.75;
    this.group.add(coneMesh);
  }

  setPosition(worldPos) {
    this.group.position.copy(worldPos);
  }

  /**
   * Sets full 3D coordinates (X, Y, Z in mm relative to nozzle tip) for a laser diode emitter.
   */
  setLaserEmitterPosition(laserNumOrPin, x, y, z) {
    let pin = laserNumOrPin;
    if (pin === 1 || pin === '1') pin = 'laser_pwm1';
    if (pin === 2 || pin === '2') pin = 'laser_pwm2';
    if (pin === 3 || pin === '3') pin = 'laser_pwm3';

    if (this.apertures[pin]) {
      if (x !== undefined && !isNaN(parseFloat(x))) this.apertures[pin].x = parseFloat(x);
      if (y !== undefined && !isNaN(parseFloat(y))) this.apertures[pin].y = parseFloat(y);
      if (z !== undefined && !isNaN(parseFloat(z))) this.apertures[pin].z = parseFloat(z);

      if (pin === 'laser_pwm1') this.laser1Height = this.apertures[pin].y;
      if (pin === 'laser_pwm2') this.laser2Height = this.apertures[pin].y;
      if (pin === 'laser_pwm3') this.laser3Height = this.apertures[pin].y;

      if (this.lensApertures[pin]) {
        this.lensApertures[pin].group.position.copy(this.apertures[pin]);
      }
    }
  }

  getLaserEmitterPositions() {
    return {
      laser1: { x: this.apertures.laser_pwm1.x, y: this.apertures.laser_pwm1.y, z: this.apertures.laser_pwm1.z },
      laser2: { x: this.apertures.laser_pwm2.x, y: this.apertures.laser_pwm2.y, z: this.apertures.laser_pwm2.z },
      laser3: { x: this.apertures.laser_pwm3.x, y: this.apertures.laser_pwm3.y, z: this.apertures.laser_pwm3.z },
      angleDeg: this.laserAngleDeg
    };
  }

  /**
   * Repositions Laser 1 or Laser 2 diode module height / offset (mm above nozzle tip).
   */
  setDiodeHeight(laserNum, heightMm) {
    const h = parseFloat(heightMm);
    if (isNaN(h)) return;

    if (laserNum === 1) {
      this.laser1Height = h;
      this.apertures['laser_pwm1'].y = h;
      if (this.lensApertures['laser_pwm1']) {
        this.lensApertures['laser_pwm1'].group.position.y = h;
      }
    } else if (laserNum === 2) {
      this.laser2Height = h;
      this.apertures['laser_pwm2'].y = h;
      if (this.lensApertures['laser_pwm2']) {
        this.lensApertures['laser_pwm2'].group.position.y = h;
      }
    }
  }

  /**
   * Updates the optical laser beam ray angle (degrees from horizontal).
   * Decoupled: only updates the beam ray vector, without rotating the physical CAD housing.
   */
  setBeamAngle(angleDeg) {
    const a = parseFloat(angleDeg);
    if (isNaN(a) || a < 0 || a > 89) return;

    this.laserAngleDeg = a;
    this.laserAngleRad = (a * Math.PI) / 180;
  }

  getDiodeSettings() {
    return {
      h1: this.laser1Height,
      h2: this.laser2Height,
      angleDeg: this.laserAngleDeg
    };
  }

  setActiveLaser(pinName, power) {
    ['laser_pwm1', 'laser_pwm2', 'laser_pwm3'].forEach(pin => {
      const aperture = this.lensApertures[pin];
      if (aperture) {
        if (pin === pinName && power > 0.001) {
          if (aperture.lens.material) {
            aperture.lens.material.emissive.setHex(0x00f0ff);
            aperture.lens.material.emissiveIntensity = 3.5 * power;
          }
          if (aperture.glow.material) {
            aperture.glow.material.opacity = 0.9 * Math.min(1, power);
          }
        } else {
          if (aperture.lens.material) {
            aperture.lens.material.emissive.setHex(0x000000);
            aperture.lens.material.emissiveIntensity = 0;
          }
          if (aperture.glow.material) {
            aperture.glow.material.opacity = 0.0;
          }
        }
      }
    });
  }

  getEmitterWorldPosition(pinName) {
    const aperture = this.lensApertures[pinName];
    const pos = new THREE.Vector3();
    if (aperture) {
      aperture.group.getWorldPosition(pos);
    } else {
      this.group.getWorldPosition(pos);
    }
    return pos;
  }

  /**
   * Returns the physical optical unit ray vector for the active laser in world space
   */
  getBeamDirectionWorld(pinName) {
    if (pinName === 'laser_pwm1') {
      // Laser 1 shoots from right down-inward towards -X at configured optical angle
      const angle = (this.laserAngleDeg * Math.PI) / 180.0;
      return new THREE.Vector3(-Math.cos(angle), -Math.sin(angle), 0).normalize();
    } else if (pinName === 'laser_pwm2') {
      // Laser 2 shoots from left down-inward towards +X at configured optical angle
      const angle = (this.laserAngleDeg * Math.PI) / 180.0;
      return new THREE.Vector3(Math.cos(angle), -Math.sin(angle), 0).normalize();
    } else if (pinName === 'laser_pwm3') {
      // Laser 3 shoots straight down
      return new THREE.Vector3(0, -1, 0);
    }
    return new THREE.Vector3(0, -1, 0);
  }

  setVisible(visible) {
    this.group.visible = visible;
  }
}

window.ToolheadAssembly = ToolheadAssembly;
