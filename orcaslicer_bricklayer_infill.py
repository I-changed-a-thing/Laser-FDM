import sys
import re
import math
import argparse

def get_val(line, key):
    m = re.search(r'\b' + key + r'([0-9\.\-]+)', line)
    return float(m.group(1)) if m else None

def strip_z(line):
    return re.sub(r'\sZ[0-9\.\-]+', '', line)

def process_gcode(input_file, extrusion_multiplier=1.0, retract_len=0.8, retract_speed=2400, z_hop=0.4):
    with open(input_file, 'r', encoding='latin1') as f:
        lines = f.readlines()
        
    out_lines = []
    
    current_type = None
    last_infill_type = None
    last_infill_width = None
    layer_height = 0.20
    Z_OFFSET_PERCENT = 0.5
    
    current_x = None
    current_y = None
    current_z = None
    current_e = None
    current_f = None
    
    is_relative_e = False
    
    current_retraction = 0.0
    
    buffer_start_x = None
    buffer_start_y = None
    buffer_start_z = None
    buffer_start_e = None
    buffer_start_f = None
    
    infill_buffer = []
    
    current_object_name = None
    
    layer_pass2_buffer = []
    
    def flush_layer_pass2():
        nonlocal layer_pass2_buffer, out_lines
        if not layer_pass2_buffer:
            return
            
        out_lines.append('; [Bricklayer] === END OF LAYER PASS 2 ===\n')
        
        base_z = layer_pass2_buffer[0]['base_z']
        target_z = base_z + (layer_height * Z_OFFSET_PERCENT)
        
        out_lines.append(f';Z:{target_z:.3f}\n')
        out_lines.append(f'G0 Z{target_z:.3f} F30000 ; [Bricklayer] Raise Z\n')
        
        if current_retraction > 0.001:
            if is_relative_e:
                out_lines.append(f'G1 E{current_retraction:.5f} F{retract_speed:.0f} ; [Bricklayer] Unretract slicer state\n')
            else:
                out_lines.append(f'M83 ; [Bricklayer] Temp relative\n')
                out_lines.append(f'G1 E{current_retraction:.5f} F{retract_speed:.0f} ; [Bricklayer] Unretract slicer state\n')
                out_lines.append(f'M82 ; [Bricklayer] Restore absolute\n')
        
        last_pass2_cx = current_x
        last_pass2_cy = current_y
        
        for item in layer_pass2_buffer:
            obj_name = item['object']
            if obj_name:
                out_lines.append(f'EXCLUDE_OBJECT_START NAME={obj_name}\n')
                
            infill_type = item['type']
            if infill_type:
                out_lines.append(f';TYPE:{infill_type}\n')
                
            infill_width = item['width']
            if infill_width:
                out_lines.append(f';WIDTH:{infill_width}\n')
                
            pass2_cx = last_pass2_cx if last_pass2_cx is not None else item['start_x']
            pass2_cy = last_pass2_cy if last_pass2_cy is not None else item['start_y']
            
            for chunk_idx, chunk in enumerate(item['chunks']):
                reverse = (chunk_idx % 2 == 1)
                
                extruding_lines = [p for p in chunk if p['is_extruding']]
                
                if not extruding_lines:
                    for p in chunk:
                        out_lines.append(strip_z(p['raw']))
                        pass2_cx = p['x'] if p['x'] is not None else pass2_cx
                        pass2_cy = p['y'] if p['y'] is not None else pass2_cy
                    continue
                
                start_e = extruding_lines[0]['start_e']
                if start_e is not None and not is_relative_e:
                    out_lines.append(f'G92 E{start_e:.5f} ; [Bricklayer] Sync E\n')
                    
                if reverse:
                    start_x = extruding_lines[-1]['x'] if extruding_lines[-1]['x'] is not None else pass2_cx
                    start_y = extruding_lines[-1]['y'] if extruding_lines[-1]['y'] is not None else pass2_cy
                else:
                    start_x = extruding_lines[0]['start_x'] if extruding_lines[0]['start_x'] is not None else pass2_cx
                    start_y = extruding_lines[0]['start_y'] if extruding_lines[0]['start_y'] is not None else pass2_cy
                    
                if start_x is not None and start_y is not None:
                    travel_dist = 0.0
                    if pass2_cx is not None and pass2_cy is not None:
                        travel_dist = math.hypot(start_x - pass2_cx, start_y - pass2_cy)
                        
                    did_retract = False
                    if travel_dist > 2.0:
                        if is_relative_e:
                            out_lines.append(f'G1 E-{retract_len:.5f} F{retract_speed:.0f} ; [Bricklayer] Retract\n')
                        elif start_e is not None:
                            out_lines.append(f'G1 E{start_e - retract_len:.5f} F{retract_speed:.0f} ; [Bricklayer] Retract\n')
                        did_retract = True
                        
                    if did_retract and z_hop > 0:
                        out_lines.append(f'G0 Z{target_z + z_hop:.3f} F30000 ; [Bricklayer] Z-hop up\n')
                        
                    out_lines.append(f'G0 X{start_x:.3f} Y{start_y:.3f} F30000 ; [Bricklayer] Travel\n')
                    
                    if did_retract and z_hop > 0:
                        out_lines.append(f'G0 Z{target_z:.3f} F30000 ; [Bricklayer] Z-hop down\n')
                        
                    if did_retract:
                        if is_relative_e:
                            out_lines.append(f'G1 E{retract_len:.5f} F{retract_speed:.0f} ; [Bricklayer] Unretract\n')
                        elif start_e is not None:
                            out_lines.append(f'G1 E{start_e:.5f} F{retract_speed:.0f} ; [Bricklayer] Unretract\n')
                    
                start_f = extruding_lines[-1]['f'] if reverse else extruding_lines[0]['f']
                if start_f is not None:
                    out_lines.append(f'G1 F{start_f:.0f} ; [Bricklayer] Restore F\n')
                    
                running_e = start_e if start_e is not None else 0.0
                iterable = reversed(extruding_lines) if reverse else chunk
                    
                for p in iterable:
                    if not p['is_extruding']:
                        if not reverse:
                            out_lines.append(strip_z(p['raw']))
                            pass2_cx = p['x'] if p['x'] is not None else pass2_cx
                            pass2_cy = p['y'] if p['y'] is not None else pass2_cy
                        continue
                        
                    if reverse:
                        target_x = p['start_x']
                        target_y = p['start_y']
                    else:
                        target_x = p['x']
                        target_y = p['y']
                        
                    start_val = p['start_e'] if p['start_e'] is not None else 0.0
                    if is_relative_e:
                        delta_e = p['e'] if p['e'] is not None else 0.0
                    else:
                        delta_e = p['e'] - start_val if p['e'] is not None else 0.0
                    
                    if delta_e > 0 and p['dist'] > 0:
                        new_delta = delta_e * extrusion_multiplier
                    else:
                        new_delta = delta_e
                        
                    running_e += new_delta
                    
                    if reverse:
                        line = "G1"
                        if target_x is not None: line += f" X{target_x:.3f}"
                        if target_y is not None: line += f" Y{target_y:.3f}"
                        if is_relative_e:
                            line += f" E{new_delta:.5f}\n"
                        else:
                            line += f" E{running_e:.5f}\n"
                    else:
                        line = strip_z(p['raw'])
                        if is_relative_e:
                            line = re.sub(r'E[0-9\.\-]+', f'E{new_delta:.5f}', line)
                        else:
                            line = re.sub(r'E[0-9\.\-]+', f'E{running_e:.5f}', line)
                        
                    out_lines.append(line)
                    pass2_cx = target_x if target_x is not None else pass2_cx
                    pass2_cy = target_y if target_y is not None else pass2_cy
                    
            if obj_name:
                out_lines.append(f'EXCLUDE_OBJECT_END NAME={obj_name}\n')
                
            last_pass2_cx = pass2_cx
            last_pass2_cy = pass2_cy
            
        if current_retraction > 0.001:
            if is_relative_e:
                out_lines.append(f'G1 E-{current_retraction:.5f} F{retract_speed:.0f} ; [Bricklayer] Restore slicer state\n')
            else:
                out_lines.append(f'M83 ; [Bricklayer] Temp relative\n')
                out_lines.append(f'G1 E-{current_retraction:.5f} F{retract_speed:.0f} ; [Bricklayer] Restore slicer state\n')
                out_lines.append(f'M82 ; [Bricklayer] Restore absolute\n')

        out_lines.append(f';Z:{base_z:.3f}\n')
        out_lines.append(f'G0 Z{base_z:.3f} F30000 ; [Bricklayer] Restore Z\n')
        if current_e is not None and not is_relative_e:
            out_lines.append(f'G92 E{current_e:.5f} ; [Bricklayer] Restore E for next feature\n')
            
        layer_pass2_buffer.clear()
        
    def flush_infill_buffer():
        nonlocal infill_buffer, current_x, current_y, current_z, current_e
        if not infill_buffer:
            return
            
        parsed_lines = []
        cx, cy, cz, ce, cf = buffer_start_x, buffer_start_y, buffer_start_z, buffer_start_e, buffer_start_f
        
        longest_dist = 0.0
        main_angle = None
        
        for line in infill_buffer:
            x = get_val(line, 'X')
            y = get_val(line, 'Y')
            z = get_val(line, 'Z')
            e = get_val(line, 'E')
            f = get_val(line, 'F')
            
            mx = x if x is not None else cx
            my = y if y is not None else cy
            mz = z if z is not None else cz
            me = e if e is not None else ce
            mf = f if f is not None else cf
            
            is_extruding = False
            if e is not None:
                if is_relative_e:
                    is_extruding = (e > 0)
                else:
                    if ce is not None:
                        is_extruding = (e > ce)
                    else:
                        is_extruding = (e > 0)
            
            dist = 0.0
            angle = None
            
            if mx is not None and my is not None and cx is not None and cy is not None:
                if x is not None or y is not None:
                    dx = mx - cx
                    dy = my - cy
                    dist = math.hypot(dx, dy)
                    if dist > 0.001:
                        angle = math.degrees(math.atan2(dy, dx)) % 180
            
            parsed_lines.append({
                'raw': line,
                'x': mx, 'y': my, 'z': mz, 'e': me, 'f': mf,
                'start_x': cx, 'start_y': cy,
                'start_e': ce,
                'is_extruding': is_extruding,
                'dist': dist,
                'angle': angle
            })
            
            if is_extruding and dist > longest_dist:
                longest_dist = dist
                main_angle = angle
                
            cx, cy, cz, ce, cf = mx, my, mz, me, mf
            
        if main_angle is None:
            for p in parsed_lines:
                out_lines.append(p['raw'])
            infill_buffer.clear()
            return

        chunks = []
        current_chunk = []
        in_path = False
        
        for p in parsed_lines:
            is_infill_line = False
            if p['is_extruding'] and p['angle'] is not None:
                diff = abs(p['angle'] - main_angle)
                diff = min(diff, 180 - diff)
                if diff < 20:
                    is_infill_line = True
                    
            if is_infill_line:
                if not in_path:
                    if current_chunk:
                        chunks.append(current_chunk)
                    current_chunk = []
                    in_path = True
            else:
                if in_path:
                    in_path = False
            
            current_chunk.append(p)
            
        if current_chunk:
            chunks.append(current_chunk)
            
        out_lines.append("; [Bricklayer] --- PASS 1 (Base Height) ---\n")
        
        pass1_cx, pass1_cy = buffer_start_x, buffer_start_y
        final_pass1_e = 0.0
        
        pass1_indices = list(range(0, len(chunks), 2))
        for i, chunk_idx in enumerate(pass1_indices):
            chunk = chunks[chunk_idx]
            reverse = (i % 2 == 1)
            
            extruding_lines = [p for p in chunk if p['is_extruding']]
            
            if not extruding_lines:
                for p in chunk:
                    out_lines.append(p['raw'])
                    pass1_cx = p['x'] if p['x'] is not None else pass1_cx
                    pass1_cy = p['y'] if p['y'] is not None else pass1_cy
                continue
                
            start_e = extruding_lines[0]['start_e']
            if start_e is not None and not is_relative_e:
                out_lines.append(f"G92 E{start_e:.5f} ; [Bricklayer] Sync E\n")
                
            if reverse:
                start_x = extruding_lines[-1]['x'] if extruding_lines[-1]['x'] is not None else pass1_cx
                start_y = extruding_lines[-1]['y'] if extruding_lines[-1]['y'] is not None else pass1_cy
            else:
                start_x = extruding_lines[0]['start_x'] if extruding_lines[0]['start_x'] is not None else pass1_cx
                start_y = extruding_lines[0]['start_y'] if extruding_lines[0]['start_y'] is not None else pass1_cy
                
            if start_x is not None and start_y is not None:
                travel_dist = 0.0
                if pass1_cx is not None and pass1_cy is not None:
                    travel_dist = math.hypot(start_x - pass1_cx, start_y - pass1_cy)
                    
                did_retract = False
                if travel_dist > 2.0:
                    if is_relative_e:
                        out_lines.append(f'G1 E-{retract_len:.5f} F{retract_speed:.0f} ; [Bricklayer] Retract\n')
                    elif start_e is not None:
                        out_lines.append(f'G1 E{start_e - retract_len:.5f} F{retract_speed:.0f} ; [Bricklayer] Retract\n')
                    did_retract = True
                    
                if did_retract and z_hop > 0:
                    out_lines.append(f'G0 Z{buffer_start_z + z_hop:.3f} F30000 ; [Bricklayer] Z-hop up\n')
                    
                out_lines.append(f"G0 X{start_x:.3f} Y{start_y:.3f} F30000 ; [Bricklayer] Travel\n")
                
                if did_retract and z_hop > 0:
                    out_lines.append(f'G0 Z{buffer_start_z:.3f} F30000 ; [Bricklayer] Z-hop down\n')
                    
                if did_retract:
                    if is_relative_e:
                        out_lines.append(f'G1 E{retract_len:.5f} F{retract_speed:.0f} ; [Bricklayer] Unretract\n')
                    elif start_e is not None:
                        out_lines.append(f'G1 E{start_e:.5f} F{retract_speed:.0f} ; [Bricklayer] Unretract\n')
                
            start_f = extruding_lines[-1]['f'] if reverse else extruding_lines[0]['f']
            if start_f is not None:
                out_lines.append(f"G1 F{start_f:.0f} ; [Bricklayer] Restore F\n")
                
            running_e = start_e if start_e is not None else 0.0
            iterable = reversed(extruding_lines) if reverse else chunk
            
            for p in iterable:
                if not p['is_extruding']:
                    if not reverse:
                        out_lines.append(p['raw'])
                        pass1_cx = p['x'] if p['x'] is not None else pass1_cx
                        pass1_cy = p['y'] if p['y'] is not None else pass1_cy
                    continue
                    
                if reverse:
                    target_x = p['start_x']
                    target_y = p['start_y']
                else:
                    target_x = p['x']
                    target_y = p['y']
                    
                start_val = p['start_e'] if p['start_e'] is not None else 0.0
                if is_relative_e:
                    delta_e = p['e'] if p['e'] is not None else 0.0
                else:
                    delta_e = p['e'] - start_val if p['e'] is not None else 0.0
                
                if delta_e > 0 and p['dist'] > 0:
                    new_delta = delta_e * extrusion_multiplier
                else:
                    new_delta = delta_e
                    
                running_e += new_delta
                
                if reverse:
                    line = "G1"
                    if target_x is not None: line += f" X{target_x:.3f}"
                    if target_y is not None: line += f" Y{target_y:.3f}"
                    if is_relative_e:
                        line += f" E{new_delta:.5f}\n"
                    else:
                        line += f" E{running_e:.5f}\n"
                else:
                    line = p['raw']
                    if is_relative_e:
                        line = re.sub(r'E[0-9\.\-]+', f'E{new_delta:.5f}', line)
                    else:
                        line = re.sub(r'E[0-9\.\-]+', f'E{running_e:.5f}', line)
                    
                out_lines.append(line)
                pass1_cx = target_x if target_x is not None else pass1_cx
                pass1_cy = target_y if target_y is not None else pass1_cy
                
            final_pass1_e = running_e
                
        if len(chunks) > 1:
            pass2_chunks = [chunks[i] for i in range(1, len(chunks), 2)]
            
            layer_pass2_buffer.append({
                "object": current_object_name,
                "type": last_infill_type,
                "width": last_infill_width,
                "chunks": pass2_chunks,
                "base_z": buffer_start_z if buffer_start_z is not None else 0.0,
                "start_x": pass1_cx,
                "start_y": pass1_cy
            })
            
        expected_x, expected_y = None, None
        for p in reversed(parsed_lines):
            if expected_x is None and p['x'] is not None: expected_x = p['x']
            if expected_y is None and p['y'] is not None: expected_y = p['y']
            if expected_x is not None and expected_y is not None: break
            
        if expected_x is not None and expected_y is not None:
            travel_dist = math.hypot(expected_x - pass1_cx, expected_y - pass1_cy)
            if travel_dist > 0.01:
                did_retract = False
                if travel_dist > 2.0:
                    if is_relative_e:
                        out_lines.append(f'G1 E-{retract_len:.5f} F{retract_speed:.0f} ; [Bricklayer] Retract for sync\n')
                    else:
                        out_lines.append(f'G92 E{final_pass1_e + retract_len:.5f} ; [Bricklayer] Sync E\n')
                        out_lines.append(f'G1 E{final_pass1_e:.5f} F{retract_speed:.0f} ; [Bricklayer] Retract for sync\n')
                    did_retract = True
                    
                if did_retract and z_hop > 0:
                    out_lines.append(f'G0 Z{buffer_start_z + z_hop:.3f} F30000 ; [Bricklayer] Z-hop up\n')
                    
                out_lines.append(f'G0 X{expected_x:.3f} Y{expected_y:.3f} F30000 ; [Bricklayer] Sync position\n')
                
                if did_retract and z_hop > 0:
                    out_lines.append(f'G0 Z{buffer_start_z:.3f} F30000 ; [Bricklayer] Z-hop down\n')
                    
                if did_retract:
                    if is_relative_e:
                        out_lines.append(f'G1 E{retract_len:.5f} F{retract_speed:.0f} ; [Bricklayer] Unretract\n')
                    else:
                        out_lines.append(f'G1 E{final_pass1_e + retract_len:.5f} F{retract_speed:.0f} ; [Bricklayer] Unretract\n')
                        out_lines.append(f'G92 E{final_pass1_e:.5f} ; [Bricklayer] Restore E\n')

        if not is_relative_e and current_e is not None:
            out_lines.append(f'G92 E{current_e:.5f} ; [Bricklayer] Resync absolute E\n')

        infill_buffer.clear()

    for line in lines:
        stripped = line.strip()
        
        if stripped.startswith('EXCLUDE_OBJECT_START'):
            m = re.search(r'NAME=([^\s]+)', stripped)
            if m:
                current_object_name = m.group(1)
        elif stripped.startswith('EXCLUDE_OBJECT_END'):
            current_object_name = None
            
        if stripped.startswith('; layer_height ='):
            try:
                layer_height = float(stripped.split('=')[1].strip())
            except ValueError:
                pass
        elif stripped.startswith(';HEIGHT:'):
            try:
                layer_height = float(stripped.split(':')[1].strip())
            except ValueError:
                pass
                
        if stripped == 'M82' or stripped.startswith('M82 '):
            is_relative_e = False
            out_lines.append(line)
            continue
        elif stripped == 'M83' or stripped.startswith('M83 '):
            is_relative_e = True
            out_lines.append(line)
            continue
            
        if stripped.startswith('EXCLUDE_OBJECT') or stripped.startswith(';LAYER_CHANGE') or stripped.startswith(';LAYER:'):
            flush_infill_buffer()
            if stripped.startswith(';LAYER_CHANGE') or stripped.startswith(';LAYER:'):
                flush_layer_pass2()
            current_type = None
            out_lines.append(line)
            continue
            
        if stripped.startswith(';TYPE:'):
            new_type = stripped.split(':')[1].strip()
            
            if new_type in ('Solid infill', 'Internal solid infill') and current_type not in ('Solid infill', 'Internal solid infill'):
                buffer_start_x = current_x
                buffer_start_y = current_y
                buffer_start_z = current_z
                buffer_start_e = current_e
                buffer_start_f = current_f
                last_infill_type = new_type
                
            if current_type in ('Solid infill', 'Internal solid infill') and new_type not in ('Solid infill', 'Internal solid infill'):
                flush_infill_buffer()
                
            current_type = new_type
            out_lines.append(line)
            continue
            
        if stripped.startswith(';WIDTH:'):
            if current_type in ('Solid infill', 'Internal solid infill'):
                last_infill_width = stripped.split(':')[1].strip()
            out_lines.append(line)
            continue
            
        if not stripped.startswith(';'):
            x = get_val(stripped, 'X')
            y = get_val(stripped, 'Y')
            z = get_val(stripped, 'Z')
            e = get_val(stripped, 'E')
            f = get_val(stripped, 'F')
            
            if x is not None: current_x = x
            if y is not None: current_y = y
            if z is not None: current_z = z
            if f is not None: current_f = f
            
            if e is not None:
                if is_relative_e:
                    if e < -0.0001:
                        current_retraction += abs(e)
                    elif e > 0.0001:
                        current_retraction = max(0.0, current_retraction - e)
                else:
                    if current_e is not None:
                        delta_e = e - current_e
                        if delta_e < -0.0001:
                            current_retraction += abs(delta_e)
                        elif delta_e > 0.0001:
                            current_retraction = max(0.0, current_retraction - delta_e)
                current_e = e
            
        if current_type in ('Solid infill', 'Internal solid infill'):
            infill_buffer.append(line)
        else:
            out_lines.append(line)
            
    flush_infill_buffer()
    flush_layer_pass2()
    
    with open(input_file, 'w', encoding='latin1') as f:
        f.writelines(out_lines)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Process G-code for Bricklayer infill.")
    parser.add_argument("input_file", help="Path to the G-code file")
    parser.add_argument("--extrusion-multiplier", type=float, default=1.0, help="Multiplier for extrusion amount (default: 1.0)")
    parser.add_argument("--retract-length", type=float, default=0.8, help="Length to retract on long travel moves (default: 0.8)")
    parser.add_argument("--retract-speed", type=float, default=2400.0, help="Speed for retractions in mm/min (default: 2400)")
    parser.add_argument("--z-hop", type=float, default=0.4, help="Z-hop distance during injected travels (default: 0.4)")
    args = parser.parse_args()
    
    process_gcode(args.input_file, args.extrusion_multiplier, args.retract_length, args.retract_speed, args.z_hop)
