// plotter/optimize.js — path optimization for pen plotting.
//
// Paths are flat arrays [x0,y0,x1,y1,...] in mm. Three passes:
//   1. mergePaths    join paths whose endpoints are within `tol` (optionally reversing)
//   2. sortPaths     greedy nearest-neighbour ordering with direction flipping
//   3. simplifyPaths drop near-collinear points (Ramer–Douglas–Peucker, iterative)
// All use a uniform spatial grid so thousands of paths stay fast.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { const ns = root.PlotterLib = root.PlotterLib || {}; Object.assign(ns, factory()); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function pathLength(p) {
    let L = 0;
    for (let k = 2; k < p.length; k += 2) L += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
    return L;
  }

  function reversed(p) {
    const r = new Array(p.length);
    for (let k = 0, n = p.length; k < n; k += 2) { r[n - 2 - k] = p[k]; r[n - 1 - k] = p[k + 1]; }
    return r;
  }

  // Pen lifts, travel and drawn length for an ordered list of paths.
  // Travel starts at `start` and (if returnTo) goes back there at the end.
  function pathStats(paths, start, returnHome) {
    start = start || [0, 0];
    let x = start[0], y = start[1];
    let travel = 0, draw = 0, points = 0;
    for (const p of paths) {
      travel += Math.hypot(p[0] - x, p[1] - y);
      draw += pathLength(p);
      x = p[p.length - 2]; y = p[p.length - 1];
      points += p.length / 2;
    }
    if (returnHome !== false && paths.length) travel += Math.hypot(start[0] - x, start[1] - y);
    return { lifts: paths.length, travelMm: travel, drawMm: draw, points };
  }

  // ---- uniform grid of endpoints with O(1) removal ----
  class EndpointGrid {
    constructor(cell) {
      this.cell = cell;
      this.cells = new Map();
      this.where = new Map(); // id -> [key, index]
      this.count = 0;
      this.minI = Infinity; this.maxI = -Infinity; this.minJ = Infinity; this.maxJ = -Infinity;
    }
    key(i, j) { return i * 1048576 + j; }
    add(id, x, y) {
      const i = Math.floor(x / this.cell), j = Math.floor(y / this.cell);
      const k = this.key(i, j);
      let arr = this.cells.get(k);
      if (!arr) { arr = []; this.cells.set(k, arr); }
      this.where.set(id, [k, arr.length]);
      arr.push({ id, x, y });
      this.count++;
      if (i < this.minI) this.minI = i; if (i > this.maxI) this.maxI = i;
      if (j < this.minJ) this.minJ = j; if (j > this.maxJ) this.maxJ = j;
    }
    remove(id) {
      const w = this.where.get(id);
      if (!w) return;
      const arr = this.cells.get(w[0]);
      const last = arr.pop();
      if (last.id !== id) { arr[w[1]] = last; this.where.get(last.id)[1] = w[1]; }
      this.where.delete(id);
      this.count--;
    }
    // Nearest entry to (x,y) passing filter, within maxDist (Infinity allowed)
    nearest(x, y, maxDist, filter) {
      if (this.count === 0) return null;
      const c = this.cell;
      const qi = Math.floor(x / c), qj = Math.floor(y / c);
      let best = null, bestD = maxDist === undefined ? Infinity : maxDist;
      const maxR = Math.max(Math.abs(qi - this.minI), Math.abs(qi - this.maxI), Math.abs(qj - this.minJ), Math.abs(qj - this.maxJ));
      const rLimit = Number.isFinite(bestD) ? Math.min(maxR, Math.ceil(bestD / c) + 1) : maxR;
      for (let r = 0; r <= rLimit; r++) {
        for (let i = qi - r; i <= qi + r; i++) {
          if (i < this.minI || i > this.maxI) continue;
          const edge = (i === qi - r || i === qi + r);
          for (let j = qj - r; j <= qj + r; j += (edge ? 1 : 2 * r || 1)) {
            if (j < this.minJ || j > this.maxJ) continue;
            const arr = this.cells.get(this.key(i, j));
            if (!arr) continue;
            for (const e of arr) {
              const d = Math.hypot(e.x - x, e.y - y);
              if (d < bestD || (d === bestD && best && e.id < best.id)) {
                if (filter && !filter(e.id)) continue;
                bestD = d; best = e;
              }
            }
          }
        }
        if (best && bestD <= r * c) break;
      }
      return best ? { id: best.id, x: best.x, y: best.y, d: bestD } : null;
    }
  }

  function bbox(paths) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of paths) {
      for (let k = 0; k < p.length; k += 2) {
        if (p[k] < minX) minX = p[k]; if (p[k] > maxX) maxX = p[k];
        if (p[k + 1] < minY) minY = p[k + 1]; if (p[k + 1] > maxY) maxY = p[k + 1];
      }
    }
    return { minX, minY, maxX, maxY };
  }

  // ---- 1. merge ----
  // Endpoint ids: 2*i = start of path i, 2*i+1 = end of path i.
  function mergePaths(paths, tol, allowReverse) {
    tol = tol > 0 ? tol : 0;
    if (allowReverse === undefined) allowReverse = true;
    const n = paths.length;
    if (n < 2 || tol === 0) return { paths: paths.map(p => p.slice()), merges: 0 };
    const grid = new EndpointGrid(Math.max(tol, 1e-3));
    for (let i = 0; i < n; i++) {
      const p = paths[i];
      grid.add(2 * i, p[0], p[1]);
      grid.add(2 * i + 1, p[p.length - 2], p[p.length - 1]);
    }
    const used = new Uint8Array(n);
    const out = [];
    let merges = 0;
    const take = (i) => { used[i] = 1; grid.remove(2 * i); grid.remove(2 * i + 1); };

    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      take(i);
      let line = paths[i].slice();
      // extend forward from the end
      for (;;) {
        const ex = line[line.length - 2], ey = line[line.length - 1];
        const hit = grid.nearest(ex, ey, tol + 1e-12, allowReverse ? null : (id) => (id & 1) === 0);
        if (!hit) break;
        const j = hit.id >> 1;
        let q = paths[j];
        if (hit.id & 1) q = reversed(q); // matched q's end -> walk it backwards
        take(j);
        const skip = (q[0] === ex && q[1] === ey) ? 2 : 0;
        for (let k = skip; k < q.length; k++) line.push(q[k]);
        merges++;
      }
      // extend backward from the start
      for (;;) {
        const sx = line[0], sy = line[1];
        const hit = grid.nearest(sx, sy, tol + 1e-12, allowReverse ? null : (id) => (id & 1) === 1);
        if (!hit) break;
        const j = hit.id >> 1;
        let q = paths[j];
        if (!(hit.id & 1)) q = reversed(q); // matched q's start -> reverse so its end meets our start
        take(j);
        const skip = (q[q.length - 2] === sx && q[q.length - 1] === sy) ? 2 : 0;
        line = q.slice(0, q.length - skip).concat(line);
        merges++;
      }
      out.push(line);
    }
    return { paths: out, merges };
  }

  // ---- 2. sort (greedy nearest neighbour, with flipping) ----
  function sortPaths(paths, start, allowReverse) {
    if (allowReverse === undefined) allowReverse = true;
    const n = paths.length;
    if (n < 2) return paths.slice();
    const b = bbox(paths);
    const area = Math.max(1, (b.maxX - b.minX) * (b.maxY - b.minY));
    const cell = Math.max(0.5, Math.sqrt(area / n));
    const grid = new EndpointGrid(cell);
    for (let i = 0; i < n; i++) {
      const p = paths[i];
      grid.add(2 * i, p[0], p[1]);
      if (allowReverse) grid.add(2 * i + 1, p[p.length - 2], p[p.length - 1]);
    }
    const out = [];
    let x = start ? start[0] : 0, y = start ? start[1] : 0;
    while (grid.count > 0) {
      const hit = grid.nearest(x, y);
      const i = hit.id >> 1;
      grid.remove(2 * i);
      if (allowReverse) grid.remove(2 * i + 1);
      const p = (hit.id & 1) ? reversed(paths[i]) : paths[i];
      out.push(p);
      x = p[p.length - 2]; y = p[p.length - 1];
    }
    return out;
  }

  // ---- 3. simplify (RDP, iterative; keeps endpoints; tol in mm) ----
  function simplifyPath(p, tol) {
    const n = p.length / 2;
    if (n <= 2 || !(tol > 0)) return p;
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    const stack = [0, n - 1];
    while (stack.length) {
      const b = stack.pop(), a = stack.pop();
      if (b <= a + 1) continue;
      const ax = p[2 * a], ay = p[2 * a + 1], bx = p[2 * b], by = p[2 * b + 1];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      let maxD = -1, idx = -1;
      for (let k = a + 1; k < b; k++) {
        const px = p[2 * k], py = p[2 * k + 1];
        let d;
        if (len < 1e-12) d = Math.hypot(px - ax, py - ay);
        else {
          // distance to the segment (not the infinite line) so back-tracking points survive
          let t = ((px - ax) * dx + (py - ay) * dy) / (len * len);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        }
        if (d > maxD) { maxD = d; idx = k; }
      }
      if (maxD > tol) {
        keep[idx] = 1;
        stack.push(a, idx, idx, b);
      }
    }
    const out = [];
    for (let k = 0; k < n; k++) if (keep[k]) out.push(p[2 * k], p[2 * k + 1]);
    return out;
  }

  function simplifyPaths(paths, tol) {
    if (!(tol > 0)) return paths;
    return paths.map(p => simplifyPath(p, tol));
  }

  // Full pipeline. opts: { merge, mergeTol, sort, reverse, simplifyTol, start }
  function optimizePaths(paths, opts) {
    opts = opts || {};
    const start = opts.start || [0, 0];
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const before = pathStats(paths, start);
    let out = paths;
    let merges = 0;
    if (opts.simplifyTol > 0) out = simplifyPaths(out, opts.simplifyTol);
    if (opts.merge !== false && opts.mergeTol > 0) {
      const m = mergePaths(out, opts.mergeTol, opts.reverse !== false);
      out = m.paths; merges = m.merges;
    }
    if (opts.sort !== false) out = sortPaths(out, start, opts.reverse !== false);
    const after = pathStats(out, start);
    const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    return { paths: out, merges, before, after, ms };
  }

  return { optimizePaths, mergePaths, sortPaths, simplifyPaths, simplifyPath, pathStats, pathLength, reversedPath: reversed, EndpointGrid };
});
