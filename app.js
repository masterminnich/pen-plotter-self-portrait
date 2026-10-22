// Camera capture -> person cutout -> drawing -> SVG download.
let video, startBtn, takeBtn, downloadBtn, styleSelect, detailRange, preview, canvas, ctx;
let fileInput, uploadBtn, modeCameraBtn, modeUploadBtn, sourceLabel, uploadedImageEl;
let net = null, modelPromise = null, modelState = 'loading';
let currentMode = 'camera', uploadedImage = null, isFrozen = false;
let lastFrame = null, lastMask = null, editedMask = null;
let sourceVersion = 0, renderVersion = 0, liveVersion = 0;
let livePreviewId = null, stillTask = null, stillPending = false;
let uploadTask = null, sourceBusy = null, cameraStarting = null, appError = null;

async function init() {
  video = document.getElementById('video');
  startBtn = document.getElementById('start-camera');
  takeBtn = document.getElementById('take-photo');
  downloadBtn = document.getElementById('download-svg');
  styleSelect = document.getElementById('style-select');
  detailRange = document.getElementById('detail');
  preview = document.getElementById('preview');
  canvas = document.getElementById('capture-canvas');
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  fileInput = document.getElementById('file-upload');
  uploadBtn = document.getElementById('upload-btn');
  modeCameraBtn = document.getElementById('mode-camera');
  modeUploadBtn = document.getElementById('mode-upload');
  sourceLabel = document.getElementById('source-label');
  uploadedImageEl = document.getElementById('uploaded-image');

  startBtn.addEventListener('click', startCamera);
  takeBtn.addEventListener('click', takePhoto);
  downloadBtn.addEventListener('click', downloadSVG);
  modeCameraBtn.addEventListener('click', () => switchMode('camera'));
  modeUploadBtn.addEventListener('click', () => switchMode('upload'));
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileUpload);
  document.getElementById('empty-camera').addEventListener('click', startCamera);
  document.getElementById('empty-upload').addEventListener('click', () => {
    switchMode('upload'); fileInput.click();
  });
  document.getElementById('retry-action').addEventListener('click', retryAction);
  styleSelect.addEventListener('change', redrawStillOnChange);
  detailRange.addEventListener('input', redrawStillOnChange);
  clearPreview();
  updateUI();
  try { await loadModel(); }
  catch (err) { showError('Background removal could not load. Check your connection and try again.', 'model'); }
}

function showError(message, retry) {
  appError = { message, retry };
  updateUI();
}

function loadModel() {
  if (net) return Promise.resolve(net);
  if (modelPromise) return modelPromise;
  modelState = 'loading';
  updateUI();
  modelPromise = Promise.resolve().then(() => bodyPix.load({
    architecture: 'MobileNetV1', outputStride: 16, multiplier: 0.75, quantBytes: 2
  })).then(model => {
    net = model; modelState = 'ready';
    if (appError && appError.retry === 'model') appError = null;
    return model;
  }).catch(err => {
    modelState = 'error';
    throw err;
  }).finally(() => { modelPromise = null; updateUI(); });
  return modelPromise;
}

async function retryAction() {
  const action = appError && appError.retry;
  appError = null;
  updateUI();
  if (action === 'camera') {
    if (video.srcObject && currentMode === 'camera') { startLivePreview(); return; }
    return startCamera();
  }
  if (action === 'render') return rerenderStill();
  if (action === 'file') { fileInput.click(); return; }
  try { await loadModel(); }
  catch (err) { showError('Background removal could not load. Check your connection and try again.', 'model'); return; }
  if (currentMode === 'upload' && uploadedImage) await processUploadedImage();
  else if (video.srcObject && !isFrozen) startLivePreview();
}

function clearPreview() {
  preview.dataset.svg = '';
  preview.innerHTML = '<div class="empty-state"><span class="empty-mark" aria-hidden="true">✳</span><strong>Your drawing appears here</strong><p>Choose a photo, then explore the drawing styles.</p></div>';
}

