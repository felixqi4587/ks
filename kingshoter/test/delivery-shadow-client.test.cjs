const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE_PATH = path.join(__dirname, '../public/kvk-delivery-shadow.js');
const DEVICE_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const QA_ROOM = 'qa-kvk-client-a';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = (value) => JSON.parse(JSON.stringify(value));

const TRAPPED_GLOBALS = [
  'Audio', 'AudioContext', 'webkitAudioContext', 'OfflineAudioContext',
  'speechSynthesis', 'SpeechSynthesisUtterance', 'HTMLMediaElement',
  'MediaMetadata', 'mediaSession', 'scheduleBeeps', 'schedulePrepareCue',
  'stopCue', 'scheduleAllCues', 'hasFuturePersonalCue',
  'acknowledgeClassicCommand', 'scheduledBeeps', '__cues', '__beeps',
  'document', 'localStorage', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'setTimeout', 'setInterval', 'requestAnimationFrame', 'Date', 'performance'
];

function trapProperty(target, name, accesses) {
  Object.defineProperty(target, name, {
    configurable: true,
    get() {
      accesses.push(name);
      throw new Error(`forbidden capability: ${name}`);
    }
  });
}

function load(options = {}) {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const window = {};
  const sandbox = { window, globalThis: window };
  const accesses = [];
  if (options.runtimeTraps) {
    for (const name of TRAPPED_GLOBALS) {
      trapProperty(window, name, accesses);
      trapProperty(sandbox, name, accesses);
    }
    const navigator = new Proxy({}, {
      get(_target, property) {
        accesses.push(`navigator.${String(property)}`);
        throw new Error(`forbidden capability: navigator.${String(property)}`);
      }
    });
    Object.defineProperty(window, 'navigator', { configurable: true, value: navigator });
    Object.defineProperty(sandbox, 'navigator', { configurable: true, value: navigator });
  }
  vm.runInNewContext(source, sandbox, { filename: SOURCE_PATH });
  return { api: window.KvkDeliveryShadow, source, accesses };
}

function identity(overrides = {}) {
  return {
    pid: '700001',
    deviceId: DEVICE_ID,
    view: 'player',
    audioArmed: true,
    ...overrides
  };
}

function fixture(config = {}) {
  const loaded = load({ runtimeTraps: config.runtimeTraps === true });
  const sent = [];
  const events = [];
  let nowMs = own(config, 'nowMs') ? config.nowMs : 1_000_000;
  let currentIdentity = identity(config.identity);
  const controller = loaded.api.create({
    room: own(config, 'room') ? config.room : QA_ROOM,
    enabled: own(config, 'enabled') ? config.enabled : true,
    send: own(config, 'send') ? config.send : (message) => {
      sent.push(plain(message));
      return true;
    },
    now: own(config, 'now') ? config.now : () => nowMs,
    getIdentity: own(config, 'getIdentity') ? config.getIdentity : () => ({ ...currentIdentity }),
    observe: own(config, 'observe') ? config.observe : (event) => events.push(plain(event))
  });
  return {
    ...loaded,
    controller,
    sent,
    events,
    setNow(value) { nowMs = value; },
    setIdentity(value) { currentIdentity = { ...currentIdentity, ...value }; }
  };
}

function hello(view = 'player') {
  return {
    t: 'deliveryShadowHello', v: 1, shadow: true,
    pid: '700001', deviceId: DEVICE_ID, view
  };
}

function probe(overrides = {}) {
  return {
    t: 'deliveryShadowProbe', v: 1, probeId: 'probe-a',
    sentAtMs: 999_900, expiresAtMs: 1_001_900,
    ...overrides
  };
}

function command(overrides = {}) {
  return {
    t: 'deliveryShadowCommand', v: 1, shadow: true,
    commandId: 'cmd-a', pid: '700001', role: 'weak', kingdom: 1,
    issuedAtMs: 999_000, fireAtMs: 1_010_000,
    audioExpiresAtMs: 1_010_150, marchSeconds: 31, leadSeconds: 10,
    ...overrides
  };
}

function cancel(overrides = {}) {
  return {
    t: 'deliveryShadowCancel', v: 1, shadow: true,
    commandId: 'cmd-a', cancelledAtMs: 1_000_010,
    ...overrides
  };
}

