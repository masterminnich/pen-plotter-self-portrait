'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSerialManager } = require('../plotter/serial.js');
const { FakeNextDraw, FakeSerial } = require('../plotter/mock.js');
const S = require('../plotter/settings.js');
const ebb = require('../plotter/ebb.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function setup(opts) {
  const dev = new FakeNextDraw(Object.assign({ timeScale: 0.02, latencyMs: 0 }, opts));
  const mgr = new WebSerialManager({ serial: new FakeSerial(dev), timeoutMs: 10000, clock: () => dev.clock() });
  await mgr.connect();
  return { dev, mgr };
}

function jobFor(paths, s) {
  const j = ebb.buildEbbJob(paths, s);
  const servo = j.servo;
  return Object.assign(j, {
    penUpCmd: ebb.penCmd(false, servo.raiseMs, servo, s.machine),
    penDownCmd: ebb.penCmd(true, servo.lowerMs, servo, s.machine),
    homeCmd: `HM,${s.machine.homeRate}`,
  });
}

async function prepare(mgr, s) {
  await mgr.sendAll(ebb.servoSetupCommands(s.machine));
  await mgr.command(ebb.penCmd(false, 45, S.penServo(s.machine), s.machine));
  await mgr.command('EM,1,1');
}

function squares(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = 20 + (i % 10) * 12, y = 20 + Math.floor(i / 10) * 12;
    out.push([x, y, x + 8, y, x + 8, y + 8, x, y + 8, x, y]);
  }
  return out;
}

test('connect: switches to future syntax, reads version, sets FIFO depth', async () => {
  const { dev, mgr } = await setup();
  assert.equal(mgr.mode, 'future');
  assert.match(mgr.version, /EBB.*3\.0\.3/);
  assert.equal(dev.fifoDepth, 16);
  const st = await mgr.queryStatus();
  assert.equal(st.penUp, true);
  await mgr.disconnect();
});

test('connect also works with a board that only speaks legacy replies', async () => {
  const { dev, mgr } = await setup({ legacyOnly: true });
  assert.equal(mgr.mode, 'legacy');
  assert.deepEqual(await mgr.querySteps(), [0, 0]);
  await mgr.command('SM,10,5,5');
  await mgr.waitIdle(5);
  assert.deepEqual(await mgr.querySteps(), [5, 5]);
  assert.equal(dev.errors.length, 0);
  await mgr.disconnect();
});

test('full plot through the fake NextDraw: drawing matches the input, ends at home', async () => {
  const { dev, mgr } = await setup();
  const s = S.defaultSettings();
  await prepare(mgr, s);
  const paths = squares(12);
  const job = jobFor(paths, s);
  const progress = [];
  mgr.on('progress', p => progress.push(p.fraction));
  const r = await mgr.writeStream(job, { window: 4 });
  assert.equal(r.result, 'done');
  assert.equal(dev.errors.length, 0, dev.errors.join('; '));
  assert.equal(dev.crashes, 0);
  assert.equal(dev.trace.length, paths.length);
  const tol = 1 / 80 + 1e-9;
  paths.forEach((p, i) => {
    const t = dev.trace[i];
    assert.ok(Math.hypot(t[0] - p[0], t[1] - p[1]) <= tol);
    assert.ok(Math.hypot(t[t.length - 2] - p[p.length - 2], t[t.length - 1] - p[p.length - 1]) <= tol);
  });
  assert.ok(Math.abs(dev.posX) < 1e-9 && Math.abs(dev.posY) < 1e-9, 'back home');
  assert.equal(progress[progress.length - 1], 1);
  // simulated elapsed time is close to the planned time
  const planned = job.cumMs[job.cumMs.length - 1];
  assert.ok(r.elapsedMs > planned * 0.9 && r.elapsedMs < planned * 1.6, `elapsed ${r.elapsedMs} vs planned ${planned}`);
  await mgr.disconnect();
});

test('pause lifts the pen and stops; resume lowers it and finishes the same drawing', async () => {
  const { dev, mgr } = await setup({ timeScale: 0.05 });
  const s = S.defaultSettings();
  await prepare(mgr, s);
  const paths = [[20, 20, 200, 20, 200, 150, 20, 150, 20, 20]]; // one long pen-down stroke
  const job = jobFor(paths, s);
  const states = [];
  mgr.on('job', e => states.push(e.state));
  const run = mgr.writeStream(job, { window: 4 });
  await sleep(60);
  mgr.pause();
  while (!states.includes('paused')) await sleep(5);
  const pausedAt = { x: dev.posX, y: dev.posY };
  assert.equal(dev.penUp, true, 'pen lifted while paused');
  assert.equal(dev.fifo.length, 0);
  await sleep(100);
  assert.deepEqual({ x: dev.posX, y: dev.posY }, pausedAt, 'no motion while paused');
  mgr.resume();
  const r = await run;
  assert.equal(r.result, 'done');
  assert.ok(states.includes('running'));
  // drawing is split in two strokes at the pause point but covers the whole square
  assert.equal(dev.trace.length, 2);
  const t = dev.trace;
  const end = t[1];
  assert.ok(Math.hypot(end[end.length - 2] - 20, end[end.length - 1] - 20) < 0.02);
  assert.ok(Math.hypot(t[1][0] - pausedAt.x, t[1][1] - pausedAt.y) < 1e-9, 'resumes where it stopped');
  assert.equal(dev.errors.length, 0);
  await mgr.disconnect();
});

test('cancel: emergency stop, pen up, back home', async () => {
  const { dev, mgr } = await setup({ timeScale: 0.05 });
  const s = S.defaultSettings();
  await prepare(mgr, s);
  const job = jobFor(squares(40), s);
  const run = mgr.writeStream(job, { window: 4 });
  await sleep(80);
  mgr.abort();
  const r = await run;
  assert.equal(r.result, 'aborted');
  assert.ok(dev.commandLog.includes('ES'));
  assert.equal(dev.penUp, true);
  assert.ok(Math.abs(dev.posX) < 0.02 && Math.abs(dev.posY) < 0.02, `home: ${dev.posX},${dev.posY}`);
  assert.ok(dev.trace.length < 40, 'stopped early');
  await mgr.disconnect();
});

test('cancel while paused also goes home', async () => {
  const { dev, mgr } = await setup({ timeScale: 0.05 });
  const s = S.defaultSettings();
  await prepare(mgr, s);
  const run = mgr.writeStream(jobFor(squares(30), s), { window: 4 });
  await sleep(60);
  mgr.pause();
  await sleep(150);
  mgr.abort();
  const r = await run;
  assert.equal(r.result, 'aborted');
  assert.ok(Math.abs(dev.posX) < 0.02 && Math.abs(dev.posY) < 0.02);
  await mgr.disconnect();
});

test('an error reply stops the plot and is reported', async () => {
  const { mgr } = await setup();
  const job = { lines: ['SM,10,10,10', 'SM,1,500,0', 'SM,10,10,10'], cumMs: Float64Array.from([10, 11, 21]), kinds: Uint8Array.from([2, 2, 2]), penUpCmd: 'SP,1,45,2', homeCmd: 'HM,4000' };
  await assert.rejects(mgr.writeStream(job, { window: 1 }), /step rate/);
  await mgr.disconnect();
});
