const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUmd(file) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, globalThis: {},
    Object, Array, String, Number, JSON, Math, RegExp, TypeError, Error
  }, { filename: file });
  return module.exports;
}

const DefenseDomain = loadUmd(path.join(__dirname, '../public/defense-domain.js'));

const plain = value => JSON.parse(JSON.stringify(value));

function personalOrder(overrides = {}) {
  return {
    id: 'defense-order-1', revision: 7,
    signalAtMs: 900_000, acceptedAtMs: 900_020,
    tapAnchorSeconds: 180, enemyMarchSeconds: 30,
    enemyLaunchAtMs: 1_080_000, enemyImpactAtMs: 1_110_000,
    completeAtMs: 1_081_000,
    pid: 'defender-a', displayName: 'Defender A',
    march: 30, marchRevision: 2, goAtMs: 1_080_000, tooLate: false,
    ...overrides
  };
}

test('personal order projection accepts only the current profile and preserves exact GO', () => {
  const order = personalOrder();
  assert.deepEqual(plain(DefenseDomain.personalOrder(order, 'defender-a', 1_060_000)), {
    captured: true,
    tooLate: false,
    id: 'defense-order-1',
    revision: 7,
    pid: 'defender-a',
    displayName: 'Defender A',
    march: 30,
    marchRevision: 2,
    goAtMs: 1_080_000,
    completeAtMs: 1_081_000,
    phase: 'scheduled',
    remainingMs: 20_000,
    observedAtMs: 1_060_000,
    planId: 'defense:defense-order-1:7:defender-a'
  });
  assert.deepEqual(plain(DefenseDomain.personalOrder(order, 'someone-else', 1_060_000)), {
    captured: false,
    tooLate: false,
    phase: 'waiting',
    remainingMs: null,
    observedAtMs: 1_060_000
  });
  assert.deepEqual(plain(DefenseDomain.personalOrder(null, 'defender-a', 1_060_000)), {
    captured: false,
    tooLate: false,
    phase: 'waiting',
    remainingMs: null,
    observedAtMs: 1_060_000
  });
});

test('full immutable server orders are projected to only the requested audience profile', () => {
  const direct = personalOrder();
  const full = {
    ...direct,
    pid: undefined,
    audience: [
      { pid: 'other', displayName: 'Other', march: 15, marchRevision: 1, goAtMs: 1_095_000, tooLate: false },
      { pid: direct.pid, displayName: direct.displayName, march: direct.march,
        marchRevision: direct.marchRevision, goAtMs: direct.goAtMs, tooLate: direct.tooLate }
    ]
  };
  const projection = DefenseDomain.personalOrder(full, 'defender-a', 1_070_000);
  assert.equal(projection.captured, true);
  assert.equal(projection.goAtMs, 1_080_000);
  assert.equal(projection.displayName, 'Defender A');
  assert.equal(JSON.stringify(projection).includes('Other'), false);
});

test('cue plan is the shared T-15, T-10..6, 5..1, and exact Now grammar', () => {
  const projection = DefenseDomain.personalOrder(personalOrder(), 'defender-a', 1_060_000);
  assert.deepEqual(plain(DefenseDomain.cuePlan(projection)), [
    { id: 'prepare-15', offsetMs: -15_000, kind: 'prepare' },
    { id: 'beep-10', offsetMs: -10_000, kind: 'beep' },
    { id: 'beep-9', offsetMs: -9_000, kind: 'beep' },
    { id: 'beep-8', offsetMs: -8_000, kind: 'beep' },
    { id: 'beep-7', offsetMs: -7_000, kind: 'beep' },
    { id: 'beep-6', offsetMs: -6_000, kind: 'beep' },
    { id: 'count-5', offsetMs: -5_000, kind: 'countdown', name: '5' },
    { id: 'count-4', offsetMs: -4_000, kind: 'countdown', name: '4' },
    { id: 'count-3', offsetMs: -3_000, kind: 'countdown', name: '3' },
    { id: 'count-2', offsetMs: -2_000, kind: 'countdown', name: '2' },
    { id: 'count-1', offsetMs: -1_000, kind: 'countdown', name: '1' },
    { id: 'now', offsetMs: 0, kind: 'go', name: 'go' }
  ]);
});

