const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '../public/battle-audio.js');
const CUES_MODULE_PATH = path.join(__dirname, '../public/battle-cues.js');
const plain = value => JSON.parse(JSON.stringify(value));

function loadApi() {
  const moduleValue = { exports: {} };
  vm.runInNewContext(fs.readFileSync(MODULE_PATH, 'utf8'), {
    module: moduleValue, exports: moduleValue.exports, globalThis: {},
    Object, Array, Number, Math, TypeError, Error, Promise, Int16Array, Uint8Array, ArrayBuffer, DataView
  }, { filename: MODULE_PATH });
  return moduleValue.exports;
}

function loadCueApi() {
  const moduleValue = { exports: {} };
  vm.runInNewContext(fs.readFileSync(CUES_MODULE_PATH, 'utf8'), {
    module: moduleValue, exports: moduleValue.exports, globalThis: {},
    Object, Array, Number, Math, TypeError, Error
  }, { filename: CUES_MODULE_PATH });
  return moduleValue.exports;
}

test('BattleAudio exposes the same frozen browser UMD surface', () => {
  const browserGlobal = {};
  vm.runInNewContext(fs.readFileSync(MODULE_PATH, 'utf8'), {
    globalThis: browserGlobal,
    Object, Array, Number, Math, TypeError, Error, Promise, Int16Array, Uint8Array, ArrayBuffer, DataView
  }, { filename: MODULE_PATH });
  assert.equal(typeof browserGlobal.BattleAudio.createAudioEngine, 'function');
  assert.equal(Object.isFrozen(browserGlobal.BattleAudio), true);
});

function createTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delay) {
      const id = next++;
      pending.set(id, { callback, at: now + Number(delay) });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        now = due[1].at;
        pending.delete(due[0]);
        due[1].callback();
      }
      now = target;
    }
  };
}

function audioHarness(options = {}) {
  const timers = createTimers();
  const oscillators = [];
  const sources = [];
  const gains = [];
  const fetches = [];
  const states = [];
  let wakeRequests = 0;
  const wake = { released: 0, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, release() { this.released += 1; } };

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 10;
      this.destination = {};
      this.closed = 0;
      this.resumeCalls = 0;
      this.deferResume = false;
    }
    resume() { this.resumeCalls += 1; if (!this.deferResume) this.state = 'running'; return Promise.resolve(); }
    transition(state) { this.state = state; if (this.onstatechange) this.onstatechange(); }
    close() { this.closed += 1; return Promise.resolve(); }
    decodeAudioData(buffer) { return Promise.resolve({ clip: buffer.clip }); }
    createOscillator() {
      const value = {
        frequency: { value: 0 }, type: '', starts: [], stops: [], disconnected: 0,
        connect() {}, start(at) { this.starts.push(at); }, stop(at) { this.stops.push(at); }, disconnect() { this.disconnected += 1; },
        emitEnded() { if (typeof this.onended === 'function') this.onended({ type: 'ended' }); }
      };
      oscillators.push(value);
      return value;
    }
    createGain() {
      const value = {
        disconnected: 0, connect() {}, disconnect() { this.disconnected += 1; },
        gain: {
          values: [], ramps: [], cancelled: [],
          setValueAtTime(value, at) { this.values.push([value, at]); },
          exponentialRampToValueAtTime(value, at) { this.ramps.push([value, at]); },
          cancelScheduledValues(at) { this.cancelled.push(at); }
        }
      };
      gains.push(value);
      return value;
    }
    createBufferSource() {
      const value = {
        buffer: null, starts: [], stops: [], disconnected: 0,
        connect() {}, start(at) { this.starts.push(at); }, stop(at) { this.stops.push(at); }, disconnect() { this.disconnected += 1; },
        emitEnded() { if (typeof this.onended === 'function') this.onended({ type: 'ended' }); }
      };
      sources.push(value);
      return value;
    }
  }

  class FakeAudio {
    constructor() {
      this.listeners = {};
      this.paused = true;
      this.ended = false;
      this.error = null;
      this.readyState = 4;
      this.volume = 0;
      this.playCalls = 0;
      this.pauseCalls = 0;
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(value => value !== fn); }
    setAttribute() {}
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); }
    pause() { this.pauseCalls += 1; this.paused = true; }
    emit(type) { (this.listeners[type] || []).forEach(fn => fn()); }
  }

  const runtime = {
    AudioContext: FakeAudioContext,
    Audio: FakeAudio,
    document: { hidden: false, visibilityState: 'visible' },
    navigator: {
      userAgent: 'Mozilla/5.0 Android', platform: 'Linux', maxTouchPoints: 0,
      audioSession: { type: 'auto' },
      mediaSession: { metadata: null, handlers: {}, setActionHandler(name, fn) { this.handlers[name] = fn; } },
      wakeLock: { request() { wakeRequests += 1; return Promise.resolve(wake); } }
    },
    MediaMetadata: function MediaMetadata(value) { Object.assign(this, value); },
    fetch(url) {
      fetches.push(url);
      return Promise.resolve({ arrayBuffer: () => Promise.resolve({ clip: url }) });
    },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  };
  const engine = loadApi().createAudioEngine({
    language: () => 'en',
    mediaTitle: 'Kingshoter Rally',
    onStateChange(state) {
      states.push(state);
      if (options.onStateChange) options.onStateChange(state, timers);
    }
  }, runtime);
  return { engine, runtime, timers, oscillators, sources, gains, fetches, states, wake,
    wakeRequests: () => wakeRequests };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test('audio remains disabled until an explicit enable and creates one reusable graph', async () => {
  const h = audioHarness();
  assert.deepEqual(plain(h.engine.state()), {
    userEnabled: false, audioContextRunning: false, carrierAlive: false
  });
  assert.equal(h.engine.context(), null);
  h.engine.enable();
  h.engine.enable();
  await settle();

  assert.equal(h.engine.state().userEnabled, true);
  assert.equal(h.engine.context().state, 'running');
  assert.equal(h.engine.carrier().playCalls, 2, 'repeat enable resumes one carrier instead of creating a second one');
  assert.equal(h.wakeRequests(), 1, 'repeat enable coalesces one pending Wake Lock request');
  assert.match(h.engine.carrier().src, /^data:audio\/wav;base64,/);
  assert.equal(h.runtime.navigator.audioSession.type, 'playback');
  assert.equal(h.runtime.navigator.mediaSession.metadata.title, 'Kingshoter Rally');
  assert.deepEqual(h.fetches.sort(), ['en', 'zh'].flatMap(language =>
    ['1', '2', '3', '4', '5', 'go'].map(name => `/sfx/${language}_${name}.mp3`)).sort());
});