function updateUI() {
  if (!preview) return;
  const camera = currentMode === 'camera', stream = !!video.srcObject;
  const busy = sourceBusy !== null || !!stillTask;
  startBtn.hidden = !camera;
  startBtn.disabled = modelState !== 'ready' || cameraStarting !== null || stream;
  takeBtn.hidden = !camera;
  takeBtn.disabled = !stream || !lastFrame;
  takeBtn.textContent = isFrozen ? 'Resume' : 'Freeze';
  uploadBtn.hidden = camera;
  video.hidden = !camera || isFrozen || !stream;
  uploadedImageEl.hidden = camera || !uploadedImage;
  document.getElementById('frozen-frame').hidden = !camera || !isFrozen;
  document.getElementById('source-empty').hidden = camera ? stream : !!uploadedImage;
  document.getElementById('empty-camera').disabled = startBtn.disabled;
  downloadBtn.disabled = !preview.dataset.svg || busy || (camera && !isFrozen) || !!appError;
  const ready = String(!!preview.dataset.svg && !busy && !appError);
  if (preview.dataset.ready !== ready) preview.dataset.ready = ready;
  document.getElementById('preview-section').setAttribute('aria-busy', String(busy));
  sourceLabel.textContent = camera ? (isFrozen ? 'Frozen photo' : 'Camera') : 'Photo';
  for (const [btn, active] of [[modeCameraBtn, camera], [modeUploadBtn, !camera]]) {
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  let message;
  if (appError) message = appError.message;
  else if (modelState === 'loading') message = uploadedImage ? 'Photo selected. Loading background removal…' : 'Loading background removal… You can choose a photo while you wait.';
  else if (cameraStarting !== null) message = 'Starting camera…';
  else if (sourceBusy !== null) message = 'Removing the background…';
  else if (stillTask) message = 'Updating your drawing…';
  else if (camera && stream) message = isFrozen ? 'Photo frozen. Refine the cutout or choose a drawing style.' : 'Camera is live. Freeze a photo when you’re ready.';
  else if (!camera && lastFrame) message = 'Ready. Refine the cutout, explore styles, or download your drawing.';
  else message = 'Start your camera or choose a photo to begin.';
  const status = document.getElementById('app-status');
  if (status.textContent !== message) status.textContent = message;
  status.parentElement.dataset.state = appError ? 'error' : (busy || modelState === 'loading' ? 'busy' : 'ready');
  document.getElementById('retry-action').hidden = !appError;
  updateMaskEditAvailability();
}

function stopLivePreview() {
  liveVersion++;
  if (livePreviewId) cancelAnimationFrame(livePreviewId);
  livePreviewId = null;
}

// Every source change invalidates all outstanding segmentation and drawing work.
function invalidateSource() {
  sourceVersion++; renderVersion++;
  stillPending = false; sourceBusy = null; cameraStarting = null;
  appError = modelState === 'error' ? { message: 'Background removal could not load. Check your connection and try again.', retry: 'model' } : null;
  stopLivePreview();
  if (window.MaskEditor) window.MaskEditor.reset();
  lastFrame = lastMask = editedMask = null;
  clearPreview();
}

function switchMode(mode) {
  if (mode === currentMode) return;
  invalidateSource();
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
  currentMode = mode; isFrozen = false;
  updateUI();
  if (mode === 'upload' && uploadedImage) processUploadedImage();
}

function redrawStillOnChange() {
  if ((currentMode === 'upload' || isFrozen) && lastFrame) return rerenderStill();
  if (currentMode === 'upload' && uploadedImage) return processUploadedImage();
}

// Coalesce brush/slider requests. Each render keeps its own frame and mask snapshot;
// callbacks may publish only while both their source and revision are still current.
function rerenderStill() {
  if (!lastFrame || !lastMask || (currentMode === 'camera' && !isFrozen)) return Promise.resolve();
  renderVersion++;
  stillPending = true;
  if (stillTask) return stillTask;
  stillTask = Promise.resolve().then(async () => {
    while (stillPending && lastFrame && (currentMode === 'upload' || isFrozen)) {
      stillPending = false;
      const source = sourceVersion, revision = renderVersion;
      const frame = lastFrame, mask = (editedMask || lastMask).slice();
      const current = () => source === sourceVersion && revision === renderVersion && frame === lastFrame;
      try {
        await renderMasked(frame, mask, current);
        if (current() && appError && appError.retry === 'render') appError = null;
      } catch (err) {
        if (current()) showError('The drawing could not update. Try again or choose another style.', 'render');
      }
    }
  }).finally(() => { stillTask = null; updateUI(); });
  updateUI();
  return stillTask;
}

function updateMaskEditAvailability() {
  if (window.MaskEditor) window.MaskEditor.setAvailable(!!lastFrame && !!lastMask && sourceBusy === null && (currentMode === 'upload' || isFrozen));
}

async function handleFileUpload(e) {
  const file = e.target.files[0];
  fileInput.value = ''; // Choosing the same file again should work.
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    showError('Choose an image file, such as a JPG or PNG.', 'file'); return;
  }
  invalidateSource();
  const source = sourceVersion;
  uploadedImage = null;
  sourceBusy = source;
  updateUI();
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = data;
    });
    if (source !== sourceVersion || currentMode !== 'upload') return;
    uploadedImage = image;
    uploadedImageEl.src = image.src;
    sourceBusy = null;
    await processUploadedImage();
  } catch (err) {
    if (source === sourceVersion) showError('This photo could not be opened. Try a JPG or PNG image.', 'file');
  } finally {
    if (sourceBusy === source) sourceBusy = null;
    updateUI();
  }
}

