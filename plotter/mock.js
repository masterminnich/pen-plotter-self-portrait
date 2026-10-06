// plotter/mock.js — FakeNextDraw: a software stand-in for a NextDraw on a serial port.
//
// Same shape as a Web Serial SerialPort (open/close/readable/writable/getInfo),
// so WebSerialManager can't tell the difference. Implements the EBB subset the
// app uses, with legacy and "future syntax" replies, a motion FIFO that blocks
// the parser when full (like the real board), simulated time, and a record of
// everything the pen drew so it can be compared with the input.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { const ns = root.PlotterLib = root.PlotterLib || {}; Object.assign(ns, factory()); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const realNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  class FakeNextDraw {
    // opts: timeScale (real ms per simulated ms; 1 = real time, 0.01 = 100x faster)
    //       stepsPerMm, travelX, travelY (mm), latencyMs (simulated per-reply), firmware
    constructor(opts) {
      opts = opts || {};
      this.timeScale = opts.timeScale === undefined ? 1 : Math.max(0.0001, opts.timeScale);
      this.stepsPerMm = opts.stepsPerMm || 80;
      this.travelX = opts.travelX || 299.97;
      this.travelY = opts.travelY || 217.93;
      this.latencyMs = opts.latencyMs === undefined ? 0.5 : opts.latencyMs;
      // extra machine time per queued move/pen command (stands in for real-world
      // overheads the estimate does not model, so calibration has something to fix)
      this.cmdOverheadMs = opts.cmdOverheadMs === undefined ? 0.3 : opts.cmdOverheadMs;
      this.firmware = opts.firmware || '3.0.3';
      this.legacyOnly = !!opts.legacyOnly;
      this.reset();
      this._open = false;
      this.ondisconnect = null;
    }

    reset() {
      this.future = false;
      this.fifoDepth = 1;
      this.fifo = [];
      this.executing = null;
      this.m1 = 0; this.m2 = 0;      // global step counters (EM/CS reset these)
      this.posX = 0; this.posY = 0;  // true carriage position, mm (never reset by EM)
      this.originX = 0; this.originY = 0;
      this.motorsOn = false;
      this.penUp = true;
      this.sc = { 4: 9720, 5: 8280, 8: 1, 11: 231, 12: 154 };
      this.vars = new Array(32).fill(0);
      this.trace = [];        // pen-down polylines, mm (true position)
      this.travel = [];       // pen-up moves [x0,y0,x1,y1]
      this._cur = null;
      this.commandLog = [];
      this.errors = [];
      this.crashes = 0;
      this.penCount = { up: 0, down: 0 };
      this.simMs = 0;
      this._rxBuf = '';
      this._lineQueue = [];
      this._debt = 0;
      this._esGen = 0;
    }

    getInfo() { return { usbVendorId: 0x04D8, usbProductId: 0xFD92 }; }

    async open() {
      if (this._open) throw new Error('Port already open');
      this._open = true;
      this._t0 = realNow();
      const self = this;
      this.readable = new ReadableStream({
        start(c) { self._rc = c; },
        cancel() { self._rc = null; },
      });
      this.writable = new WritableStream({
        async write(chunk) {
          self._rxBuf += new TextDecoder().decode(chunk);
          let i;
          while ((i = self._rxBuf.indexOf('\r')) >= 0) {
            const line = self._rxBuf.slice(0, i).replace(/\n/g, '').trim();
            self._rxBuf = self._rxBuf.slice(i + 1);
            if (line) self._lineQueue.push(line);
          }
          self._kickParser();
          // USB back-pressure: don't accept more while the parser is backed up
          while (self._open && self._lineQueue.length > 8) await self._waitChange();
        },
      });
      this._parserRunning = false;
      this._execRunning = false;
    }

    async close() {
      this._open = false;
      try { this._rc && this._rc.close(); } catch (e) {}
      this._rc = null;
      this._notify();
    }

    // Simulated machine clock in ms: the time the motors and pen were busy,
    // plus the part of the current command already done. Host-side delays
    // (browser busy, paused) don't count, so a fast simulation still reports
    // the time a perfectly fed NextDraw would take.
    clock() {
      let t = this.simMs;
      const it = this.executing;
      if (it && it.realStart !== undefined && it.dur) t += Math.min(it.dur, (realNow() - it.realStart) / this.timeScale);
      return t;
    }

    // ---- internal plumbing ----
    _waitChange() { return new Promise(r => { (this._waiters = this._waiters || []).push(r); }); }
    _notify() { const w = this._waiters || []; this._waiters = []; for (const r of w) r(); }
    async _sleepSim(ms) {
      // batch small sleeps so very fast time scales don't drown in timers
      this._debt += ms * this.timeScale;
      if (this._debt >= 4) { const d = this._debt; this._debt = 0; await new Promise(r => setTimeout(r, d)); }
      else await Promise.resolve();
    }
    _reply(text) {
      if (!this._rc) return;
      try { this._rc.enqueue(new TextEncoder().encode(text)); } catch (e) {}
    }
    _respond(name, data, legacyText) {
      if (this.future) this._reply(data !== undefined && data !== null ? `${name},${data}\n` : `${name}\n`);
      else this._reply(legacyText !== undefined ? legacyText : 'OK\r\n');
    }
    _error(name, msg) {
      this.errors.push(`${name}: ${msg}`);
      if (this.future) this._reply(`${name},!${msg}\n`);
      else this._reply(`!${msg}\r\n`);
    }

    _kickParser() {
      if (this._parserRunning) return;
      this._parserRunning = true;
      (async () => {
        try {
          while (this._open && this._lineQueue.length) {
            const line = this._lineQueue.shift();
            this._notify();
            await this._handle(line);
            if (this.latencyMs) await this._sleepSim(this.latencyMs);
          }
        } finally { this._parserRunning = false; }
        if (this._open && this._lineQueue.length) this._kickParser();
      })();
    }

    _kickExec() {
      if (this._execRunning) return;
      this._execRunning = true;
      (async () => {
        try {
          while (this._open && this.fifo.length) {
            const item = this.fifo.shift();
            this.executing = item;
            this._notify();
            await this._execute(item);
            this.executing = null;
            this._notify();
          }
        } finally { this._execRunning = false; }
      })();
    }

    async _enqueue(item) {
      // A full FIFO blocks the parser (and so every later command) — like the EBB.
      while (this._open && this.fifo.length >= this.fifoDepth) await this._waitChange();
      if (item.gen !== undefined && item.gen !== this._esGen) return; // flushed by ES while waiting
      this.fifo.push(item);
      this._kickExec();
    }

    _xyFromSteps(m1, m2) {
      return [(m1 + m2) / (2 * this.stepsPerMm), (m1 - m2) / (2 * this.stepsPerMm)];
    }

    _moveTo(d1, d2, frac) {
      const a = Math.round(d1 * frac), b = Math.round(d2 * frac);
      this.m1 += a; this.m2 += b;
      const [dx, dy] = this._xyFromSteps(a, b);
      const x0 = this.posX, y0 = this.posY;
      this.posX += dx; this.posY += dy;
      if (this.posX < -0.05 || this.posY < -0.05 || this.posX > this.travelX + 0.05 || this.posY > this.travelY + 0.05) {
        this.crashes++;
      }
      if (!this.penUp) {
        if (!this._cur) { this._cur = [x0, y0]; this.trace.push(this._cur); }
        this._cur.push(this.posX, this.posY);
      } else {
        this.travel.push([x0, y0, this.posX, this.posY]);
      }
    }

    async _execute(item) {
      if (item.type === 'move') {
        if (!this.motorsOn) { this.motorsOn = true; }
        item.realStart = realNow();
        await this._sleepSim(item.dur);
        if (item.cancelled) return;
        this.simMs += item.dur + this.cmdOverheadMs;
        this._moveTo(item.d1, item.d2, 1);
      } else if (item.type === 'pen') {
        const wasUp = this.penUp;
        this.penUp = item.up;
        if (item.up) { this.penCount.up++; this._cur = null; }
        else { this.penCount.down++; if (wasUp || !this._cur) { this._cur = [this.posX, this.posY]; this.trace.push(this._cur); } }
        await this._sleepSim(item.dur);
        this.simMs += item.dur + this.cmdOverheadMs;
      } else if (item.type === 'enable') {
        this.motorsOn = item.on;
        this.m1 = 0; this.m2 = 0;
      } else if (item.type === 'home') {
        const d1 = -this.m1, d2 = -this.m2;
        const dur = Math.max(Math.abs(d1), Math.abs(d2)) / item.rate * 1000 + 5;
        await this._sleepSim(dur);
        if (item.cancelled) return;
        this.simMs += dur;
        this._moveTo(d1, d2, 1);
      }
    }

    async _handle(line) {
      this.commandLog.push(line);
      const parts = line.split(',');
      const name = parts[0].toUpperCase();
      const num = (i, d) => (parts[i] === undefined || parts[i] === '' ? d : Number(parts[i]));
      switch (name) {
        case 'V':
          if (this.future) this._reply(`V,EBBv13_and_above EB Firmware Version ${this.firmware}\n`);
          else this._reply(`EBBv13_and_above EB Firmware Version ${this.firmware}\r\n`);
          return;
        case 'CU': {
          const p = num(1), v = num(2);
          if (p === 10) {
            if (this.legacyOnly) { this._reply('OK\r\n'); return; }
            const was = this.future;
            this.future = v === 1;
            if (!was && this.future) this._reply('\n');
            else if (was && !this.future) this._reply('CUOK\r\n');
            else this._respond('CU');
            return;
          }
          if (p === 4) {
            if (!(v >= 1 && v <= 32)) return this._error('CU', '3 Err: Parameter outside allowed range');
            this.fifoDepth = v;
          }
          return this._respond('CU');
        }
        case 'SC': {
          this.sc[num(1)] = num(2);
          return this._respond('SC');
        }
        case 'SR': case 'SL': case 'PO': case 'PD':
          if (name === 'SL') this.vars[num(2, 0)] = num(1);
          return this._respond(name);
        case 'QL': return this._respond('QL', this.vars[num(1, 0)], `${this.vars[num(1, 0)]}\r\nOK\r\n`);
        case 'QT': return this._respond('QT', 'FakeNextDraw', 'FakeNextDraw\r\nOK\r\n');
        case 'QE': { const s = this.motorsOn ? 16 : 0; return this._respond('QE', `${s},${s}`, `${s},${s}\r\nOK\r\n`); }
        case 'QU': return this._respond('QU', this.fifoDepth, `${this.fifoDepth}\r\nOK\r\n`);
        case 'R': this.fifo = []; this.future = false; return this._reply(this.future ? 'R\n' : 'OK\r\n');
        case 'SP': {
          const v = num(1), dur = num(2, 0);
          if (![0, 1, 2, 3].includes(v)) return this._error('SP', '3 Err: Parameter outside allowed range');
          if (v === 2 || v === 3) {
            this.penUp = true; this._cur = null; this.penCount.up++;
            return this._respond('SP');
          }
          await this._enqueue({ type: 'pen', up: v === 1, dur, gen: this._esGen });
          return this._respond('SP');
        }
        case 'SM': case 'XM': {
          const dur = num(1), a = num(2, 0), b = num(3, 0);
          if (!(dur >= 1) || !Number.isInteger(dur)) return this._error(name, '3 Err: Parameter outside allowed range');
          let d1 = a, d2 = b;
          if (name === 'XM') { d1 = a + b; d2 = a - b; }
          if (Math.abs(d1) / dur > 25 || Math.abs(d2) / dur > 25) return this._error(name, '0 Err: step rate > 25K steps/second');
          await this._enqueue({ type: 'move', dur: (d1 === 0 && d2 === 0) ? Math.min(dur, 100000) : dur, d1, d2, gen: this._esGen });
          return this._respond(name);
        }
        case 'HM': {
          const rate = num(1);
          if (!(rate >= 1 && rate <= 25000)) return this._error('HM', '3 Err: Parameter outside allowed range');
          // waits for previous motion to stop
          while (this._open && (this.fifo.length || this.executing)) await this._waitChange();
          await this._enqueue({ type: 'home', rate, gen: this._esGen });
          return this._respond('HM');
        }
        case 'EM': {
          const e1 = num(1, 0);
          while (this._open && this.fifo.length >= this.fifoDepth) await this._waitChange();
          await this._enqueue({ type: 'enable', on: e1 !== 0, gen: this._esGen });
          return this._respond('EM');
        }
        case 'CS': this.m1 = 0; this.m2 = 0; return this._respond('CS');
        case 'QS': return this._respond('QS', `${this.m1},${this.m2}`, `${this.m1},${this.m2}\r\nOK\r\n`);
        case 'QG': {
          let b = 0;
          if (this.penUp) b |= 16;
          if (this.executing) b |= 8;
          if (this.executing && this.executing.type !== 'pen') b |= 6;
          if (this.fifo.length) b |= 1;
          const hex = b.toString(16).toUpperCase().padStart(2, '0');
          return this._respond('QG', hex, `${hex}\r\n`);
        }
        case 'ES': {
          const interrupted = (this.fifo.length || this.executing) ? 1 : 0;
          this._esGen = (this._esGen || 0) + 1;
          for (const it of this.fifo) it.cancelled = true;
          this.fifo = [];
          if (this.executing && (this.executing.type === 'move' || this.executing.type === 'home')) {
            // stop part-way: credit the fraction of the move already done
            const it = this.executing;
            it.cancelled = true;
            const elapsed = it.realStart === undefined ? 0 : Math.min(1, Math.max(0, (realNow() - it.realStart) / ((it.dur || 1) * this.timeScale)));
            if (it.type === 'move') this._moveTo(it.d1, it.d2, elapsed);
          }
          if (num(1, 0) === 1) this.motorsOn = false;
          this._notify();
          return this._respond('ES', interrupted, `${interrupted}\r\nOK\r\n`);
        }
        default:
          return this._error(name, '8 Err: Unknown command');
      }
    }

    // ---- helpers for tests / the UI ----
    get position() { return { x: this.posX, y: this.posY, m1: this.m1, m2: this.m2 }; }

    // Render the pen trace into an SVG string (mm units)
    traceSvg(width, height, opts) {
      opts = opts || {};
      const f = (n) => n.toFixed(2);
      const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(width)} ${f(height)}" width="100%" height="100%">`];
      parts.push(`<rect x="0" y="0" width="${f(width)}" height="${f(height)}" fill="#f4f4f4" stroke="#bbb" stroke-width="0.5"/>`);
      if (opts.paperRect) {
        const r = opts.paperRect;
        parts.push(`<rect x="${f(r.x0)}" y="${f(r.y0)}" width="${f(r.x1 - r.x0)}" height="${f(r.y1 - r.y0)}" fill="#fff" stroke="#999" stroke-width="0.4" stroke-dasharray="2 2"/>`);
      }
      parts.push(`<circle cx="0" cy="0" r="3" fill="#2f7d4f"><title>home</title></circle>`);
      if (opts.showTravel) {
        let d = '';
        for (const t of this.travel) d += `M${f(t[0])} ${f(t[1])}L${f(t[2])} ${f(t[3])}`;
        parts.push(`<path d="${d}" fill="none" stroke="#e07a2f" stroke-width="0.25" stroke-dasharray="1 1"/>`);
      }
      let d = '';
      for (const p of this.trace) {
        d += `M${f(p[0])} ${f(p[1])}`;
        for (let k = 2; k < p.length; k += 2) d += `L${f(p[k])} ${f(p[k + 1])}`;
        if (p.length === 2) d += 'h0.01';
      }
      parts.push(`<path d="${d}" fill="none" stroke="#111" stroke-width="0.35" stroke-linecap="round"/>`);
      parts.push('</svg>');
      return parts.join('');
    }
  }

  // Minimal navigator.serial look-alike that hands out one FakeNextDraw
  class FakeSerial {
    constructor(device) { this.device = device; }
    async requestPort() { return this.device; }
    async getPorts() { return [this.device]; }
  }

  return { FakeNextDraw, FakeSerial };
});
