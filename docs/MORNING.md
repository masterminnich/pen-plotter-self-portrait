# Morning notes for Joe

Hi Joe. The Plotter feature from PLAN.md is built. All of it works against a software stand-in for the
NextDraw, but none of it has touched a real machine yet. This page covers what's there, what still needs the
real plotter, and a step-by-step first session.

## What's built

- **Plotter button and panel.** A **Plotter** button sits in the top bar and opens a side panel. With the panel
  closed, the app looks and behaves as before; the button is the only addition.
- **Live time estimate.**
  - The big number at the top of the panel updates when you change the style or move the Detail slider.
  - Under it is a breakdown of drawing, travel, pen-lift and command-overhead time, plus the distance drawn, the
    distance travelled and the number of pen lifts.
  - It models acceleration on every segment and slows down at corners.
  - The motion planner that produces the estimate also produces the NextDraw commands, so the estimate and the
    machine share one model.
  - With the live camera running it says **live · unoptimized**. After Freeze, or once the slider stops moving, it
    says **optimized**.
- **Path optimization.**
  - Lines whose ends are within 0.5 mm get joined, flipping direction where that helps.
  - Lines are reordered nearest-first, and near-straight extra points are dropped.
  - The panel shows pen lifts and travel before and after.
  - Tick **Show travel moves on the preview** to see the pen-up moves as orange dashes.
  - Savings for all 13 styles are in [style-results.md](style-results.md). For example, Blueprint drops from
    2548 to 831 pen lifts and from 22 to 15 minutes.
- **Downloads.**
  - **Download plot-ready SVG** gives the optimized drawing at true size in mm. It works in the NextDraw desktop
    software as a fallback.
  - **Download G-code** is for Grbl machines.
- **Direct NextDraw control** in Chrome or Edge:
  - Connect, pen height sliders, Test Up / Test Down
  - Start plot, Dry run (pen up), Pause / Resume, Cancel
  - A progress bar showing % done, elapsed and remaining time
  - Draw 50 mm test square, Walk home, Motors off
- **Plot log and calibration.**
  - Every finished plot is logged with its style, detail, the estimate for each part, the actual time and all the
    timing settings.
  - **Calibrate from last plot** and **Fit each term** fix the estimate. **Export CSV** saves the log.
  - If you plot with the NextDraw desktop software instead, type the real minutes into **Plotted elsewhere?** and
    press **Add to log**.
- **Settings.** Everything is under **Settings**: machine, paper, timing, optimizer and G-code. Changes save in the
  browser automatically, and **Export / Import settings** copies a tuned setup to another computer.
- **Simulated NextDraw.** Open the page with `?mockplotter=1` on the end of the address,
  https://joe-pen-plotter-self-portrait.sklabs.app/?mockplotter=1, to try the whole flow without the machine.
  - A small window shows what the simulated pen drew.
  - Simulated plots are marked "(sim)" in the log.
  - Clear the log before your real plots (**Clear log**) so the simulated entries don't mix into calibration.

## What's verified overnight (no hardware)

- **51 automated tests pass** (`node --test`). They cover:
  - every SVG path command, absolute and relative, including arcs and curves
  - merging and sorting: no line is lost and the drawn length is kept
  - the estimate: more detail means more time, lower acceleration means more time, and the job's commands add up
    to exactly the estimate
  - a round trip: the NextDraw commands are decoded back into a drawing and checked against the input to within
    one motor step, with no drift
  - refusal of plots that leave the paper
  - G-code output
  - pause, resume and cancel against the simulated NextDraw
- **All 13 styles**, captured from the real app, go through optimize → estimate → NextDraw commands → G-code
  without errors.
- **The real page in headless Chrome** shows zero console errors with the panel closed, open, in live-camera mode
  and in simulated-plotter mode. A full simulated plot was run, including pause, resume, calibrate, test square,
  dry run and cancel. Screenshots are in [screenshots/](screenshots/).

