const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function domain() {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'defense-domain.js'));
  url.searchParams.set('run', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function player(name, march, marchRevision = 0, extra = {}) {
  return { name, march, marchRevision, identityMode: 'nickname', ...extra };
}

async function configuredState(options = {}) {
  const mod = await domain();
  const initial = mod.defaultDefenseState();
  const updated = mod.updateDefenseConfig(initial, {
    mutationId: options.mutationId || 'config-1',
    baseRevision: 0,
    tapAnchorSeconds: options.tapAnchorSeconds ?? 180,
    enemyMarchSeconds: options.enemyMarchSeconds ?? 30,
    updatedAt: options.updatedAt || '2026-07-16T12:00:00.000Z'
  });
  assert.equal(updated.ok, true);
  return { mod, state: updated.state };
}

test('Defense config defaults to 3:00 and accepts both exact timing endpoints', async () => {
  const mod = await domain();
  const initial = mod.defaultDefenseState();
  assert.deepEqual(initial, {
    version: 1,
    config: {
      tapAnchorSeconds: 180,
      enemyMarchSeconds: null,
      revision: 0,
      updatedAt: null
    },
    players: {},
    pendingRemovalPids: [],
    orderRevision: 0,
    activeOrder: null,
    lastTerminal: null,
    recentMutations: []
  });

  const minimum = mod.updateDefenseConfig(initial, {
    mutationId: 'config-min', baseRevision: 0,
    tapAnchorSeconds: 5, enemyMarchSeconds: 5,
    updatedAt: '2026-07-16T12:00:00.000Z'
  });
  assert.equal(minimum.ok, true);
  assert.deepEqual(minimum.config, {
    tapAnchorSeconds: 5,
    enemyMarchSeconds: 5,
    revision: 1,
    updatedAt: '2026-07-16T12:00:00.000Z'
  });

  const maximum = mod.updateDefenseConfig(minimum.state, {
    mutationId: 'config-max', baseRevision: 1,
    tapAnchorSeconds: 300, enemyMarchSeconds: 120,
    updatedAt: '2026-07-16T12:01:00.000Z'
  });
  assert.equal(maximum.ok, true);
  assert.deepEqual(maximum.config, {
    tapAnchorSeconds: 300,
    enemyMarchSeconds: 120,
    revision: 2,
    updatedAt: '2026-07-16T12:01:00.000Z'
  });
  assert.deepEqual(initial, mod.defaultDefenseState(), 'config transition must not mutate its input');
});

test('Defense config rejects malformed MM:SS-like and out-of-range values atomically', async () => {
  const mod = await domain();
  const initial = mod.defaultDefenseState();
  const badAnchors = [4, 301, 5.5, '0:05', '05:00', '5:60', '', null, true, Infinity, NaN];
  for (const tapAnchorSeconds of badAnchors) {
    const before = structuredClone(initial);
    const result = mod.updateDefenseConfig(initial, {
      mutationId: `bad-anchor-${String(tapAnchorSeconds)}`,
      baseRevision: 0,
      tapAnchorSeconds,
      enemyMarchSeconds: 30,
      updatedAt: 'never'
    });
    assert.equal(result.ok, false, String(tapAnchorSeconds));
    assert.equal(result.error, 'invalid_tap_anchor');
    assert.deepEqual(initial, before);
  }

  const badMarches = [4, 121, 5.5, '0:05', '02:00', '1:60', '', null, false, Infinity, NaN];
  for (const enemyMarchSeconds of badMarches) {
    const before = structuredClone(initial);
    const result = mod.updateDefenseConfig(initial, {
      mutationId: `bad-march-${String(enemyMarchSeconds)}`,
      baseRevision: 0,
      tapAnchorSeconds: 180,
      enemyMarchSeconds,
      updatedAt: 'never'
    });
    assert.equal(result.ok, false, String(enemyMarchSeconds));
    assert.equal(result.error, 'invalid_enemy_march');
    assert.deepEqual(initial, before);
  }
});

test('normalization repairs malformed state and keeps only the newest 64 bounded mutations', async () => {
  const mod = await domain();
  const recentMutations = Array.from({ length: 70 }, (_, index) => ({
    mutationId: `m-${index}`,
    operation: 'config',
    fingerprint: `f-${index}`,
    outcome: { ok: true, revision: index }
  }));
  const players = Object.create({ inherited: player('Inherited', 30) });
  players.good_pid = player('Good', 30, -7);
  players.__proto__ = player('Poison', 31);
  players['bad pid'] = player('Bad', 32);

  const normalized = mod.normalizeDefenseState({
    version: 99,
    config: { tapAnchorSeconds: 999, enemyMarchSeconds: -1, revision: -4, updatedAt: 42 },
    players,
    pendingRemovalPids: ['good_pid', 'good_pid', '__proto__', 'bad pid'],
    orderRevision: -5,
    activeOrder: { broken: true },
    lastTerminal: { broken: true },
    recentMutations
  });

  assert.equal(normalized.version, 1);
  assert.deepEqual(normalized.config, {
    tapAnchorSeconds: 180,
    enemyMarchSeconds: null,
    revision: 0,
    updatedAt: null
  });
  assert.deepEqual(Object.keys(normalized.players), ['good_pid']);
  assert.equal(normalized.players.good_pid.marchRevision, 0);
  assert.deepEqual(normalized.pendingRemovalPids, ['good_pid']);
  assert.equal(normalized.orderRevision, 0);
  assert.equal(normalized.activeOrder, null);
  assert.equal(normalized.lastTerminal, null);
  assert.equal(normalized.recentMutations.length, 64);
  assert.equal(normalized.recentMutations[0].mutationId, 'm-6');
  assert.equal(normalized.recentMutations.at(-1).mutationId, 'm-69');
});

test('normalization fails closed when stored order equations or frozen audience facts contradict', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 180, enemyMarchSeconds: 30 });
  state.players = { p1: player('One', 30, 2) };
  const created = mod.createDefenseOrder(state, {
    mutationId: 'fire-normalize', orderId: 'order-normalize', configRevision: 1,
    signalAtMs: 500_000, acceptedAtMs: 500_010, connectedPids: ['p1']
  });
  assert.equal(created.ok, true);

  const corruptions = [
    value => { value.activeOrder.enemyLaunchAtMs += 1; },
    value => { value.activeOrder.enemyImpactAtMs += 1; },
    value => { value.activeOrder.audience[0].goAtMs += 1; },
    value => { value.activeOrder.audience[0].tooLate = !value.activeOrder.audience[0].tooLate; },
    value => { value.activeOrder.audience[0].march += 1; },
    value => { value.activeOrder.audience = []; },
    value => { value.activeOrder.completeAtMs += 1; }
  ];
  for (const corrupt of corruptions) {
    const stored = structuredClone(created.state);
    corrupt(stored);
    const normalized = mod.normalizeDefenseState(stored);
    assert.equal(normalized.activeOrder, null);
    assert.equal(normalized.orderRevision, 1, 'the monotonic revision survives rejected active payloads');
  }
});

