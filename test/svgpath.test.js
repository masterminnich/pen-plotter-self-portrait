'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePathData, flattenPathData, svgToPolylines, polylineLength, parseSvgDocument } = require('../plotter/svgpath.js');

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);
function distToPolyline(p, x, y) {
  let best = Infinity;
  for (let k = 2; k < p.length; k += 2) {
    const ax = p[k - 2], ay = p[k - 1], dx = p[k] - ax, dy = p[k + 1] - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}
const last = (p) => [p[p.length - 2], p[p.length - 1]];

test('parser: implicit repeats, compact numbers, arc flags', () => {
  const c = parsePathData('M1-2.5.5 3L3,4 5 6m1 1 2 2z');
  assert.deepEqual(c.map(x => x.cmd), ['M', 'L', 'L', 'L', 'm', 'l', 'z']);
  assert.deepEqual(c[0].args, [1, -2.5]);
  assert.deepEqual(c[1].args, [0.5, 3]);
  const a = parsePathData('M0 0a5 5 0 1010 0');
  assert.deepEqual(a[1].args, [5, 5, 0, 1, 0, 10, 0]);
  const e = parsePathData('M1e1-2E-1');
  assert.deepEqual(e[0].args, [10, -0.2]);
  assert.throws(() => parsePathData('10 10'));
});

test('M/L/H/V absolute and relative', () => {
  const [p] = flattenPathData('M10 10 L20 10 H30 V20 l-10 0 h-5 v-5', 0.1);
  assert.deepEqual(p, [10, 10, 20, 10, 30, 10, 30, 20, 20, 20, 15, 20, 15, 15]);
});

test('Z closes and the next command starts from the subpath start', () => {
  const polys = flattenPathData('M0 0 L10 0 L10 10 Z l5 5', 0.1);
  assert.equal(polys.length, 2);
  assert.deepEqual(polys[0], [0, 0, 10, 0, 10, 10, 0, 0]);
  assert.deepEqual(polys[1], [0, 0, 5, 5]);
  // relative m after z is relative to the subpath start
  const q = flattenPathData('M10 10 h5 z m1 1 h1', 0.1);
  assert.deepEqual(q[1], [11, 11, 12, 11]);
});

test('multiple subpaths become separate polylines', () => {
  const polys = flattenPathData('M0 0 L1 1 M5 5 L6 6 M9 9', 0.1);
  assert.equal(polys.length, 2);
});

test('cubic C and smooth S stay within tolerance of the true curve', () => {
  const tol = 0.01;
  const [p] = flattenPathData('M0 0 C0 10 10 10 10 0 S20 -10 20 0', tol);
  assert.deepEqual(last(p), [20, 0]);
  // true midpoint of first cubic at t=.5 is (5, 7.5)
  assert.ok(distToPolyline(p, 5, 7.5) <= tol + 1e-9, 'passes within tol of the true curve midpoint');
  // smooth reflection: second curve's control 1 = (10,-10) -> dips below 0
  let minY = Infinity;
  for (let k = 0; k < p.length; k += 2) if (p[k] > 10) minY = Math.min(minY, p[k + 1]);
  close(minY, -7.5, 0.05, 'S reflected control point');
  // relative c
  const [r] = flattenPathData('M10 10 c0 10 10 10 10 0', tol);
  assert.deepEqual(last(r), [20, 10]);
});

test('quadratic Q and smooth T', () => {
  const [p] = flattenPathData('M0 0 Q5 10 10 0 T20 0', 0.01);
  assert.deepEqual(last(p), [20, 0]);
  let maxY = -Infinity, minY = Infinity;
  for (let k = 0; k < p.length; k += 2) { maxY = Math.max(maxY, p[k + 1]); minY = Math.min(minY, p[k + 1]); }
  close(maxY, 5, 0.02, 'Q apex');
  close(minY, -5, 0.02, 'T reflected apex');
  const [r] = flattenPathData('M0 0 q5 10 10 0 t10 0', 0.01);
  assert.deepEqual(last(r), [20, 0]);
});

test('arcs: the app\'s circle idiom (two relative half-arcs) gives a full circle', () => {
  const r = 3, tol = 0.001;
  const [p] = flattenPathData(`M ${10 - r} 10 a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`, tol);
  for (let k = 0; k < p.length; k += 2) close(Math.hypot(p[k] - 10, p[k + 1] - 10), r, 0.002, 'on circle');
  close(polylineLength(p), 2 * Math.PI * r, 0.01, 'circumference');
  assert.deepEqual(last(p), [10 - r, 10]);
});

test('arcs: absolute A with sweep flags, rotation and out-of-range radii', () => {
  // Blueprint/Invaders use A for hearts: semicircle above the chord with sweep=1
  const [p] = flattenPathData('M0 0 A5 5 0 0 1 10 0', 0.001);
  let minY = Infinity;
  for (let k = 0; k < p.length; k += 2) minY = Math.min(minY, p[k + 1]);
  close(minY, -5, 0.01, 'sweep=1 goes through y<0 (screen up)');
  const [q] = flattenPathData('M0 0 A5 5 0 0 0 10 0', 0.001);
  let maxY = -Infinity;
  for (let k = 0; k < q.length; k += 2) maxY = Math.max(maxY, q[k + 1]);
  close(maxY, 5, 0.01, 'sweep=0 the other way');
  // radii too small are scaled up (spec F.6.6)
  const [s] = flattenPathData('M0 0 A1 1 0 0 1 10 0', 0.001);
  close(polylineLength(s), Math.PI * 5, 0.02, 'scaled radius semicircle');
  // rotated ellipse ends at its endpoint
  const [t] = flattenPathData('M0 0 A10 5 30 1 1 10 10', 0.01);
  assert.deepEqual(last(t), [10, 10]);
  // zero radius = straight line
  const [u] = flattenPathData('M0 0 A0 5 0 0 1 10 0', 0.01);
  assert.deepEqual(u, [0, 0, 10, 0]);
});

test('dots: zero-length subpaths are kept (plotted as a dot), bare M is dropped', () => {
  const polys = flattenPathData('M 5 5 h 0.1 M 7 7 h 0 M 9 9', 0.1);
  assert.equal(polys.length, 2);
});

test('svg document: viewBox, visibility, multiple element types, entity-encoded newlines', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
    <path d="M 1 1&#10;L 2 2" fill="none" stroke="#000"/>
    <path d='M 3 3 L 4 4' opacity="0"/>
    <path d="M 5 5 L 6 6" stroke="none"/>
    <polyline points="0,0 10,0 10,10"/>
    <polygon points="0 0 5 0 5 5"/>
    <line x1="1" y1="2" x2="3" y2="4"/>
    <rect x="0" y="0" width="5" height="5"/>
    <circle cx="10" cy="10" r="2"/>
  </svg>`;
  const doc = parseSvgDocument(svg);
  assert.deepEqual(doc.viewBox, [0, 0, 640, 480]);
  const res = svgToPolylines(svg, 0.05);
  assert.equal(res.skipped, 2);
  assert.equal(res.polylines.length, 6);
  assert.deepEqual(res.polylines[0], [1, 1, 2, 2]);
  assert.equal(res.errors.length, 0);
});
