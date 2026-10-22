// mask-editor.js — paint over a still to add to or erase from the person mask.
// Works on app.js globals (lastFrame, lastMask, editedMask, rerenderStill); the output redraws as you paint.
(function () {
  'use strict';

  const MIN_R = 2, MAX_R = 80, UNDO_LIMIT = 40;
  const ADD_RGB = [20, 184, 166];   // teal outline of the person
  const BRUSH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L11 15.8 8.2 13z"/><path d="M7.1 14.2c-1.8 0-3.2 1.5-3.2 3.3 0 1.4-1.3 2.2-2 2.5 1 1.3 2.6 2 4.3 2 2.4 0 4.3-1.9 4.3-4.3 0-.3 0-.6-.1-.9z"/></svg>';

  let container, stage, surface, editBtn, canvas, cctx, cursor, toolbar, sizeInput, addBtn, eraseBtn, undoBtn, resetBtn, panBtn, zoomInput;
  let available = false, isOpen = false;
  let frame = null, mask = null, w = 0, h = 0, overlay = null;
  let mode = 'add', radius = 16, altHeld = false;
  let undo = [];
  let painting = false, last = null, hovering = false, hoverPt = null;
  let pointerId = null, panMode = false, panStart = null, zoom = 1;
  let rafId = 0, overlayDirty = false, outputDirty = false;

  function build() {
    container = document.querySelector('.video-container');
    if (!container) return false;
    document.getElementById('cutout-action').insertAdjacentHTML('beforeend', `
      <button type="button" class="mask-edit-btn" hidden title="Correct which parts of the photo appear in your drawing">${BRUSH_ICON}<span>Refine cutout</span></button>`);
    container.insertAdjacentHTML('beforeend', `
      <div class="mask-stage" hidden><div class="mask-surface"><canvas class="mask-canvas" aria-label="Paint on the photo to keep or remove areas"></canvas></div></div>
      <div class="mask-cursor" hidden></div>`);
    document.getElementById('cutout-tools').innerHTML = `
      <div class="mask-tools" hidden>
        <p class="mask-tip" id="mask-help">Highlighted areas stay in the drawing. Brush to keep or remove parts of the photo.</p>
        <div class="mask-toolbar" role="group" aria-label="Cutout tools">
          <div class="mask-seg">
            <button type="button" data-mode="add" title="Keep in the drawing (A)"><b>+</b> Keep</button>
            <button type="button" data-mode="erase" title="Remove from the drawing (E)"><b>−</b> Remove</button>
          </div>
          <label class="mask-size">Brush <input type="range" min="${MIN_R}" max="${MAX_R}" step="1" aria-label="Brush size"></label>
          <button type="button" data-act="undo" title="Undo (Ctrl/⌘ Z)">Undo</button>
          <button type="button" data-act="reset" title="Restore the automatic cutout">Reset</button>
          <button type="button" data-act="done" class="mask-done">Done</button>
        </div>
        <div class="mask-view-controls">
          <label>View <select aria-label="Photo zoom"><option value="1">Fit</option><option value="2">2×</option><option value="4">4×</option></select></label>
          <button type="button" data-act="pan" aria-pressed="false">Move view</button>
          <details><summary>Shortcuts</summary><p>A: Keep · E: Remove · X: swap · Alt/Option: swap temporarily · [ / ] or scroll: brush size · Ctrl/⌘ Z: undo · Esc: done</p></details>
        </div>
      </div>`;
    editBtn = document.querySelector('.mask-edit-btn');
    stage = container.querySelector('.mask-stage');
    surface = container.querySelector('.mask-surface');
    canvas = container.querySelector('.mask-canvas');
    cctx = canvas.getContext('2d');
    cursor = container.querySelector('.mask-cursor');
    toolbar = document.querySelector('.mask-tools');
    canvas.setAttribute('aria-describedby', 'mask-help');
    sizeInput = toolbar.querySelector('input');
    addBtn = toolbar.querySelector('[data-mode="add"]');
    eraseBtn = toolbar.querySelector('[data-mode="erase"]');
    undoBtn = toolbar.querySelector('[data-act="undo"]');
    resetBtn = toolbar.querySelector('[data-act="reset"]');
    panBtn = toolbar.querySelector('[data-act="pan"]');
    zoomInput = toolbar.querySelector('select');
    zoomInput.addEventListener('change', () => { zoom = Number(zoomInput.value); layoutCanvas(); });
    panBtn.addEventListener('click', () => { panMode = !panMode; updatePan(); });
    new ResizeObserver(() => { if (isOpen) layoutCanvas(); }).observe(container);
    stage.addEventListener('scroll', () => { cursor.hidden = true; });
    sizeInput.value = radius;

    editBtn.addEventListener('click', open);
    addBtn.addEventListener('click', () => setMode('add'));
    eraseBtn.addEventListener('click', () => setMode('erase'));
    undoBtn.addEventListener('click', undoStep);
    resetBtn.addEventListener('click', resetMask);
    toolbar.querySelector('[data-act="done"]').addEventListener('click', close);
    sizeInput.addEventListener('input', () => setRadius(parseInt(sizeInput.value, 10), true));

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerenter', () => { hovering = true; });
    canvas.addEventListener('pointerleave', () => { hovering = false; if (!painting) cursor.hidden = true; });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', (e) => { if (e.key === 'Alt' && altHeld) { altHeld = false; updateCursor(); } });
    window.addEventListener('blur', () => { altHeld = false; endStroke(); updateCursor(); });
    window.addEventListener('resize', () => { if (isOpen) updateCursor(); });
    return true;
  }

  // ---------- open / close ----------
  function setAvailable(v) {
    available = !!v;
    if (!available && isOpen) close();
    if (editBtn) editBtn.hidden = !available || isOpen;
  }

  function open() {
    if (!available || !lastFrame || isOpen) return;
    if (frame !== lastFrame) { undo = []; zoom = 1; }
    frame = lastFrame; w = frame.width; h = frame.height;
    mask = Uint8Array.from(editedMask || lastMask);
    canvas.width = w; canvas.height = h;
    overlay = cctx.createImageData(w, h);
    isOpen = true;
    container.classList.add('mask-editing');
    editBtn.hidden = true;
    stage.hidden = toolbar.hidden = false;
    zoomInput.value = String(zoom);
    panMode = false; altHeld = false;
    updatePan();
    layoutCanvas();
    setMode(mode);
    updateUndo();
    drawOverlay();
    addBtn.focus();
  }

  function close() {
    if (!isOpen) return;
    const returnFocus = toolbar.contains(document.activeElement);
    endStroke();
    isOpen = false; hovering = false; hoverPt = null;
    container.classList.remove('mask-editing');
    stage.hidden = toolbar.hidden = cursor.hidden = true;
    editBtn.hidden = !available;
    editBtn.classList.toggle('mask-edited', !!editedMask);
    if (returnFocus && available) editBtn.focus();
  }

  function reset() {
    available = false;
    close();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0; overlayDirty = outputDirty = false;
    frame = mask = overlay = null; undo = []; zoom = 1;
    editBtn.hidden = true;
    editBtn.classList.remove('mask-edited');
  }

  function layoutCanvas() {
    if (!isOpen) return;
    const oldW = surface.offsetWidth, oldH = surface.offsetHeight;
    const centerX = oldW ? (stage.scrollLeft + stage.clientWidth / 2) / oldW : 0.5;
    const centerY = oldH ? (stage.scrollTop + stage.clientHeight / 2) / oldH : 0.5;
    const scale = Math.min(stage.clientWidth / w, stage.clientHeight / h) * zoom;
    const sw = Math.max(stage.clientWidth, w * scale), sh = Math.max(stage.clientHeight, h * scale);
    surface.style.width = sw + 'px'; surface.style.height = sh + 'px';
    canvas.style.width = w * scale + 'px'; canvas.style.height = h * scale + 'px';
    canvas.style.left = (sw - w * scale) / 2 + 'px'; canvas.style.top = (sh - h * scale) / 2 + 'px';
    stage.scrollLeft = centerX * sw - stage.clientWidth / 2;
    stage.scrollTop = centerY * sh - stage.clientHeight / 2;
    cursor.hidden = true;
  }

  function updatePan() {
    panBtn.setAttribute('aria-pressed', String(panMode));
    canvas.style.cursor = panMode ? 'grab' : 'none';
    if (panMode) cursor.hidden = true;
  }

  // ---------- tools ----------
  function effectiveMode() { return altHeld ? (mode === 'add' ? 'erase' : 'add') : mode; }

  function setMode(m) {
    mode = m; panMode = false; updatePan();
    addBtn.setAttribute('aria-pressed', String(m === 'add'));
    eraseBtn.setAttribute('aria-pressed', String(m === 'erase'));
    updateCursor();
  }

  function setRadius(r, preview) {
    radius = Math.max(MIN_R, Math.min(MAX_R, Math.round(r)));
    sizeInput.value = radius;
    // show the brush in the middle of the photo while sizing it from the toolbar
    if (preview && !hovering) hoverPt = null;
    updateCursor(preview && !hovering);
  }

  function pushUndo() {
    undo.push(mask.slice());
    if (undo.length > UNDO_LIMIT) undo.shift();
    updateUndo();
  }
  function updateUndo() { undoBtn.disabled = undo.length === 0; resetBtn.disabled = !editedMask; }

  function undoStep() {
    if (!undo.length) return;
    mask.set(undo.pop());
    updateUndo();
    changed();
  }

  function resetMask() {
    if (!lastMask || !editedMask) return;
    pushUndo();
    mask.set(lastMask);
    changed();
  }

  function changed() {
    editedMask = mask.some((value, i) => value !== lastMask[i]) ? mask : null;
    editBtn.classList.toggle('mask-edited', !!editedMask);
    updateUndo();
    // Invalidate any trace immediately, before the next animation frame runs.
    renderVersion++;
    downloadBtn.disabled = true;
    preview.dataset.ready = 'false';
    overlayDirty = outputDirty = true;
    schedule();
  }

  // ---------- painting ----------
  function contentBox() {
    const r = canvas.getBoundingClientRect();
    const s = Math.min(r.width / w, r.height / h);
    return { left: r.left + (r.width - w * s) / 2, top: r.top + (r.height - h * s) / 2, scale: s, rect: r };
  }

  function toImage(e) {
    const b = contentBox();
    return { x: (e.clientX - b.left) / b.scale, y: (e.clientY - b.top) / b.scale, cx: e.clientX, cy: e.clientY };
  }

  function stamp(cx, cy, val) {
    const r2 = radius * radius;
    const y0 = Math.max(0, Math.ceil(cy - radius)), y1 = Math.min(h - 1, Math.floor(cy + radius));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const dx = Math.sqrt(Math.max(0, r2 - dy * dy));
      const x0 = Math.max(0, Math.ceil(cx - dx)), x1 = Math.min(w - 1, Math.floor(cx + dx));
      if (x1 >= x0) mask.fill(val, y * w + x0, y * w + x1 + 1);
    }
  }

  function strokeTo(p) {
    const val = effectiveMode() === 'add' ? 1 : 0;
    if (!last) { stamp(p.x, p.y, val); last = p; return; }
    const n = Math.ceil(Math.hypot(p.x - last.x, p.y - last.y) / Math.max(1, radius / 4));
    for (let i = 1; i <= n; i++) stamp(last.x + (p.x - last.x) * i / n, last.y + (p.y - last.y) * i / n, val);
    last = p;
  }

  function onDown(e) {
    if (e.button !== 0 || pointerId !== null) return;
    e.preventDefault();
    altHeld = e.altKey;
    pointerId = e.pointerId;
    canvas.setPointerCapture(pointerId);
    if (panMode) { panStart = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop }; return; }
    painting = true; last = null;
    pushUndo();
    const p = toImage(e);
    hoverPt = p;
    strokeTo(p);
    changed();
    updateCursor();
  }

  function onMove(e) {
    if (pointerId !== null && e.pointerId !== pointerId) return;
    if (panStart) { stage.scrollLeft = panStart.left - (e.clientX - panStart.x); stage.scrollTop = panStart.top - (e.clientY - panStart.y); return; }
    hovering = true;
    if (altHeld !== e.altKey && !painting) altHeld = e.altKey;
    const events = painting && e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (events.length ? events : [e])) {
      const p = toImage(ev);
      hoverPt = p;
      if (painting) strokeTo(p);
    }
    if (painting) changed();
    updateCursor();
  }

  function endStroke() {
    if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    pointerId = null; painting = false; last = null; panStart = null;
  }

  function onUp(e) {
    if (e.pointerId !== pointerId) return;
    endStroke();
    if (e.pointerType !== 'mouse') cursor.hidden = true;
  }

  function onWheel(e) {
    e.preventDefault();
    setRadius(radius * Math.pow(1.0015, -e.deltaY), false);
  }

  function onKey(e) {
    if (!isOpen) return;
    const t = e.target;
    if (t && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range') || t.tagName === 'TEXTAREA')) return;
    const k = e.key;
    if (k === 'Alt') { if (!altHeld) { altHeld = true; updateCursor(); } e.preventDefault(); return; }
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') { e.preventDefault(); undoStep(); return; }
    if (e.metaKey || e.ctrlKey) return;
    if (k === 'a' || k === 'A' || k === 'b' || k === 'B') setMode('add');
    else if (k === 'e' || k === 'E') setMode('erase');
    else if (k === 'x' || k === 'X') setMode(mode === 'add' ? 'erase' : 'add');
    else if (k === '[') setRadius(radius / 1.2, false);
    else if (k === ']') setRadius(radius * 1.2 + 0.5, false);
    else if (k === 'Escape' || (k === 'Enter' && (!t || t.tagName !== 'BUTTON'))) close();
    else return;
    e.preventDefault();
  }

  // ---------- drawing ----------
  function updateCursor(centered) {
    if (!isOpen || panMode) { cursor.hidden = true; return; }
    const b = contentBox();
    const crect = container.getBoundingClientRect();
    let px, py;
    if (centered) { px = b.left + (w * b.scale) / 2; py = b.top + (h * b.scale) / 2; }
    else if (hoverPt && (hovering || painting)) { px = hoverPt.cx; py = hoverPt.cy; }
    else { cursor.hidden = true; return; }
    const d = Math.max(4, radius * 2 * b.scale);
    cursor.style.width = cursor.style.height = d + 'px';
    cursor.style.left = (px - crect.left) + 'px';
    cursor.style.top = (py - crect.top) + 'px';
    cursor.className = 'mask-cursor ' + (effectiveMode() === 'add' ? 'mask-cursor-add' : 'mask-cursor-erase');
    cursor.hidden = false;
    if (centered) {
      clearTimeout(updateCursor.t);
      updateCursor.t = setTimeout(() => { if (!hovering && !painting) cursor.hidden = true; }, 700);
    }
  }

  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function tick() {
    rafId = 0;
    if (overlayDirty) { overlayDirty = false; if (isOpen) drawOverlay(); }
    if (outputDirty) { outputDirty = false; rerenderStill(); }
  }

  // The person keeps full colour with a teal edge; everything outside is dimmed to grey
  function drawOverlay() {
    const src = frame.data, out = overlay.data, n = w * h;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = src[p], g = src[p + 1], b = src[p + 2];
      if (mask[i]) {
        const x = i % w;
        const edge = (x > 0 && !mask[i - 1]) || (x < w - 1 && !mask[i + 1]) ||
          (i >= w && !mask[i - w]) || (i < n - w && !mask[i + w]);
        if (edge) { out[p] = ADD_RGB[0]; out[p + 1] = ADD_RGB[1]; out[p + 2] = ADD_RGB[2]; }
        else { out[p] = r * 0.85 + ADD_RGB[0] * 0.15; out[p + 1] = g * 0.85 + ADD_RGB[1] * 0.15; out[p + 2] = b * 0.85 + ADD_RGB[2] * 0.15; }
      } else {
        const l = (r * 0.3 + g * 0.59 + b * 0.11) * 0.3;
        out[p] = out[p + 1] = out[p + 2] = l;
      }
      out[p + 3] = 255;
    }
    cctx.putImageData(overlay, 0, 0);
  }

  function init() {
    if (!build()) return;
    window.MaskEditor = { setAvailable, open, close, reset, get isOpen() { return isOpen; } };
    if (typeof updateMaskEditAvailability === 'function') updateMaskEditAvailability();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