test('normalization rejects a coordinated valid-flag, audience, and completion rewrite', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 180, enemyMarchSeconds: 30 });
  state.players = { p1: player('One', 30, 2) };
  const created = mod.createDefenseOrder(state, {
    mutationId: 'fire-coordinated-corruption', orderId: 'order-coordinated-corruption', configRevision: 1,
    signalAtMs: 550_000, acceptedAtMs: 550_010, connectedPids: ['p1']
  });
  const stored = structuredClone(created.state);
  stored.activeOrder.rosterAtAcceptance[0].validAtAcceptance = false;
  stored.activeOrder.audience = [];
  stored.activeOrder.completeAtMs = stored.activeOrder.acceptedAtMs + 3000;

  const normalized = mod.normalizeDefenseState(stored);
  assert.equal(normalized.activeOrder, null);
  assert.equal(normalized.orderRevision, 1);
});

test('terminal purge normalization validates and deduplicates without scanning past 150 raw entries', async () => {
  const mod = await domain();
  const validPids = Array.from({ length: 150 }, (_, index) => `purge_${String(index).padStart(3, '0')}`);
  const rawPids = validPids.slice();
  Object.defineProperty(rawPids, 150, {
    enumerable: true,
    get() { throw new Error('stored purge list scanned past the 150-player boundary'); }
  });
  let normalized;
  assert.doesNotThrow(() => {
    normalized = mod.normalizeDefenseState({
      orderRevision: 2,
      lastTerminal: {
        orderId: 'bounded-terminal', revision: 2, status: 'completed', terminalAtMs: 1_000,
        purgePids: rawPids
      }
    });
  });
  assert.equal(normalized.lastTerminal.purgePids.length, 150);
  assert.deepEqual(normalized.lastTerminal.purgePids, validPids);
});

