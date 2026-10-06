// plotter/svgpath.js — SVG path parser + flattener.
//
// Turns SVG markup (or a single path "d" string) into polylines: plain arrays
// [x0, y0, x1, y1, ...] in the SVG's own user units. Every path command is
// supported (M L H V C S Q T A Z, absolute and relative, implicit repeats).
// Curves and arcs are flattened to within a chord tolerance.
//
// Loads as a classic <script> (adds to window.PlotterLib) and in Node
// (module.exports) so the same code is unit-tested.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { const ns = root.PlotterLib = root.PlotterLib || {}; Object.assign(ns, factory()); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ARG_COUNTS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

  // Tokenise a path string into [{cmd, args}] with implicit repeats expanded.
  function parsePathData(d) {
    const out = [];
    if (!d) return out;
    const s = String(d);
    let i = 0;
    const n = s.length;
    let cmd = null;

    function skipSep() {
      while (i < n) {
        const c = s.charCodeAt(i);
        // whitespace or comma
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) i++;
        else break;
      }
    }
    function readNumber() {
      skipSep();
      const start = i;
      if (s[i] === '+' || s[i] === '-') i++;
      let sawDigit = false, sawDot = false;
      while (i < n) {
        const ch = s[i];
        if (ch >= '0' && ch <= '9') { sawDigit = true; i++; }
        else if (ch === '.' && !sawDot) { sawDot = true; i++; }
        else break;
      }
      if (!sawDigit) { i = start; return null; }
      if (s[i] === 'e' || s[i] === 'E') {
        const save = i;
        i++;
        if (s[i] === '+' || s[i] === '-') i++;
        let expDigit = false;
        while (i < n && s[i] >= '0' && s[i] <= '9') { expDigit = true; i++; }
        if (!expDigit) i = save;
      }
      return parseFloat(s.slice(start, i));
    }
    function readFlag() {
      skipSep();
      const ch = s[i];
      if (ch === '0' || ch === '1') { i++; return ch === '1' ? 1 : 0; }
      return null;
    }

    while (true) {
      skipSep();
      if (i >= n) break;
      const ch = s[i];
      if (/[MLHVCSQTAZmlhvcsqtaz]/.test(ch)) {
        cmd = ch;
        i++;
        if (cmd === 'Z' || cmd === 'z') { out.push({ cmd, args: [] }); continue; }
      } else if (cmd === null) {
        throw new Error('Path data must start with a command near "' + s.slice(i, i + 10) + '"');
      } else if (cmd === 'Z' || cmd === 'z') {
        throw new Error('Unexpected number after Z near "' + s.slice(i, i + 10) + '"');
      }
      // read argument groups for cmd (repeat while numbers follow)
      const upper = cmd.toUpperCase();
      const count = ARG_COUNTS[upper];
      let first = true;
      while (true) {
        skipSep();
        if (i >= n) break;
        if (!first && /[MLHVCSQTAZmlhvcsqtaz]/.test(s[i])) break;
        const args = [];
        for (let k = 0; k < count; k++) {
          let v;
          if (upper === 'A' && (k === 3 || k === 4)) v = readFlag();
          else v = readNumber();
          if (v === null) {
            if (k === 0 && !first) { break; }
            throw new Error('Bad number in path data near "' + s.slice(i, i + 10) + '"');
          }
          args.push(v);
        }
        if (args.length === 0) break;
        let c = cmd;
        // Extra pairs after M/m are implicit L/l
        if (!first && (cmd === 'M')) c = 'L';
        if (!first && (cmd === 'm')) c = 'l';
        out.push({ cmd: c, args });
        first = false;
      }
    }
    return out;
  }

  // Number of segments for a Bezier of degree `deg` with control polygon pts
  // (flat array) so that the chord error stays under tol (Wang's formula).
  function bezierSegments(pts, deg, tol) {
    let m = 0;
    for (let k = 0; k + 2 <= deg; k++) {
      const ax = pts[2 * k] - 2 * pts[2 * k + 2] + pts[2 * k + 4];
      const ay = pts[2 * k + 1] - 2 * pts[2 * k + 3] + pts[2 * k + 5];
      m = Math.max(m, Math.hypot(ax, ay));
    }
    const nSeg = Math.ceil(Math.sqrt((deg * (deg - 1) / 8) * m / Math.max(tol, 1e-9)));
    return Math.min(Math.max(nSeg, 1), 1000);
  }

  // SVG arc endpoint -> center parameterisation (SVG 1.1 spec F.6.5)
  function arcToCenter(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx === 0 || ry === 0) return null; // straight line
    const phi = phiDeg * Math.PI / 180;
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy;
    const y1p = -sin * dx + cos * dy;
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) { const sq = Math.sqrt(lambda); rx *= sq; ry *= sq; }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
    if (fa === fs) coef = -coef;
    const cxp = coef * (rx * y1p) / ry;
    const cyp = coef * -(ry * x1p) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    function ang(ux, uy, vx, vy) {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    }
    const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
    const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
    const theta1 = ang(1, 0, ux, uy);
    let dtheta = ang(ux, uy, vx, vy);
    if (!fs && dtheta > 0) dtheta -= 2 * Math.PI;
    else if (fs && dtheta < 0) dtheta += 2 * Math.PI;
    return { cx, cy, rx, ry, phi, theta1, dtheta };
  }

  // Flatten one path "d" into polylines. tol = max chord error (same units).
  // Returns array of flat arrays. Each subpath (M) starts a new polyline.
  function flattenPathData(d, tol) {
    tol = tol > 0 ? tol : 0.1;
    const cmds = typeof d === 'string' ? parsePathData(d) : d;
    const polys = [];
    let cur = null;
    let x = 0, y = 0, sx = 0, sy = 0;
    let lastCtrlX = null, lastCtrlY = null, lastCmd = '';

    function begin(px, py) {
      if (cur && cur.length >= 2) polys.push(cur);
      cur = [px, py];
    }
    function lineTo(px, py) {
      if (!cur) cur = [x, y];
      cur.push(px, py);
    }

    for (const { cmd, args } of cmds) {
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      const ox = rel ? x : 0, oy = rel ? y : 0;
      // drawing right after Z (or at the very start) begins at the current point
      if (!cur && C !== 'M' && C !== 'Z') cur = [x, y];
      switch (C) {
        case 'M':
          x = ox + args[0]; y = oy + args[1];
          sx = x; sy = y;
          begin(x, y);
          lastCtrlX = lastCtrlY = null;
          break;
        case 'L':
          x = ox + args[0]; y = oy + args[1];
          lineTo(x, y);
          break;
        case 'H':
          x = (rel ? x : 0) + args[0];
          lineTo(x, y);
          break;
        case 'V':
          y = (rel ? y : 0) + args[0];
          lineTo(x, y);
          break;
        case 'C':
        case 'S': {
          let c1x, c1y, c2x, c2y, ex, ey;
          if (C === 'C') {
            c1x = ox + args[0]; c1y = oy + args[1];
            c2x = ox + args[2]; c2y = oy + args[3];
            ex = ox + args[4]; ey = oy + args[5];
          } else {
            if (lastCtrlX !== null && (lastCmd === 'C' || lastCmd === 'S')) {
              c1x = 2 * x - lastCtrlX; c1y = 2 * y - lastCtrlY;
            } else { c1x = x; c1y = y; }
            c2x = ox + args[0]; c2y = oy + args[1];
            ex = ox + args[2]; ey = oy + args[3];
          }
          const pts = [x, y, c1x, c1y, c2x, c2y, ex, ey];
          const nSeg = bezierSegments(pts, 3, tol);
          if (!cur) cur = [x, y];
          for (let k = 1; k <= nSeg; k++) {
            const t = k / nSeg, mt = 1 - t;
            const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, e = t * t * t;
            cur.push(a * x + b * c1x + c * c2x + e * ex, a * y + b * c1y + c * c2y + e * ey);
          }
          cur[cur.length - 2] = ex; cur[cur.length - 1] = ey;
          lastCtrlX = c2x; lastCtrlY = c2y;
          x = ex; y = ey;
          break;
        }
        case 'Q':
        case 'T': {
          let cx, cy, ex, ey;
          if (C === 'Q') {
            cx = ox + args[0]; cy = oy + args[1];
            ex = ox + args[2]; ey = oy + args[3];
          } else {
            if (lastCtrlX !== null && (lastCmd === 'Q' || lastCmd === 'T')) {
              cx = 2 * x - lastCtrlX; cy = 2 * y - lastCtrlY;
            } else { cx = x; cy = y; }
            ex = ox + args[0]; ey = oy + args[1];
          }
          const pts = [x, y, cx, cy, ex, ey];
          const nSeg = bezierSegments(pts, 2, tol);
          if (!cur) cur = [x, y];
          for (let k = 1; k <= nSeg; k++) {
            const t = k / nSeg, mt = 1 - t;
            cur.push(mt * mt * x + 2 * mt * t * cx + t * t * ex, mt * mt * y + 2 * mt * t * cy + t * t * ey);
          }
          cur[cur.length - 2] = ex; cur[cur.length - 1] = ey;
          lastCtrlX = cx; lastCtrlY = cy;
          x = ex; y = ey;
          break;
        }
        case 'A': {
          const ex = ox + args[5], ey = oy + args[6];
          if (ex === x && ey === y) { break; } // zero-length arc is omitted per spec
          const arc = arcToCenter(x, y, args[0], args[1], args[2], args[3], args[4], ex, ey);
          if (!cur) cur = [x, y];
          if (!arc) { cur.push(ex, ey); }
          else {
            const r = Math.max(arc.rx, arc.ry);
            const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 2;
            const nSeg = Math.min(1000, Math.max(2, Math.ceil(Math.abs(arc.dtheta) / step)));
            const cphi = Math.cos(arc.phi), sphi = Math.sin(arc.phi);
            for (let k = 1; k <= nSeg; k++) {
              const th = arc.theta1 + arc.dtheta * (k / nSeg);
              const px = arc.rx * Math.cos(th), py = arc.ry * Math.sin(th);
              cur.push(arc.cx + cphi * px - sphi * py, arc.cy + sphi * px + cphi * py);
            }
            cur[cur.length - 2] = ex; cur[cur.length - 1] = ey;
          }
          x = ex; y = ey;
          break;
        }
        case 'Z':
          if (cur) {
            if (cur[cur.length - 2] !== sx || cur[cur.length - 1] !== sy) cur.push(sx, sy);
            polys.push(cur);
          }
          cur = null;
          x = sx; y = sy;
          // A command after Z without M continues from the subpath start
          cur = null;
          break;
      }
      if (C !== 'C' && C !== 'S' && C !== 'Q' && C !== 'T') { if (C !== 'M') { lastCtrlX = lastCtrlY = null; } }
      lastCmd = C;
    }
    if (cur && cur.length >= 2) polys.push(cur);
    // A lone "M x y" with nothing after it draws nothing; drop it. A subpath
    // with 2+ coincident points is kept (it plots as a dot).
    return polys.filter(p => p.length >= 4);
  }

  // ---- SVG document handling (regex based so it works in Node too) ----

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e[0] === '#') return String.fromCharCode(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
    });
  }

  function parseAttrs(str) {
    const attrs = {};
    const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(str))) attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
    return attrs;
  }

  function parseLength(v) {
    if (v == null) return null;
    const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(px|mm|cm|in|pt|pc)?\s*$/i.exec(v);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = (m[2] || 'px').toLowerCase();
    // returns value in px (CSS 96 dpi) and in mm
    const mmPer = { px: 25.4 / 96, mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 }[unit];
    return { value: n, unit, mm: n * mmPer };
  }

  // Is this element going to show ink? The app styles every path as a black
  // stroke, but honour explicit "hide me" attributes.
  function isVisible(attrs) {
    const style = attrs.style || '';
    const get = (k) => {
      const m = new RegExp('(?:^|;)\\s*' + k + '\\s*:\\s*([^;]+)').exec(style);
      return m ? m[1].trim() : attrs[k];
    };
    if (get('display') === 'none' || get('visibility') === 'hidden') return false;
    const op = get('opacity');
    if (op != null && parseFloat(op) === 0) return false;
    const stroke = get('stroke');
    const sop = get('stroke-opacity');
    if (sop != null && parseFloat(sop) === 0) return false;
    if (stroke === 'none' || stroke === 'transparent') return false;
    return true;
  }

  function parseSvgDocument(svgText) {
    const text = String(svgText || '');
    const svgTag = /<svg\b([^>]*)>/i.exec(text);
    const svgAttrs = svgTag ? parseAttrs(svgTag[1]) : {};
    let viewBox = null;
    if (svgAttrs.viewBox) {
      const v = svgAttrs.viewBox.trim().split(/[\s,]+/).map(Number);
      if (v.length === 4 && v.every(Number.isFinite)) viewBox = v;
    }
    const width = parseLength(svgAttrs.width);
    const height = parseLength(svgAttrs.height);
    if (!viewBox) viewBox = [0, 0, width ? width.value : 0, height ? height.value : 0];

    const elements = [];
    const re = /<(path|polyline|polygon|line|rect|circle|ellipse)\b([^>]*?)\/?>/gi;
    let m;
    while ((m = re.exec(text))) {
      const attrs = parseAttrs(m[2]);
      elements.push({ tag: m[1].toLowerCase(), attrs, visible: isVisible(attrs) });
    }
    return { viewBox, width, height, elements };
  }

  function elementToPathData(el) {
    const a = el.attrs;
    const num = (k) => parseFloat(a[k] || 0);
    switch (el.tag) {
      case 'path': return a.d || '';
      case 'polyline':
      case 'polygon': {
        const nums = (a.points || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
        if (nums.length < 4) return '';
        let d = 'M' + nums[0] + ' ' + nums[1];
        for (let k = 2; k + 1 < nums.length; k += 2) d += ' L' + nums[k] + ' ' + nums[k + 1];
        return el.tag === 'polygon' ? d + ' Z' : d;
      }
      case 'line': return `M${num('x1')} ${num('y1')} L${num('x2')} ${num('y2')}`;
      case 'rect': {
        const x = num('x'), y = num('y'), w = num('width'), h = num('height');
        if (!(w > 0 && h > 0)) return '';
        return `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
      }
      case 'circle': {
        const cx = num('cx'), cy = num('cy'), r = num('r');
        if (!(r > 0)) return '';
        return `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
      }
      case 'ellipse': {
        const cx = num('cx'), cy = num('cy'), rx = num('rx'), ry = num('ry');
        if (!(rx > 0 && ry > 0)) return '';
        return `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
      }
    }
    return '';
  }

  // Whole document -> { viewBox, polylines (source units), skipped }
  function svgToPolylines(svgText, tol) {
    const doc = parseSvgDocument(svgText);
    const polylines = [];
    let skipped = 0, errors = [];
    for (const el of doc.elements) {
      if (!el.visible) { skipped++; continue; }
      const d = elementToPathData(el);
      if (!d) continue;
      try {
        for (const p of flattenPathData(d, tol)) polylines.push(p);
      } catch (e) {
        errors.push(e.message);
      }
    }
    return { viewBox: doc.viewBox, width: doc.width, height: doc.height, polylines, skipped, errors };
  }

  function polylineLength(p) {
    let L = 0;
    for (let k = 2; k < p.length; k += 2) L += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
    return L;
  }

  return { parsePathData, flattenPathData, parseSvgDocument, svgToPolylines, polylineLength, arcToCenter, parseLength };
});
