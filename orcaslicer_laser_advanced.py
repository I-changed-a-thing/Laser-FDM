import sys
import re
import os
import math

# =====================================================================
# ADVANCED LASER-ASSISTED FDM POST-PROCESSING SCRIPT
# =====================================================================
# Features:
#   1. PREHEATING   — Dynamic power scaling for inter-layer adhesion
#   2. ANNEALING    — Per-layer reheating pass for controlled crystallinity
#   3. SMOOTHING    — Laser grid pass over top surfaces for surface glazing
#   4. WALL SMOOTH  — Offset laser pass to remelt side walls
#
# Usage (OrcaSlicer post-process command):
#   python orcaslicer_laser_advanced.py [options] <gcode_file>
#
# Each feature can be independently enabled/disabled via config or CLI.
# =====================================================================


# ═════════════════════════════════════════════════════════════════════
#  1. PREHEATING CONFIGURATION
#     Fires the laser ahead of the nozzle during extrusion moves to
#     preheat the previous layer. Power scales with feedrate.
# ═════════════════════════════════════════════════════════════════════
PREHEAT_ENABLED  = False
PREHEAT_POWER    = 0.40    # PWM at REF_SPEED (0.0–1.0)
REF_SPEED        = 50.0    # Speed (mm/s) at which PREHEAT_POWER is calibrated
MIN_LASER_POWER  = 0.065    # Hardware floor: laser won't fire below this PWM
MIN_LAYER        = 3       # First layer to activate any laser feature (0-indexed)
TRAILING_ENABLED = False   # Enable trailing laser post-heating
TRAILING_RATIO   = 0.50    # Ratio of main power for the trailing laser to post-heat the line

# Feature types to preheat (OrcaSlicer names)
PREHEAT_TYPES = [
    "Solid infill",
    "Internal solid infill",
    "Outer wall",
    "Inner wall",
    "Top surface",
]


# ═════════════════════════════════════════════════════════════════════
#  2. ANNEALING CONFIGURATION
#     After each layer is fully printed, the nozzle retraces a
#     serpentine grid over the layer's bounding box at low power.
#     This briefly reheats the plastic to the crystallization window
#     (e.g. 100–120 °C for PLA) to promote controlled crystallinity.
# ═════════════════════════════════════════════════════════════════════
ANNEAL_ENABLED   = False   # Disabled by default — experimental!
ANNEAL_POWER     = 0.08    # Low PWM for gentle reheating
ANNEAL_SPEED     = 30.0    # mm/s — slow for even heat distribution
ANNEAL_SPACING   = 1.0     # mm between raster lines
ANNEAL_Z_HOP     = 0.15    # mm hop to prevent nozzle scraping
ANNEAL_OVERSHOOT = 0.5     # mm to extend passes for acceleration smoothing
ANNEAL_OVERSHOOT_WITHOUT_LASER = False
ANNEAL_MIN_LAYER = 5       # Skip early layers (bed proximity keeps them warm)
ANNEAL_MARGIN    = 0.0     # mm inward shrink from layer bounding box (default 0.0 for full coverage)
ANNEAL_MIN_AREA  = 5.0     # mm² — don't anneal tiny features (default 5.0 to catch small parts)
ANNEAL_ANGLE     = 0.0     # Degrees — angle of the annealing grid


# ═════════════════════════════════════════════════════════════════════
#  3. TOP SURFACE SMOOTHING CONFIGURATION
#     After top surface features finish on a layer, the nozzle
#     retracts, hops slightly, and traces a fine laser grid over
#     the top surface area. The shallow 22° laser angle creates a
#     wide elliptical spot that gently reflows the surface to a
#     smooth, glossy finish.
# ═════════════════════════════════════════════════════════════════════
SMOOTH_ENABLED   = False
SMOOTH_POWER     = 0.15    # PWM — moderate power for surface glazing
SMOOTH_SPEED     = 20.0    # mm/s — slow for even melting
SMOOTH_SPACING   = 0.2     # mm between grid lines (finer = smoother)
SMOOTH_Z_HOP     = 0.50    # mm hop above print surface during smoothing
SMOOTH_OVERSHOOT = 0.5     # mm to extend passes for acceleration smoothing
SMOOTH_OVERSHOOT_WITHOUT_LASER = False
SMOOTH_MARGIN    = 0.0     # mm inward shrink from top-surface bounding box
SMOOTH_MIN_AREA  = 1.0     # mm² — skip smoothing on tiny top surfaces
SMOOTH_PASSES    = 2       # Number of smoothing passes over the top surface
SMOOTH_ALTERNATE = True    # Alternate direction for each consecutive pass
SMOOTH_ANGLE     = 0.0     # Base grid angle

SMOOTH_ENABLE_AREA_BOOST = False # Enable dynamic power scaling based on surface area
SMOOTH_AREA_BOOST = 0.60   # Max power multiplier (0.60 = +60%) for large areas
SMOOTH_AREA_MAX   = 900.0  # mm² at which max boost is applied
SMOOTH_AREA_BASE  = 16.0   # mm² at which boost begins
SMOOTH_ANGLE_STEP= 90.0    # Degrees to rotate between alternating passes
SMOOTH_PREHEAT   = 0       # ms to preheat before moving
SMOOTH_FAN_SPEED = 0       # Fan speed (0-255) during smoothing
SMOOTH_LASER_PIN = "laser_pwm3" # New perpendicular laser
SMOOTH_OFFSET_X  = 34.0    # mm offset X
SMOOTH_OFFSET_Y  = 72.5   # mm offset Y

SMOOTH_SMART_CHUNKING = False     # Enable chunking for large top surfaces (off by default)
SMOOTH_CHUNK_SIZE     = 20.0      # mm — max dimension of each chunk
SMOOTH_CHUNK_FULL_PASS = True     # Run a final pass over the full size to blend chunk edges
SMOOTH_CHUNK_FULL_PASS_POWER = 0.15 # Power for the final edge pass when chunking is active
SMOOTH_BOOLEAN_RES    = 0.1       # mm — lower resolution (default 0.2) for sharper edge tracking

# Motion limits (from printer.cfg) for bounds checking
X_MIN, X_MAX = -6.0, 235.0
Y_MIN, Y_MAX = -2.0, 235.0


# ═════════════════════════════════════════════════════════════════════
#  4. WALL SMOOTHING CONFIGURATION
#     After an outer wall is printed, the laser traces the outside of
#     the wall (offset by X) to remelt the side of the layers.
# ═════════════════════════════════════════════════════════════════════
WALL_SMOOTH_ENABLED       = False
WALL_MODE_PASS1          = "standard"
WALL_MODE_PASS2          = "none"
WALL_PASS2_SPEED         = 20.0
WALL_PASS2_POWER_PLUS    = 0.10
WALL_PASS2_POWER_MINUS   = 0.10
WALL_PASS2_REVERSE_DIRECTION = False
WALL_PASS2_WOBBLE_REVERSE    = False
WALL_WOBBLE_PROJECTION_FACTOR = 1.0
WALL_SMOOTH_POWER_X_PLUS  = 0.20    # PWM for the right side (X+) laser
WALL_SMOOTH_POWER_X_MINUS = 0.20    # PWM for the left side (X-) laser
WALL_SMOOTH_OVERHANG_POWER_X_PLUS = 0.20
WALL_SMOOTH_OVERHANG_POWER_X_MINUS = 0.20
WALL_SMOOTH_SPEED         = 20.0    # mm/s
WALL_SMOOTH_FREQ          = 1       # Run every N layers
WALL_SMOOTH_PASSES        = 1       # Number of passes per wall
WALL_SMOOTH_MIN_LAYER     = 3       # Start at layer
WALL_SMOOTH_ANGLE_TOL     = 55.0    # Degrees — max deviation from Y axis
WALL_SMOOTH_TARGET        = "both"  # Options: "both", "outer", "inner"
WALL_SMOOTH_MIN_PATH_AREA = 16.0    # mm² — skip loops smaller than this (eyes, tiny features)

WALL_DEEP_MODE           = False
WALL_Z_DIVISIONS         = 1
WALL_DEEP_OVERHANG_ANGLE = 70.0
WALL_DEEP_OVERLAP        = 1      # Number of layers to overlap the seam
WALL_DEEP_SAFETY         = 2      # Layers to leave unsmoothed at the top of a block
WALL_MAX_LAYER_SAFETY    = 0      # Layers to leave unsmoothed at the very top of the print

# Added for Laser Offset Level
WALL_OFFSET_LEVEL        = 0
WALL_Z_OFFSET            = 2.8
WALL_X_PLUS_OFFSET       = 5.0
WALL_X_MINUS_OFFSET      = -5.5
DEEP_MODE_WARNING_SHOWN  = False
WALL_DISABLE_OVERHANG    = False

WALL_WOBBLE_ENABLED      = False
WALL_WOBBLE_SEAM_ONLY    = False
WALL_WOBBLE_PULL_CONTINUOUS = False

WALL_DEEP_WOBBLE_LAYERS       = 4
WALL_DEEP_WOBBLE_OVERLAP      = 1
WALL_DEEP_WOBBLE_SPACING      = 0.2
WALL_DEEP_WOBBLE_CORNER_POWER_DROP = 0.5
WALL_DEEP_WOBBLE_CORNER_DISTANCE   = 1.5
WALL_DEEP_WOBBLE_OVERSHOOT         = 0.0

WALL_SEAM_WOBBLE_SPEED        = 20.0
WALL_SEAM_WOBBLE_POWER_PLUS   = 0.2
WALL_SEAM_WOBBLE_POWER_MINUS  = 0.2
WALL_SEAM_WOBBLE_OVERLAP      = 1
WALL_SEAM_WOBBLE_OVERSHOOT    = 0.0
WALL_SEAM_WOBBLE_SPACING      = 0.2
WALL_SEAM_WOBBLE_CORNER_POWER_DROP = 0.5
WALL_SEAM_WOBBLE_CORNER_DISTANCE   = 1.5

WALL_OVERSHOOT           = 0.0
WALL_CORNER_POWER_DROP   = 0.5   # Ratio of power to apply at corners
WALL_CORNER_DISTANCE     = 1.5   # Distance from corner apex to apply drop
WALL_RETRACT             = 5.0   # mm to retract at start of each wall smooth block
WALL_MAX_RETRACT         = 8.0   # mm max total retraction during a wall smooth block (cap for do_extra_retract)
WALL_STANDBY_TEMP_DROP   = 0.0   # How many degrees to drop nozzle temp during deep sweeps (0 = disabled)
CURRENT_PRINT_TEMP       = 220.0 # Track the current print temperature
# ═════════════════════════════════════════════════════════════════════
#  5. RIVETING CONFIGURATION
#     Pulses the laser at high power over a grid to melt a "plug"
#     that penetrates multiple layers deep for Z-axis anchoring.
# ═════════════════════════════════════════════════════════════════════
RIVET_ENABLED   = False
RIVET_POWER     = 0.25    # PWM for deep penetration (low power, long dwell)
RIVET_TIME      = 2000    # Dwell time (ms) at each rivet point
RIVET_SPACING   = 3.0     # mm between rivets
RIVET_Z_HOP     = 0.50    # mm hop to prevent nozzle collision while moving
RIVET_FREQ      = 4       # Run every N layers
RIVET_MIN_LAYER = 5       # Skip early layers
RIVET_MARGIN    = 1.5     # mm inward shrink from bounding box
RIVET_MIN_AREA  = 2.0     # mm² minimum area to rivet
RIVET_WOBBLE_RADIUS = 0.0 # mm wobble radius for continuous mode
RIVET_WOBBLE_TURNS = 1    # number of revolutions to make during dwell
RIVET_WOBBLE_MAX_SPEED = 250.0 # max mm/s speed for wobble motion
RIVET_PULSE_PERIOD = 200  # ms period for pulsing
RIVET_PULSE_DUTY = 0.5    # duty cycle for pulsing
RIVET_LASER_PIN = "laser_pwm3" # New perpendicular laser
RIVET_OFFSET_X  = 34.0    # mm offset X
RIVET_OFFSET_Y  = 72.5   # mm offset Y


# ═════════════════════════════════════════════════════════════════════
#  6. Z-SWEEPING CONFIGURATION
# ═════════════════════════════════════════════════════════════════════
SWEEP_FEATURE   = ""
SWEEP_START_Z   = 0.0
SWEEP_END_Z     = 50.0
SWEEP_START_VAL = 0.0
SWEEP_END_VAL   = 1.0

ENABLE_PURGE    = False
PURGE_X         = 5.0
PURGE_Y         = 5.0


# ═════════════════════════════════════════════════════════════════════
#  HELPER FUNCTIONS
# ═════════════════════════════════════════════════════════════════════

def get_val(line, char):
    """Extract a numeric value following a G-code letter (e.g. X, Y, E, F)."""
    match = re.search(fr'{char}\s*([-+]?\d*\.?\d+)', line)
    return float(match.group(1)) if match else None


def compute_rotated_bbox(points, angle_deg=0.0, margin=0.0):
    """
    Compute a bounding box for points rotated by -angle_deg around their centroid.
    Returns ((min_x, min_y, max_x, max_y), (cx, cy)) or (None, None).
    """
    if len(points) < 2:
        return None, (None, None)

    import math
    rad = math.radians(angle_deg)
    cos_a = math.cos(-rad)
    sin_a = math.sin(-rad)

    cx = sum(p[0] for p in points) / len(points)
    cy = sum(p[1] for p in points) / len(points)

    rotated = []
    for x, y in points:
        nx = cos_a * (x - cx) - sin_a * (y - cy)
        ny = sin_a * (x - cx) + cos_a * (y - cy)
        rotated.append((nx, ny))

    min_x = min(p[0] for p in rotated) + margin
    max_x = max(p[0] for p in rotated) - margin
    min_y = min(p[1] for p in rotated) + margin
    max_y = max(p[1] for p in rotated) - margin

    # After shrinking, the box might be invalid
    if max_x <= min_x or max_y <= min_y:
        return None, (None, None)

    return (min_x, min_y, max_x, max_y), (cx, cy)


def is_touching(ptsA, ptsB, max_dist=3.0):
    gridA = set()
    for x,y in ptsA:
        gridA.add((int(x/max_dist), int(y/max_dist)))
    for x,y in ptsB:
        gx, gy = int(x/max_dist), int(y/max_dist)
        if (gx, gy) in gridA or (gx+1, gy) in gridA or (gx-1, gy) in gridA or (gx, gy+1) in gridA or (gx, gy-1) in gridA or (gx+1, gy+1) in gridA or (gx-1, gy-1) in gridA or (gx+1, gy-1) in gridA or (gx-1, gy+1) in gridA:
            return True
    return False

def downsample_points(points, resolution=0.5):
    seen = set()
    res = []
    for x, y in points:
        gx, gy = int(x/resolution), int(y/resolution)
        if (gx, gy) not in seen:
            seen.add((gx, gy))
            res.append((x, y))
    return res

