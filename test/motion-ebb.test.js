'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const motion = require('../plotter/motion.js');
const S = require('../plotter/settings.js');
const ebb = require('../plotter/ebb.js');
const gcode = require('../plotter/gcode.js');
const pipeline = require('../plotter/pipeline.js');

const settings = () => S.defaultSettings();
const kinOf = (s) => ebb.kinematics(s.machine);

function zigzag(x0, y0, n, step, amp) {
  const p = [x0, y0];
  for (let i = 1; i <= n; i++) p.push(x0 + i * step, y0 + (i % 2 ? amp : 0));
  return p;
}

test('pen-lift numbers match NextDraw defaults (brushless)', () => {
  const s = S.penServo(settings().machine);
  assert.equal(s.pin, 2);
  assert.equal(s.up, 9720);
  assert.equal(s.down, 8280);
  assert.equal(s.rateRaise, 231);
  assert.equal(s.rateLower, 154);
  assert.equal(s.raiseMs, 45);
  assert.equal(s.lowerMs, 47);
  assert.deepEqual(ebb.servoSetupCommands(settings().machine), ['SC,11,231', 'SC,12,154', 'SC,4,9720', 'SC,5,8280', 'SC,8,1']);
  assert.equal(ebb.penCmd(false, 45, s, {}), 'SP,1,45,2', 'SP,1 = pen up');
  assert.equal(ebb.penCmd(true, 47, s, {}), 'SP,0,47,2', 'SP,0 = pen down');
  assert.equal(ebb.penCmd(true, 47, s, { invertPen: true }), 'SP,1,47,2');
});

test('trapezoid: long move reaches cruise speed; time = L/v + v/a', () => {
  const t = settings().timing;
  const L = 200;
  const est = motion.estimateJob([[0, 0, L, 0]], t, { raiseMs: 0, lowerMs: 0 }, null, { returnHome: false });
  const expect = 1000 * (L / t.drawSpeed + t.drawSpeed / t.drawAccel);
  // travel from home to start is 0 here; small rounding from integer-ms slices
  assert.ok(Math.abs(est.drawMs - expect) < 5, `${est.drawMs} vs ${expect}`);
  // short move never reaches cruise: t = 2*sqrt(L/a)
  const e2 = motion.estimateJob([[0, 0, 1, 0]], t, { raiseMs: 0, lowerMs: 0 }, null, { returnHome: false });
  const expect2 = 1000 * 2 * Math.sqrt(1 / t.drawAccel);
  assert.ok(Math.abs(e2.drawMs - expect2) < 3, `${e2.drawMs} vs ${expect2}`);
});

test('collinear points do not slow the pen down; sharp zigzags do', () => {
  const t = settings().timing;
  const pen = { raiseMs: 0, lowerMs: 0 };
  const straight = [0, 0]; for (let i = 1; i <= 100; i++) straight.push(i, 0);
  const one = motion.estimateJob([[0, 0, 100, 0]], t, pen, null, { returnHome: false });
  const many = motion.estimateJob([straight], t, pen, null, { returnHome: false });
  assert.ok(Math.abs(one.drawMs - many.drawMs) < 0.02 * one.drawMs, `${one.drawMs} vs ${many.drawMs}`);
  const zz = motion.estimateJob([zigzag(0, 0, 100, 1, 3)], t, pen, null, { returnHome: false });
  const zzLen = 100 * Math.hypot(1, 3);
  const naive = 1000 * zzLen / t.drawSpeed;
  assert.ok(zz.drawMs > naive * 1.3, `accel makes zigzags slower than naive: ${zz.drawMs} vs ${naive}`);
});

test('acceleration effect: lower accel = longer; higher accel approaches naive', () => {
  const pen = { raiseMs: 0, lowerMs: 0 };
  const paths = []; for (let i = 0; i < 40; i++) paths.push(zigzag(10, 10 + i * 4, 60, 1.5, 1.5));
  const base = settings().timing;
  const slow = motion.estimateJob(paths, { ...base, drawAccel: 200, travelAccel: 200 }, pen, null).totalMs;
  const mid = motion.estimateJob(paths, base, pen, null).totalMs;
  const fast = motion.estimateJob(paths, { ...base, drawAccel: 1e6, travelAccel: 1e6, cornering: 100 }, pen, null).totalMs;
  const naive = motion.naiveEstimate(paths, base, pen);
  assert.ok(slow > mid && mid > fast, `${slow} > ${mid} > ${fast}`);
  assert.ok(Math.abs(fast - naive) / naive < 0.05, `fast accel ~ naive: ${fast} vs ${naive}`);
});

