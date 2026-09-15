# Laser 3D Printer - Technical Documentation

This document provides a comprehensive technical overview of the Laser 3D Printer software stack. It details how the different software components interact, the architecture of the post-processing pipeline, and in-depth descriptions of the functions within each Python script.

---

## 1. System Architecture Overview

The software stack integrates laser processing directly into a standard FDM 3D printing workflow. It intercepts the sliced G-code before it reaches the printer, analyzes the geometric paths (e.g., top surfaces, outer walls), and dynamically injects precise laser control commands. 

The architecture consists of four primary components:
1. **Web Generator UI (`web_generator/index.html`)**: A frontend application that acts as the control panel. Users define their parameters visually, and the UI generates a long, complex command-line string.
2. **OrcaSlicer Post-Processing**: The generated command-line string is pasted into OrcaSlicer's post-processing settings. When a model is sliced, OrcaSlicer automatically runs the Python scripts on the output `.gcode` file.
3. **Python Processing Scripts**: The scripts parse the G-code line-by-line, calculate vectors, cluster geometric shapes, and generate new G-code commands (e.g., `SET_PIN PIN=laser_pwm VALUE=...`) based on the requested features (annealing, smoothing, etc.).
4. **Klipper Firmware (`printer.cfg`)**: The printer's firmware receives the modified G-code. Custom macros and `[output_pin]` configurations execute the laser commands synchronously with the toolhead movements.

---

> ⚠️ **DEVELOPMENT STATUS**: Standard horizontal wall smoothing is the stable production method. All advanced multi-layer wall modes (Deep, Wobble, Voxel Wobble, Voxel Raycast) are in **ALPHA** and must be visually verified before printing on physical hardware.

## 2. Core Post-Processing Script
### `orcaslicer_laser_advanced.py`

This is the primary script responsible for analyzing the G-code and injecting laser commands for preheating, annealing, smoothing, wall remelting. It heavily utilizes 2D vector mathematics and spatial clustering.

#### Geometric & Mathematical Helpers
- **`get_val(line, char)`**: Parses a G-code line (e.g., `G1 X100 Y50 E2 F3000`) and extracts the numeric value following a specific character (e.g., `X`). Returns `None` if missing.
- **`compute_rotated_bbox(points, angle_deg=0.0, margin=0.0)`**: Calculates a rotated bounding box for a set of 2D points to align laser raster paths accurately across irregularly shaped surfaces.
- **`is_touching(ptsA, ptsB, max_dist=3.0)`**: Determines if two sets of points are close enough to be considered a single contiguous shape.
- **`downsample_points(points, resolution=0.5)`**: Reduces the number of points in a path to optimize computation speed.
- **`cluster_points(points, max_dist=2.5)`**: Groups a large set of points into individual, spatially isolated clusters (representing distinct islands or parts on the build plate).
- **`bbox_area(bbox)`**: Calculates the area in mm² of a bounding box.
- **`calculate_boosted_power(base_power, area)`**: Dynamically increases laser power for larger surface areas where heat dissipates more rapidly.

#### Raster & Grid Generation
- **`build_boolean_grid(points, res, max_dist)`**: Creates a 2D boolean occupation grid representing solid areas vs. empty space, used to ensure the laser only fires over the actual printed part and not thin air.
- **`generate_laser_grid(...)`**: The core rasterization engine. It takes a bounding box, an angle, and physical parameters to generate a dense zig-zag pattern of G-code moves across a surface. It handles clipping against the boolean grid, alternating directions, and inserting precise `SET_PIN` commands.
- **`generate_laser_connectivity(...)`**: Similar to the laser grid, but optimized for generating distinct conductive or structural traces.