def cluster_points(points, max_dist=2.5):
    """
    Cluster points into islands based on spatial proximity.
    Uses a simple grid-based Union-Find approach.
    """
    if not points:
        return []
    
    cell_size = max_dist / 1.414
    grid = {}
    
    for i, (x, y) in enumerate(points):
        cx = int(x // cell_size)
        cy = int(y // cell_size)
        cell = (cx, cy)
        if cell not in grid:
            grid[cell] = []
        grid[cell].append(i)
    
    parent = list(range(len(points)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    
    def union(i, j):
        root_i = find(i)
        root_j = find(j)
        if root_i != root_j:
            parent[root_i] = root_j
            
    import math
    for (cx, cy), indices in grid.items():
        for dx in [-1, 0, 1]:
            for dy in [-1, 0, 1]:
                adj_cell = (cx + dx, cy + dy)
                if adj_cell in grid:
                    adj_indices = grid[adj_cell]
                    for i in indices:
                        px, py = points[i]
                        for j in adj_indices:
                            if i < j:
                                qx, qy = points[j]
                                if math.hypot(px - qx, py - qy) <= max_dist:
                                    union(i, j)
                                    
    clusters_dict = {}
    for i, p in enumerate(points):
        root = find(i)
        if root not in clusters_dict:
            clusters_dict[root] = []
        clusters_dict[root].append(p)
        
    return list(clusters_dict.values())


def bbox_area(bbox):
    """Calculate the area of a bounding box tuple."""
    if bbox is None:
        return 0.0
    return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])


def calculate_boosted_power(base_power, area):
    if not SMOOTH_ENABLE_AREA_BOOST:
        return base_power
    if area <= SMOOTH_AREA_BASE:
        return base_power
    elif area >= SMOOTH_AREA_MAX:
        return min(1.0, base_power * (1.0 + SMOOTH_AREA_BOOST))
    else:
        ratio = (area - SMOOTH_AREA_BASE) / (SMOOTH_AREA_MAX - SMOOTH_AREA_BASE)
        boost = SMOOTH_AREA_BOOST * ratio
        return min(1.0, base_power * (1.0 + boost))


def build_boolean_grid(points, res, max_dist):
    grid = set()
    if res <= 0: res = 0.1  # guard against zero/negative resolution; 0.1mm is the original default
    radius = int(max_dist / res)
    r2 = radius * radius
    for px, py in points:
        cx, cy = int(px / res), int(py / res)
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                if dx*dx + dy*dy <= r2:
                    grid.add((cx + dx, cy + dy))
    return grid

def generate_laser_grid(bbox, cx, cy, angle_deg, speed, power, z_hop, spacing, overshoot, label, laser_pin="laser_pwm1", offset_x=0.0, offset_y=0.0, fan_speed=0, preheat=0, overshoot_without_laser=False, cluster=None, wall_expansion=0.45, layer_points=None, layer_z=None, boolean_res=0.2):
    min_x, min_y, max_x, max_y = bbox
    gcode = []
    f_val = speed * 60.0

    import math
    rad = math.radians(angle_deg)
    cos_a = math.cos(rad)
    sin_a = math.sin(rad)

    def rot(lx, ly):
        nx = cos_a * lx - sin_a * ly + cx
        ny = sin_a * lx + cos_a * ly + cy
        return nx, ny

    def validate_bounds(tx, ty):
        if not (X_MIN <= tx <= X_MAX and Y_MIN <= ty <= Y_MAX):
            raise ValueError("ERROR: Smoothing path exceeds motion limits! X:" + str(tx) + " Y:" + str(ty))

    gcode.append(f"\n; == [{label}] Start - Grid {(max_x-min_x):.1f} x {(max_y-min_y):.1f} mm at {angle_deg} deg, spacing {spacing:.2f} mm ==\n")

    gcode.append(f"SET_PIN PIN=laser_pwm1 VALUE=0\nSET_PIN PIN=laser_pwm2 VALUE=0\nSET_PIN PIN=laser_pwm3 VALUE=0\n")
    gcode.append("G91\n")
    gcode.append(f"G1 E-5.0 F2400\n")
    if layer_z is not None:
        # Use absolute Z to go to the correct height regardless of where we came from
        gcode.append(f"G90\n")
        gcode.append(f"G0 Z{layer_z + z_hop:.3f} F600\n")
    else:
        gcode.append(f"G1 Z{z_hop:.2f} F600\n")
        gcode.append("G90\n")
    if fan_speed > 0:
        gcode.append(f"M106 S{int(fan_speed)}\n")

    bool_grid = None
    res = boolean_res
    if cluster and len(cluster) > 0:
        # Expand boolean grid by wall_expansion (default ~one nozzle width = 0.45mm).
        # This bridges the gap between top-surface infill and the outer wall edge,
        # catching sharp corners WITHOUT bleeding into areas that have walls above them.
        bool_grid = build_boolean_grid(cluster, res, max_dist=wall_expansion)
        # Also expand the local bbox by the same margin so the scan range covers corners
        min_x -= wall_expansion
        max_x += wall_expansion
        min_y -= wall_expansion
        max_y += wall_expansion


    y = min_y
    forward = True
    laser_is_on = False
    first_line = True
    prev_tx2 = None
    prev_ty2 = None
    
    while y <= max_y + 0.001:
        scan_segments = []
        if bool_grid:
            in_segment = False
            start_x = None
            step = res
            cx_min = min_x
            while cx_min <= max_x + 0.001:
                gx, gy = rot(cx_min, y)
                near = (int(gx / res), int(gy / res)) in bool_grid
                if near and not in_segment:
                    in_segment = True
                    start_x = cx_min
                elif not near and in_segment:
                    in_segment = False
                    scan_segments.append((start_x, cx_min - step))
                cx_min += step
            if in_segment:
                scan_segments.append((start_x, max_x))
        else:
            scan_segments = [(min_x, max_x)]
            
        if not scan_segments:
            y += spacing
            continue
            
        if not forward:
            scan_segments = [(end_x, start_x) for start_x, end_x in reversed(scan_segments)]
            
        for i, (lx1, lx2) in enumerate(scan_segments):
            lx1_over = lx1 - overshoot if (lx1 < lx2) else lx1 + overshoot
            lx2_over = lx2 + overshoot if (lx1 < lx2) else lx2 - overshoot
            
            rx1, ry1 = rot(lx1, y)
            rx2, ry2 = rot(lx2, y)
            rx1_over, ry1_over = rot(lx1_over, y)
            rx2_over, ry2_over = rot(lx2_over, y)

            tx1, ty1 = rx1 + offset_x, ry1 + offset_y
            tx2, ty2 = rx2 + offset_x, ry2 + offset_y
            tx1_over, ty1_over = rx1_over + offset_x, ry1_over + offset_y
            tx2_over, ty2_over = rx2_over + offset_x, ry2_over + offset_y
            # Strict bounds check: the printer firmware strictly enforces motion limits on the nozzle.
            # Because the laser has an offset, the nozzle might need to exceed Y_MAX to reach the edge of a part.
            # If so, it is physically impossible to smooth that edge, and we must raise an error so the user
            # knows to move the part further away from the bed edge in the slicer.
            def check_bounds(tx, ty):
                if not (X_MIN <= tx <= X_MAX and Y_MIN <= ty <= Y_MAX):
                    raise ValueError("ERROR: Smoothing path exceeds motion limits! X:" + str(tx) + " Y:" + str(ty))

            check_bounds(tx1, ty1)
            check_bounds(tx2, ty2)

            start_x = tx1_over if overshoot > 0 else tx1
            start_y = ty1_over if overshoot > 0 else ty1
            end_x = tx2_over if overshoot > 0 else tx2
            end_y = ty2_over if overshoot > 0 else ty2

            if prev_tx2 is not None and prev_ty2 is not None:
                dist = math.hypot(start_x - prev_tx2, start_y - prev_ty2)
            else:
                dist = 9999.0
                
            if not first_line and dist < 2.0:
                if not laser_is_on:
                    gcode.append(f"SET_PIN PIN={laser_pin} VALUE={power:.3f}\n")
                    laser_is_on = True
                gcode.append(f"G1 X{start_x:.3f} Y{start_y:.3f} F{f_val:.0f} ; continuous edge travel\n")
            else:
                if laser_is_on:
                    gcode.append(f"SET_PIN PIN={laser_pin} VALUE=0\n")
                    laser_is_on = False
                gcode.append(f"G0 X{start_x:.3f} Y{start_y:.3f} F6000\n")
                
                gcode.append(f"SET_PIN PIN={laser_pin} VALUE={power:.3f}\n")
                if preheat > 0:
                    gcode.append(f"G4 P{int(preheat)}\n")
                laser_is_on = True
                
            gcode.append(f"G1 X{end_x:.3f} Y{end_y:.3f} F{f_val:.0f}\n")
            prev_tx2 = end_x
            prev_ty2 = end_y
            
            first_line = False

        forward = not forward
        y += spacing

    if laser_is_on:
        gcode.append(f"SET_PIN PIN={laser_pin} VALUE=0\n")

    if fan_speed > 0:
        gcode.append(f"M107\n")
    if layer_z is not None:
        # Use absolute Z to go back to the correct layer height
        gcode.append(f"G0 Z{layer_z:.3f} F600\n")
        gcode.append("G91\n")
        gcode.append(f"G1 E5.0 F2400\n")
        gcode.append("G90\n")
    else:
        gcode.append("G91\n")
        gcode.append(f"G1 Z-{z_hop:.2f} F600\n")
        gcode.append(f"G1 E5.0 F2400\n")
        gcode.append("G90\n")

    num_lines = int((max_y - min_y) / spacing) + 1
    gcode.append(f"; == [{label}] End - {num_lines} lines traced ==\n\n")

    return gcode



def is_point_in_path(pt_x, pt_y, path):
    inside = False
    for seg in path:
        x1, y1, x2, y2 = seg[:4]
        if ((y1 > pt_y) != (y2 > pt_y)) and (pt_x < (x2 - x1) * (pt_y - y1) / (y2 - y1) + x1):
            inside = not inside
    return inside

def build_paths_from_segments(segments):
    paths = []
    current_path = []
    for x1, y1, x2, y2 in segments:
        if not current_path:
            current_path.append((x1, y1, x2, y2))
        else:
            last_x2, last_y2 = current_path[-1][2], current_path[-1][3]
            if abs(x1 - last_x2) < 0.01 and abs(y1 - last_y2) < 0.01:
                current_path.append((x1, y1, x2, y2))
            else:
                paths.append(current_path)
                current_path = [(x1, y1, x2, y2)]
    if current_path:
        paths.append(current_path)
        
    path_is_hole = []
    for i, path in enumerate(paths):
        if not path:
            path_is_hole.append(False)
            continue
        pt_x, pt_y = path[0][0], path[0][1]
        contain_count = 0
        for j, other_path in enumerate(paths):
            if i == j: continue
            if is_point_in_path(pt_x, pt_y, other_path):
                contain_count += 1
        path_is_hole.append(contain_count % 2 == 1)
        
    return paths, path_is_hole

def generate_wobble_passes(wall_segments, prev_segments, current_z, prev_z, start_depth_layers, end_depth_layers, speed, passes_count, x_plus_power, x_minus_power, angle_tol, overshoot=0.0):
    """
    Generate G-code for Z-wobble passes using high-speed X oscillation.
    Supports chunking for Deep Mode integration.
    """
    import math
    gcode = []
    
    if not wall_segments or start_depth_layers >= end_depth_layers:
        return gcode
        
    global WALL_STANDBY_TEMP_DROP, CURRENT_PRINT_TEMP, ENABLE_PURGE, PURGE_X, PURGE_Y, WALL_RETRACT, WALL_MAX_RETRACT

        
    f_val = speed * 60.0
    layer_height = current_z - prev_z if (prev_z is not None and current_z > prev_z) else 0.2
    
    threshold_dist = layer_height * math.tan(math.radians(WALL_DEEP_OVERHANG_ANGLE)) if (WALL_DEEP_MODE and prev_segments) else float('inf')
    
    paths, path_is_hole = build_paths_from_segments(wall_segments)
    
    # Clean up paths by removing small seam overlaps that cause double-wobble passes
    cleaned_paths = []
    for path in paths:
        if len(path) > 1:
            first_seg = path[0]
            last_seg = path[-1]
            d_first = math.hypot(first_seg[2]-first_seg[0], first_seg[3]-first_seg[1])
            d_last = math.hypot(last_seg[2]-last_seg[0], last_seg[3]-last_seg[1])
            
            if d_first > 0.01 and d_last > 0.01:
                nx1 = (first_seg[2]-first_seg[0])/d_first
                ny1 = (first_seg[3]-first_seg[1])/d_first
                nx2 = (last_seg[2]-last_seg[0])/d_last
                ny2 = (last_seg[3]-last_seg[1])/d_last
                
                # If the last segment is parallel to the first and very short (like a slicer seam overlap)
                if (nx1*nx2 + ny1*ny2) > 0.99 and d_last < 5.0:
                    path = path[:-1]
        cleaned_paths.append(path)
    paths = cleaned_paths
    
    global WALL_SEAM_WOBBLE_CORNER_DISTANCE, WALL_SEAM_WOBBLE_CORNER_POWER_DROP, WALL_WOBBLE_PULL_ONLY
    paths = split_corners_in_paths(paths, WALL_SEAM_WOBBLE_CORNER_DISTANCE, WALL_SEAM_WOBBLE_CORNER_POWER_DROP, path_is_hole)
    import math
    if overshoot > 0:
        for p in paths:
            if len(p) > 2:
                sx, sy = p[0][0], p[0][1]
                end_x, end_y = p[-1][2], p[-1][3]
                path_len = sum(math.hypot(s[2]-s[0], s[3]-s[1]) for s in p)
                if path_len > 5.0 and math.hypot(end_x - sx, end_y - sy) < 1.0:
                    continue # closed loop
            if len(p) > 0:
                f_seg = list(p[0])
                dx = f_seg[2] - f_seg[0]
                dy = f_seg[3] - f_seg[1]
                l = math.hypot(dx, dy)
                if l > 0.001:
                    f_seg[0] = f_seg[0] - (dx/l) * overshoot
                    f_seg[1] = f_seg[1] - (dy/l) * overshoot
                    p[0] = tuple(f_seg)
                
                l_seg = list(p[-1])
                dx = l_seg[2] - l_seg[0]
                dy = l_seg[3] - l_seg[1]
                l = math.hypot(dx, dy)
                if l > 0.001:
                    l_seg[2] = l_seg[2] + (dx/l) * overshoot
                    l_seg[3] = l_seg[3] + (dy/l) * overshoot
                    p[-1] = tuple(l_seg)

    
    # Removed incorrect 5mm path truncation. Deep Mode seams wrap the entire part.
    z_start_drop = layer_height * start_depth_layers
    z_end_drop = layer_height * end_depth_layers
    z_wobble_dist = z_end_drop - z_start_drop
    
    x_plus_ratio = WALL_X_PLUS_OFFSET / WALL_Z_OFFSET if WALL_Z_OFFSET != 0 else 0
    x_minus_ratio = WALL_X_MINUS_OFFSET / WALL_Z_OFFSET if WALL_Z_OFFSET != 0 else 0
    
    target_z_base = current_z - (z_start_drop + z_end_drop) / 2.0
    target_z = target_z_base + WALL_Z_OFFSET

    last_ex = None
    last_ey = None

    total_retracted = 0.0
    if WALL_STANDBY_TEMP_DROP > 0 and CURRENT_PRINT_TEMP > 0:
        initial_retract = min(WALL_RETRACT, WALL_MAX_RETRACT)
        total_retracted = initial_retract
        gcode.append("G91 ; relative\n")
        gcode.append(f"G1 E-{initial_retract:.1f} F2400 ; [Wobble] batch retract\n")
        gcode.append("G90 ; absolute\n")
        
        target_temp = max(0, CURRENT_PRINT_TEMP - WALL_STANDBY_TEMP_DROP)
        gcode.append(f"M104 S{target_temp} ; [Wobble] Standby temp drop\n")
        if ENABLE_PURGE:
            gcode.append(f"G0 Z{current_z + 2.8:.3f} F600 ; z-hop for travel to purge bucket\n")
            gcode.append(f"G0 X{PURGE_X:.3f} Y{PURGE_Y:.3f} F6000 ; move to purge bucket for cooldown\n")
            gcode.append("M106 S255 ; blast fan to cool nozzle faster\n")
            gcode.append("G4 P10000 ; dwell 10 seconds\n")
            gcode.append("M107 ; shut off fan during smoothing\n")
            gcode.append(f"G0 Z{current_z:.3f} F600 ; return to sweep Z height\n")
        else:
            gcode.append("M106 S255 ; blast fan to cool nozzle faster\n")
            gcode.append("G4 P10000 ; dwell 10 seconds\n")
            gcode.append("M107 ; shut off fan during smoothing\n")


    for pass_idx in range(passes_count):
        gcode.append(f"\n; == [Wobble Pass {pass_idx+1}/{passes_count}] Start - Layers {start_depth_layers} to {end_depth_layers} ==\n")
        gcode.append(f"G0 Z{target_z:.3f} F600 ; [Wobble] Drop to seam layer\n")
        
        for path_idx, path in enumerate(paths):
            area_sum = 0.0
            for pt_idx in range(len(path)):
                x1, y1, x2, y2 = path[pt_idx][:4]
                area_sum += (x2 - x1) * (y2 + y1)
            
            curr_laser = None
            curr_power = None
            
            if WALL_WOBBLE_PULL_ONLY:
                new_path = []
                push_group = []
                for seg in path:
                    x1, y1, x2, y2 = seg[:4]
                    dx, dy = x2 - x1, y2 - y1
                    l = math.hypot(dx, dy)
                    if l < 0.001:
                        norm_seg = list(seg)
                        if len(norm_seg) == 4: norm_seg.append(1.0)
                        norm_seg.append("PLUS")
                        new_path.append(tuple(norm_seg))
                        continue
                    
                    nx = dy
                    if nx > abs(x2 - x1) * 0.1:
                        laser_dir_seg = "PLUS"
                    elif nx < -abs(x2 - x1) * 0.1:
                        laser_dir_seg = "MINUS"
                    else:
                        laser_dir_seg = curr_laser if curr_laser else "PLUS"
                    
                    should_reverse = False
                    if laser_dir_seg == "PLUS" and dx < -0.001:
                        should_reverse = True
                    elif laser_dir_seg == "MINUS" and dx > 0.001:
                        should_reverse = True
                    
                    if should_reverse:
                        rev_seg = list(seg)
                        rev_seg[0], rev_seg[1], rev_seg[2], rev_seg[3] = x2, y2, x1, y1
                        if len(rev_seg) == 4: rev_seg.append(1.0)
                        rev_seg.append(laser_dir_seg)
                        push_group.append(tuple(rev_seg))
                    else:
                        if push_group:
                            new_path.extend(reversed(push_group))
                            push_group = []
                        norm_seg = list(seg)
                        if len(norm_seg) == 4: norm_seg.append(1.0)
                        norm_seg.append(laser_dir_seg)
                        new_path.append(tuple(norm_seg))
                if push_group:
                    new_path.extend(reversed(push_group))
                path = new_path
            
            for pt_idx in range(len(path)):
                seg = path[pt_idx]
                x1, y1, x2, y2 = seg[:4]
                power_factor = seg[4] if len(seg) > 4 else 1.0
                
                dx = x2 - x1
                dy = y2 - y1
                if dx == 0 and dy == 0: continue
                    
                angle = math.degrees(math.atan2(abs(x2 - x1), abs(dy)))
                if angle > angle_tol:
                    if curr_laser is not None:
                        gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                        curr_laser = None
                    continue
                    
                    
                nx = dy
                if nx > abs(x2 - x1) * 0.1:
                    laser_dir = "PLUS"
                elif nx < -abs(x2 - x1) * 0.1:
                    laser_dir = "MINUS"
                else:
                    laser_dir = curr_laser if curr_laser else "PLUS"
                    
                # Overhang Detection for Wobble
                is_overhang = False
                if WALL_DEEP_MODE and not WALL_DISABLE_OVERHANG:
                    if not prev_segments:
                        is_overhang = True
                    else:
                        mx, my = (x1 + x2) / 2.0, (y1 + y2) / 2.0
                        min_dx = None
                        closest_px = None
                        for (px1, py1, px2, py2) in prev_segments:
                            min_y, max_y = min(py1, py2), max(py1, py2)
                            if min_y - 0.1 <= my <= max_y + 0.1:
                                if py1 != py2:
                                    px = px1 + (my - py1) * (px2 - px1) / (py2 - py1)
                                else:
                                    px = (px1 + px2) / 2.0
                                ox = mx - px
                                if closest_px is None or abs(ox) < abs(min_dx):
                                    min_dx = ox
                                    closest_px = px
                        if closest_px is None:
                            is_overhang = True
                        else:
                            if laser_dir == "PLUS" and min_dx > threshold_dist:
                                is_overhang = True
                            elif laser_dir == "MINUS" and min_dx < -threshold_dist:
                                is_overhang = True
                            
                if is_overhang:
                    if curr_laser is not None:
                        gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                        curr_laser = None
                    continue # Skip overhangs during deep wobble sweeps!
                    
                base_shift = WALL_X_PLUS_OFFSET if laser_dir == "PLUS" else WALL_X_MINUS_OFFSET
                ratio = x_plus_ratio if laser_dir == "PLUS" else x_minus_ratio
                base_power = x_plus_power if laser_dir == "PLUS" else x_minus_power
                power = base_power * power_factor
                
                segment_len = math.hypot(dx, dy)
                ndx = dx / segment_len
                ndy = dy / segment_len
                
                num_wobbles = int(segment_len / max(0.01, WALL_SEAM_WOBBLE_SPACING))
                if num_wobbles < 1: num_wobbles = 1
                step_len = segment_len / num_wobbles
                
                start_nx = x1 + base_shift
                
                if pass_idx > 0 or (last_ex is not None and last_ey is not None):
                    if last_ex is not None and last_ey is not None:
                        dist_back = math.hypot(start_nx - last_ex, y1 - last_ey)
                        if dist_back > 1.0:
                            if curr_laser is not None:
                                gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                                curr_laser = None
                            gcode.append(f"G0 X{start_nx:.3f} Y{y1:.3f} F6000\n")
                        else:
                            gcode.append(f"G1 X{start_nx:.3f} Y{y1:.3f} F6000\n")
                    else:
                        gcode.append(f"G0 X{start_nx:.3f} Y{y1:.3f} F6000\n")
                else:
                    gcode.append(f"G0 X{start_nx:.3f} Y{y1:.3f} F6000\n")
                
                pin = "laser_pwm1" if laser_dir == "PLUS" else "laser_pwm2"
                if curr_laser != pin or curr_power is None or abs(curr_power - power) > 0.001:
                    if curr_laser is not None and curr_laser != pin:
                        gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                    if power >= 0.01:
                        gcode.append(f"SET_PIN PIN={pin} VALUE={power:.3f}\n")
                    curr_laser = pin
                    curr_power = power
                    
                if power < 0.01:
                    if curr_laser is not None:
                        gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                        curr_laser = None
                
                base_wobble_amplitude_x = z_wobble_dist * ratio * WALL_WOBBLE_PROJECTION_FACTOR

                perp_x = base_wobble_amplitude_x
                perp_y = 0.0

                for i in range(num_wobbles):
                    if WALL_WOBBLE_PULL_ONLY and not WALL_WOBBLE_PULL_CONTINUOUS:
                        current_perp_x = perp_x
                        current_perp_y = perp_y
                        
                        pt_base_x = x1 + ndx * (i * step_len) + base_shift
                        pt_base_y = y1 + ndy * (i * step_len)
                        
                        pt_peak_x = pt_base_x + current_perp_x
                        pt_peak_y = pt_base_y + current_perp_y
                        
                        if curr_laser is not None:
                            gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                            curr_laser = None
                        gcode.append(f"G0 X{pt_base_x:.3f} Y{pt_base_y:.3f} F6000\n")
                        
                        curr_laser = "laser_pwm1" if laser_dir == "PLUS" else "laser_pwm2"
                        gcode.append(f"SET_PIN PIN={curr_laser} VALUE={power:.3f}\n")
                        gcode.append(f"G1 X{pt_peak_x:.3f} Y{pt_peak_y:.3f} F{f_val}\n")
                    else:
                        is_out = (i % 2 == 0)
                        current_perp_x = perp_x if is_out else -perp_x
                        current_perp_y = perp_y if is_out else -perp_y
                        
                        pt_base_x = x1 + ndx * (i * step_len) + base_shift
                        pt_base_y = y1 + ndy * (i * step_len)
                        
                        pt_peak_x = pt_base_x + current_perp_x
                        pt_peak_y = pt_base_y + current_perp_y
                        
                        # 1. Sweep vertically to the peak
                        gcode.append(f"G1 X{pt_peak_x:.3f} Y{pt_peak_y:.3f} F{f_val}\n")
                        
                        # 2. Sweep horizontally to the next position along the peak
                        pt_next_base_x = x1 + ndx * ((i+1) * step_len) + base_shift
                        pt_next_base_y = y1 + ndy * ((i+1) * step_len)
                        
                        pt_next_peak_x = pt_next_base_x + current_perp_x
                        pt_next_peak_y = pt_next_base_y + current_perp_y
                        
                        gcode.append(f"G1 X{pt_next_peak_x:.3f} Y{pt_next_peak_y:.3f} F{f_val}\n")
                        
                        pt_end_x = pt_next_peak_x
                        pt_end_y = pt_next_peak_y
                
                # Return to baseline at the end of the segment for a clean transition
                pt_final_base_x = x1 + ndx * (num_wobbles * step_len) + base_shift
                pt_final_base_y = y1 + ndy * (num_wobbles * step_len)
                gcode.append(f"G1 X{pt_final_base_x:.3f} Y{pt_final_base_y:.3f} F{f_val}\n")
                
                last_ex = pt_final_base_x
                last_ey = pt_final_base_y
                    
            if curr_laser is not None:
                gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
            
    # Return to layer Z so subsequent smooth pass can correctly position itself
    gcode.append(f"G0 Z{current_z:.3f} F600 ; [Wobble] Return to layer Z\n")
    
    if WALL_STANDBY_TEMP_DROP > 0 and CURRENT_PRINT_TEMP > 0:
        gcode.append(f"M109 S{CURRENT_PRINT_TEMP} ; [Wobble] Restore print temp and wait\n")
        
    gcode.append(f"; == [Wobble Pass] End == RETRACT={total_retracted:.1f}\n")
    return gcode

def split_corners_in_paths(paths, corner_dist, power_scaler, path_is_hole=None):
    if corner_dist <= 0.0 or power_scaler >= 1.0:
        return paths
        
    power_scaler = max(0.0, min(1.0, power_scaler))
        
    new_paths = []
    import math
    for path_idx, path in enumerate(paths):
        if not path:
            new_paths.append([])
            continue
            
        def get_laser_dir(s):
            dx = s[2] - s[0]
            dy = s[3] - s[1]
            nx = dy
            if nx > abs(dx) * 0.1: return "PLUS"
            if nx < -abs(dx) * 0.1: return "MINUS"
            return None

        new_path = []
        for i in range(len(path)):
            x1, y1, x2, y2 = path[i][:4]
            seg_len = math.hypot(x2 - x1, y2 - y1)
            
            # Check angle with PREVIOUS segment
            is_sharp_entry = False
            prev_seg = path[i-1] if i > 0 else (path[-1] if math.hypot(path[0][0] - path[-1][2], path[0][1] - path[-1][3]) < 0.1 else None)
            if prev_seg:
                px1, py1, px2, py2 = prev_seg[:4]
                v1x, v1y = px2 - px1, py2 - py1
                v2x, v2y = x2 - x1, y2 - y1
                mag1, mag2 = math.hypot(v1x, v1y), math.hypot(v2x, v2y)
                if mag1 > 0.001 and mag2 > 0.001:
                    cos_theta = max(-1.0, min(1.0, (v1x*v2x + v1y*v2y) / (mag1*mag2)))
                    angle = math.degrees(math.acos(cos_theta))
                    if angle > 45.0:
                        is_sharp_entry = True
                        if get_laser_dir(prev_seg) != get_laser_dir(path[i]) and get_laser_dir(path[i]) is not None:
                            is_sharp_entry = False
                        
            # Check angle with NEXT segment
            is_sharp_exit = False
            next_seg = path[i+1] if i < len(path) - 1 else (path[0] if math.hypot(path[-1][2] - path[0][0], path[-1][3] - path[0][1]) < 0.1 else None)
            if next_seg:
                nx1, ny1, nx2, ny2 = next_seg[:4]
                v1x, v1y = x2 - x1, y2 - y1
                v2x, v2y = nx2 - nx1, ny2 - ny1
                mag1, mag2 = math.hypot(v1x, v1y), math.hypot(v2x, v2y)
                if mag1 > 0.001 and mag2 > 0.001:
                    cos_theta = max(-1.0, min(1.0, (v1x*v2x + v1y*v2y) / (mag1*mag2)))
                    angle = math.degrees(math.acos(cos_theta))
                    if angle > 45.0:
                        is_sharp_exit = True
                        if get_laser_dir(next_seg) != get_laser_dir(path[i]) and get_laser_dir(path[i]) is not None:
                            is_sharp_exit = False
                        
            # If the segment is extremely short, scale the whole thing
            if seg_len <= corner_dist * 2:
                if is_sharp_entry or is_sharp_exit:
                    new_path.append((x1, y1, x2, y2, power_scaler))
                else:
                    new_path.append((x1, y1, x2, y2, 1.0))
                continue
                
            # Otherwise, split it
            curr_x, curr_y = x1, y1
            
            if is_sharp_entry:
                split_ratio = corner_dist / seg_len
                sx = x1 + (x2 - x1) * split_ratio
                sy = y1 + (y2 - y1) * split_ratio
                new_path.append((curr_x, curr_y, sx, sy, power_scaler))
                curr_x, curr_y = sx, sy
                
            if is_sharp_exit:
                split_ratio = (seg_len - corner_dist) / seg_len
                sx = x1 + (x2 - x1) * split_ratio
                sy = y1 + (y2 - y1) * split_ratio
                new_path.append((curr_x, curr_y, sx, sy, 1.0))
                new_path.append((sx, sy, x2, y2, power_scaler))
            else:
                new_path.append((curr_x, curr_y, x2, y2, 1.0))
                
        new_paths.append(new_path)
    return new_paths


def generate_deep_wobble_passes(chunk_map, chunk_z_map, chunk_layers, top_segments, current_z, z_drop, speed, passes_count, x_plus_power, x_minus_power, angle_tol, reverse_path=False, reverse_wobble=False, overshoot=0.0):
    import math
    gcode = []
    if not top_segments or z_drop <= 0:
        return gcode
        
    global WALL_RETRACT, WALL_MAX_RETRACT, WALL_DEEP_MODE
    global WALL_X_PLUS_OFFSET, WALL_X_MINUS_OFFSET, WALL_Z_OFFSET, WALL_DEEP_WOBBLE_SPACING, WALL_DEEP_WOBBLE_CORNER_DISTANCE, WALL_DEEP_WOBBLE_CORNER_POWER_DROP
    global WALL_STANDBY_TEMP_DROP, CURRENT_PRINT_TEMP, ENABLE_PURGE, PURGE_X, PURGE_Y
    
    mode_str = f"DeepMode:{WALL_DEEP_MODE} - Wobble"
    top_layer = chunk_layers[-1] if chunk_layers else 0
    gcode.append(f"\n; == [Wall Smooth] Start (Layer {top_layer}) - {mode_str} Z Drop:{z_drop:.2f}mm OffsetX1:{WALL_X_PLUS_OFFSET:.2f} OffsetX2:{WALL_X_MINUS_OFFSET:.2f} OffsetZ:{WALL_Z_OFFSET:.2f} ==\n")
    gcode.append("G91 ; relative\n")
    initial_retract = min(WALL_RETRACT, WALL_MAX_RETRACT)
    gcode.append(f"G1 E-{initial_retract:.1f} F2400 ; [Wall Smooth] batch retract\n")
    gcode.append("G90 ; absolute\n")
    
    if WALL_DEEP_MODE and WALL_STANDBY_TEMP_DROP > 0 and CURRENT_PRINT_TEMP > 0:
        target_temp = max(0, CURRENT_PRINT_TEMP - WALL_STANDBY_TEMP_DROP)
        gcode.append(f"M104 S{target_temp} ; [Wall Smooth] Standby temp drop\n")
        if ENABLE_PURGE:
            gcode.append(f"G0 Z{current_z + 2.8:.3f} F600 ; z-hop for travel to purge bucket\n")
            gcode.append(f"G0 X{PURGE_X:.3f} Y{PURGE_Y:.3f} F6000 ; move to purge bucket for cooldown\n")
            gcode.append("M106 S255 ; blast fan to cool nozzle faster\n")
            gcode.append("G4 P10000 ; dwell 10 seconds\n")
            gcode.append("M107 ; shut off fan during smoothing\n")
        else:
            gcode.append("M106 S255 ; blast fan to cool nozzle faster\n")
            gcode.append("G4 P10000 ; dwell 10 seconds\n")
            gcode.append("M107 ; shut off fan during smoothing\n")
            
    target_z = current_z + WALL_Z_OFFSET
    gcode.append(f"G0 Z{target_z:.3f} F300 ; Raise nozzle for laser focal offset\n")
        
    f_val = speed * 60.0
    
    paths, path_is_hole = build_paths_from_segments(top_segments)
    
    if reverse_path:
        for i in range(len(paths)):
            paths[i] = [(seg[2], seg[3], seg[0], seg[1]) for seg in reversed(paths[i])]
            
    cleaned_paths = []
    for path in paths:
        if len(path) > 1:
            first_seg = path[0]
            last_seg = path[-1]
            d_first = math.hypot(first_seg[2]-first_seg[0], first_seg[3]-first_seg[1])
            d_last = math.hypot(last_seg[2]-last_seg[0], last_seg[3]-last_seg[1])
            if d_first > 0.01 and d_last > 0.01:
                nx1 = (first_seg[2]-first_seg[0])/d_first
                ny1 = (first_seg[3]-first_seg[1])/d_first
                nx2 = (last_seg[2]-last_seg[0])/d_last
                ny2 = (last_seg[3]-last_seg[1])/d_last
                if (nx1*nx2 + ny1*ny2) > 0.95 and d_last < 5.0:
                    path = path[:-1]
        cleaned_paths.append(path)
        
    # Re-integrate corner drops for wobble sweeps
    cleaned_paths = split_corners_in_paths(cleaned_paths, WALL_DEEP_WOBBLE_CORNER_DISTANCE, WALL_DEEP_WOBBLE_CORNER_POWER_DROP, path_is_hole)
    laser_split_paths = []
    for path_idx, path in enumerate(cleaned_paths):
        
        curr_loop_split_paths = []
        curr_sub_path = []
        curr_laser = None
        for seg in path:
            x1, y1, x2, y2 = seg[:4]
            dy = y2 - y1
            
            if len(seg) > 5:
                laser_dir_seg = seg[5]
            else:
                if abs(dy) < 0.01:
                    laser_dir_seg = curr_laser if curr_laser else "PLUS"
                else:
                    nx = dy
                    if nx > abs(x2 - x1) * 0.1:
                        laser_dir_seg = "PLUS"
                    elif nx < -abs(x2 - x1) * 0.1:
                        laser_dir_seg = "MINUS"
                    else:
                        laser_dir_seg = curr_laser if curr_laser else "PLUS"
                    
            norm_seg = list(seg)
            if len(norm_seg) == 4: norm_seg.append(1.0)
            if len(norm_seg) == 5: norm_seg.append(laser_dir_seg)
            else: norm_seg[5] = laser_dir_seg
            
            if curr_laser is None:
                curr_laser = laser_dir_seg
                curr_sub_path.append(tuple(norm_seg))
            elif curr_laser == laser_dir_seg:
                curr_sub_path.append(tuple(norm_seg))
            else:
                curr_loop_split_paths.append((curr_laser, curr_sub_path))
                curr_sub_path = [tuple(norm_seg)]
                curr_laser = laser_dir_seg
        if curr_sub_path:
            curr_loop_split_paths.append((curr_laser, curr_sub_path))
            
        if overshoot > 0:
            is_closed_loop = False
            if len(path) > 2:
                path_len = sum(math.hypot(s[2]-s[0], s[3]-s[1]) for s in path)
                is_closed_loop = (path_len > 5.0 and math.hypot(path[-1][2] - path[0][0], path[-1][3] - path[0][1]) < 1.0)
                
            for i, (laser, sp) in enumerate(curr_loop_split_paths):
                if len(sp) == 0: continue
                
                should_overshoot_start = False
                if i > 0:
                    should_overshoot_start = True
                elif is_closed_loop and len(curr_loop_split_paths) > 1:
                    if curr_loop_split_paths[-1][0] != laser:
                        should_overshoot_start = True
                        
                should_overshoot_end = False
                if i < len(curr_loop_split_paths) - 1:
                    should_overshoot_end = True
                elif is_closed_loop and len(curr_loop_split_paths) > 1:
                    if curr_loop_split_paths[0][0] != laser:
                        should_overshoot_end = True
                        
                if should_overshoot_start:
                    f_seg = list(sp[0])
                    dx = f_seg[2] - f_seg[0]
                    dy = f_seg[3] - f_seg[1]
                    l = math.hypot(dx, dy)
                    if l > 0.001:
                        f_seg[0] = f_seg[0] - (dx/l) * overshoot
                        f_seg[1] = f_seg[1] - (dy/l) * overshoot
                        sp[0] = tuple(f_seg)
                        
                if should_overshoot_end:
                    l_seg = list(sp[-1])
                    dx = l_seg[2] - l_seg[0]
                    dy = l_seg[3] - l_seg[1]
                    l = math.hypot(dx, dy)
                    if l > 0.001:
                        l_seg[2] = l_seg[2] + (dx/l) * overshoot
                        l_seg[3] = l_seg[3] + (dy/l) * overshoot
                        sp[-1] = tuple(l_seg)
                        
        for laser, sp in curr_loop_split_paths:
            laser_split_paths.append(sp)
                    
    if WALL_WOBBLE_PULL_ONLY:
        final_paths = []
        for sp in laser_split_paths:
            if not sp: continue
            
            current_normal_stroke = []
            push_group = []
            laser_dir_seg = sp[0][5]
            
            for seg in sp:
                x1, y1, x2, y2 = seg[:4]
                dx = x2 - x1
                should_reverse = False
                if laser_dir_seg == "PLUS" and dx < -0.001:
                    should_reverse = True
                elif laser_dir_seg == "MINUS" and dx > 0.001:
                    should_reverse = True
                    
                if should_reverse:
                    if current_normal_stroke:
                        final_paths.append(current_normal_stroke)
                        current_normal_stroke = []
                        
                    rev_seg = list(seg)
                    rev_seg[0], rev_seg[1], rev_seg[2], rev_seg[3] = x2, y2, x1, y1
                    push_group.append(tuple(rev_seg))
                else:
                    if push_group:
                        final_paths.append(list(reversed(push_group)))
                        push_group = []
                    current_normal_stroke.append(seg)
                    
            if current_normal_stroke:
                final_paths.append(current_normal_stroke)
            if push_group:
                final_paths.append(list(reversed(push_group)))
        laser_split_paths = final_paths

    cleaned_paths = laser_split_paths

        
    x_plus_ratio = WALL_X_PLUS_OFFSET / WALL_Z_OFFSET if WALL_Z_OFFSET != 0 else 0
    x_minus_ratio = WALL_X_MINUS_OFFSET / WALL_Z_OFFSET if WALL_Z_OFFSET != 0 else 0
    
    target_z_base = chunk_z_map.get(chunk_layers[-1], current_z)
    target_z = target_z_base + WALL_Z_OFFSET
    z_wobble_dist = z_drop

    for pass_idx in range(passes_count):
        gcode.append(f"\n; == [Wobble Pass {pass_idx+1}/{passes_count}] Start ==\n")
        gcode.append(f"G0 Z{target_z:.3f} F600 ; [Wobble] Drop to seam layer\n")
        
        for path_idx, path in enumerate(cleaned_paths):
            curr_laser = None
            curr_power = None
            last_ex = None
            last_ey = None

            for pt_idx in range(len(path)):
                seg = path[pt_idx]
                x1, y1, x2, y2 = seg[:4]
                power_factor = seg[4] if len(seg) > 4 else 1.0
                
                dx, dy = x2 - x1, y2 - y1
                segment_len = math.hypot(dx, dy)
                if segment_len < 0.001: continue
                
                angle = math.degrees(math.atan2(abs(x2 - x1), abs(dy)))
                if angle > angle_tol:
                    if curr_laser is not None:
                        gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                        curr_laser = None
                    continue
                
                laser_dir = seg[5]
                
                base_shift = WALL_X_PLUS_OFFSET if laser_dir == "PLUS" else WALL_X_MINUS_OFFSET
                ratio = x_plus_ratio if laser_dir == "PLUS" else x_minus_ratio
                power = (x_plus_power if laser_dir == "PLUS" else x_minus_power) * power_factor
                
                ndx = dx / segment_len
                ndy = dy / segment_len
                
                num_wobbles = int(segment_len / max(0.01, WALL_DEEP_WOBBLE_SPACING))
                if num_wobbles < 1: num_wobbles = 1
                step_len = segment_len / num_wobbles
                
                start_nx = x1 + base_shift
                
                if pass_idx > 0 or (last_ex is not None and last_ey is not None):
                    if last_ex is not None and last_ey is not None:
                        dist_back = math.hypot(start_nx - last_ex, y1 - last_ey)
                        if dist_back > 1.0:
                            if curr_laser is not None:
                                gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                                curr_laser = None
                            gcode.append(f"G0 X{start_nx:.3f} Y{y1:.3f} F6000\n")
                        else:
                            gcode.append(f"G1 X{start_nx:.3f} Y{y1:.3f} F6000\n")
                    else:
                        gcode.append(f"G0 X{start_nx:.3f} Y{y1:.3f} F6000\n")
                else:
                    gcode.append(f"G0 X{start_nx:.3f} Y{y1:.3f} F6000\n")
                
                pin = "laser_pwm1" if laser_dir == "PLUS" else "laser_pwm2"
                if curr_laser != pin or curr_power is None or abs(curr_power - power) > 0.001:
                    if curr_laser is not None and curr_laser != pin:
                        gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                    if power >= 0.01:
                        gcode.append(f"SET_PIN PIN={pin} VALUE={power:.3f}\n")
                    curr_laser = pin
                    curr_power = power
                
                if power < 0.01:
                    if curr_laser is not None:
                        gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                        curr_laser = None
                
                base_wobble_amplitude_x = z_wobble_dist * ratio * WALL_WOBBLE_PROJECTION_FACTOR

                for i in range(num_wobbles):
                    if WALL_WOBBLE_PULL_ONLY and not WALL_WOBBLE_PULL_CONTINUOUS:
                        current_perp_x = base_wobble_amplitude_x
                        current_perp_y = 0.0
                        
                        pt_base_x = x1 + ndx * (i * step_len) + base_shift
                        pt_base_y = y1 + ndy * (i * step_len)
                        
                        pt_peak_x = pt_base_x + current_perp_x
                        pt_peak_y = pt_base_y + current_perp_y
                        
                        if curr_laser is not None:
                            gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
                            curr_laser = None
                        gcode.append(f"G0 X{pt_base_x:.3f} Y{pt_base_y:.3f} F6000\n")
                        
                        curr_laser = "laser_pwm1" if laser_dir == "PLUS" else "laser_pwm2"
                        gcode.append(f"SET_PIN PIN={curr_laser} VALUE={power:.3f}\n")
                        gcode.append(f"G1 X{pt_peak_x:.3f} Y{pt_peak_y:.3f} F{f_val}\n")
                    else:
                        is_out = (i % 2 == 0)
                        if reverse_wobble:
                            is_out = not is_out
                        current_perp_x = base_wobble_amplitude_x if is_out else 0.0
                        current_perp_y = 0.0
                        
                        pt_base_x = x1 + ndx * (i * step_len) + base_shift
                        pt_base_y = y1 + ndy * (i * step_len)
                        
                        pt_peak_x = pt_base_x + current_perp_x
                        pt_peak_y = pt_base_y + current_perp_y
                        
                        gcode.append(f"G1 X{pt_peak_x:.3f} Y{pt_peak_y:.3f} F{f_val}\n")
                        
                        pt_next_base_x = x1 + ndx * ((i+1) * step_len) + base_shift
                        pt_next_base_y = y1 + ndy * ((i+1) * step_len)
                        
                        pt_next_peak_x = pt_next_base_x + current_perp_x
                        pt_next_peak_y = pt_next_base_y + current_perp_y
                        
                        gcode.append(f"G1 X{pt_next_peak_x:.3f} Y{pt_next_peak_y:.3f} F{f_val}\n")
                    
                pt_final_base_x = x1 + ndx * (num_wobbles * step_len) + base_shift
                pt_final_base_y = y1 + ndy * (num_wobbles * step_len)
                gcode.append(f"G1 X{pt_final_base_x:.3f} Y{pt_final_base_y:.3f} F{f_val}\n")
                
                last_ex = pt_final_base_x
                last_ey = pt_final_base_y
                    
            if curr_laser is not None:
                gcode.append(f"SET_PIN PIN={curr_laser} VALUE=0\n")
            
    gcode.append(f"G0 Z{current_z:.3f} F600 ; [Wobble] Return to layer Z\n")
    if WALL_DEEP_MODE and WALL_STANDBY_TEMP_DROP > 0 and CURRENT_PRINT_TEMP > 0:
        gcode.append(f"M109 S{CURRENT_PRINT_TEMP} ; [Wall Smooth] Restore print temp and wait\n")
    gcode.append(f"; == [Wall Smooth] End == RETRACT={initial_retract:.1f}\n\n")
    return gcode

def generate_wall_smooth_passes(wall_segments, prev_segments, next_segments, current_z, prev_z, layer_idx, accumulated_layers, speed, passes_count, x_plus_power, x_minus_power, overhang_plus_power, overhang_minus_power, angle_tol, is_final_layer=False, force_trigger=False, max_sweep_layers=None, layer_outer_walls_map=None, restore_z=None, reverse_path=False):
    """
    Generate G-code for wall smoothing passes. Handles overhang detection and Deep Mode (multi-Z).
    """
    import math
    gcode = []
    
    if not wall_segments and not prev_segments:
        return gcode
        
    f_val = speed * 60.0
    
    def extract_laser_paths(segments, min_area=0.0):
        if not segments: return []
        paths, _path_is_hole = build_paths_from_segments(segments)
        if reverse_path:
            for i in range(len(paths)):
                paths[i] = [(seg[2], seg[3], seg[0], seg[1]) for seg in reversed(paths[i])]
        paths = split_corners_in_paths(paths, WALL_CORNER_DISTANCE, WALL_CORNER_POWER_DROP, _path_is_hole)
            
        _straight_passes = []
        for path_idx, path in enumerate(paths):
            area_sum = 0.0
            for x1, y1, x2, y2, pwr in path:
                area_sum += (x2 - x1) * (y2 + y1)
            if path:
                x_first, y_first = path[0][0], path[0][1]
                x_last, y_last = path[-1][2], path[-1][3]
                area_sum += (x_first - x_last) * (y_first + y_last)
            
            path_area = abs(area_sum) / 2.0
            if path_area < min_area:
                continue
                
            air_on_right = (not is_ccw) if is_hole else is_ccw
            
            _curr_straight = []
            _curr_straight_laser = None
            
            for seg in path:
                x1, y1, x2, y2 = seg[:4]
                power_scaler = seg[4] if len(seg) > 4 else 1.0
                dx, dy = x2 - x1, y2 - y1
                if dx == 0 and dy == 0: continue
                angle = math.degrees(math.atan2(abs(x2 - x1), abs(dy)))
                if not WALL_DEEP_MODE and angle > angle_tol:
                    if _curr_straight:
                        _straight_passes.append((_curr_straight_laser, _curr_straight, False))
                        _curr_straight = []
                        _curr_straight_laser = None
                    continue
                    
                
                nx = dy
                if nx > abs(x2 - x1) * 0.1:
                    laser_dir = "PLUS"
                elif nx < -abs(x2 - x1) * 0.1:
                    laser_dir = "MINUS"
                else:
                    laser_dir = _curr_straight_laser if _curr_straight_laser else "PLUS"
                    
                shift = WALL_X_PLUS_OFFSET if laser_dir == "PLUS" else WALL_X_MINUS_OFFSET
                nx1, nx2 = x1 + shift, x2 + shift
                
                seg_pwr = x_plus_power if laser_dir == "PLUS" else x_minus_power
                seg_pwr = seg_pwr * power_scaler
                
                if laser_dir == _curr_straight_laser:
                    _curr_straight.append((nx1, y1, nx2, y2, seg_pwr))
                else:
                    if _curr_straight:
                        _straight_passes.append((_curr_straight_laser, _curr_straight, False))
                    _curr_straight = [(nx1, y1, nx2, y2, seg_pwr)]
                    _curr_straight_laser = laser_dir
                    
            if _curr_straight:
                _straight_passes.append((_curr_straight_laser, _curr_straight, False))
                
        return _straight_passes

    
    # 1. Extract contiguous loops/paths from segments
    paths = []
    current_path = []
    for x1, y1, x2, y2 in wall_segments:
        if not current_path:
            current_path.append((x1, y1, x2, y2))
        else:
            last_x2, last_y2 = current_path[-1][2], current_path[-1][3]
            if abs(x1 - last_x2) < 0.5 and abs(y1 - last_y2) < 0.5:
                current_path.append((x1, y1, x2, y2))
            else:
                paths.append(current_path)
                current_path = [(x1, y1, x2, y2)]
    if current_path:
        paths.append(current_path)
        
    # Determine nesting for each path
    path_is_hole = []
    for i, path in enumerate(paths):
        if not path:
            path_is_hole.append(False)
            continue
        pt_x, pt_y = path[0][0], path[0][1]
        contain_count = 0
        for j, other_path in enumerate(paths):
            if i == j: continue
            if is_point_in_path(pt_x, pt_y, other_path):
                contain_count += 1
        path_is_hole.append(contain_count % 2 == 1)
        
    # Split the paths geometry around sharp corners to drop power
    paths = split_corners_in_paths(paths, WALL_CORNER_DISTANCE, WALL_CORNER_POWER_DROP, path_is_hole)
        
    overhang_passes = []   # list of (laser_dir, segment_list, True)
    straight_passes = []   # list of (laser_dir, segment_list, False)
    terminated_passes = [] # list of (laser_dir, segment_list, False) — wall ends here
        
    layer_height = current_z - prev_z if (prev_z is not None and current_z > prev_z) else 0.2
    
    global DEEP_MODE_WARNING_SHOWN
    if WALL_DEEP_MODE:
        max_depth_layers = max(1, WALL_SMOOTH_FREQ) + WALL_DEEP_OVERLAP
        max_drop = max_depth_layers * layer_height
        safety_clearance = WALL_Z_OFFSET - max_drop
        if safety_clearance < 2.0 * layer_height:
            if not DEEP_MODE_WARNING_SHOWN:
                import ctypes
                import sys
                msg = (f"WARNING: Deep Mode Safety Violation!\n\n"
                       f"Z Offset is {WALL_Z_OFFSET:.1f}mm. Max deep mode drop is {max_drop:.2f}mm ({max_depth_layers} layers at {layer_height:.2f}mm).\n"
                       f"This leaves a clearance of {safety_clearance:.2f}mm between the nozzle and the printed part.\n"
                       f"Required clearance is {2.0 * layer_height:.2f}mm (2 layers).\n\n"
                       f"The nozzle might crash into the part!\n"
                       f"Do you want to continue anyway?")
                if False:
                    res = ctypes.windll.user32.MessageBoxW(0, msg, "Deep Mode Collision Warning", 262164)
                    if res == 7:  # IDNO
                        print("User aborted script due to Deep Mode collision warning.")
                        sys.exit(1)
                DEEP_MODE_WARNING_SHOWN = True
                
    threshold_dist = layer_height * math.tan(math.radians(WALL_DEEP_OVERHANG_ANGLE)) if prev_segments else float('inf')
        
    for path_idx, path in enumerate(paths):
        area_sum = 0.0
        for seg in path:
            x1, y1, x2, y2 = seg[:4]
            area_sum += (x2 - x1) * (y2 + y1)
        if path:
            x_first, y_first = path[0][0], path[0][1]
            x_last, y_last = path[-1][2], path[-1][3]
            area_sum += (x_first - x_last) * (y_first + y_last)
        
        # Bug 4 fix: Skip tiny loops (eyes, small features) by area
        # area_sum/2 is the signed area in mm²; WALL_SMOOTH_MIN_PATH_AREA is in mm²
        path_area = abs(area_sum) / 2.0
        if path_area < (0.0 if WALL_DEEP_MODE else WALL_SMOOTH_MIN_PATH_AREA):
            continue


        curr_overhang = []
        curr_straight = []
        curr_terminated = []
        curr_overhang_laser = None
        curr_straight_laser = None
        curr_terminated_laser = None
        
        for seg in path:
            x1, y1, x2, y2 = seg[:4]
            power_scaler = seg[4] if len(seg) > 4 else 1.0
            dx = x2 - x1
            dy = y2 - y1
            if dx == 0 and dy == 0:
                continue
                
            angle = math.degrees(math.atan2(abs(x2 - x1), abs(dy)))
            if not WALL_DEEP_MODE and angle > angle_tol:
                if curr_overhang:
                    overhang_passes.append((curr_overhang_laser, curr_overhang, True))
                    curr_overhang = []
                    curr_overhang_laser = None
                if curr_straight:
                    straight_passes.append((curr_straight_laser, curr_straight, False))
                    curr_straight = []
                    curr_straight_laser = None
                
                continue
                
                
            if abs(dy) < 0.05:
                if curr_straight_laser is not None:
                    laser_dir = curr_straight_laser
                elif curr_overhang_laser is not None:
                    laser_dir = curr_overhang_laser
                elif curr_terminated_laser is not None:
                    laser_dir = curr_terminated_laser
                else:
                    nx = dy
                    if nx > abs(x2 - x1) * 0.1:
                        laser_dir = "PLUS"
                    elif nx < -abs(x2 - x1) * 0.1:
                        laser_dir = "MINUS"
                    else:
                        laser_dir = "PLUS"
            else:
                nx = dy
                if nx > abs(x2 - x1) * 0.1:
                    laser_dir = "PLUS"
                elif nx < -abs(x2 - x1) * 0.1:
                    laser_dir = "MINUS"
                else:
                    laser_dir = curr_straight_laser if curr_straight_laser else (curr_overhang_laser if curr_overhang_laser else (curr_terminated_laser if curr_terminated_laser else "PLUS"))
                
            # Overhang Detection
            # Bug 1/7/8 fix: When prev_segments is empty (Layer 1, or fresh section after gap),
            # treat as a new straight-chunk start, NOT an overhang.
            # is_overhang should only be True when the wall shifts outward past the laser angle.
            is_overhang = False
            min_dx = None
            closest_dist = float('inf')
            
            if WALL_DEEP_MODE and not WALL_DISABLE_OVERHANG and prev_segments:
                mx, my = (x1 + x2) / 2.0, (y1 + y2) / 2.0
                for (px1, py1, px2, py2) in prev_segments:
                    # Find closest point on segment to (mx, my) using 2D projection
                    l2 = (px2 - px1)**2 + (py2 - py1)**2
                    if l2 == 0:
                        t = 0
                    else:
                        t = max(0, min(1, ((mx - px1) * (px2 - px1) + (my - py1) * (py2 - py1)) / l2))
                    proj_x = px1 + t * (px2 - px1)
                    proj_y = py1 + t * (py2 - py1)
                    
                    dist = (mx - proj_x)**2 + (my - proj_y)**2
                    if dist < closest_dist:
                        closest_dist = dist
                        min_dx = mx - proj_x
                
                if closest_dist > 6.25: # If the closest wall below is >2.5mm away, it's an extreme overhang
                    is_overhang = True
                elif min_dx is not None:
                    if laser_dir == "PLUS" and min_dx > threshold_dist:
                        is_overhang = True
                    elif laser_dir == "MINUS" and min_dx < -threshold_dist:
                        is_overhang = True
                        
            # Dynamic power scaling
            segment_power = x_plus_power if laser_dir == "PLUS" else x_minus_power
            if WALL_DEEP_MODE and min_dx is not None and closest_dist <= 6.25:
                # Calculate actual overhang angle
                actual_shift = min_dx if laser_dir == "PLUS" else -min_dx
                if actual_shift > 0:
                    layer_height = current_z - prev_z if current_z > prev_z else 0.2
                    theta = math.degrees(math.atan2(actual_shift, layer_height))
                    
                    if theta >= WALL_DEEP_OVERHANG_ANGLE:
                        segment_power = overhang_plus_power if laser_dir == "PLUS" else overhang_minus_power
                    elif theta > 0:
                        # Linear interpolation
                        base_p = x_plus_power if laser_dir == "PLUS" else x_minus_power
                        target_p = overhang_plus_power if laser_dir == "PLUS" else overhang_minus_power
                        ratio = theta / WALL_DEEP_OVERHANG_ANGLE
                        segment_power = base_p + (target_p - base_p) * ratio
            elif is_overhang:
                segment_power = overhang_plus_power if laser_dir == "PLUS" else overhang_minus_power
                
            segment_power = segment_power * power_scaler
                            
            # Predictive End-of-Section Detection (wall physically ends above current layer)
            # Bug 3 fix: ONLY trigger terminated when wall disappears (has_no_match),
            # NOT when it merely shifts laterally. Normal taper and curve should not break chunks.
            is_terminated = False
            if WALL_DEEP_MODE and not is_overhang and not is_final_layer and next_segments:
                mx, my = (x1 + x2) / 2.0, (y1 + y2) / 2.0
                has_any_match = False
                
                # Only check if there's any wall within 2.5mm in next layer (wall end detection)
                for (nx1, ny1, nx2, ny2) in next_segments:
                    nmx, nmy = (nx1 + nx2) / 2.0, (ny1 + ny2) / 2.0
                    if (nmx - mx)**2 + (nmy - my)**2 < 6.25: # 2.5mm threshold
                        has_any_match = True
                        break
                            
                if not has_any_match:
                    # Wall truly ends here (top of section, not just a shift)
                    is_terminated = True
                    seg_len = math.hypot(x2 - x1, y2 - y1)
                    if seg_len < 4.0:
                        is_terminated = False
            
            shift = WALL_X_PLUS_OFFSET if laser_dir == "PLUS" else WALL_X_MINUS_OFFSET
            nx1 = x1 + shift
            nx2 = x2 + shift
            
            if is_overhang:
                if laser_dir == curr_overhang_laser:
                    curr_overhang.append((nx1, y1, nx2, y2, segment_power))
                else:
                    if curr_overhang:
                        overhang_passes.append((curr_overhang_laser, curr_overhang, True))
                    curr_overhang = [(nx1, y1, nx2, y2, segment_power)]
                    curr_overhang_laser = laser_dir
            elif is_terminated:
                if laser_dir == curr_terminated_laser:
                    curr_terminated.append((nx1, y1, nx2, y2, segment_power))
                else:
                    if curr_terminated:
                        terminated_passes.append((curr_terminated_laser, curr_terminated, False))
                    curr_terminated = [(nx1, y1, nx2, y2, segment_power)]
                    curr_terminated_laser = laser_dir
            else:
                if laser_dir == curr_straight_laser:
                    curr_straight.append((nx1, y1, nx2, y2, segment_power))
                else:
                    if curr_straight:
                        straight_passes.append((curr_straight_laser, curr_straight, False))
                    curr_straight = [(nx1, y1, nx2, y2, segment_power)]
                    curr_straight_laser = laser_dir
                    
        if curr_overhang:
            overhang_passes.append((curr_overhang_laser, curr_overhang, True))
        if curr_straight:
            straight_passes.append((curr_straight_laser, curr_straight, False))
        if curr_terminated:
            terminated_passes.append((curr_terminated_laser, curr_terminated, False))
            
    # 3. Create Z-batches
    z_batches = []
    
    def get_z_offsets_for_layers(num_layers, safety_layers=0):
        # Add configurable layer overlap for multi-layer paths to smooth the seam
        overlap_layers = WALL_DEEP_OVERLAP if num_layers > 1 else 0
        total_layers = num_layers + overlap_layers
        
        total_divs = total_layers * max(1, WALL_Z_DIVISIONS)
        safety_divs = safety_layers * max(1, WALL_Z_DIVISIONS)
        
        step = layer_height / max(1, WALL_Z_DIVISIONS)
        offsets = []
        
        # Process from TOP to BOTTOM (smallest Z-drop to largest Z-drop)
        # Shift everything down by safety_divs
        for i in range(1, total_divs + 1):
            offsets.append((safety_divs + i - 1) * step)
            
        if getattr(args, 'wall_deep_bottom_up', False):
            offsets.reverse()
            
        if getattr(args, 'wall_deep_interlace', False):
            half = (len(offsets) + 1) // 2
            interlaced = []
            for i in range(half):
                interlaced.append(offsets[i])
                if i + half < len(offsets):
                    interlaced.append(offsets[i + half])
            offsets = interlaced
            
        return offsets

    if WALL_DEEP_MODE:
        # Overhangs processed EVERY layer (1 layer height)
        if overhang_passes:
            for offset in get_z_offsets_for_layers(1, safety_layers=0):
                tz = current_z - offset
                if tz > 0.05:
                    z_batches.append( (tz, overhang_passes) )
            
        # Straight segments processed every FREQ layers with multiple Z drops
        remainder = accumulated_layers % max(1, WALL_SMOOTH_FREQ)
        should_trigger = (remainder == 0 and accumulated_layers > 0) or is_final_layer or force_trigger
        if straight_passes and should_trigger:
            layers_to_sweep = accumulated_layers
            if layer_idx > accumulated_layers:
                layers_to_sweep += WALL_DEEP_SAFETY
                
            # Bug 5 fix: Cap sweep depth at the max safe depth (stops laser going past overhangs below)
            if max_sweep_layers is not None:
                layers_to_sweep = min(layers_to_sweep, max_sweep_layers)
                
            # No safety offset needed on final layer since printhead is moving away
            safety = 0 if is_final_layer else WALL_DEEP_SAFETY
            for offset in get_z_offsets_for_layers(layers_to_sweep, safety_layers=safety):
                tz = current_z - offset
                if tz > 0.05:
                    target_layer_idx = layer_idx - round(offset / layer_height)
                    if target_layer_idx < 1:
                        target_layer_idx = 1
                    target_passes = straight_passes
                    if layer_outer_walls_map and target_layer_idx in layer_outer_walls_map:
                        target_segs = layer_outer_walls_map[target_layer_idx]
                        if target_segs:
                            target_passes = extract_laser_paths(target_segs, min_area=0.0)
                    if target_passes:
                        z_batches.append( (tz, target_passes) )
                    
        # (Duplicate z_batch block removed — was re-adding straight_passes with safety_layers=0,
        #  creating unwanted extra strokes in the safety zone near the nozzle.)
                
    if not z_batches:
        return gcode
    mode_str = f"DeepMode:{WALL_DEEP_MODE}"
    if WALL_MODE_PASS1 == 'wobble' or WALL_MODE_PASS2 == 'wobble':
        mode_str += " - Wobble"
    gcode.append(f"\n; == [Wall Smooth] Start (Layer {layer_idx}) - {mode_str} ==\n")
    gcode.append("G91 ; relative\n")
    initial_retract = min(WALL_RETRACT, WALL_MAX_RETRACT)
    gcode.append(f"G1 E-{initial_retract:.1f} F2400 ; [Wall Smooth] batch retract\n")
    gcode.append("G90 ; absolute\n")
    
    if WALL_DEEP_MODE and WALL_STANDBY_TEMP_DROP > 0 and CURRENT_PRINT_TEMP > 0:
        target_temp = max(0, CURRENT_PRINT_TEMP - WALL_STANDBY_TEMP_DROP)
        gcode.append(f"M104 S{target_temp} ; [Wall Smooth] Standby temp drop\n")
        if ENABLE_PURGE:
            gcode.append(f"G0 Z{current_z + 2.8:.3f} F600 ; z-hop for travel to purge bucket\n")
            gcode.append(f"G0 X{PURGE_X:.3f} Y{PURGE_Y:.3f} F6000 ; move to purge bucket for cooldown\n")
            gcode.append("M106 S255 ; blast fan to cool nozzle faster\n")
            gcode.append("G4 P10000 ; dwell 10 seconds\n")
            gcode.append("M107 ; shut off fan during smoothing\n")
            gcode.append(f"G0 Z{current_z:.3f} F600 ; return to sweep Z height\n")
        else:
            gcode.append("M106 S255 ; blast fan to cool nozzle faster\n")
            gcode.append("G4 P10000 ; dwell 10 seconds\n")
            gcode.append("M107 ; shut off fan during smoothing\n")
    
    total_retracted = initial_retract
    loop_count = 0
    
    def do_extra_retract():
        nonlocal loop_count, total_retracted
        loop_count += 1
        if loop_count > 1 and total_retracted < WALL_MAX_RETRACT:
            retract_amt = min(3.0, WALL_MAX_RETRACT - total_retracted)
            total_retracted += retract_amt
            gcode.append("G91\n")
            gcode.append(f"G1 E-{retract_amt:.1f} F2400 ; [Wall Smooth] Extra progressive retract\n")
            gcode.append("G90\n")
    
    gcode.append("G90 ; absolute\n")
    total_z_batches = len(z_batches)
    
    # Flatten loop into an ordered list of (pass_idx, batch_idx, target_z_base, passes, pass_type)
    iteration_order = []
    if WALL_DEEP_DELAY_PASSES:
        for pass_idx in range(passes_count):
            for batch_idx, (target_z_base, passes) in enumerate(z_batches):
                iteration_order.append((pass_idx, batch_idx, target_z_base, passes, 1))
    else:
        for batch_idx, (target_z_base, passes) in enumerate(z_batches):
            for pass_idx in range(passes_count):
                iteration_order.append((pass_idx, batch_idx, target_z_base, passes, 1))
                
    last_emitted_z = None
    last_ex = None
    last_ey = None

    for pass_idx, batch_idx, target_z_base, passes, pass_type in iteration_order:
        target_z = target_z_base + WALL_Z_OFFSET
        
        # Calculate fade multiplier based on batch_idx (depth)
        if total_z_batches > 1 and WALL_DEEP_FADE != 100.0:
            fade_target = max(0.0, min(100.0, WALL_DEEP_FADE)) / 100.0
            progress = batch_idx / (total_z_batches - 1)
            fade_multiplier = 1.0 - (1.0 - fade_target) * progress
        else:
            fade_multiplier = 1.0
            
        if last_emitted_z is None or abs(last_emitted_z - target_z) > 0.001:
            gcode.append(f"G0 Z{target_z:.3f} F600 ; [Wall Smooth] Z offset up for Z-Base {target_z_base:.3f} (Fade: {fade_multiplier*100:.0f}%)\n")
            last_emitted_z = target_z
            # Break continuous path assumption to ensure safe travel on new Z height
            last_ex = None
            last_ey = None
            
        def merge_passes_list(plist):
            if not plist: return []
            merged = []
            for l_dir, segs, is_over in plist:
                if not segs: continue
                did_merge = False
                for i, (m_dir, m_segs, m_over) in enumerate(merged):
                    if m_dir == l_dir and m_over == is_over:
                        if math.hypot(segs[0][0] - m_segs[-1][2], segs[0][1] - m_segs[-1][3]) < 2.0:
                            m_segs.extend(segs)
                            did_merge = True
                            break
                        elif math.hypot(segs[-1][2] - m_segs[0][0], segs[-1][3] - m_segs[0][1]) < 2.0:
                            merged[i] = (m_dir, segs + m_segs, m_over)
                            did_merge = True
                            break
                if not did_merge:
                    merged.append((l_dir, list(segs), is_over))
            # Second pass to connect the loop if it was split at the seam
            final_merged = []
            for l_dir, segs, is_over in merged:
                did_merge = False
                for i, (m_dir, m_segs, m_over) in enumerate(final_merged):
                    if m_dir == l_dir and m_over == is_over:
                        if math.hypot(segs[0][0] - m_segs[-1][2], segs[0][1] - m_segs[-1][3]) < 2.0:
                            m_segs.extend(segs)
                            did_merge = True
                            break
                        elif math.hypot(segs[-1][2] - m_segs[0][0], segs[-1][3] - m_segs[0][1]) < 2.0:
                            final_merged[i] = (m_dir, segs + m_segs, m_over)
                            did_merge = True
                            break
                if not did_merge:
                    final_merged.append((l_dir, segs, is_over))
            return final_merged

        len_before = len(passes)
        passes = merge_passes_list(passes)
            
        for laser_dir, segments, is_overhang_type in passes:
            pwm_pin = "laser_pwm1" if laser_dir == "PLUS" else "laser_pwm2"
            
            # Select settings based on pass_type
            if pass_type == 2:
                eff_speed = WALL_DEEP_SECOND_SPEED if WALL_DEEP_SECOND_SPEED is not None else speed
            else:
                eff_speed = speed
                
            f_val = eff_speed * 60.0
            
            # 1. Closed loop check
            is_closed_loop = False
            if len(segments) > 2:
                sx, sy = segments[0][0], segments[0][1]
                end_x, end_y = segments[-1][2], segments[-1][3]
                path_len = sum(math.hypot(s[2]-s[0], s[3]-s[1]) for s in segments)
                h_val = math.hypot(end_x - sx, end_y - sy)
                if path_len > 5.0 and h_val < 1.0:
                    is_closed_loop = True
                    
            # 2. Start Coordinates and Overshoot
            sx, sy = segments[0][0], segments[0][1]
            if WALL_OVERSHOOT > 0 and not is_closed_loop:
                dx = segments[0][2] - segments[0][0]
                dy = segments[0][3] - segments[0][1]
                length = math.hypot(dx, dy)
                if length > 0.001:
                    sx = sx - (dx / length) * WALL_OVERSHOOT
                    sy = sy - (dy / length) * WALL_OVERSHOOT
                    
            # 3. Retract and Initial G0 Move
            do_extra_retract()
            
            if pass_idx > 0 or (last_ex is not None and last_ey is not None):
                if last_ex is not None and last_ey is not None:
                    dist_back = math.hypot(sx - last_ex, sy - last_ey)
                    if dist_back > 0.05:
                        do_extra_retract()
                        gcode.append(f"G0 X{sx:.3f} Y{sy:.3f} F6000\n")
                    else:
                        gcode.append(f"G1 X{sx:.3f} Y{sy:.3f} F6000\n")
                else:
                    gcode.append(f"G0 X{sx:.3f} Y{sy:.3f} F6000\n")
            else:
                gcode.append(f"G0 X{sx:.3f} Y{sy:.3f} F6000\n")
                
            # 4. Execute all segments except the last one
            curr_dynamic_power = None
            
            for nx1, ny1, nx2, ny2, seg_pwr in segments[:-1]:
                # Override power if second pass
                if pass_type == 2:
                    if is_overhang_type:
                        seg_pwr = WALL_DEEP_SECOND_OVERHANG_POWER_PLUS if laser_dir == "PLUS" else WALL_DEEP_SECOND_OVERHANG_POWER_MINUS
                    else:
                        seg_pwr = WALL_DEEP_SECOND_POWER_PLUS if laser_dir == "PLUS" else WALL_DEEP_SECOND_POWER_MINUS
                    if seg_pwr is None: seg_pwr = 0.0
                else:
                    seg_pwr *= fade_multiplier
                    
                if seg_pwr < 0.01:
                    if curr_dynamic_power is not None and curr_dynamic_power >= 0.01:
                        gcode.append(f"SET_PIN PIN={pwm_pin} VALUE=0\n")
                    curr_dynamic_power = 0.0
                else:
                    if curr_dynamic_power != seg_pwr:
                        gcode.append(f"SET_PIN PIN={pwm_pin} VALUE={seg_pwr:.3f} ; L{layer_idx} PT{pass_type}\n")
                        curr_dynamic_power = seg_pwr
                gcode.append(f"G1 X{nx2:.3f} Y{ny2:.3f} F{f_val:.0f}\n")
                
            # 5. Execute Last segment and End Overshoot
            ex, ey = segments[-1][2], segments[-1][3]
            last_seg_pwr = segments[-1][4]
            
            if pass_type == 2:
                if is_overhang_type:
                    last_seg_pwr = WALL_DEEP_SECOND_OVERHANG_POWER_PLUS if laser_dir == "PLUS" else WALL_DEEP_SECOND_OVERHANG_POWER_MINUS
                else:
                    last_seg_pwr = WALL_DEEP_SECOND_POWER_PLUS if laser_dir == "PLUS" else WALL_DEEP_SECOND_POWER_MINUS
                if last_seg_pwr is None: last_seg_pwr = 0.0
            else:
                last_seg_pwr *= fade_multiplier

            if WALL_OVERSHOOT > 0 and not is_closed_loop:
                dx = segments[-1][2] - segments[-1][0]
                dy = segments[-1][3] - segments[-1][1]
                length = math.hypot(dx, dy)
                if length > 0.001:
                    ex = ex + (dx / length) * WALL_OVERSHOOT
                    ey = ey + (dy / length) * WALL_OVERSHOOT
                    
            if last_seg_pwr < 0.01:
                if curr_dynamic_power is not None and curr_dynamic_power >= 0.01:
                    gcode.append(f"SET_PIN PIN={pwm_pin} VALUE=0\n")
            else:
                if curr_dynamic_power != last_seg_pwr:
                    gcode.append(f"SET_PIN PIN={pwm_pin} VALUE={last_seg_pwr:.3f} ; L{layer_idx} PT{pass_type}\n")
                    
            gcode.append(f"G1 X{ex:.3f} Y{ey:.3f} F{f_val:.0f}\n")
            gcode.append(f"SET_PIN PIN={pwm_pin} VALUE=0\n")
                
            last_ex = ex
            last_ey = ey
                
    restore_val = current_z if restore_z is None else restore_z
    # Return to layer Z so subsequent passes can correctly position themselves
    gcode.append(f"G0 Z{restore_val:.3f} F600\n")
    
    if WALL_DEEP_MODE and WALL_STANDBY_TEMP_DROP > 0 and CURRENT_PRINT_TEMP > 0:
        gcode.append(f"M109 S{CURRENT_PRINT_TEMP} ; [Wall Smooth] Restore print temp and wait\n")
        
    # Leave extruder retracted, we will handle the prime/purge next
    gcode.append(f"; == [Wall Smooth] End == RETRACT={total_retracted:.1f}\n\n")
    return gcode

def generate_laser_rivets(bbox, cx, cy, angle_deg, power, dwell_ms, z_hop, spacing, laser_pin="laser_pwm1", offset_x=0.0, offset_y=0.0, fan_speed=0, wobble_radius=0.0, wobble_turns=1, wobble_max_speed=250.0, pulse_period=0, pulse_duty=0.5, cluster=None, boolean_res=0.2, wall_expansion=0.45):
    """
    Generate G-code for stationary laser pulses (rivets) over a bounding box.
    Supports continuous wobble, stationary pulsing, or combined dashed-circle wobble.
    """
    min_x, min_y, max_x, max_y = bbox
    gcode = []
    
    bool_grid = None
    res = boolean_res
    if cluster and len(cluster) > 0:
        bool_grid = build_boolean_grid(cluster, res, max_dist=wall_expansion)
    
    import math
    rad = math.radians(angle_deg)
    cos_a = math.cos(rad)
    sin_a = math.sin(rad)

    def rot(lx, ly):
        nx = cos_a * lx - sin_a * ly + cx
        ny = sin_a * lx + cos_a * ly + cy
        return nx, ny

    # Bounds check function
    def validate_bounds(tx, ty):
        if not (X_MIN <= tx <= X_MAX and Y_MIN <= ty <= Y_MAX):
            raise ValueError(
                f"\n\n======================================================\n"
                f"ERROR: Rivet path exceeds motion limits!\n"
                f"Target position X:{tx:.2f}, Y:{ty:.2f} is out of bounds.\n"
                f"Motion limits -> X:[{X_MIN}, {X_MAX}], Y:[{Y_MIN}, {Y_MAX}]\n"
                f"This happened because of the laser offset (X:{offset_x}, Y:{offset_y}).\n"
                f"Please move your part closer to the center of the build plate.\n"
                f"======================================================\n"
            )

    gcode.append(f"\n; == [Rivet] Start - Spacing {spacing}mm, Power {power}, Dwell {dwell_ms}ms ==\n")
    if pulse_period > 0:
        gcode.append(f"; [Rivet] Pulsing enabled: {pulse_period}ms period, {pulse_duty} duty cycle\n")
    if wobble_radius > 0:
        gcode.append(f"; [Rivet] Wobble enabled: {wobble_radius}mm radius\n")
    
    # -- Retract and Z-hop --
    gcode.append(f"SET_PIN PIN=laser_pwm1 VALUE=0\nSET_PIN PIN=laser_pwm2 VALUE=0\nSET_PIN PIN=laser_pwm3 VALUE=0 ; [Rivet] safety off\n")
    gcode.append("G91 ; relative\n")
    gcode.append("G1 E-5.0 F2400 ; [Rivet] retract\n")
    gcode.append(f"G1 Z{z_hop:.2f} F600 ; [Rivet] Z hop\n")
    gcode.append("G90 ; absolute\n")
    if fan_speed > 0:
        gcode.append(f"M106 S{int(fan_speed)} ; [Rivet] Set fan speed\n")
    
    count = 0
    width = max_x - min_x
    height = max_y - min_y
    
    nx = max(1, int((width + 0.001) // spacing) + 1)
    ny = max(1, int((height + 0.001) // spacing) + 1)
    
    start_x = min_x + (width - (nx - 1) * spacing) / 2.0
    start_y = min_y + (height - (ny - 1) * spacing) / 2.0
    
    for j in range(ny):
        y = start_y + j * spacing
        for i in range(nx):
            x = start_x + i * spacing
            rx, ry = rot(x, y)
            
            if bool_grid:
                if (int(rx / res), int(ry / res)) not in bool_grid:
                    x += spacing
                    continue
                    
            tx, ty = rx + offset_x, ry + offset_y
            validate_bounds(tx, ty)
            
            # Move to rivet center
            gcode.append(f"G0 X{tx:.3f} Y{ty:.3f} F6000 ; [Rivet] move to position\n")
            gcode.append("M400 ; Wait for moves to finish before firing\n")
            
            if wobble_radius > 0 and pulse_period == 0:
                # Scenario B: Wobble Only (Continuous Laser)
                actual_turns = wobble_turns
                perimeter = 2 * math.pi * wobble_radius * actual_turns
                feedrate = (perimeter / (dwell_ms / 1000.0)) * 60.0
                
                if feedrate > wobble_max_speed * 60.0:
                    actual_turns = (wobble_max_speed * (dwell_ms / 1000.0)) / (2 * math.pi * wobble_radius)
                    feedrate = wobble_max_speed * 60.0
                
                total_angle = 2 * math.pi * actual_turns
                total_edges = max(1, int(math.ceil(8 * actual_turns)))
                
                # Move to start of path
                sx = tx + wobble_radius
                sy = ty
                gcode.append(f"G0 X{sx:.3f} Y{sy:.3f} F6000\n")
                gcode.append(f"SET_PIN PIN={laser_pin} VALUE={power:.3f} ; [Rivet] ON\n")
                
                for i in range(1, total_edges + 1):
                    angle = i * (total_angle / total_edges)
                    px = tx + wobble_radius * math.cos(angle)
                    py = ty + wobble_radius * math.sin(angle)
                    gcode.append(f"G1 X{px:.3f} Y{py:.3f} F{feedrate:.1f}\n")
                
                gcode.append(f"SET_PIN PIN={laser_pin} VALUE=0 ; [Rivet] OFF\n")
                
            elif wobble_radius == 0 and pulse_period > 0:
                # Scenario A: Pulsing Only (Stationary)
                cycles = max(1, int(dwell_ms / pulse_period))
                on_time = int(pulse_period * pulse_duty)
                off_time = int(pulse_period * (1.0 - pulse_duty))
                for _ in range(cycles):
                    gcode.append(f"SET_PIN PIN={laser_pin} VALUE={power:.3f}\n")
                    gcode.append(f"G4 P{on_time}\n")
                    gcode.append(f"SET_PIN PIN={laser_pin} VALUE=0\n")
                    gcode.append(f"G4 P{off_time}\n")
                    
            elif wobble_radius > 0 and pulse_period > 0:
                # Scenario C: Pulsing + Wobble (Dashed Circle)
                actual_turns = wobble_turns
                perimeter = 2 * math.pi * wobble_radius * actual_turns
                feedrate = (perimeter / (dwell_ms / 1000.0)) * 60.0
                
                if feedrate > wobble_max_speed * 60.0:
                    actual_turns = (wobble_max_speed * (dwell_ms / 1000.0)) / (2 * math.pi * wobble_radius)
                    feedrate = wobble_max_speed * 60.0
                
                total_angle = 2 * math.pi * actual_turns
                cycles = max(1, int(dwell_ms / pulse_period))
                edges = min(cycles, max(1, int(50 * actual_turns))) # Cap edges to protect buffer
                
                sx = tx + wobble_radius
                sy = ty
                gcode.append(f"G0 X{sx:.3f} Y{sy:.3f} F6000\n")
                
                for i in range(1, edges + 1):
                    # Each edge corresponds to one pulse period
                    # Start angle
                    a1 = (i - 1) * (total_angle / edges)
                    # End angle
                    a2 = i * (total_angle / edges)
                    # Mid angle (where the laser turns off based on duty cycle)
                    mid_angle = a1 + (a2 - a1) * pulse_duty
                    
                    mx = tx + wobble_radius * math.cos(mid_angle)
                    my = ty + wobble_radius * math.sin(mid_angle)
                    
                    ex = tx + wobble_radius * math.cos(a2)
                    ey = ty + wobble_radius * math.sin(a2)
                    
                    gcode.append(f"SET_PIN PIN={laser_pin} VALUE={power:.3f}\n")
                    gcode.append(f"G1 X{mx:.3f} Y{my:.3f} F{feedrate:.1f}\n")
                    gcode.append(f"SET_PIN PIN={laser_pin} VALUE=0\n")
                    gcode.append(f"G1 X{ex:.3f} Y{ey:.3f} F{feedrate:.1f}\n")
                    
            else:
                # Original Stationary
                gcode.append(f"SET_PIN PIN={laser_pin} VALUE={power:.3f} ; [Rivet] ON\n")
                gcode.append(f"G4 P{int(dwell_ms)} ; [Rivet] Dwell\n")
                gcode.append(f"SET_PIN PIN={laser_pin} VALUE=0 ; [Rivet] OFF\n")
            
            count += 1


    # -- Undo Z-hop and unretract --
    if fan_speed > 0:
        gcode.append(f"M107 ; [Rivet] Turn off fan\n")
    gcode.append("G91 ; relative\n")
    gcode.append(f"G1 Z-{z_hop:.2f} F600 ; [Rivet] undo Z hop\n")
    gcode.append(f"G1 E5.0 F2400 ; [Rivet] unretract\n")
    gcode.append("G90 ; absolute\n")
    
    gcode.append(f"; == [Rivet] End - {count} rivets placed ==\n\n")
    
    return gcode


def generate_laser_connectivity(bbox, cx, cy, power, speed, z_hop, laser_pin="laser_pwm3", offset_x=0.0, offset_y=0.0, fan_speed=0, pass2_power=0.0, pass2_speed=0.0, passes=2, num_sublines=3, subline_spacing=0.2):
    """
    Generate G-code for connectivity/cabling trace lines over a bounding box.
    Creates `num_sublines` parallel trace lines (default 3, spaced by subline_spacing 0.2mm)
    to form a thick, easily probeable conductive line. Each sub-line executes `passes` passes.
    """
    min_x, min_y, max_x, max_y = bbox
    gcode = []
    
    tx1 = min_x + cx + offset_x
    tx2 = max_x + cx + offset_x
    cy_base = (min_y + max_y)/2.0 + cy + offset_y
    
    f_val = speed * 60.0
    f_val2 = (pass2_speed if pass2_speed > 0 else speed) * 60.0
    p2 = pass2_power if pass2_power > 0 else (power * 0.5)
    
    gcode.append(f"; == [Connectivity] Start ({num_sublines} sub-lines, spacing {subline_spacing}mm) - Power {power:.3f}, Speed {speed}mm/s ==\n")
    gcode.append(f"SET_PIN PIN=laser_pwm1 VALUE=0\nSET_PIN PIN=laser_pwm2 VALUE=0\nSET_PIN PIN=laser_pwm3 VALUE=0\n")
    gcode.append("G91\nG1 E-5.0 F2400\n")
    gcode.append(f"G1 Z{z_hop:.2f} F600\nG90\n")
    if fan_speed > 0:
        gcode.append(f"M106 S{int(fan_speed)}\n")
        
    # Calculate Y offsets for sub-lines (centered around cy_base)
    half_count = (num_sublines - 1) / 2.0
    y_offsets = [(i - half_count) * subline_spacing for i in range(num_sublines)]
    
    for sub_idx, y_off in enumerate(y_offsets):
        ty = cy_base + y_off
        gcode.append(f"; [Connectivity] Sub-line {sub_idx+1}/{num_sublines} at Y={ty:.3f}\n")
        
        # Move to start of sub-line
        gcode.append(f"G0 X{tx1:.3f} Y{ty:.3f} F6000\n")
        gcode.append(f"SET_PIN PIN={laser_pin} VALUE={power:.3f} ; Pass 1 ON\n")
        gcode.append(f"G1 X{tx2:.3f} Y{ty:.3f} F{f_val:.0f}\n")
        gcode.append(f"SET_PIN PIN={laser_pin} VALUE=0 ; Pass 1 OFF\n")
        
        if passes >= 2:
            gcode.append(f"SET_PIN PIN={laser_pin} VALUE={p2:.3f} ; Pass 2 ON (Graphitize)\n")
            gcode.append(f"G1 X{tx1:.3f} Y{ty:.3f} F{f_val2:.0f}\n")
            gcode.append(f"SET_PIN PIN={laser_pin} VALUE=0 ; Pass 2 OFF\n")
            
    gcode.append(f"G91\nG1 Z-{z_hop:.2f} F600\nG1 E5.0 F2400\nG90\n")
    if fan_speed > 0:
        gcode.append("M107\n")
    gcode.append("; == [Connectivity] End ==\n\n")
    return gcode



# ═════════════════════════════════════════════════════════════════════
#  MAIN PROCESSING FUNCTION
# ═════════════════════════════════════════════════════════════════════


def will_laser_resume_shortly(start_idx, current_x, current_y, current_type, lines, preheat_types):
    look_cx, look_cy = current_x, current_y
    travel_dist = 0.0
    look_type = current_type
    import re
    import math
    for look_idx in range(start_idx, len(lines)):
        look_l = lines[look_idx].strip()
        if look_l.startswith(';TYPE:'):
            look_type = look_l.split(':')[1].strip()
            continue
        if look_l.startswith('G1 ') or look_l.startswith('G0 '):
            lx, ly, le = None, None, None
            mx = re.search(r'X\s*([-+]?\d*\.?\d+)', look_l)
            my = re.search(r'Y\s*([-+]?\d*\.?\d+)', look_l)
            me = re.search(r'E\s*([-+]?\d*\.?\d+)', look_l)
            if mx: lx = float(mx.group(1))
            if my: ly = float(my.group(1))
            if me: le = float(me.group(1))

            nx = lx if lx is not None else look_cx
            ny = ly if ly is not None else look_cy
            
            # Check for extrusion FIRST to avoid adding extrusion length to travel_dist
            if le is not None and le > 0:
                if look_type in preheat_types:
                    return True
                return False
                
            # If not extrusion, it is travel. Add distance.
            if look_cx is not None and look_cy is not None and nx is not None and ny is not None:
                travel_dist += math.hypot(nx - look_cx, ny - look_cy)
                
            if travel_dist > 3.0:
                return False
                
            look_cx, look_cy = nx, ny
    return False

def extract_outer_walls(lines):
    import math
    def linearize_arc(x_start, y_start, x_end, y_end, i, j, is_cw, segments=6):
        cx, cy = x_start + i, y_start + j
        r = math.hypot(i, j)
        if r < 0.001: return []
        start_angle = math.atan2(y_start - cy, x_start - cx)
        end_angle = math.atan2(y_end - cy, x_end - cx)
        if is_cw:
            while end_angle > start_angle: end_angle -= 2*math.pi
        else:
            while end_angle < start_angle: end_angle += 2*math.pi
        pts = []
        for step in range(1, segments + 1):
            a = start_angle + (end_angle - start_angle) * step / segments
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        return pts

    layer_walls = {}
    curr_x, curr_y = None, None
    is_abs = True
    in_outer_wall = False
    current_layer = 0
    for line in lines:
        stripped = line.strip()
        if 'G90' in stripped: is_abs = True
        if 'G91' in stripped: is_abs = False
        if stripped.startswith(';LAYER:'):
            try:
                current_layer = int(stripped.split(':')[1])
            except:
                pass
            if current_layer not in layer_walls:
                layer_walls[current_layer] = []
        elif stripped == ';TYPE:Outer wall':
            in_outer_wall = True
        elif stripped.startswith(';TYPE:'):
            in_outer_wall = False
            
        if stripped.startswith('G0 ') or stripped.startswith('G1 ') or stripped.startswith('G2 ') or stripped.startswith('G3 '):
            clean_line = stripped.split(';')[0] if ';' in stripped else stripped
            parts = clean_line.split()
            nx, ny, ne = curr_x, curr_y, False
            ni, nj = 0.0, 0.0
            is_arc = stripped.startswith('G2 ') or stripped.startswith('G3 ')
            is_cw = stripped.startswith('G2 ')
            for p in parts:
                if p.startswith('X'): nx = float(p[1:]) if is_abs else (curr_x + float(p[1:]) if curr_x else None)
                elif p.startswith('Y'): ny = float(p[1:]) if is_abs else (curr_y + float(p[1:]) if curr_y else None)
                elif p.startswith('I'): ni = float(p[1:])
                elif p.startswith('J'): nj = float(p[1:])
                elif p.startswith('E'): ne = True
            
            if in_outer_wall and ne and curr_x is not None and curr_y is not None:
                if nx is not None and ny is not None:
                    if not (nx == curr_x and ny == curr_y):
                        if is_arc:
                            arc_pts = linearize_arc(curr_x, curr_y, nx, ny, ni, nj, is_cw, segments=6)
                            last_pt_x, last_pt_y = curr_x, curr_y
                            for (apx, apy) in arc_pts:
                                layer_walls[current_layer].append((last_pt_x, last_pt_y, apx, apy))
                                last_pt_x, last_pt_y = apx, apy
                        else:
                            layer_walls[current_layer].append((curr_x, curr_y, nx, ny))
            curr_x, curr_y = nx, ny
    return layer_walls

def extract_top_surfaces(lines):
    import math
    layer_tops = {}
    curr_x, curr_y = None, None
    is_abs = True
    current_type = None
    current_layer = -1
    for line in lines:
        stripped = line.strip()
        if 'G90' in stripped: is_abs = True
        elif 'G91' in stripped: is_abs = False
        elif stripped.startswith(';LAYER:'):
            try: current_layer = int(stripped.split(':')[1])
            except: pass
            if current_layer not in layer_tops:
                layer_tops[current_layer] = []
        elif stripped.startswith(';TYPE:'):
            current_type = stripped.split(':')[1]
            
        if stripped.startswith('G0 ') or stripped.startswith('G1 '):
            clean_line = stripped.split(';')[0]
            parts = clean_line.split()
            nx, ny, ne = curr_x, curr_y, False
            for p in parts:
                if p.startswith('X'): nx = float(p[1:]) if is_abs else (curr_x + float(p[1:]) if curr_x else None)
                elif p.startswith('Y'): ny = float(p[1:]) if is_abs else (curr_y + float(p[1:]) if curr_y else None)
                elif p.startswith('E'): ne = True
                
            if current_type == "Top surface" and ne and curr_x is not None and curr_y is not None and nx is not None and ny is not None:
                dist = math.hypot(nx - curr_x, ny - curr_y)
                if dist > 0.2:
                    steps = int(dist / 0.2)
                    for step_i in range(1, steps + 1):
                        px = curr_x + (nx - curr_x) * (step_i / steps)
                        py = curr_y + (ny - curr_y) * (step_i / steps)
                        layer_tops[current_layer].append((px, py))
                else:
                    layer_tops[current_layer].append((nx, ny))
            curr_x, curr_y = nx, ny
    return layer_tops

def process_gcode(file_path, args=None):
    with open(file_path, "r", encoding="latin1") as f:
        lines = f.readlines()
        
    layer_outer_walls_map = extract_outer_walls(lines)
    layer_top_surfaces_map = extract_top_surfaces(lines)
    max_layer_global = max(layer_outer_walls_map.keys()) if layer_outer_walls_map else 0

    global PREHEAT_POWER, SMOOTH_POWER, ANNEAL_POWER, RIVET_POWER, RIVET_TIME, WALL_DEEP_IGNORE_OVERHANG_LENGTH

    out_lines = []
    
    if args is not None:
        import json
        settings_dict = vars(args)
        out_lines.append(f"; LASER_SETTINGS: {json.dumps(settings_dict)}\n")

    
    # ── Tracking state ──
    current_layer = -1
    current_z = 0.0
    unswept_layers = []
    layer_z_map = {}
    current_type = None
    current_x = None
    current_y = None
    current_f = None
    is_preheat_on = False
    last_pwm1 = 0.0
    last_pwm2 = 0.0
    warning_shown = False
    delayed_deep_passes_queue = []
    delayed_deep_passes_trigger_layer = -1
    last_chunk_end_layer = -1
    chunk_start_segments = []

    def apply_sweep(z):
        global PREHEAT_POWER, SMOOTH_POWER, ANNEAL_POWER, RIVET_POWER, RIVET_TIME, WALL_DEEP_IGNORE_OVERHANG_LENGTH
        if not SWEEP_FEATURE:
            return
        z_clamped = max(SWEEP_START_Z, min(SWEEP_END_Z, z))
        if SWEEP_END_Z <= SWEEP_START_Z:
            ratio = 1.0
        else:
            ratio = (z_clamped - SWEEP_START_Z) / (SWEEP_END_Z - SWEEP_START_Z)
        val = SWEEP_START_VAL + ratio * (SWEEP_END_VAL - SWEEP_START_VAL)
        
        if SWEEP_FEATURE == "preheat-power":
            PREHEAT_POWER = val
        elif SWEEP_FEATURE == "smooth-power":
            SMOOTH_POWER = val
        elif SWEEP_FEATURE == "anneal-power":
            ANNEAL_POWER = val
        elif SWEEP_FEATURE == "rivet-power":
            RIVET_POWER = val
        elif SWEEP_FEATURE == "rivet-time":
            RIVET_TIME = int(val)

    # Points collected for end-of-layer passes
    top_surface_points = []   # (x, y) coords printed as "Top surface"
    layer_points = []         # (x, y) coords of all extrusion moves on this layer
    solid_points = []         # (x, y) coords of solid infill / top / bottom areas
    outer_wall_segments = []  # (x1, y1, x2, y2) of "Outer wall" extrusion moves
    prev_outer_wall_segments = [] # Previous layer's outer wall for overhang detection
    prev_z = None             # Previous layer's Z height

    # Stats counters
    stats = {
        "preheat_commands": 0,
        "smooth_passes": 0,
        "anneal_passes": 0,
        "wall_smooth_layers": 0,
        "rivet_layers": 0,
    }

    def inject_end_of_layer_passes(is_final_layer=False):
        nonlocal is_preheat_on, last_pwm1, last_pwm2, prev_outer_wall_segments, prev_z, current_z
        nonlocal delayed_deep_passes_queue, delayed_deep_passes_trigger_layer
        nonlocal last_chunk_end_layer
        nonlocal unswept_layers, layer_z_map
        nonlocal active_slope_groups
        
        injected = []

        if delayed_deep_passes_queue and current_layer >= delayed_deep_passes_trigger_layer:
            injected.extend(delayed_deep_passes_queue)
            delayed_deep_passes_queue = []

        if is_preheat_on:
            injected.append("SET_PIN PIN=laser_pwm1 VALUE=0\nSET_PIN PIN=laser_pwm2 VALUE=0 ; [Post-Proc] OFF (end of layer)\n")
            is_preheat_on = False
            last_pwm1 = 0.0
            last_pwm2 = 0.0

        if outer_wall_segments:
            layer_z_map[current_layer] = current_z
            if WALL_MAX_LAYER_SAFETY > 0 and max_layer_global > 0 and current_layer > max_layer_global - WALL_MAX_LAYER_SAFETY:
                pass # Skip adding to unswept_layers for top layer safety
            else:
                unswept_layers.append(current_layer)

            # Check for physical overhang/bridge boundary
            is_boundary = False
            if WALL_SMOOTH_ENABLED and WALL_DEEP_MODE and len(unswept_layers) > 1:
                cur_segs = outer_wall_segments
                prev_segs = layer_outer_walls_map.get(current_layer - 1, [])
                if cur_segs and prev_segs:
                    import math as _math
                    dz = current_z - layer_z_map.get(current_layer - 1, current_z - 0.2)
                    if dz <= 0: dz = 0.2
                    overhang_len = 0.0
                    for cx1, cy1, cx2, cy2 in cur_segs:
                        mx, my = (cx1+cx2)/2.0, (cy1+cy2)/2.0
                        min_dist = 9999.0
                        for px1, py1, px2, py2 in prev_segs:
                            l2 = (px2-px1)**2 + (py2-py1)**2
                            if l2 == 0:
                                d = _math.hypot(mx-px1, my-py1)
                            else:
                                t = max(0.0, min(1.0, ((mx-px1)*(px2-px1) + (my-py1)*(py2-py1)) / l2))
                                proj_x = px1 + t * (px2-px1)
                                proj_y = py1 + t * (py2-py1)
                                d = _math.hypot(mx-proj_x, my-proj_y)
                            if d < min_dist:
                                min_dist = d
                        
                        intersections = 0
                        for px1, py1, px2, py2 in prev_segs:
                            if (py1 > my) != (py2 > my):
                                intersect_x = px1 + (my - py1) * (px2 - px1) / (py2 - py1)
                                if mx < intersect_x:
                                    intersections += 1
                        is_outside = (intersections % 2 == 0)

                        angle = _math.degrees(_math.atan2(min_dist, dz))
                        if is_outside and angle > WALL_DEEP_OVERHANG_ANGLE:
                            overhang_len += _math.hypot(cx2-cx1, cy2-cy1)
                            
                    if overhang_len > WALL_DEEP_IGNORE_OVERHANG_LENGTH:
                        is_boundary = True



            def do_sweep(chunk_layers, ignore_safety=False):
                if not chunk_layers: return []
                
                safety = 0 if (is_final_layer or ignore_safety) else WALL_DEEP_SAFETY
                if safety > 0:
                    if len(chunk_layers) <= safety:
                        return []
                    chunk_layers = chunk_layers[:-safety]
                    
                all_passes = []
                
                def execute_pass(mode, speed, p_plus, p_minus, is_pass2=False):
                    if mode == "none": return []
                    reverse_path_flag = is_pass2 and WALL_PASS2_REVERSE_DIRECTION
                    reverse_wobble_flag = is_pass2 and WALL_PASS2_WOBBLE_REVERSE
                    
                    if mode == "wobble":
                        top_layer_idx = chunk_layers[-1]
                        bottom_layer_idx = chunk_layers[0]
                        segs = layer_outer_walls_map.get(top_layer_idx, [])
                        if not segs: return []
                        
                        tz = layer_z_map.get(top_layer_idx, current_z)
                        bz = layer_z_map.get(bottom_layer_idx, tz - (len(chunk_layers) * 0.2))
                        
                        chunk_map = {idx: layer_outer_walls_map.get(idx, []) for idx in chunk_layers}
                        chunk_z_map = {idx: layer_z_map.get(idx, tz - ((top_layer_idx - idx) * 0.2)) for idx in chunk_layers}
                        
                        return generate_deep_wobble_passes(
                            chunk_map=chunk_map,
                            chunk_z_map=chunk_z_map,
                            chunk_layers=chunk_layers,
                            top_segments=segs,
                            current_z=tz,
                            z_drop=tz - bz,
                            speed=speed,
                            passes_count=WALL_SMOOTH_PASSES,
                            x_plus_power=p_plus,
                            x_minus_power=p_minus,
                            angle_tol=WALL_SMOOTH_ANGLE_TOL,
                            reverse_path=reverse_path_flag,
                            overshoot=WALL_DEEP_WOBBLE_OVERSHOOT
                        )
                    
                    elif mode == "deep":
                        top_layer_idx = chunk_layers[-1]
                        segs = layer_outer_walls_map.get(top_layer_idx, [])
                        if not segs: return []
                        tz = layer_z_map.get(top_layer_idx, current_z)
                        pz = layer_z_map.get(top_layer_idx - 1, tz - 0.2)
                        sweep_depth = min(len(chunk_layers), WALL_SMOOTH_FREQ)
                        passes = generate_wall_smooth_passes(segs, layer_outer_walls_map.get(top_layer_idx-1, []), layer_outer_walls_map.get(top_layer_idx+1, []), tz, pz, top_layer_idx, sweep_depth, speed, WALL_SMOOTH_PASSES, p_plus, p_minus, p_plus, p_minus, WALL_SMOOTH_ANGLE_TOL, True, True, sweep_depth, layer_outer_walls_map, tz, reverse_path=reverse_path_flag)
                        return passes if passes else []
                        
                    elif mode == "standard":
                        standard_passes = []
                        for idx in reversed(chunk_layers):
                            segs = layer_outer_walls_map.get(idx, [])
                            if not segs: continue
                            tz = layer_z_map.get(idx, current_z)
                            pz = layer_z_map.get(idx - 1, tz - 0.2)
                            passes = generate_wall_smooth_passes(segs, layer_outer_walls_map.get(idx-1, []), layer_outer_walls_map.get(idx+1, []), tz, pz, idx, 1, speed, WALL_SMOOTH_PASSES, p_plus, p_minus, p_plus, p_minus, WALL_SMOOTH_ANGLE_TOL, True, True, 1, layer_outer_walls_map, tz, reverse_path=reverse_path_flag)
                            if passes: standard_passes.extend(passes)
                        return standard_passes
                        
                    return []

                all_passes.extend(execute_pass(WALL_MODE_PASS1, WALL_SMOOTH_SPEED, WALL_SMOOTH_POWER_X_PLUS, WALL_SMOOTH_POWER_X_MINUS, is_pass2=False))
                if WALL_MODE_PASS2 != "none":
                    all_passes.extend(execute_pass(WALL_MODE_PASS2, WALL_PASS2_SPEED, WALL_PASS2_POWER_PLUS, WALL_PASS2_POWER_MINUS, is_pass2=True))
                return all_passes

            wobble_active = (WALL_MODE_PASS1 == "wobble" or WALL_MODE_PASS2 == "wobble")
            effective_chunk_size = WALL_DEEP_WOBBLE_LAYERS if wobble_active else max(1, WALL_SMOOTH_FREQ)
            effective_overlap = WALL_DEEP_WOBBLE_OVERLAP if wobble_active else WALL_DEEP_OVERLAP
            effective_overlap = min(max(1, effective_chunk_size) - 1, effective_overlap)
            if effective_overlap < 0: effective_overlap = 0

            if is_boundary:
                chunk = unswept_layers[:-1]
                if chunk:
                    passes = do_sweep(chunk, ignore_safety=True)
                    if passes: 
                        if WALL_DEEP_DELAY_PASSES and WALL_DEEP_MODE:
                            delayed_deep_passes_queue.extend(passes)
                            delayed_deep_passes_trigger_layer = current_layer + WALL_DEEP_SAFETY
                        else:
                            injected.extend(passes)
                        stats["wall_smooth_layers"] += 1
                        recovery_layers.add(current_layer + 1)
                        
                        # Execute Wobble Seam pass for the PREVIOUS chunk's seam
                        if WALL_WOBBLE_SEAM_ONLY and WALL_WOBBLE_ENABLED and last_chunk_end_layer != -1 and WALL_SEAM_WOBBLE_OVERLAP > 0:
                            half_down = (WALL_SEAM_WOBBLE_OVERLAP - 1) // 2
                            half_up = WALL_SEAM_WOBBLE_OVERLAP // 2
                            lower_target_layer = max(1, last_chunk_end_layer - half_down)
                            upper_target_layer = min(current_layer, last_chunk_end_layer + half_up)
                            
                            target_layers_count = upper_target_layer - lower_target_layer + 1
                            
                            if target_layers_count >= WALL_SEAM_WOBBLE_OVERLAP:
                                start_depth_layers = current_layer - upper_target_layer
                                end_depth_layers = current_layer - lower_target_layer
                                
                                wobble_seam_segments = layer_outer_walls_map.get(last_chunk_end_layer, [])
                                if wobble_seam_segments:
                                    w_passes = generate_wobble_passes(
                                        wobble_seam_segments,
                                        outer_wall_segments,
                                        current_z,
                                        prev_z,
                                        start_depth_layers,
                                        end_depth_layers,
                                        WALL_SEAM_WOBBLE_SPEED,
                                        WALL_SMOOTH_PASSES,
                                        WALL_SEAM_WOBBLE_POWER_PLUS,
                                        WALL_SEAM_WOBBLE_POWER_MINUS,
                                        WALL_SMOOTH_ANGLE_TOL,
                                        overshoot=WALL_SEAM_WOBBLE_OVERSHOOT
                                    )
                                    if w_passes:
                                        if WALL_DEEP_DELAY_PASSES and WALL_DEEP_MODE and not is_final_layer:
                                            delayed_deep_passes_queue.extend(w_passes)
                                        else:
                                            injected.extend(w_passes)
                        
                        last_chunk_end_layer = current_layer
                if effective_overlap > 0 and not is_final_layer:
                    unswept_layers = unswept_layers[-effective_overlap:]
                else:
                    unswept_layers = []

            
            safety_offset = 0 if is_final_layer else WALL_DEEP_SAFETY
            trigger_size = effective_chunk_size + safety_offset
            retained_overlap = effective_overlap + safety_offset

            if is_final_layer or (effective_chunk_size > 0 and len(unswept_layers) >= trigger_size):
                chunk = list(unswept_layers)
                if chunk:
                    passes = do_sweep(chunk)
                    if passes: 
                        if WALL_DEEP_DELAY_PASSES and WALL_DEEP_MODE and not is_final_layer:
                            delayed_deep_passes_queue.extend(passes)
                            delayed_deep_passes_trigger_layer = current_layer + WALL_DEEP_SAFETY
                        else:
                            injected.extend(passes)
                        stats["wall_smooth_layers"] += 1
                        recovery_layers.add(current_layer + 1)
                        
                        # Execute Wobble Seam pass for the PREVIOUS chunk's seam
                        if WALL_WOBBLE_SEAM_ONLY and WALL_WOBBLE_ENABLED and last_chunk_end_layer != -1 and WALL_SEAM_WOBBLE_OVERLAP > 0:
                            half_down = (WALL_SEAM_WOBBLE_OVERLAP - 1) // 2
                            half_up = WALL_SEAM_WOBBLE_OVERLAP // 2
                            lower_target_layer = max(1, last_chunk_end_layer - half_down)
                            upper_target_layer = min(current_layer, last_chunk_end_layer + half_up)
                            
                            target_layers_count = upper_target_layer - lower_target_layer + 1
                            
                            if target_layers_count >= WALL_SEAM_WOBBLE_OVERLAP:
                                start_depth_layers = current_layer - upper_target_layer
                                end_depth_layers = current_layer - lower_target_layer
                                
                                wobble_seam_segments = layer_outer_walls_map.get(last_chunk_end_layer, [])
                                if wobble_seam_segments:
                                    w_passes = generate_wobble_passes(
                                        wobble_seam_segments,
                                        outer_wall_segments,
                                        current_z,
                                        prev_z,
                                        start_depth_layers,
                                        end_depth_layers,
                                        WALL_SEAM_WOBBLE_SPEED,
                                        WALL_SMOOTH_PASSES,
                                        WALL_SEAM_WOBBLE_POWER_PLUS,
                                        WALL_SEAM_WOBBLE_POWER_MINUS,
                                        WALL_SMOOTH_ANGLE_TOL,
                                        overshoot=WALL_SEAM_WOBBLE_OVERSHOOT
                                    )
                                    if w_passes:
                                        if WALL_DEEP_DELAY_PASSES and WALL_DEEP_MODE and not is_final_layer:
                                            delayed_deep_passes_queue.extend(w_passes)
                                        else:
                                            injected.extend(w_passes)
                        
                        last_chunk_end_layer = current_layer
                if retained_overlap > 0 and not is_final_layer:
                    unswept_layers = unswept_layers[-retained_overlap:]
                else:
                    unswept_layers = []

        # ── Top Surface Smoothing ──
        # ── Top Surface Smoothing ──
        if SMOOTH_ENABLED and (not GLOBAL_SMOOTH_ENABLED or SMOOTH_LOCAL_ENABLED) and current_layer >= MIN_LAYER and len(top_surface_points) >= 2 and SMOOTH_PASSES > 0:
            if SMOOTH_GROUP_SLOPES:
                # 1. Update active groups with current layer's islands
                clusters = cluster_points(top_surface_points, max_dist=2.5)
                for cluster in clusters:
                    merged = False
                    for group in active_slope_groups:
                        if is_touching(cluster, group['points'], max_dist=3.0):
                            group['points'].extend(cluster)
                            group['max_z'] = current_z
                            merged = True
                            break
                    if not merged:
                        active_slope_groups.append({
                            'points': list(cluster),
                            'max_z': current_z
                        })
                
                # 2. Check if groups are finished by looking at the next layer
                next_layer_pts = layer_top_surfaces_map.get(current_layer + 1, [])
                finished_groups = []
                kept_groups = []
                
                for group in active_slope_groups:
                    if is_final_layer or not next_layer_pts or not is_touching(group['points'], next_layer_pts, max_dist=3.0):
                        finished_groups.append(group)
                    else:
                        kept_groups.append(group)
                        
                active_slope_groups = kept_groups
                
                # 3. Generate passes for finished groups
                for g_idx, group in enumerate(finished_groups):
                    pass_z = group['max_z'] + SMOOTH_Z_HOP
                    subsampled = downsample_points(group['points'], resolution=max(0.2, SMOOTH_BOOLEAN_RES)) if len(group['points']) > 20000 else group['points']
                    
                    for pass_idx in range(SMOOTH_PASSES):
                        current_angle = SMOOTH_ANGLE + (SMOOTH_ANGLE_STEP * pass_idx if SMOOTH_ALTERNATE else 0.0)
                        bbox, (cx, cy) = compute_rotated_bbox(group['points'], angle_deg=current_angle, margin=SMOOTH_MARGIN)
                        
                        if bbox is not None and bbox_area(bbox) >= SMOOTH_MIN_AREA:
                            pass_label = f"Grouped Slope Pass {pass_idx+1} (Group {g_idx+1})"
                            boosted_power = calculate_boosted_power(SMOOTH_POWER, bbox_area(bbox))
                            
                            inj = generate_laser_grid(
                                bbox, cx, cy, current_angle, SMOOTH_SPEED, boosted_power, 0.0,
                                SMOOTH_SPACING, SMOOTH_OVERSHOOT, pass_label,
                                laser_pin=SMOOTH_LASER_PIN, offset_x=SMOOTH_OFFSET_X, offset_y=SMOOTH_OFFSET_Y, 
                                fan_speed=SMOOTH_FAN_SPEED, preheat=SMOOTH_PREHEAT, 
                                overshoot_without_laser=SMOOTH_OVERSHOOT_WITHOUT_LASER, 
                                cluster=subsampled, layer_points=subsampled,
                                layer_z=pass_z, boolean_res=max(0.2, SMOOTH_BOOLEAN_RES)
                            )
                            if inj:
                                injected.append(f"; ── Grouped Sloped Smoothing Pass (Z={pass_z:.3f}) ──\n")
                                injected.extend(inj)
                                injected.append("SET_PIN PIN=laser_pwm1 VALUE=0\nSET_PIN PIN=laser_pwm2 VALUE=0 ; [Grouped Smooth] safety OFF\n")
                                stats["smooth_passes"] += 1
            else:
                clusters = cluster_points(top_surface_points, max_dist=2.5)
                for pass_idx in range(SMOOTH_PASSES):
                    current_angle = SMOOTH_ANGLE + (SMOOTH_ANGLE_STEP * pass_idx if SMOOTH_ALTERNATE else 0.0)
                    
                    for c_idx, cluster in enumerate(clusters):
                        if len(cluster) < 2:
                            continue
                        
                        bbox, (cx, cy) = compute_rotated_bbox(cluster, angle_deg=current_angle, margin=SMOOTH_MARGIN)
                        if bbox is not None and bbox_area(bbox) >= SMOOTH_MIN_AREA:
                            min_x, min_y, max_x, max_y = bbox
                            if SMOOTH_SMART_CHUNKING and ((max_x - min_x) > SMOOTH_CHUNK_SIZE or (max_y - min_y) > SMOOTH_CHUNK_SIZE):
                                import math
                                nx = math.ceil((max_x - min_x) / SMOOTH_CHUNK_SIZE)
                                ny = math.ceil((max_y - min_y) / SMOOTH_CHUNK_SIZE)
                                step_x = (max_x - min_x) / nx
                                step_y = (max_y - min_y) / ny
                                
                                for ix in range(nx):
                                    for iy in range(ny):
                                        c_min_x = min_x + ix * step_x
                                        c_max_x = min_x + (ix + 1) * step_x
                                        c_min_y = min_y + iy * step_y
                                        c_max_y = min_y + (iy + 1) * step_y
                                        c_bbox = (c_min_x, c_min_y, c_max_x, c_max_y)
                                        
                                        pass_label = f"Smooth Pass {pass_idx+1} (Island {c_idx+1} Chunk {ix},{iy})"
                                        boosted_power = calculate_boosted_power(SMOOTH_POWER, bbox_area(c_bbox))
                                        injected.extend(generate_laser_grid(
                                            c_bbox, cx, cy, current_angle, SMOOTH_SPEED, boosted_power, SMOOTH_Z_HOP,
                                            SMOOTH_SPACING, SMOOTH_OVERSHOOT, pass_label,
                                            laser_pin=SMOOTH_LASER_PIN, offset_x=SMOOTH_OFFSET_X, offset_y=SMOOTH_OFFSET_Y, fan_speed=SMOOTH_FAN_SPEED, preheat=SMOOTH_PREHEAT, overshoot_without_laser=SMOOTH_OVERSHOOT_WITHOUT_LASER, cluster=cluster, layer_points=layer_points,
                                            layer_z=current_z, boolean_res=SMOOTH_BOOLEAN_RES
                                        ))
                                        
                                if SMOOTH_CHUNK_FULL_PASS:
                                    pass_label = f"Smooth Pass {pass_idx+1} (Island {c_idx+1} Full Edge Pass)"
                                    boosted_power = calculate_boosted_power(SMOOTH_CHUNK_FULL_PASS_POWER, bbox_area(bbox))
                                    injected.extend(generate_laser_grid(
                                        bbox, cx, cy, current_angle, SMOOTH_SPEED, boosted_power, SMOOTH_Z_HOP,
                                        SMOOTH_SPACING, SMOOTH_OVERSHOOT, pass_label,
                                        laser_pin=SMOOTH_LASER_PIN, offset_x=SMOOTH_OFFSET_X, offset_y=SMOOTH_OFFSET_Y, fan_speed=SMOOTH_FAN_SPEED, preheat=SMOOTH_PREHEAT, overshoot_without_laser=SMOOTH_OVERSHOOT_WITHOUT_LASER, cluster=cluster, layer_points=layer_points,
                                        layer_z=current_z, boolean_res=SMOOTH_BOOLEAN_RES
                                    ))
                            else:
                                pass_label = f"Smooth Pass {pass_idx+1} (Island {c_idx+1})"
                                boosted_power = calculate_boosted_power(SMOOTH_POWER, bbox_area(bbox))
                                injected.extend(generate_laser_grid(
                                    bbox, cx, cy, current_angle, SMOOTH_SPEED, boosted_power, SMOOTH_Z_HOP,
                                    SMOOTH_SPACING, SMOOTH_OVERSHOOT, pass_label,
                                    laser_pin=SMOOTH_LASER_PIN, offset_x=SMOOTH_OFFSET_X, offset_y=SMOOTH_OFFSET_Y, fan_speed=SMOOTH_FAN_SPEED, preheat=SMOOTH_PREHEAT, overshoot_without_laser=SMOOTH_OVERSHOOT_WITHOUT_LASER, cluster=cluster, layer_points=layer_points,
                                    layer_z=current_z, boolean_res=SMOOTH_BOOLEAN_RES
                                ))
                            stats["smooth_passes"] += 1

        # ── Crystallinity Annealing ──
        if ANNEAL_ENABLED and current_layer >= ANNEAL_MIN_LAYER and len(layer_points) >= 2:
            bbox, (cx, cy) = compute_rotated_bbox(layer_points, angle_deg=ANNEAL_ANGLE, margin=ANNEAL_MARGIN)
            if bbox is not None and bbox_area(bbox) >= ANNEAL_MIN_AREA:
                injected.extend(generate_laser_grid(
                    bbox, cx, cy, ANNEAL_ANGLE, ANNEAL_SPEED, ANNEAL_POWER, ANNEAL_Z_HOP,
                    ANNEAL_SPACING, ANNEAL_OVERSHOOT, "Anneal"
                ))
                stats["anneal_passes"] += 1

        # ── Laser Riveting ──
        if RIVET_ENABLED and current_layer >= RIVET_MIN_LAYER and (current_layer % max(1, RIVET_FREQ)) == 0:
            if len(solid_points) >= 2:
                clusters = cluster_points(solid_points, max_dist=2.5)
                for cluster in clusters:
                    if len(cluster) < 2:
                        continue
                    bbox, (cx, cy) = compute_rotated_bbox(cluster, angle_deg=0.0, margin=RIVET_MARGIN)
                    if bbox is not None and bbox_area(bbox) >= RIVET_MIN_AREA:
                        injected.extend(generate_laser_rivets(
                            bbox, cx, cy, 0.0, RIVET_POWER, RIVET_TIME, RIVET_Z_HOP, RIVET_SPACING,
                            laser_pin=RIVET_LASER_PIN, offset_x=RIVET_OFFSET_X, offset_y=RIVET_OFFSET_Y,
                            wobble_radius=RIVET_WOBBLE_RADIUS, wobble_turns=RIVET_WOBBLE_TURNS, wobble_max_speed=RIVET_WOBBLE_MAX_SPEED, pulse_period=RIVET_PULSE_PERIOD, pulse_duty=RIVET_PULSE_DUTY,
                            cluster=cluster, boolean_res=0.2
                        ))
                stats["rivet_layers"] += 1

        return injected

    final_passes_injected = False

    in_laser_block = False
    pending_unretract = 0.0
    suppress_next_unretract = False
    skip_next_purge = False
    is_m83 = True
    current_fan_speed = 0
    recovery_layers = set()
    recovery_flow_active = False
    
    active_slope_groups = []
    global_solid_points = []
    global_pass_injected = False

    # ── Main G-code processing loop ──
    for idx, line in enumerate(lines):
        stripped = line.strip()
        
        if 'M82' in stripped: is_m83 = False
        if 'M83' in stripped: is_m83 = True
        
        if stripped.startswith('M104 ') or stripped.startswith('M109 '):
            s_val = get_val(stripped, 'S')
            if s_val is not None and s_val > 0:
                global CURRENT_PRINT_TEMP
                CURRENT_PRINT_TEMP = s_val

        # State machine to completely strip previously inserted laser blocks
        # This prevents "ghost passes" if the script is run multiple times on the same file.
        if stripped.startswith("; ==") and "Start" in stripped and "[" in stripped:
            in_laser_block = True
            continue
        if stripped.startswith("; ==") and "End" in stripped and "==" in stripped:
            in_laser_block = False
            if "RETRACT=" in stripped:
                try: pending_unretract = float(stripped.split("RETRACT=")[1].strip().split()[0])
                except: pass
            continue
        if in_laser_block:
            continue
            
        if suppress_next_unretract:
            is_move = stripped.startswith('G1 ') or stripped.startswith('G0 ')
            if is_move and 'E' in stripped:
                if 'X' in stripped or 'Y' in stripped:
                    # This is a printing move, not an unretract. Stop suppressing.
                    suppress_next_unretract = False
                else:
                    # This is an E-only or Z+E move. Suppress the E!
                    import re
                    e_match = re.search(r'E([-\d.]+)', stripped)
                    if e_match:
                        e_val = float(e_match.group(1))
                        # Strip E parameter
                        new_line = re.sub(r'E[-\d.]+', '', stripped).strip()
                        new_line = re.sub(r'\s+', ' ', new_line)
                        
                        out_lines.append(f"; {line.rstrip()} [Unretract suppressed by Mid-Air Purge]\n")
                        
                        # If there's still a valid command (like Z or F), output it
                        if new_line != "G1" and new_line != "G0":
                            out_lines.append(f"{new_line}\n")
                            
                        # If absolute mode, we MUST update the printer's E tracker!
                        if not is_m83:
                            out_lines.append(f"G92 E{e_val:.5f} ; Update absolute E tracker after purge\n")
                            
                        suppress_next_unretract = False
                        continue
                        
        # Legacy fallback for old passes without tags
        if "SET_PIN PIN=laser_pwm" in stripped or "[Wall Smooth]" in stripped or "Z-Tower" in stripped or "[Wobble]" in stripped or "Wobble Pass" in stripped:
            continue
            
        if stripped.startswith('M106'):
            s_val = get_val(stripped, 'S')
            if s_val is not None:
                current_fan_speed = int(s_val)
        elif stripped.startswith('M107'):
            current_fan_speed = 0
            
        if pending_unretract > 0.0:
            is_move = stripped.startswith('G1 ') or stripped.startswith('G0 ')
            if is_move and 'X' in stripped and 'Y' in stripped and 'E' not in stripped:
                if getattr(args, 'enable_purge', False) and not skip_next_purge:
                    # Mid-Air Purge (Poop)
                    purge_x = getattr(args, 'purge_x', 5.0)
                    purge_y = getattr(args, 'purge_y', 5.0)
                    purge_extra = getattr(args, 'purge_extra', 25.0)
                    
                    out_lines.append(f"; [Mid-Air Purge] Move to safe corner to prime nozzle\n")
                    out_lines.append(f"G0 X{purge_x:.3f} Y{purge_y:.3f} F6000\n")
                    out_lines.append("M106 S255 ; blast fan to blow blob away\n")
                    out_lines.append("M83 ; relative extrusion\n")
                    out_lines.append(f"G1 E{pending_unretract + purge_extra:.1f} F1200 ; unretract + extra prime\n")
                    out_lines.append("G1 E-1.5 F2400 ; quick retract to snap string\n")
                    out_lines.append(f"G0 X{purge_x + 10.0:.3f} F6000 ; shake to drop string\n")
                    out_lines.append("G1 E1.5 F2400 ; unretract the snap\n")
                    if not is_m83:
                        out_lines.append("M82 ; restore absolute extrusion\n")
                    if current_fan_speed > 0:
                        out_lines.append(f"M106 S{current_fan_speed} ; restore fan\n")
                    else:
                        out_lines.append("M107 ; restore fan\n")
                    
                    # Output the travel move completely untouched so it moves to the part
                    out_lines.append(f"{line}")
                    
                    pending_unretract = 0.0
                    suppress_next_unretract = True
                    continue
                else:
                    skip_next_purge = False
                    # Old behavior: unretract in place before traveling
                    out_lines.append("M83 ; relative extrusion\n")
                    out_lines.append(f"G1 E{pending_unretract:.1f} F2400 ; In-place unretract (Purge Disabled)\n")
                    if not is_m83:
                        out_lines.append("M82 ; restore absolute extrusion\n")
                    
                    out_lines.append(f"{line}")
                    pending_unretract = 0.0
                    # Still suppress the slicer's unretract to prevent over-extrusion!
                    suppress_next_unretract = True
                    continue

        # ────────────────────────────────────
        # Detect end of print commands
        # ────────────────────────────────────
        if stripped in (";PRINT_END", "M104 S0") or stripped.startswith("; custom gcode"):
            # ── Inject Global 2D Smoothing Pass ──
            if GLOBAL_SMOOTH_ENABLED and not global_pass_injected and len(global_solid_points) >= 2:
                global_pass_injected = True
                pass_z = (current_z if current_z is not None else 0.0) + 0.5
                out_lines.append(f"; ── Global 2D Smoothing Pass ──\n")
                out_lines.append(f"G0 Z{pass_z:.3f} F1200\n")
                
                # We need a fallback if current_z wasn't set, though it should be.
                # Subsample points for performance without creating gaps in the mask
                subsampled_points = downsample_points(global_solid_points, resolution=max(0.5, SMOOTH_BOOLEAN_RES)) if len(global_solid_points) > 50000 else global_solid_points
                
                for pass_idx in range(SMOOTH_PASSES):
                    current_angle = SMOOTH_ANGLE + (SMOOTH_ANGLE_STEP * pass_idx if SMOOTH_ALTERNATE else 0.0)
                    bbox, (cx, cy) = compute_rotated_bbox(global_solid_points, angle_deg=current_angle, margin=SMOOTH_MARGIN)
                    
                    if bbox is not None and bbox_area(bbox) >= SMOOTH_MIN_AREA:
                        pass_label = f"Global 2D Smooth Pass {pass_idx+1}"
                        injected = generate_laser_grid(
                            bbox, cx, cy, current_angle, SMOOTH_SPEED, SMOOTH_POWER, 0.0,
                            SMOOTH_SPACING, SMOOTH_OVERSHOOT, pass_label,
                            laser_pin=SMOOTH_LASER_PIN, offset_x=SMOOTH_OFFSET_X, offset_y=SMOOTH_OFFSET_Y, 
                            fan_speed=SMOOTH_FAN_SPEED, preheat=SMOOTH_PREHEAT, 
                            overshoot_without_laser=SMOOTH_OVERSHOOT_WITHOUT_LASER, 
                            cluster=subsampled_points, layer_points=subsampled_points,
                            layer_z=pass_z, boolean_res=max(0.5, SMOOTH_BOOLEAN_RES)
                        )
                        if injected:
                            out_lines.extend(injected)
                            stats["smooth_passes"] += 1
                out_lines.append("SET_PIN PIN=laser_pwm1 VALUE=0\nSET_PIN PIN=laser_pwm2 VALUE=0 ; [Global Smooth] safety OFF\n")

            if recovery_flow_active:
                out_lines.append("M221 S100 ; Reset recovery flow rate before end\n")
                recovery_flow_active = False
            if not final_passes_injected and current_layer >= 0:
                final_passes_injected = True
                injected = inject_end_of_layer_passes(is_final_layer=True)
                if injected:
                    out_lines.extend(injected)
                    if any("[NO_PURGE]" in inj_line for inj_line in injected):
                        skip_next_purge = True
                    for inj_line in reversed(injected):
                        if "RETRACT=" in inj_line:
                            try: pending_unretract = float(inj_line.split("RETRACT=")[1].strip().split()[0])
                            except: pass
                            break

        # ────────────────────────────────────
        # Detect layer change
        # ────────────────────────────────────
        if stripped.startswith(';LAYER:'):
            # Before starting the new layer, inject passes for the PREVIOUS layer
            if current_layer >= 0:
                injected = inject_end_of_layer_passes()
                if injected:
                    out_lines.extend(injected)
                    if any("[NO_PURGE]" in inj_line for inj_line in injected):
                        skip_next_purge = True
                    for inj_line in reversed(injected):
                        if "RETRACT=" in inj_line:
                            try: pending_unretract = float(inj_line.split("RETRACT=")[1].strip().split()[0])
                            except: pass
                            break
                prev_outer_wall_segments = list(outer_wall_segments)
                prev_z = current_z

            # Reset per-layer state
            top_surface_points = []
            layer_points = []
            solid_points = []
            outer_wall_segments = []

            try:
                current_layer = int(stripped.split(':')[1])
            except ValueError:
                pass

            out_lines.append(line)
            continue

        # ────────────────────────────────────
        # Track feature type
        # ────────────────────────────────────
        if stripped.startswith(';TYPE:'):
            if recovery_flow_active:
                out_lines.append("M221 S100 ; Reset recovery flow rate\n")
                recovery_flow_active = False

            current_type = stripped.split(':')[1].strip()
            out_lines.append(line)
            
            if current_layer in recovery_layers and WALL_RECOVERY_FLOW != 100:
                is_target = False
                if WALL_SMOOTH_TARGET == "both" and current_type in ("Outer wall", "Inner wall"):
                    is_target = True
                elif WALL_SMOOTH_TARGET == "outer" and current_type == "Outer wall":
                    is_target = True
                elif WALL_SMOOTH_TARGET == "inner" and current_type == "Inner wall":
                    is_target = True
                    
                if is_target:
                    out_lines.append(f"M221 S{WALL_RECOVERY_FLOW} ; Boost flow rate for thermal shrinkage recovery\n")
                    recovery_flow_active = True

            continue

        # ────────────────────────────────────
        # Process movement commands
        # ────────────────────────────────────
        is_move = stripped.startswith('G1 ') or stripped.startswith('G0 ')

        if is_move:
            x = get_val(stripped, 'X')
            y = get_val(stripped, 'Y')
            z = get_val(stripped, 'Z')
            e = get_val(stripped, 'E')
            f = get_val(stripped, 'F')

            if z is not None:
                current_z = z
                apply_sweep(current_z)

            if f is not None:
                current_f = f

            # ── Collect points for bounding boxes ──
            moved_x = x if x is not None else current_x
            moved_y = y if y is not None else current_y

            if e is not None and e > 0 and moved_x is not None and moved_y is not None:
                # Interpolate points along the segment to ensure dense point clouds for boolean grids
                pts_to_add = [(moved_x, moved_y)]
                if current_x is not None and current_y is not None:
                    import math
                    dist = math.hypot(moved_x - current_x, moved_y - current_y)
                    if dist > 0.2:
                        steps = int(dist / 0.2)
                        pts_to_add = []
                        for step_i in range(1, steps + 1):
                            px = current_x + (moved_x - current_x) * (step_i / steps)
                            py = current_y + (moved_y - current_y) * (step_i / steps)
                            pts_to_add.append((px, py))
                            
                for pt in pts_to_add:
                    layer_points.append(pt)
                    if current_type == "Top surface":
                        top_surface_points.append(pt)
                    if current_type in ("Solid infill", "Internal solid infill", "Top surface", "Bottom surface"):
                        solid_points.append(pt)
                    if current_layer > 0:
                        global_solid_points.append(pt)
                        
                if current_type == "Outer wall":
                    if current_x is not None and current_y is not None:
                        outer_wall_segments.append((current_x, current_y, moved_x, moved_y))

            # ── Preheating logic (dynamic power scaling) ──
            qualifying = False
            move_dir = None

            if (PREHEAT_ENABLED and
                current_layer >= MIN_LAYER and
                current_type in PREHEAT_TYPES and
                e is not None and e > 0 and
                x is not None and current_x is not None):

                if x > current_x + 0.01:
                    move_dir = "PLUS"
                    qualifying = True
                elif x < current_x - 0.01:
                    move_dir = "MINUS"
                    qualifying = True
                elif y is not None and current_y is not None and (y > current_y + 0.01 or y < current_y - 0.01):
                    move_dir = "BOTH"
                    qualifying = True

            if qualifying:
                current_speed_mms = (current_f / 60.0) if current_f is not None else REF_SPEED
                
                # ── Safety Error for CPU Bottleneck ──
                if not warning_shown and current_speed_mms > 60.0:
                    if TRAILING_ENABLED and TRAILING_RATIO > 0.0 and abs(TRAILING_RATIO - 1.0) > 0.005 and move_dir != "BOTH":
                        import ctypes
                        import sys
                        msg = ("ERROR: Print speed is %.1f mm/s.\n\n"
                               "The CPU is too slow to handle speeds > 60 mm/s when trailing is enabled and not equal to 1.0 (for non-Y moves).\n"
                               "The high frequency of SET_PIN commands will cause the laser to lag behind the toolhead, "
                               "resulting in potential dangerous situations!\n\n"
                               "Do you want to continue anyway?" % current_speed_mms)
                        # MB_YESNO (4) | MB_ICONSTOP (16) | MB_TOPMOST (262144) = 262164
                        res = ctypes.windll.user32.MessageBoxW(0, msg, "Laser CPU Speed Warning", 262164)
                        if res == 7:  # 7 = IDNO
                            print("User aborted script due to CPU speed safety warning.")
                            sys.exit(1)
                        warning_shown = True

                scaled_power = PREHEAT_POWER * (current_speed_mms / REF_SPEED)
                
                # Check if main power is below minimum
                if scaled_power < MIN_LASER_POWER:
                    scaled_power = MIN_LASER_POWER
                else:
                    scaled_power = min(1.0, scaled_power)
                
                trailing_power = 0.0
                
                if move_dir == "BOTH":
                    y_power = scaled_power * 0.50
                    if y_power < MIN_LASER_POWER:
                        y_power = MIN_LASER_POWER
                    scaled_power = y_power
                else:
                    if TRAILING_ENABLED:
                        trailing_power = scaled_power * TRAILING_RATIO
                        if trailing_power < MIN_LASER_POWER:
                            trailing_power = MIN_LASER_POWER

                if move_dir == "PLUS":
                    target_pwm1 = scaled_power
                    target_pwm2 = trailing_power
                elif move_dir == "MINUS":
                    target_pwm1 = trailing_power
                    target_pwm2 = scaled_power
                else:
                    target_pwm1 = scaled_power
                    target_pwm2 = scaled_power

                diff1 = abs(target_pwm1 - last_pwm1)
                diff2 = abs(target_pwm2 - last_pwm2)
                
                if not is_preheat_on or diff1 > 0.005 or diff2 > 0.005:
                    out_lines.append(f"SET_PIN PIN=laser_pwm1 VALUE={target_pwm1:.3f}\nSET_PIN PIN=laser_pwm2 VALUE={target_pwm2:.3f} ; [Preheat] ON ({current_speed_mms:.1f}mm/s)\n")
                    last_pwm1 = target_pwm1
                    last_pwm2 = target_pwm2
                    is_preheat_on = True
                    stats["preheat_commands"] += 1
            else:
                if is_preheat_on:
                    if not will_laser_resume_shortly(idx, current_x, current_y, current_type, lines, PREHEAT_TYPES):
                        out_lines.append("SET_PIN PIN=laser_pwm1 VALUE=0\nSET_PIN PIN=laser_pwm2 VALUE=0 ; [Preheat] OFF\n")
                        last_pwm1 = 0.0
                        last_pwm2 = 0.0
                        is_preheat_on = False

            # Update tracked position
            if x is not None:
                current_x = x
            if y is not None:
                current_y = y

            out_lines.append(line)

        else:
            # Non-move commands: turn off laser if active
            # (except harmless comments and progress updates)
            if is_preheat_on:
                if not stripped.startswith(';') and not stripped.startswith('M73'):
                    if not will_laser_resume_shortly(idx + 1, current_x, current_y, current_type, lines, PREHEAT_TYPES):
                        out_lines.append("SET_PIN PIN=laser_pwm1 VALUE=0\nSET_PIN PIN=laser_pwm2 VALUE=0 ; [Preheat] OFF (non-move cmd)\n")
                        is_preheat_on = False
                        last_pwm1 = 0.0
                        last_pwm2 = 0.0

            out_lines.append(line)

    # ── End of file: inject final passes for last layer (fallback) ──
    if not final_passes_injected and current_layer >= 0:
        out_lines.extend(inject_end_of_layer_passes())

    # Final safety
    out_lines.append("SET_PIN PIN=laser_pwm1 VALUE=0\nSET_PIN PIN=laser_pwm2 VALUE=0 ; [Post-Proc] safety OFF (EOF)\n")

    # ── Write output ──
    with open(file_path, 'w', encoding='utf-8') as f:
        f.writelines(out_lines)

    # ── Print summary ──
    print(f"Advanced laser post-processing complete: {file_path}")
    print(f"  Preheat commands injected: {stats['preheat_commands']}")
    print(f"  Smoothing passes injected: {stats['smooth_passes']}")
    print(f"  Annealing passes injected: {stats['anneal_passes']}")
    print(f"  Wall smoothing passes injected: {stats['wall_smooth_layers']}")


# ═════════════════════════════════════════════════════════════════════
#  CLI ENTRY POINT
# ═════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Advanced Laser-Assisted FDM Post-Processor: "
                    "Preheating, Crystallinity Control, and Top Surface Smoothing.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic usage (preheating + smoothing, default settings):
  python orcaslicer_laser_advanced.py model.gcode

  # Enable annealing, adjust powers:
  python orcaslicer_laser_advanced.py --anneal --anneal-power 0.10 --smooth-power 0.12 model.gcode

  # Preheating only (disable smoothing):
  python orcaslicer_laser_advanced.py --no-smooth model.gcode
        """
    )

    # ── Preheating args ──
    preheat_group = parser.add_argument_group("Preheating")
    preheat_group.add_argument("--preheat", action="store_true",
                               help="Enable inter-layer preheating")
    preheat_group.add_argument("--power", type=float, default=PREHEAT_POWER,
                               help=f"Preheat PWM at reference speed (default: {PREHEAT_POWER})")
    preheat_group.add_argument("--ref-speed", type=float, default=REF_SPEED,
                               help=f"Reference speed in mm/s (default: {REF_SPEED})")
    preheat_group.add_argument("--min-power", type=float, default=MIN_LASER_POWER,
                               help=f"Minimum laser PWM threshold (default: {MIN_LASER_POWER})")
    preheat_group.add_argument("--min-layer", type=int, default=MIN_LAYER,
                               help=f"First layer for laser activation (default: {MIN_LAYER})")
    preheat_group.add_argument("--trailing", action="store_true",
                               help="Enable trailing laser post-heating")
    preheat_group.add_argument("--trailing-ratio", type=float, default=TRAILING_RATIO,
                               help=f"Ratio of main power for trailing laser (default: {TRAILING_RATIO})")

    # ── Smoothing args ──
    smooth_group = parser.add_argument_group("Top Surface Smoothing")
    smooth_group.add_argument("--smooth", action="store_true",
                              help="Enable top surface smoothing")
    smooth_group.add_argument("--global-smooth", action="store_true",
                              help="Enable global 2D top surface smoothing at the end of the print")
    smooth_group.add_argument("--smooth-local", action="store_true",
                              help="Keep local smoothing active even when global smoothing is enabled")
    smooth_group.add_argument("--smooth-power", type=float, default=SMOOTH_POWER,
                              help=f"Smoothing laser PWM (default: {SMOOTH_POWER})")
    smooth_group.add_argument("--smooth-speed", type=float, default=SMOOTH_SPEED,
                              help=f"Smoothing pass speed in mm/s (default: {SMOOTH_SPEED})")
    smooth_group.add_argument("--smooth-spacing", type=float, default=SMOOTH_SPACING,
                              help=f"Grid line spacing in mm (default: {SMOOTH_SPACING})")
    smooth_group.add_argument("--smooth-overshoot", type=float, default=SMOOTH_OVERSHOOT,
                              help=f"Overshoot distance in mm (default: {SMOOTH_OVERSHOOT})")
    smooth_group.add_argument("--smooth-overshoot-without-laser", action="store_true",
                              help="Perform overshoot moves with the laser off to prevent burning the edges")
    smooth_group.add_argument("--smooth-group-slopes", action="store_true",
                              help="Group adjacent sloped top surfaces across multiple layers for a single large smoothing pass")
    smooth_group.add_argument("--smooth-angle", type=float, default=SMOOTH_ANGLE,
                              help=f"Grid angle in degrees (default: {SMOOTH_ANGLE})")
    smooth_group.add_argument("--smooth-passes", type=int, default=SMOOTH_PASSES,
                              help=f"Number of smoothing passes (default: {SMOOTH_PASSES})")
    smooth_group.add_argument("--smooth-angle-step", type=float, default=SMOOTH_ANGLE_STEP,
                              help=f"Angle step for multiple passes (default: {SMOOTH_ANGLE_STEP})")
    smooth_group.add_argument("--smooth-margin", type=float, default=SMOOTH_MARGIN,
                              help=f"Margin inward shrink in mm (default: {SMOOTH_MARGIN})")
    smooth_group.add_argument("--smooth-min-area", type=float, default=SMOOTH_MIN_AREA,
                              help=f"Minimum area to smooth in mm² (default: {SMOOTH_MIN_AREA})")
    
    # Area Power Scaling
    smooth_group.add_argument("--smooth-enable-area-boost", action="store_true",
                              help="Enable dynamic power scaling based on surface area")
    smooth_group.add_argument("--smooth-area-boost", type=float, default=SMOOTH_AREA_BOOST,
                              help=f"Max power boost fraction for large areas (default: {SMOOTH_AREA_BOOST})")
    smooth_group.add_argument("--smooth-area-max", type=float, default=SMOOTH_AREA_MAX,
                              help=f"Area mm² where max boost is applied (default: {SMOOTH_AREA_MAX})")
    smooth_group.add_argument("--smooth-area-base", type=float, default=SMOOTH_AREA_BASE,
                              help=f"Area mm² where boost begins (default: {SMOOTH_AREA_BASE})")
                              
    smooth_group.add_argument("--smooth-preheat", type=int, default=SMOOTH_PREHEAT,
                              help=f"Preheat delay in ms (default: {SMOOTH_PREHEAT})")
    smooth_group.add_argument("--smooth-smart-chunking", action="store_true",
                              help="Enable chunking for large top surfaces")
    smooth_group.add_argument("--smooth-chunk-size", type=float, default=SMOOTH_CHUNK_SIZE,
                              help=f"Max chunk dimension in mm (default: {SMOOTH_CHUNK_SIZE})")
    smooth_group.add_argument("--smooth-chunk-no-full-pass", action="store_true",
                              help="Disable final full edge pass when chunking")
    smooth_group.add_argument("--smooth-chunk-full-pass-power", type=float, default=SMOOTH_CHUNK_FULL_PASS_POWER,
                              help=f"Power for final full edge pass (default: {SMOOTH_CHUNK_FULL_PASS_POWER})")
    smooth_group.add_argument("--smooth-boolean-res", type=float, default=SMOOTH_BOOLEAN_RES,
                              help=f"Boolean grid resolution for smoothing (default: {SMOOTH_BOOLEAN_RES})")
    smooth_group.add_argument("--smooth-no-alternate", action="store_true",
                              help="Do not alternate pass direction")
    smooth_group.add_argument("--smooth-z-hop", type=float, default=SMOOTH_Z_HOP,
                              help=f"Z hop distance in mm for smoothing (default: {SMOOTH_Z_HOP})")
    smooth_group.add_argument("--smooth-fan-speed", type=int, default=SMOOTH_FAN_SPEED,
                              help=f"Fan speed during smoothing (0-255) (default: {SMOOTH_FAN_SPEED})")
    smooth_group.add_argument("--smooth-offset-x", type=float, default=None, help="Custom X offset for Top Surface laser")
    smooth_group.add_argument("--smooth-offset-y", type=float, default=None, help="Custom Y offset for Top Surface laser")
    smooth_group.add_argument("--smooth-offset-z", type=float, default=None, help="Custom Z offset for Top Surface laser")


    # ── Annealing args ──
    anneal_group = parser.add_argument_group("Crystallinity Annealing")
    anneal_group.add_argument("--anneal", action="store_true",
                              help="Enable per-layer annealing pass (disabled by default)")
    anneal_group.add_argument("--anneal-power", type=float, default=ANNEAL_POWER,
                              help=f"Annealing laser PWM (default: {ANNEAL_POWER})")
    anneal_group.add_argument("--anneal-speed", type=float, default=ANNEAL_SPEED,
                              help=f"Annealing pass speed in mm/s (default: {ANNEAL_SPEED})")
    anneal_group.add_argument("--anneal-spacing", type=float, default=ANNEAL_SPACING,
                              help=f"Annealing grid spacing in mm (default: {ANNEAL_SPACING})")
    anneal_group.add_argument("--anneal-overshoot", type=float, default=ANNEAL_OVERSHOOT,
                              help=f"Annealing overshoot distance in mm (default: {ANNEAL_OVERSHOOT})")
    anneal_group.add_argument("--anneal-overshoot-without-laser", action="store_true",
                              help="Turn laser off during annealing overshoot")
    anneal_group.add_argument("--anneal-angle", type=float, default=ANNEAL_ANGLE,
                              help=f"Annealing grid angle in degrees (default: {ANNEAL_ANGLE})")
    anneal_group.add_argument("--anneal-margin", type=float, default=ANNEAL_MARGIN,
                              help=f"Annealing margin inward shrink in mm (default: {ANNEAL_MARGIN})")
    anneal_group.add_argument("--anneal-min-area", type=float, default=ANNEAL_MIN_AREA,
                              help=f"Annealing min area in mm² (default: {ANNEAL_MIN_AREA})")

    # ── Riveting args ──
    rivet_group = parser.add_argument_group("Laser Riveting")
    rivet_group.add_argument("--rivet", action="store_true", help="Enable laser riveting")
    rivet_group.add_argument("--rivet-power", type=float, default=RIVET_POWER, help=f"Rivet PWM (default: {RIVET_POWER})")
    rivet_group.add_argument("--rivet-time", type=int, default=RIVET_TIME, help=f"Rivet dwell time in ms (default: {RIVET_TIME})")
    rivet_group.add_argument("--rivet-spacing", type=float, default=RIVET_SPACING, help=f"Spacing between rivets in mm (default: {RIVET_SPACING})")
    rivet_group.add_argument("--rivet-freq", type=int, default=RIVET_FREQ, help=f"Rivet frequency (layers) (default: {RIVET_FREQ})")
    rivet_group.add_argument("--rivet-offset-x", type=float, default=None, help="Custom X offset for Rivet laser")
    rivet_group.add_argument("--rivet-offset-y", type=float, default=None, help="Custom Y offset for Rivet laser")
    rivet_group.add_argument("--rivet-min-area", type=float, default=RIVET_MIN_AREA, help=f"Minimum area in mm2 to rivet (default: {RIVET_MIN_AREA})")
    rivet_group.add_argument("--rivet-min-layer", type=int, default=RIVET_MIN_LAYER, help=f"Minimum layer to start riveting (default: {RIVET_MIN_LAYER})")
    rivet_group.add_argument("--rivet-margin", type=float, default=RIVET_MARGIN, help=f"Margin (shrinkage) in mm from the boundary (default: {RIVET_MARGIN})")
    rivet_group.add_argument("--rivet-wobble-radius", type=float, default=RIVET_WOBBLE_RADIUS, help=f"Wobble radius in mm (default: {RIVET_WOBBLE_RADIUS})")
    rivet_group.add_argument("--rivet-wobble-turns", type=int, default=RIVET_WOBBLE_TURNS, help=f"Number of wobble revolutions (default: {RIVET_WOBBLE_TURNS})")
    rivet_group.add_argument("--rivet-wobble-max-speed", type=float, default=RIVET_WOBBLE_MAX_SPEED, help=f"Max wobble speed in mm/s (default: {RIVET_WOBBLE_MAX_SPEED})")
    rivet_group.add_argument("--rivet-pulse-period", type=int, default=RIVET_PULSE_PERIOD, help=f"Pulse period in ms (default: {RIVET_PULSE_PERIOD})")
    rivet_group.add_argument("--rivet-pulse-duty", type=float, default=RIVET_PULSE_DUTY, help=f"Pulse duty cycle (default: {RIVET_PULSE_DUTY})")

    # ── Wall Smoothing args ──
    wall_smooth_group = parser.add_argument_group("Wall Smoothing (Remelt Outer Shell)")
    wall_smooth_group.add_argument("--wall-smooth", action="store_true", help="Enable wall smoothing")
    wall_smooth_group.add_argument("--wall-mode-pass1", choices=["standard", "deep", "wobble"], default="standard",
                                   help="First pass smoothing mode")
    wall_smooth_group.add_argument("--wall-mode-pass2", choices=["none", "standard", "deep", "wobble"], default="none",
                                   help="Second pass smoothing mode")
    wall_smooth_group.add_argument("--wall-pass2-speed", type=float, default=None, help="Pass 2 speed")
    wall_smooth_group.add_argument("--wall-pass2-power-plus", type=float, default=None, help="Pass 2 X+ power")
    wall_smooth_group.add_argument("--wall-pass2-power-minus", type=float, default=None, help="Pass 2 X- power")
    wall_smooth_group.add_argument("--wall-pass2-reverse", action="store_true", help="Reverse path direction for Pass 2")
    wall_smooth_group.add_argument("--wall-pass2-wobble-reverse", action="store_true", help="Reverse phase of wobble for Pass 2")
    wall_smooth_group.add_argument("--wall-power-plus", type=float, default=WALL_SMOOTH_POWER_X_PLUS,
                                   help=f"Wall smoothing PWM for X+ (default: {WALL_SMOOTH_POWER_X_PLUS})")
    wall_smooth_group.add_argument("--wall-power-minus", type=float, default=WALL_SMOOTH_POWER_X_MINUS,
                                   help=f"Wall smoothing PWM for X- (default: {WALL_SMOOTH_POWER_X_MINUS})")
    wall_smooth_group.add_argument("--wall-overhang-power-plus", type=float, default=WALL_SMOOTH_OVERHANG_POWER_X_PLUS,
                                   help=f"Overhang (Standard mode) PWM for X+ (default: {WALL_SMOOTH_OVERHANG_POWER_X_PLUS})")
    wall_smooth_group.add_argument("--wall-overhang-power-minus", type=float, default=WALL_SMOOTH_OVERHANG_POWER_X_MINUS,
                                   help=f"Overhang (Standard mode) PWM for X- (default: {WALL_SMOOTH_OVERHANG_POWER_X_MINUS})")
    wall_smooth_group.add_argument("--wall-speed", type=float, default=WALL_SMOOTH_SPEED,
                                   help=f"Wall smoothing speed in mm/s (default: {WALL_SMOOTH_SPEED})")
    wall_smooth_group.add_argument("--wall-passes", type=int, default=WALL_SMOOTH_PASSES,
                                   help=f"Number of wall smoothing passes (default: {WALL_SMOOTH_PASSES})")
    wall_smooth_group.add_argument("--wall-freq", type=int, default=WALL_SMOOTH_FREQ,
                                   help=f"Wall smoothing frequency (layers) (default: {WALL_SMOOTH_FREQ})")
    wall_smooth_group.add_argument("--wall-min-layer", type=int, default=WALL_SMOOTH_MIN_LAYER,
                                   help=f"First layer for wall smoothing (default: {WALL_SMOOTH_MIN_LAYER})")
    wall_smooth_group.add_argument("--wall-angle-tol", type=float, default=WALL_SMOOTH_ANGLE_TOL,
                                   help=f"Max angle from Y axis for wall smoothing (default: {WALL_SMOOTH_ANGLE_TOL})")
    wall_smooth_group.add_argument("--wall-target", choices=["both", "outer", "inner"], default=WALL_SMOOTH_TARGET,
                                   help=f"Target which walls to smooth (default: {WALL_SMOOTH_TARGET})")
    wall_smooth_group.add_argument("--wall-min-path-area", type=float, default=WALL_SMOOTH_MIN_PATH_AREA,
                                   help=f"Min loop area in mm² to smooth (skip tiny features like eyes, default: {WALL_SMOOTH_MIN_PATH_AREA})")
    wall_smooth_group.add_argument("--wall-deep", action="store_true",
                                   help="Enable deep wall smoothing (multi-height passes every N layers)")
    wall_smooth_group.add_argument("--wall-z-divisions", type=int, default=WALL_Z_DIVISIONS,
                                   help=f"Number of Z-height passes per layer (default: {WALL_Z_DIVISIONS})")
    wall_smooth_group.add_argument('--wall-deep-deviation', type=float, default=1.0, help='Maximum horizontal curve deviation before breaking chunk')
    wall_smooth_group.add_argument('--wall-deep-min-overhang-length', type=float, default=3.0, help='Minimum length of overhang to trigger chunk break')
    wall_smooth_group.add_argument('--wall-overhang-ignore-length', type=float, default=4.0, help='Minimum length of overhang to trigger chunk break')
    wall_smooth_group.add_argument("--wall-deep-overhang-angle", type=float, default=WALL_DEEP_OVERHANG_ANGLE,
                                   help=f"Angle threshold for overhang fallback (default: {WALL_DEEP_OVERHANG_ANGLE})")
    wall_smooth_group.add_argument("--wall-disable-overhang", action="store_true",
                                   help="Disable overhang detection completely")
    wall_smooth_group.add_argument("--wall-deep-overlap", type=int, default=WALL_DEEP_OVERLAP,
                                   help=f"Number of layers to overlap deep mode sweeps (default: {WALL_DEEP_OVERLAP})")
    wall_smooth_group.add_argument("--wall-deep-safety", type=int, default=WALL_DEEP_SAFETY,
                                   help=f"Layers to leave unsmoothed at the top of a deep block (default: {WALL_DEEP_SAFETY})")
    wall_smooth_group.add_argument("--wall-max-layer-safety", type=int, default=0,
                                   help="Number of topmost layers of the entire print to exclude from smoothing")
    wall_smooth_group.add_argument("--wall-deep-bottom-up", action="store_true",
                                   help="Reverse sweep direction to start from bottom and move up")
    wall_smooth_group.add_argument("--wall-deep-interlace", action="store_true",
                                   help="Interlace Z-sweeps to prevent heat accumulation")
    wall_smooth_group.add_argument("--wall-deep-delay-passes", action="store_true",
                                   help="Delay repeat passes until the entire block has been swept once")
    wall_smooth_group.add_argument("--wall-deep-fade", type=float, default=100.0,
                                   help="Final power percentage for the last sweep in a deep block (default: 100)")
    wall_smooth_group.add_argument("--wall-recovery-flow", type=int, default=100,
                                   help="Flow rate %% (M221) for the walls on the layer immediately after a smoothing pass (default: 100)")
    wall_smooth_group.add_argument("--wall-retract", type=float, default=WALL_RETRACT,
                                   help=f"Initial retraction (mm) at the start of each wall smooth block. Direct drive: 2-3mm, Bowden: 4-6mm (default: {WALL_RETRACT})")
    wall_smooth_group.add_argument("--wall-max-retract", type=float, default=WALL_MAX_RETRACT,
                                   help=f"Maximum total retraction (mm) across all progressive retracts in a wall smooth block. Prevents filament ejection on long sweeps (default: {WALL_MAX_RETRACT})")
    wall_smooth_group.add_argument("--wall-standby-temp-drop", type=float, default=0.0,
                                   help="Degrees C to lower nozzle temp during deep sweeps to stop oozing (default: 0.0)")
    wall_smooth_group.add_argument("--wall-overshoot", type=float, default=0.0,
                                   help="Distance in mm to overshoot corners before turning laser off (default: 0.0)")
    wall_smooth_group.add_argument("--wall-corner-power-drop", type=float, default=50.0,
                                   help="Percentage to drop power at sharp corners (default: 50.0)")
    wall_smooth_group.add_argument("--wall-corner-distance", type=float, default=1.5,
                                   help="Distance in mm from corner apex to begin power drop (default: 1.5)")
    wall_smooth_group.add_argument("--wall-offset-level", type=int, default=0, choices=[0, 1, 2, 3, 4],
                                   help="Laser offset level for wall smoothing (0=default, 1=11.5/-12.6mm, 2=21.2/-23.8mm, 3=31.9/-35.7mm, 4=42.5/-47.6mm)")
    wall_smooth_group.add_argument("--wall-x-plus-offset", type=float, default=None, help="Custom X offset for Wall Plus laser (overrides level)")
    wall_smooth_group.add_argument("--wall-x-minus-offset", type=float, default=None, help="Custom X offset for Wall Minus laser (overrides level)")
    wall_smooth_group.add_argument("--wall-z-offset", type=float, default=None, help="Custom Z offset for Wall lasers (overrides level)")
                                   
    wall_smooth_group.add_argument("--wall-wobble-projection-factor", type=float, default=1.0, help="Multiplier for X-axis projection")
    wall_smooth_group.add_argument("--wall-wobble-pull-only", action="store_true", help="Force wobble sweeps to never push along the wall path (adds Y component)")
    wall_smooth_group.add_argument("--wall-wobble-pull-continuous", action="store_true", help="Use standard zig-zag micro-geometry while retaining pull-only macro-path reversal")
    wall_smooth_group.add_argument("--wall-wobble", action="store_true", help="Enable X-axis Z-wobble mode")
    wall_smooth_group.add_argument("--wall-wobble-seam-only", action="store_true", help="Use wobble only for blending Deep Mode overlap seams")
    
    wall_smooth_group.add_argument("--wall-deep-wobble-layers", type=int, default=4, help="Max layers per deep wobble chunk")
    wall_smooth_group.add_argument("--wall-deep-wobble-overlap", type=int, default=1, help="Layer overlap between deep wobble chunks")
    wall_smooth_group.add_argument("--wall-deep-wobble-spacing", type=float, default=0.2, help="Vertical grid spacing for deep wobble")
    wall_smooth_group.add_argument("--wall-deep-wobble-corner-power-drop", type=float, default=50.0, help="Percentage to drop power at sharp corners during deep wobble (default: 50.0)")
    wall_smooth_group.add_argument("--wall-deep-wobble-corner-distance", type=float, default=1.5, help="Distance in mm from corner apex to begin power drop during deep wobble (default: 1.5)")
    wall_smooth_group.add_argument("--wall-deep-wobble-overshoot", type=float, default=0.0, help="Distance in mm to overshoot corners before turning laser off for deep wobble (default: 0.0)")
    
    wall_smooth_group.add_argument("--wall-seam-wobble-speed", type=float, default=20.0, help="X-axis oscillation speed in mm/s for seam blending")
    wall_smooth_group.add_argument("--wall-seam-wobble-power-plus", type=float, default=0.2, help="Power for wobble X+ for seam blending")
    wall_smooth_group.add_argument("--wall-seam-wobble-power-minus", type=float, default=0.2, help="Power for wobble X- for seam blending")
    wall_smooth_group.add_argument("--wall-seam-wobble-overlap", type=int, default=1, help="Layer overlap between seam wobble chunks")
    wall_smooth_group.add_argument("--wall-seam-wobble-overshoot", type=float, default=0.0, help="Overshoot for seam wobble")
    wall_smooth_group.add_argument("--wall-seam-wobble-spacing", type=float, default=0.2, help="Vertical grid spacing for seam wobble")
    wall_smooth_group.add_argument("--wall-seam-wobble-corner-power-drop", type=float, default=50.0, help="Percentage to drop power at sharp corners during seam wobble (default: 50.0)")
    wall_smooth_group.add_argument("--wall-seam-wobble-corner-distance", type=float, default=1.5, help="Distance in mm from corner apex to begin power drop during seam wobble (default: 1.5)")

    # ── Bricklayer args ──
    bricklayer_group = parser.add_argument_group("Bricklayer Infill")
    bricklayer_group.add_argument("--bricklayer", action="store_true", help="Enable Bricklayer pre-processing script")
    bricklayer_group.add_argument("--bricklayer-extrusion", type=float, default=1.0, help="Multiplier for extrusion amount (default: 1.0)")
    bricklayer_group.add_argument("--bricklayer-retract-length", type=float, default=0.8, help="Length to retract on long travel moves (default: 0.8)")
    bricklayer_group.add_argument("--bricklayer-retract-speed", type=float, default=2400.0, help="Speed for retractions in mm/min (default: 2400)")
    bricklayer_group.add_argument("--bricklayer-z-hop", type=float, default=0.4, help="Z-hop distance during injected travels (default: 0.4)")

    # ── Vibration args ──
    vibrate_group = parser.add_argument_group("Z-Axis Vibration")
    vibrate_group.add_argument("--vibrate", action="store_true", help="Enable Z-Axis Vibration pre-processing script")
    vibrate_group.add_argument("--vibrate-amplitude", type=float, default=0.1, help="Max Z vibration height in mm (default: 0.1)")
    vibrate_group.add_argument("--vibrate-wavelength", type=float, default=2.0, help="Distance between peaks in mm (default: 2.0)")
    vibrate_group.add_argument("--vibrate-spacing", type=float, default=0.4, help="Extrusion width / line spacing (default: 0.4)")
    vibrate_group.add_argument("--vibrate-fade", type=float, default=1.0, help="Fade distance at line ends in mm (default: 1.0)")
    vibrate_group.add_argument("--vibrate-resolution", type=float, default=0.5, help="Length of generated segments in mm (default: 0.5)")
    vibrate_group.add_argument("--vibrate-sync", action="store_true", help="Synchronize phase between lines")

    # ── Purge args ──
    purge_group = parser.add_argument_group("Mid-Air Purge (Poop)")
    purge_group.add_argument("--enable-purge", action="store_true", help="Enable mid-air purge to prime nozzle")
    purge_group.add_argument("--purge-x", type=float, default=5.0, help="X coordinate for mid-air purge (default: 5.0)")
    purge_group.add_argument("--purge-y", type=float, default=5.0, help="Y coordinate for mid-air purge (default: 5.0)")
    purge_group.add_argument("--purge-extra", type=float, default=25.0, help="Extra extrusion amount to prime nozzle (default: 25.0)")

    # ── Z-Sweeping args ──
    sweep_group = parser.add_argument_group("Z-Sweeping (Calibration)")
    sweep_group.add_argument("--sweep-feature", type=str, default="",
                             help="Feature to sweep (e.g. rivet-power, smooth-power, anneal-power, preheat-power)")
    sweep_group.add_argument("--sweep-start-z", type=float, default=SWEEP_START_Z)
    sweep_group.add_argument("--sweep-end-z", type=float, default=SWEEP_END_Z)
    sweep_group.add_argument("--sweep-start-val", type=float, default=SWEEP_START_VAL)
    sweep_group.add_argument("--sweep-end-val", type=float, default=SWEEP_END_VAL)

    # ── Positional ──
    parser.add_argument("gcode_file",
                        help="Path to the G-code file (appended by OrcaSlicer)")

    args = parser.parse_args()

    # Apply CLI arguments to globals
    PREHEAT_ENABLED  = args.preheat
    PREHEAT_POWER    = args.power
    REF_SPEED        = args.ref_speed
    MIN_LASER_POWER  = args.min_power
    MIN_LAYER        = args.min_layer
    TRAILING_ENABLED = args.trailing
    TRAILING_RATIO   = args.trailing_ratio

    SMOOTH_ENABLED   = args.smooth
    GLOBAL_SMOOTH_ENABLED = getattr(args, 'global_smooth', False)
    SMOOTH_LOCAL_ENABLED = getattr(args, 'smooth_local', False)
    SMOOTH_POWER     = args.smooth_power
    SMOOTH_SPEED     = args.smooth_speed
    SMOOTH_SPACING   = args.smooth_spacing
    SMOOTH_OVERSHOOT = args.smooth_overshoot
    SMOOTH_OVERSHOOT_WITHOUT_LASER = args.smooth_overshoot_without_laser
    SMOOTH_GROUP_SLOPES = getattr(args, 'smooth_group_slopes', False)
    SMOOTH_Z_HOP     = max(0.2, args.smooth_z_hop)
    SMOOTH_FAN_SPEED = args.smooth_fan_speed
    SMOOTH_ANGLE     = args.smooth_angle
    SMOOTH_ANGLE_STEP= args.smooth_angle_step
    SMOOTH_PREHEAT   = args.smooth_preheat
    SMOOTH_PASSES    = args.smooth_passes
    SMOOTH_ALTERNATE = not args.smooth_no_alternate
    
    if args.smooth_smart_chunking:
        SMOOTH_SMART_CHUNKING = True
    if args.smooth_chunk_size is not None:
        SMOOTH_CHUNK_SIZE = args.smooth_chunk_size
    if args.smooth_chunk_no_full_pass:
        SMOOTH_CHUNK_FULL_PASS = False
    if args.smooth_chunk_full_pass_power is not None:
        SMOOTH_CHUNK_FULL_PASS_POWER = args.smooth_chunk_full_pass_power
    if args.smooth_boolean_res is not None:
        SMOOTH_BOOLEAN_RES = args.smooth_boolean_res if args.smooth_boolean_res > 0 else 0.1

    SMOOTH_MARGIN    = args.smooth_margin
    SMOOTH_MIN_AREA  = args.smooth_min_area
    SMOOTH_ENABLE_AREA_BOOST = getattr(args, 'smooth_enable_area_boost', False)
    SMOOTH_AREA_BOOST = args.smooth_area_boost
    SMOOTH_AREA_MAX   = args.smooth_area_max
    SMOOTH_AREA_BASE  = args.smooth_area_base
    SMOOTH_OVERSHOOT = args.smooth_overshoot
    SMOOTH_OVERSHOOT_WITHOUT_LASER = args.smooth_overshoot_without_laser

    if args.smooth_offset_x is not None:
        SMOOTH_OFFSET_X = args.smooth_offset_x
    if args.smooth_offset_y is not None:
        SMOOTH_OFFSET_Y = args.smooth_offset_y
    if args.smooth_offset_z is not None:
        SMOOTH_OFFSET_Z = args.smooth_offset_z

    ANNEAL_ENABLED   = args.anneal
    ANNEAL_POWER     = args.anneal_power
    ANNEAL_SPEED     = args.anneal_speed
    ANNEAL_SPACING   = args.anneal_spacing
    ANNEAL_OVERSHOOT = args.anneal_overshoot
    ANNEAL_OVERSHOOT_WITHOUT_LASER = args.anneal_overshoot_without_laser
    ANNEAL_ANGLE     = args.anneal_angle
    ANNEAL_MARGIN    = args.anneal_margin
    ANNEAL_MIN_AREA  = args.anneal_min_area

    RIVET_ENABLED   = args.rivet
    RIVET_POWER     = args.rivet_power
    RIVET_TIME      = args.rivet_time
    RIVET_SPACING   = args.rivet_spacing
    RIVET_FREQ      = args.rivet_freq

    if args.rivet_offset_x is not None:
        RIVET_OFFSET_X = args.rivet_offset_x
    if args.rivet_offset_y is not None:
        RIVET_OFFSET_Y = args.rivet_offset_y
        
    RIVET_MIN_AREA = args.rivet_min_area
    RIVET_MIN_LAYER = args.rivet_min_layer
    RIVET_MARGIN = args.rivet_margin
    RIVET_WOBBLE_RADIUS = args.rivet_wobble_radius
    RIVET_WOBBLE_TURNS = args.rivet_wobble_turns
    RIVET_WOBBLE_MAX_SPEED = args.rivet_wobble_max_speed
    RIVET_PULSE_PERIOD = args.rivet_pulse_period
    RIVET_PULSE_DUTY = args.rivet_pulse_duty

    WALL_SMOOTH_ENABLED = args.wall_smooth
    WALL_SMOOTH_POWER_X_PLUS = args.wall_power_plus
    WALL_SMOOTH_POWER_X_MINUS = args.wall_power_minus
    WALL_SMOOTH_OVERHANG_POWER_X_PLUS = args.wall_overhang_power_plus
    WALL_SMOOTH_OVERHANG_POWER_X_MINUS = args.wall_overhang_power_minus
    
    WALL_OVERHANG_POWER_MAX_PLUS = getattr(args, 'wall_overhang_power_max_plus', WALL_SMOOTH_OVERHANG_POWER_X_PLUS)
    WALL_OVERHANG_POWER_MAX_MINUS = getattr(args, 'wall_overhang_power_max_minus', WALL_SMOOTH_OVERHANG_POWER_X_MINUS)
    
    WALL_MODE_PASS1          = getattr(args, 'wall_mode_pass1', 'standard')
    WALL_MODE_PASS2          = getattr(args, 'wall_mode_pass2', 'none')
    WALL_PASS2_SPEED         = getattr(args, 'wall_pass2_speed', WALL_SMOOTH_SPEED)
    WALL_PASS2_POWER_PLUS    = getattr(args, 'wall_pass2_power_plus', WALL_SMOOTH_POWER_X_PLUS)
    WALL_PASS2_POWER_MINUS   = getattr(args, 'wall_pass2_power_minus', WALL_SMOOTH_POWER_X_MINUS)
    WALL_PASS2_REVERSE_DIRECTION = getattr(args, 'wall_pass2_reverse', False)
    WALL_PASS2_WOBBLE_REVERSE    = getattr(args, 'wall_pass2_wobble_reverse', False)

    WALL_SMOOTH_SPEED = args.wall_speed
    WALL_SMOOTH_PASSES = args.wall_passes
    WALL_SMOOTH_FREQ = args.wall_freq
    WALL_SMOOTH_MIN_LAYER = args.wall_min_layer
    WALL_SMOOTH_ANGLE_TOL = args.wall_angle_tol
    WALL_SMOOTH_TARGET = args.wall_target
    WALL_SMOOTH_MIN_PATH_AREA = args.wall_min_path_area
    
    WALL_DEEP_MODE            = (WALL_MODE_PASS1 in ["deep", "wobble"] or WALL_MODE_PASS2 in ["deep", "wobble"])
    WALL_Z_DIVISIONS          = args.wall_z_divisions
    WALL_DEEP_OVERHANG_ANGLE  = args.wall_deep_overhang_angle
    WALL_DEEP_DEVIATION       = args.wall_deep_deviation
    WALL_DEEP_MIN_OVERHANG_LENGTH = args.wall_deep_min_overhang_length
    WALL_DEEP_OVERLAP         = args.wall_deep_overlap
    WALL_DEEP_SAFETY          = args.wall_deep_safety
    WALL_MAX_LAYER_SAFETY     = args.wall_max_layer_safety
    WALL_DEEP_IGNORE_OVERHANG_LENGTH = args.wall_overhang_ignore_length
    WALL_DEEP_BOTTOM_UP       = args.wall_deep_bottom_up
    WALL_DEEP_INTERLACE       = args.wall_deep_interlace
    WALL_DEEP_DELAY_PASSES    = args.wall_deep_delay_passes
    WALL_DEEP_FADE            = args.wall_deep_fade
    WALL_DISABLE_OVERHANG     = args.wall_disable_overhang
    WALL_RECOVERY_FLOW        = args.wall_recovery_flow
    WALL_RETRACT              = args.wall_retract
    WALL_MAX_RETRACT          = args.wall_max_retract
    WALL_STANDBY_TEMP_DROP    = args.wall_standby_temp_drop
    
    WALL_WOBBLE_ENABLED       = args.wall_wobble
    WALL_WOBBLE_SEAM_ONLY     = args.wall_wobble_seam_only
    
    WALL_DEEP_WOBBLE_LAYERS        = getattr(args, 'wall_deep_wobble_layers', 4)
    WALL_DEEP_WOBBLE_OVERLAP       = getattr(args, 'wall_deep_wobble_overlap', 1)
    WALL_DEEP_WOBBLE_SPACING       = getattr(args, 'wall_deep_wobble_spacing', 0.2)
    WALL_DEEP_WOBBLE_CORNER_POWER_DROP = max(0.0, min(100.0, 100.0 - getattr(args, 'wall_deep_wobble_corner_power_drop', 50.0))) / 100.0
    WALL_DEEP_WOBBLE_CORNER_DISTANCE   = max(0.0, getattr(args, 'wall_deep_wobble_corner_distance', 1.5))
    WALL_DEEP_WOBBLE_OVERSHOOT         = getattr(args, 'wall_deep_wobble_overshoot', 0.0)
    
    WALL_SEAM_WOBBLE_SPEED         = getattr(args, 'wall_seam_wobble_speed', 20.0)
    WALL_SEAM_WOBBLE_POWER_PLUS    = getattr(args, 'wall_seam_wobble_power_plus', 0.2)
    WALL_SEAM_WOBBLE_POWER_MINUS   = getattr(args, 'wall_seam_wobble_power_minus', 0.2)
    WALL_SEAM_WOBBLE_OVERLAP       = getattr(args, 'wall_seam_wobble_overlap', 1)
    WALL_SEAM_WOBBLE_SPACING       = getattr(args, 'wall_seam_wobble_spacing', 0.2)
    WALL_SEAM_WOBBLE_CORNER_POWER_DROP = max(0.0, min(100.0, 100.0 - getattr(args, 'wall_seam_wobble_corner_power_drop', 50.0))) / 100.0
    WALL_SEAM_WOBBLE_CORNER_DISTANCE   = max(0.0, getattr(args, 'wall_seam_wobble_corner_distance', 1.5))
    
    WALL_OVERSHOOT            = args.wall_overshoot
    WALL_WOBBLE_PROJECTION_FACTOR = getattr(args, 'wall_wobble_projection_factor', 1.0)
    WALL_WOBBLE_PULL_ONLY = getattr(args, 'wall_wobble_pull_only', False)
    WALL_WOBBLE_PULL_CONTINUOUS = getattr(args, 'wall_wobble_pull_continuous', False)
    WALL_CORNER_POWER_DROP    = max(0.0, min(100.0, 100.0 - args.wall_corner_power_drop)) / 100.0
    WALL_CORNER_DISTANCE      = max(0.0, args.wall_corner_distance)
    
    WALL_OFFSET_LEVEL = args.wall_offset_level
    if WALL_OFFSET_LEVEL == 1:
        WALL_Z_OFFSET = 5.8
        WALL_X_PLUS_OFFSET = 11.5
        WALL_X_MINUS_OFFSET = -12.6
    elif WALL_OFFSET_LEVEL == 2:
        WALL_Z_OFFSET = 10.0
        WALL_X_PLUS_OFFSET = 21.2
        WALL_X_MINUS_OFFSET = -23.8
    elif WALL_OFFSET_LEVEL == 3:
        WALL_Z_OFFSET = 15.0
        WALL_X_PLUS_OFFSET = 31.9
        WALL_X_MINUS_OFFSET = -35.7
    elif WALL_OFFSET_LEVEL == 4:
        WALL_Z_OFFSET = 20.0
        WALL_X_PLUS_OFFSET = 42.5
        WALL_X_MINUS_OFFSET = -47.6
    else:
        WALL_Z_OFFSET = 2.8
        WALL_X_PLUS_OFFSET = 5.0
        WALL_X_MINUS_OFFSET = -5.5

    if args.wall_x_plus_offset is not None:
        WALL_X_PLUS_OFFSET = args.wall_x_plus_offset
    if args.wall_x_minus_offset is not None:
        WALL_X_MINUS_OFFSET = args.wall_x_minus_offset
    if args.wall_z_offset is not None:
        WALL_Z_OFFSET = args.wall_z_offset

    SWEEP_FEATURE   = args.sweep_feature
    SWEEP_START_Z   = args.sweep_start_z
    SWEEP_END_Z     = args.sweep_end_z
    SWEEP_START_VAL = args.sweep_start_val
    SWEEP_END_VAL   = args.sweep_end_val
    
    ENABLE_PURGE    = getattr(args, 'enable_purge', False)
    PURGE_X         = getattr(args, 'purge_x', 5.0)
    PURGE_Y         = getattr(args, 'purge_y', 5.0)

    if os.path.exists(args.gcode_file):
        if args.bricklayer:
            try:
                import orcaslicer_bricklayer_infill
                print(f"Running Bricklayer on {args.gcode_file}...")
                orcaslicer_bricklayer_infill.process_gcode(
                    args.gcode_file, 
                    args.bricklayer_extrusion, 
                    args.bricklayer_retract_length, 
                    args.bricklayer_retract_speed, 
                    args.bricklayer_z_hop
                )
            except Exception as e:
                print(f"Error running Bricklayer: {e}")
                
        if args.vibrate:
            try:
                import orcaslicer_vibrate_infill
                print(f"Running Vibration on {args.gcode_file}...")
                orcaslicer_vibrate_infill.process_gcode(
                    args.gcode_file,
                    args.vibrate_amplitude,
                    args.vibrate_wavelength,
                    args.vibrate_spacing,
                    args.vibrate_fade,
                    args.vibrate_resolution,
                    args.vibrate_sync
                )
            except Exception as e:
                print(f"Error running Vibration: {e}")
                
        process_gcode(args.gcode_file, args)
    else:
        print(f"Error: File {args.gcode_file} not found.")
        sys.exit(1)