test('a terminal tombstone dominates an older active order but not a genuinely newer round', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 180, enemyMarchSeconds: 30 });
  state.players = { p1: player('One', 30) };
  const first = mod.createDefenseOrder(state, {
    mutationId: 'fire-tombstone-a', orderId: 'order-a', configRevision: 1,
    signalAtMs: 600_000, acceptedAtMs: 600_010, connectedPids: ['p1']
  });
  const staleStored = structuredClone(first.state);
  staleStored.lastTerminal = {
    orderId: 'order-a', revision: 2, status: 'cancelled', terminalAtMs: 600_100,
    purgePids: []
  };
  staleStored.orderRevision = 2;
  const tombstoned = mod.normalizeDefenseState(staleStored);
  assert.equal(tombstoned.activeOrder, null);
  assert.deepEqual(tombstoned.lastTerminal, staleStored.lastTerminal);

  const cancelled = mod.cancelDefenseOrder(first.state, {
    mutationId: 'cancel-tombstone-a', orderId: 'order-a', orderRevision: 1,
    cancelledAtMs: 600_100
  });
  const second = mod.createDefenseOrder(cancelled.state, {
    mutationId: 'fire-tombstone-b', orderId: 'order-b', configRevision: 1,
    signalAtMs: 601_000, acceptedAtMs: 601_010, connectedPids: ['p1']
  });
  assert.equal(second.order.revision, 3);
  const normalizedNewer = mod.normalizeDefenseState(second.state);
  assert.equal(normalizedNewer.activeOrder.id, 'order-b');
  assert.equal(normalizedNewer.activeOrder.revision, 3);
  assert.equal(normalizedNewer.lastTerminal.revision, 2);
});

test('order creation freezes every profile and targets only connected valid profiles with exact equations', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 5, enemyMarchSeconds: 5 });
  state.players = {
    alpha: player('Alpha', 5, 2),
    bravo: player('Bravo', 120, 3, {
      identityMode: 'playerId', playerId: '900000002', profileKey: 'must-not-leak'
    }),
    offline: player('Offline', 30, 4),
    invalid: player('Invalid', 4, 5)
  };
  const before = structuredClone(state);
  const created = mod.createDefenseOrder(state, {
    mutationId: 'fire-1',
    orderId: 'order-1',
    configRevision: 1,
    signalAtMs: 1_000_000,
    acceptedAtMs: 1_000_040,
    connectedPids: ['bravo', 'alpha', 'alpha', 'invalid']
  });

  assert.equal(created.ok, true);
  assert.equal(created.order.revision, 1);
  assert.equal(created.order.enemyLaunchAtMs, 1_005_000);
  assert.equal(created.order.enemyImpactAtMs, 1_010_000);
  assert.equal(created.order.completeAtMs, 1_006_000);
  assert.deepEqual(created.order.rosterAtAcceptance, [
    {
      pid: 'alpha', displayName: 'Alpha', identityMode: 'nickname', playerId: '',
      march: 5, marchRevision: 2, connectedAtAcceptance: true, validAtAcceptance: true
    },
    {
      pid: 'bravo', displayName: 'Bravo', identityMode: 'playerId', playerId: '900000002',
      march: 120, marchRevision: 3, connectedAtAcceptance: true, validAtAcceptance: true
    },
    {
      pid: 'invalid', displayName: 'Invalid', identityMode: 'nickname', playerId: '',
      march: 4, marchRevision: 5, connectedAtAcceptance: true, validAtAcceptance: false
    },
    {
      pid: 'offline', displayName: 'Offline', identityMode: 'nickname', playerId: '',
      march: 30, marchRevision: 4, connectedAtAcceptance: false, validAtAcceptance: true
    }
  ]);
  assert.deepEqual(created.order.audience, [
    {
      pid: 'alpha', displayName: 'Alpha', identityMode: 'nickname', playerId: '',
      march: 5, marchRevision: 2, goAtMs: 1_005_000, tooLate: false
    },
    {
      pid: 'bravo', displayName: 'Bravo', identityMode: 'playerId', playerId: '900000002',
      march: 120, marchRevision: 3, goAtMs: 890_000, tooLate: true
    }
  ]);
  assert.deepEqual(state, before, 'order creation must not mutate the canonical input');
  assert.doesNotMatch(JSON.stringify(created.order), /profileKey|must-not-leak/);
});