test('estimate is monotonic in the amount of drawing (detail)', () => {
  const t = settings().timing;
  const pen = S.penServo(settings().machine);
  let prev = 0;
  for (const spacing of [16, 12, 8, 6, 4]) {
    const paths = [];
    for (let y = 10; y < 200; y += spacing) paths.push(zigzag(10, y, 150, 1.2, 0.8));
    const e = motion.estimateJob(paths, t, pen, kinOf(settings()));
    assert.ok(e.totalMs > prev, `spacing ${spacing}: ${e.totalMs} > ${prev}`);
    prev = e.totalMs;
  }
});

test('EBB job time equals the estimate exactly (shared planner) and respects step-rate limit', () => {
  const s = settings();
  const paths = [zigzag(20, 20, 200, 0.7, 2), [30, 30, 150, 100, 30, 190], [100, 100, 100.05, 100]];
  const job = ebb.buildEbbJob(paths, s);
  let sum = 0;
  for (const line of job.lines) {
    const parts = line.split(',');
    if (parts[0] === 'SM') {
      const dur = +parts[1];
      assert.ok(Number.isInteger(dur) && dur >= 1);
      assert.ok(Math.abs(+parts[2]) / dur <= 25 && Math.abs(+parts[3]) / dur <= 25, 'rate ' + line);
      sum += dur;
    } else if (parts[0] === 'SP') sum += +parts[2];
  }
  const est = motion.estimateJob(paths, s.timing, S.penServo(s.machine), kinOf(s));
  assert.equal(sum, est.totalMs);
  assert.equal(job.cumMs[job.cumMs.length - 1], est.totalMs);
});

test('EBB round trip: decoded pen-down moves match the input within one step, no drift', () => {
  const s = settings();
  const spm = s.machine.stepsPerMm;
  const paths = [];
  // lots of awkward fractional coordinates to provoke rounding drift
  for (let i = 0; i < 60; i++) {
    const p = [];
    for (let k = 0; k < 40; k++) p.push(20 + i * 3.333 + Math.sin(k * 0.7) * 2.17, 15 + k * 4.1234 + Math.cos(i) * 0.31);
    paths.push(p);
  }
  paths.push([50, 50, 50, 50]); // a dot
  const job = ebb.buildEbbJob(paths, s);
  const dec = ebb.decodeEbb(job.lines, spm);
  assert.equal(dec.polylines.length, paths.length, 'one pen-down stroke per path');
  const tol = 1 / spm + 1e-9;
  paths.forEach((p, i) => {
    const d = dec.polylines[i];
    // start point
    assert.ok(Math.hypot(d[0] - p[0], d[1] - p[1]) <= tol, `path ${i} start`);
    // every input vertex is hit, in order
    let j = 0;
    for (let k = 2; k < p.length; k += 2) {
      while (j < d.length && Math.hypot(d[j] - p[k], d[j + 1] - p[k + 1]) > tol) j += 2;
      assert.ok(j < d.length, `path ${i} vertex ${k / 2} reached`);
    }
  });
  // back home exactly
  assert.equal(dec.m1, 0); assert.equal(dec.m2, 0);
});

test('bounds: plots that leave the paper or the machine are refused', () => {
  const s = settings();
  const layout = S.computeLayout(s, [0, 0, 640, 480]);
  assert.equal(layout.rotated, true, 'Letter portrait goes sideways on an 8511');
  assert.ok(ebb.checkBounds([[10, 10, 50, 50]], layout).ok);
  const off = ebb.checkBounds([[10, 10, 290, 10]], layout); // x beyond Letter's 279.4 mm
  assert.equal(off.ok, false);
  assert.match(off.problems[0], /off the paper/);
  const neg = ebb.checkBounds([[-1, 10, 5, 5]], layout);
  assert.equal(neg.ok, false);
  // a paper too big for the machine is flagged in the layout and its plot is refused
  const big = S.mergeSettings(S.DEFAULTS, { paper: { size: 'tabloid' } });
  const svg = '<svg viewBox="0 0 640 480"><path d="M0 0 L640 480"/></svg>';
  const prep = pipeline.preparePlot(svg, big, { optimize: false });
  assert.ok(prep.layout.warnings.length > 0);
  assert.equal(prep.bounds.ok, false);
});

