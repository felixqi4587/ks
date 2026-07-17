const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '../public/battle-cues.js');
const plain = value => JSON.parse(JSON.stringify(value));

function loadApi() {
  const moduleValue = { exports: {} };
  vm.runInNewContext(fs.readFileSync(MODULE_PATH, 'utf8'), {
    module: moduleValue, exports: moduleValue.exports, globalThis: {}, Object, Array, Number, Math, TypeError, Error
  }, { filename: MODULE_PATH });
  return moduleValue.exports;
}

test('BattleCues exposes the same frozen browser UMD surface', () => {
  const browserGlobal = {};
  vm.runInNewContext(fs.readFileSync(MODULE_PATH, 'utf8'), {
    globalThis: browserGlobal, Object, Array, Number, Math, TypeError, Error
  }, { filename: MODULE_PATH });
  assert.equal(typeof browserGlobal.BattleCues.createCueScheduler, 'function');
  assert.equal(Object.isFrozen(browserGlobal.BattleCues), true);
});

function harness(now = 100_000) {
  let nowMs = now;
  let scheduleMode = 'success';
  const scheduled = [];
  const attempts = [];
  const cancelled = [];
  const scheduledEvents = [];
  const errors = [];
  const registry = {};
  const audio = {
    nowSeconds: () => 10,
    schedule(event, when) {
      attempts.push({ event: { ...event }, when, mode: scheduleMode });
      if (scheduleMode === 'throw') throw new Error('schedule failed');
      if (scheduleMode === 'empty') return [];
      const nodes = [{ event: { ...event }, when }];
      scheduled.push({ event: { ...event }, when, nodes });
      return nodes;
    },
    cancel(nodes) { cancelled.push(nodes); }
  };
  const api = loadApi().createCueScheduler({
    audio,
    registry,
    nowMs: () => nowMs,
    clockOffsetMs: () => 25,
    onScheduled: event => scheduledEvents.push(event),
    onError: error => errors.push(error)
  });
  return {
    api, audio, registry, scheduled, attempts, cancelled, scheduledEvents, errors,
    setNow: value => { nowMs = value; },
    setScheduleMode: value => { scheduleMode = value; }
  };
}

test('absolute events schedule once and expose a node-free snapshot', () => {
  const h = harness();
  const plan = {
    id: 'command:7:captain',
    targetAtMs: 111_000,
    events: [
      { id: '10', offsetMs: -10_000, kind: 'tick' },
      { id: '5', offsetMs: -5_000, kind: 'countdown', name: '5' },
      { id: '0', offsetMs: 0, kind: 'go' }
    ]
  };
  h.api.reconcile([plan]);
  h.api.reconcile([plan]);

  assert.deepEqual(h.scheduled.map(value => [value.event.kind, value.when]), [
    ['tick', 11], ['countdown', 16], ['go', 21]
  ]);
  assert.deepEqual(Object.keys(h.registry).sort(), [
    'command:7:captain:0', 'command:7:captain:10', 'command:7:captain:5'
  ]);
  const snapshot = h.api.snapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[0]), true);
  assert.ok(snapshot.every(entry => !Object.hasOwn(entry, 'nodes')));
  assert.ok(snapshot.every(entry => entry.scheduled === true),
    'a projected cue reports that Web Audio nodes were actually created');
  assert.deepEqual(snapshot.map(entry => entry.clockOffsetMs), [25, 25, 25]);
});

test('past events become tombstones and never replay after reconnect or drift', () => {
  const h = harness(112_000);
  const plan = {
    id: 'past-command', targetAtMs: 111_000,
    events: [{ id: '0', offsetMs: 0, kind: 'go' }]
  };
  assert.equal(h.api.reconcile([plan]), 0);
  assert.equal(h.scheduled.length, 0);
  assert.deepEqual(plain(h.registry['past-command:0'].nodes), []);
  assert.equal(h.api.snapshot()[0].scheduled, false,
    'an anti-replay tombstone is distinguishable from a real scheduled cue');
  assert.equal(h.scheduledEvents.length, 0, 'a tombstone is not a real scheduled cue');

  assert.equal(h.api.cancelDrifted(1_000, 300), true);
  assert.deepEqual(Object.keys(h.registry), []);
  h.api.reconcile([plan]);
  assert.equal(h.scheduled.length, 0, 'the past GO remains silent after replanning');
  assert.equal(h.scheduledEvents.length, 0);
});