test('when every GO is late the order completes exactly three seconds after acceptance', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 5, enemyMarchSeconds: 5 });
  state.players = { late: player('Late', 5, 0) };
  const created = mod.createDefenseOrder(state, {
    mutationId: 'fire-late', orderId: 'order-late', configRevision: 1,
    signalAtMs: 1_000_000, acceptedAtMs: 1_005_000, connectedPids: ['late']
  });
  assert.equal(created.ok, true);
  assert.equal(created.order.audience[0].goAtMs, 1_005_000);
  assert.equal(created.order.audience[0].tooLate, true, 'GO equal to acceptance is too late');
  assert.equal(created.order.completeAtMs, 1_008_000);
  assert.equal(mod.nextDefenseWakeAt(created.state), 1_008_000);
});

test('active order snapshots and frozen metrics never change after profile or config edits', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 180, enemyMarchSeconds: 30 });
  state.players = {
    captured: player('Captured', 20, 3),
    offline: player('Offline', 30, 1),
    invalid: player('Invalid', 121, 2)
  };
  const created = mod.createDefenseOrder(state, {
    mutationId: 'fire-frozen', orderId: 'order-frozen', configRevision: 1,
    signalAtMs: 2_000_000, acceptedAtMs: 2_000_010, connectedPids: ['captured', 'invalid']
  });
  assert.equal(created.ok, true);
  const frozenOrder = structuredClone(created.order);
  const frozenSummary = mod.publicDefenseSummary(created.state).activeOrder;

  created.state.players.captured.name = 'Edited';
  created.state.players.captured.march = 60;
  created.state.players.captured.marchRevision = 4;
  created.state.players.newcomer = player('Newcomer', 25, 0);
  const configUpdated = mod.updateDefenseConfig(created.state, {
    mutationId: 'config-next-round', baseRevision: 1,
    tapAnchorSeconds: 300, enemyMarchSeconds: 120,
    updatedAt: '2026-07-16T12:05:00.000Z'
  });

  assert.equal(configUpdated.ok, true);
  assert.deepEqual(configUpdated.state.activeOrder, frozenOrder);
  assert.deepEqual(mod.publicDefenseSummary(configUpdated.state).activeOrder, frozenSummary);
  assert.equal(mod.publicDefenseSummary(configUpdated.state).registeredProfiles, 4);
});

