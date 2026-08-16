import sys
import os
import argparse
import re
import math

import importlib.util
advanced_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "orcaslicer_laser_advanced - z wobble.py")
spec = importlib.util.spec_from_file_location("advanced", advanced_path)
advanced = importlib.util.module_from_spec(spec)
spec.loader.exec_module(advanced)

def get_val(line, axis):
    match = re.search(f'{axis}\\s*([-+]?\\d*\\.?\\d+)', line)
    return float(match.group(1)) if match else None

def split_segment_by_columns(x1, y1, x2, y2, long_axis, min_val):
    if long_axis == 'X':
        v1, v2 = x1, x2
    else:
        v1, v2 = y1, y2
        
    start_v = min(v1, v2)
    end_v = max(v1, v2)
    
    boundaries = [min_val + c * 10 for c in range(1, 5)]
    crossings = [b for b in boundaries if start_v < b < end_v]
    
    if not crossings:
        return [(x1, y1, x2, y2)]
        
    if v1 > v2:
        crossings.sort(reverse=True)
    else:
        crossings.sort()
        
    segments = []
    curr_x, curr_y = x1, y1
    for b in crossings:
        ratio = (b - v1) / (v2 - v1)
        mid_x = x1 + ratio * (x2 - x1)
        mid_y = y1 + ratio * (y2 - y1)
        segments.append((curr_x, curr_y, mid_x, mid_y))
        curr_x, curr_y = mid_x, mid_y
        
    segments.append((curr_x, curr_y, x2, y2))
    return segments

def get_interpolated(args, var_name, row, col, max_rows=5, max_cols=5):
    if args.x_var == var_name:
        if max_cols <= 1: return args.x_min
        return args.x_min + col * (args.x_max - args.x_min) / (max_cols - 1.0)
    elif args.y_var == var_name:
        if max_rows <= 1: return args.y_min
        return args.y_min + row * (args.y_max - args.y_min) / (max_rows - 1.0)
    else:
        return getattr(args, var_name, 0.0)

def get_matrix_values(row, col, args, max_rows=5, max_cols=5):
    """Interpolates variables based on row and col."""
    power = get_interpolated(args, "power", row, col, max_rows, max_cols)
    speed = get_interpolated(args, "speed", row, col, max_rows, max_cols)
    spacing = get_interpolated(args, "spacing", row, col, max_rows, max_cols)
    z_hop = max(0.2, get_interpolated(args, "z_hop", row, col, max_rows, max_cols))
    passes = max(1, int(round(get_interpolated(args, "passes", row, col, max_rows, max_cols))))
    dwell = int(round(get_interpolated(args, "dwell", row, col, max_rows, max_cols)))
    angle = get_interpolated(args, "angle", row, col, max_rows, max_cols)
    fan_speed = int(round(get_interpolated(args, "fan_speed", row, col, max_rows, max_cols)))
    preheat = int(round(get_interpolated(args, "preheat", row, col, max_rows, max_cols)))
    angle_step = get_interpolated(args, "angle_step", row, col, max_rows, max_cols)
    overshoot = get_interpolated(args, "overshoot", row, col, max_rows, max_cols)
    rivet_wobble_radius = get_interpolated(args, "rivet_wobble_radius", row, col, max_rows, max_cols)
    rivet_wobble_turns = int(round(get_interpolated(args, "rivet_wobble_turns", row, col, max_rows, max_cols)))
    rivet_wobble_max_speed = get_interpolated(args, "rivet_wobble_max_speed", row, col, max_rows, max_cols)
    rivet_pulse_period = int(round(get_interpolated(args, "rivet_pulse_period", row, col, max_rows, max_cols)))
    rivet_pulse_duty = get_interpolated(args, "rivet_pulse_duty", row, col, max_rows, max_cols)
    pass2_power = get_interpolated(args, "pass2_power", row, col, max_rows, max_cols)
    pass2_speed = get_interpolated(args, "pass2_speed", row, col, max_rows, max_cols)
    angle_tol = get_interpolated(args, "angle_tol", row, col, max_rows, max_cols)
    deep_overhang = get_interpolated(args, "deep_overhang", row, col, max_rows, max_cols)
    deep_overlap = int(round(get_interpolated(args, "deep_overlap", row, col, max_rows, max_cols)))
    
    return power, speed, spacing, z_hop, passes, dwell, overshoot, angle, fan_speed, preheat, angle_step, rivet_wobble_radius, rivet_wobble_turns, rivet_wobble_max_speed, rivet_pulse_period, rivet_pulse_duty, pass2_power, pass2_speed, angle_tol, deep_overhang, deep_overlap


def is_point_in_path(pt_x, pt_y, path):
    inside = False
    for x1, y1, x2, y2 in path:
        if ((y1 > pt_y) != (y2 > pt_y)) and (pt_x < (x2 - x1) * (pt_y - y1) / (y2 - y1) + x1):
            inside = not inside
    return inside



