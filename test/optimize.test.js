'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { optimizePaths, mergePaths, sortPaths, simplifyPath, pathStats, pathLength } = require('../plotter/optimize.js');

// deterministic PRNG
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function randomPaths(n, seed, opts) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = r() * 200, y = r() * 250;
    const pts = [x, y];
    const k = 1 + Math.floor(r() * 5);
    for (let j = 0; j < k; j++) pts.push(pts[pts.length - 2] + (r() - 0.5) * 10, pts[pts.length - 1] + (r() - 0.5) * 10);
    out.push(pts);
  }
  if (opts && opts.chains) {
    // add chains of segments that touch end-to-start (some reversed) so merging has work to do
    for (let c = 0; c < opts.chains; c++) {
      let x = r() * 200, y = r() * 250;
      for (let s = 0; s < 6; s++) {
        const nx = x + (r() - 0.5) * 8, ny = y + (r() - 0.5) * 8;
        out.push(r() < 0.5 ? [x, y, nx, ny] : [nx, ny, x, y]);
        x = nx + (r() - 0.5) * 0.2; y = ny + (r() - 0.5) * 0.2; // small gaps < 0.5 mm
      }
    }
  }
  return out;
}

// Multiset of segments (direction-free) to prove no drawing is lost
function segmentKeys(paths) {
  const keys = [];
  for (const p of paths) for (let k = 2; k < p.length; k += 2) {
    const a = `${p[k - 2].toFixed(6)},${p[k - 1].toFixed(6)}`, b = `${p[k].toFixed(6)},${p[k + 1].toFixed(6)}`;
    keys.push(a < b ? a + '|' + b : b + '|' + a);
  }
  return keys.sort();
}

test('sort: every path appears exactly once (possibly reversed) and travel drops', () => {
  const paths = randomPaths(3000, 1);
  const sorted = sortPaths(paths, [0, 0], true);
  assert.equal(sorted.length, paths.length);
  assert.deepEqual(segmentKeys(sorted), segmentKeys(paths));
  const before = pathStats(paths, [0, 0]), after = pathStats(sorted, [0, 0]);
  assert.ok(Math.abs(before.drawMm - after.drawMm) < 1e-6, 'drawn length preserved');
  assert.ok(after.travelMm < before.travelMm * 0.2, `travel ${before.travelMm.toFixed(0)} -> ${after.travelMm.toFixed(0)}`);
});

test('sort: greedy picks the true nearest endpoint (grid search agrees with brute force)', () => {
  const paths = randomPaths(400, 7);
  const sorted = sortPaths(paths, [0, 0], true);
  // brute force greedy
  const left = paths.map((p, i) => i);
  let x = 0, y = 0;
  const bf = [];
  while (left.length) {
    let best = Infinity, bi = -1, rev = false;
    for (let j = 0; j < left.length; j++) {
      const p = paths[left[j]];
      const ds = Math.hypot(p[0] - x, p[1] - y), de = Math.hypot(p[p.length - 2] - x, p[p.length - 1] - y);
      if (ds < best) { best = ds; bi = j; rev = false; }
      if (de < best) { best = de; bi = j; rev = true; }
    }
    const p = paths[left[bi]];
    left.splice(bi, 1);
    bf.push(best);
    x = rev ? p[0] : p[p.length - 2]; y = rev ? p[1] : p[p.length - 1];
  }
  let gx = 0, gy = 0;
  sorted.forEach((p, i) => {
    const d = Math.hypot(p[0] - gx, p[1] - gy);
    assert.ok(Math.abs(d - bf[i]) < 1e-9, `step ${i}: grid ${d} vs brute ${bf[i]}`);
    gx = p[p.length - 2]; gy = p[p.length - 1];
  });
});

test('sort without reversal keeps directions', () => {
  const paths = randomPaths(200, 3);
  const sorted = sortPaths(paths, [0, 0], false);
  const starts = new Set(paths.map(p => p[0] + ',' + p[1]));
  for (const p of sorted) assert.ok(starts.has(p[0] + ',' + p[1]));
});

test('merge: joins touching paths with reversal, loses nothing, adds at most the gaps', () => {
  const paths = randomPaths(500, 11, { chains: 200 });
  const tol = 0.5;
  const m = mergePaths(paths, tol, true);
  assert.ok(m.paths.length < paths.length, `${paths.length} -> ${m.paths.length}`);
  assert.equal(paths.length - m.paths.length, m.merges);
  const L0 = paths.reduce((s, p) => s + pathLength(p), 0);
  const L1 = m.paths.reduce((s, p) => s + pathLength(p), 0);
  assert.ok(L1 >= L0 - 1e-6, 'never shorter');
  assert.ok(L1 <= L0 + m.merges * tol + 1e-6, 'only gap bridges added');
  // every original segment survives
  const after = new Set(segmentKeys(m.paths));
  for (const k of segmentKeys(paths)) assert.ok(after.has(k), 'segment kept ' + k);
});

test('merge: exact chain in mixed directions becomes one path', () => {
  const paths = [[0, 0, 1, 0], [2, 0, 1, 0], [2, 0, 3, 0], [4, 0, 3, 0]];
  const m = mergePaths(paths, 0.01, true);
  assert.equal(m.paths.length, 1);
  assert.equal(pathLength(m.paths[0]), 4);
  const noRev = mergePaths(paths, 0.01, false);
  assert.ok(noRev.paths.length > 1);
});

test('simplify drops collinear points, keeps corners and back-tracks', () => {
  assert.deepEqual(simplifyPath([0, 0, 1, 0, 2, 0, 3, 0, 3, 1], 0.01), [0, 0, 3, 0, 3, 1]);
  // a spike that goes back over itself must survive
  assert.deepEqual(simplifyPath([0, 0, 10, 0, 5, 0], 0.01), [0, 0, 10, 0, 5, 0]);
});

test('optimizePaths reports before/after and is fast for thousands of paths', () => {
  const paths = randomPaths(8000, 5, { chains: 500 });
  const t0 = Date.now();
  const r = optimizePaths(paths, { merge: true, mergeTol: 0.5, sort: true, reverse: true, simplifyTol: 0 });
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `took ${ms} ms`);
  assert.ok(r.after.lifts < r.before.lifts);
  assert.ok(r.after.travelMm < r.before.travelMm);
  assert.ok(r.after.drawMm >= r.before.drawMm - 1e-6);
});