test('mutation IDs are idempotent, conflicting reuse fails, first manager wins, and ledger stays at 64', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 180, enemyMarchSeconds: 30 });
  state.players = { p1: player('One', 30) };
  const request = {
    mutationId: 'fire-same', orderId: 'order-same', configRevision: 1,
    signalAtMs: 3_000_000, acceptedAtMs: 3_000_010, connectedPids: ['p1']
  };
  const first = mod.createDefenseOrder(state, request);
  const duplicate = mod.createDefenseOrder(first.state, { ...request, connectedPids: ['p1', 'p1'] });
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.replayed, true);
  assert.deepEqual(duplicate.order, first.order);
  assert.equal(duplicate.state.recentMutations.length, first.state.recentMutations.length);

  const conflicting = mod.createDefenseOrder(first.state, { ...request, signalAtMs: 3_000_001 });
  assert.deepEqual(
    { ok: conflicting.ok, error: conflicting.error },
    { ok: false, error: 'mutation_conflict' }
  );
  const secondManager = mod.createDefenseOrder(first.state, {
    mutationId: 'fire-second-manager', orderId: 'order-second', configRevision: 1,
    signalAtMs: 3_000_020, acceptedAtMs: 3_000_030, connectedPids: ['p1']
  });
  assert.equal(secondManager.ok, false);
  assert.equal(secondManager.error, 'order_active');
  assert.equal(secondManager.activeOrder.id, 'order-same');

  let current = mod.defaultDefenseState();
  for (let index = 0; index < 70; index++) {
    const result = mod.updateDefenseConfig(current, {
      mutationId: `config-${index}`,
      baseRevision: index,
      tapAnchorSeconds: 180 + (index % 2),
      enemyMarchSeconds: 30,
      updatedAt: `tick-${index}`
    });
    assert.equal(result.ok, true, `config-${index}`);
    current = result.state;
  }
  assert.equal(current.recentMutations.length, 64);
  assert.equal(current.recentMutations[0].mutationId, 'config-6');
  assert.equal(current.recentMutations.at(-1).mutationId, 'config-69');
});

test('mutation replay ignores regenerated server metadata but still fingerprints client intent', async () => {
  const mod = await domain();
  const configured = mod.updateDefenseConfig(mod.defaultDefenseState(), {
    mutationId: 'config-retry', baseRevision: 0,
    tapAnchorSeconds: 180, enemyMarchSeconds: 30,
    updatedAt: 'first-server-time'
  });
  const configReplay = mod.updateDefenseConfig(configured.state, {
    mutationId: 'config-retry', baseRevision: 0,
    tapAnchorSeconds: 180, enemyMarchSeconds: 30,
    updatedAt: 'later-server-time'
  });
  assert.equal(configReplay.ok, true);
  assert.equal(configReplay.replayed, true);
  assert.equal(configReplay.mutationId, 'config-retry');
  assert.equal(configReplay.config.updatedAt, 'first-server-time');

  configured.state.players = { p1: player('One', 30) };
  const firstFire = mod.createDefenseOrder(configured.state, {
    mutationId: 'fire-retry', orderId: 'first-server-order', configRevision: 1,
    signalAtMs: 3_500_000, acceptedAtMs: 3_500_010, connectedPids: ['p1']
  });
  const fireReplay = mod.createDefenseOrder(firstFire.state, {
    mutationId: 'fire-retry', orderId: 'regenerated-server-order', configRevision: 1,
    signalAtMs: 3_500_000, acceptedAtMs: 3_500_999, connectedPids: []
  });
  assert.equal(fireReplay.ok, true);
  assert.equal(fireReplay.replayed, true);
  assert.equal(fireReplay.mutationId, 'fire-retry');
  assert.equal(fireReplay.order.id, 'first-server-order');
  assert.equal(fireReplay.order.acceptedAtMs, 3_500_010);
  assert.equal(fireReplay.order.audience.length, 1);

  const cancelled = mod.cancelDefenseOrder(firstFire.state, {
    mutationId: 'cancel-retry', orderId: 'first-server-order', orderRevision: 1,
    cancelledAtMs: 3_501_000
  });
  const cancelReplay = mod.cancelDefenseOrder(cancelled.state, {
    mutationId: 'cancel-retry', orderId: 'first-server-order', orderRevision: 1,
    cancelledAtMs: 3_502_000
  });
  assert.equal(cancelReplay.ok, true);
  assert.equal(cancelReplay.replayed, true);
  assert.equal(cancelReplay.mutationId, 'cancel-retry');
  assert.equal(cancelReplay.state.lastTerminal.terminalAtMs, 3_501_000);
});

