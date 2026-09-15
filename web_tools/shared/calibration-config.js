/**
 * Laser 3D Suite — Shared Calibration Configuration Manager
 * Provides unified, persistent machine-specific laser diode offset calibration.
 * 
 * Safety Rule: NO default offsets are shipped. System starts in an uncalibrated state.
 * Fixed Z Heights: 2.0mm, 5.0mm, 10.0mm, 15.0mm, 20.0mm.
 * User only calibrates X offsets (X1 for Laser 1 / X+, X2 for Laser 2 / X-).
 */

(function (window) {
    'use strict';

    const STORAGE_KEY = 'laser3d_calibration_v1';
    const CUSTOM_STORAGE_KEY = 'laser3d_custom_level_v1';

    // 5 Fixed Z Heights (Stand-off above target layer)
    const FIXED_Z_LEVELS = [2.0, 5.0, 10.0, 15.0, 20.0];

    function createUncalibratedTemplate() {
        return FIXED_Z_LEVELS.map((z, idx) => ({
            level: idx,
            z: z,
            x1: null,
            x2: null
        }));
    }

    function createUncalibratedCustom() {
        return {
            z: 10.0,
            x1: null,
            x2: null
        };
    }

    const LaserCalibration = {
        FIXED_Z_LEVELS: FIXED_Z_LEVELS,

        /**
         * Retrieve current calibration levels.
         * Returns array of 5 levels: [{ level: 0..4, z: float, x1: float|null, x2: float|null }]
         */
        getLevels: function () {
            try {
                const stored = localStorage.getItem(STORAGE_KEY);
                if (!stored) return createUncalibratedTemplate();
                const parsed = JSON.parse(stored);
                if (!Array.isArray(parsed) || parsed.length !== FIXED_Z_LEVELS.length) {
                    return createUncalibratedTemplate();
                }
                return parsed.map((item, idx) => ({
                    level: idx,
                    z: FIXED_Z_LEVELS[idx], // Z is always strictly fixed
                    x1: (item && typeof item.x1 === 'number' && !isNaN(item.x1)) ? item.x1 : null,
                    x2: (item && typeof item.x2 === 'number' && !isNaN(item.x2)) ? item.x2 : null
                }));
            } catch (e) {
                console.warn('Failed to load laser calibration from localStorage:', e);
                return createUncalibratedTemplate();
            }
        },

        /**
         * Retrieve custom laser offset level with configurable positive Z.
         */
        getCustomLevel: function () {
            try {
                const stored = localStorage.getItem(CUSTOM_STORAGE_KEY);
                if (!stored) return createUncalibratedCustom();
                const parsed = JSON.parse(stored);
                const z = (parsed && typeof parsed.z === 'number' && parsed.z > 0) ? parsed.z : 10.0;
                return {
                    z: z,
                    x1: (parsed && typeof parsed.x1 === 'number' && !isNaN(parsed.x1)) ? parsed.x1 : null,
                    x2: (parsed && typeof parsed.x2 === 'number' && !isNaN(parsed.x2)) ? parsed.x2 : null
                };
            } catch (e) {
                return createUncalibratedCustom();
            }
        },

        /**
         * Save custom level offsets. Z MUST be strictly positive (Z > 0).
         */
        saveCustomLevel: function (z, x1, x2) {
            const numZ = parseFloat(z);
            if (isNaN(numZ) || numZ <= 0) {
                throw new Error('Laser Z standoff offset must be strictly positive (Z > 0 mm). Received: ' + z);
            }
            const numX1 = (x1 !== null && x1 !== undefined && x1 !== '') ? parseFloat(x1) : null;
            const numX2 = (x2 !== null && x2 !== undefined && x2 !== '') ? parseFloat(x2) : null;
            const customData = {
                z: Math.round(numZ * 100) / 100,
                x1: (numX1 !== null && !isNaN(numX1)) ? Math.round(numX1 * 100) / 100 : null,
                x2: (numX2 !== null && !isNaN(numX2)) ? Math.round(numX2 * 100) / 100 : null
            };
            localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(customData));
            try {
                window.dispatchEvent(new CustomEvent('laser-calibration-updated', { detail: { custom: customData } }));
            } catch (e) {}
            return customData;
        },

        /**
         * Check if custom level is fully calibrated.
         */
        isCustomCalibrated: function () {
            const c = this.getCustomLevel();
            return typeof c.z === 'number' && c.z > 0 &&
                   typeof c.x1 === 'number' && !isNaN(c.x1) && c.x1 !== null &&
                   typeof c.x2 === 'number' && !isNaN(c.x2) && c.x2 !== null;
        },

        /**
         * Check if all 5 fixed Z heights have valid calibrated X1 and X2 offsets.
         */
        isCalibrated: function () {
            const levels = this.getLevels();
            for (let i = 0; i < levels.length; i++) {
                if (typeof levels[i].x1 !== 'number' || typeof levels[i].x2 !== 'number' ||
                    isNaN(levels[i].x1) || isNaN(levels[i].x2) ||
                    levels[i].x1 === null || levels[i].x2 === null) {
                    return false;
                }
            }
            return true;
        },

        /**
         * Check if a specific level index (0..4) is calibrated.
         */
        isLevelCalibrated: function (idx) {
            const levels = this.getLevels();
            const l = levels[idx];
            if (!l) return false;
            return typeof l.x1 === 'number' && typeof l.x2 === 'number' && !isNaN(l.x1) && !isNaN(l.x2);
        },

        /**
         * Get calibration for a specific level index.
         */
        getLevel: function (idx) {
            const levels = this.getLevels();
            return levels[idx] || null;
        },

        /**
         * Save calibration levels to localStorage and broadcast update.
         */
        saveLevels: function (levels) {
            if (!Array.isArray(levels) || levels.length !== FIXED_Z_LEVELS.length) {
                throw new Error('Calibration must contain exactly ' + FIXED_Z_LEVELS.length + ' levels.');
            }

            const cleanLevels = levels.map((item, idx) => {
                const x1 = (item && item.x1 !== null && item.x1 !== undefined && item.x1 !== '') ? parseFloat(item.x1) : null;
                const x2 = (item && item.x2 !== null && item.x2 !== undefined && item.x2 !== '') ? parseFloat(item.x2) : null;
                return {
                    level: idx,
                    z: FIXED_Z_LEVELS[idx],
                    x1: (x1 !== null && !isNaN(x1)) ? Math.round(x1 * 100) / 100 : null,
                    x2: (x2 !== null && !isNaN(x2)) ? Math.round(x2 * 100) / 100 : null
                };
            });

            localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanLevels));

            // Notify all listening components/tabs
            try {
                window.dispatchEvent(new CustomEvent('laser-calibration-updated', { detail: cleanLevels }));
            } catch (e) {}

            return cleanLevels;
        },

        /**
         * Clear calibration back to uncalibrated state.
         */
        clearCalibration: function () {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(CUSTOM_STORAGE_KEY);
            const template = createUncalibratedTemplate();
            try {
                window.dispatchEvent(new CustomEvent('laser-calibration-updated', { detail: template }));
            } catch (e) {}
            return template;
        },

        /**
         * Export current calibration as a downloadable laser_offsets.json file.
         */
        exportJSON: function () {
            const levels = this.getLevels();
            const payload = {
                format: 'laser3d_calibration',
                version: '1.1',
                created_at: new Date().toISOString(),
                is_calibrated: this.isCalibrated(),
                calibration_standard: '10mm_cube_paper_method',
                fixed_z_heights: FIXED_Z_LEVELS,
                levels: levels,
                custom_level: this.getCustomLevel()
            };

            const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
            const downloadAnchor = document.createElement('a');
            downloadAnchor.setAttribute('href', dataStr);
            downloadAnchor.setAttribute('download', 'laser_offsets.json');
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();
        },

        /**
         * Import calibration from JSON string or parsed object.
         */
        importJSON: function (jsonContent) {
            let data;
            if (typeof jsonContent === 'string') {
                data = JSON.parse(jsonContent);
            } else {
                data = jsonContent;
            }

            if (!data) throw new Error('Invalid JSON content.');

            let rawLevels = data.levels || (Array.isArray(data) ? data : null);
            if (!Array.isArray(rawLevels) || rawLevels.length !== FIXED_Z_LEVELS.length) {
                throw new Error('Import file must contain an array of ' + FIXED_Z_LEVELS.length + ' calibration levels.');
            }

            if (data.custom_level && typeof data.custom_level === 'object') {
                const cz = parseFloat(data.custom_level.z);
                if (!isNaN(cz) && cz > 0) {
                    this.saveCustomLevel(cz, data.custom_level.x1, data.custom_level.x2);
                }
            }

            return this.saveLevels(rawLevels);
        },

        /**
         * Interpolate offset for any continuous Z height (mm) for pin 1 (X+) or pin 2 (X-).
         */
        interpolateOffset: function (beamHeight, pin) {
            const levels = this.getLevels();
            const key = (pin === 1) ? 'x1' : 'x2';

            if (levels[0][key] === null) return 0;

            if (beamHeight <= levels[0].z) {
                return levels[0][key] || 0;
            }
            const last = levels[levels.length - 1];
            if (beamHeight >= last.z) {
                return last[key] || 0;
            }

            for (let i = 0; i < levels.length - 1; i++) {
                const z0 = levels[i].z;
                const z1 = levels[i + 1].z;
                if (z0 <= beamHeight && beamHeight <= z1) {
                    const v0 = levels[i][key];
                    const v1 = levels[i + 1][key];
                    if (v0 === null || v1 === null) return v0 || v1 || 0;
                    const t = (beamHeight - z0) / (z1 - z0);
                    return v0 + t * (v1 - v0);
                }
            }
            return levels[0][key] || 0;
        }
    };

    window.LaserCalibration = LaserCalibration;

})(typeof window !== 'undefined' ? window : this);