function establish(f, view = 'player') {
  assert.equal(f.controller.onOpen(), true);
  assert.deepEqual(f.sent.shift(), hello(view));
}

function onlyMessage(f) {
  assert.equal(f.sent.length, 1);
  return f.sent.shift();
}

test('QA predicate exactly matches the server boundary corpus', async () => {
  const model = await import('../src/delivery.js');
  const { api } = load();
  const maxRoom = 'qa-kvk-' + 'a'.repeat(41);
  const corpus = [
    'qa-kvk-a',
    maxRoom,
    'qa-kvk-' + 'a'.repeat(42),
    'QA-kvk-a',
    'qa-kvk-a_b',
    'qa-kvk-a-',
    'qa-kvk-',
    'operation-room',
    'demo',
    '_',
    '',
    null,
    1
  ];
  assert.equal(maxRoom.length, 48);
  for (const room of corpus) {
    assert.equal(api.isQaRoomName(room), model.isQaRoomName(room), String(room));
  }
});

test('disabled and non-QA controllers are fully inert', () => {
  const { api } = load();
  for (const input of [
    { room: 'operation-room', enabled: true },
    { room: QA_ROOM, enabled: false },
    { room: QA_ROOM, enabled: 1 }
  ]) {
    const calls = [];
    const controller = api.create({
      ...input,
      send() { calls.push('send'); throw new Error('must stay inert'); },
      now() { calls.push('now'); throw new Error('must stay inert'); },
      getIdentity() { calls.push('identity'); return identity(); },
      observe() { calls.push('observe'); throw new Error('must stay inert'); }
    });
    assert.equal(controller.enabled, false);
    assert.equal(controller.onOpen(), false);
    assert.equal(controller.handleMessage({
      t: 'deliveryShadowProbe', v: 1, probeId: 'probe-a',
      sentAtMs: 1, expiresAtMs: 2
    }), false);
    assert.deepEqual(plain(controller.state()), {
      seenCandidate: [], cancelled: [], observations: []
    });
    assert.deepEqual(calls, []);
  }
});

test('public API and controller expose only the frozen Task 5 surface', () => {
  const { api } = load();
  assert.deepEqual(Object.keys(api).sort(), ['create', 'isQaRoomName']);
  assert.equal(Object.isFrozen(api), true);
  const controller = api.create({
    room: QA_ROOM,
    enabled: true,
    send: () => true,
    now: () => 1,
    getIdentity: identity,
    observe: () => {}
  });
  assert.deepEqual(Object.keys(controller).sort(), [
    'enabled', 'handleMessage', 'onOpen', 'state'
  ]);
  assert.equal(Object.isFrozen(controller), true);
  assert.equal(controller.enabled, true);
  assert.deepEqual(plain(controller.state()), {
    seenCandidate: [], cancelled: [], observations: []
  });
});

test('hello requires exact canonical identity and omits armed state', () => {
  const invalid = [
    { pid: '' },
    { pid: 'bad/pid' },
    { pid: '__proto__' },
    { pid: 700001 },
    { deviceId: '' },
    { deviceId: DEVICE_ID.toUpperCase() },
    { deviceId: 'not-a-device' },
    { view: 'spectator' }
  ];
  for (const value of invalid) {
    const f = fixture({ identity: value });
    assert.equal(f.controller.onOpen(), false, JSON.stringify(value));
    assert.deepEqual(f.sent, [], JSON.stringify(value));
  }

  const f = fixture({ identity: { view: 'commander', audioArmed: false } });
  assert.equal(f.controller.onOpen(), true);
  assert.deepEqual(f.sent, [hello('commander')]);
  assert.equal(own(f.sent[0], 'audioArmed'), false);
});

test('hello pins only after strict true and identity drift clears the session', () => {
  for (const behavior of ['false', 'truthy', 'throw']) {
    const calls = [];
    const f = fixture({
      send(message) {
        calls.push(plain(message));
        if (behavior === 'throw') throw new Error('closed');
        return behavior === 'truthy' ? 1 : false;
      }
    });
    assert.equal(f.controller.onOpen(), false, behavior);
    assert.equal(f.controller.handleMessage(probe()), false, behavior);
    assert.deepEqual(calls, [hello()], behavior);
  }

  const drift = fixture();
  establish(drift);
  drift.setIdentity({ pid: '700002' });
  assert.equal(drift.controller.handleMessage(probe()), false);
  assert.deepEqual(drift.sent, []);
  drift.setIdentity({ pid: '700001' });
  assert.equal(drift.controller.handleMessage(probe()), false, 'restoring values does not restore a cleared pin');
  assert.equal(drift.controller.onOpen(), true);
  drift.sent.length = 0;
  assert.equal(drift.controller.handleMessage(probe()), true);
  assert.deepEqual(onlyMessage(drift), {
    t: 'deliveryShadowProbeAck', v: 1,
    probeId: 'probe-a', audioArmed: true
  });
});

