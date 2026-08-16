# Laser 3D Printer - User Guide

Welcome to the Laser 3D Printer User Guide! This manual explains all the features available in the software, what they actually do to your 3D print, and what every single setting changes so you can get the most out of the script.

---

## 1. Top Surface Smoothing
**What it does:** Once your printer finishes the top layers of a part, it lifts the nozzle slightly and uses a laser to trace a zig-zag pattern over the surface. The heat from the laser gently melts the top layer, reflowing the plastic into a perfectly smooth, glossy finish that hides all extrusion lines.

**Settings:**
*   **Enable:** Turns the feature on or off.
*   **Power:** How strong the laser fires (PWM percentage). Too high causes boiling; too low won't melt the surface.
*   **Speed:** How fast the toolhead moves in mm/s. Slower speeds allow heat to soak deeper.
*   **Grid Spacing:** The distance between the laser zig-zag lines. A smaller spacing (e.g., `0.2mm`) ensures no gaps are left un-melted, but takes longer to print.
*   **Z-Hop:** Lifts the nozzle (e.g., `0.5mm`) so it doesn't drag through the freshly melted plastic while the laser is running.
*   **Overshoot:** The laser will run slightly past the edge of the part before turning around. This prevents the laser from lingering at the edges while the printer decelerates, avoiding burnt corners.
*   **Overshoot Without Laser:** Turns the laser off during the overshoot move so it doesn't fire into thin air.
*   **Passes:** How many times the laser traces the entire surface.
*   **No Alternate:** By default, each pass rotates the zig-zag direction. Enabling this forces all passes to run in the exact same direction.
*   **Angle:** The starting angle (in degrees) of the laser zig-zag pattern.
*   **Angle Step:** How many degrees the pattern rotates on each subsequent pass (default is 90 degrees, creating a crosshatch pattern).
*   **Fan Speed:** Forces the part cooling fan to a specific speed (0-255) during smoothing to cool the plastic immediately after melting.
*   **Preheat Delay:** Forces the laser to turn on and wait in one spot for a few milliseconds before moving, ensuring the start of the line melts properly.
*   **Group Slopes:** Tries to group slanted top surfaces together for smoother continuous sweeps.
*   **Smart Chunking:** If a top surface is too massive, the plastic might warp. This breaks large flat surfaces into smaller "chunks" (e.g., 20mm squares) and smooths them one by one.
*   **Chunk Size:** The maximum size of the chunks in mm.
*   **Chunk No Full Pass:** Disables the final "blending" pass that usually runs over the entire surface to hide the seams between chunks.
*   **Chunk Full Pass Power:** The specific laser power used for that final blending pass.
*   **Area Boost:** Automatically increases laser power on massive surfaces because large areas dissipate heat much faster than tiny spots.
*   **Area Boost (Multiplier):** How much extra power to add at maximum boost (e.g., `0.6` = +60%).
*   **Area Max:** The maximum size (mm²) where the boost hits its ceiling.
*   **Area Base:** The size (mm²) where the script begins gradually applying the boost.

---

## 2. Wall Smoothing
**What it does:** Layer lines on vertical walls can be unsightly. Wall Smoothing activates side-mounted lasers to trace the outer perimeter of your print, remelting the sides and fusing the layer lines together into a single, smooth surface.

**Settings:**
*   **Enable:** Turns the feature on or off.
*   **Wall Offset Level:** A quick preset to tell the script the X and Z offset distances of your side-mounted lasers.
*   **Custom X+ / X- / Z Offsets:** Exact physical distance from your nozzle to the laser focal point, overriding the level preset.
*   **Power X+ / Power X-:** The laser power for the left and right side lasers.
*   **Overhang Power X+ / X-:** Specific power settings used only when the wall leans outward (an overhang), as they require less power to melt.
*   **Speed:** How fast the toolhead moves along the wall.
*   **Passes:** Number of times the laser traces the wall on a single layer.
*   **Wall Frequency (Layers):** Instead of running every single layer, you can tell it to run every N layers (e.g., every 3 layers).
*   **Target (Both, Inner, Outer):** Which perimeters to smooth. Usually you only want `Outer`.
*   **Min Path Area:** Skips tiny loops (like small bolt holes) where the laser would just sit and burn the plastic.
*   **Angle Tolerance:** Skips walls that lean beyond this angle (aggressive overhangs) to prevent them from drooping.
*   **Corner Power Drop:** Reduces laser power at sharp corners to prevent them from rounding off or melting away.
*   **Corner Distance:** How far from the apex of the corner the power drop begins.
*   **Overshoot:** Extends the wall trace slightly past the start point to ensure the seam is fully melted.
*   **Retract / Max Retract:** Retracts the filament inside the nozzle so it doesn't ooze out while the laser is smoothing the wall.
*   **Standby Temp Drop:** Lowers the hotend temperature temporarily while performing long smoothing operations to prevent filament degradation.
*   **Deep Mode:** Instead of tracing horizontally, the laser pauses and sweeps vertically up and down across multiple layers, deeply fusing a thick vertical chunk.
*   **Z-Divisions:** How many vertical slices to make during Deep Mode.
*   **Deep Overhang Angle:** A stricter angle tolerance for Deep Mode.
*   **Deep Overlap:** How many layers to overlap the vertical sweeps so horizontal seams don't form between chunks.
*   **Deep Safety / Max Layer Safety:** Leaves the very top layers untouched by the deep sweep so the nozzle doesn't collide with them later.
*   **Deep Bottom Up:** Reverses the sweep to start from the bottom and move upward.
*   **Deep Interlace:** Staggers the vertical sweeps to prevent heat from building up in one spot.
*   **Deep Delay Passes:** Waits until the whole wall is done before starting the second pass to allow cooling.
*   **Deep Fade:** Tapers off the power at the very end of a deep sweep to leave a pristine finish.
*   **Wobble Mode:** Rapidly wiggles the laser left/right as it moves along the wall to artificially widen the melt zone without increasing power.
*   **Wobble Projection Factor:** How wide the wiggle should be.
*   **Wobble Pull Only:** Forces the wobble to only happen in directions moving away from the nozzle to prevent crashing into fresh plastic.
*   **Wobble Pull Continuous:** Smooths out the zig-zag into a more continuous wave.
*   **Deep Wobble / Seam Wobble:** Special parameters combining deep vertical sweeps with high-frequency horizontal wiggling for maximum blending.
*   **Pass 2 Mode:** Allows you to run a second, entirely different smoothing strategy immediately after the first pass finishes.