test('layout fits the 640x480 SVG inside the margins, centred, aspect kept', () => {
  const s = settings();
  const svg = '<svg viewBox="0 0 640 480"><path d="M0 0 L640 0 L640 480 L0 480 Z"/></svg>';
  const prep = pipeline.preparePlot(svg, s, { optimize: false });
  const p = prep.paperPaths[0];
  const xs = p.filter((_, i) => i % 2 === 0), ys = p.filter((_, i) => i % 2 === 1);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(w / h - 640 / 480) < 1e-9, 'aspect kept');
  assert.ok(Math.abs(Math.min(...xs) - 12.7) < 1e-9, 'left margin');
  assert.ok(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - 279.4 / 2) < 1e-9, 'vertically centred');
  assert.ok(prep.bounds.ok);
});

test('G-code: header, pen commands, feed rates, and the drawing parses back (Y up)', () => {
  const s = settings();
  const paths = [[10, 20, 30, 20, 30, 40], [50, 50, 60, 70]];
  const text = gcode.buildGcode(paths, 279.4, s.gcode, s.timing, { style: 'test' });
  assert.match(text, /^; pen-plotter-self-portrait G-code/);
  assert.match(text, /\nG21\nG90\n/);
  assert.match(text, /G1 X30 Y259\.4 F2100/);
  assert.ok(text.trim().endsWith('M2'));
  const back = gcode.parseGcode(text, s.gcode);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], [10, 259.4, 30, 259.4, 30, 239.4]);
  const topLeft = gcode.buildGcode(paths, 279.4, { ...s.gcode, originBottomLeft: false, penUpCmd: 'M5', penDownCmd: 'M3 S1000', penDwellMs: 150 }, s.timing);
  assert.match(topLeft, /M3 S1000\nG4 P0\.15/);
  const back2 = gcode.parseGcode(topLeft, { penUpCmd: 'M5', penDownCmd: 'M3 S1000' });
  assert.deepEqual(back2[1], [50, 50, 60, 70]);
});

test('calibration: correction factor and per-term fit', () => {
  const t = settings().timing;
  const entry = { estimate: { drawMs: 60000, travelMs: 20000, penMs: 10000, overheadMs: 0, totalMs: 90000 }, actualMs: 99000 };
  assert.ok(Math.abs(S.calibrateFromEntry(entry, t) - 1.1) < 1e-9);
  // synthetic log where the truth is draw*1.2, travel*0.9, pen*1.5
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const e = { drawMs: 30000 + i * 15000, travelMs: 10000 + (i % 3) * 7000, penMs: 5000 + (i % 2) * 6000, overheadMs: 0 };
    rows.push({ estimate: e, actualMs: e.drawMs * 1.2 + e.travelMs * 0.9 + e.penMs * 1.5 });
  }
  const fit = S.fitTerms(rows);
  assert.ok(Math.abs(fit.kDraw - 1.2) < 0.01 && Math.abs(fit.kTravel - 0.9) < 0.02 && Math.abs(fit.kPen - 1.5) < 0.02, JSON.stringify(fit));
  const csv = S.logToCsv([{ when: '2026-10-05', kind: 'plot', style: 'outline', detail: 0.5, estimate: entry.estimate, shownMs: 90000, actualMs: 99000, settings: t }]);
  assert.equal(csv.split('\n')[0], S.CSV_COLUMNS.join(','));
  assert.match(csv, /outline,0\.5/);
  assert.match(csv, /-9\.1/);
});

test('settings merge ignores junk and keeps defaults', () => {
  const m = S.mergeSettings(S.DEFAULTS, { timing: { drawSpeed: 50, travelSpeed: 'fast', bogus: 1 }, machine: null });
  assert.equal(m.timing.drawSpeed, 50);
  assert.equal(m.timing.travelSpeed, S.DEFAULTS.timing.travelSpeed);
  assert.equal(m.timing.bogus, undefined);
});