test('probe reports current true or false armed state and accepts expiry equality only', () => {
  const preHello = fixture();
  assert.equal(preHello.controller.handleMessage(probe()), false);
  assert.deepEqual(preHello.sent, []);

  for (const audioArmed of [true, false]) {
    const f = fixture({ identity: { audioArmed }, nowMs: 1_001_900 });
    establish(f);
    assert.equal(f.controller.handleMessage(probe()), true);
    assert.deepEqual(onlyMessage(f), {
      t: 'deliveryShadowProbeAck', v: 1,
      probeId: 'probe-a', audioArmed
    });
  }

  const late = fixture({ nowMs: 1_001_901 });
  establish(late);
  assert.equal(late.controller.handleMessage(probe()), false);
  assert.deepEqual(late.sent, []);
});

test('probe rejects missing, extra, malformed, and unsynchronized input without state', () => {
  const invalid = [];
  for (const missing of ['t', 'v', 'probeId', 'sentAtMs', 'expiresAtMs']) {
    const value = probe();
    delete value[missing];
    invalid.push(value);
  }
  invalid.push(
    probe({ extra: true }),
    probe({ t: 'deliveryProbe' }),
    probe({ v: 2 }),
    probe({ probeId: '' }),
    probe({ probeId: ' ' }),
    probe({ probeId: 'x'.repeat(65) }),
    probe({ probeId: 7 }),
    probe({ sentAtMs: -1 }),
    probe({ sentAtMs: 1.5 }),
    probe({ sentAtMs: Number.MAX_SAFE_INTEGER + 1 }),
    probe({ sentAtMs: 2_000, expiresAtMs: 1_999 }),
    probe({ expiresAtMs: Infinity })
  );
  const f = fixture();
  establish(f);
  for (const value of invalid) {
    assert.equal(f.controller.handleMessage(value), false, JSON.stringify(value));
    assert.deepEqual(f.sent, [], JSON.stringify(value));
  }
  assert.deepEqual(plain(f.controller.state()), {
    seenCandidate: [], cancelled: [], observations: []
  });

  for (const now of [undefined, null, () => 1.5, () => Infinity, () => { throw new Error('clock'); }]) {
    const timed = fixture({ now });
    establish(timed);
    assert.equal(timed.controller.handleMessage(probe()), false);
    assert.deepEqual(timed.sent, []);
  }
});

test('command accepts only the exact complete twelve-field envelope for the pinned PID', () => {
  const valid = fixture();
  establish(valid);
  assert.equal(valid.controller.handleMessage(command()), true);
  assert.deepEqual(onlyMessage(valid), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-a',
    result: 'would_schedule', futureCueCount: 11
  });

  const invalid = [];
  for (const missing of [
    't', 'v', 'shadow', 'commandId', 'pid', 'role', 'kingdom',
    'issuedAtMs', 'fireAtMs', 'audioExpiresAtMs', 'marchSeconds', 'leadSeconds'
  ]) {
    const value = command({ commandId: `missing-${missing}` });
    delete value[missing];
    invalid.push(value);
  }
  invalid.push(
    command({ commandId: 'extra-field', extra: true }),
    command({ commandId: 'bad-type', t: 'deliveryCommand' }),
    command({ commandId: 'bad-version', v: 2 }),
    command({ commandId: 'bad-shadow', shadow: false }),
    command({ commandId: '' }),
    command({ commandId: ' ' }),
    command({ commandId: 'x'.repeat(65) }),
    command({ commandId: 7 }),
    command({ commandId: 'wrong-pid', pid: '700002' }),
    command({ commandId: 'number-pid', pid: 700001 }),
    command({ commandId: 'bad-role', role: 'captain' }),
    command({ commandId: 'bad-kingdom', kingdom: 3 }),
    command({ commandId: 'zero-issued', issuedAtMs: 0 }),
    command({ commandId: 'fraction-issued', issuedAtMs: 999_000.5 }),
    command({ commandId: 'unsafe-issued', issuedAtMs: Number.MAX_SAFE_INTEGER + 1 }),
    command({ commandId: 'zero-fire', fireAtMs: 0 }),
    command({ commandId: 'bad-expiry', audioExpiresAtMs: 1_009_999 }),
    command({ commandId: 'fraction-expiry', audioExpiresAtMs: 1_010_150.5 }),
    command({ commandId: 'negative-march', marchSeconds: -1 }),
    command({ commandId: 'fraction-march', marchSeconds: 31.5 }),
    command({ commandId: 'unsafe-march', marchSeconds: Number.MAX_SAFE_INTEGER + 1 }),
    command({ commandId: 'zero-lead', leadSeconds: 0 }),
    command({ commandId: 'large-lead', leadSeconds: 121 }),
    command({ commandId: 'fraction-lead', leadSeconds: 10.5 }),
    null,
    []
  );
  for (const value of invalid) {
    const f = fixture();
    establish(f);
    assert.equal(f.controller.handleMessage(value), false, JSON.stringify(value));
    assert.deepEqual(f.sent, [], JSON.stringify(value));
    assert.deepEqual(plain(f.controller.state()), {
      seenCandidate: [], cancelled: [], observations: []
    }, JSON.stringify(value));
  }
});

