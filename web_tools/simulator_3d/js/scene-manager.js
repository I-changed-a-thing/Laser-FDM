/**
 * 3D Scene Manager, Studio Lighting, PEI Print Bed, and Bloom Post-Processing
 */

class SceneManager {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.width = this.container.clientWidth || window.innerWidth;
    this.height = this.container.clientHeight || window.innerHeight;

    // Bed configuration (Elegoo Neptune 4 / Ender standard 235x235mm)
    this.bedWidth = 235;
    this.bedDepth = 235;
    this.bedCenterX = 117.5;
    this.bedCenterY = 117.5;

    // Camera modes
    this.cameraMode = 'orbit'; // 'orbit', 'follow', 'macro', 'turntable'
    this.turntableAngle = 0;
    this.targetCameraPos = new THREE.Vector3(0, 80, 160);
    this.targetLookAt = new THREE.Vector3(0, 15, 0);

    this.bloomEnabled = true;

    this._initScene();
    this._initLights();
    this._initPrintBed();
    this._initPostProcessing();
    this._setupResizeListener();
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07090e);
    this.scene.fog = new THREE.FogExp2(0x07090e, 0.002);

    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.5, 2000);
    this.camera.position.set(0, 100, 180);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.container.appendChild(this.renderer.domElement);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02; // Don't go below bed
    this.controls.target.set(0, 10, 0);
  }

  _initLights() {
    // Studio Ambient Light (Soft, even, balanced)
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.15);
    this.scene.add(ambientLight);

    // Key Light (Warm, soft studio key light with gentle shadows)
    this.keyLight = new THREE.DirectionalLight(0xfffbeb, 1.5);
    this.keyLight.position.set(80, 180, 100);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.width = 2048;
    this.keyLight.shadow.mapSize.height = 2048;
    this.keyLight.shadow.camera.near = 10;
    this.keyLight.shadow.camera.far = 400;
    const d = 140;
    this.keyLight.shadow.camera.left = -d;
    this.keyLight.shadow.camera.right = d;
    this.keyLight.shadow.camera.top = d;
    this.keyLight.shadow.camera.bottom = -d;
    this.keyLight.shadow.bias = -0.0005;
    this.scene.add(this.keyLight);

    // Fill Light (Soft neutral fill to illuminate shadowed faces)
    const fillLight = new THREE.DirectionalLight(0x94a3b8, 0.95);
    fillLight.position.set(-120, 140, 100);
    this.scene.add(fillLight);

    // Front Light (Illuminates toolhead face directly)
    const frontLight = new THREE.DirectionalLight(0xffffff, 0.85);
    frontLight.position.set(0, 120, 160);
    this.scene.add(frontLight);

    // Rim Light (Subtle cool rim highlighting toolhead & silhouette)
    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.65);
    rimLight.position.set(0, 100, -150);
    this.scene.add(rimLight);
  }

  _initPrintBed() {
    this.bedGroup = new THREE.Group();

    // 1. Gold PEI Sheet Bed Plate
    const bedGeo = new THREE.BoxGeometry(this.bedWidth, 3, this.bedDepth);
    
    // Create high-detail procedural canvas texture for PEI grid markings
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');

    // Base dark textured carbon/PEI background
    ctx.fillStyle = '#181b24';
    ctx.fillRect(0, 0, 1024, 1024);

    // Subtle PEI grain noise
    for (let i = 0; i < 20000; i++) {
      const gx = Math.random() * 1024;
      const gy = Math.random() * 1024;
      const val = Math.random() * 20 + 20;
      ctx.fillStyle = `rgba(${val+10}, ${val+5}, ${val}, 0.15)`;
      ctx.fillRect(gx, gy, 1.5, 1.5);
    }

    // Grid lines (every 10mm & 50mm)
    const step = 1024 / (this.bedWidth / 10);
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= 1024; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 1024);
      ctx.stroke();
    }
    for (let y = 0; y <= 1024; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1024, y);
      ctx.stroke();
    }

    // 50mm major grid lines
    const majorStep = step * 5;
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.2)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= 1024; x += majorStep) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 1024);
      ctx.stroke();
    }
    for (let y = 0; y <= 1024; y += majorStep) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1024, y);
      ctx.stroke();
    }

    // Center crosshair & branding
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(512, 512, 16, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('235 x 235 mm • LASER SMOOTHING BED', 512, 980);

    const bedTexture = new THREE.CanvasTexture(canvas);
    bedTexture.anisotropy = 8;

    const bedMat = new THREE.MeshStandardMaterial({
      map: bedTexture,
      roughness: 0.65,
      metalness: 0.25
    });

    const bedMesh = new THREE.Mesh(bedGeo, bedMat);
    bedMesh.position.y = -1.5;
    bedMesh.receiveShadow = true;
    this.bedGroup.add(bedMesh);

    // 2. Aluminum Base Bevel Frame
    const frameGeo = new THREE.BoxGeometry(this.bedWidth + 8, 4, this.bedDepth + 8);
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.4,
      metalness: 0.8
    });
    const frameMesh = new THREE.Mesh(frameGeo, frameMat);
    frameMesh.position.y = -4.5;
    this.bedGroup.add(frameMesh);

    this.scene.add(this.bedGroup);
  }

  _initPostProcessing() {
    // Direct hardware-accelerated WebGL rendering with native MSAA antialiasing
  }

  _setupResizeListener() {
    window.addEventListener('resize', () => {
      this.width = this.container.clientWidth || window.innerWidth;
      this.height = this.container.clientHeight || window.innerHeight;
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(this.width, this.height);
    });
  }

  /**
   * Converts 3D Printer G-code Coordinates (X, Y, Z in mm) to Three.js World Space Coordinates
   */
  toWorld(x, y, z) {
    return new THREE.Vector3(
      x - this.bedCenterX,
      z,
      -(y - this.bedCenterY)
    );
  }

  /**
   * Converts Three.js World Space Coordinates back to Printer G-code Coordinates (X, Y, Z in mm)
   */
  fromWorld(worldVec) {
    return {
      x: worldVec.x + this.bedCenterX,
      y: -worldVec.z + this.bedCenterY,
      z: worldVec.y
    };
  }

  setCameraMode(mode) {
    this.cameraMode = mode;
    if (mode === 'orbit') {
      this.controls.enabled = true;
    } else {
      this.controls.enabled = (mode === 'turntable');
    }
  }

  setBloomEnabled(enabled) {
    this.bloomEnabled = enabled;
    this.bloomPass.enabled = enabled;
  }

  setMacroDistance(scale) {
    this.macroDistanceScale = Math.max(0.3, Math.min(3.0, scale));
  }

  setMacroAngle(pitchDeg, yawDeg) {
    if (pitchDeg !== undefined) this.macroPitchDeg = Math.max(2.0, Math.min(80.0, pitchDeg));
    if (yawDeg !== undefined) this.macroYawDeg = Math.max(-80.0, Math.min(80.0, yawDeg));
  }

  updateCamera(toolheadWorldPos, laserTargetWorldPos, activeLaser, dt) {
    if (this.cameraMode === 'orbit') {
      this.controls.update();
    } else if (this.cameraMode === 'follow' && toolheadWorldPos) {
      // Over-the-shoulder chase camera
      const offset = new THREE.Vector3(30, 25, 45);
      const desiredPos = toolheadWorldPos.clone().add(offset);
      this.camera.position.lerp(desiredPos, Math.min(1.0, dt * 4.0));
      this.controls.target.lerp(toolheadWorldPos, Math.min(1.0, dt * 5.0));
      this.controls.update();
    } else if (this.cameraMode === 'macro') {
      // Macro Camera: dynamic tracking between active laser melt zone (when lasering) and nozzle (when printing)
      const isLasering = (activeLaser !== null && activeLaser !== undefined);

      let targetFocus;
      if (isLasering && laserTargetWorldPos) {
        targetFocus = laserTargetWorldPos;
      } else {
        // Normal printing / travel: Macro camera tracks the active nozzle orifice!
        targetFocus = toolheadWorldPos || new THREE.Vector3(0, 5, 0);
      }

      // User-configurable Macro Angle (Pitch) & Distance (Zoom)
      const pitchDeg = (this.macroPitchDeg !== undefined) ? this.macroPitchDeg : 20.0;
      const pitchRad = (pitchDeg * Math.PI) / 180.0;
      const dist = 22.0 * (this.macroDistanceScale || 1.0);
      const height = dist * Math.sin(pitchRad);
      const horizDist = dist * Math.cos(pitchRad);

      let azimuthDeg = 35.0;
      if (isLasering && activeLaser === 'laser_pwm1') azimuthDeg = 65.0;
      else if (isLasering && activeLaser === 'laser_pwm2') azimuthDeg = -65.0;
      else if (isLasering && activeLaser === 'laser_pwm3') azimuthDeg = 45.0;

      if (this.macroYawDeg !== undefined) azimuthDeg += this.macroYawDeg;

      const azimuthRad = (azimuthDeg * Math.PI) / 180.0;
      const targetMacroOffset = new THREE.Vector3(
        horizDist * Math.sin(azimuthRad),
        height,
        horizDist * Math.cos(azimuthRad)
      );

      if (this.macroNominalY === undefined) {
        this.macroNominalY = targetFocus.y;
      } else {
        // Smoothly track nominal layer height changes while ignoring high-frequency jitter
        this.macroNominalY += (targetFocus.y - this.macroNominalY) * Math.min(1.0, dt * 3.0);
      }

      if (!this.currentMacroOffset) {
        this.currentMacroOffset = targetMacroOffset.clone();
      } else {
        // Smoothly transition camera vantage point
        this.currentMacroOffset.lerp(targetMacroOffset, Math.min(1.0, dt * 4.5));
      }

      const smoothedFocus = new THREE.Vector3(targetFocus.x, this.macroNominalY, targetFocus.z);
      const desiredPos = smoothedFocus.clone().add(this.currentMacroOffset);

      this.camera.position.lerp(desiredPos, Math.min(1.0, dt * 6.0));
      this.controls.target.lerp(smoothedFocus, Math.min(1.0, dt * 6.0));
      this.controls.update();
    } else if (this.cameraMode === 'turntable') {
      this.turntableAngle += dt * 0.35;
      const radius = 140;
      const height = 75;
      this.camera.position.x = Math.sin(this.turntableAngle) * radius;
      this.camera.position.z = Math.cos(this.turntableAngle) * radius;
      this.camera.position.y = height;
      this.controls.target.set(0, 15, 0);
      this.controls.update();
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

window.SceneManager = SceneManager;
