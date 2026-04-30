// app.js — camera capture -> person segmentation -> vectorize -> SVG download
let video = null;
let startBtn = null;
let takeBtn = null;
let downloadBtn = null;
let styleSelect = null;
let detailRange = null;
let preview = null;
let canvas = null;
let ctx = null;
let net = null;
let isFrozen = false;
let livePreviewId = null;

// Mode and upload
let currentMode = 'camera'; // 'camera' or 'upload'
let uploadedImage = null;
let fileInput = null;
let uploadBtn = null;
let modeCameraBtn = null;
let modeUploadBtn = null;
let sourceLabel = null;
let uploadedImageEl = null;

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

  // Mode/upload elements
  fileInput = document.getElementById('file-upload');
  uploadBtn = document.getElementById('upload-btn');
  modeCameraBtn = document.getElementById('mode-camera');
  modeUploadBtn = document.getElementById('mode-upload');
  sourceLabel = document.getElementById('source-label');
  uploadedImageEl = document.getElementById('uploaded-image');

  // Event listeners
  startBtn.addEventListener('click', startCamera);
  takeBtn.addEventListener('click', takePhoto);
  downloadBtn.addEventListener('click', downloadSVG);
  
  // Mode switching
  modeCameraBtn.addEventListener('click', () => switchMode('camera'));
  modeUploadBtn.addEventListener('click', () => switchMode('upload'));
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileUpload);
  
  // Live update on style/detail change in upload mode
  styleSelect.addEventListener('change', () => {
    if (currentMode === 'upload' && uploadedImage && !isFrozen) {
      processUploadedImage();
    }
  });
  detailRange.addEventListener('input', () => {
    if (currentMode === 'upload' && uploadedImage && !isFrozen) {
      processUploadedImage();
    }
  });

  // Load BodyPix model in background
  net = await bodyPix.load({architecture: 'MobileNetV1', outputStride: 16, multiplier: 0.75, quantBytes: 2});
}

function switchMode(mode) {
  currentMode = mode;
  
  // Update toggle buttons and animation
  const modeToggle = document.querySelector('.mode-toggle');
  modeToggle.setAttribute('data-mode', mode);
  
  // Update toggle buttons
  modeCameraBtn.classList.toggle('active', mode === 'camera');
  modeUploadBtn.classList.toggle('active', mode === 'upload');
  
  // Show/hide appropriate controls
  if (mode === 'camera') {
    startBtn.style.display = '';
    startBtn.disabled = false;
    takeBtn.style.display = '';
    takeBtn.disabled = true;
    takeBtn.textContent = 'Freeze';
    uploadBtn.style.display = 'none';
    video.style.display = '';
    uploadedImageEl.style.display = 'none';
    sourceLabel.textContent = 'Camera';
    downloadBtn.disabled = true;
    
    // Stop any live preview
    isFrozen = false;
    if (livePreviewId) cancelAnimationFrame(livePreviewId);
    livePreviewId = null;
  } else {
    startBtn.style.display = 'none';
    takeBtn.style.display = '';
    // In upload mode the Freeze control is not applicable — keep it deactivated
    takeBtn.disabled = true;
    takeBtn.textContent = 'Freeze';
    uploadBtn.style.display = '';
    video.style.display = 'none';
    uploadedImageEl.style.display = uploadedImage ? '' : 'none';
    sourceLabel.textContent = 'Image';
    // Downloads become available after the uploaded image is processed into an SVG
    downloadBtn.disabled = true;
    
    // Stop camera stream if running
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(track => track.stop());
      video.srcObject = null;
    }
    if (livePreviewId) cancelAnimationFrame(livePreviewId);
    livePreviewId = null;
    isFrozen = false;
  }
  
  // Clear preview
  preview.innerHTML = '';
  preview.dataset.svg = '';
}

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (event) => {
    uploadedImage = new Image();
    uploadedImage.onload = () => {
      uploadedImageEl.src = uploadedImage.src;
      uploadedImageEl.style.display = '';
      // Freeze is not applicable for uploads — keep the button deactivated
      takeBtn.disabled = true;
      isFrozen = false;
      takeBtn.textContent = 'Freeze';
      downloadBtn.disabled = true;
      
      // Auto-process the image
      processUploadedImage();
    };
    uploadedImage.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

async function processUploadedImage() {
  if (!uploadedImage) return;
  
  // Resize to reasonable dimensions
  const maxDim = 640;
  let w = uploadedImage.naturalWidth;
  let h = uploadedImage.naturalHeight;
  
  if (w > maxDim || h > maxDim) {
    if (w > h) {
      h = Math.round(h * (maxDim / w));
      w = maxDim;
    } else {
      w = Math.round(w * (maxDim / h));
      h = maxDim;
    }
  }
  
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(uploadedImage, 0, 0, w, h);
  
  // Run segmentation
  const segmentation = await net.segmentPerson(canvas, {internalResolution: 'medium', segmentationThreshold: 0.7});
  
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  for (let i = 0; i < w * h; i++) {
    if (!segmentation.data[i]) {
      data[i * 4 + 3] = 0;
    }
  }
  
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  outCtx.putImageData(imgData, 0, 0);
  
  const style = styleSelect.value;
  const detail = parseFloat(detailRange.value);
  
  if (style === 'pixel') {
    const px = Math.max(24, Math.floor(64 + detail * 256));
    const tiny = document.createElement('canvas');
    tiny.width = px;
    tiny.height = Math.round(px * h / w);
    const tctx = tiny.getContext('2d', { willReadFrequently: true });
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(outCanvas, 0, 0, tiny.width, tiny.height);
    const scaled = document.createElement('canvas');
    scaled.width = w;
    scaled.height = h;
    const sctx = scaled.getContext('2d', { willReadFrequently: true });
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(tiny, 0, 0, w, h);
    await generateSVGFromCanvasAsync(scaled, style, detail);
  } else {
    await generateSVGFromCanvasAsync(outCanvas, style, detail);
  }

  // Enable download in upload mode after SVG generation completes
  if (currentMode === 'upload') {
    downloadBtn.disabled = false;
  }
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'user'}, audio: false});
    video.srcObject = stream;
    await video.play();
    takeBtn.disabled = false;
    takeBtn.textContent = 'Freeze';
    startBtn.disabled = true;
    isFrozen = false;
    startLivePreview();
  } catch (err) {
    alert('Could not start camera: ' + err.message);
  }
}

