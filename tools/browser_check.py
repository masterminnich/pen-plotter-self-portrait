"""Headless-browser check of the real page, with and without the Plotter panel.

    python3 tools/browser_check.py [base-url]      (default http://127.0.0.1:9716/)

1. Panel closed: upload the test portrait, run every style, expect zero console
   errors and no plotter UI on screen.
2. Panel open: estimate appears and gets optimized; travel overlay toggles.
3. ?mockplotter=1: connect to the simulated NextDraw, pause/resume a real plot,
   finish it, check the log, calibrate, dry run, test square, cancel.
Screenshots go to docs/screenshots/. Needs: pip install playwright.
"""
import json, sys, pathlib, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9716/"
IMG = str(next((ROOT / "test" / "fixtures").glob("portrait-*.jpg")))
SHOTS = ROOT / "docs" / "screenshots"
SHOTS.mkdir(parents=True, exist_ok=True)
STYLES = ["outline", "blueprint", "topo", "constellation", "pinwheel", "pixel", "squiggle",
          "invader", "sobel", "spiral", "wiggle", "shards", "composition"]
results = {}


def watch(page, bucket):
    page.on("console", lambda m: bucket.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: bucket.append(f"pageerror: {e}"))


def load(page, url):
    page.goto(url)
    page.wait_for_function("typeof net !== 'undefined' && net !== null", timeout=120000)
    page.click("#mode-upload")
    page.set_input_files("#file-upload", IMG)
    page.wait_for_function("preview.dataset.svg && preview.dataset.svg.length > 100", timeout=60000)