test('frozen candidate counts cover the full v1 lead range and never exceed twelve', () => {
  const cases = [
    { lead: 1, fireAtMs: 1_121_000, expected: 11 },
    { lead: 10, fireAtMs: 1_010_000, expected: 11 },
    { lead: 11, fireAtMs: 1_121_000, expected: 12 },
    { lead: 15, fireAtMs: 1_015_000, expected: 12 },
    { lead: 30, fireAtMs: 1_030_000, expected: 12 },
    { lead: 60, fireAtMs: 1_060_000, expected: 12 },
    { lead: 120, fireAtMs: 1_121_000, expected: 12 }
  ];
  for (const item of cases) {
    const f = fixture();
    establish(f);
    const commandId = `lead-${item.lead}`;
    assert.equal(f.controller.handleMessage(command({
      commandId,
      fireAtMs: item.fireAtMs,
      audioExpiresAtMs: item.fireAtMs + 150,
      leadSeconds: item.lead
    })), true);
    const ack = onlyMessage(f);
    assert.deepEqual(ack, {
      t: 'deliveryShadowAck', v: 1, commandId,
      result: 'would_schedule', futureCueCount: item.expected
    });
    assert.ok(ack.futureCueCount <= 12);
  }
});

test('progressive expiry uses the strict minus-150 future-fact boundary', () => {
  const cases = [
    { nowMs: 1_000_149, result: 'would_schedule', count: 11 },
    { nowMs: 1_000_150, result: 'would_schedule', count: 10 },
    { nowMs: 1_009_149, result: 'would_schedule', count: 2 },
    { nowMs: 1_009_150, result: 'would_schedule', count: 1 },
    { nowMs: 1_010_149, result: 'would_schedule', count: 1 },
    { nowMs: 1_010_150, result: 'expired', count: 0 }
  ];
  for (const item of cases) {
    const f = fixture({ nowMs: item.nowMs });
    establish(f);
    const commandId = `at-${item.nowMs}`;
    assert.equal(f.controller.handleMessage(command({ commandId })), true);
    assert.deepEqual(onlyMessage(f), {
      t: 'deliveryShadowAck', v: 1, commandId,
      result: item.result, futureCueCount: item.count
    });
  }
});

