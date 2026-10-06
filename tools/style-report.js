#!/usr/bin/env node
// Prints a markdown table of optimization savings and time estimates for the
// style fixtures in test/fixtures/svg (default settings: NextDraw 8511, Letter).
//   node tools/style-report.js
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../plotter/settings.js');
const pipeline = require('../plotter/pipeline.js');
const motion = require('../plotter/motion.js');
const ebb = require('../plotter/ebb.js');

const DIR = path.join(__dirname, '..', 'test', 'fixtures', 'svg');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('-d50.svg')).sort();
const s = S.defaultSettings();
const fmt = (ms) => { const t = Math.round(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const rows = [];
for (const f of files) {
  const svg = fs.readFileSync(path.join(DIR, f), 'utf8');
  const raw = pipeline.preparePlot(svg, s, { optimize: false });
  const t0 = Date.now();
  const opt = pipeline.preparePlot(svg, s, { optimize: true });
  const ms = Date.now() - t0;
  const job = ebb.buildEbbJob(opt.machinePaths, s);
  const naive = motion.naiveEstimate(opt.machinePaths, s.timing, S.penServo(s.machine));
  const b = opt.opt.before, a = opt.opt.after;
  rows.push(`| ${f.replace('-d50.svg', '')} | ${b.lifts} → ${a.lifts} | ${(b.travelMm / 1000).toFixed(1)} → ${(a.travelMm / 1000).toFixed(1)} m | ${(a.drawMm / 1000).toFixed(1)} m | ${fmt(raw.estimate.totalMs)} → **${fmt(opt.estimate.totalMs)}** | ${fmt(naive)} | ${job.lines.length} | ${ms} ms |`);
}
console.log('| Style | Pen lifts | Travel | Drawn | Estimate (raw → optimized) | Naive length/speed | EBB commands | Optimize time |');
console.log('|---|---|---|---|---|---|---|---|');
console.log(rows.join('\n'));