function startLivePreview() {
  if (livePreviewId) cancelAnimationFrame(livePreviewId);
  async function loop() {
    if (!isFrozen && video.readyState === 4) {
      await processFrame();
    }
    livePreviewId = requestAnimationFrame(loop);
  }
  loop();
}

async function processFrame() {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);

  const segmentation = await net.segmentPerson(canvas, {internalResolution: 'medium', segmentationThreshold: 0.7});

  const imgData = ctx.getImageData(0,0,w,h);
  const data = imgData.data;
  for (let i=0;i<w*h;i++){
    const seg = segmentation.data[i];
    if (!seg) { data[i*4+3] = 0; }
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = w; outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  outCtx.putImageData(imgData, 0, 0);

  const style = styleSelect.value;
  const detail = parseFloat(detailRange.value);

  if (style === 'pixel') {
    const px = Math.max(24, Math.floor(64 + detail * 256));
    const tiny = document.createElement('canvas');
    tiny.width = px; tiny.height = Math.round(px * h / w);
    const tctx = tiny.getContext('2d', { willReadFrequently: true });
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(outCanvas, 0, 0, tiny.width, tiny.height);
    const scaled = document.createElement('canvas'); scaled.width = w; scaled.height = h;
    const sctx = scaled.getContext('2d', { willReadFrequently: true }); sctx.imageSmoothingEnabled = false;
    sctx.drawImage(tiny, 0, 0, w, h);
    await generateSVGFromCanvasAsync(scaled, style, detail);
  } else {
    await generateSVGFromCanvasAsync(outCanvas, style, detail);
  }
}

