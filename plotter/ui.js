// plotter/ui.js — the optional Plotter panel.
//
// Reads the app's output from #preview (preview.dataset.svg) and never changes
// how the app itself works. While the panel is closed it does nothing at all.
// Add ?mockplotter=1 to the URL to use a simulated NextDraw instead of USB.
(function () {
  'use strict';
  const L = window.PlotterLib;
  const S = L;
  const LS_SETTINGS = 'penplot.plotter.settings.v1';
  const LS_LOG = 'penplot.plotter.log.v1';
  const params = new URLSearchParams(location.search);
  const MOCK = params.get('mockplotter') === '1';

  // ---------- state ----------
  let settings = loadSettings();
  let log = loadLog();
  let open = false;
  let lastSvg = '';
  let lastPrep = null;          // latest computed plan (optimized or not)
  let lastOptimizedPrep = null; // latest optimized plan for lastSvg
  let liveTimer = null, settleTimer = null, settingsTimer = null;
  let lastLiveAt = 0;
  let mgr = null, mockDev = null;
  let homeSet = false;
  let running = null;           // {kind, job, prep, meta}
  let mockViewTimer = null;
  let mockExpected = 0;          // strokes the current/last simulated job should draw

  function loadSettings() {
    try { return S.mergeSettings(S.DEFAULTS, JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null')); }
    catch (e) { return S.defaultSettings(); }
  }
  function saveSettings() { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) {} }
  function loadLog() { try { const v = JSON.parse(localStorage.getItem(LS_LOG) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function saveLog() { try { localStorage.setItem(LS_LOG, JSON.stringify(log)); } catch (e) {} }

  // app.js globals (classic scripts share one global scope)
  function appState() {
    const st = {};
    try { st.mode = currentMode; } catch (e) {}
    try { st.frozen = isFrozen; } catch (e) {}
    try { st.livePreview = !!livePreviewId; } catch (e) {}
    const sel = document.getElementById('style-select');
    const det = document.getElementById('detail');
    st.style = sel ? sel.value : '';
    st.styleLabel = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : st.style;
    st.detail = det ? parseFloat(det.value) : NaN;
    st.live = st.mode === 'camera' && !st.frozen && st.livePreview;
    return st;
  }

  // ---------- formatting ----------
  function fmtTime(ms) {
    if (!Number.isFinite(ms)) return '–';
    const t = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
    if (m) return `${m} min ${String(s).padStart(2, '0')} s`;
    return `${s} s`;
  }
  function fmtClock(ms) {
    if (!Number.isFinite(ms)) return '–';
    const t = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }
  const fmtM = (mm) => mm >= 1000 ? (mm / 1000).toFixed(2) + ' m' : Math.round(mm) + ' mm';
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  let panel;

  function buildPanel() {
    panel = document.createElement('aside');
    panel.id = 'plotter-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Plotter');
    panel.innerHTML = `
      <div class="pl-head">
        <h2>Plotter ${MOCK ? '<span class="pl-badge">simulated NextDraw</span>' : ''}</h2>
        <button class="pl-close" id="pl-close" title="Close the plotter panel" aria-label="Close">×</button>
      </div>
      <div class="pl-sub" id="pl-sub"></div>

      <div class="pl-est" id="pl-est">
        <div><span class="pl-est-total" id="pl-est-total">–</span><span class="pl-tag" id="pl-est-tag">no drawing yet</span></div>
        <table class="pl-table" id="pl-breakdown">
          <tr><th></th><th>time</th><th>amount</th></tr>
          <tr><td>Drawing</td><td id="pl-b-draw">–</td><td id="pl-b-drawmm">–</td></tr>
          <tr><td>Travel (pen up)</td><td id="pl-b-travel">–</td><td id="pl-b-travelmm">–</td></tr>
          <tr><td>Pen lifts</td><td id="pl-b-pen">–</td><td id="pl-b-lifts">–</td></tr>
          <tr><td>Command overhead</td><td id="pl-b-over">–</td><td id="pl-b-cmds">–</td></tr>
          <tr><td>Calibration</td><td id="pl-b-cal">–</td><td></td></tr>
        </table>
        <div class="pl-note" id="pl-opt-summary"></div>
        <label class="pl-note"><input type="checkbox" id="pl-show-travel"> Show travel moves on the preview</label>
        <label class="pl-note"><input type="checkbox" id="pl-show-paper"> Show paper border on the preview</label>
      </div>
      <div class="pl-info" id="pl-layout-info"></div>
      <div class="pl-warn" id="pl-warn"></div>
      <div class="pl-row">
        <button id="pl-dl-svg" title="Optimized SVG at real size in mm (also works in the NextDraw desktop app)">Download plot-ready SVG</button>
        <button id="pl-dl-gcode">Download G-code</button>
      </div>

      <details id="pl-machine" open>
        <summary>NextDraw</summary>
        <div class="pl-row">
          <button id="pl-connect" class="pl-primary">Connect</button>
          <span class="pl-status" id="pl-conn-status">Not connected</span>
        </div>
        <div class="pl-warn" id="pl-serial-warn"></div>
        <div class="pl-slider"><span>Pen up</span><input type="range" id="pl-pen-up" min="0" max="100" step="1"><span id="pl-pen-up-v"></span></div>
        <div class="pl-slider"><span>Pen down</span><input type="range" id="pl-pen-down" min="0" max="100" step="1"><span id="pl-pen-down-v"></span></div>
        <div class="pl-row">
          <button id="pl-test-up" data-needs="idle">Test Up</button>
          <button id="pl-test-down" data-needs="idle">Test Down</button>
        </div>
        <div class="pl-row">
          <button id="pl-start" class="pl-primary" data-needs="idle">Start plot</button>
          <button id="pl-dry" data-needs="idle" title="Trace the whole drawing with the pen up">Dry run (pen up)</button>
          <button id="pl-pause" data-needs="running">Pause</button>
          <button id="pl-cancel" class="pl-danger" data-needs="running" title="Stop now, lift the pen and go home">Cancel</button>
        </div>
        <div class="pl-progress"><div id="pl-progress-bar"></div></div>
        <div class="pl-progress-text" id="pl-progress-text">Idle</div>
        <div class="pl-row">
          <button id="pl-square" data-needs="idle" title="Draws a 50 × 50 mm square 20 mm from home. Measure it to check steps per mm.">Draw 50 mm test square</button>
          <button id="pl-home" data-needs="idle">Walk home</button>
          <button id="pl-motors-off" data-needs="idle" title="Lets you move the carriage by hand. Home must be set again before the next plot.">Motors off</button>
        </div>
        <div class="pl-note" id="pl-home-note"></div>
        ${MOCK ? `<div class="pl-row"><span class="pl-note">Simulation speed</span>
          <select id="pl-mock-speed"><option value="1">1× (real time)</option><option value="0.1">10×</option><option value="0.02" selected>50×</option><option value="0.005">200×</option></select>
          <label class="pl-note"><input type="checkbox" id="pl-mock-travel"> show travel</label></div>
          <div id="pl-mock-view"></div><div class="pl-note" id="pl-mock-stats"></div>` : ''}
      </details>

      <details id="pl-log-section">
        <summary>Plot log &amp; calibration</summary>
        <div class="pl-note">Every finished plot is logged with its estimate and the real time. Calibrating scales future estimates to match.</div>
        <div class="pl-log-wrap"><table class="pl-table" id="pl-log-table"></table></div>
        <div class="pl-row">
          <button id="pl-calibrate" title="Fit one correction factor so the last plot's estimate would have been exact">Calibrate from last plot</button>
          <button id="pl-fit" title="Fit separate factors for drawing, travel and pen lifts (needs 3+ different plots)">Fit each term</button>
        </div>
        <div class="pl-row">
          <button id="pl-csv">Export CSV</button>
          <button id="pl-clear-log" class="pl-danger">Clear log</button>
        </div>
        <div class="pl-row">
          <span class="pl-note">Plotted elsewhere? Actual time</span>
          <input type="number" id="pl-manual-min" min="0" step="0.1" style="width:80px" placeholder="min">
          <button id="pl-manual-add" title="Log the current drawing's estimate with a time you measured yourself">Add to log</button>
        </div>
        <div class="pl-note" id="pl-cal-result"></div>
      </details>

      <details id="pl-settings">
        <summary>Settings</summary>
        <div id="pl-settings-body"></div>
        <div class="pl-row">
          <button id="pl-export">Export settings</button>
          <button id="pl-import">Import settings</button>
          <input type="file" id="pl-import-file" accept="application/json,.json" hidden>
          <button id="pl-reset" class="pl-danger">Reset to defaults</button>
        </div>
      </details>`;
    document.body.appendChild(panel);
    buildSettingsForm();
  }

  // ---------- settings form ----------
  const MACHINE_OPTS = Object.keys(S.MACHINES).map(k => [k, S.MACHINES[k].label]);
  const PAPER_OPTS = Object.keys(S.PAPERS).map(k => [k, S.PAPERS[k].label]);
  const PENLIFT_OPTS = Object.keys(S.PENLIFTS).map(k => [k, S.PENLIFTS[k].label]);
  const FORM = [
    ['Machine', [
      ['machine', 'profile', 'Machine', 'select', { options: MACHINE_OPTS }],
      ['machine', 'travelX', 'Travel along long axis (X)', 'number', { unit: 'mm', step: 0.1, hint: ['How far the pen can reach from home', 'Filled in when you pick a machine'] }],
      ['machine', 'travelY', 'Travel along short axis (Y)', 'number', { unit: 'mm', step: 0.1, hint: ['How far the pen can reach from home', 'Filled in when you pick a machine'] }],
      ['machine', 'penlift', 'Pen-lift motor', 'select', { options: PENLIFT_OPTS }],
      ['machine', 'invertPen', 'Swap pen up/down (if Test Up lowers it)', 'check'],
      ['machine', 'penRateRaise', 'Pen raising speed', 'number', { unit: '%', min: 1, max: 100, hint: 'NextDraw default is 75%' }],
      ['machine', 'penRateLower', 'Pen lowering speed', 'number', { unit: '%', min: 1, max: 100 }],
      ['machine', 'stepsPerMm', 'Steps per mm', 'number', { step: 0.001, hint: ['Fix this if the 50 mm test square measures wrong', 'New value = old × 50 ÷ measured size'] }],
      ['machine', 'maxStepRate', 'Max motor step rate', 'number', { unit: 'steps/s', step: 100, hint: '25,000 is the controller board\'s hard limit' }],
      ['machine', 'window', 'Commands in flight', 'number', { min: 1, max: 32, hint: ['How many moves are queued on the plotter at once', 'Small = Pause and Cancel react faster'] }],
      ['machine', 'homeRate', 'Walk-home speed', 'number', { unit: 'steps/s', step: 100, min: 100, max: 25000 }],
      ['machine', 'usbFilter', 'Only list NextDraw (EiBotBoard) USB devices', 'check', { hint: 'Untick if the plotter does not appear in Chrome\'s port list' }],
    ]],
    ['Paper', [
      ['paper', 'size', 'Paper size', 'select', { options: PAPER_OPTS }],
      ['paper', 'orientation', 'Orientation (as you look at the picture)', 'select', { options: [['portrait', 'Portrait'], ['landscape', 'Landscape']] }],
      ['paper', 'customW', 'Custom width', 'number', { unit: 'mm', step: 0.1, show: () => settings.paper.size === 'custom' }],
      ['paper', 'customH', 'Custom height', 'number', { unit: 'mm', step: 0.1, show: () => settings.paper.size === 'custom' }],
      ['paper', 'margin', 'Margin', 'number', { unit: 'mm', step: 0.1, hint: ['Blank space kept around every edge of the sheet', 'The drawing is scaled to fit inside it'] }],
      ['paper', 'rotate', 'Sheet on the machine', 'select', { options: [['auto', 'Automatic (sideways if needed)'], ['none', 'Same way up as the picture'], ['rotate', 'Always sideways']], hint: ['Turns the sheet 90° on the machine when needed', 'Automatic only turns it if the picture won\'t fit the other way'] }],
      ['paper', 'offsetX', 'Paper corner offset from home, X', 'number', { unit: 'mm', step: 0.5, hint: 'Use if the sheet\'s corner isn\'t exactly at the home position' }],
      ['paper', 'offsetY', 'Paper corner offset from home, Y', 'number', { unit: 'mm', step: 0.5, hint: 'Use if the sheet\'s corner isn\'t exactly at the home position' }],
    ]],
    ['Timing (the estimate updates as you type)', [
      ['timing', 'drawSpeed', 'Drawing speed (pen down)', 'number', { unit: 'mm/s', step: 1, min: 1, hint: ['Starts on the cautious side', 'NextDraw\'s own default is about 55 mm/s'] }],
      ['timing', 'travelSpeed', 'Travel speed (pen up)', 'number', { unit: 'mm/s', step: 1, min: 1, hint: ['Starts on the cautious side', 'NextDraw\'s own default is about 165 mm/s'] }],
      ['timing', 'drawAccel', 'Acceleration, pen down', 'number', { unit: 'mm/s²', step: 50, min: 10 }],
      ['timing', 'travelAccel', 'Acceleration, pen up', 'number', { unit: 'mm/s²', step: 50, min: 10 }],
      ['timing', 'cornering', 'Cornering (junction deviation)', 'number', { unit: 'mm', step: 0.01, min: 0.001, hint: 'Bigger = corners taken faster' }],
      ['timing', 'penUpExtraMs', 'Extra pen-up delay', 'number', { unit: 'ms', step: 5, min: 0 }],
      ['timing', 'penDownExtraMs', 'Extra pen-down delay', 'number', { unit: 'ms', step: 5, min: 0 }],
      ['timing', 'cmdOverheadMs', 'Per-command overhead', 'number', { unit: 'ms', step: 0.1, min: 0, hint: 'Only affects the estimate' }],
      ['timing', 'maxSliceMs', 'Acceleration time slice', 'number', { unit: 'ms', step: 1, min: 3, max: 200, hint: 'Speed-ups and slow-downs are sent in steps this long' }],
      ['timing', 'kDraw', 'Drawing time × (calibration)', 'number', { step: 0.01, min: 0.01, hint: 'Set for you by “Fit each term” in the plot log' }],
      ['timing', 'kTravel', 'Travel time × (calibration)', 'number', { step: 0.01, min: 0.01, hint: 'Set for you by “Fit each term” in the plot log' }],
      ['timing', 'kPen', 'Pen-lift time × (calibration)', 'number', { step: 0.01, min: 0.01, hint: 'Set for you by “Fit each term” in the plot log' }],
      ['timing', 'correction', 'Overall correction ×', 'number', { step: 0.01, min: 0.01, hint: 'Set for you by “Calibrate from last plot”' }],
    ]],
    ['Path optimization', [
      ['optimize', 'enabled', 'Optimize paths', 'check', { hint: 'Fewer pen lifts and less pen-up travel, so plots finish sooner' }],
      ['optimize', 'merge', 'Join paths that touch', 'check'],
      ['optimize', 'mergeTol', 'Join if ends are closer than', 'number', { unit: 'mm', step: 0.1, min: 0 }],
      ['optimize', 'sort', 'Reorder paths (nearest first)', 'check'],
      ['optimize', 'reverse', 'Allow drawing paths backwards', 'check'],
      ['optimize', 'simplifyTol', 'Drop points closer to a straight line than', 'number', { unit: 'mm', step: 0.01, min: 0, hint: '0 = off' }],
      ['optimize', 'curveTol', 'Curve smoothness (max error)', 'number', { unit: 'mm', step: 0.01, min: 0.005, hint: 'Smaller = smoother curves, but more moves' }],
    ]],
    ['G-code (Grbl)', [
      ['gcode', 'penUpCmd', 'Pen up command', 'text'],
      ['gcode', 'penDownCmd', 'Pen down command', 'text'],
      ['gcode', 'penDwellMs', 'Pause after pen up/down', 'number', { unit: 'ms', step: 10, min: 0 }],
      ['gcode', 'originBottomLeft', 'Origin at bottom-left, Y up', 'check', { hint: 'The usual CNC convention' }],
      ['gcode', 'header', 'Extra lines at the start', 'textarea'],
      ['gcode', 'footer', 'Extra lines at the end', 'textarea'],
    ]],
  ];

  function buildSettingsForm() {
    const body = $('pl-settings-body');
    body.innerHTML = '';
    FORM.forEach(([title, fields], gi) => {
      const det = document.createElement('details');
      if (gi === 2) det.open = true; // Timing open by default — it's what gets tuned
      det.innerHTML = `<summary>${esc(title)}</summary>`;
      for (const [sec, key, label, type, o] of fields) {
        const opts = o || {};
        const row = document.createElement('label');
        row.className = 'pl-field' + (type === 'check' ? ' pl-check' : '');
        row.dataset.key = sec + '.' + key;
        const id = `pl-set-${sec}-${key}`;
        let input;
        if (type === 'select') {
          input = `<select id="${id}">${opts.options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select>`;
        } else if (type === 'check') {
          input = `<input type="checkbox" id="${id}">`;
        } else if (type === 'textarea') {
          input = `<textarea id="${id}" rows="2"></textarea>`;
        } else if (type === 'text') {
          input = `<input type="text" id="${id}">`;
        } else {
          input = `<span><input type="number" id="${id}" ${opts.step ? `step="${opts.step}"` : ''} ${opts.min !== undefined ? `min="${opts.min}"` : ''} ${opts.max !== undefined ? `max="${opts.max}"` : ''}></span>`;
        }
        const info = opts.hint ? ` <button type="button" class="pl-info-btn" aria-label="More about this setting" aria-expanded="false">i</button>` : '';
        row.innerHTML = `<span>${esc(label)}${opts.unit ? ` <span class="pl-unit">(${esc(opts.unit)})</span>` : ''}${info}</span>${input}`;
        det.appendChild(row);
        if (opts.hint) {
          // Tap/click the "i" to show the notes as bullet points right under the setting (no slow hover tooltip)
          const ul = document.createElement('ul');
          ul.className = 'pl-hint';
          ul.hidden = true;
          ul.innerHTML = [].concat(opts.hint).map(h => `<li>${esc(h)}</li>`).join('');
          det.appendChild(ul);
          const btn = row.querySelector('.pl-info-btn');
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            ul.hidden = !ul.hidden;
            btn.setAttribute('aria-expanded', String(!ul.hidden));
          });
        }
        const el = row.querySelector('#' + id);
        const handler = () => {
          let v;
          if (type === 'check') v = el.checked;
          else if (type === 'number') { v = parseFloat(el.value); if (!Number.isFinite(v)) return; if (opts.min !== undefined) v = Math.max(opts.min, v); if (opts.max !== undefined) v = Math.min(opts.max, v); }
          else v = el.value;
          settings[sec][key] = v;
          onSettingChanged(sec, key);
        };
        el.addEventListener(type === 'number' || type === 'text' || type === 'textarea' ? 'input' : 'change', handler);
      }
      body.appendChild(det);
    });
    refreshSettingsForm();
  }

  function refreshSettingsForm() {
    for (const [, fields] of FORM) {
      for (const [sec, key, , type, o] of fields) {
        const el = $(`pl-set-${sec}-${key}`);
        if (!el) continue;
        const v = settings[sec][key];
        if (type === 'check') el.checked = !!v;
        else if (document.activeElement !== el) el.value = type === 'number' ? +(+v).toFixed(4) : v;
        if (o && o.show) el.closest('.pl-field').style.display = o.show() ? '' : 'none';
      }
    }
    $('pl-pen-up').value = settings.machine.penUpPct;
    $('pl-pen-down').value = settings.machine.penDownPct;
    $('pl-pen-up-v').textContent = settings.machine.penUpPct + '%';
    $('pl-pen-down-v').textContent = settings.machine.penDownPct + '%';
    $('pl-show-travel').checked = !!settings.optimize.showTravel;
    $('pl-show-paper').checked = !!settings.optimize.showPaper;
  }

  function onSettingChanged(sec, key) {
    if (sec === 'machine' && key === 'profile') {
      const m = S.MACHINES[settings.machine.profile];
      if (m) { settings.machine.travelX = +m.travelX.toFixed(2); settings.machine.travelY = +m.travelY.toFixed(2); }
    }
    saveSettings();
    refreshSettingsForm();
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => recompute({ settle: true }), 120);
    updateHeader();
  }

  // ---------- estimate ----------
  function updateHeader() {
    const m = S.MACHINES[settings.machine.profile] || {};
    const p = S.PAPERS[settings.paper.size] || {};
    const size = S.paperSizeMm(settings.paper);
    $('pl-sub').textContent = `${m.label || settings.machine.profile} · ${settings.paper.size === 'custom' ? `${size.w.toFixed(0)} × ${size.h.toFixed(0)} mm` : (p.label || '')} ${settings.paper.orientation} · ${(settings.paper.margin / 25.4).toFixed(2)} in margin`;
  }

  function onSvgMaybeChanged() {
    if (!open) return;
    const svg = (document.getElementById('preview') || {}).dataset ? document.getElementById('preview').dataset.svg || '' : '';
    drawPaperBorder(); // the sheet doesn't depend on the drawing, so keep it steady between live frames
    if (svg === lastSvg) { drawTravelOverlay(); return; }
    lastSvg = svg;
    lastOptimizedPrep = null;
    const st = appState();
    clearTimeout(settleTimer);
    if (!svg) { lastPrep = null; renderEstimate(null, ''); return; }
    if (st.live) {
      // Live camera: quick unoptimized estimate at most ~3×/s; optimize once frames stop changing
      const t = performance.now();
      if (t - lastLiveAt > 300) { lastLiveAt = t; recompute({ settle: false }); }
      else { clearTimeout(liveTimer); liveTimer = setTimeout(() => { lastLiveAt = performance.now(); recompute({ settle: false }); }, 300); }
      settleTimer = setTimeout(() => recompute({ settle: true }), 900);
    } else {
      renderTag('computing…', '');
      settleTimer = setTimeout(() => recompute({ settle: true }), 250);
    }
  }

  function recompute(o) {
    if (!open || !lastSvg) return;
    const optimize = o.settle && settings.optimize.enabled;
    let prep;
    try {
      prep = L.preparePlot(lastSvg, settings, { optimize });
    } catch (e) {
      console.error(e);
      $('pl-warn').textContent = 'Could not read the drawing: ' + e.message;
      return;
    }
    lastPrep = prep;
    if (o.settle) lastOptimizedPrep = prep;
    renderEstimate(prep, o.settle ? (optimize ? 'optimized' : 'not optimized') : 'live · unoptimized');
    drawPaperBorder();
    drawTravelOverlay();
  }

  function renderTag(text, cls) {
    const tag = $('pl-est-tag');
    tag.textContent = text;
    tag.className = 'pl-tag ' + (cls || '');
  }

  function renderEstimate(prep, label) {
    const set = (id, v) => { $(id).textContent = v; };
    if (!prep) {
      set('pl-est-total', '–'); renderTag('no drawing yet');
      ['pl-b-draw', 'pl-b-drawmm', 'pl-b-travel', 'pl-b-travelmm', 'pl-b-pen', 'pl-b-lifts', 'pl-b-over', 'pl-b-cmds', 'pl-b-cal'].forEach(i => set(i, '–'));
      set('pl-opt-summary', ''); set('pl-warn', ''); set('pl-layout-info', '');
      updateButtons();
      return;
    }
    const e = prep.estimate, t = settings.timing;
    set('pl-est-total', fmtTime(prep.shownMs));
    renderTag(label, label === 'optimized' ? 'pl-opt' : (label.startsWith('live') ? 'pl-live' : ''));
    set('pl-b-draw', fmtClock(e.drawMs * t.kDraw * t.correction));
    set('pl-b-drawmm', fmtM(e.drawMm));
    set('pl-b-travel', fmtClock(e.travelMs * t.kTravel * t.correction));
    set('pl-b-travelmm', fmtM(e.travelMm));
    set('pl-b-pen', fmtClock(e.penMs * t.kPen * t.correction));
    set('pl-b-lifts', `${e.lifts} lifts`);
    set('pl-b-over', fmtClock(e.overheadMs * t.correction));
    set('pl-b-cmds', `${e.commands} cmds`);
    const kNote = (t.kDraw !== 1 || t.kTravel !== 1 || t.kPen !== 1) ? ` (draw ×${t.kDraw.toFixed(2)}, travel ×${t.kTravel.toFixed(2)}, pen ×${t.kPen.toFixed(2)})` : '';
    set('pl-b-cal', `×${t.correction.toFixed(2)}${kNote}`);
    if (prep.opt) {
      const b = prep.opt.before, a = prep.opt.after;
      set('pl-opt-summary', `Optimizing: pen lifts ${b.lifts} → ${a.lifts}, travel ${fmtM(b.travelMm)} → ${fmtM(a.travelMm)} (${prep.opt.ms.toFixed(0)} ms)`);
    } else set('pl-opt-summary', label.startsWith('live') ? 'Freeze the picture (or stop moving the slider) to optimize.' : '');
    const lay = prep.layout;
    const info = [];
    if (lay.rotated) info.push('Lay the paper sideways on the machine: its corner at home, the top of the picture toward the home (left) side.');
    else if (!lay.isGcode) info.push('Paper corner at the home position.');
    info.push(`Drawing size ${((lay.drawRect.u1 - lay.drawRect.u0)).toFixed(0)} × ${((lay.drawRect.v1 - lay.drawRect.v0)).toFixed(0)} mm.`);
    if (lay.isGcode) info.push('G-code profile: the estimate uses the same motion model, but Grbl plans moves its own way, so treat it as rough.');
    set('pl-layout-info', info.join(' '));
    const warns = lay.warnings.slice();
    if (!prep.bounds.ok) warns.push('This plot would be refused: ' + prep.bounds.problems.join('; '));
    if (prep.errors && prep.errors.length) warns.push('Some paths could not be read: ' + prep.errors.slice(0, 2).join('; '));
    set('pl-warn', warns.join(' '));
    updateButtons();
  }

  // ---------- travel overlay ----------
  function drawTravelOverlay() {
    const svgEl = document.querySelector('#preview svg');
    if (!svgEl) return;
    const old = svgEl.querySelector('g.pl-travel');
    const want = open && settings.optimize.showTravel && lastPrep && lastPrep.paperPaths;
    if (!want) { if (old) old.remove(); return; }
    if (old && old.dataset.for === String(lastPrep.ms) + lastPrep.paperPaths.length) return;
    if (old) old.remove();
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'pl-travel');
    g.dataset.for = String(lastPrep.ms) + lastPrep.paperPaths.length;
    const segs = L.travelSegmentsInSource(lastPrep.paperPaths, lastPrep.layout, settings);
    const frag = document.createDocumentFragment();
    for (const s of segs) {
      const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('x1', s[0].toFixed(1)); ln.setAttribute('y1', s[1].toFixed(1));
      ln.setAttribute('x2', s[2].toFixed(1)); ln.setAttribute('y2', s[3].toFixed(1));
      frag.appendChild(ln);
    }
    g.appendChild(frag);
    svgEl.appendChild(g);
  }

  // ---------- paper border overlay ----------
  // Outlines the sheet and its margin (from the machine/paper settings) around the drawing.
  // Widens the preview's viewBox to fit; the downloaded SVG is untouched (it comes from dataset.svg).
  function drawPaperBorder() {
    const svgEl = document.querySelector('#preview svg');
    if (!svgEl) return;
    const old = svgEl.querySelector('g.pl-paper');
    if (old) old.remove();
    if (svgEl.dataset.plViewBox) {
      svgEl.setAttribute('viewBox', svgEl.dataset.plViewBox);
      svgEl.setAttribute('width', svgEl.dataset.plWidth);
      svgEl.setAttribute('height', svgEl.dataset.plHeight);
      delete svgEl.dataset.plViewBox; delete svgEl.dataset.plWidth; delete svgEl.dataset.plHeight;
    }
    const lay = lastPrep && lastPrep.layout;
    if (!open || !settings.optimize.showPaper || !lay) return;
    const s = lay.scale, vb = lay.viewBox, du = lay.drawRect.u0, dv = lay.drawRect.v0;
    const toSrc = (u, v) => [vb[0] + (u - du) / s, vb[1] + (v - dv) / s];
    const [x0, y0] = toSrc(0, 0), [x1, y1] = toSrc(lay.paperW, lay.paperH);
    const [mx0, my0] = toSrc(lay.margin, lay.margin), [mx1, my1] = toSrc(lay.paperW - lay.margin, lay.paperH - lay.margin);
    const pad = Math.max(x1 - x0, y1 - y0) * 0.01;
    svgEl.dataset.plViewBox = svgEl.getAttribute('viewBox') || '';
    svgEl.dataset.plWidth = svgEl.getAttribute('width') || '';
    svgEl.dataset.plHeight = svgEl.getAttribute('height') || '';
    const w = x1 - x0 + 2 * pad, h = y1 - y0 + 2 * pad;
    svgEl.setAttribute('viewBox', `${(x0 - pad).toFixed(1)} ${(y0 - pad).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
    svgEl.setAttribute('width', w.toFixed(1));
    svgEl.setAttribute('height', h.toFixed(1));
    const NS = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'pl-paper');
    const rect = (cls, a, b, c, d) => {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('class', cls);
      r.setAttribute('x', a.toFixed(1)); r.setAttribute('y', b.toFixed(1));
      r.setAttribute('width', Math.max(0, c - a).toFixed(1)); r.setAttribute('height', Math.max(0, d - b).toFixed(1));
      g.appendChild(r);
    };
    rect('pl-paper-sheet', x0, y0, x1, y1);
    if (lay.margin > 0) rect('pl-paper-margin', mx0, my0, mx1, my1);
    svgEl.insertBefore(g, svgEl.firstChild);
  }

  // ---------- downloads ----------
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function currentOptimizedPrep() {
    if (!lastSvg) return null;
    if (lastOptimizedPrep && lastOptimizedPrep === lastPrep) return lastOptimizedPrep;
    lastOptimizedPrep = lastPrep = L.preparePlot(lastSvg, settings, { optimize: settings.optimize.enabled });
    renderEstimate(lastPrep, settings.optimize.enabled ? 'optimized' : 'not optimized');
    return lastOptimizedPrep;
  }

  function metaLine() {
    const st = appState();
    return `${st.styleLabel || st.style}, detail ${st.detail}, ${settings.paper.size} ${settings.paper.orientation}`;
  }

  // ---------- machine ----------
  function servo() { return S.penServo(settings.machine); }
  function penUpLine() { const s = servo(); return L.penCmd(false, s.raiseMs + settings.timing.penUpExtraMs, s, settings.machine); }
  function penDownLine() { const s = servo(); return L.penCmd(true, s.lowerMs + settings.timing.penDownExtraMs, s, settings.machine); }

  function ensureManager() {
    if (mgr) return mgr;
    if (MOCK) {
      mockDev = new L.FakeNextDraw({
        timeScale: parseFloat(($('pl-mock-speed') || {}).value || '0.02'),
        stepsPerMm: settings.machine.stepsPerMm, travelX: settings.machine.travelX, travelY: settings.machine.travelY,
      });
      mgr = new L.WebSerialManager({ serial: new L.FakeSerial(mockDev), clock: () => mockDev.clock() });
      window.__plotterMock = mockDev;
    } else {
      mgr = new L.WebSerialManager({ filters: L.USB_FILTERS });
      Object.defineProperty(mgr, 'filters', { get: () => (settings.machine.usbFilter ? L.USB_FILTERS : []) });
    }
    mgr.on('progress', onProgress);
    mgr.on('job', onJobEvent);
    mgr.on('disconnected', (e) => {
      homeSet = false;
      $('pl-conn-status').textContent = e && e.message ? e.message : 'Not connected';
      $('pl-connect').textContent = 'Connect';
      updateButtons();
    });
    mgr.on('error', (e) => { $('pl-serial-warn').textContent = e.message; });
    return mgr;
  }

  async function toggleConnect() {
    $('pl-serial-warn').textContent = '';
    if (!MOCK && !L.WebSerialManager.isSupported()) {
      $('pl-serial-warn').textContent = L.WebSerialManager.unsupportedMessage();
      return;
    }
    const m = ensureManager();
    if (m.connected) { await m.disconnect(); return; }
    $('pl-conn-status').textContent = 'Connecting…';
    try {
      await m.connect();
      $('pl-conn-status').innerHTML = `Connected · <b>${esc(m.version.replace(/^.*Firmware Version\s*/i, 'firmware '))}</b>${m.mode === 'legacy' ? ' (legacy replies)' : ''}`;
      $('pl-connect').textContent = 'Disconnect';
      const fw = /(\d+)\.(\d+)\.(\d+)/.exec(m.version);
      if (fw && (+fw[1] < 3)) $('pl-serial-warn').textContent = `Firmware ${fw[0]} is older than 3.0 — NextDraw software needs 3.0.2+. Plotting may still work but is untested.`;
      // configure the pen and lift it, so the first thing the machine does is safe
      await m.sendAll(L.servoSetupCommands(settings.machine));
      await m.command(penUpLine());
    } catch (e) {
      const msg = (e && e.name === 'NotFoundError') ? 'No plotter chosen.' : (e.message || String(e));
      $('pl-conn-status').textContent = 'Not connected';
      $('pl-serial-warn').textContent = msg;
    }
    updateHomeNote();
    updateButtons();
  }

  function updateHomeNote() {
    const n = $('pl-home-note');
    if (!mgr || !mgr.connected) { n.textContent = ''; return; }
    n.textContent = homeSet
      ? 'Home is set. The plot starts and ends at the home corner.'
      : 'Before the first plot, the app will ask you to push the carriage to the home corner (motors off lets you move it by hand).';
  }

  async function ensureHome() {
    if (homeSet) return true;
    const ok = window.confirm('Is the pen carriage at the home corner?\n\nIf not: press Cancel, then "Motors off", slide the carriage gently to the home corner by hand, and press Start again.\n\nPress OK if it is at home.');
    if (!ok) return false;
    await mgr.command('EM,1,1'); // 16× microstepping; also makes this spot step position 0,0
    await mgr.command('CS');
    homeSet = true;
    updateHomeNote();
    return true;
  }

  async function runJob(kind, paths, prep) {
    const m = ensureManager();
    if (!m.connected || m.busy) return;
    $('pl-serial-warn').textContent = '';
    try {
      if (!(await ensureHome())) return;
      await m.sendAll(L.servoSetupCommands(settings.machine));
      await m.command(penUpLine());
      const job = L.buildEbbJob(paths, settings, { dryRun: kind === 'dry' });
      job.penUpCmd = penUpLine();
      job.penDownCmd = penDownLine();
      job.homeCmd = `HM,${Math.round(settings.machine.homeRate)}`;
      const st = appState();
      running = {
        kind, job, prep,
        factor: job.estimate.totalMs > 0 ? S.correctedEstimate(job.estimate, settings.timing) / job.estimate.totalMs : 1,
        meta: { style: st.style, detail: st.detail },
      };
      if (MOCK && mockDev) { mockDev.trace = []; mockDev.travel = []; mockExpected = job.estimate.lifts; startMockView(); }
      updateButtons();
      const res = await m.writeStream(job, { window: settings.machine.window });
      if (res.result === 'done' && (kind === 'plot' || kind === 'dry') && prep) {
        addLogEntry({ kind, actualMs: res.elapsedMs, estimate: job.estimate, prep, meta: running.meta });
      }
    } catch (e) {
      $('pl-serial-warn').textContent = 'Plot stopped: ' + (e.message || e);
    } finally {
      running = null;
      updateButtons();
      if (MOCK) { renderMockView(); stopMockView(); }
    }
  }

  async function startPlot(kind) {
    const st = appState();
    if (st.live) { $('pl-serial-warn').textContent = 'Press Freeze first, so the drawing stops changing.'; return; }
    const prep = currentOptimizedPrep();
    if (!prep || !prep.machinePaths.length) { $('pl-serial-warn').textContent = 'There is no drawing to plot yet.'; return; }
    if (prep.layout.isGcode) { $('pl-serial-warn').textContent = 'The Grbl profile is G-code only — use Download G-code.'; return; }
    if (!prep.bounds.ok) { $('pl-serial-warn').textContent = 'Refused — part of the drawing is outside the paper or the machine: ' + prep.bounds.problems.join('; '); return; }
    await runJob(kind, prep.machinePaths, prep);
  }

  async function testSquare() {
    const paths = L.testSquarePaths(50, 20);
    const lay = S.computeLayout(settings, [0, 0, 640, 480]);
    const b = L.checkBounds(paths, Object.assign({}, lay, { paperRectMachine: { x0: 0, y0: 0, x1: lay.travelX, y1: lay.travelY } }));
    if (!b.ok) { $('pl-serial-warn').textContent = 'The test square does not fit the machine travel.'; return; }
    await runJob('square', paths, null);
  }

  async function penTest(down) {
    const m = ensureManager();
    if (!m.connected || m.busy) return;
    try {
      await m.sendAll(L.servoSetupCommands(settings.machine));
      await m.command(down ? penDownLine() : penUpLine());
    } catch (e) { $('pl-serial-warn').textContent = e.message; }
  }

  async function walkHome() {
    const m = ensureManager();
    if (!m.connected || m.busy) return;
    if (!homeSet) { $('pl-serial-warn').textContent = 'Home is not set yet (it is set when a plot starts).'; return; }
    try {
      await m.command(penUpLine());
      await m.command(`HM,${Math.round(settings.machine.homeRate)}`);
      await m.waitIdle(50, 120000);
    } catch (e) { $('pl-serial-warn').textContent = e.message; }
  }

  async function motorsOff() {
    const m = ensureManager();
    if (!m.connected || m.busy) return;
    try { await m.command('EM,0,0'); homeSet = false; updateHomeNote(); }
    catch (e) { $('pl-serial-warn').textContent = e.message; }
  }

  function onProgress(p) {
    if (!running) return;
    const pct = Math.round(p.fraction * 1000) / 10;
    $('pl-progress-bar').style.width = pct + '%';
    const remaining = (p.totalMs - p.doneMs) * running.factor;
    const label = { plot: 'Plotting', dry: 'Dry run', square: 'Test square' }[running.kind] || 'Running';
    const state = p.state === 'paused' ? 'Paused' : label;
    $('pl-progress-text').textContent = `${state} · ${pct.toFixed(1)}% · elapsed ${fmtClock(p.elapsedMs)} · remaining ~${fmtClock(remaining)}`;
  }

  function onJobEvent(e) {
    const pause = $('pl-pause');
    if (e.state === 'paused') pause.textContent = 'Resume';
    else if (e.state === 'running' || e.state === 'pausing') pause.textContent = e.state === 'pausing' ? 'Pausing…' : 'Pause';
    if (e.state === 'cancelling') $('pl-progress-text').textContent = 'Cancelling — stopping, lifting the pen, going home…';
    if (['done', 'aborted', 'error'].includes(e.state)) {
      pause.textContent = 'Pause';
      const msg = { done: 'Finished', aborted: 'Cancelled — pen up, back home', error: 'Stopped with an error' }[e.state];
      $('pl-progress-text').textContent = `${msg} · ${fmtClock(e.elapsedMs)}`;
      if (e.state === 'done') $('pl-progress-bar').style.width = '100%';
    }
    updateButtons();
  }

  function updateButtons() {
    const connected = !!(mgr && mgr.connected);
    const busy = !!(mgr && mgr.busy) || !!running;
    panel.querySelectorAll('[data-needs="idle"]').forEach(b => { b.disabled = !connected || busy; });
    panel.querySelectorAll('[data-needs="running"]').forEach(b => { b.disabled = !connected || !busy || (mgr && !mgr.busy); });
    $('pl-connect').disabled = busy;
    const hasDrawing = !!lastSvg;
    $('pl-dl-svg').disabled = !hasDrawing;
    $('pl-dl-gcode').disabled = !hasDrawing;
    if (connected && !hasDrawing) { $('pl-start').disabled = true; $('pl-dry').disabled = true; }
  }

  // ---------- mock view ----------
  function renderMockView() {
    if (!MOCK || !mockDev) return;
    const v = $('pl-mock-view');
    if (!v) return;
    v.innerHTML = mockDev.traceSvg(settings.machine.travelX, settings.machine.travelY, {
      showTravel: $('pl-mock-travel') && $('pl-mock-travel').checked,
      paperRect: lastPrep && !lastPrep.layout.isGcode ? lastPrep.layout.paperRectMachine : null,
    });
    const strokes = mockDev.trace.length;
    const expected = mockExpected;
    $('pl-mock-stats').textContent = `Simulated pen: ${strokes} strokes drawn${expected ? ` of ${expected}` : ''} · position ${mockDev.posX.toFixed(2)}, ${mockDev.posY.toFixed(2)} mm · pen ${mockDev.penUp ? 'up' : 'down'}${mockDev.errors.length ? ' · errors: ' + mockDev.errors.slice(-2).join('; ') : ''}`;
  }
  function startMockView() { stopMockView(); mockViewTimer = setInterval(renderMockView, 300); }
  function stopMockView() { clearInterval(mockViewTimer); mockViewTimer = null; }

  // ---------- log & calibration ----------
  function addLogEntry(o) {
    const t = settings.timing;
    const e = o.estimate;
    const entry = {
      when: new Date().toISOString().replace('T', ' ').slice(0, 19),
      kind: o.kind,
      style: o.meta.style, detail: o.meta.detail,
      machine: settings.machine.profile, paper: `${settings.paper.size} ${settings.paper.orientation}`,
      lifts: e.lifts, drawMm: e.drawMm, travelMm: e.travelMm,
      estimate: { drawMs: e.drawMs, travelMs: e.travelMs, penMs: e.penMs, overheadMs: e.overheadMs, totalMs: e.totalMs },
      shownMs: S.correctedEstimate(e, t),
      actualMs: o.actualMs,
      settings: Object.assign({}, t),
      optimized: !!(o.prep && o.prep.optimized),
      notes: MOCK ? 'simulated' : (o.notes || ''),
    };
    log.push(entry);
    saveLog();
    renderLog();
  }

  function renderLog() {
    const tbl = $('pl-log-table');
    if (!log.length) { tbl.innerHTML = '<tr><td class="pl-note">No plots logged yet.</td></tr>'; return; }
    const rows = log.slice(-30).reverse().map(e => {
      const err = e.actualMs > 0 && e.shownMs > 0 ? (100 * (e.shownMs - e.actualMs) / e.actualMs) : NaN;
      return `<tr><td title="${esc(e.when)}">${esc(e.when.slice(5, 16))}${e.kind === 'dry' ? ' (dry)' : ''}${e.notes === 'simulated' ? ' (sim)' : ''}</td><td>${esc(e.style || '')} ${e.detail != null ? (+e.detail).toFixed(2) : ''}</td><td>${fmtClock(e.shownMs)}</td><td>${fmtClock(e.actualMs)}</td><td>${Number.isFinite(err) ? (err > 0 ? '+' : '') + err.toFixed(0) + '%' : ''}</td></tr>`;
    }).join('');
    tbl.innerHTML = `<tr><th>when</th><th>style</th><th>est.</th><th>actual</th><th>error</th></tr>${rows}`;
  }

  function calibrate() {
    const last = log[log.length - 1];
    if (!last) { $('pl-cal-result').textContent = 'Plot something first.'; return; }
    const before = settings.timing.correction;
    const c = S.calibrateFromEntry(last, settings.timing);
    if (!c) { $('pl-cal-result').textContent = 'The last entry has no usable time.'; return; }
    settings.timing.correction = Math.round(c * 1000) / 1000;
    saveSettings(); refreshSettingsForm();
    $('pl-cal-result').textContent = `Correction ×${before.toFixed(3)} → ×${settings.timing.correction.toFixed(3)} (last plot took ${fmtClock(last.actualMs)}).`;
    recompute({ settle: !appState().live });
  }

  function fitTerms() {
    const fit = S.fitTerms(log);
    if (!fit) { $('pl-cal-result').textContent = 'Need at least 3 logged plots that differ (e.g. different styles) to fit each term.'; return; }
    if (!window.confirm(`Fit from ${fit.n} plots:\n drawing ×${fit.kDraw.toFixed(3)}\n travel ×${fit.kTravel.toFixed(3)}\n pen lifts ×${fit.kPen.toFixed(3)}\nRemaining error ≈ ${fit.rmsPctError.toFixed(1)}%.\n\nApply these (and reset the overall correction to 1)?`)) return;
    Object.assign(settings.timing, { kDraw: +fit.kDraw.toFixed(3), kTravel: +fit.kTravel.toFixed(3), kPen: +fit.kPen.toFixed(3), correction: 1 });
    saveSettings(); refreshSettingsForm();
    $('pl-cal-result').textContent = `Applied per-term factors (rms error ${fit.rmsPctError.toFixed(1)}%).`;
    recompute({ settle: !appState().live });
  }

  function manualAdd() {
    const min = parseFloat($('pl-manual-min').value);
    if (!(min > 0)) { $('pl-cal-result').textContent = 'Type the real plot time in minutes first.'; return; }
    const prep = currentOptimizedPrep();
    if (!prep) { $('pl-cal-result').textContent = 'There is no drawing to compare with.'; return; }
    const st = appState();
    addLogEntry({ kind: 'plot', actualMs: min * 60000, estimate: prep.estimate, prep, meta: { style: st.style, detail: st.detail }, notes: 'entered by hand' });
    $('pl-manual-min').value = '';
    $('pl-cal-result').textContent = 'Added. Use “Calibrate from last plot” to apply it.';
  }

  // ---------- wiring ----------
  function setOpen(v) {
    open = v;
    panel.hidden = !v;
    document.body.classList.toggle('plotter-open', v);
    $('plotter-toggle').setAttribute('aria-expanded', String(v));
    if (v) { lastSvg = null; onSvgMaybeChanged(); updateButtons(); }
    else {
      clearTimeout(liveTimer); clearTimeout(settleTimer);
      const g = document.querySelector('#preview svg g.pl-travel');
      if (g) g.remove();
      drawPaperBorder();
    }
  }

  function init() {
    const toggle = document.getElementById('plotter-toggle');
    if (!toggle || !L) return;
    buildPanel();
    updateHeader();
    renderLog();
    if (!MOCK && !L.WebSerialManager.isSupported()) {
      $('pl-serial-warn').textContent = L.WebSerialManager.unsupportedMessage() + ' Estimates and downloads still work here.';
    }
    toggle.addEventListener('click', () => setOpen(!open));
    $('pl-close').addEventListener('click', () => setOpen(false));
    $('pl-show-travel').addEventListener('change', (e) => { settings.optimize.showTravel = e.target.checked; saveSettings(); drawTravelOverlay(); });
    $('pl-show-paper').addEventListener('change', (e) => { settings.optimize.showPaper = e.target.checked; saveSettings(); drawPaperBorder(); });
    $('pl-dl-svg').addEventListener('click', () => {
      const prep = currentOptimizedPrep(); if (!prep) return;
      download('penplot-plot-ready.svg', L.plotReadySvg(prep.paperPaths, prep.layout, metaLine()), 'image/svg+xml');
    });
    $('pl-dl-gcode').addEventListener('click', () => {
      const prep = currentOptimizedPrep(); if (!prep) return;
      download('penplot.gcode', L.buildGcodeFor(prep, settings, { drawing: metaLine(), estimate: fmtTime(prep.shownMs) }), 'text/plain');
    });
    $('pl-connect').addEventListener('click', toggleConnect);
    const slider = (id, key) => $(id).addEventListener('input', (e) => { settings.machine[key] = parseInt(e.target.value, 10); saveSettings(); refreshSettingsForm(); clearTimeout(settingsTimer); settingsTimer = setTimeout(() => recompute({ settle: !appState().live }), 150); });
    slider('pl-pen-up', 'penUpPct');
    slider('pl-pen-down', 'penDownPct');
    $('pl-test-up').addEventListener('click', () => penTest(false));
    $('pl-test-down').addEventListener('click', () => penTest(true));
    $('pl-start').addEventListener('click', () => startPlot('plot'));
    $('pl-dry').addEventListener('click', () => startPlot('dry'));
    $('pl-pause').addEventListener('click', () => { if (!mgr || !mgr.job) return; if (mgr.job.pauseReq) mgr.resume(); else mgr.pause(); });
    $('pl-cancel').addEventListener('click', () => { if (mgr) mgr.abort(); });
    $('pl-square').addEventListener('click', testSquare);
    $('pl-home').addEventListener('click', walkHome);
    $('pl-motors-off').addEventListener('click', motorsOff);
    $('pl-calibrate').addEventListener('click', calibrate);
    $('pl-fit').addEventListener('click', fitTerms);
    $('pl-csv').addEventListener('click', () => download('plot-log.csv', S.logToCsv(log), 'text/csv'));
    $('pl-clear-log').addEventListener('click', () => { if (log.length && window.confirm('Delete all logged plots?')) { log = []; saveLog(); renderLog(); } });
    $('pl-manual-add').addEventListener('click', manualAdd);
    $('pl-export').addEventListener('click', () => download('plotter-settings.json', JSON.stringify(settings, null, 2), 'application/json'));
    $('pl-import').addEventListener('click', () => $('pl-import-file').click());
    $('pl-import-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { settings = S.mergeSettings(S.DEFAULTS, JSON.parse(await f.text())); saveSettings(); refreshSettingsForm(); updateHeader(); recompute({ settle: !appState().live }); }
      catch (err) { $('pl-warn').textContent = 'Could not read that settings file: ' + err.message; }
      e.target.value = '';
    });
    $('pl-reset').addEventListener('click', () => { if (window.confirm('Reset all plotter settings to the defaults? (The plot log is kept.)')) { settings = S.defaultSettings(); saveSettings(); refreshSettingsForm(); updateHeader(); recompute({ settle: !appState().live }); } });
    if (MOCK) {
      $('pl-mock-speed').addEventListener('change', (e) => {
        if (!mockDev) return;
        mockDev.timeScale = parseFloat(e.target.value);
      });
      $('pl-mock-travel').addEventListener('change', renderMockView);
    }
    // Watch the app's output. The observer callback is a no-op while the panel is closed.
    const preview = document.getElementById('preview');
    if (preview) new MutationObserver(() => { if (open) onSvgMaybeChanged(); }).observe(preview, { childList: true });
    updateButtons();
    // Always start closed; ?plotter=1 (or the mock) opens it for testing.
    if (params.get('plotter') === '1' || MOCK) setOpen(true);
    window.PlotterUI = { get settings() { return settings; }, get log() { return log; }, get lastPrep() { return lastPrep; }, get manager() { return mgr; }, get mock() { return mockDev; }, setOpen, recompute };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