test('cross-round fire replay never mixes an old mutation outcome with the current active order', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 180, enemyMarchSeconds: 30 });
  state.players = { p1: player('One', 30) };
  const first = mod.createDefenseOrder(state, {
    mutationId: 'fire-cross-a', orderId: 'order-cross-a', configRevision: 1,
    signalAtMs: 3_600_000, acceptedAtMs: 3_600_010, connectedPids: ['p1']
  });
  const blockedRequest = {
    mutationId: 'fire-cross-blocked', orderId: 'ignored-server-id', configRevision: 1,
    signalAtMs: 3_600_020, acceptedAtMs: 3_600_030, connectedPids: ['p1']
  };
  const blocked = mod.createDefenseOrder(first.state, blockedRequest);
  assert.equal(blocked.error, 'order_active');
  assert.equal(blocked.activeOrderId, 'order-cross-a');
  assert.equal(blocked.activeOrder.revision, 1);

  const cancelled = mod.cancelDefenseOrder(blocked.state, {
    mutationId: 'cancel-cross-a', orderId: 'order-cross-a', orderRevision: 1,
    cancelledAtMs: 3_600_100
  });
  const current = mod.createDefenseOrder(cancelled.state, {
    mutationId: 'fire-cross-c', orderId: 'order-cross-c', configRevision: 1,
    signalAtMs: 3_601_000, acceptedAtMs: 3_601_010, connectedPids: ['p1']
  });
  assert.equal(current.order.revision, 3);

  const blockedReplay = mod.createDefenseOrder(current.state, blockedRequest);
  assert.equal(blockedReplay.replayed, true);
  assert.equal(blockedReplay.error, 'order_active');
  assert.equal(blockedReplay.activeOrderId, 'order-cross-a');
  assert.equal(blockedReplay.activeOrderRevision, 1);
  assert.equal(blockedReplay.activeOrder, null);
  assert.notEqual(blockedReplay.activeOrder, current.order);

  const successfulReplay = mod.createDefenseOrder(current.state, {
    mutationId: 'fire-cross-a', orderId: 'regenerated-id', configRevision: 1,
    signalAtMs: 3_600_000, acceptedAtMs: 9_999_999, connectedPids: []
  });
  assert.equal(successfulReplay.replayed, true);
  assert.equal(successfulReplay.orderId, 'order-cross-a');
  assert.equal(successfulReplay.revision, 1);
  assert.equal(successfulReplay.order, null);
});

test('captured removal queues until cancellation while a mid-order newcomer is purged immediately', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 180, enemyMarchSeconds: 30 });
  state.players = { captured: player('Captured', 30) };
  const created = mod.createDefenseOrder(state, {
    mutationId: 'fire-removal', orderId: 'order-removal', configRevision: 1,
    signalAtMs: 4_000_000, acceptedAtMs: 4_000_010, connectedPids: ['captured']
  });
  created.state.players.newcomer = player('Newcomer', 40);

  const queued = mod.removeDefensePlayer(created.state, 'captured');
  assert.equal(queued.ok, true);
  assert.equal(queued.pending, true);
  assert.deepEqual(queued.purgePids, []);
  assert.ok(queued.state.players.captured);
  assert.deepEqual(queued.state.pendingRemovalPids, ['captured']);
  assert.equal(queued.cardStatus, 'removal_applies_next_round');

  const immediate = mod.removeDefensePlayer(queued.state, 'newcomer');
  assert.equal(immediate.ok, true);
  assert.equal(immediate.pending, false);
  assert.deepEqual(immediate.purgePids, ['newcomer']);
  assert.equal(immediate.state.players.newcomer, undefined);

  const cancelled = mod.cancelDefenseOrder(immediate.state, {
    mutationId: 'cancel-removal', orderId: 'order-removal', orderRevision: 1,
    cancelledAtMs: 4_001_000
  });
  assert.equal(cancelled.ok, true);
  assert.deepEqual(cancelled.purgePids, ['captured']);
  assert.equal(cancelled.state.players.captured, undefined);
  assert.deepEqual(cancelled.state.pendingRemovalPids, []);
  assert.equal(cancelled.state.activeOrder, null);
  assert.deepEqual(cancelled.state.lastTerminal, {
    orderId: 'order-removal', revision: 2, status: 'cancelled', terminalAtMs: 4_001_000,
    purgePids: ['captured']
  });
  assert.equal(cancelled.state.orderRevision, 2);
  assert.equal(mod.nextDefenseWakeAt(cancelled.state), null);
});