test('expiry minus one is actionable while equality, unarmed, and their duplicates stay zero', () => {
  const actionable = fixture({ nowMs: 1_010_149 });
  establish(actionable);
  assert.equal(actionable.controller.handleMessage(command({ commandId: 'expiry-minus-one' })), true);
  assert.deepEqual(onlyMessage(actionable), {
    t: 'deliveryShadowAck', v: 1, commandId: 'expiry-minus-one',
    result: 'would_schedule', futureCueCount: 1
  });

  const unarmed = fixture({ identity: { audioArmed: false } });
  establish(unarmed);
  const unarmedMessage = command({ commandId: 'cmd-unarmed' });
  assert.equal(unarmed.controller.handleMessage(unarmedMessage), true);
  assert.deepEqual(onlyMessage(unarmed), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-unarmed',
    result: 'audio_unarmed', futureCueCount: 0
  });
  unarmed.setIdentity({ audioArmed: true });
  assert.equal(unarmed.controller.handleMessage(plain(unarmedMessage)), true);
  assert.deepEqual(onlyMessage(unarmed), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-unarmed',
    result: 'duplicate', futureCueCount: 0
  });

  const expired = fixture({ nowMs: 1_010_150 });
  establish(expired);
  const expiredMessage = command({ commandId: 'cmd-expired' });
  assert.equal(expired.controller.handleMessage(expiredMessage), true);
  assert.deepEqual(onlyMessage(expired), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-expired',
    result: 'expired', futureCueCount: 0
  });
  expired.setNow(1_000_000);
  assert.equal(expired.controller.handleMessage(plain(expiredMessage)), true);
  assert.deepEqual(onlyMessage(expired), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-expired',
    result: 'duplicate', futureCueCount: 0
  });
});

test('immutable retry keeps the first fact across time and armed-state changes', () => {
  const f = fixture();
  establish(f);
  const original = command({ commandId: 'cmd-frozen' });
  assert.equal(f.controller.handleMessage(original), true);
  assert.deepEqual(onlyMessage(f), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-frozen',
    result: 'would_schedule', futureCueCount: 11
  });
  f.setNow(1_020_000);
  f.setIdentity({ audioArmed: false });
  assert.equal(f.controller.handleMessage(plain(original)), true);
  assert.deepEqual(onlyMessage(f), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-frozen',
    result: 'duplicate', futureCueCount: 11
  });
});

test('a false or thrown first ACK send is recoverable as a frozen duplicate', () => {
  for (const failure of ['false', 'throw']) {
    const output = [];
    let ackAttempts = 0;
    const f = fixture({
      send(message) {
        const value = plain(message);
        if (value.t === 'deliveryShadowHello') {
          output.push(value);
          return true;
        }
        ackAttempts += 1;
        if (ackAttempts === 1) {
          if (failure === 'throw') throw new Error('lost ACK');
          return false;
        }
        output.push(value);
        return true;
      }
    });
    assert.equal(f.controller.onOpen(), true);
    assert.deepEqual(output, [hello()]);
    const value = command({ commandId: `recover-${failure}` });
    assert.equal(f.controller.handleMessage(value), true);
    assert.deepEqual(output, [hello()], failure);
    assert.equal(f.controller.handleMessage(plain(value)), true);
    assert.deepEqual(output.at(-1), {
      t: 'deliveryShadowAck', v: 1,
      commandId: `recover-${failure}`,
      result: 'duplicate', futureCueCount: 11
    });
  }
});

test('same-ID fingerprint conflict is silent and cannot overwrite the frozen fact', () => {
  const f = fixture();
  establish(f);
  const stable = command({ commandId: 'cmd-conflict' });
  assert.equal(f.controller.handleMessage(stable), true);
  onlyMessage(f);
  assert.equal(f.controller.handleMessage({ ...stable, marchSeconds: 32 }), false);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(plain(f.controller.state()).observations.at(-1), {
    kind: 'candidate-conflict', commandId: 'cmd-conflict'
  });
  f.setNow(1_020_000);
  f.setIdentity({ audioArmed: false });
  assert.equal(f.controller.handleMessage(plain(stable)), true);
  assert.deepEqual(onlyMessage(f), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-conflict',
    result: 'duplicate', futureCueCount: 11
  });
});