function processUploadedImage() {
  if (!uploadedImage || currentMode !== 'upload') return Promise.resolve();
  const source = sourceVersion, image = uploadedImage;
  if (uploadTask && uploadTask.source === source) return uploadTask.promise;
  sourceBusy = source;
  appError = null;
  const task = { source };
  task.promise = Promise.resolve().then(async () => {
    try {
      const model = await loadModel();
      if (source !== sourceVersion || currentMode !== 'upload') return;
      const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
      const w = Math.max(1, Math.round(image.naturalWidth * scale)), h = Math.max(1, Math.round(image.naturalHeight * scale));
      const capture = document.createElement('canvas');
      capture.width = w; capture.height = h;
      const context = capture.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, w, h);
      const frame = context.getImageData(0, 0, w, h);
      const segmentation = await model.segmentPerson(capture, {internalResolution: 'medium', segmentationThreshold: 0.7});
      if (source !== sourceVersion || currentMode !== 'upload') return;
      lastFrame = frame; lastMask = segmentation.data; editedMask = null;
      await rerenderStill();
    } catch (err) {
      if (source === sourceVersion) showError(modelState === 'error' ? 'Background removal could not load. Check your connection and try again.' : 'The photo could not be processed. Try again or choose another photo.', modelState === 'error' ? 'model' : 'upload');
    } finally {
      if (sourceBusy === source) sourceBusy = null;
      if (uploadTask === task) uploadTask = null;
      updateUI();
    }
  });
  uploadTask = task;
  updateUI();
  return task.promise;
}

async function startCamera() {
  if (cameraStarting !== null || video.srcObject || currentMode !== 'camera') return;
  const source = sourceVersion;
  cameraStarting = source; appError = null;
  updateUI();
  try {
    await loadModel();
    if (source !== sourceVersion || currentMode !== 'camera') return;
    const stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'user'}, audio: false});
    if (source !== sourceVersion || currentMode !== 'camera') { stream.getTracks().forEach(track => track.stop()); return; }
    video.srcObject = stream;
    await video.play();
    if (source !== sourceVersion || currentMode !== 'camera') return;
    isFrozen = false;
    startLivePreview();
  } catch (err) {
    if (source === sourceVersion) {
      if (video.srcObject) { video.srcObject.getTracks().forEach(track => track.stop()); video.srcObject = null; }
      showError(modelState === 'error' ? 'Background removal could not load. Check your connection and try again.' : 'The camera could not start. Check camera access in your browser, or upload a photo.', modelState === 'error' ? 'model' : 'camera');
    }
  } finally {
    if (cameraStarting === source) cameraStarting = null;
    updateUI();
  }
}

function startLivePreview() {
  stopLivePreview();
  const loopVersion = liveVersion;
  async function loop() {
    if (loopVersion !== liveVersion || currentMode !== 'camera' || isFrozen || !video.srcObject) return;
    await processFrame();
    if (loopVersion === liveVersion && currentMode === 'camera' && !isFrozen && video.srcObject && !appError) livePreviewId = requestAnimationFrame(loop);
  }
  livePreviewId = requestAnimationFrame(loop);
}

async function processFrame() {
  if (!net || isFrozen || currentMode !== 'camera' || video.readyState < 2) return;
  const source = sourceVersion;
  const w = video.videoWidth || 640, h = video.videoHeight || 480;
  canvas.width = w; canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  const frame = ctx.getImageData(0, 0, w, h);
  try {
    const segmentation = await net.segmentPerson(canvas, {internalResolution: 'medium', segmentationThreshold: 0.7});
    if (source !== sourceVersion || isFrozen || currentMode !== 'camera') return;
    lastFrame = frame; lastMask = segmentation.data; editedMask = null;
    const revision = ++renderVersion;
    updateUI();
    await renderMasked(frame, lastMask, () => source === sourceVersion && revision === renderVersion && !isFrozen);
  } catch (err) {
    if (source === sourceVersion) showError('The camera picture could not be processed. Try again or upload a photo.', 'camera');
  }
}