test('cancellation rejects stale revisions and duplicate cancellation cannot resurrect or repurge', async () => {
  const { mod, state } = await configuredState();
  state.players = { p1: player('One', 30) };
  const created = mod.createDefenseOrder(state, {
    mutationId: 'fire-cancel', orderId: 'order-cancel', configRevision: 1,
    signalAtMs: 5_000_000, acceptedAtMs: 5_000_010, connectedPids: ['p1']
  });
  const stale = mod.cancelDefenseOrder(created.state, {
    mutationId: 'cancel-stale', orderId: 'order-cancel', orderRevision: 0,
    cancelledAtMs: 5_000_100
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'stale_order');
  assert.deepEqual(stale.state.activeOrder, created.order);

  const cancelled = mod.cancelDefenseOrder(created.state, {
    mutationId: 'cancel-good', orderId: 'order-cancel', orderRevision: 1,
    cancelledAtMs: 5_000_100
  });
  const replayed = mod.cancelDefenseOrder(cancelled.state, {
    mutationId: 'cancel-good', orderId: 'order-cancel', orderRevision: 1,
    cancelledAtMs: 5_000_100
  });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.purgePids, []);
  assert.equal(replayed.state.activeOrder, null);

  const staleCompletion = mod.completeDefenseOrder(cancelled.state, {
    orderId: 'order-cancel', orderRevision: 1, completedAtMs: 9_000_000
  });
  assert.equal(staleCompletion.ok, false);
  assert.equal(staleCompletion.error, 'stale_order');
  assert.deepEqual(staleCompletion.state.lastTerminal, cancelled.state.lastTerminal);
});

test('completion is due exactly at completeAtMs and atomically returns queued purge pids', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 5, enemyMarchSeconds: 5 });
  state.players = { p1: player('One', 5) };
  const created = mod.createDefenseOrder(state, {
    mutationId: 'fire-complete', orderId: 'order-complete', configRevision: 1,
    signalAtMs: 6_000_000, acceptedAtMs: 6_000_010, connectedPids: ['p1']
  });
  const queued = mod.removeDefensePlayer(created.state, 'p1');
  const early = mod.completeDefenseOrder(queued.state, {
    orderId: 'order-complete', orderRevision: 1,
    completedAtMs: created.order.completeAtMs - 1
  });
  assert.equal(early.ok, false);
  assert.equal(early.error, 'order_not_due');
  assert.equal(early.wakeAtMs, created.order.completeAtMs);

  const completed = mod.completeDefenseOrder(queued.state, {
    orderId: 'order-complete', orderRevision: 1,
    completedAtMs: created.order.completeAtMs
  });
  assert.equal(completed.ok, true);
  assert.deepEqual(completed.purgePids, ['p1']);
  assert.equal(completed.state.players.p1, undefined);
  assert.deepEqual(completed.state.lastTerminal, {
    orderId: 'order-complete', revision: 2, status: 'completed',
    terminalAtMs: created.order.completeAtMs, purgePids: ['p1']
  });

  const duplicate = mod.completeDefenseOrder(completed.state, {
    orderId: 'order-complete', orderRevision: 1,
    completedAtMs: created.order.completeAtMs + 1
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.replayed, true);
  assert.deepEqual(duplicate.purgePids, ['p1']);
});

