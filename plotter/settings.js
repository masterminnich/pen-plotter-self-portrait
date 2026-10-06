// plotter/settings.js — machine profiles, paper sizes, defaults, persistence,
// page layout (fit SVG to paper) and the plot log / calibration maths.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { const ns = root.PlotterLib = root.PlotterLib || {}; Object.assign(ns, factory()); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const IN = 25.4;

  // Travel figures from Bantam's nextdraw_conf / models.py (see docs/nextdraw-protocol.md)
  const MACHINES = {
    'nextdraw-8511': { label: 'NextDraw 8511', protocol: 'ebb', travelX: 11.81 * IN, travelY: 8.58 * IN },
    'nextdraw-1117': { label: 'NextDraw 1117', protocol: 'ebb', travelX: 16.93 * IN, travelY: 11.69 * IN },
    'nextdraw-2234': { label: 'NextDraw 2234', protocol: 'ebb', travelX: 34.02 * IN, travelY: 23.39 * IN },
    'custom-ebb': { label: 'Other EBB machine (custom travel)', protocol: 'ebb', travelX: 300, travelY: 218 },
    'grbl': { label: 'Generic Grbl (G-code file)', protocol: 'gcode', travelX: 300, travelY: 300 },
  };

  // Portrait dimensions (w < h), mm
  const PAPERS = {
    letter: { label: 'US Letter (8.5 × 11 in)', w: 8.5 * IN, h: 11 * IN },
    legal: { label: 'US Legal (8.5 × 14 in)', w: 8.5 * IN, h: 14 * IN },
    tabloid: { label: 'Tabloid (11 × 17 in)', w: 11 * IN, h: 17 * IN },
    a4: { label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
    a3: { label: 'A3 (297 × 420 mm)', w: 297, h: 420 },
    '9x12': { label: '9 × 12 in', w: 9 * IN, h: 12 * IN },
    custom: { label: 'Custom', w: null, h: null },
  };

  // Pen-lift motor table from nextdrawcore models.py (pulse units are 1/12 MHz)
  const PENLIFTS = {
    brushless: { label: 'Brushless (NextDraw default)', pin: 2, min: 5400, max: 12600, sweepMs: 70, moveMinMs: 20, moveSlope: 1.28, pwmPeriod: 0.03, channels: 1 },
    standard: { label: 'Standard hobby servo', pin: 1, min: 9855, max: 27831, sweepMs: 200, moveMinMs: 45, moveSlope: 2.69, pwmPeriod: 0.24, channels: 8 },
  };

  const DEFAULTS = {
    version: 1,
    machine: {
      profile: 'nextdraw-8511',
      travelX: MACHINES['nextdraw-8511'].travelX,
      travelY: MACHINES['nextdraw-8511'].travelY,
      penlift: 'brushless',
      penUpPct: 60,          // NextDraw default pen_pos_up
      penDownPct: 40,        // NextDraw default pen_pos_down
      penRateRaise: 75,      // % (NextDraw default)
      penRateLower: 50,      // %
      invertPen: false,      // swap SP,0 / SP,1 if Test Up lowers the pen
      stepsPerMm: 80,        // 2032 steps/inch at 16x (EM,1,1)
      maxStepRate: 25000,    // steps/s per motor, EBB hard limit
      fifoDepth: 16,         // CU,4,<n>
      window: 4,             // commands in flight (keeps Pause/Cancel quick)
      homeRate: 4000,        // HM step frequency for Walk home / Cancel
      usbFilter: true,       // only list EiBotBoard USB devices (VID 04D8 / PID FD92) in the port chooser
    },
    paper: {
      size: 'letter',
      orientation: 'portrait',
      customW: 8.5 * IN,
      customH: 11 * IN,
      margin: 0.5 * IN,
      rotate: 'auto',        // 'auto' | 'none' | 'rotate' — turn the sheet 90° on the machine
      offsetX: 0,            // paper corner offset from home, mm (machine axes)
      offsetY: 0,
    },
    timing: {
      // Conservative first-plot speeds (NextDraw defaults are ~55 mm/s down, ~165 mm/s up)
      drawSpeed: 35,         // mm/s pen down
      travelSpeed: 100,      // mm/s pen up
      drawAccel: 800,        // mm/s² pen down
      travelAccel: 1200,     // mm/s² pen up
      cornering: 0.05,       // junction deviation, mm (bigger = faster corners)
      penUpExtraMs: 0,       // added to the computed servo raise time
      penDownExtraMs: 0,     // added to the computed servo lower time
      cmdOverheadMs: 0,      // per motion command (USB / parser cost), for the estimate
      maxSliceMs: 20,        // accel/decel time slice for SM commands
      minSliceMs: 2,         // EBB practical minimum SM duration
      kDraw: 1, kTravel: 1, kPen: 1, // per-term calibration multipliers
      correction: 1,         // overall calibration factor
    },
    optimize: {
      enabled: true,
      merge: true,
      mergeTol: 0.5,         // mm
      sort: true,
      reverse: true,
      simplifyTol: 0.02,     // mm, 0 = off
      curveTol: 0.05,        // mm, curve/arc flattening tolerance
      showTravel: false,
    },
    gcode: {
      penUpCmd: 'G0 Z5',
      penDownCmd: 'G1 Z0 F1000',
      penDwellMs: 0,
      originBottomLeft: true, // Y up from the bottom-left corner of the paper (CNC convention)
      header: '',
      footer: '',
    },
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Deep-merge user values over defaults, keeping only known keys with the right type.
  function mergeSettings(base, over) {
    const out = clone(base);
    if (!over || typeof over !== 'object') return out;
    for (const sec of Object.keys(out)) {
      if (typeof out[sec] !== 'object' || out[sec] === null) continue;
      const src = over[sec];
      if (!src || typeof src !== 'object') continue;
      for (const k of Object.keys(out[sec])) {
        if (!(k in src)) continue;
        const want = typeof out[sec][k], got = typeof src[k];
        if (want === got && (want !== 'number' || Number.isFinite(src[k]))) out[sec][k] = src[k];
      }
    }
    return out;
  }

  function defaultSettings() { return clone(DEFAULTS); }

  function paperSizeMm(paper) {
    let w, h;
    if (paper.size === 'custom' || !PAPERS[paper.size]) { w = paper.customW; h = paper.customH; }
    else { w = PAPERS[paper.size].w; h = PAPERS[paper.size].h; }
    const lo = Math.min(w, h), hi = Math.max(w, h);
    return paper.orientation === 'landscape' ? { w: hi, h: lo } : { w: lo, h: hi };
  }

  // Page layout: where the drawing goes on the paper and the paper on the machine.
  // Paper coords (u,v): mm from the paper's top-left, as you look at the picture.
  // Machine coords (x,y): mm from home; x along the long axis.
  function computeLayout(settings, viewBox) {
    const { w: W, h: H } = paperSizeMm(settings.paper);
    const m = Math.max(0, settings.paper.margin);
    const vb = viewBox && viewBox[2] > 0 && viewBox[3] > 0 ? viewBox : [0, 0, 640, 480];
    const availW = W - 2 * m, availH = H - 2 * m;
    const warnings = [];
    if (availW <= 0 || availH <= 0) warnings.push('Margins are larger than the paper.');
    const scale = Math.max(1e-9, Math.min(availW / vb[2], availH / vb[3]));
    const drawW = vb[2] * scale, drawH = vb[3] * scale;
    const offU = m + (availW - drawW) / 2, offV = m + (availH - drawH) / 2;

    const isGcode = (MACHINES[settings.machine.profile] || {}).protocol === 'gcode';
    const TX = settings.machine.travelX, TY = settings.machine.travelY;
    const ox = settings.paper.offsetX || 0, oy = settings.paper.offsetY || 0;
    // does the printable area fit the travel unrotated / rotated?
    const fitsNone = ox + m + availW <= TX + 1e-6 && oy + m + availH <= TY + 1e-6;
    const fitsRot = ox + m + availH <= TX + 1e-6 && oy + m + availW <= TY + 1e-6;
    let rotated = false;
    const mode = settings.paper.rotate;
    if (!isGcode) {
      if (mode === 'rotate') rotated = true;
      else if (mode === 'auto') rotated = !fitsNone && fitsRot;
      if (rotated ? !fitsRot : !fitsNone) warnings.push('The printable area is bigger than the machine can reach; the plot will be refused.');
    }

    const toPaper = (x, y) => [offU + (x - vb[0]) * scale, offV + (y - vb[1]) * scale];
    // Rotation used when the sheet lies sideways: the top of the picture faces home (x = 0).
    const paperToMachine = rotated
      ? (u, v) => [ox + v, oy + (W - u)]
      : (u, v) => [ox + u, oy + v];
    const machineToPaper = rotated
      ? (x, y) => [W - (y - oy), x - ox]
      : (x, y) => [x - ox, y - oy];
    // paper rectangle in machine coords
    const paperRectMachine = rotated
      ? { x0: ox, y0: oy, x1: ox + H, y1: oy + W }
      : { x0: ox, y0: oy, x1: ox + W, y1: oy + H };
    return {
      paperW: W, paperH: H, margin: m, scale, viewBox: vb,
      drawRect: { u0: offU, v0: offV, u1: offU + drawW, v1: offV + drawH },
      rotated, isGcode, warnings, toPaper, paperToMachine, machineToPaper, paperRectMachine,
      travelX: TX, travelY: TY,
    };
  }

  // ---- pen-lift maths (nextdrawcore pen_handling.py) ----
  function penServo(machine) {
    const pl = PENLIFTS[machine.penlift] || PENLIFTS.brushless;
    const range = pl.max - pl.min;
    const up = Math.round(pl.min + range / 100 * machine.penUpPct);
    const down = Math.round(pl.min + range / 100 * machine.penDownPct);
    const scale = range * pl.pwmPeriod / pl.sweepMs;
    const rateRaise = Math.max(1, Math.round(scale * machine.penRateRaise));
    const rateLower = Math.max(1, Math.round(scale * machine.penRateLower));
    const d = Math.abs(machine.penUpPct - machine.penDownPct);
    const transit = (rate) => d < 0.9 ? 0 : Math.floor(Math.pow(Math.pow(pl.moveSlope * d + pl.moveMinMs, 4) + Math.pow(pl.sweepMs * d / Math.max(1, rate), 4), 0.25));
    return { pin: pl.pin, channels: pl.channels, up, down, rateRaise, rateLower, raiseMs: transit(machine.penRateRaise), lowerMs: transit(machine.penRateLower), penlift: machine.penlift };
  }

  // ---- plot log + calibration ----
  // Entry: { when, style, detail, machine, estimate: {drawMs, travelMs, penMs, overheadMs, totalMs (raw, uncorrected)},
  //          shownMs (what the panel said), actualMs, kind: 'plot'|'dry' , settings: {...timing snapshot} }
  function weightedRaw(est, t) {
    return t.kDraw * est.drawMs + t.kTravel * est.travelMs + t.kPen * est.penMs + (est.overheadMs || 0);
  }
  function correctedEstimate(est, t) { return weightedRaw(est, t) * t.correction; }

  // One-click: correction factor so the last plot's estimate would have matched.
  function calibrateFromEntry(entry, timing) {
    const raw = weightedRaw(entry.estimate, timing);
    if (!(raw > 0) || !(entry.actualMs > 0)) return null;
    return entry.actualMs / raw;
  }

  // Least squares for per-term multipliers (needs >= 3 varied plots).
  // actual ≈ kD·draw + kT·travel + kP·pen + overhead
  function fitTerms(entries) {
    const rows = entries.filter(e => e.actualMs > 0 && e.estimate);
    if (rows.length < 3) return null;
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    for (const e of rows) {
      const x = [e.estimate.drawMs, e.estimate.travelMs, e.estimate.penMs];
      const y = e.actualMs - (e.estimate.overheadMs || 0);
      for (let i = 0; i < 3; i++) { b[i] += x[i] * y; for (let j = 0; j < 3; j++) A[i][j] += x[i] * x[j]; }
    }
    // small ridge toward 1.0 keeps it stable when terms are collinear
    const lam = 1e-6 * (A[0][0] + A[1][1] + A[2][2]) / 3;
    for (let i = 0; i < 3; i++) { A[i][i] += lam; b[i] += lam; }
    const k = solve3(A, b);
    if (!k || k.some(v => !Number.isFinite(v) || v <= 0)) return null;
    let sse = 0;
    for (const e of rows) {
      const p = k[0] * e.estimate.drawMs + k[1] * e.estimate.travelMs + k[2] * e.estimate.penMs + (e.estimate.overheadMs || 0);
      sse += Math.pow((p - e.actualMs) / e.actualMs, 2);
    }
    return { kDraw: k[0], kTravel: k[1], kPen: k[2], rmsPctError: 100 * Math.sqrt(sse / rows.length), n: rows.length };
  }

  function solve3(A, b) {
    const M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
      }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  }

  const CSV_COLUMNS = ['when', 'kind', 'style', 'detail', 'machine', 'paper', 'lifts', 'drawMm', 'travelMm',
    'est_draw_s', 'est_travel_s', 'est_pen_s', 'est_overhead_s', 'est_raw_s', 'est_shown_s', 'actual_s', 'error_pct',
    'drawSpeed', 'travelSpeed', 'drawAccel', 'travelAccel', 'cornering', 'penUpExtraMs', 'penDownExtraMs',
    'cmdOverheadMs', 'kDraw', 'kTravel', 'kPen', 'correction', 'optimized', 'notes'];

  function logToCsv(entries) {
    const esc = (v) => {
      if (v === undefined || v === null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [CSV_COLUMNS.join(',')];
    for (const e of entries) {
      const t = e.settings || {};
      const est = e.estimate || {};
      const s = (ms) => ms == null ? '' : (ms / 1000).toFixed(2);
      const row = {
        when: e.when, kind: e.kind, style: e.style, detail: e.detail, machine: e.machine, paper: e.paper,
        lifts: e.lifts, drawMm: e.drawMm != null ? e.drawMm.toFixed(1) : '', travelMm: e.travelMm != null ? e.travelMm.toFixed(1) : '',
        est_draw_s: s(est.drawMs), est_travel_s: s(est.travelMs), est_pen_s: s(est.penMs), est_overhead_s: s(est.overheadMs),
        est_raw_s: s(est.totalMs), est_shown_s: s(e.shownMs), actual_s: s(e.actualMs),
        error_pct: (e.actualMs > 0 && e.shownMs > 0) ? (100 * (e.shownMs - e.actualMs) / e.actualMs).toFixed(1) : '',
        drawSpeed: t.drawSpeed, travelSpeed: t.travelSpeed, drawAccel: t.drawAccel, travelAccel: t.travelAccel,
        cornering: t.cornering, penUpExtraMs: t.penUpExtraMs, penDownExtraMs: t.penDownExtraMs, cmdOverheadMs: t.cmdOverheadMs,
        kDraw: t.kDraw, kTravel: t.kTravel, kPen: t.kPen, correction: t.correction, optimized: e.optimized, notes: e.notes,
      };
      lines.push(CSV_COLUMNS.map(c => esc(row[c])).join(','));
    }
    return lines.join('\n') + '\n';
  }

  return { MACHINES, PAPERS, PENLIFTS, DEFAULTS, defaultSettings, mergeSettings, paperSizeMm, computeLayout, penServo,
    weightedRaw, correctedEstimate, calibrateFromEntry, fitTerms, logToCsv, CSV_COLUMNS };
});