test('future schedule throws and empty node results remain retryable until recovery', () => {
  const h = harness();
  const plan = {
    id: 'retry-command', targetAtMs: 110_000,
    events: [{ id: '0', offsetMs: 0, kind: 'go' }]
  };

  h.setScheduleMode('throw');
  assert.equal(h.api.reconcile([plan]), 0);
  assert.deepEqual(Object.keys(h.registry), []);
  assert.equal(h.errors.length, 1);
  assert.equal(h.scheduledEvents.length, 0);

  h.setScheduleMode('empty');
  assert.equal(h.api.reconcile([plan]), 0);
  assert.deepEqual(Object.keys(h.registry), []);
  assert.equal(h.scheduledEvents.length, 0);

  h.setScheduleMode('success');
  assert.equal(h.api.reconcile([plan]), 1);
  assert.deepEqual(Object.keys(h.registry), ['retry-command:0']);
  assert.equal(h.scheduledEvents.length, 1);
  assert.deepEqual(h.attempts.map(value => value.mode), ['throw', 'empty', 'success']);
});

test('reconcile cancels only obsolete future cues while explicit scopes are cancellable', () => {
  const h = harness();
  h.api.reconcile([
    { id: 'round:1:a', targetAtMs: 110_000, events: [{ id: '0', offsetMs: 0, kind: 'go' }] },
    { id: 'round:1:b', targetAtMs: 111_000, events: [{ id: '0', offsetMs: 0, kind: 'go' }] }
  ]);
  h.api.reconcile([
    { id: 'round:1:b', targetAtMs: 111_000, events: [{ id: '0', offsetMs: 0, kind: 'go' }] }
  ]);
  assert.equal(h.cancelled.length, 1);
  assert.equal(h.api.hasFutureCue('round:1:a'), false);
  assert.equal(h.api.hasFutureCue('round:1:b'), true);

  h.api.upsert({
    id: 'round:2:c', targetAtMs: 112_000,
    events: [{ id: '0', offsetMs: 0, kind: 'go' }]
  });
  assert.equal(h.api.cancelScope('round:1'), 1);
  assert.equal(h.api.hasFutureCue('round:1:b'), false);
  assert.equal(h.api.cancel('round:2:c'), true);
  assert.deepEqual(h.api.snapshot(), []);
});

test('upsert can merge a distinct prepare event without rebuilding countdown nodes', () => {
  const h = harness();
  h.api.upsert({
    id: 'personal', targetAtMs: 120_000,
    events: [{ id: '10', offsetMs: -10_000, kind: 'tick' }]
  });
  h.api.upsert({
    id: 'personal', targetAtMs: 120_000,
    events: [{ id: '15', offsetMs: -15_000, kind: 'prepare' }]
  }, { merge: true });
  assert.equal(h.scheduled.length, 2);
  assert.equal(h.cancelled.length, 0);
  assert.deepEqual(Object.keys(h.registry).sort(), ['personal:10', 'personal:15']);
});

test('dispose cancels every remaining future node and rejects new work', () => {
  const h = harness();
  h.api.reconcile([{ id: 'live', targetAtMs: 110_000, events: [{ id: '0', offsetMs: 0, kind: 'go' }] }]);
  h.api.dispose();
  assert.equal(h.cancelled.length, 1);
  assert.deepEqual(h.api.snapshot(), []);
  assert.throws(() => h.api.reconcile([]), /disposed/);
});