test('cancel-before and command-then-cancel are idempotent and never revive count', () => {
  const before = fixture();
  establish(before);
  const stopBefore = cancel({ commandId: 'cmd-before' });
  assert.equal(before.controller.handleMessage(stopBefore), true);
  assert.deepEqual(before.sent, []);
  const later = command({ commandId: 'cmd-before' });
  assert.equal(before.controller.handleMessage(later), true);
  assert.deepEqual(onlyMessage(before), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-before',
    result: 'expired', futureCueCount: 0
  });
  assert.equal(before.controller.handleMessage(plain(later)), true);
  assert.deepEqual(onlyMessage(before), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-before',
    result: 'duplicate', futureCueCount: 0
  });

  const after = fixture();
  establish(after);
  const active = command({ commandId: 'cmd-after' });
  assert.equal(after.controller.handleMessage(active), true);
  assert.equal(onlyMessage(after).futureCueCount, 11);
  const stopAfter = cancel({ commandId: 'cmd-after' });
  assert.equal(after.controller.handleMessage(stopAfter), true);
  assert.equal(after.controller.handleMessage(plain(stopAfter)), true);
  assert.deepEqual(after.sent, []);
  assert.equal(after.controller.handleMessage(plain(active)), true);
  assert.deepEqual(onlyMessage(after), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-after',
    result: 'duplicate', futureCueCount: 0
  });
  const state = plain(after.controller.state());
  assert.deepEqual(state.cancelled, ['cmd-after']);
  assert.equal(state.observations.filter((event) => event.kind === 'candidate-cancel').length, 1);
});

test('a candidate cancellation survives cancelled-list FIFO eviction without a second observation', () => {
  const f = fixture();
  establish(f);
  const active = command({ commandId: 'cmd-cancel-tombstone' });
  assert.equal(f.controller.handleMessage(active), true);
  assert.equal(onlyMessage(f).futureCueCount, 11);
  assert.equal(f.controller.handleMessage(cancel({ commandId: 'cmd-cancel-tombstone' })), true);

  for (let index = 0; index < 32; index += 1) {
    assert.equal(f.controller.handleMessage(cancel({ commandId: `other-cancel-${index}` })), true);
  }
  let state = plain(f.controller.state());
  assert.equal(state.cancelled.length, 32);
  assert.equal(state.cancelled.includes('cmd-cancel-tombstone'), false);
  assert.equal(state.observations.filter((event) =>
    event.kind === 'candidate-cancel' && event.commandId === 'cmd-cancel-tombstone').length, 1);

  assert.equal(f.controller.handleMessage(plain(active)), true);
  assert.deepEqual(onlyMessage(f), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-cancel-tombstone',
    result: 'duplicate', futureCueCount: 0
  });

  assert.equal(f.controller.handleMessage(cancel({ commandId: 'cmd-cancel-tombstone' })), true);
  state = plain(f.controller.state());
  assert.equal(state.cancelled.includes('cmd-cancel-tombstone'), false);
  assert.equal(state.observations.filter((event) =>
    event.kind === 'candidate-cancel' && event.commandId === 'cmd-cancel-tombstone').length, 1);
  assert.equal(f.controller.handleMessage(plain(active)), true);
  assert.deepEqual(onlyMessage(f), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-cancel-tombstone',
    result: 'duplicate', futureCueCount: 0
  });
});

test('cancel rejects non-exact or malformed frames without state', () => {
  const invalid = [];
  for (const missing of ['t', 'v', 'shadow', 'commandId', 'cancelledAtMs']) {
    const value = cancel({ commandId: `missing-${missing}` });
    delete value[missing];
    invalid.push(value);
  }
  invalid.push(
    cancel({ commandId: 'extra', extra: true }),
    cancel({ v: 2 }),
    cancel({ shadow: false }),
    cancel({ commandId: '' }),
    cancel({ commandId: ' ' }),
    cancel({ commandId: 'x'.repeat(65) }),
    cancel({ cancelledAtMs: -1 }),
    cancel({ cancelledAtMs: 1.5 }),
    cancel({ cancelledAtMs: Number.MAX_SAFE_INTEGER + 1 })
  );
  const f = fixture();
  establish(f);
  for (const value of invalid) {
    assert.equal(f.controller.handleMessage(value), false, JSON.stringify(value));
  }
  assert.deepEqual(f.sent, []);
  assert.deepEqual(plain(f.controller.state()), {
    seenCandidate: [], cancelled: [], observations: []
  });
});