def generate_matrix_wall(wall_segments, current_z, layer_height, args, override_vals=None):
    wall_min_x = min(min(x1, x2) for x1, y1, x2, y2 in wall_segments)
    wall_max_x = max(max(x1, x2) for x1, y1, x2, y2 in wall_segments)
    wall_min_y = min(min(y1, y2) for x1, y1, x2, y2 in wall_segments)
    wall_max_y = max(max(y1, y2) for x1, y1, x2, y2 in wall_segments)
    
    if (wall_max_x - wall_min_x) > (wall_max_y - wall_min_y):
        long_axis = 'X'
        min_val = wall_min_x
    else:
        long_axis = 'Y'
        min_val = wall_min_y
        
    # Group into continuous paths
    paths = []
    current_path = []
    for x1, y1, x2, y2 in wall_segments:
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
        
    gcode = []
    all_passes = []
    
    wall_offset_level = getattr(args, 'wall_offset_level', 0)
    if wall_offset_level == 1:
        x_plus_offset, x_minus_offset, z_offset = 11.5, -12.6, 5.8
    elif wall_offset_level == 2:
        x_plus_offset, x_minus_offset, z_offset = 21.2, -23.8, 10.0
    elif wall_offset_level == 3:
        x_plus_offset, x_minus_offset, z_offset = 31.9, -35.7, 15.0
    elif wall_offset_level == 4:
        x_plus_offset, x_minus_offset, z_offset = 42.5, -47.6, 20.0
    else:
        x_plus_offset, x_minus_offset, z_offset = 5.0, -5.5, 2.8
        
    if getattr(args, 'wall_x_plus_offset', None) is not None:
        x_plus_offset = args.wall_x_plus_offset
    if getattr(args, 'wall_x_minus_offset', None) is not None:
        x_minus_offset = args.wall_x_minus_offset
    if getattr(args, 'wall_z_offset', None) is not None:
        z_offset = args.wall_z_offset
    
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
        
    for path_idx, path in enumerate(paths):
        area_sum = sum((x2 - x1) * (y2 + y1) for x1, y1, x2, y2 in path)
        is_ccw = (area_sum <= 0)
        is_hole = path_is_hole[path_idx]
        
        # If it's an outer boundary, air is on the right when CCW. If CW, air is on the left.
        # If it's a hole, air is on the left when CCW. If CW, air is on the right.
        if not is_hole:
            air_on_right = is_ccw
        else:
            air_on_right = not is_ccw
        
        split_path = []
        for x1, y1, x2, y2 in path:
            split_path.extend(split_segment_by_columns(x1, y1, x2, y2, long_axis, min_val))
            
        passes = []
        current_pass = []
        current_laser = None
        
        for (x1, y1, x2, y2) in split_path:
            dx = x2 - x1
            dy = y2 - y1
            if dx == 0 and dy == 0: continue
            
            skip = False
            
            if getattr(args, 'mode', '') == "wall_z":
                angle_deg = math.degrees(math.atan2(abs(dx), abs(dy)))
                angle_tol = override_vals[18] if override_vals else getattr(args, 'angle_tol', 65.0)
                if angle_deg > angle_tol:
                    skip = True
                    
                wall_target = getattr(args, 'wall_target', 'both')
                if wall_target == 'outer' and is_hole:
                    skip = True
                if wall_target == 'inner' and not is_hole:
                    skip = True
                    
                if not skip:
                    if air_on_right:
                        laser_dir = "PLUS" if dy > 0 else "MINUS"
                    else:
                        laser_dir = "MINUS" if dy > 0 else "PLUS"
            else:
                # Skip the flat base wall; only smooth the protrusions
                if long_axis == 'X':
                    if ((y1 + y2) / 2.0 - wall_min_y) <= 1.5:
                        skip = True
                    # Determine which side of the wall this segment is on
                    is_plus_side = ((y1 + y2) / 2.0) > ((wall_min_y + wall_max_y) / 2.0)
                else:
                    if ((x1 + x2) / 2.0 - wall_min_x) <= 1.5:
                        skip = True
                    is_plus_side = ((x1 + x2) / 2.0) > ((wall_min_x + wall_max_x) / 2.0)
                    
                if not skip:
                    laser_dir = "PLUS" if is_plus_side else "MINUS"
                
            if skip:
                if current_pass:
                    passes.append((current_laser, current_pass))
                    current_pass = []
                    current_laser = None
                continue
                
            shift = x_plus_offset if laser_dir == "PLUS" else x_minus_offset
            nx1 = x1 + shift
            nx2 = x2 + shift
            ny1 = y1
            ny2 = y2
            
            if laser_dir == current_laser:
                current_pass.append((nx1, ny1, nx2, ny2, x1, y1, x2, y2))
            else:
                if current_pass:
                    passes.append((current_laser, current_pass))
                current_pass = [(nx1, ny1, nx2, ny2, x1, y1, x2, y2)]
                current_laser = laser_dir
                
        if current_pass:
            passes.append((current_laser, current_pass))
            
        if passes:
            all_passes.append(passes)
            
    if not all_passes:
        return gcode
        
    gcode.append("; [Wall Smooth START]\n")
    gcode.append("G91\n")
    gcode.append("G1 E-5.0 F2400 ; [Wall Smooth] Initial retract\n")
    gcode.append("G90\n")
    
    total_retracted = 5.0
    loop_count = 0
    
    def do_extra_retract():
        nonlocal loop_count, total_retracted
        loop_count += 1
        if loop_count > 1 and total_retracted < 14.0:
            retract_amt = min(3.0, 14.0 - total_retracted)
            total_retracted += retract_amt
            gcode.append("G91\n")
            gcode.append(f"G1 E-{retract_amt:.1f} F2400 ; [Wall Smooth] Extra progressive retract\n")
            gcode.append("G90\n")
    
    # Evaluate global row (Z-height) for row-level vars
    if override_vals:
        row_wall_layers = max(1, int(round(override_vals[16]))) # Assuming we append wall_layers and z_divs to override
        row_z_divisions = max(1, int(round(override_vals[17])))
        overlap_layers = int(override_vals[20]) if row_wall_layers > 1 else 0
    else:
        base_row = max(0, min(4, int(current_z / 5.0)))
        row_wall_layers = max(1, int(round(get_interpolated(args, "wall_layers", base_row, 0))))
        row_z_divisions = max(1, int(round(get_interpolated(args, "z_divisions", base_row, 0))))
        overlap_layers = int(round(get_interpolated(args, "deep_overlap", base_row, 0))) if row_wall_layers > 1 else 0
    
    total_layers = row_wall_layers + overlap_layers
    
    # Calculate Z divisions
    safety_layers = getattr(args, 'deep_safety', 0)
    safety_divs = safety_layers * row_z_divisions
    total_divs = total_layers * row_z_divisions
    step = layer_height / row_z_divisions
    
    # Generate list of Z offsets
    z_offsets = []
    for div_i in range(1, total_divs + 1):
        target_z_base = current_z - ((safety_divs + div_i - 1) * step)
        if target_z_base >= 0.05:
            z_offsets.append(target_z_base)
            
    if getattr(args, 'wall_deep_bottom_up', False):
        z_offsets.reverse()
        
    if getattr(args, 'wall_deep_interlace', False):
        half = (len(z_offsets) + 1) // 2
        first_half = z_offsets[:half]
        second_half = z_offsets[half:]
        interlaced = []
        for a, b in zip(first_half, second_half + [None]):
            interlaced.append(a)
            if b is not None:
                interlaced.append(b)
        z_offsets = interlaced
        
    # Calculate max passes dynamically from the first segment to determine passes_count
    max_passes = 1
    for passes in all_passes:
        for laser_dir, segments in passes:
            for nx1, ny1, nx2, ny2, ox1, oy1, ox2, oy2 in segments:
                if override_vals:
                    passes_val = int(override_vals[4])
                else:
                    mid_v = (ox1 + ox2) / 2.0 if long_axis == 'X' else (oy1 + oy2) / 2.0
                    rel_v = mid_v - min_val
                    col = max(0, min(4, int(rel_v / 10.0)))
                    row = max(0, min(4, int(current_z / 5.0)))
                    vals = get_matrix_values(row, col, args)
                    passes_val = int(vals[4])
                max_passes = max(max_passes, passes_val)
                
    iteration_order = []
    if getattr(args, 'wall_deep_delay_passes', False):
        for pass_idx in range(max_passes):
            for batch_idx, target_z_base in enumerate(z_offsets):
                iteration_order.append((pass_idx, batch_idx, target_z_base))
    else:
        for batch_idx, target_z_base in enumerate(z_offsets):
            for pass_idx in range(max_passes):
                iteration_order.append((pass_idx, batch_idx, target_z_base))
                
    last_emitted_z = None
    last_ex = None
    last_ey = None
    
    total_z_batches = len(z_offsets)
    fade_setting = getattr(args, 'wall_deep_fade', 100.0)

    for pass_idx, batch_idx, target_z_base in iteration_order:
        target_z = target_z_base + z_offset
        
        # Calculate fade multiplier based on batch_idx
        if total_z_batches > 1 and fade_setting != 100.0:
            fade_target = max(0.0, min(100.0, fade_setting)) / 100.0
            progress = batch_idx / (total_z_batches - 1)
            fade_multiplier = 1.0 - (1.0 - fade_target) * progress
        else:
            fade_multiplier = 1.0
            
        if last_emitted_z is None or abs(last_emitted_z - target_z) > 0.001:
            gcode.append(f"G0 Z{target_z:.3f} F600 ; [Wall Smooth] Z offset up for Z-Base {target_z_base:.3f} (Fade: {fade_multiplier*100:.0f}%)\n")
            last_emitted_z = target_z
            last_ex = None
            last_ey = None
        
        for passes in all_passes:
            for laser_dir, segments in passes:
                pwm_pin = "laser_pwm1" if laser_dir == "PLUS" else "laser_pwm2"
                sx, sy = segments[0][0], segments[0][1]
                do_extra_retract()
                
                if pass_idx > 0 or (last_ex is not None and last_ey is not None):
                    if last_ex is not None and last_ey is not None:
                        dist_back = math.hypot(sx - last_ex, sy - last_ey)
                        if dist_back > 1.0:
                            do_extra_retract()
                            gcode.append(f"G0 X{sx:.3f} Y{sy:.3f} F6000\n")
                        else:
                            gcode.append(f"G1 X{sx:.3f} Y{sy:.3f} F6000\n")
                    else:
                        gcode.append(f"G0 X{sx:.3f} Y{sy:.3f} F6000\n")
                else:
                    gcode.append(f"G0 X{sx:.3f} Y{sy:.3f} F6000\n")
    
                for nx1, ny1, nx2, ny2, ox1, oy1, ox2, oy2 in segments:
                    if override_vals:
                        # Unpack using the new tuple structure including rivet_wobble_turns and rivet_wobble_max_speed
                        power, speed, spacing, z_hop, passes_val, dwell, overshoot, angle, fan_speed, preheat, angle_step, rivet_wobble_radius, rivet_wobble_turns, rivet_wobble_max_speed, rivet_pulse_period, rivet_pulse_duty, pass2_power, pass2_speed, wl, zd, angle_tol, deep_overhang, deep_overlap = override_vals
                        col, row = 0, 0
                    else:
                        mid_v = (ox1 + ox2) / 2.0 if long_axis == 'X' else (oy1 + oy2) / 2.0
                        rel_v = mid_v - min_val
                        col = max(0, min(4, int(rel_v / 10.0)))
                        row = max(0, min(4, int(current_z / 5.0)))
                        power, speed, spacing, z_hop, passes_val, dwell, overshoot, angle, fan_speed, preheat, angle_step, rivet_wobble_radius, rivet_wobble_turns, rivet_wobble_max_speed, rivet_pulse_period, rivet_pulse_duty, pass2_power, pass2_speed, angle_tol, deep_overhang, deep_overlap = get_matrix_values(row, col, args)
                    
                    if pass_idx < int(passes_val):
                        f_val = speed * 60.0
                        power = power * fade_multiplier # Apply fade scaling to the block power
                        
                        if override_vals:
                            gcode.append(f"SET_PIN PIN={pwm_pin} VALUE={power:.3f} ; Z-Tower Override (Fade: {fade_multiplier*100:.0f}%)\n")
                        else:
                            gcode.append(f"SET_PIN PIN={pwm_pin} VALUE={power:.3f} ; Matrix Col {col} Row {row} (Fade: {fade_multiplier*100:.0f}%)\n")
                        gcode.append(f"G1 X{nx2:.3f} Y{ny2:.3f} F{f_val:.0f}\n")
                    else:
                        gcode.append(f"SET_PIN PIN={pwm_pin} VALUE=0\n")
                        gcode.append(f"G0 X{nx2:.3f} Y{ny2:.3f} F6000\n")
                        
                last_ex = segments[-1][2]
                last_ey = segments[-1][3]
                
                gcode.append(f"SET_PIN PIN={pwm_pin} VALUE=0\n")
                
    gcode.append(f"G0 Z{current_z + z_offset:.3f} F600\n")
    # Leave extruder retracted, we will handle the prime/purge next
    gcode.append(f"; [Wall Smooth END] RETRACT={total_retracted:.1f}\n")
    
    return gcode