async function renderMasked(frame, mask, current = () => true) {
  const w = frame.width, h = frame.height;
  const imgData = new ImageData(new Uint8ClampedArray(frame.data), w, h);
  for (let i = 0; i < w * h; i++) if (!mask[i]) imgData.data[i * 4 + 3] = 0;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w; outCanvas.height = h;
  outCanvas.getContext('2d', { willReadFrequently: true }).putImageData(imgData, 0, 0);
  const style = styleSelect.value, detail = parseFloat(detailRange.value);
  if (style === 'pixel') {
    const tiny = document.createElement('canvas');
    tiny.width = Math.max(24, Math.floor(64 + detail * 256)); tiny.height = Math.round(tiny.width * h / w);
    const tctx = tiny.getContext('2d', { willReadFrequently: true });
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(outCanvas, 0, 0, tiny.width, tiny.height);
    const scaled = document.createElement('canvas'); scaled.width = w; scaled.height = h;
    const sctx = scaled.getContext('2d', { willReadFrequently: true }); sctx.imageSmoothingEnabled = false;
    sctx.drawImage(tiny, 0, 0, w, h);
    await generateSVGFromCanvasAsync(scaled, style, detail, current);
  } else await generateSVGFromCanvasAsync(outCanvas, style, detail, current);
}

function takePhoto() {
  if (!lastFrame || currentMode !== 'camera') return;
  if (isFrozen) {
    invalidateSource(); isFrozen = false;
    updateUI(); startLivePreview();
  } else {
    sourceVersion++; renderVersion++;
    stopLivePreview(); isFrozen = true; appError = null;
    const frozen = document.getElementById('frozen-frame');
    frozen.width = lastFrame.width; frozen.height = lastFrame.height;
    frozen.getContext('2d').putImageData(lastFrame, 0, 0);
    rerenderStill();
    updateUI();
  }
}

// --- CORE VECTOR ENGINE ---

function generateShatteredGlass(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  const paths = [];

  // Larger steps = simpler, more "doodly" look
  const step = Math.max(12, Math.floor(30 - detail * 20));

  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      const idx = (y * w + x) * 4;
      const b = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;

      // Only doodle in the dark/detail areas
      if (b < 140) {
        // Calculate a "lazy" path for this feature
        const jitter = () => (Math.random() - 0.5) * (step * 0.4);
        
        let d = "";
        if (b < 60) {
          // DARKEST: Eyes/Pupils -> "The Scribble Circle"
          const r = step * 0.3;
          d = `M ${x-r+jitter()} ${y+jitter()} a ${r} ${r} 0 1 0 ${r*2} 0 a ${r} ${r} 0 1 0 ${-r*2} 0`;
        } else if (y > h * 0.6 && Math.abs(x - w/2) < w/4) {
          // MID-LOW: Likely the mouth -> "The Lazy Smile"
          d = `M ${x-step/2} ${y+jitter()} Q ${x} ${y+step/4+jitter()}, ${x+step/2} ${y+jitter()}`;
        } else {
          // REST: Loose hatches
          d = `M ${x+jitter()} ${y+jitter()} L ${x+step*0.5+jitter()} ${y+step*0.5+jitter()}`;
        }

        if (d) paths.push(createPathElement(d));
      }
    }
  }
  return paths;
}

function generateShatteredGlass2(x, y, w, h, canvas, paths, detail) {
  const tctx = canvas.getContext('2d', { willReadFrequently: true });
  // Ensure we don't try to sample a 0-pixel area
  const sampleW = Math.max(1, Math.floor(w));
  const sampleH = Math.max(1, Math.floor(h));
  const imgData = tctx.getImageData(x, y, sampleW, sampleH).data;
  
  let totalB = 0;
  for (let i = 0; i < imgData.length; i += 4) {
    totalB += (imgData[i] + imgData[i+1] + imgData[i+2]) / 3;
  }
  const avgB = totalB / (imgData.length / 4);

  // minSize determines how "fine" the glass shards get in dark areas
  const minSize = Math.max(4, 24 - detail * 18);
  const shouldSplit = avgB < 170 && w > minSize;

  if (shouldSplit) {
    const hw = w / 2;
    const hh = h / 2;
    // Recursively split into 4 smaller shards
    generateShatteredGlass(x, y, hw, hh, canvas, paths, detail);
    generateShatteredGlass(x + hw, y, hw, hh, canvas, paths, detail);
    generateShatteredGlass(x, y + hh, hw, hh, canvas, paths, detail);
    generateShatteredGlass(x + hw, y + hh, hw, hh, canvas, paths, detail);
  } else if (avgB < 235) {
    // Generate the individual glass shard path
    // The "jitter" makes it look like broken glass rather than a grid
    const jitter = w * 0.25; 
    const p1 = { x: x + rand(jitter), y: y + rand(jitter) };
    const p2 = { x: x + w - rand(jitter), y: y + rand(jitter) };
    const p3 = { x: x + w - rand(jitter), y: y + h - rand(jitter) };
    const p4 = { x: x + rand(jitter), y: y + h - rand(jitter) };

    const d = `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} 
               L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} 
               L ${p3.x.toFixed(1)} ${p3.y.toFixed(1)} 
               L ${p4.x.toFixed(1)} ${p4.y.toFixed(1)} Z`;
               
    paths.push(createPathElement(d));
  }
}

// Simple helper for the shard jitter
function rand(range) {
  return Math.random() * range;
}