test('unchanged ensure, resume, and full cue scheduling do not postpone the 900ms publisher', async () => {
  let armed = false;
  let publisherTimer = 0;
  let published = 0;
  const h = audioHarness({
    onStateChange(_state, timers) {
      if (!armed) return;
      if (publisherTimer) timers.clearTimeout(publisherTimer);
      publisherTimer = timers.setTimeout(() => { published += 1; }, 900);
    }
  });
  h.engine.enable();
  await settle();
  h.engine.carrier().emit('playing');
  const stateCount = h.states.length;
  armed = true;
  publisherTimer = h.timers.setTimeout(() => { published += 1; }, 900);

  h.timers.advance(300);
  h.engine.ensure();
  h.timers.advance(300);
  h.engine.resume();
  h.timers.advance(100);
  [10, 9, 8, 7, 6].forEach((name, index) =>
    h.engine.schedule({ kind: 'tick', name: String(name) }, 20 + index));
  [5, 4, 3, 2, 1].forEach((name, index) =>
    h.engine.schedule({ kind: 'countdown', name: String(name), language: 'en' }, 25 + index));
  h.engine.schedule({ kind: 'go', language: 'en' }, 30);
  h.timers.advance(200);

  assert.equal(published, 1, 'the original 900ms readiness deadline remains intact');
  assert.equal(h.states.length, stateCount, 'unchanged audio operations emit no fake state edges');
});

test('carrier health tolerates an 80ms loop gap and pause recovers after 250ms', async () => {
  const h = audioHarness();
  h.engine.enable();
  await settle();
  const carrier = h.engine.carrier();
  carrier.emit('playing');
  assert.equal(h.engine.state().carrierAlive, true);

  carrier.readyState = 1;
  carrier.emit('waiting');
  h.timers.advance(79);
  assert.equal(h.engine.state().carrierAlive, true);
  carrier.readyState = 4;
  carrier.emit('playing');
  h.timers.advance(1);
  assert.equal(h.engine.state().carrierAlive, true);

  carrier.paused = true;
  carrier.emit('pause');
  assert.equal(h.engine.state().carrierAlive, false);
  h.timers.advance(249);
  assert.equal(carrier.playCalls, 1);
  h.timers.advance(1);
  await settle();
  assert.equal(carrier.playCalls, 2);
});