def set_style(page, style, detail=0.5):
    page.evaluate("""async ([s, d]) => { styleSelect.value = s; detailRange.value = d; await processUploadedImage(); }""", [style, detail])


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)

    # ---------- 1. panel closed ----------
    page = ctx.new_page()
    errs = []
    watch(page, errs)
    page.goto(BASE)
    page.evaluate("localStorage.clear()")
    load(page, BASE)
    for s in STYLES:
        set_style(page, s)
    set_style(page, "blueprint")
    results["closed_panel_hidden"] = page.evaluate("document.getElementById('plotter-panel').hidden")
    results["closed_body_class"] = page.evaluate("document.body.className")
    page.screenshot(path=str(SHOTS / "01-panel-closed.png"))
    results["closed_errors"] = list(errs)

    # ---------- 2. panel open ----------
    errs.clear()
    page.click("#plotter-toggle")
    page.wait_for_function("document.getElementById('pl-est-tag').textContent === 'optimized'", timeout=20000)
    results["open_estimate"] = page.inner_text("#pl-est-total")
    results["open_opt_summary"] = page.inner_text("#pl-opt-summary")
    results["open_layout_info"] = page.inner_text("#pl-layout-info")
    page.screenshot(path=str(SHOTS / "02-panel-open-estimate.png"))
    # detail slider moves -> estimate changes
    est = {}
    for d in (0.1, 0.5, 0.9):
        set_style(page, "squiggle", d)
        page.wait_for_function("document.getElementById('pl-est-tag').textContent === 'optimized'", timeout=20000)
        time.sleep(0.4)
        est[d] = page.evaluate("PlotterUI.lastPrep.shownMs")
    results["squiggle_estimates_ms"] = est
    page.check("#pl-show-travel")
    time.sleep(0.3)
    results["travel_lines"] = page.evaluate("document.querySelectorAll('#preview svg g.pl-travel line').length")
    page.screenshot(path=str(SHOTS / "03-travel-overlay.png"))
    page.uncheck("#pl-show-travel")
    # settings: timing section is open; change draw speed -> estimate recomputes
    page.click("#pl-settings > summary")
    before = page.evaluate("PlotterUI.lastPrep.shownMs")
    page.fill("#pl-set-timing-drawSpeed", "70")
    time.sleep(0.6)
    after = page.evaluate("PlotterUI.lastPrep.shownMs")
    results["speed_change_ms"] = [before, after]
    page.fill("#pl-set-timing-drawSpeed", "35")
    time.sleep(0.4)
    page.evaluate("document.getElementById('pl-settings').scrollIntoView()")
    page.screenshot(path=str(SHOTS / "04-settings-timing.png"))
    with page.expect_download() as dl:
        page.click("#pl-dl-svg")
    results["plot_ready_svg_bytes"] = len(pathlib.Path(dl.value.path()).read_bytes())
    with page.expect_download() as dl:
        page.click("#pl-dl-gcode")
    g = pathlib.Path(dl.value.path()).read_text()
    results["gcode_lines"] = g.count("\n")
    # Web Serial support message (headless Chromium has navigator.serial)
    results["serial_supported"] = page.evaluate("!!(navigator.serial && navigator.serial.requestPort)")
    page.click("#pl-close")
    results["closed_again_overlay"] = page.evaluate("document.querySelectorAll('#preview svg g.pl-travel').length")
    results["open_errors"] = list(errs)
    page.close()

    # ---------- 3. mock plotter ----------
    page = ctx.new_page()
    errs = []
    watch(page, errs)
    page.on("dialog", lambda d: d.accept())
    load(page, BASE + "?mockplotter=1")
    set_style(page, "squiggle", 0.3)
    page.wait_for_function("document.getElementById('pl-est-tag').textContent === 'optimized'", timeout=20000)
    page.select_option("#pl-mock-speed", "0.005")
    page.click("#pl-connect")
    page.wait_for_function("document.getElementById('pl-conn-status').textContent.startsWith('Connected')", timeout=10000)
    results["mock_conn_status"] = page.inner_text("#pl-conn-status")
    # pen tests
    page.click("#pl-test-down"); time.sleep(0.2)
    page.click("#pl-test-up"); time.sleep(0.2)
    # start a plot, pause, resume
    page.click("#pl-start")
    page.wait_for_function("PlotterUI.manager.busy", timeout=10000)
    time.sleep(0.8)
    page.click("#pl-pause")
    page.wait_for_function("document.getElementById('pl-pause').textContent === 'Resume'", timeout=20000)
    results["mock_pen_up_while_paused"] = page.evaluate("PlotterUI.mock.penUp")
    page.screenshot(path=str(SHOTS / "05-mock-paused.png"))
    page.click("#pl-pause")
    page.wait_for_function("!PlotterUI.manager.busy", timeout=180000)
    time.sleep(0.5)
    results["mock_progress_text"] = page.inner_text("#pl-progress-text")
    results["mock_log_len"] = page.evaluate("PlotterUI.log.length")
    results["mock_last_log"] = page.evaluate("(() => { const e = PlotterUI.log[PlotterUI.log.length-1]; return e && {style: e.style, est: e.shownMs, actual: e.actualMs, lifts: e.lifts}; })()")
    results["mock_trace_strokes"] = page.evaluate("PlotterUI.mock.trace.length")
    results["mock_expected_strokes"] = page.evaluate("PlotterUI.lastPrep.machinePaths.length")
    results["mock_errors"] = page.evaluate("PlotterUI.mock.errors")
    results["mock_crashes"] = page.evaluate("PlotterUI.mock.crashes")
    results["mock_final_pos"] = page.evaluate("[PlotterUI.mock.posX, PlotterUI.mock.posY]")
    # compare drawn strokes with the plan (within one step at every recorded vertex end)
    results["mock_max_endpoint_err_mm"] = page.evaluate("""(() => {
        const t = PlotterUI.mock.trace, P = PlotterUI.lastPrep.machinePaths;
        // pause splits one stroke in two; compare starts of the plan to stroke starts in order
        let worst = 0, j = 0;
        for (const p of P) {
          while (j < t.length && Math.hypot(t[j][0]-p[0], t[j][1]-p[1]) > 0.05) j++;
          if (j >= t.length) return 'missing';
          worst = Math.max(worst, Math.hypot(t[j][0]-p[0], t[j][1]-p[1])); j++;
        }
        return worst; })()""")
    page.evaluate("document.getElementById('pl-machine').scrollIntoView()")
    page.screenshot(path=str(SHOTS / "06-mock-finished.png"))
    # calibrate from that plot
    page.click("#pl-log-section > summary")
    page.click("#pl-calibrate")
    results["calibration_text"] = page.inner_text("#pl-cal-result")
    page.evaluate("document.getElementById('pl-log-section').scrollIntoView()")
    page.screenshot(path=str(SHOTS / "07-plot-log-calibrated.png"))
    with page.expect_download() as dl:
        page.click("#pl-csv")
    results["csv_head"] = pathlib.Path(dl.value.path()).read_text().splitlines()[:2]
    # test square
    page.click("#pl-square")
    page.wait_for_function("PlotterUI.manager.busy", timeout=10000)
    page.wait_for_function("!PlotterUI.manager.busy", timeout=60000)
    page.evaluate("document.getElementById('pl-mock-view').scrollIntoView({block: 'center'})")
    time.sleep(0.4)
    page.screenshot(path=str(SHOTS / "08-mock-test-square.png"))
    results["square_bbox"] = page.evaluate("""(() => { const p = PlotterUI.mock.trace.flat();
        const xs = p.filter((_, i) => i % 2 === 0), ys = p.filter((_, i) => i % 2 === 1);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(v => +v.toFixed(3)); })()""")
    # dry run then cancel part-way
    page.click("#pl-dry")
    page.wait_for_function("PlotterUI.manager.busy", timeout=10000)
    time.sleep(0.6)
    pen_down_during_dry = page.evaluate("!PlotterUI.mock.penUp")
    page.click("#pl-cancel")
    page.wait_for_function("!PlotterUI.manager.busy", timeout=60000)
    results["dry_pen_down"] = pen_down_during_dry
    results["after_cancel_pos"] = page.evaluate("[PlotterUI.mock.posX, PlotterUI.mock.posY, PlotterUI.mock.penUp]")
    results["after_cancel_text"] = page.inner_text("#pl-progress-text")
    page.click("#pl-home")
    time.sleep(0.5)
    page.click("#pl-motors-off")
    time.sleep(0.3)
    results["home_note_after_motors_off"] = page.inner_text("#pl-home-note")
    results["mock_page_errors"] = list(errs)
    browser.close()

    # ---------- 4. live camera (Chromium's fake camera) ----------
    browser = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.grant_permissions(["camera"])
    page = ctx.new_page()
    errs = []
    watch(page, errs)
    page.goto(BASE)
    page.wait_for_function("typeof net !== 'undefined' && net !== null", timeout=120000)
    page.click("#start-camera")
    page.wait_for_function("preview.dataset.svg && preview.dataset.svg.length > 50", timeout=60000)
    page.click("#plotter-toggle")
    # The fake camera has no person in it, so every frame gives the same empty SVG.
    # Feed real style output into the preview between frames to mimic a moving subject.
    fx = [(ROOT / "test" / "fixtures" / "svg" / n).read_text() for n in ("squiggle-d10.svg", "squiggle-d50.svg")]
    page.evaluate("""(fx) => { let i = 0; window.__feed = setInterval(() => {
        if (isFrozen) return; const s = fx[i++ % fx.length]; preview.innerHTML = s; preview.dataset.svg = s; }, 120); }""", fx)
    tags = set()
    t_end = time.time() + 6
    while time.time() < t_end:
        tags.add(page.inner_text("#pl-est-tag"))
        time.sleep(0.1)
    results["live_tags_seen"] = sorted(tags)
    page.screenshot(path=str(SHOTS / "09-live-camera-unoptimized.png"))
    page.click("#take-photo")  # Freeze
    page.evaluate("clearInterval(window.__feed)")
    page.wait_for_function("document.getElementById('pl-est-tag').textContent === 'optimized'", timeout=20000)
    results["after_freeze_tag"] = page.inner_text("#pl-est-tag")
    results["live_errors"] = list(errs)
    browser.close()

print(json.dumps(results, indent=1))
