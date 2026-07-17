const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/rally-controller.js'), 'utf8');
const audioSource = fs.readFileSync(path.join(__dirname, '../public/battle-audio.js'), 'utf8');

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

test('Rally readiness projects all five conditions through one shared truth', () => {
  let audioState = { userEnabled: true, audioContextRunning: true, carrierAlive: true };
  let clockIsFresh = true;
  const inputs = [];
  const sandbox = {
    battleAudio: { state: () => audioState },
    sock: { connected: true, clockFresh: () => clockIsFresh }, syncedOK: true,
    window: { BattleStatus: { deriveReadiness(input) {
      inputs.push(structuredClone(input));
      return { green: Object.values(input).every(value => value === true) };
    } } }
  };
  vm.runInNewContext(`${extractFunction('battleReadiness')}\n${extractFunction('audioAlive')}\nthis.audioAlive = audioAlive;`, sandbox);
  assert.equal(sandbox.audioAlive(), true);
  assert.deepEqual(inputs.at(-1), {
    userEnabled: true, audioContextRunning: true, carrierAlive: true,
    connected: true, clockFresh: true
  });
  for (const field of ['userEnabled', 'audioContextRunning', 'carrierAlive']) {
    audioState = { ...audioState, [field]: false };
    assert.equal(sandbox.audioAlive(), false, field);
    audioState = { userEnabled: true, audioContextRunning: true, carrierAlive: true };
  }
  sandbox.sock.connected = false;
  assert.equal(sandbox.audioAlive(), false, 'socket');
  sandbox.sock.connected = true; sandbox.syncedOK = false;
  assert.equal(sandbox.audioAlive(), true, 'canonical connection sample remains fresh');
  clockIsFresh = false; sandbox.syncedOK = true;
  assert.equal(sandbox.audioAlive(), false, 'clock');
});

test('clock freshness transitions re-enter the existing readiness publisher', () => {
  const sent = [];
  const sandbox = {
    syncedOK: false,
    paintChrome() {}, paintAudioStatus() {}, rebookCuesOnDrift() {}, scheduleAllCues() {},
    sendDeviceStatus(type, force) { sent.push([type, force]); }
  };
  vm.runInNewContext(`${extractFunction('updateSync')}\nthis.updateSync = updateSync;`, sandbox);

  sandbox.updateSync({ fresh: true, rtt: null });
  assert.equal(sandbox.syncedOK, true, 'a failed refresh does not discard a still-fresh canonical sample');
  assert.deepEqual(sent, [['deviceStatus', true]]);

  sandbox.updateSync({ fresh: true, rtt: 4 });
  assert.deepEqual(sent, [['deviceStatus', true]], 'unchanged freshness does not create another edge');

  sandbox.updateSync({ fresh: false, rtt: 4 });
  assert.equal(sandbox.syncedOK, false, 'fresh=false wins even when an RTT was observed');
  assert.deepEqual(sent, [['deviceStatus', true], ['deviceStatus', true]]);
});

test('starting a clock refresh preserves the shared connection freshness contract', async () => {
  let resolveSync;
  const sent = [];
  const sandbox = {
    syncAttempt: 0, syncedOK: true, lastAcceptedClockOffset: 12,
    sock: { clockFresh: () => true },
    window: {
      clockOffset: 12,
      syncClock: () => new Promise(resolve => { resolveSync = resolve; })
    },
    paintChrome() {}, paintAudioStatus() {},
    updateSync(result) { sandbox.syncedOK = result.fresh === true; },
    sendDeviceStatus(type, force) { sent.push([type, force]); }
  };
  vm.runInNewContext(`${extractFunction('beginClockSync')}\nthis.beginClockSync = beginClockSync;`, sandbox);

  const pending = sandbox.beginClockSync();
  assert.equal(sandbox.syncedOK, true, 'an in-flight refresh must not invalidate a fresh prior sample');
  assert.deepEqual(sent, []);
  resolveSync({ fresh: true, rtt: null });
  assert.equal(await pending, true);
});

test('lamp, status publisher, and ACK path cannot fork the readiness calculation', () => {
  assert.match(extractFunction('audioAlive'), /return battleReadiness\(\)\.green/);
  assert.match(extractFunction('paintAudioStatus'), /var readiness = battleReadiness\(\)[\s\S]*if \(readiness\.green\)/);
  assert.match(extractFunction('sendDeviceStatus'), /ready = audioAlive\(\)/);
  assert.match(extractFunction('acknowledgeClassicCommand'), /sendDeviceStatus\(\)/);
  assert.match(extractFunction('onBattleAudioStateChange'), /sendDeviceStatus\("deviceStatus", true\)[\s\S]*paintAudioStatus\(\)/);
});

test('the shared engine retains carrier debounce, recovery, MediaSession, and Wake Lock', () => {
  assert.match(audioSource, /var STALL_CONFIRM_MS = 80/);
  assert.match(audioSource, /var PAUSE_RECOVERY_MS = 250/);
  assert.match(audioSource, /listen\(carrier, "playing", carrierPlaying\)/);
  assert.match(audioSource, /listen\(carrier, "pause"/);
  assert.match(audioSource, /listen\(carrier, "error", carrierStopped\)/);
  assert.match(audioSource, /listen\(carrier, "ended", carrierStopped\)/);
  assert.match(audioSource, /listen\(carrier, "waiting", confirmCarrierLoss\)/);
  assert.match(audioSource, /listen\(carrier, "stalled", confirmCarrierLoss\)/);
  assert.match(audioSource, /nav\.mediaSession\.metadata/);
  assert.match(audioSource, /nav\.audioSession\.type !== "playback"/);
  assert.match(audioSource, /nav\.wakeLock\.request\("screen"\)/);
});

test('every AudioContext transition immediately reprojects device readiness', () => {
  assert.match(audioSource, /context\.onstatechange = function \(\)[\s\S]*context\.state !== "running"[\s\S]*notify\(\)/);
  assert.match(source, /onStateChange: onBattleAudioStateChange/);
  assert.match(extractFunction('onBattleAudioStateChange'), /syncLegacyAudioState\(state\)[\s\S]*sendDeviceStatus\("deviceStatus", true\)/);
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

test('routine same-generation state refreshes cannot postpone a pending green forever', () => {
  const h = statusPublisherHarness();
  h.sandbox.sendDeviceStatus('deviceStatus'); // onOpen
  h.advance(300);
  h.sandbox.sendDeviceStatus('deviceStatus'); // state snapshot
  h.advance(300);
  h.sandbox.sendDeviceStatus('deviceStatus'); // another room broadcast
  h.advance(299);
  assert.deepEqual(h.sent, []);
  h.advance(1);
  assert.deepEqual(h.sent.map(message => message.soundReady), [true],
    'unchanged room broadcasts must coalesce behind the original 900ms stability gate');
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