test('reconnect plans only events that have not passed and never replays a partial late order', () => {
  const future = DefenseDomain.personalOrder(personalOrder(), 'defender-a', 1_071_500);
  assert.deepEqual(
    plain(DefenseDomain.cuePlan(future).map(event => event.id)),
    ['beep-8', 'beep-7', 'beep-6', 'count-5', 'count-4', 'count-3', 'count-2', 'count-1', 'now']
  );

  const exactNow = DefenseDomain.personalOrder(personalOrder(), 'defender-a', 1_080_000);
  assert.equal(exactNow.phase, 'now');
  assert.equal(exactNow.tooLate, false);
  assert.deepEqual(plain(DefenseDomain.cuePlan(exactNow).map(event => event.id)), ['now']);

  const missed = DefenseDomain.personalOrder(personalOrder(), 'defender-a', 1_080_001);
  assert.equal(missed.tooLate, true);
  assert.equal(missed.phase, 'too_late');
  assert.deepEqual(plain(DefenseDomain.cuePlan(missed)), []);

  const canonicallyLate = DefenseDomain.personalOrder(
    personalOrder({ tooLate: true, goAtMs: 1_079_000 }), 'defender-a', 1_060_000
  );
  assert.equal(canonicallyLate.tooLate, true);
  assert.deepEqual(plain(DefenseDomain.cuePlan(canonicallyLate)), []);
});

test('personal phase boundaries preserve T-15, T-10, T-5, and exact T0 meaning', () => {
  const phases = [
    [1_064_999, 'scheduled'],
    [1_065_000, 'prepare'],
    [1_070_000, 'beep'],
    [1_075_000, 'countdown'],
    [1_080_000, 'now'],
    [1_080_001, 'too_late']
  ];
  for (const [nowMs, phase] of phases) {
    assert.equal(DefenseDomain.personalOrder(personalOrder(), 'defender-a', nowMs).phase, phase);
  }
});

test('terminal matching and cue scopes are exact to order and revision', () => {
  const active = DefenseDomain.personalOrder(personalOrder(), 'defender-a', 1_060_000);
  assert.equal(DefenseDomain.matchesTerminal(active, {
    t: 'defenseOrderCancelled', orderId: 'defense-order-1', revision: 8
  }), true);
  assert.equal(DefenseDomain.matchesTerminal(active, {
    t: 'defenseOrderCompleted', orderId: 'defense-order-1', revision: 8
  }), true);
  assert.equal(DefenseDomain.matchesTerminal(active, {
    t: 'defenseOrderCancelled', orderId: 'other-order', revision: 8
  }), false);
  assert.equal(DefenseDomain.matchesTerminal(active, {
    t: 'defenseOrderCancelled', orderId: 'defense-order-1', revision: 7
  }), false, 'a terminal transition must advance the order revision');
  assert.equal(DefenseDomain.cueScope(active), 'defense:defense-order-1:7:defender-a');
});

test('malformed order values fail closed and never create a cue plan', () => {
  for (const malformed of [
    personalOrder({ id: '' }),
    personalOrder({ revision: 0 }),
    personalOrder({ goAtMs: Infinity }),
    personalOrder({ march: 4 }),
    personalOrder({ pid: '__proto__' }),
    personalOrder({ tooLate: 'yes' })
  ]) {
    const projection = DefenseDomain.personalOrder(malformed, 'defender-a', 1_060_000);
    assert.equal(projection.captured, false);
    assert.deepEqual(plain(DefenseDomain.cuePlan(projection)), []);
  }
});