test('persistent waiting and stalled carrier events use the exact 80ms health boundary', async () => {
  const h = audioHarness();
  h.engine.enable();
  await settle();
  const carrier = h.engine.carrier();
  carrier.emit('playing');

  carrier.readyState = 2;
  carrier.emit('waiting');
  h.timers.advance(79);
  assert.equal(h.engine.state().carrierAlive, true);
  h.timers.advance(1);
  assert.equal(h.engine.state().carrierAlive, false, 'readyState 2 is unhealthy after 80ms');

  carrier.readyState = 4;
  carrier.emit('playing');
  carrier.readyState = 3;
  carrier.emit('stalled');
  h.timers.advance(80);
  assert.equal(h.engine.state().carrierAlive, true, 'readyState 3 remains playable at the boundary');
});

test('pause, ended, and error synchronously turn red and cancel a pending loss check', async () => {
  const h = audioHarness();
  h.engine.enable();
  await settle();
  const carrier = h.engine.carrier();

  for (const eventName of ['error', 'ended']) {
    carrier.readyState = 1;
    carrier.emit('waiting');
    assert.equal(h.timers.pending.size, 1);
    carrier.emit(eventName);
    assert.equal(h.engine.state().carrierAlive, false, eventName);
    assert.equal(h.timers.pending.size, 0, `${eventName} cancels the pending 80ms loss check`);
    carrier.readyState = 4;
    carrier.emit('playing');
  }

  carrier.readyState = 1;
  carrier.emit('stalled');
  carrier.paused = true;
  carrier.emit('pause');
  assert.equal(h.engine.state().carrierAlive, false, 'pause is synchronous');
  assert.equal(h.timers.pending.size, 1, 'only the 250ms recovery remains after pause');
  h.timers.advance(250);
  await settle();
  assert.equal(carrier.playCalls, 2);
});

test('AudioContext suspended and running transitions immediately reproject engine readiness', async () => {
  const h = audioHarness();
  h.engine.enable();
  await settle();
  const context = h.engine.context();
  const carrier = h.engine.carrier();
  carrier.emit('playing');
  context.deferResume = true;

  context.transition('suspended');
  assert.equal(context.resumeCalls, 1);
  assert.equal(h.engine.state().audioContextRunning, false);
  assert.equal(h.states.at(-1).audioContextRunning, false, 'adapter callback receives red immediately');

  context.transition('running');
  assert.equal(h.engine.state().audioContextRunning, true);
  assert.equal(h.states.at(-1).audioContextRunning, true, 'adapter callback receives recovery immediately');
});

test('the exact Rally cue grammar is shared without changing its frequencies or clips', async () => {
  const h = audioHarness();
  h.engine.enable();
  await settle();

  const tick = h.engine.schedule({ kind: 'tick' }, 20);
  const five = h.engine.schedule({ kind: 'countdown', name: '5', language: 'en' }, 21);
  const go = h.engine.schedule({ kind: 'go', language: 'en' }, 22);
  const prepare = h.engine.schedule({ kind: 'prepare' }, 23);

  assert.equal(tick.length, 1);
  assert.equal(tick[0].o.frequency.value, 740);
  assert.equal(five.length, 1);
  assert.equal(five[0].o.buffer.clip, '/sfx/en_5.mp3');
  assert.deepEqual(plain(go.map(node => node.o.frequency && node.o.frequency.value || 'clip')), ['clip', 1320, 1760]);
  assert.deepEqual(plain(prepare.map(node => [node.o.frequency.value, node.o.starts[0]])), [[587, 23], [784, 23.18]]);
});

test('a partially constructed multi-node cue rolls back before a clean scheduler retry', async () => {
  const h = audioHarness();
  h.engine.enable();
  await settle();
  const context = h.engine.context();
  const originalCreateOscillator = context.createOscillator.bind(context);
  const constructionError = new Error('second oscillator failed');
  let oscillatorAttempts = 0;
  context.createOscillator = function () {
    oscillatorAttempts += 1;
    if (oscillatorAttempts === 2) throw constructionError;
    return originalCreateOscillator();
  };
  const registry = {};
  const errors = [];
  const scheduler = loadCueApi().createCueScheduler({
    audio: h.engine,
    registry,
    nowMs: () => 100_000,
    onError: error => errors.push(error)
  });
  const plan = {
    id: 'transactional-go', targetAtMs: 110_000,
    events: [{ id: '0', offsetMs: 0, kind: 'go', language: 'en' }]
  };

  assert.equal(scheduler.reconcile([plan]), 0);
  const failedSources = h.sources.slice();
  const failedOscillators = h.oscillators.slice();
  const failedGains = h.gains.slice();
  context.createOscillator = originalCreateOscillator;
  assert.equal(scheduler.reconcile([plan]), 1);

  assert.deepEqual(errors, [constructionError], 'the original construction failure is rethrown unchanged');
  assert.deepEqual(Object.keys(registry), ['transactional-go:0']);
  assert.equal(registry['transactional-go:0'].nodes.length, 3);
  assert.ok(failedSources.every(node => node.stops.includes(0) && node.disconnected === 1));
  assert.ok(failedOscillators.every(node => node.stops.includes(0) && node.disconnected === 1));
  assert.ok(failedGains.every(node => node.disconnected === 1));
  assert.ok(registry['transactional-go:0'].nodes.every(node =>
    !failedSources.includes(node.o) && !failedOscillators.includes(node.o) && !failedGains.includes(node.g)));
});