## Verify in the morning (needs the real NextDraw)

I couldn't confirm these without the machine. Each one has a setting, so nothing needs a code change:

1. **Pen direction.** `SP,1` should lift the pen; I checked this against Bantam's own code, and the issue had it
   backwards. If **Test Up** lowers the pen, tick *Settings → Machine → Swap pen up/down*.
2. **Brushless pen-lift wiring.** The app sends pen moves to output pin B2 with the NextDraw brushless pulse range.
   If Test Up / Test Down do nothing at all, set *Settings → Machine → Pen-lift motor* to **Standard hobby servo**
   and try again. Tell me if that was needed.
3. **Pen heights.** The defaults are 60 % up and 40 % down, the same as NextDraw's. Adjust them with the sliders.
4. **Steps per mm (80).** Worked out from NextDraw's numbers (2032 steps/inch at 16× microstepping). The test
   square checks it.
5. **Axis directions.**
   - The test square should be drawn away from the home corner, with the letter F inside it reading normally
     (not mirrored).
   - If the carriage heads into the frame instead, press **Cancel** or switch the machine off, and report it.
6. **Paper placement.**
   - Letter portrait is taller than the 8511 can reach, so the app turns the drawing sideways.
   - Lay the sheet landscape with its corner at the home position. The top of the picture faces the home (left)
     side.
   - If the paper corner can't sit exactly at the pen's home spot, use *Settings → Paper → Paper corner offset*.
7. **Firmware version.** It is shown after Connect. Bantam's software needs 3.0.2 or newer. If it says
   "(legacy replies)", the app still works, but tell me.
8. **The USB device list.** Chrome should offer a device called "EiBotBoard…". If the list is empty, untick
   *Settings → Machine → Only list NextDraw (EiBotBoard) USB devices*.
9. **Speeds.** The first-plot defaults are deliberately slow: 35 mm/s drawing and 100 mm/s travel. NextDraw's own
   defaults are about 55 and 165. Speed up once a plot looks clean.
10. **Time accuracy.** This is the main thing to tune. See "Tuning the time estimate" below.

The protocol notes, with links to every source, are in [nextdraw-protocol.md](nextdraw-protocol.md).

## Morning checklist

1. **Open the page.** In Chrome (or Edge) on the computer the NextDraw is plugged into, go to
   https://joe-pen-plotter-self-portrait.sklabs.app and click **Plotter** in the top bar. The line under "Plotter"
   should read *NextDraw 8511 · US Letter … portrait · 0.50 in margin*. If you tried `?mockplotter=1`, open
   **Plot log & calibration** and press **Clear log**.
2. **Connect.** Switch the NextDraw on and press **Connect**. Pick the EiBotBoard device in Chrome's list. The
   status should say *Connected · firmware 3.x.x*, and the pen lifts.
3. **Set the pen heights.**
   - Put a pen in the holder and press **Test Down**, then **Test Up**.
   - Move the **Pen up** / **Pen down** sliders and press the Test buttons again until the pen just touches the
     paper when down and clears it well when up.
   - If Test Up lowers the pen, see item 1 in the list above.
4. **Draw the test square.**
   - Press **Motors off** and slide the carriage by hand to the home corner, where the NextDraw software starts.
   - Put a scrap sheet down. Press **Draw 50 mm test square** and answer **OK** when asked if the carriage is at
     home. Keep a hand near the power switch for this first move.
   - Measure the square. Each side should be 50.0 mm, and the F inside should not be mirrored.
   - If the sides are off, set *Settings → Machine → Steps per mm* to 80 × 50 ÷ (what you measured). Draw the
     square again.
5. **Dry run.**
   - Tape a Letter sheet landscape on the machine with its corner at home.
   - Upload a photo (or take one and press Freeze), choose **Outline** and press **Dry run (pen up)**.
   - Check that the pen stays over the paper the whole time. **Cancel** stops it, lifts the pen and goes home.
