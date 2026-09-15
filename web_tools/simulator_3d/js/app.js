/**
 * Application Orchestrator & Playback Director with Real 3D Physical Ray Tracing
 */

class App {
  constructor() {
    this.parser = new GCodeParser();
    this.sceneManager = new SceneManager('canvas-container');
    this.toolhead = new ToolheadAssembly(this.sceneManager.scene, this.sceneManager);
    this.laserFx = new LaserEffects(this.sceneManager.scene);
    this.wallRenderer = new WallRenderer(this.sceneManager.scene, this.sceneManager);

    // Initial default parking position (above the bed center)
    this.toolhead.setPosition(this.sceneManager.toWorld(117.5, 117.5, 30));

    // Playback State
    this.isPlaying = false;
    this.playbackSpeed = 1.0;
    this.currentTime = 0.0;
    this.totalTime = 0.0;
    this.currentSegmentIndex = 0;
    this.activeLayer = 0;
    this.parsedData = null;
    this.isScrubbing = false;

    // Manual Jog & Laser Calibration State
    this.manualJogActive = false;
    this.manualToolheadPos = new THREE.Vector3(0, 50, 0);
    this.manualStepSize = 1.0;
    this.manualActiveLaser = null;
    this.manualLaserPower = 1.0;

    // Laser Energy Heatmap State
    this.heatmapActive = false;
    this.heatmapAcceleration = 5000.0;
    this.heatmapBeamWaist = 0.35;
    this.heatmapLaserPowerWatts = 10.0;
    this.heatmapData = null;

    this.lastFrameTime = performance.now();

    this._bindUI();
    this._bindKeyboard();
    this._bindManualJog();
    this._bindHeatmapUI();
    this._initStartModal();
    this._initSettingsModal();
    this._loadSavedSettings();

    // Start render loop
    requestAnimationFrame(this._animate.bind(this));
  }

