// plotter/motion.js — motion planner + time-slicer shared by the time estimate
// and the EBB command generator, so the estimate and the machine use one model.
//
// Model: each straight segment gets a trapezoidal speed profile (accelerate,
// cruise, decelerate). Speeds at corners come from a junction-deviation model
// (like Grbl's): sharper corner -> slower. Every path starts and ends at rest.
// The profile is cut into time slices; each slice becomes one constant-speed
// EBB "SM" move with an integer millisecond duration and whole motor steps.
// The estimate is the sum of exactly those slice durations plus pen times.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { const ns = root.PlotterLib = root.PlotterLib || {}; Object.assign(ns, factory()); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DRAW = 1, TRAVEL = 2;

  // Junction speed limit between unit vectors (ax,ay) -> (bx,by)
  function junctionSpeed(ax, ay, bx, by, accel, deviation, vmax) {
    // cos of the angle between the reversed incoming and the outgoing direction
    const cosTheta = -(ax * bx + ay * by);
    if (cosTheta > 0.999999) return 0;            // full reversal
    if (cosTheta < -0.999999) return vmax;        // straight on
    const sinHalf = Math.sqrt(0.5 * (1 - cosTheta));
    const v = Math.sqrt(accel * deviation * sinHalf / (1 - sinHalf));
    return Math.min(v, vmax);
  }

  // Speed cap so neither motor exceeds its step rate (CoreXY: m1 = x+y, m2 = x−y)
  function motorSpeedCap(ux, uy, kin) {
    if (!kin || !kin.stepsPerMm) return Infinity;
    const f = Math.max(Math.abs(ux + uy), Math.abs(ux - uy));
    if (f < 1e-12) return Infinity;
    return 0.95 * kin.maxStepRate / (kin.stepsPerMm * f);
  }

  // Build segments for one polyline with entry/exit speeds (forward + backward pass).
  function planPolyline(p, vmax, accel, deviation, kin) {
    const segs = [];
    for (let k = 2; k < p.length; k += 2) {
      const dx = p[k] - p[k - 2], dy = p[k + 1] - p[k - 1];
      const L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      const ux = dx / L, uy = dy / L;
      segs.push({ x0: p[k - 2], y0: p[k - 1], x1: p[k], y1: p[k + 1], L, ux, uy, vmax: Math.min(vmax, motorSpeedCap(ux, uy, kin)), v0: 0, v1: 0 });
    }
    const n = segs.length;
    if (!n) return segs;
    // junction limits: limit[k] = max speed at the start of seg k
    const limit = new Float64Array(n + 1);
    limit[0] = 0; limit[n] = 0;
    for (let k = 1; k < n; k++) {
      const a = segs[k - 1], b = segs[k];
      limit[k] = Math.min(junctionSpeed(a.ux, a.uy, b.ux, b.uy, accel, deviation, vmax), a.vmax, b.vmax);
    }
    // backward pass
    const v = new Float64Array(n + 1);
    v[n] = 0;
    for (let k = n - 1; k >= 0; k--) v[k] = Math.min(limit[k], Math.sqrt(v[k + 1] * v[k + 1] + 2 * accel * segs[k].L));
    v[0] = 0;
    // forward pass
    for (let k = 0; k < n; k++) v[k + 1] = Math.min(v[k + 1], Math.sqrt(v[k] * v[k] + 2 * accel * segs[k].L));
    for (let k = 0; k < n; k++) { segs[k].v0 = v[k]; segs[k].v1 = v[k + 1]; }
    return segs;
  }

  // Trapezoid for a segment: returns phase times (s) and distances.
  function trapezoid(L, v0, vc, v1, a) {
    const vPeak = Math.sqrt((2 * a * L + v0 * v0 + v1 * v1) / 2);
    if (vPeak < vc) vc = vPeak;
    vc = Math.max(vc, v0, v1, 1e-6);
    const ta = Math.max(0, (vc - v0) / a), da = Math.max(0, (vc * vc - v0 * v0) / (2 * a));
    const td = Math.max(0, (vc - v1) / a), dd = Math.max(0, (vc * vc - v1 * v1) / (2 * a));
    let dc = L - da - dd;
    if (dc < 0) dc = 0;
    const tc = dc / vc;
    return { v0, vc, v1, a, ta, tc, td, da, dc, dd, T: ta + tc + td };
  }

  function distanceAt(tr, t) {
    if (t <= tr.ta) return tr.v0 * t + 0.5 * tr.a * t * t;
    if (t <= tr.ta + tr.tc) return tr.da + tr.vc * (t - tr.ta);
    const tau = Math.min(t - tr.ta - tr.tc, tr.td);
    return tr.da + tr.dc + tr.vc * tau - 0.5 * tr.a * tau * tau;
  }

  // The slicer turns planned segments into SM-sized moves.
  // emit.move(xTarget, yTarget, durMs, m1Target, m2Target, kind)
  // emit.pen(down: bool, ms)
  class Slicer {
    constructor(opts, emit) {
      this.kin = opts.kin || null;             // {stepsPerMm, maxStepRate} for EBB, null for G-code
      this.maxSliceMs = opts.maxSliceMs || 20;
      this.maxCruiseMs = opts.maxCruiseMs || 400;
      this.minSliceMs = opts.minSliceMs || 2;
      this.emit = emit || {};
      this.x = 0; this.y = 0;
      this.m1 = 0; this.m2 = 0;
      this.carry = 0;
      this.pendingMs = 0;                       // time of slices with no steps, folded into the next move
      this.totals = { drawMs: 0, travelMs: 0, penMs: 0, drawMm: 0, travelMm: 0, lifts: 0, moves: 0, penCmds: 0 };
    }
    stepsAt(x, y) {
      const s = this.kin.stepsPerMm;
      return [Math.round(s * (x + y)), Math.round(s * (x - y))];
    }
    slice(x, y, dtMs, kind) {
      let dur = Math.round(dtMs + this.carry);
      let m1 = 0, m2 = 0, d1 = 0, d2 = 0;
      if (this.kin) {
        [m1, m2] = this.stepsAt(x, y);
        d1 = m1 - this.m1; d2 = m2 - this.m2;
        if (d1 === 0 && d2 === 0) {
          // no motor motion in this slice: fold its time into the next one
          this.pendingMs += dtMs;
          this.x = x; this.y = y;
          return;
        }
      }
      dur = Math.round(dtMs + this.pendingMs + this.carry);
      dur = Math.max(this.minSliceMs, dur);
      if (this.kin) {
        const maxPerMs = this.kin.maxStepRate / 1000;
        const need = Math.ceil(Math.max(Math.abs(d1), Math.abs(d2)) / maxPerMs);
        if (need > dur) dur = need;
      }
      this.carry += dtMs + this.pendingMs - dur;
      if (this.carry < -0.5) this.carry = -0.5;
      if (this.carry > 0.5) this.carry = 0.5;
      this.pendingMs = 0;
      if (kind === DRAW) this.totals.drawMs += dur; else this.totals.travelMs += dur;
      this.totals.moves++;
      if (this.emit.move) this.emit.move(x, y, dur, m1, m2, kind);
      this.x = x; this.y = y; this.m1 = m1; this.m2 = m2;
    }
    flushPending(kind) {
      // leftover time with no steps (rare): emit as a pure delay so time is kept
      const dur = Math.round(this.pendingMs + this.carry);
      this.pendingMs = 0;
      if (dur >= 1) {
        this.carry = 0;
        if (kind === DRAW) this.totals.drawMs += dur; else this.totals.travelMs += dur;
        this.totals.moves++;
        if (this.emit.move) this.emit.move(this.x, this.y, dur, this.m1, this.m2, kind);
      }
    }
    segment(seg, accel, kind) {
      const tr = trapezoid(seg.L, seg.v0, seg.vmax, seg.v1, accel);
      const phases = [[0, tr.ta, this.maxSliceMs], [tr.ta, tr.ta + tr.tc, this.maxCruiseMs], [tr.ta + tr.tc, tr.T, this.maxSliceMs]];
      let tPrev = 0;
      for (const [t0, t1, maxMs] of phases) {
        const span = (t1 - t0) * 1000;
        if (span <= 1e-9) continue;
        const n = Math.max(1, Math.ceil(span / maxMs - 1e-9));
        for (let i = 1; i <= n; i++) {
          const t = (i === n) ? t1 : t0 + (t1 - t0) * i / n;
          const s = (t1 === tr.T && i === n) ? seg.L : Math.min(seg.L, distanceAt(tr, t));
          const x = seg.x0 + seg.ux * s, y = seg.y0 + seg.uy * s;
          this.slice(x, y, (t - tPrev) * 1000, kind);
          tPrev = t;
        }
      }
      if (kind === DRAW) this.totals.drawMm += seg.L; else this.totals.travelMm += seg.L;
      // make sure we end exactly on the vertex (slices end on it already)
      this.x = seg.x1; this.y = seg.y1;
    }
    polyline(p, vmax, accel, deviation, kind) {
      const segs = planPolyline(p, vmax, accel, deviation, this.kin);
      for (const s of segs) this.segment(s, accel, kind);
      this.flushPending(kind);
    }
    pen(down, ms) {
      this.flushPending(TRAVEL);
      this.totals.penMs += ms;
      this.totals.penCmds++;
      if (down) this.totals.lifts++;
      if (this.emit.pen) this.emit.pen(down, ms);
    }
  }

  // Walk a whole job. paths: flat arrays in machine mm. Starts/ends at `home`, pen up.
  // timing: settings.timing; pen: {raiseMs, lowerMs}; kin: {stepsPerMm, maxStepRate} or null
  function runJob(paths, timing, pen, kin, emit, opts) {
    opts = opts || {};
    const home = opts.home || [0, 0];
    const sl = new Slicer({ kin, maxSliceMs: timing.maxSliceMs, minSliceMs: timing.minSliceMs }, emit);
    sl.x = home[0]; sl.y = home[1];
    if (kin) { [sl.m1, sl.m2] = sl.stepsAt(home[0], home[1]); }
    const raiseMs = Math.max(1, Math.round(pen.raiseMs + (timing.penUpExtraMs || 0)));
    const lowerMs = Math.max(1, Math.round(pen.lowerMs + (timing.penDownExtraMs || 0)));
    const dev = Math.max(1e-4, timing.cornering);
    const travelTo = (x, y) => {
      if (Math.hypot(x - sl.x, y - sl.y) < 1e-9) return;
      sl.polyline([sl.x, sl.y, x, y], timing.travelSpeed, timing.travelAccel, dev, TRAVEL);
    };
    for (const p of paths) {
      if (!p || p.length < 2) continue;
      travelTo(p[0], p[1]);
      sl.pen(true, lowerMs);
      sl.polyline(p, timing.drawSpeed, timing.drawAccel, dev, DRAW);
      sl.pen(false, raiseMs);
    }
    if (opts.returnHome !== false) travelTo(home[0], home[1]);
    sl.flushPending(TRAVEL);
    const t = sl.totals;
    const overheadMs = (t.moves + t.penCmds) * (timing.cmdOverheadMs || 0);
    return {
      drawMs: t.drawMs, travelMs: t.travelMs, penMs: t.penMs, overheadMs,
      totalMs: t.drawMs + t.travelMs + t.penMs + overheadMs,
      drawMm: t.drawMm, travelMm: t.travelMm, lifts: t.lifts, commands: t.moves + t.penCmds,
      raiseMs, lowerMs,
    };
  }

  // Estimate only (no command strings). Same code path as the EBB generator.
  function estimateJob(paths, timing, pen, kin, opts) {
    return runJob(paths, timing, pen, kin, null, opts);
  }

  // Naive length/speed estimate, for comparison in tests and the UI breakdown.
  function naiveEstimate(paths, timing, pen) {
    let x = 0, y = 0, draw = 0, travel = 0;
    for (const p of paths) {
      travel += Math.hypot(p[0] - x, p[1] - y);
      for (let k = 2; k < p.length; k += 2) draw += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
      x = p[p.length - 2]; y = p[p.length - 1];
    }
    travel += Math.hypot(x, y);
    return 1000 * (draw / timing.drawSpeed + travel / timing.travelSpeed) + paths.length * (pen.raiseMs + pen.lowerMs);
  }

  return { runJob, estimateJob, naiveEstimate, planPolyline, trapezoid, distanceAt, junctionSpeed, motorSpeedCap, Slicer, KIND_DRAW: DRAW, KIND_TRAVEL: TRAVEL };
});
