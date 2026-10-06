// plotter/gcode.js — G-code for Grbl-style pen plotters (download only, no streaming).
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { const ns = root.PlotterLib = root.PlotterLib || {}; Object.assign(ns, factory()); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fmt(n) {
    const s = (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  }

  // paths: flat arrays in paper mm (u right, v down from the paper's top-left).
  // paperH: paper height (for Y-up conversion). g: settings.gcode, timing: settings.timing
  function buildGcode(paths, paperH, g, timing, meta) {
    const out = [];
    const yOf = (v) => g.originBottomLeft ? paperH - v : v;
    const fDraw = Math.round(timing.drawSpeed * 60);
    const fTravel = Math.round(timing.travelSpeed * 60);
    const dwell = g.penDwellMs > 0 ? `G4 P${fmt(g.penDwellMs / 1000)}` : null;
    out.push('; pen-plotter-self-portrait G-code');
    if (meta) for (const k of Object.keys(meta)) out.push(`; ${k}: ${meta[k]}`);
    out.push(`; origin: paper ${g.originBottomLeft ? 'bottom-left, Y up' : 'top-left, Y down'}; units mm`);
    if (g.header) out.push(...g.header.split(/\r?\n/));
    out.push('G21', 'G90');
    const up = () => { out.push(...g.penUpCmd.split(/\r?\n/).filter(Boolean)); if (dwell) out.push(dwell); };
    const down = () => { out.push(...g.penDownCmd.split(/\r?\n/).filter(Boolean)); if (dwell) out.push(dwell); };
    up();
    for (const p of paths) {
      out.push(`G0 X${fmt(p[0])} Y${fmt(yOf(p[1]))} F${fTravel}`);
      down();
      let first = true;
      for (let k = 2; k < p.length; k += 2) {
        out.push(`G1 X${fmt(p[k])} Y${fmt(yOf(p[k + 1]))}` + (first ? ` F${fDraw}` : ''));
        first = false;
      }
      up();
    }
    out.push(`G0 X0 Y0 F${fTravel}`);
    if (g.footer) out.push(...g.footer.split(/\r?\n/));
    out.push('M2');
    return out.join('\n') + '\n';
  }

  // Minimal parser used by the tests: returns pen-down polylines in G-code coordinates.
  function parseGcode(text, g) {
    const isCmd = (line, cmd) => cmd.split(/\r?\n/).filter(Boolean).some(c => c.trim() === line.trim());
    let x = 0, y = 0, down = false;
    const polys = [];
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/;.*$/, '').trim();
      if (!line) continue;
      if (isCmd(line, g.penDownCmd)) { down = true; cur = [x, y]; continue; }
      if (isCmd(line, g.penUpCmd)) { if (down && cur) polys.push(cur); down = false; cur = null; continue; }
      const m = /^G([01])\b(.*)$/i.exec(line);
      if (!m) continue;
      const mx = /X(-?[\d.]+)/i.exec(m[2]), my = /Y(-?[\d.]+)/i.exec(m[2]);
      if (mx) x = parseFloat(mx[1]);
      if (my) y = parseFloat(my[1]);
      if (down && cur) cur.push(x, y);
    }
    return polys;
  }

  return { buildGcode, parseGcode };
});
