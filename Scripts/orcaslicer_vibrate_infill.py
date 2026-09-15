import sys
import re
import os
import math
import argparse

# ==========================================
# LASER-ASSISTED FDM POST-PROCESSING SCRIPT
# VIBRATION INFILL ADD-ON
# ==========================================

# --- CONFIGURATION ---
AMPLITUDE = 0.1       # Max Z vibration height (mm)
WAVELENGTH = 2.0      # Distance between peaks along the line (mm)
LINE_SPACING = 0.4    # Extrusion width / distance between lines for phase shift
FADE_DISTANCE = 1.0   # Distance to fade in/out the amplitude at line ends (mm)
RESOLUTION = 0.5      # Length of generated small segments (mm)
SYNC_PHASE = False    # Whether lines should vibrate in sync (peak-to-peak) instead of alternating


ALLOWED_TYPES = [
    "Internal solid infill",
    "Solid infill"
]
# ---------------------

def smooth_envelope(d, fade, L):
    if L <= 0: 
        return 0.0
    if L < 2 * fade:
        half = L / 2.0
        if d < half:
            t_env = d / half
            return 0.5 - 0.5 * math.cos(math.pi * t_env)
        else:
            t_env = (L - d) / half
            return 0.5 - 0.5 * math.cos(math.pi * t_env)
    else:
        if d < fade:
            t_env = d / fade
            return 0.5 - 0.5 * math.cos(math.pi * t_env)
        elif d > L - fade:
            t_env = (L - d) / fade
            return 0.5 - 0.5 * math.cos(math.pi * t_env)
        else:
            return 1.0

def process_gcode(file_path, amplitude=AMPLITUDE, wavelength=WAVELENGTH, spacing=LINE_SPACING, fade=FADE_DISTANCE, resolution=RESOLUTION, sync=SYNC_PHASE):
    with open(file_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    out_lines = []
    current_type = None
    
    current_x = 0.0
    current_y = 0.0
    current_z = 0.2
    current_e = 0.0
    
    is_absolute_extrusion = True # Default to absolute unless M83 is found

    def get_val(line, char):
        match = re.search(fr'{char}\s*([-+]?\d*\.?\d+)', line)
        return float(match.group(1)) if match else None

    for line in lines:
        stripped = line.strip()
        
        # Track feature type
        if stripped.startswith(';TYPE:'):
            current_type = stripped.split(':')[1].strip()
            
        # Track Extrusion mode
        elif stripped.startswith('M82'):
            is_absolute_extrusion = True
        elif stripped.startswith('M83'):
            is_absolute_extrusion = False
            
        # Process movement commands
        is_move = stripped.startswith('G1 ') or stripped.startswith('G0 ')
        
        if is_move:
            x = get_val(stripped, 'X')
            y = get_val(stripped, 'Y')
            z = get_val(stripped, 'Z')
            e = get_val(stripped, 'E')
            f = get_val(stripped, 'F')
            
            # Update current Z before any processing if the command sets Z
            if z is not None:
                current_z = z
                
            is_qualifying = (current_type in ALLOWED_TYPES and 
                             e is not None and e > 0 and 
                             x is not None and y is not None)
            
            if is_qualifying:
                # We have a line segment that needs vibration
                x1 = x
                y1 = y
                x0 = current_x
                y0 = current_y
                
                dx = x1 - x0
                dy = y1 - y0
                L = math.sqrt(dx*dx + dy*dy)
                
                if L > 0.01:
                    out_lines.append(f"; [Vibration Start] L={L:.2f}\n")
                    
                    angle = math.atan2(dy, dx)
                    while angle < 0: 
                        angle += math.pi
                    while angle >= math.pi: 
                        angle -= math.pi
                        
                    cos_th = math.cos(angle)
                    sin_th = math.sin(angle)
                    
                    N = max(1, int(math.ceil(L / resolution)))
                    
                    e0 = current_e if is_absolute_extrusion else 0.0
                    e1 = e if is_absolute_extrusion else e
                    
                    for i in range(1, N + 1):
                        t = i / float(N)
                        seg_x = x0 + t * dx
                        seg_y = y0 + t * dy
                        d = t * L
                        
                        u = seg_x * cos_th + seg_y * sin_th
                        v = -seg_x * sin_th + seg_y * cos_th
                        
                        if sync:
                            phase = 2.0 * math.pi * (u / wavelength)
                        else:
                            phase = 2.0 * math.pi * (u / wavelength) + math.pi * (v / spacing)
                            
                        z_vibrate = amplitude * math.sin(phase)
                        
                        env = smooth_envelope(d, fade, L)
                        new_z = current_z + env * z_vibrate
                        
                        if is_absolute_extrusion:
                            seg_e = e0 + t * (e1 - e0)
                        else:
                            seg_e = e1 / float(N)
                            
                        # Format the G-code string
                        gcode_parts = ["G1", f"X{seg_x:.3f}", f"Y{seg_y:.3f}", f"Z{new_z:.3f}", f"E{seg_e:.5f}"]
                        if i == 1 and f is not None:
                            gcode_parts.append(f"F{f}")
                            
                        out_lines.append(" ".join(gcode_parts) + "\n")
                    
                    out_lines.append("; [Vibration End]\n")
                    
                    # Update trackers
                    current_x = x1
                    current_y = y1
                    if is_absolute_extrusion:
                        current_e = e1
                    continue # Skip appending the original line

            # If not qualifying, or skipped due to length 0, keep original line
            # but we still need to update tracking variables
            if x is not None: current_x = x
            if y is not None: current_y = y
            if e is not None and is_absolute_extrusion: current_e = e
            
            out_lines.append(line)
            
        else:
            # Non-move commands just get appended
            out_lines.append(line)

    # Write output to the same file
    with open(file_path, 'w', encoding='utf-8') as f:
        f.writelines(out_lines)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Z-axis vibration script for solid infill.")
    parser.add_argument("--amplitude", type=float, default=AMPLITUDE, help="Max Z vibration height (mm)")
    parser.add_argument("--wavelength", type=float, default=WAVELENGTH, help="Distance between peaks (mm)")
    parser.add_argument("--spacing", type=float, default=LINE_SPACING, help="Extrusion width / line spacing (mm)")
    parser.add_argument("--fade", type=float, default=FADE_DISTANCE, help="Fade distance at line ends (mm)")
    parser.add_argument("--resolution", type=float, default=RESOLUTION, help="Length of generated segments (mm)")
    parser.add_argument("--sync", action="store_true", help="Synchronize phase between lines (no peak-to-valley)")
    parser.add_argument("gcode_file", help="Path to the G-code file")
    
    args = parser.parse_args()
    
    AMPLITUDE = args.amplitude
    WAVELENGTH = args.wavelength
    LINE_SPACING = args.spacing
    FADE_DISTANCE = args.fade
    RESOLUTION = args.resolution
    SYNC_PHASE = args.sync
    
    if os.path.exists(args.gcode_file):
        process_gcode(args.gcode_file, AMPLITUDE, WAVELENGTH, LINE_SPACING, FADE_DISTANCE, RESOLUTION, SYNC_PHASE)
        print(f"Successfully applied Z-vibration to {args.gcode_file}.")
    else:
        print(f"Error: File {args.gcode_file} not found.")
        sys.exit(1)