test('candidate facts and observations use FIFO 32/200 bounds and defensive copies', () => {
  const f = fixture();
  establish(f);
  for (let index = 0; index < 205; index += 1) {
    assert.equal(f.controller.handleMessage(command({
      commandId: `obs-${index}`,
      fireAtMs: 1_120_000,
      audioExpiresAtMs: 1_120_150
    })), true);
  }
  const state = plain(f.controller.state());
  assert.deepEqual(state.seenCandidate,
    Array.from({ length: 32 }, (_, index) => `obs-${index + 173}`));
  assert.equal(state.observations.length, 200);
  assert.equal(state.observations[0].commandId, 'obs-5');
  assert.equal(state.observations.at(-1).commandId, 'obs-204');

  const exposed = f.controller.state();
  exposed.seenCandidate.push('injected');
  exposed.cancelled.push('injected');
  exposed.observations[0].kind = 'mutated';
  exposed.observations.push({ kind: 'injected' });
  const fresh = plain(f.controller.state());
  assert.equal(fresh.seenCandidate.includes('injected'), false);
  assert.equal(fresh.cancelled.includes('injected'), false);
  assert.equal(fresh.observations.some((event) => event.kind === 'mutated' || event.kind === 'injected'), false);
});

test('cancelled IDs use FIFO 32 bounds and observations contain only privacy-safe facts', () => {
  const f = fixture();
  establish(f);
  for (let index = 0; index < 35; index += 1) {
    assert.equal(f.controller.handleMessage(cancel({ commandId: `cancel-${index}` })), true);
  }
  const state = plain(f.controller.state());
  assert.deepEqual(state.cancelled,
    Array.from({ length: 32 }, (_, index) => `cancel-${index + 3}`));

  const allowed = new Set(['kind', 'commandId', 'result', 'count']);
  for (const event of [...f.events, ...state.observations]) {
    assert.ok(Object.keys(event).every((key) => allowed.has(key)), JSON.stringify(event));
    assert.equal(typeof event.kind, 'string');
    if (own(event, 'commandId')) {
      assert.equal(typeof event.commandId, 'string');
      assert.ok(event.commandId.length > 0 && event.commandId.length <= 64);
    }
    const serialized = JSON.stringify(event);
    for (const secret of [
      'pid', 'deviceId', 'view', 'audioArmed', 'probeId',
      'issuedAtMs', 'fireAtMs', 'cancelledAtMs', 'raw', 'envelope'
    ]) {
      assert.equal(serialized.includes(secret), false, serialized);
    }
  }
});

test('identity, time, and observation exceptions are contained and fail closed', () => {
  const missingIdentity = fixture({
    getIdentity() { throw new Error('identity'); }
  });
  let opened;
  assert.doesNotThrow(() => { opened = missingIdentity.controller.onOpen(); });
  assert.equal(opened, false);
  assert.deepEqual(missingIdentity.sent, []);

  let identityThrows = false;
  const drift = fixture({
    getIdentity() {
      if (identityThrows) throw new Error('identity lost');
      return identity();
    }
  });
  establish(drift);
  identityThrows = true;
  let handled;
  assert.doesNotThrow(() => { handled = drift.controller.handleMessage(probe()); });
  assert.equal(handled, false);
  assert.deepEqual(drift.sent, []);

  for (const now of [undefined, null, () => 1.25, () => NaN, () => { throw new Error('clock'); }]) {
    const f = fixture({ now });
    establish(f);
    let result;
    assert.doesNotThrow(() => {
      result = f.controller.handleMessage(command({ commandId: 'bad-clock' }));
    });
    assert.equal(result, false);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(plain(f.controller.state()).seenCandidate, []);
  }

  const observed = [];
  const badObserver = fixture({
    observe(event) {
      observed.push(plain(event));
      throw new Error('observer');
    }
  });
  establish(badObserver);
  assert.doesNotThrow(() => {
    handled = badObserver.controller.handleMessage(command({ commandId: 'observe-failure' }));
  });
  assert.equal(handled, true);
  assert.deepEqual(onlyMessage(badObserver), {
    t: 'deliveryShadowAck', v: 1, commandId: 'observe-failure',
    result: 'would_schedule', futureCueCount: 11
  });
  assert.equal(observed.length, 1);
  assert.equal(plain(badObserver.controller.state()).observations.length, 1);
});

