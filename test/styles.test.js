'use strict';
// End-to-end over the real output of every style (fixtures captured from the app
// by tools/capture_fixtures.py): flatten -> optimize -> estimate -> EBB + G-code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../plotter/settings.js');
const pipeline = require('../plotter/pipeline.js');
const ebb = require('../plotter/ebb.js');
const gcode = require('../plotter/gcode.js');

const DIR = path.join(__dirname, 'fixtures', 'svg');
const STYLES = ['outline', 'blueprint', 'topo', 'constellation', 'pinwheel', 'pixel', 'squiggle',
  'invader', 'sobel', 'spiral', 'wiggle', 'shards', 'composition'];
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

for (const style of STYLES) {
  test(`style ${style}: optimize, estimate, EBB and G-code without errors`, () => {
    const svg = read(`${style}-d50.svg`);
    const s = S.defaultSettings();
    const raw = pipeline.preparePlot(svg, s, { optimize: false });
    const opt = pipeline.preparePlot(svg, s, { optimize: true });
    assert.equal(raw.errors.length, 0, raw.errors.join('; '));
    assert.ok(raw.paperPaths.length > 0, 'has paths');
    assert.ok(opt.bounds.ok, opt.bounds.problems.join('; '));
    assert.ok(opt.opt.after.lifts <= opt.opt.before.lifts, 'no extra lifts');
    assert.ok(opt.opt.after.travelMm <= opt.opt.before.travelMm + 1e-6, 'no extra travel');
    // drawing is preserved (merge may only add sub-0.5 mm bridges; simplify may trim ≤0.02 mm wiggles)
    assert.ok(opt.estimate.drawMm >= raw.estimate.drawMm * 0.99, `drawn ${opt.estimate.drawMm} vs ${raw.estimate.drawMm}`);
    assert.ok(opt.estimate.totalMs > 0 && Number.isFinite(opt.estimate.totalMs));
    assert.ok(opt.estimate.totalMs <= raw.estimate.totalMs * 1.01, 'optimizing never makes it slower');

    const job = ebb.buildEbbJob(opt.machinePaths, s);
    assert.equal(job.cumMs[job.cumMs.length - 1], opt.estimate.totalMs, 'job time == estimate');
    const dec = ebb.decodeEbb(job.lines, s.machine.stepsPerMm);
    assert.equal(dec.polylines.length, opt.machinePaths.length);
    assert.equal(dec.m1, 0); assert.equal(dec.m2, 0);
    // spot-check: every path's start and end are reproduced within one step
    const tol = 1 / s.machine.stepsPerMm + 1e-9;
    opt.machinePaths.forEach((p, i) => {
      const d = dec.polylines[i];
      assert.ok(Math.hypot(d[0] - p[0], d[1] - p[1]) <= tol);
      assert.ok(Math.hypot(d[d.length - 2] - p[p.length - 2], d[d.length - 1] - p[p.length - 1]) <= tol);
    });

    const g = pipeline.buildGcodeFor(opt, s, { style });
    const back = gcode.parseGcode(g, s.gcode);
    assert.equal(back.length, opt.paperPaths.length);
    const svgOut = pipeline.plotReadySvg(opt.paperPaths, opt.layout);
    assert.match(svgOut, /width="215\.9mm" height="279\.4mm"/);
  });
}

test('estimate grows with the Detail slider (squiggle and outline fixtures)', () => {
  const s = S.defaultSettings();
  for (const style of ['squiggle', 'outline']) {
    const lo = pipeline.preparePlot(read(`${style}-d10.svg`), s).estimate.totalMs;
    const mid = pipeline.preparePlot(read(`${style}-d50.svg`), s).estimate.totalMs;
    const hi = pipeline.preparePlot(read(`${style}-d90.svg`), s).estimate.totalMs;
    assert.ok(lo < mid && mid < hi, `${style}: ${lo} < ${mid} < ${hi}`);
  }
});

test('G-code profile: Grbl estimate and output for a fixture', () => {
  const s = S.mergeSettings(S.DEFAULTS, { machine: { profile: 'grbl', travelX: 300, travelY: 300 } });
  const prep = pipeline.preparePlot(read('blueprint-d50.svg'), s);
  assert.equal(prep.layout.isGcode, true);
  assert.equal(prep.layout.rotated, false);
  const g = pipeline.buildGcodeFor(prep, s, {});
  assert.ok(g.split('\n').length > 1000);
});