#### Wall & Path Smoothing
- **`is_point_in_path(pt_x, pt_y, path)`**: Uses ray-casting to determine if a specific point lies inside a closed polygon (used for inner/outer wall sorting).
- **`build_paths_from_segments(segments)`**: Takes chaotic, disconnected line segments and stitches them into continuous, ordered polygons.
- **`split_corners_in_paths(paths, corner_dist, power_scaler, ...)`**: Analyzes paths for sharp corners/angles and dynamically reduces laser power at the apex to prevent overheating and melting the corner away.
- **`generate_wall_smooth_passes(...)`**: Processes outer wall polygons. It calculates perpendicular offsets to position the side-mounted lasers exactly at the focal distance, and handles Z-axis interlacing, multi-height divisions, and temperature drops.
- **`generate_voxel_wobble_passes(...)` & `generate_voxel_raycast_wall_passes(...)`**: Modern slope-adaptive 3D wall smoothing engines. They compute perpendicular offsets, analyze layer-to-layer slope vectors, and apply dynamic apex displacement to follow outer perimeters smoothly.
- **`check_3d_sloped_occlusion(...)`**: Raycasting function that uses the physical diode laser elevation angle (e.g. 22°) to verify line-of-sight and prevent firing through intervening geometry.
- **`generate_wobble_passes(...)`**: Generates high-frequency sinusoidal oscillations along the wall path to broaden the laser melt pool without excessive heat concentration.

#### Parsing & Extraction
- **`will_laser_resume_shortly(...)`**: A look-ahead function that checks upcoming G-code lines to see if the laser will be needed again immediately, preventing unnecessary on/off cycling.
- **`extract_outer_walls(lines)`** & **`extract_top_surfaces(lines)`**: Specialized parsers that scan the raw OrcaSlicer output and extract the exact X/Y coordinates of walls and top layers based on slicing comments.
- **`process_gcode(file_path, args)`**: The main execution loop. It reads the file, tracks the current state (X, Y, Z, E, Feedrate), maintains the active laser configuration, delegates generation to the functions above, and writes the final modified file back to disk.

---

## 3. Mechanical & Infill Manipulation

### `orcaslicer_bricklayer_infill.py`
This script alters internal infill geometry to create staggered, interlocking "brick" patterns that improve structural integrity.
- **`get_val(line, key)`**: G-code parsing helper.
- **`strip_z(line)`**: Removes Z-axis moves from a line to normalize 2D logic.
- **`process_gcode(...)`**: Scans for infill lines and injects retractions and Z-hops to break continuous extrusions into distinct structural "bricks".

### `orcaslicer_vibrate_infill.py`
This script introduces vertical Z-axis oscillations during infill printing to create a 3D corrugated internal structure for enhanced Z-axis strength.
- **`smooth_envelope(d, fade, L)`**: Calculates a mathematical fade-in/fade-out envelope so that the vibrations taper off smoothly near the walls, preventing nozzle collisions with solid perimeters.
- **`process_gcode(...)`**: The main execution loop. It breaks long, flat infill lines into hundreds of microscopic segments, modulating the Z-height of each segment based on a sine wave function `sin(distance / wavelength) * amplitude * envelope`.

---

## 4. Web Ecosystem

### Unified Web Suite (`index.html`)
The release features a unified, responsive Web Suite that runs entirely offline with zero server requirements. A master Hub connects four specialized subpages with persistent cross-navigation:
1. **Configurator & Calibration (`web_tools/configurator/`)**: Generates OrcaSlicer CLI strings, includes JSON preset export/import, Virtual PCB parameters, experimental slicing paths, and Matrix calibration.
2. **G-Code Visualizer (`web_tools/gcode_visualizer/`)**: Fast 2D/3D toolpath inspector with support for hardware Calibration Levels (0 to 4), power heatmaps, and chunk analysis.
3. **3D Toolhead Simulator (`web_tools/simulator_3d/`)**: Photorealistic WebGL simulation featuring the authentic 3D CAD toolhead assembly, cooling fans, golden nozzle, and macro melt-zone camera.
4. **Offset Calibration (`web_tools/calibration/`)**: Step-by-step 10mm cube paper calibration to align angled laser diodes and generate Klipper test macros.
The frontend is built using standard HTML/CSS/JS. It relies on a JavaScript function `generateCommand()` that triggers on any input change. This function dynamically reads all DOM elements, checks for active toggles, and concatenates a formatted string of Python CLI arguments. The UI leverages `localStorage` to save settings between sessions, and implements `JSON.parse`/`JSON.stringify` to export/import complete material preset profiles to the local disk.

### 3D Visualizer (`web_tools/gcode_visualizer/index.html`)
The visualizer uses **Three.js** to render G-code paths in a web browser. It parses standard `G1` moves into lines. More importantly, it specifically searches for the injected `SET_PIN PIN=laser_pwm...` commands generated by the Python scripts. When it detects a laser activation, it changes the color and thickness of the rendered path, interpolating colors from blue (low power) to red (high power), allowing users to visually verify the laser paths and calibration sweeps before running the print.