function takePhoto() {
  isFrozen = !isFrozen;
  takeBtn.textContent = isFrozen ? 'Resume' : 'Freeze';
  downloadBtn.disabled = !isFrozen;
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

function generateSVGFromCanvasAsync(sourceCanvas, style, detail) {
  return new Promise((resolve) => {
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
      let parser = new DOMParser();
      let doc = parser.parseFromString(svgstr, 'image/svg+xml');
      let svg = doc.querySelector('svg');
      if (!svg) { resolve(); return; }

      svg.setAttribute('width', sourceCanvas.width);
      svg.setAttribute('height', sourceCanvas.height);
      svg.setAttribute('viewBox', `0 0 ${sourceCanvas.width} ${sourceCanvas.height}`);

      const paths = svg.querySelectorAll('path');
      
      // Handle Custom Remix Styles
      if (style === 'squiggle') {
        paths.forEach(p => p.remove());
        const squigglePaths = generateSquiggleLines(sourceCanvas, detail);
        squigglePaths.forEach(pathEl => svg.appendChild(pathEl));
      }
      else if (style === 'sobel') {
        paths.forEach(p => p.remove());
        const hatchPaths = generateSobelLines(sourceCanvas, detail);
        hatchPaths.forEach(pathEl => svg.appendChild(pathEl));
      } 
      else if (style === 'topo') {
        paths.forEach(p => p.remove());
        const topoPaths = generateTopoLines(sourceCanvas, detail);
        topoPaths.forEach(pathEl => svg.appendChild(pathEl));
      }
      else if (style === 'spiral') {
        paths.forEach(p => p.remove());
        const spiralPaths = generateSpiralLines(sourceCanvas, detail);
        spiralPaths.forEach(pathEl => svg.appendChild(pathEl));
      }
      else if (style === 'constellation') {
        paths.forEach(p => p.remove());
        const dotPaths = generateConstellation(sourceCanvas, detail);
        dotPaths.forEach(pathEl => svg.appendChild(pathEl));
      }
      else if (style === 'blueprint') {
        paths.forEach(p => p.remove());
        const blueprintPaths = generateBlueprint(sourceCanvas, detail);
        blueprintPaths.forEach(pathEl => svg.appendChild(pathEl));
      }
      else if (style === 'invader') {
        paths.forEach(p => p.remove());
        const invaderPaths = generateInvaders(sourceCanvas, detail);
        invaderPaths.forEach(pathEl => svg.appendChild(pathEl));
      }
      else if (style === 'pinwheel') {
        paths.forEach(p => p.remove());
        const pinwheelPaths = generatePinwheel(sourceCanvas, detail);
        pinwheelPaths.forEach(pathEl => svg.appendChild(pathEl));
      }
      else if (style === 'scribble') {
        paths.forEach(p => p.remove());
        const scribblePaths = generateScribbles(sourceCanvas, detail);
        scribblePaths.forEach(pathEl => svg.appendChild(pathEl));
      }
      else if (style === 'wiggle') {
        paths.forEach(p => p.remove());
        const wigglePaths = generateWiggles(sourceCanvas, detail);
        wigglePaths.forEach(pathEl => svg.appendChild(pathEl));
      }
      else if (style === 'shards') {
        paths.forEach(p => p.remove());
        const shardPaths = generateShards(sourceCanvas, detail);
        shardPaths.forEach(pathEl => svg.appendChild(pathEl));
      }
      else if (style === 'composition') {
        paths.forEach(p => p.remove());
        const compPaths = generateComposition(sourceCanvas, detail);
        compPaths.forEach(pathEl => svg.appendChild(pathEl));
      } else {
        // Standard Outline or Pixel logic
        paths.forEach(p => {
          p.setAttribute('fill', 'none');
          p.setAttribute('stroke', '#000');
          p.setAttribute('stroke-width', '1');
        });
      }

      const serializer = new XMLSerializer();
      const finalSVG = serializer.serializeToString(svg);
      preview.innerHTML = finalSVG;
      preview.dataset.svg = finalSVG;
      resolve();
    }, options);
  });
}

// --- STYLE GENERATORS ---

function generateSpiralLines(sourceCanvas, detail) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const tctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = tctx.getImageData(0, 0, w, h).data;
  
  const centerX = w / 2;
  const centerY = h / 2;
  const maxRadius = Math.sqrt(w*w + h*h) / 2;
  
  // Controls how tight the spiral is
  const spacing = Math.max(2, Math.floor(10 - detail * 7));
  let pathD = "";
  let inSeg = false;

  // We loop through the radius and the angle
  for (let r = 2; r < maxRadius; r += spacing / 10) {
    // The angle moves as the radius increases
    const angle = r * (spacing * 0.5);
    const x = centerX + Math.cos(angle) * r;
    const y = centerY + Math.sin(angle) * r;

    if (x >= 0 && x < w && y >= 0 && y < h) {
      const idx = (Math.floor(y) * w + Math.floor(x)) * 4;
      const alpha = imgData[idx + 3];
      
      if (alpha > 128) {
        const brightness = (imgData[idx] + imgData[idx+1] + imgData[idx+2]) / 3;
        const darkness = 1 - (brightness / 255);
        
        // The "Spirograph" wobble: 
        // Darker pixels = bigger amplitude waves along the spiral
        const wobble = Math.sin(r * 2) * (darkness * spacing * 1.5);
        const finalX = centerX + Math.cos(angle) * (r + wobble);
        const finalY = centerY + Math.sin(angle) * (r + wobble);

        if (!inSeg) {
          pathD += `M ${finalX.toFixed(1)} ${finalY.toFixed(1)} `;
          inSeg = true;
        } else {
          pathD += `L ${finalX.toFixed(1)} ${finalY.toFixed(1)} `;
        }
      } else {
        inSeg = false;
      }
    }
  }

  return [createPathElement(pathD)];
}

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
  if (!svg) return;
  const blob = new Blob([svg], {type: 'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'penplot.svg';
  a.click();
  URL.revokeObjectURL(url);
}

window.addEventListener('load', init);