  _initStartModal() {
    const startModal = document.getElementById('start-modal');
    if (startModal) {
      startModal.style.display = 'flex';
    }

    // Button: Load Sample (Test Cube)
    const btnSample = document.getElementById('btn-load-sample');
    if (btnSample) {
      btnSample.addEventListener('click', () => {
        if (window.DEFAULT_GCODE) {
          if (startModal) startModal.style.display = 'none';
          this.loadGCode(window.DEFAULT_GCODE, 'Test cube.gcode');
        }
      });
    }

    // Modal File input
    const modalFileInput = document.getElementById('modal-file-input');
    if (modalFileInput) {
      modalFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (ev) => {
            startModal.style.display = 'none';
            this.loadGCode(ev.target.result, file.name);
          };
          reader.readAsText(file);
        }
      });
    }

    // Modal dropzone
    const dropzone = document.getElementById('modal-dropzone');
    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          const reader = new FileReader();
          reader.onload = (ev) => {
            startModal.style.display = 'none';
            this.loadGCode(ev.target.result, file.name);
          };
          reader.readAsText(file);
        }
      });
      dropzone.addEventListener('click', () => {
        if (modalFileInput) modalFileInput.click();
      });
    }

    // Close button (✕)
    const btnCloseModal = document.getElementById('btn-close-start-modal');
    if (btnCloseModal) {
      btnCloseModal.addEventListener('click', () => {
        if (startModal) startModal.style.display = 'none';
      });
    }

    // Dismiss when clicking outside modal card on backdrop
    if (startModal) {
      startModal.addEventListener('click', (e) => {
        if (e.target === startModal) {
          startModal.style.display = 'none';
        }
      });
    }
  }

  _getDefaultSettings() {
    return {
      laser1: { x: 68.45, y: 27.8, z: -0.18 },
      laser2: { x: -68.45, y: 29.0, z: -0.18 },
      laser3: { x: -34.08, y: 87.52, z: 72.80 },
      laserAngle: 23.0,
      focalDistance: 100.0
    };
  }

  _loadSavedSettings() {
    let settings = this._getDefaultSettings();
    try {
      const raw = localStorage.getItem('laser_visualizer_settings_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.laser1) settings.laser1 = { ...settings.laser1, ...parsed.laser1 };
        if (parsed.laser2) settings.laser2 = { ...settings.laser2, ...parsed.laser2 };
        if (parsed.laser3) settings.laser3 = { ...settings.laser3, ...parsed.laser3 };
        if (parsed.laserAngle !== undefined) settings.laserAngle = parseFloat(parsed.laserAngle);
        if (parsed.focalDistance !== undefined) settings.focalDistance = parseFloat(parsed.focalDistance);
      }
    } catch (e) {
      console.warn('Failed to load saved settings from localStorage:', e);
    }
    this._applySettings(settings, false);
  }

  _applySettings(settings, recomputeSmoothing = true) {
    // 1. Update Toolhead Apertures
    this.toolhead.setLaserEmitterPosition(1, settings.laser1.x, settings.laser1.y, settings.laser1.z);
    this.toolhead.setLaserEmitterPosition(2, settings.laser2.x, settings.laser2.y, settings.laser2.z);
    this.toolhead.setLaserEmitterPosition(3, settings.laser3.x, settings.laser3.y, settings.laser3.z);
    this.toolhead.setBeamAngle(settings.laserAngle);

    // 2. Update Laser Effects
    if (this.laserFx && settings.focalDistance) {
      this.laserFx.setFocalDistance(settings.focalDistance);
    }

    // 3. Update Settings Modal Inputs
    const setL1X = document.getElementById('set-l1-x');
    const setL1Y = document.getElementById('set-l1-y');
    const setL1Z = document.getElementById('set-l1-z');
    const setL2X = document.getElementById('set-l2-x');
    const setL2Y = document.getElementById('set-l2-y');
    const setL2Z = document.getElementById('set-l2-z');
    const setL3X = document.getElementById('set-l3-x');
    const setL3Y = document.getElementById('set-l3-y');
    const setL3Z = document.getElementById('set-l3-z');
    const setAngle = document.getElementById('set-beam-angle');
    const setFocal = document.getElementById('set-focal-dist');

    if (setL1X) setL1X.value = settings.laser1.x;
    if (setL1Y) setL1Y.value = settings.laser1.y;
    if (setL1Z) setL1Z.value = settings.laser1.z;
    if (setL2X) setL2X.value = settings.laser2.x;
    if (setL2Y) setL2Y.value = settings.laser2.y;
    if (setL2Z) setL2Z.value = settings.laser2.z;
    if (setL3X) setL3X.value = settings.laser3.x;
    if (setL3Y) setL3Y.value = settings.laser3.y;
    if (setL3Z) setL3Z.value = settings.laser3.z;
    if (setAngle) setAngle.value = settings.laserAngle;
    if (setFocal) setFocal.value = settings.focalDistance;

    // 4. Update Left HUD inputs
    const hudL1 = document.getElementById('laser1-height');
    const hudL2 = document.getElementById('laser2-height');
    const hudAngle = document.getElementById('laser-angle');
    const hudFocal = document.getElementById('laser-focal-dist');
    if (hudL1) hudL1.value = settings.laser1.y;
    if (hudL2) hudL2.value = settings.laser2.y;
    if (hudAngle) hudAngle.value = settings.laserAngle;
    if (hudFocal) hudFocal.value = settings.focalDistance;

    // 5. Trigger wall smoothing recomputation if requested
    if (recomputeSmoothing && this.wallRenderer && this.parsedData) {
      this.wallRenderer.recomputeLaserSmoothing(this.toolhead);
      this.wallRenderer.syncToTime(this.currentTime, this.currentSegmentIndex);
    }
  }

  _collectSettingsFromModal() {
    return {
      laser1: {
        x: parseFloat(document.getElementById('set-l1-x')?.value) || 68.45,
        y: parseFloat(document.getElementById('set-l1-y')?.value) || 27.8,
        z: parseFloat(document.getElementById('set-l1-z')?.value) || -0.18
      },
      laser2: {
        x: parseFloat(document.getElementById('set-l2-x')?.value) || -68.45,
        y: parseFloat(document.getElementById('set-l2-y')?.value) || 29.0,
        z: parseFloat(document.getElementById('set-l2-z')?.value) || -0.18
      },
      laser3: {
        x: parseFloat(document.getElementById('set-l3-x')?.value) || -34.08,
        y: parseFloat(document.getElementById('set-l3-y')?.value) || 87.52,
        z: parseFloat(document.getElementById('set-l3-z')?.value) || 72.80
      },
      laserAngle: parseFloat(document.getElementById('set-beam-angle')?.value) || 23.0,
      focalDistance: parseFloat(document.getElementById('set-focal-dist')?.value) || 100.0
    };
  }

  _saveSettings() {
    const settings = this._collectSettingsFromModal();
    try {
      localStorage.setItem('laser_visualizer_settings_v1', JSON.stringify(settings));
    } catch (e) {
      console.warn('Failed to save settings to localStorage:', e);
    }
    this._applySettings(settings, true);

    const statusBadge = document.getElementById('settings-save-status');
    if (statusBadge) {
      statusBadge.textContent = '✓ Saved to Storage';
      statusBadge.classList.add('show');
      setTimeout(() => statusBadge.classList.remove('show'), 2200);
    }
  }

  _initSettingsModal() {
    const modal = document.getElementById('settings-modal');
    const openBtns = document.querySelectorAll('.settings-trigger-btn, #btn-open-settings, #btn-open-settings-hud');
    const closeBtn = document.getElementById('btn-close-settings');
    const saveBtn = document.getElementById('btn-save-settings');
    const resetBtn = document.getElementById('btn-reset-defaults');

    const openModal = (e) => {
      if (e) e.stopPropagation();
      if (modal) {
        modal.style.display = 'flex';
        this._loadSavedSettings();
      }
    };

    openBtns.forEach(btn => {
      btn.addEventListener('click', openModal);
    });

    const closeModal = () => {
      if (modal) modal.style.display = 'none';
    };

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && modal.style.display === 'flex') {
        closeModal();
      }
    });

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        this._saveSettings();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (confirm('Reset all laser emitter coordinates and optics to factory defaults?')) {
          try {
            localStorage.removeItem('laser_visualizer_settings_v1');
          } catch (e) {}
          const defaults = this._getDefaultSettings();
          this._applySettings(defaults, true);
          const statusBadge = document.getElementById('settings-save-status');
          if (statusBadge) {
            statusBadge.textContent = '✓ Defaults Restored';
            statusBadge.classList.add('show');
            setTimeout(() => {
              statusBadge.classList.remove('show');
              statusBadge.textContent = '✓ Saved to Storage';
            }, 2200);
          }
        }
      });
    }

    // Live preview when editing any modal input field
    const modalInputs = modal ? modal.querySelectorAll('input') : [];
    modalInputs.forEach(input => {
      input.addEventListener('input', () => {
        const settings = this._collectSettingsFromModal();
        this._applySettings(settings, true);
      });
    });
  }

  loadGCode(gcodeText, filename = 'custom.gcode') {
    const loadingOverlay = document.getElementById('loading-overlay');
    loadingOverlay.style.display = 'flex';
    loadingOverlay.style.opacity = '1';

    setTimeout(() => {
      try {
        this.parsedData = this.parser.parse(gcodeText);
        this.totalTime = this.parsedData.totalTime;
        this.currentTime = 0.0;
        this.currentSegmentIndex = 0;

        const settings = this.parsedData.laserSettings;

        // Set laser spot sizing according to wall_offset_level (0, 1, 2)
        const offsetLevel = parseInt(settings.wall_offset_level || 2, 10);
        this.laserFx.setOffsetLevel(offsetLevel);

        // Build 3D Wall Extrusion Geometry
        this.wallRenderer.buildGeometry(this.parsedData, this.toolhead);

        // Update UI displays
        document.getElementById('current-filename').textContent = `${filename} • OrcaSlicer Advanced Post-Processor`;
        
        const modeText = settings.wall_mode_pass1 ? `Z-WOBBLE ${settings.wall_mode_pass1.toUpperCase()} SMOOTHING (LEVEL ${offsetLevel})` : 'LASER WALL SMOOTHING';
        document.getElementById('laser-mode-text').textContent = modeText;

        // Setup timeline laser markers
        this._renderLaserMarkers();

        // Setup layer slider max
        const layerSlider = document.getElementById('layer-slider');
        layerSlider.max = Math.max(1, this.parsedData.layers.length - 1);
        layerSlider.value = layerSlider.max;
        document.getElementById('layer-slider-val').textContent = 'All';

        // Update Total Time
        document.getElementById('time-total').textContent = this._formatTime(this.totalTime);

        // Reset or recalculate Heatmap
        this.heatmapData = null;
        if (this.heatmapActive) {
          this.calculateHeatmap();
        }

        loadingOverlay.style.opacity = '0';
        setTimeout(() => { loadingOverlay.style.display = 'none'; }, 400);

        this.isPlaying = true;
        this._updatePlayPauseIcon();
      } catch (err) {
        console.error('Failed to load/parse G-code in 3D simulator:', err);
        alert('Failed to load G-Code file: ' + (err && err.message ? err.message : err));
        loadingOverlay.style.opacity = '0';
        setTimeout(() => { loadingOverlay.style.display = 'none'; }, 400);
      }
    }, 50);
  }

  _renderLaserMarkers() {
    const container = document.getElementById('laser-markers-container');
    container.innerHTML = '';
    if (!this.parsedData || !this.parsedData.laserPasses || this.totalTime <= 0) return;

    this.parsedData.laserPasses.forEach((pass) => {
      const seg = this.parsedData.segments[pass.startSegment];
      if (seg) {
        const pct = (seg.startTime / this.totalTime) * 100;
        const marker = document.createElement('div');
        marker.className = 'laser-marker-dot';
        marker.style.left = `${pct}%`;
        marker.title = `Laser Smoothing Pass (Layer ${pass.layerIndex})`;
        marker.addEventListener('click', (e) => {
          e.stopPropagation();
          this.seekToTime(seg.startTime);
        });
        container.appendChild(marker);
      }
    });
  }

  _bindUI() {
    // Play / Pause Button
    const playBtn = document.getElementById('btn-play-pause');
    playBtn.addEventListener('click', () => {
      this.isPlaying = !this.isPlaying;
      if (this.isPlaying) {
        this.resetManualJog();
      }
      this._updatePlayPauseIcon();
    });

    // Reset Button
    document.getElementById('btn-reset').addEventListener('click', () => {
      this.seekToTime(0);
    });

    // Step Forward / Backward
    document.getElementById('btn-step-fwd').addEventListener('click', () => {
      this.stepSegment(1);
    });
    document.getElementById('btn-step-back').addEventListener('click', () => {
      this.stepSegment(-1);
    });

    // Speed Chips
    const speedChips = document.querySelectorAll('.speed-chip');
    speedChips.forEach(chip => {
      chip.addEventListener('click', () => {
        speedChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.playbackSpeed = parseFloat(chip.getAttribute('data-speed'));
      });
    });

    // Timeline Slider
    const timeline = document.getElementById('timeline-slider');
    timeline.addEventListener('input', () => {
      this.isScrubbing = true;
      const targetTime = (parseFloat(timeline.value) / 1000) * this.totalTime;
      this.seekToTime(targetTime);
    });
    timeline.addEventListener('change', () => {
      this.isScrubbing = false;
    });

    // Layer Slider
    const layerSlider = document.getElementById('layer-slider');
    layerSlider.addEventListener('input', () => {
      const val = parseInt(layerSlider.value, 10);
      const isAll = val >= parseInt(layerSlider.max, 10);
      document.getElementById('layer-slider-val').textContent = isAll ? 'All' : val;
      this.wallRenderer.setLayerFilter(isAll ? 9999 : val);
    });

    // Prev / Next Layer Buttons
    document.getElementById('btn-prev-layer').addEventListener('click', () => {
      this.jumpLayer(-1);
    });
    document.getElementById('btn-next-layer').addEventListener('click', () => {
      this.jumpLayer(1);
    });

    // Prev / Next Laser Pass Buttons
    document.getElementById('btn-prev-laser').addEventListener('click', () => {
      this.jumpLaserPass(-1);
    });
    document.getElementById('btn-next-laser').addEventListener('click', () => {
      this.jumpLaserPass(1);
    });

    // Camera Selector Buttons
    const camBtns = document.querySelectorAll('.cam-btn');
    camBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        camBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.getAttribute('data-cam');
        this.sceneManager.setCameraMode(mode);
      });
    });

    // Macro Distance Slider (Zoom Control)
    const macroDistSlider = document.getElementById('macro-dist-slider');
    const macroDistVal = document.getElementById('macro-dist-val');
    if (macroDistSlider) {
      macroDistSlider.addEventListener('input', () => {
        const val = parseFloat(macroDistSlider.value);
        if (!isNaN(val)) {
          if (macroDistVal) macroDistVal.textContent = `${val.toFixed(1)}x`;
          this.sceneManager.setMacroDistance(val);
        }
      });
    }

    // Macro Angle Slider (Pitch Angle Control)
    const macroAngleSlider = document.getElementById('macro-angle-slider');
    const macroAngleVal = document.getElementById('macro-angle-val');
    if (macroAngleSlider) {
      macroAngleSlider.addEventListener('input', () => {
        const val = parseFloat(macroAngleSlider.value);
        if (!isNaN(val)) {
          if (macroAngleVal) macroAngleVal.textContent = `${Math.round(val)}°`;
          this.sceneManager.setMacroAngle(val);
        }
      });
    }

    // Header File Upload Picker
    const fileInput = document.getElementById('gcode-file-input');
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          this.loadGCode(ev.target.result, file.name);
        };
        reader.readAsText(file);
      }
    });

    // Drag and drop onto canvas
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        const reader = new FileReader();
        reader.onload = (ev) => {
          const startModal = document.getElementById('start-modal');
          if (startModal) startModal.style.display = 'none';
          this.loadGCode(ev.target.result, file.name);
        };
        reader.readAsText(file);
      }
    });

    // Clean UI Mode Toggle (H key / button)
    const cleanBtn = document.getElementById('btn-clean-ui');
    cleanBtn.addEventListener('click', () => this.toggleCleanUI());

    // Toggles
    document.getElementById('toggle-toolhead').addEventListener('change', (e) => {
      this.toolhead.setVisible(e.target.checked);
    });
    document.getElementById('toggle-laser-beam').addEventListener('change', (e) => {
      this.laserFx.setVisible(e.target.checked);
    });
    document.getElementById('toggle-bloom').addEventListener('change', (e) => {
      this.sceneManager.setBloomEnabled(e.target.checked);
    });
    document.getElementById('toggle-travel-moves').addEventListener('change', (e) => {
      this.wallRenderer.setShowTravelMoves(e.target.checked);
    });

    this._bindDiodeAlignment();
  }

  _bindDiodeAlignment() {
    const laser1Input = document.getElementById('laser1-height');
    const laser2Input = document.getElementById('laser2-height');
    const angleInput  = document.getElementById('laser-angle');

    const syncSmoothingAndSave = () => {
      if (this.wallRenderer && this.parsedData) {
        this.wallRenderer.recomputeLaserSmoothing(this.toolhead);
        this.wallRenderer.syncToTime(this.currentTime, this.currentSegmentIndex);
      }
      // Keep Settings Modal inputs in sync
      const setL1Y = document.getElementById('set-l1-y');
      const setL2Y = document.getElementById('set-l2-y');
      const setAngle = document.getElementById('set-beam-angle');
      if (setL1Y && laser1Input) setL1Y.value = laser1Input.value;
      if (setL2Y && laser2Input) setL2Y.value = laser2Input.value;
      if (setAngle && angleInput) setAngle.value = angleInput.value;

      try {
        const settings = this._collectSettingsFromModal();
        localStorage.setItem('laser_visualizer_settings_v1', JSON.stringify(settings));
      } catch (e) {}
    };

    const applyLaser1 = () => {
      const v = parseFloat(laser1Input.value);
      if (!isNaN(v)) {
        this.toolhead.setDiodeHeight(1, v);
        syncSmoothingAndSave();
      }
    };
    const applyLaser2 = () => {
      const v = parseFloat(laser2Input.value);
      if (!isNaN(v)) {
        this.toolhead.setDiodeHeight(2, v);
        syncSmoothingAndSave();
      }
    };
    const applyAngle = () => {
      const v = parseFloat(angleInput.value);
      if (!isNaN(v)) {
        this.toolhead.setBeamAngle(v);
        syncSmoothingAndSave();
      }
    };

    // Live update on direct input change
    laser1Input.addEventListener('input',  applyLaser1);
    laser1Input.addEventListener('change', applyLaser1);
    laser2Input.addEventListener('input',  applyLaser2);
    laser2Input.addEventListener('change', applyLaser2);
    angleInput.addEventListener('input',   applyAngle);
    angleInput.addEventListener('change',  applyAngle);

    // Initial sync
    applyLaser1();
    applyLaser2();
    applyAngle();

    // Nudge buttons (▲ / ▼)
    document.querySelectorAll('.diode-nudge').forEach(btn => {
      btn.addEventListener('click', () => {
        const delta = parseFloat(btn.getAttribute('data-delta'));
        const laserNum = btn.getAttribute('data-laser');
        const param    = btn.getAttribute('data-param');

        if (param === 'angle') {
          angleInput.value = Math.max(5, Math.min(89, parseFloat(angleInput.value) + delta)).toFixed(1);
          applyAngle();
        } else if (param === 'focal') {
          const focalInput = document.getElementById('laser-focal-dist');
          if (focalInput) {
            focalInput.value = Math.max(10, Math.min(80, parseFloat(focalInput.value) + delta)).toFixed(1);
            this.laserFx.setFocalDistance(focalInput.value);
            const setFocal = document.getElementById('set-focal-dist');
            if (setFocal) setFocal.value = focalInput.value;
            try {
              const settings = this._collectSettingsFromModal();
              localStorage.setItem('laser_visualizer_settings_v1', JSON.stringify(settings));
            } catch (e) {}
          }
        } else if (laserNum === '1') {
          laser1Input.value = Math.max(5, Math.min(80, parseFloat(laser1Input.value) + delta)).toFixed(1);
          applyLaser1();
        } else if (laserNum === '2') {
          laser2Input.value = Math.max(5, Math.min(80, parseFloat(laser2Input.value) + delta)).toFixed(1);
          applyLaser2();
        }
      });
    });
  }

  _bindManualJog() {
    // Realistic Beam Toggle
    const realisticToggle = document.getElementById('toggle-realistic-beam');
    if (realisticToggle) {
      realisticToggle.addEventListener('change', (e) => {
        this.laserFx.setRealisticBeam(e.target.checked);
      });
    }

    // Focal Waist Distance input
    const focalInput = document.getElementById('laser-focal-dist');
    if (focalInput) {
      focalInput.addEventListener('input', (e) => {
        this.laserFx.setFocalDistance(e.target.value);
      });
      focalInput.addEventListener('change', (e) => {
        this.laserFx.setFocalDistance(e.target.value);
      });
    }

    // Step Size Selector Chips
    document.querySelectorAll('.jog-step-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.jog-step-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.manualStepSize = parseFloat(chip.getAttribute('data-step')) || 1.0;
      });
    });

    // 3-Axis Jog Buttons
    document.querySelectorAll('.jog-btn[data-axis]').forEach(btn => {
      btn.addEventListener('click', () => {
        const axis = btn.getAttribute('data-axis');
        const dir = parseFloat(btn.getAttribute('data-dir')) || 1;
        this.jogAxis(axis, dir);
      });
    });

    // Jog Reset Button
    const resetBtn = document.getElementById('btn-jog-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.resetManualJog());
    }

    // Manual Laser Toggle Buttons
    document.querySelectorAll('.jog-laser-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pin = btn.getAttribute('data-laser');
        this.toggleManualLaser(pin);
      });
    });

    // Direct Coordinate Input fields
    const posX = document.getElementById('jog-pos-x');
    const posY = document.getElementById('jog-pos-y');
    const posZ = document.getElementById('jog-pos-z');

    const handleCoordChange = () => {
      const x = parseFloat(posX.value) || 0;
      const y = parseFloat(posY.value) || 0;
      const z = parseFloat(posZ.value) || 0;
      this.setManualPos(x, y, z);
    };

    if (posX) posX.addEventListener('change', handleCoordChange);
    if (posY) posY.addEventListener('change', handleCoordChange);
    if (posZ) posZ.addEventListener('change', handleCoordChange);
  }

  jogAxis(axis, direction) {
    if (!this.manualJogActive) {
      this.manualJogActive = true;
      if (this.isPlaying) {
        this.isPlaying = false;
        this._updatePlayPauseIcon();
      }
      if (this.toolhead && this.toolhead.group) {
        this.manualToolheadPos.copy(this.toolhead.group.position);
      }
    }
    const step = this.manualStepSize * direction;
    if (axis === 'X') this.manualToolheadPos.x += step;
    else if (axis === 'Y') this.manualToolheadPos.z -= step; // In Three.js: G-code +Y is -Z
    else if (axis === 'Z') this.manualToolheadPos.y = Math.max(0, this.manualToolheadPos.y + step); // G-code +Z is +Y

    this._updateManualJogUI();
  }

  setManualPos(x, y, z) {
    this.manualJogActive = true;
    if (this.isPlaying) {
      this.isPlaying = false;
      this._updatePlayPauseIcon();
    }
    const world = this.sceneManager.toWorld(x, y, z);
    this.manualToolheadPos.copy(world);
    this._updateManualJogUI();
  }

  toggleManualLaser(pin) {
    if (this.manualActiveLaser === pin) {
      this.manualActiveLaser = null;
    } else {
      this.manualActiveLaser = pin;
      if (!this.manualJogActive) {
        this.manualJogActive = true;
        if (this.isPlaying) {
          this.isPlaying = false;
          this._updatePlayPauseIcon();
        }
        if (this.toolhead && this.toolhead.group) {
          this.manualToolheadPos.copy(this.toolhead.group.position);
        }
      }
    }
    if (this.toolhead) {
      this.toolhead.setActiveLaser(this.manualActiveLaser, this.manualActiveLaser ? this.manualLaserPower : 0);
    }
    this._updateManualJogUI();
  }

  resetManualJog() {
    this.manualJogActive = false;
    this.manualActiveLaser = null;
    if (this.toolhead) {
      this.toolhead.setActiveLaser(null, 0);
    }
    if (this.laserFx) {
      this.laserFx.clear();
    }
    const distEl = document.getElementById('jog-wall-dist');
    if (distEl) distEl.textContent = '-- mm';
    const focusEl = document.getElementById('jog-focus-status');
    if (focusEl) {
      focusEl.textContent = 'Standby';
      focusEl.style.color = 'var(--text-dim)';
    }
    this._updateManualJogUI();
  }

  _updateManualJogUI() {
    const statusBadge = document.getElementById('jog-mode-status');
    if (statusBadge) {
      if (this.manualJogActive) {
        statusBadge.textContent = 'MANUAL JOG';
        statusBadge.classList.add('active-jog');
      } else {
        statusBadge.textContent = 'SIM TRACK';
        statusBadge.classList.remove('active-jog');
      }
    }

    const gcodeCoords = this.sceneManager.fromWorld ? this.sceneManager.fromWorld(this.manualToolheadPos) : {
      x: this.manualToolheadPos.x,
      y: -this.manualToolheadPos.z,
      z: this.manualToolheadPos.y
    };

    const posX = document.getElementById('jog-pos-x');
    const posY = document.getElementById('jog-pos-y');
    const posZ = document.getElementById('jog-pos-z');
    if (posX && document.activeElement !== posX) posX.value = gcodeCoords.x.toFixed(1);
    if (posY && document.activeElement !== posY) posY.value = gcodeCoords.y.toFixed(1);
    if (posZ && document.activeElement !== posZ) posZ.value = gcodeCoords.z.toFixed(1);

    document.querySelectorAll('.jog-laser-btn').forEach(btn => {
      const pin = btn.getAttribute('data-laser');
      if (pin === this.manualActiveLaser) {
        btn.classList.add('active-laser');
      } else {
        btn.classList.remove('active-laser');
      }
    });
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;

      if (e.code === 'Space') {
        e.preventDefault();
        this.isPlaying = !this.isPlaying;
        this._updatePlayPauseIcon();
      } else if (e.code === 'KeyH') {
        e.preventDefault();
        this.toggleCleanUI();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        this.seekToTime(this.currentTime + (e.shiftKey ? 5.0 : 1.0));
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        this.seekToTime(this.currentTime - (e.shiftKey ? 5.0 : 1.0));
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        this.jumpLayer(1);
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        this.jumpLayer(-1);
      } else if (e.code === 'BracketRight') {
        e.preventDefault();
        this.jumpLaserPass(1);
      } else if (e.code === 'BracketLeft') {
        e.preventDefault();
        this.jumpLaserPass(-1);
      } else if (e.code === 'KeyC') {
        e.preventDefault();
        this._cycleCamera();
      }
    });
  }

  toggleCleanUI() {
    const ui = document.getElementById('ui-container');
    const helper = document.getElementById('clean-ui-helper');
    const isHidden = ui.classList.toggle('ui-hidden');
    helper.style.display = isHidden ? 'block' : 'none';
  }

  _cycleCamera() {
    const modes = ['orbit', 'follow', 'macro', 'turntable'];
    const current = this.sceneManager.cameraMode;
    const nextIdx = (modes.indexOf(current) + 1) % modes.length;
    const nextMode = modes[nextIdx];

    const camBtns = document.querySelectorAll('.cam-btn');
    camBtns.forEach(b => {
      if (b.getAttribute('data-cam') === nextMode) b.classList.add('active');
      else b.classList.remove('active');
    });
    this.sceneManager.setCameraMode(nextMode);
  }

  seekToTime(time) {
    if (this.manualJogActive) {
      this.resetManualJog();
    }
    this.currentTime = Math.max(0, Math.min(this.totalTime, time));
    this._updatePlaybackPosition();
    if (this.wallRenderer) {
      this.wallRenderer.syncToTime(this.currentTime, this.currentSegmentIndex);
    }
  }

  stepSegment(direction) {
    if (!this.parsedData || !this.parsedData.segments.length) return;
    const nextIdx = Math.max(0, Math.min(this.parsedData.segments.length - 1, this.currentSegmentIndex + direction));
    const seg = this.parsedData.segments[nextIdx];
    this.seekToTime(seg.startTime);
  }

  jumpLayer(delta) {
    if (!this.parsedData || !this.parsedData.layers.length) return;
    const currentLayerIdx = this.activeLayer;
    const targetLayerIdx = Math.max(0, Math.min(this.parsedData.layers.length - 1, currentLayerIdx + delta));
    const layer = this.parsedData.layers[targetLayerIdx];
    if (layer) {
      const seg = this.parsedData.segments[layer.startSegment];
      if (seg) this.seekToTime(seg.startTime);
    }
  }

  jumpLaserPass(delta) {
    if (!this.parsedData || !this.parsedData.laserPasses.length) return;
    const passes = this.parsedData.laserPasses;

    let targetPass = null;
    if (delta > 0) {
      targetPass = passes.find(p => {
        const seg = this.parsedData.segments[p.startSegment];
        return seg && seg.startTime > this.currentTime + 0.1;
      }) || passes[0];
    } else {
      for (let i = passes.length - 1; i >= 0; i--) {
        const seg = this.parsedData.segments[passes[i].startSegment];
        if (seg && seg.startTime < this.currentTime - 0.5) {
          targetPass = passes[i];
          break;
        }
      }
      if (!targetPass) targetPass = passes[passes.length - 1];
    }

    if (targetPass) {
      const seg = this.parsedData.segments[targetPass.startSegment];
      if (seg) this.seekToTime(seg.startTime);
    }
  }

  _updatePlayPauseIcon() {
    document.getElementById('icon-play').style.display = this.isPlaying ? 'none' : 'block';
    document.getElementById('icon-pause').style.display = this.isPlaying ? 'block' : 'none';
  }

  _getLaserIntersection(emitterWorldPos, beamDirWorld, activePin) {
    if (!emitterWorldPos || !beamDirWorld) return { hitPoint: null, hitNormal: null };

    const Ex = emitterWorldPos.x, Ey = emitterWorldPos.y, Ez = emitterWorldPos.z;
    const Dx = beamDirWorld.x, Dy = beamDirWorld.y, Dz = beamDirWorld.z;

    // 1. Instant Analytical Bed Intersection (Plane Y = 0 in world coords, 0ms cost)
    let bedHit = null;
    let bedT = Infinity;
    if (Dy < -0.0001) {
      bedT = (0 - Ey) / Dy;
      if (bedT > 0) {
        bedHit = {
          hitPoint: new THREE.Vector3(Ex + bedT * Dx, 0, Ez + bedT * Dz),
          hitNormal: new THREE.Vector3(0, 1, 0)
        };
      }
    }

    // 2. Fast Analytical Outer Wall / Top Surface Ray Intersection (0.01ms cost)
    const layers = this.wallRenderer ? this.wallRenderer.microSegmentsByLayer : null;
    if (!layers) return bedHit || { hitPoint: new THREE.Vector3(Ex + Dx * 120, Ey + Dy * 120, Ez + Dz * 120), hitNormal: new THREE.Vector3(0, 1, 0) };

    const maxAllowedLayer = this.manualJogActive
      ? (this.wallRenderer.maxVisibleLayer ?? 9999)
      : Math.min(this.activeLayer ?? 9999, this.wallRenderer.maxVisibleLayer ?? 9999);

    let closestHit = null;
    let closestT = bedT;
    const invDy = 1.0 / (Dy || -0.0001);
    const bedCenterX = this.sceneManager.bedCenterX;
    const bedCenterY = this.sceneManager.bedCenterY;

    if (activePin === 'laser_pwm3') {
      const topSegs = this.wallRenderer.topSurfaceMicroSegments;
      if (topSegs) {
        for (let i = 0; i < topSegs.length; i++) {
          const seg = topSegs[i];
          if (seg.layerIndex > maxAllowedLayer) continue;

          const p0x = seg.startX - bedCenterX, p0z = -(seg.startY - bedCenterY);
          const p1x = seg.endX - bedCenterX, p1z = -(seg.endY - bedCenterY);

          const minX = Math.min(p0x, p1x) - 0.4, maxX = Math.max(p0x, p1x) + 0.4;
          const minZ = Math.min(p0z, p1z) - 0.4, maxZ = Math.max(p0z, p1z) + 0.4;

          if (Ex >= minX && Ex <= maxX && Ez >= minZ && Ez <= maxZ) {
            const hitY = seg.startZ;
            const t = (hitY - Ey) * invDy;
            if (t > 0 && t < closestT) {
              closestT = t;
              closestHit = {
                hitPoint: new THREE.Vector3(Ex, hitY, Ez),
                hitNormal: new THREE.Vector3(0, 1, 0)
              };
              break;
            }
          }
        }
      }
    } else {
      // Laser 1 & 2: Angled ray from side
      for (const layStr in layers) {
        const layIdx = parseInt(layStr, 10);
        if (layIdx > maxAllowedLayer) continue;

        const segs = layers[layStr];
        if (!segs || segs.length === 0) continue;

        const layWorldY = segs[0].startZ;
        const tLayer = (layWorldY - Ey) * invDy;
        if (tLayer <= 0 || tLayer >= closestT) continue;

        const rayX = Ex + tLayer * Dx;
        const rayZ = Ez + tLayer * Dz;

        for (let s = 0; s < segs.length; s++) {
          const seg = segs[s];
          const p0x = seg.startX - bedCenterX, p0z = -(seg.startY - bedCenterY);
          const p1x = seg.endX - bedCenterX, p1z = -(seg.endY - bedCenterY);

          const dx = p1x - p0x, dz = p1z - p0z;
          const lenSq = dx * dx + dz * dz;
          if (lenSq < 0.0001) continue;

          const u = Math.max(0, Math.min(1, ((rayX - p0x) * dx + (rayZ - p0z) * dz) / lenSq));
          const cx = p0x + u * dx;
          const cz = p0z + u * dz;

          const dSq = (rayX - cx) * (rayX - cx) + (rayZ - cz) * (rayZ - cz);
          if (dSq <= 0.36) { // within 0.60mm bead radius
            const len = Math.sqrt(lenSq);
            let nx = -dz / len;
            let nz = dx / len;
            if (nx * Dx + nz * Dz > 0) {
              nx = -nx;
              nz = -nz;
            }
            closestT = tLayer;
            closestHit = {
              hitPoint: new THREE.Vector3(cx + nx * 0.21, layWorldY, cz + nz * 0.21),
              hitNormal: new THREE.Vector3(nx, 0, nz)
            };
            break;
          }
        }
      }
    }

    return closestHit || bedHit || {
      hitPoint: new THREE.Vector3(Ex + Dx * 120, Ey + Dy * 120, Ez + Dz * 120),
      hitNormal: new THREE.Vector3(0, 1, 0)
    };
  }

  _animate(now) {
    requestAnimationFrame(this._animate.bind(this));

    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000.0);
    this.lastFrameTime = now;

    const prevSegmentIndex = this.currentSegmentIndex;

    if (this.isPlaying && this.totalTime > 0) {
      this.currentTime += dt * this.playbackSpeed;
      if (this.currentTime >= this.totalTime) {
        this.currentTime = this.totalTime;
        this.isPlaying = false;
        this._updatePlayPauseIcon();
      }
      this._updatePlaybackPosition();
    }

    if (this.wallRenderer) {
      this.wallRenderer.setTime(this.currentTime);
    }

    let toolheadWorldPos = null;
    let laserHitWorldPos = null;
    let activeLaserHitNormal = null;
    let activePin = null;

    if (this.manualJogActive) {
      // =========================================================================
      // MANUAL JOG & LASER CALIBRATION MODE
      // =========================================================================
      toolheadWorldPos = this.manualToolheadPos;
      this.toolhead.setPosition(toolheadWorldPos);

      activePin = this.manualActiveLaser;
      const power = activePin ? this.manualLaserPower : 0.0;
      this.toolhead.setActiveLaser(activePin, power);

      if (activePin && power > 0.001) {
        const emitterWorldPos = this.toolhead.getEmitterWorldPosition(activePin);
        const beamDirWorld = this.toolhead.getBeamDirectionWorld(activePin);

        const { hitPoint, hitNormal } = this._getLaserIntersection(emitterWorldPos, beamDirWorld, activePin);
        laserHitWorldPos = hitPoint;
        activeLaserHitNormal = hitNormal;

        // Update Glowing Laser Beam & Contact Spot (Dynamic length Emitter -> Part / Bed)
        this.laserFx.update(emitterWorldPos, hitPoint, power, activePin, hitNormal);

        // Live Optical Measurement Readout
        const distMm = emitterWorldPos.distanceTo(hitPoint);
        const distEl = document.getElementById('jog-wall-dist');
        if (distEl) distEl.textContent = `${distMm.toFixed(1)} mm`;

        const focusEl = document.getElementById('jog-focus-status');
        if (focusEl) {
          const defocus = distMm - this.laserFx.focalDistance;
          if (Math.abs(defocus) <= 0.8) {
            focusEl.textContent = `Sharp (${distMm.toFixed(1)}mm)`;
            focusEl.style.color = 'var(--laser-cyan)';
          } else if (defocus < 0) {
            focusEl.textContent = `Defocus (${defocus.toFixed(1)}mm close)`;
            focusEl.style.color = '#f59e0b';
          } else {
            focusEl.textContent = `Defocus (+${defocus.toFixed(1)}mm far)`;
            focusEl.style.color = '#ef4444';
          }
        }
      } else {
        this.laserFx.update(null, null, 0.0, null, null);
        const distEl = document.getElementById('jog-wall-dist');
        if (distEl) distEl.textContent = '-- mm';
        const focusEl = document.getElementById('jog-focus-status');
        if (focusEl) {
          focusEl.textContent = 'Standby';
          focusEl.style.color = 'var(--text-dim)';
        }
      }

      this.sceneManager.updateCamera(toolheadWorldPos, laserHitWorldPos, activePin, dt);
    } else if (this.parsedData && this.parsedData.segments.length > 0) {
      const seg = this.parsedData.segments[this.currentSegmentIndex];
      if (seg) {
        // Interpolate position along current segment
        const segProgress = seg.duration > 0.0001 ? Math.max(0, Math.min(1, (this.currentTime - seg.startTime) / seg.duration)) : 1.0;
        const curX = seg.startX + (seg.endX - seg.startX) * segProgress;
        const curY = seg.startY + (seg.endY - seg.startY) * segProgress;
        const curZ = seg.startZ + (seg.endZ - seg.startZ) * segProgress;

        toolheadWorldPos = this.sceneManager.toWorld(curX, curY, curZ);
        this.toolhead.setPosition(toolheadWorldPos);

        // Strict Laser Activation: ONLY when activeLaser is set AND laserPower > 0 AND NOT a travel move
        const isLaserActive = (seg.isLaserPass && !seg.isTravel && seg.activeLaser && seg.laserPower > 0.001);
        activePin = isLaserActive ? seg.activeLaser : null;
        const power = isLaserActive ? seg.laserPower : 0.0;

        // Toolhead lights up ONLY the active laser aperture
        this.toolhead.setActiveLaser(activePin, power);

        if (isLaserActive && activePin && power > 0.001) {
          const emitterWorldPos = this.toolhead.getEmitterWorldPosition(activePin);
          const beamDirWorld = this.toolhead.getBeamDirectionWorld(activePin);

          // Dynamic Raycast: compute exact intersection with printed part or print bed
          const { hitPoint, hitNormal } = this._getLaserIntersection(emitterWorldPos, beamDirWorld, activePin);
          laserHitWorldPos = hitPoint;
          activeLaserHitNormal = hitNormal;

          // Update Glowing Laser Beam & Contact Spot (Dynamic length Emitter -> Part / Bed)
          this.laserFx.update(emitterWorldPos, laserHitWorldPos, power, activePin, hitNormal);
        } else {
          // Laser is OFF
          this.laserFx.update(null, null, 0.0, null, null);
        }

        // Camera Laser Target & Pin: Active laser melt zone when firing; nozzle when printing
        let cameraLaserTarget = isLaserActive ? laserHitWorldPos : null;
        let cameraLaserPin = isLaserActive ? activePin : null;

        // Update Wall Renderer geometry draw ranges via binary search (0ms CPU cost)
        this.wallRenderer.updatePlayback(this.currentSegmentIndex, this.activeLayer, dt);

        // Update Telemetry HUD
        this._updateHUD(seg, curX, curY, curZ, isLaserActive, activePin, power);

        // Update Camera (Lerp follow / macro / turntable)
        this.sceneManager.updateCamera(toolheadWorldPos, cameraLaserTarget, cameraLaserPin, dt);
      }
    }

    // Render 3D Scene
    this.sceneManager.render();
  }

  _updatePlaybackPosition() {
    if (!this.parsedData || !this.parsedData.segments.length) return;

    // Binary search to find segment for currentTime
    const segs = this.parsedData.segments;
    let low = 0, high = segs.length - 1;
    let foundIdx = 0;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (segs[mid].startTime <= this.currentTime) {
        foundIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    this.currentSegmentIndex = foundIdx;
    const seg = segs[foundIdx];
    this.activeLayer = seg.layerIndex;

    // Update Timeline Slider
    if (!this.isScrubbing) {
      const slider = document.getElementById('timeline-slider');
      const pct = this.totalTime > 0 ? (this.currentTime / this.totalTime) * 1000 : 0;
      slider.value = pct;
    }

    // Update Time Label
    document.getElementById('time-current').textContent = this._formatTime(this.currentTime);
  }

  _updateHUD(seg, x, y, z, isLaserActive, activePin, power) {
    document.getElementById('tele-x').innerHTML = `${x.toFixed(2)} <small>mm</small>`;
    document.getElementById('tele-y').innerHTML = `${y.toFixed(2)} <small>mm</small>`;
    document.getElementById('tele-z').innerHTML = `${z.toFixed(2)} <small>mm</small>`;
    document.getElementById('tele-f').innerHTML = `${seg.speed.toFixed(0)} <small>mm/s</small>`;

    const totalLayers = this.parsedData ? Math.max(1, this.parsedData.layers.length - 1) : 34;
    document.getElementById('tele-layer').textContent = `${seg.layerIndex} / ${totalLayers}`;
    document.getElementById('tele-layer-z').innerHTML = `${z.toFixed(2)} <small>mm</small>`;

    // Feature label
    let featText = seg.feature;
    if (isLaserActive) {
      if (activePin === 'laser_pwm3') {
        featText = `Top Surface Smooth Pass [Perpendicular]`;
      } else {
        featText = `Wall Smooth Pass [Wobble]`;
      }
    } else if (seg.isTravel) {
      featText = `Rapid Travel (G0)`;
    }
    document.getElementById('tele-feature').textContent = featText;

    // Laser HUD Widget
    const laserCard = document.getElementById('laser-hud-card');
    const laserName = document.getElementById('hud-laser-name');
    const laserTarget = document.getElementById('hud-laser-target');
    const laserPower = document.getElementById('hud-laser-power');
    const powerBar = document.getElementById('hud-power-bar');

    if (isLaserActive && power > 0.001) {
      laserCard.classList.add('firing');
      const pinLabel = (activePin === 'laser_pwm1') ? 'LASER 1 (RIGHT X+)' : ((activePin === 'laser_pwm2') ? 'LASER 2 (LEFT X-)' : 'LASER 3 (CENTER VERTICAL)');
      laserName.textContent = pinLabel;
      const targetLabel = (activePin === 'laser_pwm3') ? `Glazing Top Surface • ${(power * 100).toFixed(0)}% Power` : `Remelting Outer Wall • ${(power * 100).toFixed(0)}% Power`;
      laserTarget.textContent = targetLabel;
      laserPower.textContent = `${(power * 100).toFixed(0)}%`;
      powerBar.style.width = `${power * 100}%`;
      document.getElementById('tele-wall-state').textContent = 'Glazed Smooth';
      document.getElementById('tele-wall-state').style.color = '#00f0ff';
    } else {
      laserCard.classList.remove('firing');
      laserName.textContent = 'LASERS STANDBY (OFF)';
      laserTarget.textContent = seg.isTravel ? 'Rapid Travel Move • Beams Off' : 'Extruding Layer Line • Beams Off';
      laserPower.textContent = '0%';
      powerBar.style.width = '0%';
      document.getElementById('tele-wall-state').textContent = 'Rough Layer Lines';
      document.getElementById('tele-wall-state').style.color = '#f59e0b';
    }

    const smoothCount = this.parsedData ? this.parsedData.laserPasses.length : 0;
    document.getElementById('tele-smooth-count').textContent = smoothCount;
  }

  _bindHeatmapUI() {
    const toggleHeatmap = document.getElementById('toggle-energy-heatmap');
    const btnRecalc = document.getElementById('btn-recalc-heatmap');
    const accelInput = document.getElementById('heatmap-accel');
    const waistInput = document.getElementById('heatmap-waist');
    const powerInput = document.getElementById('heatmap-power-watts');

    if (toggleHeatmap) {
      toggleHeatmap.addEventListener('change', (e) => {
        this.heatmapActive = e.target.checked;
        const legend = document.getElementById('heatmap-legend');

        if (this.heatmapActive) {
          if (!this.heatmapData) {
            this.calculateHeatmap();
          } else {
            this.wallRenderer.setHeatmapColors(this.heatmapData.outerColors, this.heatmapData.topColors);
            this._updateHeatmapLegend(this.heatmapData);
          }
          if (legend) legend.style.display = 'flex';
        } else {
          this.wallRenderer.restoreOriginalColors();
          if (legend) legend.style.display = 'none';
        }
      });
    }

    if (btnRecalc) {
      btnRecalc.addEventListener('click', () => {
        this.calculateHeatmap();
      });
    }

    [accelInput, waistInput, powerInput].forEach(inp => {
      if (inp) {
        inp.addEventListener('change', () => {
          if (this.heatmapActive) {
            this.calculateHeatmap();
          }
        });
      }
    });
  }

  calculateHeatmap() {
    if (!this.parsedData || !this.wallRenderer) return;

    const accelInput = document.getElementById('heatmap-accel');
    const waistInput = document.getElementById('heatmap-waist');
    const powerInput = document.getElementById('heatmap-power-watts');

    this.heatmapAcceleration = accelInput ? (parseFloat(accelInput.value) || 5000.0) : 5000.0;
    this.heatmapBeamWaist = waistInput ? (parseFloat(waistInput.value) || 0.35) : 0.35;
    this.heatmapLaserPowerWatts = powerInput ? (parseFloat(powerInput.value) || 10.0) : 10.0;

    if (typeof LaserHeatmap !== 'undefined') {
      this.heatmapData = LaserHeatmap.computeEnergyMap({
        segments: this.parsedData.segments,
        outerWallMicroSegments: this.wallRenderer.outerWallMicroSegments,
        topSurfaceMicroSegments: this.wallRenderer.topSurfaceMicroSegments,
        sceneManager: this.sceneManager,
        toolhead: this.toolhead,
        acceleration: this.heatmapAcceleration,
        beamWaist: this.heatmapBeamWaist,
        laserRatedPowerWatts: this.heatmapLaserPowerWatts
      });

      if (this.heatmapData) {
        this._updateHeatmapLegend(this.heatmapData);
        if (this.heatmapActive) {
          this.wallRenderer.setHeatmapColors(this.heatmapData.outerColors, this.heatmapData.topColors);
          const legend = document.getElementById('heatmap-legend');
          if (legend) legend.style.display = 'flex';
        }
      }
    }
  }

  _updateHeatmapLegend(data) {
    if (!data) return;

    const lblMid = document.getElementById('heatmap-label-mid');
    const lblMax = document.getElementById('heatmap-label-max');
    const statPeak = document.getElementById('heatmap-stat-peak');
    const statAvg = document.getElementById('heatmap-stat-avg');
    const statJoules = document.getElementById('heatmap-stat-joules');

    const maxD = data.maxDose || 0;
    const avgD = data.avgDose || 0;
    const midD = maxD * 0.5;
    const totalJ = data.totalJoules || 0;

    if (lblMid) lblMid.textContent = `${midD.toFixed(1)} J/mm²`;
    if (lblMax) lblMax.textContent = `${maxD.toFixed(1)} J/mm² (Peak)`;
    if (statPeak) statPeak.textContent = `${maxD.toFixed(1)} J/mm²`;
    if (statAvg) statAvg.textContent = `${avgD.toFixed(1)} J/mm²`;
    if (statJoules) statJoules.textContent = `${totalJ.toFixed(0)} J Delivered`;
  }

  _formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}

window.App = App;

// Instantiate on window load
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
