'use strict';
// Browser regressions for the photo/cutout workflow. Needs Playwright and Chrome:
//   node tools/ui-check.js [http://127.0.0.1:8000/]
// Optional: PLAYWRIGHT_MODULE=/path/to/playwright, UI_SHOTS=/path/to/screenshots
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const base = process.argv[2] || 'http://127.0.0.1:8000/';
const portrait = path.join(__dirname, '../test/fixtures/portrait-sally-ride-nasa-public-domain.jpg');
const shots = process.env.UI_SHOTS;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    let releaseModel;
    const modelGate = new Promise(resolve => { releaseModel = resolve; });
    await page.route('**/*', async route => {
      if (/storage.googleapis.com|tfhub.dev/.test(route.request().url())) await modelGate;
      await route.continue();
    });
    await page.goto(base);
    await page.click('#mode-upload');
    await page.setInputFiles('#file-upload', portrait);
    await page.waitForFunction(() => !!uploadedImage);
    assert.equal(await page.locator('#download-svg').isDisabled(), true);
    assert.match(await page.locator('#app-status').innerText(), /Loading background removal/);
    releaseModel();
    await page.waitForFunction(() => !downloadBtn.disabled, { timeout: 90000 });
    assert.equal(await page.locator('#take-photo').isVisible(), false);
    console.log('PASS: upload queues while model loads, then processes automatically');

    for (const style of await page.locator('#style-select option').evaluateAll(options => options.map(o => o.value))) {
      await page.selectOption('#style-select', style);
      await page.waitForFunction(() => !stillTask && !downloadBtn.disabled);
      assert.ok(await page.locator('#preview svg path').count() > 0, style);
    }
    await page.selectOption('#style-select', 'blueprint');
    await page.waitForFunction(() => !stillTask);
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, '10-mask-edit-button.png') }); }
    console.log('PASS: all 12 styles render from the kept frame');

    const originalMask = await page.evaluate(() => Array.from(lastMask));
    const originalSVG = await page.evaluate(() => preview.dataset.svg);
    await page.click('.mask-edit-btn');
    const noOverlap = await page.evaluate(() => document.querySelector('.mask-tools').getBoundingClientRect().top >= document.querySelector('.video-container').getBoundingClientRect().bottom);
    assert.equal(noOverlap, true);
    await page.click('[data-mode="erase"]');
    const b = await page.locator('.mask-canvas').boundingBox();
    await page.mouse.move(b.x + b.width * .4, b.y + b.height * .4);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * .6, b.y + b.height * .4, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(() => !!editedMask && !stillTask && !downloadBtn.disabled);
    assert.notEqual(await page.evaluate(() => preview.dataset.svg), originalSVG);
    await page.click('[data-act="done"]'); await page.click('.mask-edit-btn');
    assert.equal(await page.locator('[data-act="undo"]').isEnabled(), true);
    await page.click('[data-act="undo"]');
    await page.waitForFunction(() => !stillTask && !editedMask);
    assert.deepEqual(await page.evaluate(() => Array.from(editedMask || lastMask)), originalMask);
    assert.equal(await page.evaluate(() => preview.dataset.svg), originalSVG);
    console.log('PASS: brush changes output; Undo survives Done/reopen and restores the exact mask and drawing');

    await page.selectOption('[aria-label="Photo zoom"]', '2');
    await page.click('[data-mode="erase"]');
    const point = await page.evaluate(() => {
      const r = document.querySelector('.mask-canvas').getBoundingClientRect(), stage = document.querySelector('.mask-stage').getBoundingClientRect();
      const x = stage.x + stage.width / 2, y = stage.y + stage.height / 2;
      return { x, y, i: Math.floor((y - r.y) * lastFrame.height / r.height) * lastFrame.width + Math.floor((x - r.x) * lastFrame.width / r.width) };
    });
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => !!editedMask && !stillTask);
    assert.equal(await page.evaluate(i => editedMask[i], point.i), 0);
    await page.click('[data-act="pan"]');
    const beforePan = await page.locator('.mask-stage').evaluate(el => [el.scrollLeft, el.scrollTop]);
    const beforeMask = await page.evaluate(() => Array.from(editedMask));
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 50, point.y + 40, { steps: 5 }); await page.mouse.up();
    assert.notDeepEqual(await page.locator('.mask-stage').evaluate(el => [el.scrollLeft, el.scrollTop]), beforePan);
    assert.deepEqual(await page.evaluate(() => Array.from(editedMask)), beforeMask);
    await page.click('[data-act="reset"]'); await page.waitForFunction(() => !stillTask && !editedMask);
    await page.click('[data-act="done"]');
    assert.equal(await page.locator('.mask-edit-btn').evaluate(el => el.classList.contains('mask-edited')), false);
    await page.click('.mask-edit-btn');
    assert.equal(await page.locator('[data-act="undo"]').isEnabled(), true);
    console.log('PASS: zoomed strokes align, moving the view does not paint, Reset clears the edited marker and is undoable');

    await page.selectOption('[aria-label="Photo zoom"]', '1');
    if (shots) await page.screenshot({ path: path.join(shots, '11-mask-brush-editing.png') });
    for (const width of [390, 768, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow at ' + width);
      assert.equal(await page.evaluate(() => document.querySelector('.mask-tools').getBoundingClientRect().top >= document.querySelector('.video-container').getBoundingClientRect().bottom), true, 'tools outside photo at ' + width);
      if (shots && width === 390) await page.screenshot({ path: path.join(shots, '12-mask-brush-mobile.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.click('[data-act="done"]');
    await page.click('#mode-camera'); await page.click('#mode-upload');
    await page.waitForFunction(() => lastFrame && !downloadBtn.disabled);
    const dl = page.waitForEvent('download'); await page.click('#download-svg');
    const downloaded = await dl;
    assert.ok(fs.readFileSync(await downloaded.path(), 'utf8').includes('<svg'));
    console.log('PASS: responsive layouts, returning to Upload, SVG download');

    // Exercise the actual ImageTracer callback after the user has changed sources.
    const raced = await page.evaluate(async () => {
      styleSelect.value = 'outline';
      const real = ImageTracer.imageToSVG;
      let release;
      ImageTracer.imageToSVG = (url, cb, options) => real.call(ImageTracer, url, svg => { release = () => cb(svg); }, options);
      try {
        const work = rerenderStill();
        while (!release) await new Promise(resolve => setTimeout(resolve, 10));
        rerenderStill(); switchMode('camera'); release(); await work;
        return { svg: preview.dataset.svg, frame: lastFrame };
      } finally { ImageTracer.imageToSVG = real; }
    });
    assert.deepEqual(raced, { svg: '', frame: null });
    console.log('PASS: obsolete trace callback cannot restore a drawing after a source switch');

    await page.click('#start-camera');
    await page.waitForFunction(() => lastFrame && !!preview.dataset.svg, { timeout: 60000 });
    await page.click('#take-photo');
    await page.waitForFunction(() => isFrozen && !stillTask);
    assert.equal(await page.locator('#video').isVisible(), false);
    assert.equal(await page.locator('#frozen-frame').isVisible(), true);
    await page.click('.mask-edit-btn'); await page.click('[data-act="done"]');
    await page.click('#take-photo');
    await page.waitForFunction(() => !isFrozen && lastFrame);
    assert.equal(await page.locator('#video').isVisible(), true);
    assert.equal(await page.locator('#frozen-frame').isVisible(), false);
    console.log('PASS: simulated camera Freeze, editing, Resume');

    await page.click('#mode-upload');
    await page.waitForFunction(() => !downloadBtn.disabled);
    await page.click('#plotter-toggle');
    await page.waitForFunction(() => PlotterUI.lastPrep && document.getElementById('pl-est-tag').textContent === 'optimized', { timeout: 30000 });
    await page.evaluate(() => {
      const real = ImageTracer.imageToSVG;
      ImageTracer.imageToSVG = (url, cb, options) => real.call(ImageTracer, url, svg => {
        window.releaseExportTrace = () => { ImageTracer.imageToSVG = real; cb(svg); };
      }, options);
      rerenderStill();
    });
    await page.waitForFunction(() => !!window.releaseExportTrace);
    assert.equal(await page.locator('#download-svg').isDisabled(), true);
    assert.equal(await page.locator('#pl-dl-svg').isDisabled(), true);
    assert.equal(await page.locator('#pl-dl-gcode').isDisabled(), true);
    await page.evaluate(() => window.releaseExportTrace());
    await page.waitForFunction(() => !stillTask && !document.getElementById('pl-dl-svg').disabled);
    const plotDL = page.waitForEvent('download'); await page.click('#pl-dl-svg');
    assert.ok(fs.readFileSync(await (await plotDL).path(), 'utf8').includes('mm'));
    assert.deepEqual(errors, []);
    console.log('PASS: exports wait for the latest redraw; plotter estimate and plot-ready SVG; no page errors');

    const retryPage = await browser.newPage();
    const retryErrors = [];
    retryPage.on('pageerror', err => retryErrors.push(String(err)));
    let failed = false;
    await retryPage.route('**/*', async route => {
      if (!failed && /storage.googleapis.com|tfhub.dev/.test(route.request().url())) { failed = true; await route.abort('failed'); }
      else await route.continue();
    });
    await retryPage.goto(base);
    await retryPage.waitForFunction(() => typeof modelState !== 'undefined' && modelState === 'error');
    await retryPage.click('#mode-upload');
    assert.equal(await retryPage.locator('#retry-action').isVisible(), true);
    await retryPage.click('#retry-action');
    await retryPage.waitForFunction(() => net !== null, { timeout: 90000 });
    assert.equal(await retryPage.locator('#retry-action').isVisible(), false);
    assert.deepEqual(retryErrors, []);
    await retryPage.close();
    console.log('PASS: failed model download shows a retry and recovers after a mode switch');
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
