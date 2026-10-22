// mask-editor.js — paint over a still to add to or erase from the person mask.
// Works on app.js globals (lastFrame, lastMask, editedMask, rerenderStill); the output redraws as you paint.
(function () {
  'use strict';

  const MIN_R = 2, MAX_R = 80, UNDO_LIMIT = 40;
  const ADD_RGB = [20, 184, 166];   // teal outline of the person
  const BRUSH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L11 15.8 8.2 13z"/><path d="M7.1 14.2c-1.8 0-3.2 1.5-3.2 3.3 0 1.4-1.3 2.2-2 2.5 1 1.3 2.6 2 4.3 2 2.4 0 4.3-1.9 4.3-4.3 0-.3 0-.6-.1-.9z"/></svg>';

  let container, editBtn, canvas, cctx, cursor, toolbar, tip, sizeInput, addBtn, eraseBtn, undoBtn;
  let available = false, isOpen = false;
  let frame = null, mask = null, w = 0, h = 0, overlay = null;
  let mode = 'add', radius = 16, altHeld = false;
  let undo = [];
  let painting = false, last = null, hovering = false, hoverPt = null;
  let rafId = 0, overlayDirty = false, outputDirty = false;

  function build() {
    container = document.querySelector('.video-container');
    if (!container) return false;
    container.insertAdjacentHTML('beforeend', `
      <button type="button" class="mask-edit-btn" hidden title="Fix where the drawing thinks you are">${BRUSH_ICON}<span>Edit mask</span></button>
      <canvas class="mask-canvas" hidden></canvas>
      <div class="mask-cursor" hidden></div>
      <div class="mask-tip" hidden>Paint over the photo. Hold <kbd>Alt</kbd> to swap brushes · <kbd>[</kbd> <kbd>]</kbd> size</div>
      <div class="mask-toolbar" role="toolbar" aria-label="Mask brush" hidden>
        <div class="mask-seg">
          <button type="button" data-mode="add" title="Add to the person (A)"><b>+</b> Add</button>
          <button type="button" data-mode="erase" title="Erase from the person (E)"><b>−</b> Erase</button>
        </div>
        <label class="mask-size" title="Brush size ([ and ])">
          <span class="mask-dot mask-dot-sm"></span>
          <input type="range" min="${MIN_R}" max="${MAX_R}" step="1" aria-label="Brush size">
          <span class="mask-dot mask-dot-lg"></span>
        </label>
        <button type="button" data-act="undo" title="Undo (Ctrl/⌘ Z)">Undo</button>
        <button type="button" data-act="reset" title="Go back to the automatic mask">Reset</button>
        <button type="button" data-act="done" class="mask-done" title="Finish editing (Enter or Esc)">Done</button>
      </div>`);
    editBtn = container.querySelector('.mask-edit-btn');
    canvas = container.querySelector('.mask-canvas');
    cctx = canvas.getContext('2d');
    cursor = container.querySelector('.mask-cursor');
    tip = container.querySelector('.mask-tip');
    toolbar = container.querySelector('.mask-toolbar');
    sizeInput = toolbar.querySelector('input');
    addBtn = toolbar.querySelector('[data-mode="add"]');
    eraseBtn = toolbar.querySelector('[data-mode="erase"]');
    undoBtn = toolbar.querySelector('[data-act="undo"]');
    sizeInput.value = radius;

    editBtn.addEventListener('click', open);
    addBtn.addEventListener('click', () => setMode('add'));
    eraseBtn.addEventListener('click', () => setMode('erase'));
    undoBtn.addEventListener('click', undoStep);
    toolbar.querySelector('[data-act="reset"]').addEventListener('click', resetMask);
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
    window.addEventListener('blur', () => { altHeld = false; });
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
    frame = lastFrame; w = frame.width; h = frame.height;
    mask = Uint8Array.from(editedMask || lastMask);
    undo = [];
    canvas.width = w; canvas.height = h;
    overlay = cctx.createImageData(w, h);
    isOpen = true;
    container.classList.add('mask-editing');
    editBtn.hidden = true;
    canvas.hidden = toolbar.hidden = tip.hidden = false;
    tip.classList.remove('mask-tip-faded');
    setMode(mode);
    updateUndo();
    drawOverlay();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false; painting = false; last = null;
    container.classList.remove('mask-editing');
    canvas.hidden = toolbar.hidden = tip.hidden = cursor.hidden = true;
    editBtn.hidden = !available;
    editBtn.classList.toggle('mask-edited', !!editedMask);
  }

  // ---------- tools ----------
  function effectiveMode() { return altHeld ? (mode === 'add' ? 'erase' : 'add') : mode; }

  function setMode(m) {
    mode = m;
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
  function updateUndo() { undoBtn.disabled = undo.length === 0; }

  function undoStep() {
    if (!undo.length) return;
    mask.set(undo.pop());
    updateUndo();
    changed();
  }

  function resetMask() {
    if (!lastMask) return;
    pushUndo();
    mask.set(lastMask);
    changed();
  }

  function changed() {
    editedMask = mask;
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
    if (e.button !== 0) return;
    e.preventDefault();
    altHeld = e.altKey;
    canvas.setPointerCapture(e.pointerId);
    painting = true; last = null;
    pushUndo();
    const p = toImage(e);
    hoverPt = p;
    strokeTo(p);
    tip.classList.add('mask-tip-faded');
    changed();
    updateCursor();
  }

  function onMove(e) {
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

  function onUp(e) {
    if (!painting) return;
    painting = false; last = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
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
    if (!isOpen) return;
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
    if (overlayDirty) { overlayDirty = false; drawOverlay(); }
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
    window.MaskEditor = { setAvailable, open, close, get isOpen() { return isOpen; } };
    if (typeof updateMaskEditAvailability === 'function') updateMaskEditAvailability();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