function generateComposition(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  const paths = [];

  const cellSize = Math.max(8, Math.floor(22 - detail * 15));
  const half = cellSize / 2;

  for (let y = 0; y < h; y += cellSize) {
    for (let x = 0; x < w; x += cellSize) {
      const idx = (y * w + x) * 4;
      if (imgData[idx + 3] < 128) continue;

      const b = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;
      if (b > 245) continue;

      // Find feature direction (angle)
      const dx = (imgData[idx + 4] - imgData[idx - 4]) || 0;
      const dy = (imgData[idx + w*4] - imgData[idx - w*4]) || 0;
      const angle = Math.atan2(dy, dx);

      const cx = x + half;
      const cy = y + half;
      let d = "";

      if (b < 70) {
        // DENSE SHADOW: A rotated square/diamond
        const s = half * 0.8;
        d = `M ${cx-s} ${cy-s} H ${cx+s} V ${cy+s} H ${cx-s} Z M ${cx-s} ${cy-s} L ${cx+s} ${cy+s}`;
      } else if (b < 130) {
        // MID-SHADOW: Rotated Triangle
        const r = half * 0.9;
        const x1 = cx + Math.cos(angle) * r, y1 = cy + Math.sin(angle) * r;
        const x2 = cx + Math.cos(angle + 2.1) * r, y2 = cy + Math.sin(angle + 2.1) * r;
        const x3 = cx + Math.cos(angle + 4.2) * r, y3 = cy + Math.sin(angle + 4.2) * r;
        d = `M ${x1} ${y1} L ${x2} ${y2} L ${x3} ${y3} Z`;
      } else if (b < 190) {
        // MID-LIGHT: The X-Cross (Aligned to edges)
        const r = half * 0.7;
        const cos = Math.cos(angle) * r, sin = Math.sin(angle) * r;
        const nCos = Math.cos(angle + Math.PI/2) * r, nSin = Math.sin(angle + Math.PI/2) * r;
        d = `M ${cx-cos} ${cy-sin} L ${cx+cos} ${cy+sin} M ${cx-nCos} ${cy-nSin} L ${cx+nCos} ${cy+nSin}`;
      } else {
        // HIGHLIGHT: Tiny Circle
        const r = 1.2;
        d = `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;
      }

      if (d) paths.push(createPathElement(d));
    }
  }
  return paths;
}

function generateShards(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  const paths = [];

  const step = Math.max(6, Math.floor(22 - detail * 16));

  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      const idx = (y * w + x) * 4;
      if (imgData[idx + 3] < 128) continue;

      const b = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;
      if (b > 240) continue; 

      // DIRECTIONAL SENSING: Find the "edge" angle
      const dx = (imgData[idx + 4] - imgData[idx - 4]) || 0;
      const dy = (imgData[idx + w*4] - imgData[idx - w*4]) || 0;
      const angle = Math.atan2(dy, dx);
      const edgeStrength = Math.sqrt(dx*dx + dy*dy);

      // VARIABLE DENSITY: Darker = More shards
      const density = b < 90 ? 2 : 1;
      
      for (let i = 0; i < density; i++) {
        const cx = x + (Math.random() - 0.5) * (step * 0.5);
        const cy = y + (Math.random() - 0.5) * (step * 0.5);
        
        // RECOGNIZABILITY LOGIC: 
        // Shards stretch along edges (like the line of a nose or jaw)
        const stretch = 1 + (edgeStrength / 50);
        const baseSize = (b / 255) * step * 0.6;
        
        const sides = 3 + Math.floor(Math.random() * 2); 
        let d = "";
        
        for (let s = 0; s < sides; s++) {
          const a = (s / sides) * Math.PI * 2;
          // Apply the stretch based on the edge angle
          const rx = Math.cos(a) * baseSize;
          const ry = Math.sin(a) * baseSize * (1 / stretch);
          
          // Rotate to align with the face's features
          const rotX = rx * Math.cos(angle) - ry * Math.sin(angle);
          const rotY = rx * Math.sin(angle) + ry * Math.cos(angle);
          
          const px = cx + rotX;
          const py = cy + rotY;
          d += (s === 0 ? "M " : "L ") + px.toFixed(1) + " " + py.toFixed(1);
        }
        d += " Z";
        paths.push(createPathElement(d));
      }
    }
  }
  return paths;
}

function generateWiggles(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  const paths = [];

  // Density of the scribble seeds
  const step = Math.max(4, Math.floor(12 - detail * 8));

  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      const idx = (y * w + x) * 4;
      if (imgData[idx + 3] < 128) continue;

      const b = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;
      if (b > 220) continue; // Skip highlights for a "clean" look

      // Calculate the "Flow" (Gradient direction)
      const dx = (imgData[idx + 4] - imgData[idx - 4]) || 0;
      const dy = (imgData[idx + w*4] - imgData[idx - w*4]) || 0;
      
      // The angle of the scribble follows the edge
      const angle = Math.atan2(dy, dx) + Math.PI/2; 
      
      // Scribble length is longer in midtones, shorter/busier in darks
      const length = (b / 255) * step * 2;
      const amplitude = (1 - b / 255) * (step / 2);

      const x1 = x - Math.cos(angle) * length;
      const y1 = y - Math.sin(angle) * length;
      const x2 = x + Math.cos(angle) * length;
      const y2 = y + Math.sin(angle) * length;

      // Add a "S" curve wobble to make it look hand-drawn
      const cp1x = x + Math.cos(angle + 1) * amplitude;
      const cp1y = y + Math.sin(angle + 1) * amplitude;
      const cp2x = x + Math.cos(angle - 1) * amplitude;
      const cp2y = y + Math.sin(angle - 1) * amplitude;

      const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      
      paths.push(createPathElement(d));
    }
  }
  return paths;
}

function generateInvaders(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  const paths = [];

  const cellSize = Math.max(10, Math.floor(25 - detail * 15));
  const s = cellSize; // scale factor

  for (let y = 0; y < h; y += cellSize) {
    for (let x = 0; x < w; x += cellSize) {
      const idx = (y * w + x) * 4;
      if (imgData[idx + 3] < 128) continue;

      const b = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;
      let d = "";

      if (b < 70) {
        // SKULL (Shadows)
        d = `M ${x+s*0.2} ${y+s*0.2} h ${s*0.6} v ${s*0.4} l ${-s*0.1} ${s*0.2} h ${-s*0.4} l ${-s*0.1} ${-s*0.2} Z 
             M ${x+s*0.3} ${y+s*0.4} h 0.1 M ${x+s*0.7} ${y+s*0.4} h 0.1`;
      } else if (b < 130) {
        // HEART (Mid-Shadows)
        d = `M ${x+s*0.5} ${y+s*0.8} L ${x+s*0.1} ${s*0.4+y} A ${s*0.2} ${s*0.2} 0 0 1 ${x+s*0.5} ${y+s*0.2} A ${s*0.2} ${s*0.2} 0 0 1 ${x+s*0.9} ${y+s*0.4} Z`;
      } else if (b < 190) {
        // LIGHTNING (Midtones)
        d = `M ${x+s*0.6} ${y+s*0.1} L ${x+s*0.2} ${y+s*0.6} H ${x+s*0.5} L ${x+s*0.4} ${y+s*0.9} L ${x+s*0.8} ${y+s*0.4} H ${x+s*0.5} Z`;
      } else if (b < 240) {
        // CIRCLE (Highlights)
        const r = s * 0.1;
        const cx = x + s*0.5, cy = y + s*0.5;
        d = `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r*2} 0 a ${r} ${r} 0 1 0 ${-r*2} 0`;
      }

      if (d) paths.push(createPathElement(d));
    }
  }
  return paths;
}

function generatePinwheel(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  const paths = [];

  const cellSize = Math.max(6, Math.floor(16 - detail * 10));

  for (let y = 0; y < h; y += cellSize) {
    for (let x = 0; x < w; x += cellSize) {
      const idx = (y * w + x) * 4;
      if (imgData[idx + 3] < 128) continue;

      const b = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;
      
      // Calculate "Gradient" (which way is the face curving here?)
      const rightB = (imgData[idx + 4] || b);
      const downB = (imgData[idx + (w * 4)] || b);
      const angle = Math.atan2(downB - b, rightB - b);

      let d = "";
      const half = cellSize / 2;
      const cx = x + half;
      const cy = y + half;

      // Dark areas get a "Cross" (two lines)
      // Mid areas get a "Tilted Slash" (one line following the face curve)
      // Light areas get a tiny "Tick"
      
      const cos = Math.cos(angle) * half;
      const sin = Math.sin(angle) * half;

      if (b < 100) {
        // Dark: Cross-hatch following the curve
        d = `M ${cx - cos} ${cy - sin} L ${cx + cos} ${cy + sin} 
             M ${cx + sin} ${cy - cos} L ${cx - sin} ${cy + cos}`;
      } else if (b < 190) {
        // Mid: Single line following the curve
        d = `M ${cx - cos} ${cy - sin} L ${cx + cos} ${cy + sin}`;
      } else if (b < 240) {
        // Light: Tiny circle (as requested before!)
        const r = 0.8;
        d = `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;
      }

      if (d) paths.push(createPathElement(d));
    }
  }
  return paths;
}