6. **Plot Outline.**
   - Press **Start plot**. Pause and Resume once if you like, to see that they work.
   - When it finishes, open **Plot log & calibration**. You'll see the estimate next to the actual time and the
     error.
   - Press **Calibrate from last plot**.
7. **Plot Squiggly.** Choose **Squiggly** at Detail about 0.5, press **Start plot**, and calibrate again when it
   finishes.
8. **Write down anything odd.** Note wobbly lines, a pen that drags, or slow corners. Press **Export CSV** and
   send me the CSV with your notes.

## Tuning the time estimate

The estimate is built from four parts, and the breakdown under the big number shows each one:

- **Drawing.** Every pen-down segment, with acceleration and slowing for corners.
- **Travel.** Every pen-up move, with acceleration.
- **Pen lifts.** The number of lifts times the servo raise and lower times. The defaults are 45 ms up and 47 ms
  down, from Bantam's formula, plus any extra delay you set.
- **Command overhead.** The number of commands times *Per-command overhead*. It is 0 by default.

There are two kinds of settings under **Settings → Timing**. Every change updates the estimate immediately.

- **Settings that change the real plot and the estimate together:**
  - Drawing speed, Travel speed
  - Acceleration pen down / pen up
  - Cornering
  - Extra pen-up / pen-down delay
  - Acceleration time slice

  The estimate is calculated from exactly the moves the machine will make. So if a plot is too slow or rough,
  changing one of these changes both the plot and the estimate.
- **Settings that change only the estimate:**
  - Per-command overhead
  - Drawing time × / Travel time × / Pen-lift time × / Overall correction ×

  Use these when the machine does what was planned but takes a different amount of real time.

Suggested routine:

1. After each real plot, press **Calibrate from last plot**. This sets the *Overall correction* so that plot would
   have been exactly right. One factor often gets you within a few percent across all styles.
2. If some styles come out fast and others slow, the error is in one part. Plot a few different styles: one with
   long lines (Squiggly, Topographic), one with many tiny marks (Blueprint, Pinwheel), and one with lots of pen
   lifts (Constellation, Shards). Then press **Fit each term**. It works out separate factors for drawing, travel
   and pen lifts from the whole log and shows the remaining error before you apply them.
3. To find out which part is off, look at the CSV:
   - **Many-small-marks styles under-estimated:** raise *Per-command overhead* (try 1–3 ms), or check whether the
     real machine slows more in corners.
   - **Lift-heavy styles under-estimated:** the pen probably needs settling time. Add *Extra pen-down delay*, for
     example 50 ms. This also makes the real plot wait longer, which can make dots cleaner.
   - **Long-line styles off:** use the drawing factor.

The CSV columns are style, detail, each estimate part in seconds, the raw and shown estimate, the actual time, the
error %, and every timing setting at the time of the plot.

## Things worth knowing

- **4411 vs 2234.** There is no NextDraw 4411; Bantam makes the 8511, 1117 and 2234. The machine list has those
  three, plus "Other EBB machine" with editable travel, plus Generic Grbl.
- **Home.** The app treats the spot where the motors were switched on (or where you confirmed "at home") as home.
  After **Motors off** it asks again before the next plot. It doesn't use the NextDraw's homing switch.
- **Motion commands.** NextDraw's own software uses smoother S-curve motion commands. This app uses simple timed
  moves with straight-line acceleration. If lines look shaky at speed, lower the acceleration.
- **G-code.**
  - The Grbl estimate uses the same motion model, but Grbl plans moves its own way, so treat it as approximate.
  - The default pen commands are `G0 Z5` (up) and `G1 Z0 F1000` (down). Change them under **Settings → G-code**,
    for example to `M3 S1000` / `M5` for a servo pen.
- **Not built (out of scope):** streaming G-code to a Grbl machine, a server backend, serpentine hatching.
- **Undo.** All of this is on the `feature/nextdraw-plotter` branch and its pull request. Nothing has been merged
  into main.
