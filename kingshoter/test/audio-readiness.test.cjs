const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test('green readiness requires both the audio clock and a playing keep-alive carrier', () => {
  const sandbox = {
    soundReady: true,
    ac: { state: 'running' },
    keepAlive: true,
    keepAudio: { paused: false, ended: false }
  };
  vm.runInNewContext(`${extractFunction('audioAlive')}\nthis.audioAlive = audioAlive;`, sandbox);

  assert.equal(sandbox.audioAlive(), true);
  sandbox.keepAlive = false;
  assert.equal(sandbox.audioAlive(), false, 'a rejected carrier play cannot stay green');
  sandbox.keepAlive = true;
  sandbox.keepAudio.paused = true;
  assert.equal(sandbox.audioAlive(), false, 'a paused carrier cannot stay green');
  sandbox.keepAudio.paused = false;
  sandbox.keepAudio.ended = true;
  assert.equal(sandbox.audioAlive(), false, 'an ended carrier cannot stay green');
  sandbox.keepAudio.ended = false;
  sandbox.ac.state = 'suspended';
  assert.equal(sandbox.audioAlive(), false, 'a suspended audio clock cannot stay green');
});

test('carrier lifecycle transitions immediately refresh canonical readiness', () => {
  const start = extractFunction('startKeepAlive');
  const resume = extractFunction('resumeAudio');
  const transition = extractFunction('setKeepAliveState');

  assert.match(start, /addEventListener\(["']playing["'],\s*carrierPlaying\)/);
  assert.match(start, /addEventListener\(["']pause["'][\s\S]*carrierStopped\(\)/);
  assert.match(start, /\[["']error["'],\s*["']ended["']\]\.forEach[\s\S]*carrierStopped/);
  assert.match(start, /\[["']waiting["'],\s*["']stalled["']\]\.forEach[\s\S]*confirmCarrierLoss/);
  assert.match(start, /KEEP_ALIVE_STALL_CONFIRM_MS/);
  assert.match(resume, /\.then\(function \(\) \{ setKeepAliveState\(true\); \}\)[\s\S]*\.catch\(function \(\) \{ setKeepAliveState\(false\); \}\)/);
  assert.match(transition, /sendDeviceStatus\(["']deviceStatus["'],\s*true\)/);
});

function carrierLifecycleHarness() {
  let nowMs = 0;
  let nextTimer = 1;
  const timers = new Map();
  const readiness = [];
  class FakeAudio {
    constructor() {
      this.paused = false;
      this.ended = false;
      this.error = null;
      this.readyState = 4;
      this.listeners = Object.create(null);
    }
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    }
    emit(type) {
      (this.listeners[type] || []).forEach(listener => listener());
    }
    play() { this.paused = false; }
    setAttribute() {}
  }
  const sandbox = {
    keepAudio: null,
    keepAlive: false,
    keepAliveStallTimer: 0,
    KEEP_ALIVE_STALL_CONFIRM_MS: 80,
    soundReady: true,
    isIOS: false,
    navigator: {},
    window: {},
    Audio: FakeAudio,
    bedURI() { return 'data:audio/wav;base64,test'; },
    bedVol() { return 0; },
    resumeAudio() {},
    paintAudioStatus() {},
    sendDeviceStatus() { readiness.push(sandbox.keepAlive); },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, at: nowMs + Number(delay) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(`${extractFunction('setKeepAliveState')}\n${extractFunction('startKeepAlive')}\nthis.startKeepAlive = startKeepAlive;`, sandbox);
  sandbox.startKeepAlive();
  readiness.length = 0;
  function advance(ms) {
    const target = nowMs + ms;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      nowMs = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    nowMs = target;
  }
  return { sandbox, audio: sandbox.keepAudio, readiness, advance };
}

test('loop-boundary waiting followed by playing within 80ms never publishes red', () => {
  const h = carrierLifecycleHarness();
  h.audio.readyState = 1;
  h.audio.emit('waiting');
  h.advance(4); // observed Chromium loop boundary gap is 0-4ms; 80ms leaves a bounded scheduling margin.
  h.audio.readyState = 4;
  h.audio.emit('playing');
  h.advance(100);
  assert.deepEqual(h.readiness, []);
  assert.equal(h.sandbox.keepAlive, true);
});

test('persistent waiting publishes red once after the 80ms carrier-loss confirmation', () => {
  const h = carrierLifecycleHarness();
  h.audio.readyState = 1;
  h.audio.emit('waiting');
  h.advance(79);
  assert.deepEqual(h.readiness, []);
  h.advance(1);
  assert.deepEqual(h.readiness, [false]);
  h.audio.emit('stalled');
  h.advance(80);
  assert.deepEqual(h.readiness, [false]);

  const stalled = carrierLifecycleHarness();
  stalled.audio.readyState = 2; // HAVE_CURRENT_DATA cannot guarantee continued playback.
  stalled.audio.emit('stalled');
  stalled.advance(80);
  assert.deepEqual(stalled.readiness, [false]);

  const buffered = carrierLifecycleHarness();
  buffered.audio.readyState = 3; // HAVE_FUTURE_DATA remains a healthy playing carrier.
  buffered.audio.emit('stalled');
  buffered.advance(80);
  assert.deepEqual(buffered.readiness, []);
});

test('pause, ended, and error synchronously publish red and cancel pending carrier loss', () => {
  for (const eventName of ['pause', 'ended', 'error']) {
    const h = carrierLifecycleHarness();
    h.audio.readyState = 1;
    h.audio.emit('waiting');
    if (eventName === 'pause') h.audio.paused = true;
    if (eventName === 'ended') h.audio.ended = true;
    if (eventName === 'error') h.audio.error = { code: 3 };
    h.audio.emit(eventName);
    assert.deepEqual(h.readiness, [false], `${eventName} is synchronous`);
    h.advance(100);
    assert.deepEqual(h.readiness, [false], `${eventName} cancels the pending check`);
  }
});

test('a suspended AudioContext immediately reports not-ready before resume completes', () => {
  function FakeAudioContext() {
    this.state = 'suspended';
    this.resume = () => {};
    this.onstatechange = null;
  }
  const statuses = [];
  const sandbox = {
    ac: null,
    AC: () => FakeAudioContext,
    window: {},
    navigator: {},
    sendDeviceStatus(type, force) { statuses.push({ type, force }); },
    paintAudioStatus() {}
  };
  vm.runInNewContext(`${extractFunction('ensureAudio')}\nthis.ensureAudio = ensureAudio;`, sandbox);
  sandbox.ensureAudio();
  statuses.length = 0;
  sandbox.ac.onstatechange();
  assert.deepEqual(statuses, [{ type: 'deviceStatus', force: true }]);
});

function statusPublisherHarness() {
  let nowMs = 1_000;
  let nextTimer = 1;
  const timers = new Map();
  const sent = [];
  const sandbox = {
    myPid: '001',
    deviceId: '00000000-0000-4000-8000-000000000401',
    ready: true,
    sock: {
      connectionGeneration: 7,
      send(message) {
        if (sandbox.sendResult === false) return false;
        sent.push(structuredClone(message));
        return true;
      }
    },
    sendResult: true,
    DEVICE_STATUS_RETRY_MS: 1200,
    DEVICE_STATUS_GREEN_STABLE_MS: 900,
    lastDeviceStatusSignature: '',
    lastDeviceStatusGeneration: -1,
    lastDeviceStatusSentSignature: '',
    lastDeviceStatusSentGeneration: -1,
    lastDeviceStatusSentAt: 0,
    deviceStatusGreenTimer: 0,
    pendingGreenGeneration: -1,
    pendingGreenSignature: '',
    audioAlive() { return sandbox.ready; },
    Date: { now() { return nowMs; } },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, at: nowMs + Number(delay) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(`${extractFunction('sendDeviceStatus')}\nthis.sendDeviceStatus = sendDeviceStatus;`, sandbox);
  function advance(ms) {
    const target = nowMs + ms;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      nowMs = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    nowMs = target;
  }
  return { sandbox, sent, timers, advance };
}

test('readiness publisher sends red immediately and one green only after 900ms stable', () => {
  const h = statusPublisherHarness();

  assert.equal(h.sandbox.sendDeviceStatus('deviceStatus', true), true);
  assert.deepEqual(h.sent, []);
  h.advance(899);
  assert.deepEqual(h.sent, []);
  h.advance(1);
  assert.deepEqual(h.sent.map(message => message.soundReady), [true]);

  h.sandbox.ready = false;
  h.sandbox.sendDeviceStatus('deviceStatus', true);
  assert.deepEqual(h.sent.map(message => message.soundReady), [true, false]);
});

test('heartbeats cannot publish green before this socket generation passes the 900ms gate', () => {
  const h = statusPublisherHarness();

  h.sandbox.sendDeviceStatus('hb', true);
  assert.deepEqual(h.sent.map(message => [message.t, message.soundReady]), [['hb', false]]);

  h.sandbox.sendDeviceStatus('deviceStatus', true);
  h.advance(899);
  h.sandbox.sendDeviceStatus('hb', true);
  assert.equal(h.sent.at(-1).soundReady, false);

  h.advance(1);
  assert.deepEqual(h.sent.at(-1), {
    t: 'deviceStatus', pid: h.sandbox.myPid, deviceId: h.sandbox.deviceId, soundReady: true
  });
  h.sandbox.sendDeviceStatus('hb', true);
  assert.deepEqual(h.sent.at(-1), {
    t: 'hb', pid: h.sandbox.myPid, deviceId: h.sandbox.deviceId, soundReady: true
  });

  h.sandbox.sock.connectionGeneration += 1;
  h.sandbox.sendDeviceStatus('hb', true);
  assert.equal(h.sent.at(-1).soundReady, false, 'a reconnect must earn green again');

  h.sandbox.ready = false;
  h.sandbox.sendDeviceStatus('hb', true);
  assert.equal(h.sent.at(-1).soundReady, false, 'raw red remains immediate');
});

test('a local red invalidates an older saved green before raw audio recovers', () => {
  const h = statusPublisherHarness();
  const greenSignature = `${h.sandbox.myPid}:${h.sandbox.deviceId}:1`;

  h.sandbox.sendDeviceStatus('deviceStatus', true);
  h.advance(900);
  h.sandbox.lastDeviceStatusGeneration = h.sandbox.sock.connectionGeneration;
  h.sandbox.lastDeviceStatusSignature = greenSignature;

  h.sandbox.ready = false;
  h.sandbox.sendDeviceStatus('deviceStatus', true);
  assert.equal(h.sent.at(-1).soundReady, false);
  assert.equal(h.sandbox.lastDeviceStatusSignature, '', 'the old Saved green is invalid immediately');

  h.sandbox.ready = true;
  h.sandbox.sendDeviceStatus('deviceStatus', true);
  h.sandbox.sendDeviceStatus('hb', true);
  assert.equal(h.sent.at(-1).soundReady, false,
    'heartbeat cannot reuse the old Saved green inside the new 900ms window');
  h.advance(900);
  h.sandbox.sendDeviceStatus('hb', true);
  assert.equal(h.sent.at(-1).soundReady, true);
});

test('a failed red send leaves no green guard and remains retryable', () => {
  const h = statusPublisherHarness();
  const generation = h.sandbox.sock.connectionGeneration;
  const greenSignature = `${h.sandbox.myPid}:${h.sandbox.deviceId}:1`;
  h.sandbox.lastDeviceStatusGeneration = generation;
  h.sandbox.lastDeviceStatusSignature = greenSignature;
  h.sandbox.lastDeviceStatusSentGeneration = generation;
  h.sandbox.lastDeviceStatusSentSignature = greenSignature;

  h.sandbox.ready = false;
  h.sandbox.sendResult = false;
  assert.equal(h.sandbox.sendDeviceStatus('deviceStatus', true), false);
  assert.equal(h.sandbox.lastDeviceStatusGeneration, -1);
  assert.equal(h.sandbox.lastDeviceStatusSignature, '');
  assert.equal(h.sandbox.lastDeviceStatusSentGeneration, -1);
  assert.equal(h.sandbox.lastDeviceStatusSentSignature, '');

  h.sandbox.ready = true;
  h.sandbox.sendResult = true;
  h.sandbox.sendDeviceStatus('hb', true);
  assert.equal(h.sent.at(-1).soundReady, false);
});

test('forced identical statuses coalesce while a new socket generation retries once', () => {
  const h = statusPublisherHarness();
  h.sandbox.sendDeviceStatus('deviceStatus', true);
  h.advance(900);

  for (let index = 0; index < 20; index += 1) {
    h.sandbox.sendDeviceStatus('deviceStatus', true);
  }
  h.advance(2_000);
  assert.equal(h.sent.length, 1);

  h.sandbox.sock.connectionGeneration += 1;
  h.sandbox.sendDeviceStatus('deviceStatus', true);
  h.advance(899);
  assert.equal(h.sent.length, 1);
  h.advance(1);
  assert.equal(h.sent.length, 2);
});

test('same-generation open, state, and audio triggers publish one green and heartbeats reuse only that gate', () => {
  const h = statusPublisherHarness();
  h.sandbox.sendDeviceStatus('deviceStatus', true); // onOpen
  h.advance(100);
  h.sandbox.sendDeviceStatus('deviceStatus', true); // first state
  h.advance(100);
  h.sandbox.sendDeviceStatus('deviceStatus', true); // audio playing
  h.advance(899);
  assert.deepEqual(h.sent, []);
  h.advance(1);
  assert.equal(h.sent.filter(message => message.t === 'deviceStatus' && message.soundReady === true).length, 1);

  for (let index = 0; index < 10; index += 1) {
    h.sandbox.sendDeviceStatus('deviceStatus', true);
    h.sandbox.sendDeviceStatus('hb', true);
  }
  h.advance(2_000);
  assert.equal(h.sent.filter(message => message.t === 'deviceStatus' && message.soundReady === true).length, 1);
  assert.equal(h.sent.filter(message => message.t === 'hb').length, 10);
  assert.ok(h.sent.filter(message => message.t === 'hb').every(message => message.soundReady === true));
});

test('repeated green edges replace the stability timer instead of publishing early', () => {
  const h = statusPublisherHarness();
  h.sandbox.sendDeviceStatus('deviceStatus', true);
  h.advance(500);
  h.sandbox.sendDeviceStatus('deviceStatus', true);
  h.advance(500);
  assert.deepEqual(h.sent, []);
  h.advance(400);
  assert.deepEqual(h.sent.map(message => message.soundReady), [true]);
});