function generateBlueprint(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  const paths = [];

  const cellSize = Math.max(5, Math.floor(18 - detail * 13));
  const r = cellSize / 16; // Radius for the tiny circles

  for (let y = 0; y < h; y += cellSize) {
    for (let x = 0; x < w; x += cellSize) {
      const idx = (y * w + x) * 4;
      if (imgData[idx + 3] < 128) continue; 

      const b = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;
      let d = "";

      if (b < 60) {
        // Very Dark: X with a Box
        d = `M ${x} ${y} L ${x+cellSize} ${y+cellSize} M ${x+cellSize} ${y} L ${x} ${y+cellSize} M ${x} ${y} H ${x+cellSize} V ${y+cellSize} H ${x} Z`;
      } else if (b < 120) {
        // Dark: Simple X
        d = `M ${x} ${y} L ${x+cellSize} ${y+cellSize} M ${x+cellSize} ${y} L ${x} ${y+cellSize}`;
      } else if (b < 180) {
        // Midtone: Diagonal Slash
        d = `M ${x} ${y+cellSize} L ${x+cellSize} ${y}`;
      } else if (b < 240) {
        // Light: Small Circle instead of a point
        const cx = x + cellSize / 2;
        const cy = y + cellSize / 2;
        // SVG Arc command to draw a circle
        d = `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;

        /* Note: Initially this drew a dot but sometimes pen plotters struggle with points, so I switched to a tiny circle.
        // Light: A tiny center dot
        d = `M ${x+cellSize/2} ${y+cellSize/2} h 0.1`;*/
      }
      

      if (d) paths.push(createPathElement(d));
    }
  }
  return paths;
}

function generateConstellation(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  const paths = [];
  
  const points = [];
  // Sample the image in a grid
  const step = Math.max(6, Math.floor(20 - detail * 14));
  
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const idx = (y * w + x) * 4;
      if (imgData[idx + 3] < 128) continue;

      const brightness = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;
      
      // If it's a dark area (feature), add a point with a slight random jitter
      // Darker areas get more points to ensure feature recognition
      if (brightness < 160) {
        points.push({
          x: x + (Math.random() - 0.5) * step,
          y: y + (Math.random() - 0.5) * step,
          b: brightness
        });
      }
    }
  }

  // Connect points to their neighbors
  // This creates the "web" look
  const maxDist = step * 1.5;
  for (let i = 0; i < points.length; i++) {
    let pathD = "";
    let connections = 0;
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      
      if (d < maxDist) {
        pathD += `M ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)} L ${points[j].x.toFixed(1)} ${points[j].y.toFixed(1)} `;
        connections++;
      }
      // Limit connections per point to keep it clean
      if (connections > 3) break;
    }
    if (pathD) paths.push(createPathElement(pathD));
  }

  return paths;
}

function generateTopoLines(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  const paths = [];

  // Spacing between horizontal flow lines
  const lineSpacing = Math.max(3, Math.floor(10 - detail * 7));
  // How much the "terrain" pushes the line up or down
  const distortionStrength = 15 + (detail * 20); 

  for (let y = 0; y < h; y += lineSpacing) {
    let pathD = "";
    let inSeg = false;

    for (let x = 0; x < w; x += 2) {
      const idx = (Math.floor(y) * w + x) * 4;
      const alpha = imgData[idx + 3];
      
      if (alpha < 128) {
        inSeg = false;
        continue;
      }

      const r = imgData[idx], g = imgData[idx+1], b = imgData[idx+2];
      const brightness = (r + g + b) / 3;
      
      // Calculate "Altitude"
      // Normalized brightness (0 to 1). 1 is a peak, 0 is a valley.
      const normB = brightness / 255;
      
      // The "Warp": Light areas push the line UP (y - offset), 
      // dark areas (eyes/mouth) pull it DOWN or keep it steady.
      const offsetY = (1 - normB) * distortionStrength;
      const newY = y + offsetY;

      if (!inSeg) {
        pathD += `M ${x} ${newY.toFixed(1)} `;
        inSeg = true;
      } else {
        pathD += `L ${x} ${newY.toFixed(1)} `;
      }
    }
    if (pathD) paths.push(createPathElement(pathD));
  }
  return paths;
}

// Styles that draw their own paths and don't need ImageTracer
const CUSTOM_STYLE_GENERATORS = {
  squiggle: generateSquiggleLines,
  sobel: generateSobelLines,
  topo: generateTopoLines,
  constellation: generateConstellation,
  blueprint: generateBlueprint,
  invader: generateInvaders,
  pinwheel: generatePinwheel,
  wiggle: generateWiggles,
  shards: generateShards,
  composition: generateComposition
};

function makeSVGElement(w, h) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  return svg;
}

function finalizeSVG(svg) {
  const serializer = new XMLSerializer();
  const finalSVG = serializer.serializeToString(svg);
  preview.innerHTML = finalSVG;
  preview.dataset.svg = finalSVG;
}

function generateSVGFromCanvasAsync(sourceCanvas, style, detail, current = () => true) {
  return new Promise((resolve, reject) => {
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;

    // Custom styles generate their own paths — skip the PNG encode + trace entirely
    const generator = CUSTOM_STYLE_GENERATORS[style];
    if (generator) {
      const svg = makeSVGElement(w, h);
      generator(sourceCanvas, detail).forEach(p => svg.appendChild(p));
      if (current()) finalizeSVG(svg);
      resolve();
      return;
    }

    // Outline and Pixel use ImageTracer
    const dataURL = sourceCanvas.toDataURL('image/png');
    const options = {
      ltres: Math.max(1, 1 + (1-detail)*5),
      qtres: Math.max(1, 1 + (1-detail)*5),
      pathomit: Math.max(0.5, (1-detail)*8),
      numberofcolors: style === 'pixel' ? 6 : 2,
      strokewidth: 1,
      blurradius: 0
    };

    ImageTracer.imageToSVG(dataURL, function(svgstr) {
      try {
        if (!current()) { resolve(); return; }
        const doc = new DOMParser().parseFromString(svgstr, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        if (!svg || doc.querySelector('parsererror')) throw new Error('Invalid drawing');
        svg.setAttribute('width', w);
        svg.setAttribute('height', h);
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.querySelectorAll('path').forEach(p => {
          p.setAttribute('fill', 'none');
          p.setAttribute('stroke', '#000');
          p.setAttribute('stroke-width', '1');
        });
        if (current()) finalizeSVG(svg);
        resolve();
      } catch (err) { reject(err); }
    }, options);
  });
}

// --- STYLE GENERATORS ---

function generateSobelLines(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  const paths = [];

  const spacing = Math.max(3, Math.floor(10 - detail * 7)); 
  
  // We scan horizontally. To get features, we look for VERTICAL changes (edges)
  for (let y = 0; y < h; y += spacing) {
    let pathD = "";
    let inSegment = false;

    for (let x = 1; x < w - 1; x += 2) {
      const idx = (y * w + x) * 4;
      const alpha = imgData[idx + 3];
      if (alpha < 128) { inSegment = false; continue; }

      // SOBEL-LITE: Compare brightness of pixel to the one below it
      const brightCenter = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;
      const idxBelow = ((y + 1) * w + x) * 4;
      const brightBelow = (imgData[idxBelow] + imgData[idxBelow+1] + imgData[idxBelow+2]) / 3;
      
      const edgeStrength = Math.abs(brightCenter - brightBelow);

      // FEATURE LOGIC: 
      // Draw if it's quite dark OR if it's a sharp edge (like a lip line)
      const isFeature = edgeStrength > (20 - detail * 10);
      const isShadow = brightCenter < 120;

      if (isFeature || isShadow) {
        if (!inSegment) {
          pathD += `M ${x} ${y} `;
          inSegment = true;
        } else {
          pathD += `L ${x} ${y} `;
        }
      } else {
        inSegment = false;
      }
    }
    if (pathD) paths.push(createPathElement(pathD));
  }
  return paths;
}

function generateSquiggleLines(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  
  const lineSpacing = Math.max(4, Math.floor(16 - detail * 12));
  const baseAmplitude = 2 + detail * 4;
  const baseFrequency = 0.05 + detail * 0.1;
  const segmentLength = 3;
  
  const paths = [];
  for (let y = 0; y < h; y += lineSpacing) {
    let pathD = '';
    let inSegment = false;
    for (let x = 0; x < w; x += segmentLength) {
      const idx = (Math.floor(y) * w + Math.floor(x)) * 4;
      const brightness = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;
      const alpha = imgData[idx+3];
      
      if (alpha > 128 && brightness < 240) {
        const darkness = 1 - (brightness / 255);
        const amplitude = baseAmplitude * darkness;
        const waveY = y + Math.sin(x * (baseFrequency * (0.5 + darkness))) * amplitude;
        if (!inSegment) { pathD += `M ${x} ${waveY.toFixed(1)} `; inSegment = true; } 
        else { pathD += `L ${x} ${waveY.toFixed(1)} `; }
      } else { inSegment = false; }
    }
    if (pathD) paths.push(createPathElement(pathD));
  }
  return paths;
}

function createPathElement(d) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', '#000');
  p.setAttribute('stroke-width', '1');
  p.setAttribute('stroke-linecap', 'round');
  return p;
}

function downloadSVG() {
  const svg = preview.dataset.svg;
  if (!svg || downloadBtn.disabled) return;
  const blob = new Blob([svg], {type: 'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'penplot.svg';
  a.click();
  URL.revokeObjectURL(url);
}

window.addEventListener('load', init);
