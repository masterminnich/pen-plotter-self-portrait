# Plan: Plotter extension (issue #2)

An optional **Plotter** panel that fixes the three gaps in plotting the app's output:

1. no time estimate, so no way to choose a detail level
2. no path optimization
3. no direct NextDraw control, so starting a plot is slow

With the panel closed, the app behaves exactly as it does today.

## Defaults (all configurable in the panel's Settings)

| Setting | Default |
|---|---|
| Machine | NextDraw 8511, brushless pen-lift |
| Paper | US Letter (8.5 × 11 in), portrait, 0.5 in margin |
| Other machines | NextDraw 4411, NextDraw 1117, generic Grbl G-code |
| Paper sizes | Letter, Legal, Tabloid, A4, A3, 9 × 12 in, custom |

Settings are saved in the browser (localStorage). They can be exported and imported as JSON, so a tuned setup can be copied to another machine.

## 1. Live time estimate

- Updates as the Detail slider moves or the style changes. Target is within ±15% for a first pass.
- **Acceleration is modelled per segment**, not just length ÷ speed. The squiggly styles have thousands of short segments where the plotter never reaches full speed, and a naive formula would underestimate them badly.
- Shows a breakdown: drawing time, travel time and pen-lift time, along with distance drawn, distance travelled and number of pen lifts.

### Tuning the estimate (built for tomorrow morning)

Every number the estimate uses is an editable field under **Settings → Timing**:

- draw speed and travel speed
- acceleration
- pen-up and pen-down delays
- per-command overhead

Change any of them and the estimate recalculates immediately.

**Auto-calibrate.** When a plot finishes, the app records the actual time next to the estimate. One click on **Calibrate from last plot** fits a correction factor. Each plot is logged with its style, detail, estimate, actual time and error. The log can be exported as CSV, so after a few plots it's clear which term (drawing, travel or lifts) is off.

## 2. Path optimization (in the browser)

1. **Size to paper.** Convert the camera-pixel SVG (640×480) to millimetres on the chosen paper, centred inside the margins.
2. **Flatten every path command.** That includes curves and the arcs Blueprint uses; each becomes a polyline.
3. **Merge lines.** Join paths whose endpoints are within 0.5 mm of each other (the threshold is configurable), reversing a path where that helps.
4. **Sort lines.** Order paths by nearest neighbour and flip their direction where that cuts down travel between them.
5. **Show the gain.** Display before/after pen lifts and travel distance, with an optional overlay of the travel moves on the preview.

Optimization runs when a photo is frozen, or once the slider settles. It does not run on every live camera frame. The live view estimates from the unoptimized paths and labels the number as such.

**Download SVG** gains a "plot-ready" option: the optimized SVG at real size in mm. It works in the NextDraw desktop software as a fallback.

## 3. Direct NextDraw control (Web Serial)

This requires Chrome or Edge on the computer the NextDraw is plugged into. Open the preview URL, then press Connect.

- **Commands:** EBB protocol. I'll check pen-up/down polarity, the brushless pen-lift commands, step scaling and motor-axis mapping against Bantam's official `nextdraw` Python library before relying on them. The issue's `SP,1` = down is believed to be backwards.
- **Motion:** each move is split into timed step commands with acceleration, sent through a small buffer so pause and cancel take effect quickly.
- **Control panel:** Connect / Disconnect, pen-up and pen-down height sliders with Test Up / Test Down, Start, Pause / Resume, Cancel, a progress bar, % complete, and elapsed and remaining time. The remaining time uses the calibrated estimate.
- **Safety:**
  - every move is checked against the paper bounds, and a plot is refused if any move falls outside them
  - plotting starts at a conservative speed
  - Dry run traces the drawing with the pen up
  - Cancel stops the motors, raises the pen and returns home
- **Calibration helpers:**
  - Draw 50 mm test square, to verify steps per mm
  - Walk home
  - Motors off, to move the carriage by hand
- **Grbl / Bantam:** G-code generation plus a **Download G-code** button. Streaming G-code straight to a Grbl machine is out of scope for now.

## Out of scope for this pass

- A server backend (vpype / nextdraw command-line tool). The app stays fully in-browser.
- Serpentine hatching. No current style draws hatching, so it would be a new style, not part of the plotting pipeline.

## Verification (no hardware available overnight)

- Automated tests for the path flattener (every SVG command), merge and sort, the estimator and the motor math.
- A round-trip test that converts the generated EBB commands back into a drawing and checks it matches the input path within one step.
- A software stand-in for the NextDraw, used to test the serial manager (buffering, pause / resume / cancel) and the full UI in a browser.
- All 13 styles run through optimize → estimate → G-code without errors.

## Morning checklist (for Joe)

1. Open https://joe-pen-plotter-self-portrait.sklabs.app in Chrome, open the Plotter panel and Connect.
2. Use Test Up / Test Down to set the pen heights.
3. Draw the 50 mm test square and measure it. If it's off, adjust steps per mm.
4. Do a dry run (pen up) of a simple style.
5. Plot one Outline and one Squiggly, then use **Calibrate from last plot** after each.
6. Note anything odd in the plot log and send it back.

Work stays on the `sandbox/joe` branch. Nothing is pushed to GitHub until Joe says so.
