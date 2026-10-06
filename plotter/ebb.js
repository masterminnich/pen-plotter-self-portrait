// plotter/ebb.js — EBB (EiBotBoard / NextDraw) command generation.
// Protocol facts and sources: docs/nextdraw-protocol.md
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./motion.js'), require('./settings.js'));
  else { const ns = root.PlotterLib = root.PlotterLib || {}; Object.assign(ns, factory(ns, ns)); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (motion, settingsLib) {
  'use strict';

  const USB_FILTERS = [{ usbVendorId: 0x04D8, usbProductId: 0xFD92 }];

  function penCmd(down, ms, servo, machine) {
    // SP,0 = pen down (SC,5), SP,1 = pen up (SC,4). invertPen swaps them if the morning test says so.
    let v = down ? 0 : 1;
    if (machine && machine.invertPen) v = 1 - v;
    return `SP,${v},${Math.min(65535, Math.max(1, Math.round(ms)))},${servo.pin}`;
  }

  // Servo configuration (sent before plots and pen tests)
  function servoSetupCommands(machine) {
    const s = settingsLib.penServo(machine);
    const cmds = [`SC,11,${s.rateRaise}`, `SC,12,${s.rateLower}`, `SC,4,${s.up}`, `SC,5,${s.down}`];
    if (s.channels === 1) cmds.push('SC,8,1');
    else cmds.push('SC,8,8', 'SR,60000');
    return cmds;
  }

  function kinematics(machine) {
    return { stepsPerMm: machine.stepsPerMm, maxStepRate: machine.maxStepRate };
  }

  // Check every point. Pen-down points must be on the paper; everything must be
  // within machine travel. Returns {ok, problems[]}.
  function checkBounds(paths, layout, tolMm) {
    tolMm = tolMm === undefined ? 0.01 : tolMm;
    const problems = [];
    const pr = layout.paperRectMachine;
    const TX = layout.travelX, TY = layout.travelY;
    let bad = 0;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      for (let k = 0; k < p.length; k += 2) {
        const x = p[k], y = p[k + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) { bad++; if (problems.length < 5) problems.push(`path ${i + 1}: invalid coordinate`); continue; }
        const offTravel = x < -tolMm || y < -tolMm || x > TX + tolMm || y > TY + tolMm;
        const offPaper = x < pr.x0 - tolMm || y < pr.y0 - tolMm || x > pr.x1 + tolMm || y > pr.y1 + tolMm;
        if (offTravel || offPaper) {
          bad++;
          if (problems.length < 5) problems.push(`path ${i + 1}: point (${x.toFixed(1)}, ${y.toFixed(1)}) mm is ${offTravel ? 'outside machine travel' : 'off the paper'}`);
        }
      }
    }
    if (bad > 5) problems.push(`…and ${bad - 5} more`);
    return { ok: bad === 0, problems, badPoints: bad };
  }

  // Build the full command stream for a plot. paths are in machine mm.
  // Returns { lines[], cumMs (Float64Array, planned ms after each line), kinds (Uint8Array), estimate }
  // kinds: 1 draw move, 2 travel move, 3 pen down, 4 pen up
  function buildEbbJob(paths, settings, opts) {
    opts = opts || {};
    const machine = settings.machine;
    const servo = settingsLib.penServo(machine);
    const kin = kinematics(machine);
    const lines = [];
    const cum = [];
    const kinds = [];
    let t = 0;
    const overhead = settings.timing.cmdOverheadMs || 0;
    const dry = !!opts.dryRun;
    const emit = {
      move(x, y, dur, m1, m2, kind) {
        // steps are absolute targets; send the difference
        const d1 = m1 - emit._m1, d2 = m2 - emit._m2;
        emit._m1 = m1; emit._m2 = m2;
        lines.push(`SM,${dur},${d1},${d2}`);
        t += dur + overhead; cum.push(t); kinds.push(kind);
      },
      pen(down, ms) {
        if (dry) {
          // Dry run: keep the timing of the pen moves but leave the pen up.
          lines.push(`SM,${Math.max(1, Math.round(ms))},0,0`);
        } else {
          lines.push(penCmd(down, ms, servo, machine));
        }
        t += ms + overhead; cum.push(t); kinds.push(down ? 3 : 4);
      },
      _m1: 0, _m2: 0,
    };
    const home = opts.home || [0, 0];
    emit._m1 = Math.round(kin.stepsPerMm * (home[0] + home[1]));
    emit._m2 = Math.round(kin.stepsPerMm * (home[0] - home[1]));
    const estimate = motion.runJob(paths, settings.timing, servo, kin, emit, { home });
    return { lines, cumMs: Float64Array.from(cum), kinds: Uint8Array.from(kinds), estimate, servo };
  }

  // Decode SM / SP commands back to XY (mm). Returns pen-down polylines and the final position.
  function decodeEbb(lines, stepsPerMm, opts) {
    opts = opts || {};
    let m1 = 0, m2 = 0, penDown = false, timeMs = 0;
    const invert = !!opts.invertPen;
    const polys = [];
    let cur = null;
    const xy = () => [(m1 + m2) / (2 * stepsPerMm), (m1 - m2) / (2 * stepsPerMm)];
    for (const line of lines) {
      const parts = line.split(',');
      const c = parts[0].toUpperCase();
      if (c === 'SM') {
        const dur = +parts[1], a = +parts[2], b = +(parts[3] || 0);
        m1 += a; m2 += b; timeMs += dur;
        if (penDown && cur) { const [x, y] = xy(); cur.push(x, y); }
      } else if (c === 'XM') {
        const dur = +parts[1], a = +parts[2], b = +(parts[3] || 0);
        m1 += a + b; m2 += a - b; timeMs += dur;
        if (penDown && cur) { const [x, y] = xy(); cur.push(x, y); }
      } else if (c === 'SP') {
        let v = +parts[1];
        if (invert && (v === 0 || v === 1)) v = 1 - v;
        const down = v === 0;
        timeMs += +(parts[2] || 0);
        if (down && !penDown) { const [x, y] = xy(); cur = [x, y]; }
        if (!down && penDown && cur) { polys.push(cur); cur = null; }
        penDown = down;
      }
    }
    if (cur) polys.push(cur);
    const [x, y] = xy();
    return { polylines: polys, x, y, m1, m2, timeMs };
  }

  // Simple utility moves (test square, jog) at a fixed slow speed, as SM lines.
  function buildPathMoves(paths, settings, home) {
    return buildEbbJob(paths, settings, { home });
  }

  // 50 mm test square drawn `inset` mm from home along +x/+y, with a letter F
  // inside its home-side corner: if the F comes out mirrored (from any side),
  // an axis direction is wrong.
  function testSquarePaths(size, inset) {
    size = size || 50; inset = inset === undefined ? 20 : inset;
    const a = inset, b = inset + size;
    const f = a + 6;
    return [
      [a, a, b, a, b, b, a, b, a, a],
      [f + 8, f, f, f, f, f + 15],   // F: top bar then stem
      [f, f + 7, f + 6, f + 7],       // F: middle bar
    ];
  }

  return { USB_FILTERS, penCmd, servoSetupCommands, kinematics, checkBounds, buildEbbJob, decodeEbb, buildPathMoves, testSquarePaths };
});
