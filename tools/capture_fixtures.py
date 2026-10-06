"""Capture real SVG output of every style as test fixtures.

Loads the app in headless Chromium, uploads test/fixtures/portrait-*.jpg
(public-domain NASA portrait), and saves preview.dataset.svg for each style.

    python3 tools/capture_fixtures.py [http://127.0.0.1:9716/]

Needs: pip install playwright && playwright install chromium
"""
import json, sys, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9716/"
IMG = next((ROOT / "test" / "fixtures").glob("portrait-*.jpg"))
OUT = ROOT / "test" / "fixtures" / "svg"
OUT.mkdir(parents=True, exist_ok=True)
STYLES = ["outline", "blueprint", "topo", "constellation", "pinwheel", "pixel", "squiggle",
          "invader", "sobel", "spiral", "wiggle", "shards", "composition"]
RUNS = [(s, 0.5) for s in STYLES] + [("squiggle", 0.1), ("squiggle", 0.9), ("outline", 0.1), ("outline", 0.9)]

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("typeof net !== 'undefined' && net !== null", timeout=120000)
    page.click("#mode-upload")
    page.set_input_files("#file-upload", str(IMG))
    page.wait_for_function("preview.dataset.svg && preview.dataset.svg.length > 100", timeout=60000)
    sizes = {}
    for style, detail in RUNS:
        svg = page.evaluate("""async ([s, d]) => {
            styleSelect.value = s; detailRange.value = d;
            await processUploadedImage();
            return preview.dataset.svg;
        }""", [style, detail])
        name = f"{style}-d{int(detail*100):02d}.svg"
        (OUT / name).write_text(svg)
        sizes[name] = len(svg)
    b.close()
    print(json.dumps({"sizes": sizes, "pageErrors": errors}, indent=1))