test('implementation source contains no forbidden capability or production ACK token', () => {
  const { source } = load();
  assert.doesNotMatch(source,
    /AudioContext|webkitAudioContext|OfflineAudioContext|createOscillator|createGain|createBufferSource|decodeAudioData|speechSynthesis|SpeechSynthesisUtterance|navigator\s*\.\s*vibrate|\bnew\s+Audio\s*\(|HTMLMediaElement|MediaMetadata|mediaSession|\.\s*play\s*\(|scheduleBeeps|schedulePrepareCue|stopCue|scheduleAllCues|hasFuturePersonalCue|acknowledgeClassicCommand|scheduledBeeps|__cues|__beeps|\bdocument\b|\blocalStorage\b|\bfetch\b|XMLHttpRequest|WebSocket|setTimeout|setInterval|requestAnimationFrame|\bDate\s*\.\s*now\b|\bperformance\s*\.\s*now\b/);
  assert.doesNotMatch(source, /\bt\s*:\s*['"]deliveryAck['"]/);
});

test('runtime getter and proxy traps stay untouched across every controller branch', () => {
  const f = fixture({ runtimeTraps: true });
  establish(f);

  assert.equal(f.controller.handleMessage(probe()), true);
  onlyMessage(f);

  const success = command({ commandId: 'runtime-success' });
  assert.equal(f.controller.handleMessage(success), true);
  onlyMessage(f);
  assert.equal(f.controller.handleMessage(plain(success)), true);
  onlyMessage(f);
  assert.equal(f.controller.handleMessage({ ...success, marchSeconds: 32 }), false);

  f.setIdentity({ audioArmed: false });
  assert.equal(f.controller.handleMessage(command({ commandId: 'runtime-unarmed' })), true);
  onlyMessage(f);

  f.setIdentity({ audioArmed: true });
  f.setNow(1_010_150);
  assert.equal(f.controller.handleMessage(command({ commandId: 'runtime-expired' })), true);
  onlyMessage(f);

  f.setNow(1_000_000);
  assert.equal(f.controller.handleMessage(cancel({ commandId: 'runtime-cancelled' })), true);
  assert.equal(f.controller.handleMessage(command({ commandId: 'runtime-cancelled' })), true);
  onlyMessage(f);

  assert.deepEqual(f.accesses, []);
});

test('every emitted candidate ACK matches the server model and none is production deliveryAck', async () => {
  const model = await import('../src/delivery.js');
  const acknowledgements = [];

  const success = fixture();
  establish(success);
  success.controller.handleMessage(command({ commandId: 'model-success' }));
  acknowledgements.push(onlyMessage(success));

  const unarmed = fixture({ identity: { audioArmed: false } });
  establish(unarmed);
  unarmed.controller.handleMessage(command({ commandId: 'model-unarmed' }));
  acknowledgements.push(onlyMessage(unarmed));

  const expired = fixture({ nowMs: 1_010_150 });
  establish(expired);
  expired.controller.handleMessage(command({ commandId: 'model-expired' }));
  acknowledgements.push(onlyMessage(expired));

  const duplicate = fixture();
  establish(duplicate);
  const duplicateMessage = command({ commandId: 'model-duplicate' });
  duplicate.controller.handleMessage(duplicateMessage);
  onlyMessage(duplicate);
  duplicate.controller.handleMessage(plain(duplicateMessage));
  acknowledgements.push(onlyMessage(duplicate));

  assert.equal(acknowledgements.some((message) => message.t === 'deliveryAck'), false);
  for (const ack of acknowledgements) {
    assert.deepEqual(Object.keys(ack).sort(), [
      'commandId', 'futureCueCount', 'result', 't', 'v'
    ]);
    assert.equal(ack.t, 'deliveryShadowAck');
    assert.equal(ack.v, 1);
    assert.equal(Number.isInteger(ack.futureCueCount), true);
    assert.ok(ack.futureCueCount >= 0 && ack.futureCueCount <= 12);

    const state = model.defaultDeliveryState(QA_ROOM);
    const record = model.createDeliveryRecord({
      id: ack.commandId,
      type: 'double_rally',
      kingdom: 1,
      payload: {
        leadSeconds: 10,
        pairs: [
          { pid: '700001', role: 'weak', pressUTC: 1010, march: 31 },
          { pid: '700002', role: 'main', pressUTC: 1012, march: 30 }
        ]
      }
    }, 1_000_000);
    state.commands.push(record);
    const attachment = {
      roomName: QA_ROOM,
      pid: '700001',
      deviceId: DEVICE_ID,
      soundReady: true,
      view: 'player',
      shadow: true,
      audioArmed: true,
      armedUntilMs: 1_008_000
    };
    assert.ok(model.upsertDeliveryTarget(state, ack.commandId, attachment, 1_000_000));
    assert.equal(model.recordShadowAck(state, attachment, ack, 1_000_001), true, JSON.stringify(ack));
  }
});
