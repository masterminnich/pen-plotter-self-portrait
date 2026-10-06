// plotter/pipeline.js — SVG text -> paper mm -> (optimized) -> machine mm -> estimate.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./svgpath.js'), require('./optimize.js'), require('./motion.js'), require('./settings.js'), require('./ebb.js'), require('./gcode.js'));
  } else { const ns = root.PlotterLib = root.PlotterLib || {}; Object.assign(ns, factory(ns, ns, ns, ns, ns, ns)); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (svgpath, optimize, motion, S, ebb, gcode) {
  'use strict';

  // Flatten + fit. Returns paper-space paths (mm) and the layout.
  function svgToPaperPaths(svgText, settings) {
    const doc = svgpath.parseSvgDocument(svgText);
    const layout = S.computeLayout(settings, doc.viewBox);
    const tolSrc = Math.max(1e-4, settings.optimize.curveTol) / layout.scale;
    const res = svgpath.svgToPolylines(svgText, tolSrc);
    const paths = res.polylines.map(p => {
      const q = new Array(p.length);
      for (let k = 0; k < p.length; k += 2) { const [u, v] = layout.toPaper(p[k], p[k + 1]); q[k] = u; q[k + 1] = v; }
      return q;
    });
    return { layout, paths, skipped: res.skipped, errors: res.errors };
  }

  function toMachine(paths, layout) {
    return paths.map(p => {
      const q = new Array(p.length);
      for (let k = 0; k < p.length; k += 2) { const [x, y] = layout.paperToMachine(p[k], p[k + 1]); q[k] = x; q[k + 1] = y; }
      return q;
    });
  }

  // The home position expressed in paper coordinates (where travel starts/ends)
  function homeInPaper(layout, settings) {
    if (layout.isGcode) return (settings && settings.gcode && !settings.gcode.originBottomLeft) ? [0, 0] : [0, layout.paperH];
    return layout.machineToPaper(0, 0);
  }

  // opts.optimize: run the optimizer (default settings.optimize.enabled)
  function preparePlot(svgText, settings, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const base = svgToPaperPaths(svgText, settings);
    const layout = base.layout;
    const doOpt = opts.optimize !== undefined ? opts.optimize : settings.optimize.enabled;
    const o = settings.optimize;
    const home = homeInPaper(layout, settings);
    let paperPaths = base.paths;
    let opt = null;
    if (doOpt) {
      opt = optimize.optimizePaths(paperPaths, { merge: o.merge, mergeTol: o.mergeTol, sort: o.sort, reverse: o.reverse, simplifyTol: o.simplifyTol, start: home });
      paperPaths = opt.paths;
    }
    const machinePaths = layout.isGcode ? paperPaths : toMachine(paperPaths, layout);
    const servo = S.penServo(settings.machine);
    const kin = layout.isGcode ? null : ebb.kinematics(settings.machine);
    const estimate = motion.estimateJob(machinePaths, settings.timing, layout.isGcode ? gcodePen(settings) : servo, kin, { home: layout.isGcode ? home : [0, 0] });
    const shownMs = S.correctedEstimate(estimate, settings.timing);
    const bounds = layout.isGcode ? { ok: true, problems: [] } : ebb.checkBounds(machinePaths, layout);
    return { layout, paperPaths, machinePaths, optimized: !!doOpt, opt, estimate, shownMs, bounds,
      sourcePathCount: base.paths.length, skipped: base.skipped, errors: base.errors, ms: Date.now() - t0 };
  }

  function gcodePen(settings) {
    const d = settings.gcode.penDwellMs || 0;
    return { raiseMs: d, lowerMs: d };
  }

  // Optimized SVG at true size in mm (works in the NextDraw desktop app / Inkscape).
  function plotReadySvg(paperPaths, layout, meta) {
    const W = layout.paperW, H = layout.paperH;
    const f = (n) => (Math.round(n * 1000) / 1000).toString();
    const parts = [];
    parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">`);
    if (meta) parts.push(`<desc>${String(meta).replace(/[<&]/g, '')}</desc>`);
    parts.push(`<g fill="none" stroke="#000" stroke-width="0.3" stroke-linecap="round" stroke-linejoin="round">`);
    for (const p of paperPaths) {
      let d = `M${f(p[0])} ${f(p[1])}`;
      for (let k = 2; k < p.length; k += 2) d += `L${f(p[k])} ${f(p[k + 1])}`;
      if (p.length === 2) d += 'z';
      parts.push(`<path d="${d}"/>`);
    }
    parts.push('</g></svg>');
    return parts.join('\n');
  }

  // Travel moves (pen-up) as segments in the SVG's source units, for the preview overlay.
  function travelSegmentsInSource(paperPaths, layout, settings) {
    const s = layout.scale, vb = layout.viewBox, du = layout.drawRect.u0, dv = layout.drawRect.v0;
    const inv = (u, v) => [vb[0] + (u - du) / s, vb[1] + (v - dv) / s];
    const segs = [];
    let prev = homeInPaper(layout, settings);
    for (const p of paperPaths) {
      segs.push(inv(prev[0], prev[1]).concat(inv(p[0], p[1])));
      prev = [p[p.length - 2], p[p.length - 1]];
    }
    return segs;
  }

  function buildGcodeFor(prep, settings, meta) {
    const paperPaths = prep.paperPaths;
    return gcode.buildGcode(paperPaths, prep.layout.paperH, settings.gcode, settings.timing, meta);
  }

  return { svgToPaperPaths, toMachine, preparePlot, plotReadySvg, travelSegmentsInSource, buildGcodeFor, homeInPaper };
});