test('fire alert preserves the legacy 880Hz envelope exactly', async () => {
  const h = audioHarness();
  h.engine.enable();
  await settle();

  const nodes = h.engine.playFire();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].o.frequency.value, 880);
  assert.deepEqual(plain(nodes[0].g.gain.values), [[0.001, 10]]);
  assert.deepEqual(plain(nodes[0].g.gain.ramps), [[0.4, 10.02], [0.001, 10.5]]);
  assert.deepEqual(plain(nodes[0].o.starts), [10]);
  assert.deepEqual(plain(nodes[0].o.stops), [10.5]);
});

test('fire alert stays silent and creates no oscillator while AudioContext is suspended', async () => {
  const h = audioHarness();
  h.engine.enable();
  await settle();
  const context = h.engine.context();
  context.deferResume = true;
  context.transition('suspended');
  const before = h.oscillators.length;

  const nodes = h.engine.playFire();
  assert.equal(Array.isArray(nodes), true);
  assert.equal(nodes.length, 0);
  assert.equal(h.oscillators.length, before);
});

test('confirm and cancelled tones pre-schedule before an asynchronous resume completes', async () => {
  const h = audioHarness();
  h.engine.enable();
  await settle();
  const context = h.engine.context();
  context.deferResume = true;
  context.transition('suspended');

  const confirm = h.engine.playConfirm();
  const cancelled = h.engine.playCancelled();
  assert.equal(context.state, 'suspended');
  assert.equal(confirm.length, 2);
  assert.equal(cancelled.length, 2);
  assert.deepEqual(plain(confirm.map(node => node.o.starts[0])), [10, 10.15]);
  assert.deepEqual(plain(cancelled.map(node => node.o.starts[0])), [10, 10.2]);

  context.transition('running');
  assert.equal(h.engine.state().audioContextRunning, true);
  assert.ok([...confirm, ...cancelled].every(node => node.o.starts.length === 1));
});

test('naturally ended immediate nodes disconnect and are not stopped again on dispose', async () => {
  const h = audioHarness();
  h.engine.enable();
  await settle();
  const nodes = [
    ...h.engine.playConfirm(),
    ...h.engine.playCancelled(),
    ...h.engine.playFire()
  ];
  nodes.forEach(node => node.o.emitEnded());
  assert.ok(nodes.every(node => node.o.disconnected === 1));
  assert.ok(nodes.every(node => node.g.disconnected === 1));
  const stopCounts = nodes.map(node => node.o.stops.length);

  h.engine.dispose();
  assert.deepEqual(nodes.map(node => node.o.stops.length), stopCounts,
    'natural completion removes nodes from engine ownership');
});

test('cancellation silences future nodes and dispose releases every owned resource', async () => {
  const h = audioHarness();
  h.engine.enable();
  await h.engine.requestWakeLock();
  await settle();
  const nodes = h.engine.schedule({ kind: 'go', language: 'en' }, 22);
  h.engine.cancel(nodes);
  assert.ok(nodes.every(node => node.g.gain.cancelled.includes(0)));
  assert.ok(nodes.every(node => node.o.stops.includes(0)));

  const context = h.engine.context();
  const carrier = h.engine.carrier();
  h.engine.dispose();
  await settle();
  assert.equal(context.closed, 1);
  assert.equal(carrier.pauseCalls, 1);
  assert.equal(h.wake.released, 1);
  assert.deepEqual(plain(h.engine.state()), {
    userEnabled: false, audioContextRunning: false, carrierAlive: false
  });
  assert.equal(h.timers.pending.size, 0);
  assert.throws(() => h.engine.enable(), /disposed/);
});