test('terminal purge intent survives normalization and cancel replay for retryable atomic cleanup', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 180, enemyMarchSeconds: 30 });
  state.players = { p1: player('One', 30) };
  const created = mod.createDefenseOrder(state, {
    mutationId: 'fire-purge-retry', orderId: 'order-purge-retry', configRevision: 1,
    signalAtMs: 6_500_000, acceptedAtMs: 6_500_010, connectedPids: ['p1']
  });
  const queued = mod.removeDefensePlayer(created.state, 'p1');
  const cancelled = mod.cancelDefenseOrder(queued.state, {
    mutationId: 'cancel-purge-retry', orderId: 'order-purge-retry', orderRevision: 1,
    cancelledAtMs: 6_500_100
  });
  assert.deepEqual(cancelled.purgePids, ['p1']);
  assert.deepEqual(cancelled.state.lastTerminal.purgePids, ['p1']);

  const reloaded = mod.normalizeDefenseState(structuredClone(cancelled.state));
  const replayed = mod.cancelDefenseOrder(reloaded, {
    mutationId: 'cancel-purge-retry', orderId: 'order-purge-retry', orderRevision: 1,
    cancelledAtMs: 9_999_999
  });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.purgePids, ['p1']);
  assert.equal(replayed.state.players.p1, undefined);
  assert.deepEqual(replayed.state.lastTerminal.purgePids, ['p1']);
  assert.deepEqual(mod.publicDefenseSummary(replayed.state).lastTerminal, {
    orderId: 'order-purge-retry', revision: 2, status: 'cancelled', terminalAtMs: 6_500_100
  });

  const reusedPidState = structuredClone(replayed.state);
  reusedPidState.players.p1 = player('Replacement', 40);
  const staleReplay = mod.cancelDefenseOrder(reusedPidState, {
    mutationId: 'cancel-purge-retry', orderId: 'order-purge-retry', orderRevision: 1,
    cancelledAtMs: 10_000_000
  });
  assert.equal(staleReplay.replayed, true);
  assert.deepEqual(staleReplay.purgePids, [], 'an old purge retry cannot delete a newly registered profile');
  assert.equal(staleReplay.state.players.p1.name, 'Replacement');
});

test('public summary exposes frozen aggregate counts without roster or secret identity material', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 5, enemyMarchSeconds: 5 });
  state.players = {
    ready: player('Ready', 5, 1, { profileKey: 'secret-a' }),
    late: player('Late', 120, 2, { profileKeyHash: 'secret-b' }),
    offline: player('Offline', 30, 3),
    invalid: player('Invalid', 4, 4)
  };
  const created = mod.createDefenseOrder(state, {
    mutationId: 'fire-summary', orderId: 'order-summary', configRevision: 1,
    signalAtMs: 7_000_000, acceptedAtMs: 7_000_010,
    connectedPids: ['ready', 'late', 'invalid']
  });
  created.state.players.newcomer = player('Newcomer', 20);
  const summary = mod.publicDefenseSummary(created.state);
  assert.equal(summary.registeredProfiles, 5);
  assert.deepEqual(summary.activeOrder.counts, {
    registeredAtAcceptance: 4,
    targetedProfiles: 2,
    offlineRosterProfiles: 1,
    invalidTimeProfiles: 1,
    tooLateProfiles: 1
  });
  assert.equal(summary.activeOrder.id, 'order-summary');
  assert.equal(summary.activeOrder.revision, 1);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /"(?:Ready|Late|Offline|Invalid|Newcomer)"|secret|rosterAtAcceptance|audience|profileKey/
  );
});

test('order creation rejects stale config and unsafe timestamp arithmetic without mutating state', async () => {
  const { mod, state } = await configuredState({ tapAnchorSeconds: 300, enemyMarchSeconds: 120 });
  state.players = { p1: player('One', 30) };
  const before = structuredClone(state);
  const stale = mod.createDefenseOrder(state, {
    mutationId: 'fire-stale-config', orderId: 'order-stale', configRevision: 0,
    signalAtMs: 8_000_000, acceptedAtMs: 8_000_010, connectedPids: ['p1']
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'config_conflict');
  assert.deepEqual(state, before);

  const overflow = mod.createDefenseOrder(state, {
    mutationId: 'fire-overflow', orderId: 'order-overflow', configRevision: 1,
    signalAtMs: Number.MAX_SAFE_INTEGER - 1_000,
    acceptedAtMs: Number.MAX_SAFE_INTEGER - 500,
    connectedPids: ['p1']
  });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error, 'invalid_time');
  assert.deepEqual(state, before);
});
