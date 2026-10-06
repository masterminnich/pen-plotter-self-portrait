// plotter/serial.js — WebSerialManager: talks EBB to a NextDraw over Web Serial.
//
// Works with a real SerialPort (Chrome/Edge) or anything with the same shape
// (open/close/readable/writable), e.g. the FakeNextDraw in plotter/mock.js.
//
// Replies: after "CU,10,1" ("future syntax") every command gets exactly one
// line back. Legacy replies (OK\r\n, data + OK) are also understood, in case
// the board ignores CU,10. Commands are matched to replies strictly in order.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { const ns = root.PlotterLib = root.PlotterLib || {}; Object.assign(ns, factory()); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Legacy-mode reply shapes
  const LEGACY_ONE_LINE = new Set(['V', 'QG', 'QB', 'QM', 'QP', 'QR']);
  const LEGACY_DATA_THEN_OK = new Set(['QS', 'QE', 'QL', 'QU', 'ES', 'QC', 'QT', 'I', 'A', 'PI', 'MR']);

  class Emitter {
    constructor() { this._l = {}; }
    on(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); return () => this.off(ev, fn); }
    off(ev, fn) { this._l[ev] = (this._l[ev] || []).filter(f => f !== fn); }
    emit(ev, data) { for (const f of (this._l[ev] || []).slice()) { try { f(data); } catch (e) { console.error(e); } } }
  }

  class WebSerialManager extends Emitter {
    constructor(opts) {
      super();
      opts = opts || {};
      this.serial = opts.serial || (typeof navigator !== 'undefined' ? navigator.serial : undefined);
      this.filters = opts.filters || [{ usbVendorId: 0x04D8, usbProductId: 0xFD92 }];
      this.timeoutMs = opts.timeoutMs || 60000;
      this.clock = opts.clock || now;
      this.port = null;
      this.writer = null;
      this.reader = null;
      this.mode = 'legacy';
      this.pending = [];        // [{name, resolve, reject, lines, timer}]
      this.rx = '';
      this.version = '';
      this.connected = false;
      this.job = null;
      this.log = [];            // recent traffic for debugging
    }

    static isSupported(nav) {
      nav = nav || (typeof navigator !== 'undefined' ? navigator : null);
      return !!(nav && nav.serial && typeof nav.serial.requestPort === 'function');
    }

    static unsupportedMessage() {
      return 'This browser can’t talk to USB serial devices. Open this page in Chrome or Edge on a desktop computer (Safari and Firefox don’t support Web Serial).';
    }

    _trace(dir, text) {
      this.log.push(dir + ' ' + text);
      if (this.log.length > 400) this.log.splice(0, this.log.length - 300);
      this.emit('traffic', { dir, text });
    }

    async connect(port) {
      if (this.connected) return;
      if (!port) {
        if (!this.serial) throw new Error(WebSerialManager.unsupportedMessage());
        port = await this.serial.requestPort({ filters: this.filters });
      }
      this.port = port;
      await port.open({ baudRate: 115200 });
      this.writer = port.writable.getWriter();
      this.connected = true;
      this._readLoop();
      this.port.ondisconnect = () => this._lost('The plotter was unplugged.');
      try {
        // Switch to "future syntax": one reply line per command. In legacy mode
        // the reply is a bare newline; in future mode it may be "CU". Discard either.
        await this._write('CU,10,1');
        await sleep(150);
        this.rx = '';
        this.mode = 'future';
        const v = await this.command('V', { timeoutMs: 3000, raw: true });
        this.version = v.replace(/^V,/, '');
        if (!/EBB/i.test(this.version)) throw new Error('Unexpected reply to V: ' + v);
        // Probe the reply mode with QG: future mode answers "QG,xx"
        const qg = await this.command('QG', { timeoutMs: 3000, raw: true });
        if (!/^QG,/i.test(qg)) this.mode = 'legacy';
        try { await this.command('CU,4,16'); } catch (e) { /* older firmware: 1-deep FIFO, still works */ }
      } catch (e) {
        await this.disconnect().catch(() => {});
        throw e;
      }
      this.emit('connected', { version: this.version, mode: this.mode });
    }

    async disconnect() {
      const port = this.port;
      this.connected = false;
      this._failPending(new Error('Disconnected'));
      try { if (this.reader) await this.reader.cancel(); } catch (e) {}
      try { if (this.writer) { this.writer.releaseLock(); } } catch (e) {}
      try { if (port) await port.close(); } catch (e) {}
      this.port = null; this.writer = null; this.reader = null;
      this.emit('disconnected', {});
    }

    _lost(msg) {
      if (!this.connected) return;
      this.connected = false;
      this._failPending(new Error(msg));
      this.emit('error', { message: msg });
      this.emit('disconnected', { message: msg });
    }

    _failPending(err) {
      const p = this.pending; this.pending = [];
      for (const c of p) { clearTimeout(c.timer); c.reject(err); }
    }

    async _readLoop() {
      const dec = new TextDecoder();
      try {
        this.reader = this.port.readable.getReader();
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this._onData(dec.decode(value, { stream: true }));
        }
      } catch (e) {
        if (this.connected) this._lost('Lost connection to the plotter: ' + e.message);
      } finally {
        try { this.reader && this.reader.releaseLock(); } catch (e) {}
      }
    }

    _onData(text) {
      this.rx += text;
      const parts = this.rx.split(/\r\n|\n\r|\r|\n/);
      this.rx = parts.pop();
      for (const line of parts) {
        const l = line.trim();
        if (!l) continue;
        this._onLine(l);
      }
    }

    _onLine(line) {
      this._trace('<', line);
      const c = this.pending[0];
      if (!c) { this.emit('stray', line); return; }
      if (this.mode === 'future' && !c.raw) {
        if (!line.toUpperCase().startsWith(c.name)) { this.emit('stray', line); return; }
        this._finish(c, line);
        return;
      }
      if (c.raw) { this._finish(c, line); return; }
      // legacy mode
      if (line.startsWith('!')) { this._finish(c, line); return; }
      if (LEGACY_ONE_LINE.has(c.name)) { this._finish(c, line); return; }
      if (LEGACY_DATA_THEN_OK.has(c.name)) {
        if (line === 'OK') { this._finish(c, c.lines.join(',')); return; }
        c.lines.push(line);
        return;
      }
      this._finish(c, line);
    }

    _finish(c, line) {
      this.pending.shift();
      clearTimeout(c.timer);
      if (/Err/i.test(line) || line.startsWith('!')) c.reject(new Error(`${c.cmd} → ${line}`));
      else c.resolve(line);
    }

    async _write(text) {
      if (!this.writer) throw new Error('Not connected');
      this._trace('>', text);
      await this.writer.write(new TextEncoder().encode(text + '\r'));
    }

    // Send one command and get a promise for its reply. Does not wait for
    // earlier commands — replies are matched in order.
    send(cmd, opts) {
      opts = opts || {};
      if (!this.connected) return Promise.reject(new Error('Not connected'));
      const name = cmd.split(',')[0].trim().toUpperCase();
      let entry;
      const p = new Promise((resolve, reject) => {
        entry = { cmd, name, resolve, reject, lines: [], raw: !!opts.raw, timer: null };
        entry.timer = setTimeout(() => {
          const i = this.pending.indexOf(entry);
          if (i >= 0) this.pending.splice(i, 1);
          reject(new Error(`No reply to ${cmd} after ${(opts.timeoutMs || this.timeoutMs) / 1000}s`));
        }, opts.timeoutMs || this.timeoutMs);
        this.pending.push(entry);
      });
      entry.promise = p;
      p.catch(() => {}); // callers handle errors; avoid unhandled-rejection noise
      const w = this._write(cmd).catch(e => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        clearTimeout(entry.timer);
        entry.reject(e);
      });
      p.written = w;
      return p;
    }

    // Wait for everything already sent, then send cmd and wait for its reply.
    async command(cmd, opts) {
      while (this.pending.length) {
        await Promise.allSettled(this.pending.map(c => c.promise));
      }
      const p = this.send(cmd, opts);
      await p.written;
      return p;
    }

    async queryStatus() {
      const r = await this.command('QG');
      const hex = r.replace(/^QG,/i, '').trim();
      const b = parseInt(hex, 16);
      return { byte: b, penUp: !!(b & 16), busy: (b & 15) !== 0 };
    }

    async waitIdle(pollMs, timeoutMs) {
      pollMs = pollMs || 50;
      const t0 = now();
      for (;;) {
        const s = await this.queryStatus();
        if (!s.busy) return s;
        if (timeoutMs && now() - t0 > timeoutMs) throw new Error('Plotter did not finish moving');
        await sleep(pollMs);
      }
    }

    async querySteps() {
      const r = await this.command('QS');
      const m = /(-?\d+)\s*,\s*(-?\d+)/.exec(r.replace(/^QS,/i, ''));
      return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
    }

    async sendAll(cmds) { for (const c of cmds) await this.command(c); }

    // ---- streaming a job ----
    // job: { lines, cumMs, kinds, penUpCmd, penDownCmd, homeCmd }
    // opts: { window, onProgress }
    writeStream(job, opts) {
      if (this.job) return Promise.reject(new Error('A plot is already running'));
      opts = opts || {};
      const windowSize = Math.max(1, opts.window || 4);
      const n = job.lines.length;
      const total = n ? job.cumMs[n - 1] : 0;
      const st = this.job = {
        state: 'running', sent: 0, acked: 0, inflight: 0, penDown: false,
        pauseReq: false, abortReq: false, wake: null, startedAt: this.clock(), pausedMs: 0, pausedAt: 0,
        error: null,
      };
      const wakeUp = () => { const w = st.wake; st.wake = null; if (w) w(); };
      const waitWake = () => new Promise(r => { st.wake = r; });
      const progress = () => {
        const done = st.acked ? job.cumMs[st.acked - 1] : 0;
        const elapsed = this.clock() - st.startedAt - st.pausedMs - (st.state === 'paused' ? this.clock() - st.pausedAt : 0);
        this.emit('progress', { state: st.state, acked: st.acked, total: n, doneMs: done, totalMs: total, fraction: total ? done / total : 1, elapsedMs: elapsed });
        if (opts.onProgress) opts.onProgress(st);
      };
      this.emit('job', { state: 'running' });

      const run = async () => {
        let lastProgress = 0;
        while (st.sent < n || st.inflight > 0) {
          if (st.abortReq || st.error || !this.connected) break;
          if (st.pauseReq && st.state === 'running') {
            // let in-flight commands land, wait for motion to stop, lift the pen
            while (st.inflight > 0 && !st.abortReq && !st.error) await waitWake();
            if (st.abortReq || st.error) break;
            await this.waitIdle(50);
            st.wasDown = st.penDown;
            if (st.penDown && job.penUpCmd) await this.command(job.penUpCmd);
            st.state = 'paused'; st.pausedAt = this.clock();
            this.emit('job', { state: 'paused' });
            progress();
            while (st.pauseReq && !st.abortReq) await waitWake();
            if (st.abortReq) break;
            if (st.wasDown && job.penDownCmd) await this.command(job.penDownCmd);
            st.pausedMs += this.clock() - st.pausedAt;
            st.state = 'running';
            this.emit('job', { state: 'running' });
            continue;
          }
          if (st.sent < n && st.inflight < windowSize && !st.pauseReq) {
            const i = st.sent++;
            const line = job.lines[i];
            const k = job.kinds[i];
            if (k === 3) st.penDown = true; else if (k === 4) st.penDown = false;
            st.inflight++;
            const p = this.send(line);
            p.then(() => { st.inflight--; st.acked++; wakeUp(); },
              (e) => { st.inflight--; if (!st.error) st.error = e; wakeUp(); });
            await p.written;
            continue;
          }
          await waitWake();
          const t = now();
          if (t - lastProgress > 100) { lastProgress = t; progress(); }
        }
        if (st.error) throw st.error;
        if (st.abortReq || !this.connected) return 'aborted';
        // everything is queued — wait for the machine to finish moving
        await this.waitIdle(50);
        return 'done';
      };

      const finish = async () => {
        let result, err = null;
        try { result = await run(); } catch (e) { err = e; result = 'error'; }
        if (result !== 'done' && this.connected) {
          // Cancel / error: stop now, lift the pen, go home
          try { await this._stopAndHome(job); } catch (e) { if (!err) err = e; }
        }
        const elapsedMs = this.clock() - st.startedAt - st.pausedMs;
        st.state = result;
        this.job = null;
        progress();
        this.emit('job', { state: result, elapsedMs, error: err ? err.message : null });
        if (err && result === 'error') throw err;
        return { result, elapsedMs };
      };
      st.promise = finish();
      st.wakeUp = wakeUp;
      return st.promise;
    }

    async _stopAndHome(job) {
      // ES flushes the FIFO; replies for already-sent lines still arrive first.
      try { await this.command('ES', { timeoutMs: 20000 }); } catch (e) { /* keep going */ }
      if (job.penUpCmd) await this.command(job.penUpCmd);
      if (job.homeCmd) await this.command(job.homeCmd);
      await this.waitIdle(50, 120000);
    }

    pause() { if (this.job && this.job.state === 'running') { this.job.pauseReq = true; this.job.wakeUp(); this.emit('job', { state: 'pausing' }); } }
    resume() { if (this.job && this.job.pauseReq) { this.job.pauseReq = false; this.job.wakeUp(); } }
    abort() { if (this.job) { this.job.abortReq = true; this.job.pauseReq = false; this.job.wakeUp(); this.emit('job', { state: 'cancelling' }); } }
    get busy() { return !!this.job; }
  }

  return { WebSerialManager, Emitter };
});
