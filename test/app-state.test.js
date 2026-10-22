'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Run the real app controller with a minimal DOM and controllable async boundaries.
// No camera, model downloads, image tracing, or browser is needed for these races.
function app() {
  const elements = new Map();
  function element() {
    const el = { hidden: false, disabled: false, dataset: {}, textContent: '', innerHTML: '',
      classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, click() {},
      getContext: () => ({ drawImage() {}, putImageData() {}, getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) }) };
    el.parentElement = { dataset: {} };
    return el;
  }
  const context = vm.createContext({
    console, Uint8Array, Uint8ClampedArray, Promise,
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    window: { addEventListener() {}, MaskEditor: { reset() {}, setAvailable() {} } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    navigator: { mediaDevices: {} }, bodyPix: {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  run(`
    video = document.getElementById('video');
    startBtn = document.getElementById('start-camera'); takeBtn = document.getElementById('take-photo');
    downloadBtn = document.getElementById('download-svg'); styleSelect = { value: 'outline' }; detailRange = { value: '0.5' };
    preview = document.getElementById('preview'); sourceLabel = document.getElementById('source-label');
    uploadedImageEl = document.getElementById('uploaded-image'); uploadBtn = document.getElementById('upload-btn');
    fileInput = {}; modeCameraBtn = document.getElementById('mode-camera'); modeUploadBtn = document.getElementById('mode-upload');
    canvas = document.createElement('canvas'); ctx = canvas.getContext('2d');
    video.readyState = 4; video.videoWidth = 2; video.videoHeight = 2;
    lastFrame = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
    lastMask = new Uint8Array([1, 1, 1, 1]);
    uploadedImage = { naturalWidth: 2, naturalHeight: 2, src: 'photo' };
    net = { segmentPerson: async () => ({ data: new Uint8Array([1,1,1,1]) }) }; modelState = 'ready';
    renderMasked = async (frame, mask, current) => { if (current()) { preview.dataset.svg = 'new drawing'; preview.innerHTML = 'new drawing'; } };
  `);
  return { run, context };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a queued redraw cannot restore an old drawing or read a cleared frame after a mode switch', async () => {
  const { run } = app();
  run(`currentMode = 'upload'; let release;
    renderMasked = (frame, mask, current) => new Promise(resolve => { release = () => { if (current()) preview.dataset.svg = 'stale'; resolve(); }; });
    let work = rerenderStill();`);
  await flush();
  run(`rerenderStill(); switchMode('camera'); release();`);
  await run('work');
  assert.equal(run('preview.dataset.svg'), '');
  assert.equal(run('lastFrame'), null);
  assert.equal(run('stillTask'), null);
});

test('brush requests invalidate an unfinished redraw and render a separate snapshot of the newest mask', async () => {
  const { run } = app();
  run(`currentMode = 'upload'; let release, seen = [], valid = [];
    renderMasked = async (frame, mask, current) => { seen.push(mask); if (seen.length === 1) await new Promise(r => release = r); valid.push(current()); };
    editedMask = new Uint8Array([1,1,1,1]); let work = rerenderStill();`);
  await flush();
  run('editedMask[0] = 0; rerenderStill(); release();');
  await run('work');
  assert.deepEqual(Array.from(run('valid')), [false, true]);
  assert.equal(run('seen[0][0]'), 1);
  assert.equal(run('seen[1][0]'), 0);
});

test('a camera frame finishing after Freeze and Done cannot replace the frozen frame or edits', async () => {
  const { run } = app();
  run(`let finishSegment; const frozenFrame = lastFrame;
    net.segmentPerson = () => new Promise(r => finishSegment = r);
    let work = processFrame(); takePhoto();
    editedMask = new Uint8Array([0,1,0,1]); const edits = editedMask;
    finishSegment({data: new Uint8Array([1,1,1,1])});`);
  await run('work');
  assert.equal(run('lastFrame === frozenFrame'), true);
  assert.equal(run('editedMask === edits'), true);
  assert.equal(run('isFrozen'), true);
});

test('an early upload waits for the model and processes automatically when ready', async () => {
  const { run } = app();
  run(`currentMode = 'upload'; net = null; lastFrame = lastMask = null;
    let finishLoad, segments = 0;
    bodyPix.load = () => new Promise(r => finishLoad = r);
    let work = processUploadedImage();`);
  await flush();
  assert.equal(run('lastFrame'), null);
  assert.equal(run('downloadBtn.disabled'), true);
  run('finishLoad({segmentPerson: async () => { segments++; return { data: new Uint8Array([1,1,1,1]) }; }});');
  await run('work');
  assert.equal(run('segments'), 1);
  assert.equal(run('lastFrame.width'), 2);
  assert.equal(run('downloadBtn.disabled'), false);
});

test('segmentation from an obsolete upload is discarded', async () => {
  const { run } = app();
  run(`currentMode = 'upload'; let finish;
    net.segmentPerson = () => new Promise(r => finish = r);
    let work = processUploadedImage();`);
  await flush();
  run(`switchMode('camera'); finish({data: new Uint8Array([1,1,1,1])});`);
  await run('work');
  assert.equal(run('lastFrame'), null);
  assert.equal(run('preview.dataset.svg'), '');
});

test('returning to Upload reprocesses the saved photo; selecting the current mode preserves edits', async () => {
  const { run } = app();
  run(`currentMode = 'upload'; switchMode('camera'); switchMode('upload');`);
  await flush();
  assert.equal(run('downloadBtn.disabled'), false);
  assert.equal(run('preview.dataset.svg'), 'new drawing');
  run(`editedMask = new Uint8Array([0,1,0,1]); const edits = editedMask; switchMode('upload');`);
  assert.equal(run('editedMask === edits'), true);
});

test('a failed model load has a retry that processes the selected photo', async () => {
  const { run } = app();
  run(`currentMode = 'upload'; net = null;
    bodyPix.load = async () => { throw new Error('offline'); };`);
  await run('processUploadedImage()');
  assert.equal(run('appError.retry'), 'model');
  run(`bodyPix.load = async () => ({ segmentPerson: async () => ({data: new Uint8Array([1,1,1,1])}) });`);
  await run('retryAction()');
  assert.equal(run('appError'), null);
  assert.equal(run('downloadBtn.disabled'), false);
});

test('a camera permission result arriving after a mode switch stops its stream', async () => {
  const { run } = app();
  run(`lastFrame = null; let allow, stopped = false;
    navigator.mediaDevices.getUserMedia = () => new Promise(r => allow = r);
    let work = startCamera();`);
  await flush();
  run(`switchMode('upload'); allow({getTracks: () => [{stop() {stopped = true;}}]});`);
  await run('work');
  assert.equal(run('stopped'), true);
  assert.equal(run('video.srcObject'), undefined);
});

test('switching modes after a failed model load keeps a visible retry', async () => {
  const { run } = app();
  run(`net = null; bodyPix.load = async () => { throw new Error('offline'); }; currentMode = 'upload';`);
  await run('processUploadedImage()');
  run(`switchMode('camera');`);
  assert.equal(run('appError.retry'), 'model');
  assert.equal(run("document.getElementById('retry-action').hidden"), false);
});

test('render failures disable exports and can be retried', async () => {
  const { run } = app();
  run(`currentMode = 'upload'; preview.dataset.svg = 'previous drawing';
    renderMasked = async () => { throw new Error('bad trace'); };`);
  await run('rerenderStill()');
  assert.equal(run('appError.retry'), 'render');
  assert.equal(run('downloadBtn.disabled'), true);
  assert.equal(run('preview.dataset.ready'), 'false');
  run(`renderMasked = async (frame, mask, current) => { if(current()) preview.dataset.svg = 'fixed drawing'; };`);
  await run('retryAction()');
  assert.equal(run('appError'), null);
  assert.equal(run('downloadBtn.disabled'), false);
  assert.equal(run('preview.dataset.ready'), 'true');
});

test('obsolete ImageTracer callbacks are ignored before parsing or publishing', async () => {
  const { run } = app();
  run(`let traced;
    ImageTracer = { imageToSVG(url, callback) { traced = callback; } };
    let work = generateSVGFromCanvasAsync({ width: 2, height: 2, toDataURL: () => 'png' }, 'outline', .5, () => false);
    traced('obsolete output');`);
  await run('work'); // DOMParser is deliberately absent: stale work must never reach it.
  assert.equal(run('preview.dataset.svg'), undefined);
});

test('malformed ImageTracer output rejects the drawing promise instead of leaving it pending', async () => {
  const { run } = app();
  run(`let traced;
    ImageTracer = { imageToSVG(url, callback) { traced = callback; } };
    DOMParser = class { parseFromString() { return { querySelector() { return null; } }; } };
    let work = generateSVGFromCanvasAsync({ width: 2, height: 2, toDataURL: () => 'png' }, 'outline', .5);
    let caught = work.then(() => '', err => err.message);
    traced('invalid output');`);
  assert.equal(await run('caught'), 'Invalid drawing');
});