def process_calibration(file_path, mode, args):
    with open(file_path, 'r', encoding='latin1') as f:
        lines = f.readlines()

    # Pass 1: Find Global Bounding Box and max Z
    min_x, max_x = 9999, -9999
    min_y, max_y = 9999, -9999
    max_z = 0.0

    current_z = 0.0
    current_type = ""
    for line in lines:
        stripped = line.strip()
        if stripped in (";PRINT_END", "M104 S0"):
            break
            
        if stripped.startswith(';TYPE:'):
            current_type = stripped.split(':')[1].strip()
            continue
            
        if line.startswith('G1 ') or line.startswith('G0 '):
            x = get_val(line, 'X')
            y = get_val(line, 'Y')
            z = get_val(line, 'Z')
            e = get_val(line, 'E')
            
            if z is not None:
                current_z = z
                
            if x is not None and y is not None and e is not None and e > 0:
                # Ignore prime lines, custom gcode, skirts and brims
                if current_type not in ("Custom", "Skirt", "Skirt/Brim", "Prime tower"):
                    if x < min_x: min_x = x
                    if x > max_x: max_x = x
                    if y < min_y: min_y = y
                    if y > max_y: max_y = y
                    if current_z > max_z:
                        max_z = current_z
                        
    if min_x == 9999: min_x, max_x = 100, 150
    if min_y == 9999: min_y, max_y = 100, 150
    cx = (min_x + max_x) / 2.0
    cy = (min_y + max_y) / 2.0

    print(f"Detected Print Center: X={cx:.2f}, Y={cy:.2f}, MaxZ={max_z:.2f}")

    out_lines = []
    if args is not None:
        import json
        settings_dict = vars(args)
        out_lines.append(f"; LASER_SETTINGS: {json.dumps(settings_dict)}\n")

    
    # State tracking for wall smooth mode
    outer_wall_segments = []
    current_z = 0.0
    current_layer = -1
    
    if mode in ("wall", "wall_z"):
        current_type = ""
        current_z = 0.0
        prev_x, prev_y = None, None
        layer_segments = []
        
        layer_count = 0
        prev_z_for_height = None
        in_laser_block = False
        pending_unretract = 0.0
        suppress_next_unretract = False
        is_m83 = True  # Default to relative E (common for OrcaSlicer/Klipper)
        current_fan_speed = 0
        
        recovery_flow_active = False
        recovery_flow_restore_pending = False
        
        for line in lines:
            stripped = line.strip()
            
            if 'M82' in stripped: is_m83 = False
            if 'M83' in stripped: is_m83 = True
            
            if "; [Wall Smooth START]" in stripped or (stripped.startswith("; ==") and "Start" in stripped and "[" in stripped):
                in_laser_block = True
                continue
            if "; [Wall Smooth END]" in stripped or (stripped.startswith("; ==") and "End" in stripped and "==" in stripped):
                in_laser_block = False
                if "RETRACT=" in stripped:
                    try:
                        pending_unretract = float(stripped.split("RETRACT=")[1].strip().split()[0])
                    except:
                        pass
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

            # Strip previous calibration passes to prevent duplication if run multiple times
            if "SET_PIN PIN=laser_pwm" in stripped or "[Wall Smooth]" in stripped or "Z-Tower" in stripped or "Matrix Col" in stripped:
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
                    if getattr(args, 'enable_purge', False):
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
                    else:
                        # Standard in-place unretract
                        out_lines.append(f"; [Wall Smooth] In-place unretract\n")
                        out_lines.append("M83 ; relative extrusion\n")
                        out_lines.append(f"G1 E{pending_unretract:.1f} F2400\n")
                        if not is_m83:
                            out_lines.append("M82 ; restore absolute\n")
                        
                        out_lines.append(f"{line}")
                    
                    pending_unretract = 0.0
                    suppress_next_unretract = True
                    continue
            if stripped.startswith(';LAYER_CHANGE'):
                layer_count += 1
                
                if mode == "wall_z" and layer_count > args.z_safety_layers:
                    step_idx = (layer_count - args.z_safety_layers - 1) // args.z_step_layers
                    # 7 levels = 6 steps total
                    val = args.z_min + min(6, step_idx) * (args.z_max - args.z_min) / 6.0
                    if args.z_var == "temp":
                        if (layer_count - args.z_safety_layers - 1) % args.z_step_layers == 0:
                            out_lines.append(f"M104 S{val:.1f} ; Z-Tower Temp\n")
                            out_lines.append(f"M109 S{val:.1f} ; Z-Tower Temp Wait\n")
                    elif args.z_var == "fan_speed":
                        if (layer_count - args.z_safety_layers - 1) % args.z_step_layers == 0:
                            out_lines.append(f"M106 S{int(val)} ; Z-Tower Fan\n")
                            
                if layer_segments:
                    if mode == "wall_z":
                        power = args.power
                        speed = args.speed
                        passes_val = args.passes
                        wl = args.wall_layers
                        zd = args.z_divisions
                        
                        if layer_count <= args.z_safety_layers:
                            power = 0.0
                        else:
                            step_idx = (layer_count - args.z_safety_layers - 1) // args.z_step_layers
                            val = args.z_min + min(6, step_idx) * (args.z_max - args.z_min) / 6.0
                            if args.z_var == "power": power = val
                            elif args.z_var == "speed": speed = val
                            elif args.z_var == "passes": passes_val = int(val)
                            
                        override_vals = [power, speed, args.spacing, args.z_hop, passes_val, args.dwell, args.overshoot, args.angle, args.fan_speed, args.preheat, args.angle_step, args.rivet_wobble_radius, args.rivet_wobble_turns, args.rivet_wobble_max_speed, args.rivet_pulse_period, args.rivet_pulse_duty, args.pass2_power, args.pass2_speed, wl, zd, args.angle_tol, args.deep_overhang, args.wall_deep_overlap]
                        
                        if layer_count % args.wall_layers == 0:
                            l_height = current_z - prev_z_for_height if (prev_z_for_height is not None and current_z > prev_z_for_height) else 0.2
                            passes_wall = generate_matrix_wall(layer_segments, current_z, l_height, args, override_vals)
                            out_lines.extend(passes_wall)
                            for pass_line in reversed(passes_wall):
                                if "RETRACT=" in pass_line:
                                    try: pending_unretract = float(pass_line.split("RETRACT=")[1].strip().split()[0])
                                    except: pass
                                    break
                            
                            if getattr(args, 'wall_recovery_flow', 100) != 100:
                                recovery_flow_active = True
                    else:
                        current_row = max(0, min(4, int(current_z / 5.0)))
                        cur_wall_layers = max(1, int(round(get_interpolated(args, "wall_layers", current_row, 0))))
                        if layer_count % cur_wall_layers == 0:
                            l_height = current_z - prev_z_for_height if (prev_z_for_height is not None and current_z > prev_z_for_height) else 0.2
                            passes_wall = generate_matrix_wall(layer_segments, current_z, l_height, args)
                            out_lines.extend(passes_wall)
                            for pass_line in reversed(passes_wall):
                                if "RETRACT=" in pass_line:
                                    try: pending_unretract = float(pass_line.split("RETRACT=")[1].strip().split()[0])
                                    except: pass
                                    break
                            
                            if getattr(args, 'wall_recovery_flow', 100) != 100:
                                recovery_flow_active = True
                    layer_segments = []
                prev_z_for_height = current_z
            elif stripped in (";PRINT_END", "M104 S0"):
                if layer_segments:
                    l_height = current_z - prev_z_for_height if (prev_z_for_height is not None and current_z > prev_z_for_height) else 0.2
                    if mode == "wall_z":
                        power = args.power if layer_count > args.z_safety_layers else 0.0
                        if args.z_var == "power" and layer_count > args.z_safety_layers:
                            step_idx = (layer_count - args.z_safety_layers - 1) // args.z_step_layers
                            power = args.z_min + min(6, step_idx) * (args.z_max - args.z_min) / 6.0
                        override_vals = [power, args.speed, args.spacing, args.z_hop, args.passes, args.dwell, args.overshoot, args.angle, args.fan_speed, args.preheat, args.angle_step, args.rivet_wobble_radius, args.rivet_wobble_turns, args.rivet_wobble_max_speed, args.rivet_pulse_period, args.rivet_pulse_duty, args.pass2_power, args.pass2_speed, args.wall_layers, args.z_divisions, args.angle_tol, args.deep_overhang, args.wall_deep_overlap]
                        passes_wall = generate_matrix_wall(layer_segments, current_z, l_height, args, override_vals)
                    else:
                        passes_wall = generate_matrix_wall(layer_segments, current_z, l_height, args)
                    out_lines.extend(passes_wall)
                    for pass_line in reversed(passes_wall):
                        if "RETRACT=" in pass_line:
                            try: pending_unretract = float(pass_line.split("RETRACT=")[1].strip().split()[0])
                            except: pass
                            break
                    layer_segments = []
                    
            if stripped.startswith(';TYPE:'):
                current_type = stripped.split(':')[1].strip()
                
                if current_type != "Outer wall" and recovery_flow_restore_pending:
                    out_lines.append("M221 S100 ; [Wall Smooth] Restore default extrusion multiplier\n")
                    recovery_flow_restore_pending = False
                
            if stripped.startswith("G1 ") or stripped.startswith("G0 "):
                x = get_val(stripped, 'X')
                y = get_val(stripped, 'Y')
                z = get_val(stripped, 'Z')
                e = get_val(stripped, 'E')
                if z is not None: current_z = z
                
                if x is not None and y is not None:
                    if current_type == "Outer wall":
                        if e is not None and e > 0 and prev_x is not None:
                            layer_segments.append((prev_x, prev_y, x, y))
                            
                        if recovery_flow_active and e is not None:
                            flow_val = getattr(args, 'wall_recovery_flow', 100)
                            out_lines.append(f"M221 S{flow_val} ; [Wall Smooth] Recovery extrusion multiplier\n")
                            out_lines.append(line)
                            recovery_flow_active = False
                            recovery_flow_restore_pending = True
                            prev_x, prev_y = x, y
                            continue
                            
                    prev_x, prev_y = x, y
                    
            out_lines.append(line)
            
    else:
        # Smooth and Rivet mode logic (Appends at the end of the print)
        in_laser_block = False
        for line in lines:
            stripped = line.strip()
            
            if "; [Laser Cal START]" in stripped or (stripped.startswith("; ==") and "Start" in stripped and "[" in stripped):
                in_laser_block = True
                continue
            if "; [Laser Cal END]" in stripped or (stripped.startswith("; ==") and "End" in stripped and "==" in stripped):
                in_laser_block = False
                continue
            if in_laser_block:
                continue
            
            if "SET_PIN PIN=laser_pwm" in stripped or "[Laser Smooth]" in stripped or "[Laser Rivet]" in stripped or "Matrix Col" in stripped:
                continue
            
            if stripped in (";PRINT_END", "M104 S0"):
                out_lines.append(f"; == MATRIX CALIBRATION ({mode.upper()}) START ==\n")
                out_lines.append(f"G0 Z{max_z + 0.5:.2f} F600\n")
                
                rows = 5
                cols = 4 if mode == "connectivity" else 5
                
                for r in range(rows):
                    for c in range(cols):
                        power, speed, spacing, z_hop, passes_val, dwell, overshoot, angle, fan_speed, preheat, angle_step, rivet_wobble_radius, rivet_wobble_turns, rivet_wobble_max_speed, rivet_pulse_period, rivet_pulse_duty, pass2_power, pass2_speed, angle_tol, deep_overhang, deep_overlap = get_matrix_values(r, c, args, max_rows=rows, max_cols=cols)
                        
                        pitch = args.block_pitch
                        offset = 2 * pitch
                        
                        if mode == "rivet":
                            rx = cx - 16 + c * 8
                            ry = cy - 16 + r * 8
                            bbox = (-0.1, -0.1, 0.1, 0.1)
                            
                            passes_list = advanced.generate_laser_rivets(
                                bbox, rx, ry, angle, power, dwell, z_hop, spacing,
                                laser_pin="laser_pwm3", offset_x=34.0, offset_y=72.5, fan_speed=fan_speed,
                                wobble_radius=rivet_wobble_radius, wobble_turns=rivet_wobble_turns, wobble_max_speed=rivet_wobble_max_speed, pulse_period=rivet_pulse_period, pulse_duty=rivet_pulse_duty
                            )
                            out_lines.extend(passes_list)
                            
                        elif mode == "smooth":
                            bx = cx - offset + c * pitch
                            by = cy - offset + r * pitch
                            half_size = args.block_size / 2.0
                            bbox = (-half_size, -half_size, half_size, half_size)
                            
                            for pass_idx in range(passes_val):
                                current_angle = angle + (angle_step * pass_idx if not args.no_alternate else 0.0)
                                pass_label = f"Matrix R{r}C{c} P{pass_idx+1}"
                                
                                rivet_x = getattr(args, 'rivet_offset_x', None)
                                rivet_x = rivet_x if rivet_x is not None else 34.0
                                rivet_y = getattr(args, 'rivet_offset_y', None)
                                rivet_y = rivet_y if rivet_y is not None else 72.5
                                
                                passes_list = advanced.generate_laser_grid(
                                    bbox, bx, by, current_angle, speed, power, z_hop, spacing, overshoot, pass_label,
                                    laser_pin="laser_pwm3", offset_x=rivet_x, offset_y=rivet_y, fan_speed=fan_speed, preheat=preheat,
                                    overshoot_without_laser=args.overshoot_without_laser
                                )
                                out_lines.extend(passes_list)
                                
                        elif mode == "connectivity":
                            # 4 columns in X, 5 rows in Y. Length in X is 10mm (half=5.0).
                            # Spacing in X is 3mm. Pitch in X is 10 + 3 = 13.0 mm.
                            # Pitch in Y is 3.0 mm.
                            c_pitch_x = 13.0
                            c_pitch_y = 3.0
                            # Center offsets to keep grid centered
                            c_offset_x = (c_pitch_x * 3) / 2.0 # 19.5
                            c_offset_y = (c_pitch_y * 4) / 2.0 # 6.0
                            
                            bx = cx - c_offset_x + c * c_pitch_x
                            by = cy - c_offset_y + r * c_pitch_y
                            half_size = 5.0 # 10mm line
                            bbox = (-half_size, 0, half_size, 0) # Width is determined by subline count
                            
                            rivet_x = getattr(args, 'rivet_offset_x', None)
                            rivet_x = rivet_x if rivet_x is not None else 34.0
                            rivet_y = getattr(args, 'rivet_offset_y', None)
                            rivet_y = rivet_y if rivet_y is not None else 72.5
                            
                            passes_list = advanced.generate_laser_connectivity(
                                bbox, bx, by, power, speed, z_hop,
                                laser_pin="laser_pwm3", offset_x=rivet_x, offset_y=rivet_y, fan_speed=fan_speed,
                                pass2_power=pass2_power, pass2_speed=pass2_speed, passes=passes_val,
                                num_sublines=args.num_sublines, subline_spacing=args.subline_spacing
                            )
                            out_lines.extend(passes_list)
                            
                out_lines.append(f"; == MATRIX CALIBRATION END ==\n")

            out_lines.append(line)

    with open(file_path, 'w', encoding='latin1') as f:
        f.writelines(out_lines)

    print(f"Matrix Calibration applied successfully: {file_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("gcode_file", nargs='+')
    parser.add_argument("--mode", choices=["rivet", "smooth", "wall", "connectivity", "wall_z"], required=True)
    
    # Map variables
    vars_choices = ["power", "speed", "spacing", "z_hop", "passes", "dwell", "overshoot", "angle", "fan_speed", "preheat", "angle_step", "rivet_wobble_radius", "rivet_wobble_turns", "rivet_wobble_max_speed", "rivet_pulse_period", "rivet_pulse_duty", "pass2_power", "pass2_speed", "wall_layers", "z_divisions", "temp", "angle_tol", "deep_overhang", "deep_overlap"]
    parser.add_argument("--x-var", choices=vars_choices, default="speed", help="Variable mapped to the X axis (columns)")
    parser.add_argument("--y-var", choices=vars_choices, default="power", help="Variable mapped to the Y axis (rows)")
    
    # Z-Tower variables
    parser.add_argument("--z-var", choices=vars_choices, default="power", help="Variable mapped to Z height")
    parser.add_argument("--z-min", type=float, default=0.1, help="Minimum value for Z sweep")
    parser.add_argument("--z-max", type=float, default=1.0, help="Maximum value for Z sweep")
    parser.add_argument("--z-step-layers", type=int, default=10, help="Layers per Z step")
    parser.add_argument("--z-safety-layers", type=int, default=5, help="Bottom layers to skip before sweeping")
    
    parser.add_argument("--x-min", type=float, default=10.0, help="Minimum value for X axis variable")
    parser.add_argument("--x-max", type=float, default=50.0, help="Maximum value for X axis variable")
    parser.add_argument("--y-min", type=float, default=0.1, help="Minimum value for Y axis variable")
    parser.add_argument("--y-max", type=float, default=1.0, help="Maximum value for Y axis variable")
    
    # Base variables
    parser.add_argument("--temp", type=float, default=210.0, help="Base temperature")
    parser.add_argument("--power", type=float, default=0.15, help="Base laser power")
    parser.add_argument("--speed", type=float, default=20.0, help="Base pass speed")
    parser.add_argument("--spacing", type=float, default=0.4, help="Base line spacing")
    parser.add_argument("--z-hop", type=float, default=0.5, help="Base Z-hop (minimum 0.2)")
    parser.add_argument("--passes", type=float, default=2, help="Base number of smoothing/connectivity passes")
    parser.add_argument("--z-divisions", type=int, default=1, help="Base number of Z divisions for wall smoothing")
    parser.add_argument("--pass2-power", type=float, default=0.08, help="Base Pass 2 power for connectivity/graphitization")
    parser.add_argument("--pass2-speed", type=float, default=0.0, help="Base Pass 2 speed for connectivity")
    parser.add_argument("--num-sublines", type=int, default=3, help="Number of parallel sub-lines to draw per connectivity trace (default: 3)")
    parser.add_argument("--subline-spacing", type=float, default=0.2, help="Spacing in mm between parallel sub-lines (default: 0.2mm)")
    parser.add_argument("--dwell", type=float, default=1000, help="Base dwell time for rivets")
    parser.add_argument("--overshoot", type=float, default=0.5, help="Base overshoot distance")
    parser.add_argument("--overshoot-without-laser", action="store_true", help="Turn laser off during overshoot")
    parser.add_argument("--angle", type=float, default=0.0, help="Base grid angle")
    parser.add_argument("--fan-speed", type=float, default=0, help="Base fan speed (0-255)")
    parser.add_argument("--preheat", type=float, default=0, help="Base preheat delay (ms)")
    parser.add_argument("--angle-step", type=float, default=90.0, help="Base angle step for multi-pass")


    
    # Rivet specific
    parser.add_argument("--rivet-wobble-radius", type=float, default=0.0, help="Radius of orbital motion for rivet in mm (default: 0.0)")
    parser.add_argument("--rivet-wobble-turns", type=int, default=1, help="Number of turns to make (default: 1)")
    parser.add_argument("--rivet-wobble-max-speed", type=float, default=250.0, help="Max speed of wobble motion (default: 250.0)")
    parser.add_argument("--rivet-pulse-period", type=int, default=0, help="Total time for one ON/OFF cycle in ms (default: 0, disabled)")
    parser.add_argument("--rivet-pulse-duty", type=float, default=0.5, help="Fraction of period the laser is ON (default: 0.5)")
    
    # Grid layout
    parser.add_argument("--block-size", type=float, default=4.0, help="Size of each square block in mm")
    parser.add_argument("--block-pitch", type=float, default=6.0, help="Center-to-center distance between blocks in mm")
    
    parser.add_argument("--no-alternate", action="store_true", help="Do not alternate pass direction")
    
    parser.add_argument("--wall-layers", type=int, default=1, help="Smooth wall every N layers")
    parser.add_argument("--angle-tol", type=float, default=65.0, help="Wall smoothing angle tolerance")
    parser.add_argument("--wall-target", choices=["both", "outer", "inner"], default="both", help="Target which walls to smooth")
    parser.add_argument("--deep-overhang", type=float, default=70.0, help="Deep mode overhang angle")
    parser.add_argument("--wall-deep-overlap", type=int, default=1,
                        help="Number of layers to overlap deep mode sweeps")
    parser.add_argument("--wall-deep-safety", type=int, default=2,
                        help="Layers to leave unsmoothed at the top of a deep block")
    parser.add_argument("--wall-deep-bottom-up", action="store_true",
                        help="Reverse sweep direction to start from bottom and move up")
    parser.add_argument("--wall-deep-interlace", action="store_true",
                        help="Interlace Z-sweeps to prevent heat accumulation")
    parser.add_argument("--wall-deep-delay-passes", action="store_true",
                        help="Delay repeat passes until the entire block has been swept once")
    parser.add_argument("--wall-deep-fade", type=float, default=100.0,
                        help="Final power percentage for the last sweep in a deep block (default: 100)")
    parser.add_argument("--wall-recovery-flow", type=int, default=100,
                        help="Extrusion multiplier percentage for the layer immediately following a wall smooth pass")
                        
    # New arguments for advanced/deep sweep that web generator uses
    parser.add_argument("--wall-offset-level", type=int, default=0, help="Wall offset level (0-4)")
    parser.add_argument("--wall-x-plus-offset", type=float, default=None, help="Custom X offset for Wall Plus laser (overrides level)")
    parser.add_argument("--wall-x-minus-offset", type=float, default=None, help="Custom X offset for Wall Minus laser (overrides level)")
    parser.add_argument("--wall-z-offset", type=float, default=None, help="Custom Z offset for Wall lasers (overrides level)")
    parser.add_argument("--rivet-offset-x", type=float, default=None, help="Custom X offset for Rivet laser")
    parser.add_argument("--rivet-offset-y", type=float, default=None, help="Custom Y offset for Rivet laser")
    parser.add_argument("--wall-deep", action="store_true", help="Enable deep mode")
    parser.add_argument("--wall-overhang-ignore-length", type=float, default=4.0, help="Ignore overhang shorter than this")
    
    parser.add_argument("--wall-deep-second-pass", action="store_true", help="Enable secondary sweep pass")
    parser.add_argument("--wall-deep-second-speed", type=float, default=20.0, help="Speed for secondary deep sweep")
    parser.add_argument("--wall-deep-second-power-plus", type=float, default=0.10, help="Secondary pass power X+")
    parser.add_argument("--wall-deep-second-power-minus", type=float, default=0.10, help="Secondary pass power X-")
    parser.add_argument("--wall-deep-second-overhang-power-plus", type=float, default=0.10, help="Secondary pass overhang power X+")
    parser.add_argument("--wall-deep-second-overhang-power-minus", type=float, default=0.10, help="Secondary pass overhang power X-")
    
    parser.add_argument("--wall-retract", type=float, default=5.0)
    parser.add_argument("--wall-max-retract", type=float, default=8.0)
    parser.add_argument("--wall-standby-temp-drop", type=float, default=0.0)
                        
    # ── Purge args ──
    parser.add_argument("--enable-purge", action="store_true", help="Enable mid-air purge (poop) to prime nozzle")
    parser.add_argument("--purge-x", type=float, default=5.0, help="X coordinate for mid-air purge")
    parser.add_argument("--purge-y", type=float, default=5.0, help="Y coordinate for mid-air purge")
    parser.add_argument("--purge-extra", type=float, default=25.0, help="Extra extrusion amount to prime nozzle")
    
    args = parser.parse_args()
    
    # Rename args.z_hop to args.z_hop so it matches string 'z_hop'
    args.z_hop = max(0.2, args.z_hop)
    args.gcode_file = " ".join(args.gcode_file)
    try:
        process_calibration(args.gcode_file, args.mode, args)
    except Exception as e:
        import traceback
        error_log = os.path.join(os.path.dirname(os.path.abspath(__file__)), "process_matrix_error.log")
        with open(error_log, "w") as f:
            f.write(f"Arguments: {sys.argv}\n")
            f.write(traceback.format_exc())
        print(f"Error! See log at {error_log}")
        sys.exit(1)