---

## 3. Laser Riveting
**What it does:** FDM 3D prints are notoriously weak along the Z-axis. Riveting pulses the laser at very high power while standing still. This melts a deep "plug" straight down through multiple layers, permanently anchoring them together.

**Settings:**
*   **Enable:** Turns the feature on or off.
*   **Rivet Power:** Must be high enough to penetrate deeply, but low enough to not burn the plastic.
*   **Rivet Time (Dwell):** How long (in milliseconds) the laser stays on in one spot.
*   **Spacing:** Distance between individual rivets in the grid.
*   **Rivet Frequency (Layers):** How often to insert a layer of rivets (e.g., every 5 layers).
*   **Min Layer:** Skips riveting on the first few bottom layers so it doesn't burn the build plate.
*   **Margin:** Shrinks the rivet grid inward from the edges of the part so it doesn't punch holes near the visible outer walls.
*   **Min Area:** Skips riveting on parts too small to hold a rivet.
*   **Wobble Radius / Turns / Max Speed:** Instead of standing perfectly still, the laser can orbit in a tiny circle (radius) at high speed while firing, creating a wider, more uniform rivet hole.
*   **Pulse Period / Duty:** Instead of a solid beam, the laser can strobe on and off (e.g. 50% duty cycle) to let heat penetrate deeper without surface burning.
*   **Custom X / Y Offsets:** Defines the exact physical location of the top-down laser.

---

## 4. Preheating
**What it does:** Normally, hot plastic is laid down onto cold plastic, leading to weak bonds. Preheating solves this by firing a laser slightly ahead of the moving nozzle. It pre-melts the surface just milliseconds before the fresh plastic is extruded on top of it, resulting in incredible inter-layer adhesion.

**Settings:**
*   **Enable:** Turns the feature on or off.
*   **Preheat Power:** The base power used. Too high and the plastic will boil.
*   **Reference Speed:** The script automatically scales the laser power based on how fast the toolhead is currently moving. You set the "Reference Speed" (e.g., 50mm/s), and the script calculates everything relative to that.
*   **Min Laser Power:** Hardware minimum limit. If the calculated power drops below this, the laser turns off completely instead of sputtering.
*   **Min Layer:** Skips preheating on the very first few layers.
*   **Trailing Enable:** Activates a second laser located *behind* the nozzle to post-heat the line after it's extruded.
*   **Trailing Ratio:** How strong the trailing laser should be compared to the main preheat laser (e.g., 0.5 = 50% strength).

---

## 5. Annealing
**What it does:** After a layer finishes printing, the laser does a very fast, low-power zig-zag pass over the entire layer. This doesn't melt the plastic, but keeps it warm (in its "crystallization window"). This reduces internal stress, prevents warping, and increases structural strength.

**Settings:**
*   **Enable:** Turns the feature on or off.
*   **Anneal Power:** Must be kept very low. You only want to warm the plastic, not melt it.
*   **Speed:** Usually kept relatively fast to distribute heat evenly.
*   **Spacing:** Distance between the zig-zag lines.
*   **Z-Hop:** Lifts the nozzle so it doesn't drag across the layer.
*   **Overshoot / Overshoot Without Laser:** Extends the path past the edge of the part, optionally turning the laser off during the turn to prevent edge burning.
*   **Min Layer:** Skips annealing on the bottom layers since the heated bed already keeps them warm.
*   **Margin:** Shrinks the annealing path inward from the edge.
*   **Min Area:** Skips annealing on tiny islands.
*   **Angle:** The direction of the annealing zig-zag path.

---

## 6. Structural Infill (Vibration & Bricklayer)
These are special non-laser scripts that alter how your internal infill is printed to make parts stronger.

*   **Z-Axis Vibration:** Rapidly shakes the nozzle up and down while printing infill lines to create corrugated, 3D wave structures inside your part.
    *   **Amplitude:** How high the waves go in mm.
    *   **Wavelength:** How stretched out the waves are in mm.
    *   **Spacing:** Distance between parallel lines.
    *   **Fade:** Gradually flattens the waves near the outer walls so the nozzle doesn't crash into solid perimeters.
    *   **Resolution:** How many microscopic segments the straight lines are broken into to create the wave.
    *   **Sync Phase:** Forces all waves to align perfectly with each other across different lines.

*   **Bricklayer:** Breaks continuous infill lines into staggered, interlocking "bricks" to stop cracks from propagating cleanly through the part.
    *   **Extrusion Multiplier:** Adjusts flow rate for the bricks.
    *   **Retract Length / Speed:** Defines the retraction pulling the filament back between bricks.
    *   **Z-Hop:** Lifts the nozzle between bricks to prevent stringing.
