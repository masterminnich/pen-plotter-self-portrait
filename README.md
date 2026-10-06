Pen-Plot Self-Portrait

This is a small client-side web app that:
- uses your camera to take a selfie
- runs person segmentation (BodyPix) to remove the background
- vectorizes the person into an SVG using ImageTracer
- offers many styles
- exports an SVG with stroke-only black paths suitable for pen plotting

Quick start (from the folder that contains these files):

1) Run a simple local HTTP server (required for camera access in modern browsers):

```bash
# Python 3
python -m http.server 8000
```

2) Open http://localhost:8000/pen-plot-app/ in Chrome or Firefox, allow camera access, then use the controls.

Notes:
- Model files (BodyPix) are downloaded from CDN at runtime — first run may be slow.
- This is a client-only demo; no images are uploaded to any server.

Files:
- index.html — main UI
- style.css — simple styling
- app.js — logic: camera, segmentation, vectorization, download

## Plotter panel (optional)

Click **Plotter** in the top bar to open a side panel. While the panel is closed the app works exactly as before.

What the panel does:

- **Time estimate** for the current drawing.
  - It updates as you change the style or the Detail slider.
  - It shows a breakdown: drawing, travel and pen-lift time, plus distances and the number of lifts.
  - The motion model includes acceleration and slowing down at corners, so plots made of many tiny strokes aren't
    underestimated.
  - With the live camera running, the estimate is unoptimized and labelled that way. Press **Freeze** to get the
    optimized figure.
- **Path optimization** joins lines that touch and reorders them so the pen travels less in the air. The panel shows
  pen lifts and travel before and after, and can overlay the travel moves on the preview.
- **Download plot-ready SVG** gives the optimized drawing at real size in mm. It also works in the NextDraw desktop
  software.
- **Download G-code** is for Grbl-style plotters.
- **Direct NextDraw control** over USB (Web Serial, Chrome or Edge only):
  - Connect, pen height sliders with Test Up / Test Down
  - Start, Dry run, Pause / Resume, Cancel, with a progress bar and elapsed / remaining time
  - Draw 50 mm test square, Walk home, Motors off
- **Plot log and calibration.** Every finished plot is logged with its estimate and the actual time.
  - *Calibrate from last plot* fits a correction factor.
  - *Fit each term* fits separate factors for drawing, travel and lifts.
  - The log exports as CSV.
- **Settings** cover the machine (NextDraw 8511 / 1117 / 2234, other EBB machines, generic Grbl), paper size and
  margins, every timing number, the optimizer and G-code commands. They are saved in the browser and can be exported
  or imported as JSON.

Add `?mockplotter=1` to the URL to try everything against a simulated NextDraw, which draws what the pen would draw.

See [docs/MORNING.md](docs/MORNING.md) for first-time setup on a real machine and how to tune the time estimate.
[docs/nextdraw-protocol.md](docs/nextdraw-protocol.md) has the protocol notes and sources, and
[docs/style-results.md](docs/style-results.md) has the per-style numbers.

### Code layout

All plotter code is in `plotter/`. Each file is a plain script with no build step, and the same files load in Node
for the tests.

| File | What it does |
|---|---|
| `svgpath.js` | SVG path parser and flattener (every command, curves and arcs to a tolerance) |
| `optimize.js` | Joins paths, sorts them nearest-first with direction flipping, simplifies |
| `settings.js` | Machines, paper sizes, defaults, page layout, pen-lift maths, plot log and calibration |
| `motion.js` | Motion planner with acceleration and cornering. It is shared by the estimate and the NextDraw output. |
| `ebb.js` | NextDraw (EBB) commands, bounds check, and a decoder used by the tests |
| `gcode.js` | G-code output |
| `pipeline.js` | SVG → paper mm → optimized → machine mm → estimate |
| `serial.js` | Web Serial connection: replies, in-flight window, pause / resume / cancel |
| `mock.js` | The simulated NextDraw |
| `ui.js`, `plotter.css` | The panel |

### Tests

```bash
node --test                                   # unit and end-to-end tests (Node 18+, no installs)
node tools/style-report.js                    # savings and estimates for all 13 styles
python3 tools/browser_check.py                # headless Chrome check of the real page (needs playwright)
python3 tools/capture_fixtures.py             # re-capture the style SVGs used by the tests
```

The test portrait (`test/fixtures/portrait-sally-ride-nasa-public-domain.jpg`) is NASA's official 1984 portrait of
Sally Ride, which is in the public domain.
