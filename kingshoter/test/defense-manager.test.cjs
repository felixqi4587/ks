const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUmd(file) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, globalThis: {},
    Object, Array, String, Number, Boolean, JSON, Math, RegExp,
    Map, Set, Date, TypeError, Error
  }, { filename: file });
  return module.exports;
}

const DefenseManager = loadUmd(path.join(__dirname, '../public/defense-manager.js'));
const DEVICE_ID = '30000000-0000-4000-8000-000000000003';

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function player(index, overrides = {}) {
  return {
    pid: `p${String(index).padStart(3, '0')}`,
    identityMode: index % 2 ? 'nickname' : 'playerId',
    playerId: index % 2 ? undefined : String(900000000 + index),
    name: index % 2 ? `Player ${index}` : `Kimchi ${index}`,
    march: 20 + index,
    revision: 0,
    profileGeneration: index + 1,
    pendingRemoval: false,
    connectedDevices: 1,
    audioReadyDevices: 1,
    clockFreshDevices: 1,
    readyDevices: 1,
    activeRound: null,
    ...overrides
  };
}

function capturedPlayer(index, overrides = {}) {
  const row = player(index);
  return player(index, {
    activeRound: {
      displayName: row.name,
      identityMode: row.identityMode,
      playerId: row.playerId,
      march: row.march,
      marchRevision: row.revision,
      connectedAtAcceptance: true,
      validAtAcceptance: true,
      targeted: true,
      goAtMs: 1_120_000 + index * 1000,
      tooLate: false,
      outcome: 'unconfirmed',
      acknowledgedDevices: 0,
      scheduledDevices: 0,
      deliveredScheduled: false,
      audioReady: false
    },
    ...overrides
  });
}

function managerState(overrides = {}) {
  const items = overrides.items || [player(0), player(1)];
  const page = overrides.page || 1;
  const total = overrides.total == null ? items.length : overrides.total;
  const totalPages = overrides.totalPages == null ? Math.max(1, Math.ceil(total / 50)) : overrides.totalPages;
  const rosterRevision = overrides.rosterRevision == null ? 7 : overrides.rosterRevision;
  const orderRevision = overrides.orderRevision == null ? 4 : overrides.orderRevision;
  return {
    t: 'defenseManagerState',
    config: { tapAnchorSeconds: 180, enemyMarchSeconds: 30, revision: 2, updatedAt: null },
    counts: {
      registeredProfiles: total, connectedProfiles: total,
      audioReadyProfiles: total, readyProfiles: total, pendingRemovalProfiles: 0
    },
    issues: [], distribution: [], activeOrder: null,
    playersPage: {
      page, pageSize: 50, total, totalPages,
      rosterRevision, baseRosterRevision: rosterRevision, baseOrderRevision: orderRevision,
      items
    },
    managerClockFresh: false, managerLeaseUntilMs: 0,
    rosterRevision, orderRevision,
    ...overrides
  };
}

function fixture(options = {}) {
  let nowMs = options.nowMs == null ? 1_000_000 : options.nowMs;
  let connected = false;
  let clock = {
    fresh: options.clockFresh !== false,
    sampledAtMs: nowMs - 10,
    offsetMs: 12
  };
  const sent = [];
  const intervals = new Map();
  const timeouts = new Map();
  const changes = [];
  let nextInterval = 1;
  let nextTimeout = 1;
  const ids = Array.from({ length: 20 }, (_, index) => `mutation-${index + 1}`);
  const transport = {
    send(message) { sent.push(plain(message)); return connected; },
    connected() { return connected; },
    serverNowMs() { return nowMs; },
    generation() { return 1; }
  };
  const controller = DefenseManager.createDefenseManager({
    transport,
    deviceId: () => DEVICE_ID,
    randomUUID: () => ids.shift(),
    setInterval(callback, delay) {
      const id = nextInterval++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) {
      const id = nextTimeout++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    nowMs: () => nowMs,
    ownsHandshake: options.ownsHandshake,
    onStateChange(next) { changes.push(plain(next)); }
  });
  return {
    controller, sent, intervals, timeouts, changes,
    connect() {
      connected = true;
      controller.connectionChanged({ connected: true, generation: 1 });
    },
    disconnect() {
      connected = false;
      controller.connectionChanged({ connected: false, generation: 1 });
    },
    clock(next = {}) {
      clock = { ...clock, ...next };
      controller.clockChanged(clock);
    },
    setNow(value) { nowMs = value; },
    fireIntervals() { for (const value of [...intervals.values()]) value.callback(); },
    fireTimeouts() {
      for (const [id, value] of [...timeouts.entries()]) {
        timeouts.delete(id);
        value.callback();
      }
    },
    handshake(frame = managerState()) {
      controller.handleMessage(frame);
    },
    authorize(frame = managerState()) {
      controller.handleMessage(frame);
      controller.handleMessage({
        t: 'defenseManagerStatusSaved', managerClockFresh: true,
        managerLeaseUntilMs: nowMs + 70_000, orderRevision: frame.orderRevision
      });
    }
  };
}

test('shared-connection manager mode leaves hello ownership to the ordinary Defense controller', () => {
  const h = fixture({ ownsHandshake: false });
  h.connect();
  assert.equal(h.sent.some(frame => frame.t === 'hello'), false);
});

test('a newly fresh shared clock refreshes manager status immediately instead of waiting 20 seconds', () => {
  const h = fixture({ clockFresh: false });
  h.connect();
  h.clock({ fresh: false });
  h.controller.unlock('qa');
  h.controller.handleMessage(managerState());
  assert.equal(h.sent.at(-1).clockFresh, false);
  h.controller.handleMessage({
    t: 'defenseManagerStatusSaved', managerClockFresh: false,
    managerLeaseUntilMs: 1_070_000, orderRevision: 4
  });
  h.clock({ fresh: true, sampledAtMs: 999_999, offsetMs: 8 });
  assert.deepEqual(h.sent.at(-1), {
    t: 'defenseManagerStatus', deviceId: DEVICE_ID, clockFresh: true,
    clockSampleAtMs: 999_999, clockOffsetMs: 8
  });
});

test('manager player projection supports truth filters, search, active GO sorting, and duplicate labels', () => {
  const rows = [
    player(1, { name: 'Same', march: 60, connectedDevices: 0, readyDevices: 0, audioReadyDevices: 0 }),
    player(2, { name: 'Same', march: 20, readyDevices: 0, audioReadyDevices: 0 }),
    player(3, { name: 'Other', march: null, readyDevices: 0 }),
    player(4, {
      name: 'Wave', march: 40,
      activeRound: { targeted: true, goAtMs: 1_100_000, tooLate: false, outcome: 'unconfirmed' }
    }),
    player(5, {
      name: 'Late', march: 30,
      activeRound: { targeted: true, goAtMs: 1_090_000, tooLate: true, outcome: 'too_late' }
    })
  ];
  assert.deepEqual(plain(DefenseManager.projectPlayers(rows, {
    query: 'same', filter: 'all', sort: 'march', active: false
  })).map(row => [row.pid, row.displayLabel]), [
    ['p002', 'Same · p002'], ['p001', 'Same · p001']
  ]);
  assert.deepEqual(plain(DefenseManager.projectPlayers(rows, {
    query: '', filter: 'offline', sort: 'name', active: false
  })).map(row => row.pid), ['p001']);
  assert.deepEqual(plain(DefenseManager.projectPlayers(rows, {
    query: '', filter: 'invalid', sort: 'name', active: false
  })).map(row => row.pid), ['p003']);
  assert.deepEqual(plain(DefenseManager.projectPlayers(rows, {
    query: '', filter: 'too_late', sort: 'go', active: true
  })).map(row => row.pid), ['p005']);
  assert.deepEqual(plain(DefenseManager.projectPlayers(rows, {
    query: '', filter: 'unconfirmed', sort: 'go', active: true
  })).map(row => row.pid), ['p004']);
});

test('manager status projection groups next alert waves without claiming game participation', () => {
  const rows = [
    player(1, { activeRound: { targeted: true, goAtMs: 1_020_010, tooLate: false, outcome: 'scheduled' } }),
    player(2, { activeRound: { targeted: true, goAtMs: 1_020_490, tooLate: false, outcome: 'unconfirmed' } }),
    player(3, { activeRound: { targeted: true, goAtMs: 1_025_000, tooLate: false, outcome: 'audio_unready' } })
  ];
  const projected = plain(DefenseManager.projectStatus({
    nowMs: 1_000_000,
    snapshot: managerState({
      items: rows,
      activeOrder: {
        id: 'order-1', revision: 4, enemyImpactAtMs: 1_080_000,
        counts: { targetedProfiles: 3, offlineRosterProfiles: 0, invalidTimeProfiles: 0, tooLateProfiles: 0 },
        delivery: { targetedProfiles: 3, deliveredScheduledProfiles: 1, audioReadyProfiles: 1, redUnconfirmedProfiles: 2 }
      }
    }),
    players: rows
  }));
  assert.equal(projected.expectedImpactAtMs, 1_080_000);
  assert.deepEqual(projected.waves.map(wave => [wave.goAtMs, wave.profiles]), [
    [1_020_000, 2], [1_025_000, 1]
  ]);
  assert.equal(projected.nextWave.goAtMs, 1_020_000);
  assert.match(projected.disclaimer, /website delivery/i);
  assert.doesNotMatch(projected.disclaimer, /participated|defended|arrived/i);
});

test('all targeted non-late profiles without canonical scheduled delivery are unconfirmed', () => {
  for (const outcome of ['unconfirmed', 'schedule_failed', 'clock_stale', 'audio_unready']) {
    const flags = plain(DefenseManager.playerFlags(capturedPlayer(1, {
      activeRound: { ...capturedPlayer(1).activeRound, outcome, deliveredScheduled: false }
    })));
    assert.equal(flags.unconfirmed, true, outcome);
  }
  assert.equal(DefenseManager.playerFlags(capturedPlayer(2, {
    activeRound: { ...capturedPlayer(2).activeRound, outcome: 'scheduled', deliveredScheduled: true }
  })).unconfirmed, false);
  assert.equal(DefenseManager.playerFlags(capturedPlayer(3, {
    activeRound: { ...capturedPlayer(3).activeRound, tooLate: true, outcome: 'too_late' }
  })).unconfirmed, false);
});

test('Chinese active target metric describes the round audience, not game delivery', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/defense-manager.js'), 'utf8');
  assert.match(source, /metricTargeted:\s*"本轮目标"/);
});

test('ACK receipts are exact to the active order and update Status delivery aggregates atomically', () => {
  const rows = [capturedPlayer(1), capturedPlayer(2)];
  const active = {
    id: 'order-5', revision: 5, enemyImpactAtMs: 1_240_000,
    counts: { targetedProfiles: 2, offlineRosterProfiles: 0, invalidTimeProfiles: 0, tooLateProfiles: 0 },
    delivery: {
      targetedProfiles: 2, deliveredScheduledProfiles: 0,
      audioReadyProfiles: 0, redUnconfirmedProfiles: 2
    }
  };
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa');
  h.authorize(managerState({ items: rows, activeOrder: active, orderRevision: 5 }));
  const receipt = {
    t: 'defenseAckSaved', orderId: active.id, revision: active.revision, pid: rows[0].pid,
    profileDelivery: {
      pid: rows[0].pid, goAtMs: rows[0].activeRound.goAtMs, tooLate: false,
      outcome: 'scheduled', acknowledgedDevices: 1, scheduledDevices: 1,
      deliveredScheduled: true, audioReady: true
    }
  };
  const before = plain(h.controller.state());
  assert.equal(h.controller.handleMessage({ ...receipt, orderId: 'stale-order', revision: 4 }), false);
  assert.deepEqual(plain(h.controller.state().activeOrder.delivery), before.activeOrder.delivery);
  assert.equal(h.controller.state().players[0].activeRound.deliveredScheduled, false);

  assert.equal(h.controller.handleMessage(receipt), true);
  const state = h.controller.state();
  assert.equal(state.players[0].activeRound.deliveredScheduled, true);
  assert.deepEqual(plain(state.activeOrder.delivery), {
    targetedProfiles: 2, deliveredScheduledProfiles: 1,
    audioReadyProfiles: 1, redUnconfirmedProfiles: 1
  });
  const status = plain(DefenseManager.projectStatus({
    nowMs: 1_000_000, snapshot: state.snapshot, players: state.players
  }));
  assert.equal(status.delivery.deliveredScheduledProfiles, 1);
  assert.deepEqual(status.issues.map(issue => [issue.code, issue.count]), [
    ['red_unconfirmed', 1]
  ]);
});

test('waiting status derives exception-first truth and march distribution from the hydrated roster', () => {
  const rows = [
    player(1, { march: 30 }),
    player(2, { march: 30, readyDevices: 0, audioReadyDevices: 0 }),
    player(3, { march: 40, connectedDevices: 0, readyDevices: 0, audioReadyDevices: 0 }),
    player(4, { march: null, readyDevices: 0 })
  ];
  const projected = plain(DefenseManager.projectStatus({
    nowMs: 1_000_000,
    snapshot: managerState({
      items: rows,
      counts: {
        registeredProfiles: 4, connectedProfiles: 3,
        audioReadyProfiles: 2, readyProfiles: 1, pendingRemovalProfiles: 0
      }
    }),
    players: rows
  }));
  assert.deepEqual(projected.waiting, {
    registered: 4, connected: 3, audioReady: 2, ready: 1,
    red: 2, offline: 1, invalid: 1
  });
  assert.deepEqual(projected.issues.map(issue => [issue.code, issue.count]), [
    ['red_unconfirmed', 2], ['offline_roster', 1], ['invalid_time', 1]
  ]);
  assert.deepEqual(projected.distribution.map(group => [group.march, group.profiles]), [
    [30, 2], [40, 1]
  ]);
});

test('canonical zero waiting counts never fall back to a stale visible roster', () => {
  const projected = plain(DefenseManager.projectStatus({
    nowMs: 1_000_000,
    snapshot: managerState({
      items: [], total: 0, totalPages: 1,
      counts: {
        registeredProfiles: 0, connectedProfiles: 0,
        audioReadyProfiles: 0, readyProfiles: 0, pendingRemovalProfiles: 0
      }
    }),
    players: [player(1), player(2)]
  }));
  assert.deepEqual(projected.waiting, {
    registered: 0, connected: 0, audioReady: 0, ready: 0,
    red: 0, offline: 0, invalid: 0
  });
});

test('unlock is retained in page memory and exact lease receipts make the manager ready', () => {
  const h = fixture();
  h.connect();
  h.clock();
  h.controller.handleMessage({ t: 'defenseState', config: {}, ownProfile: null, orderRevision: 0 });
  assert.deepEqual(plain(h.controller.unlock('qa')), { ok: true });
  assert.deepEqual(h.sent.at(-1), { t: 'defenseUnlock', password: 'qa' });
  h.controller.handleMessage(managerState());
  assert.equal(h.controller.state().authorized, true);
  assert.deepEqual(h.sent.at(-1), {
    t: 'defenseManagerStatus', deviceId: DEVICE_ID, clockFresh: true,
    clockSampleAtMs: 999990, clockOffsetMs: 12
  });
  assert.equal([...h.intervals.values()][0].delay, 20_000);
  assert.equal(h.controller.state().managerReady, false, 'a snapshot is not the exact lease receipt');
  h.controller.handleMessage({
    t: 'defenseManagerStatusSaved', managerClockFresh: true,
    managerLeaseUntilMs: 1_070_000, orderRevision: 4
  });
  assert.equal(h.controller.state().managerReady, true);
  h.fireIntervals();
  assert.equal(h.controller.state().managerReady, true,
    'renewing a still-valid exact lease does not create a false red gap before its next receipt');

  h.disconnect();
  assert.equal(h.intervals.size, 0);
  h.connect();
  assert.deepEqual(h.sent.slice(-2), [
    { t: 'hello' }, { t: 'defenseUnlock', password: 'qa' }
  ], 'reconnect automatically reuses only the successful in-memory password');
});

test('manager lease expiry publishes an immediate false readiness projection', () => {
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa'); h.authorize();
  assert.equal(h.controller.state().managerReady, true);
  assert.equal([...h.timeouts.values()].at(-1).delay, 70_000);
  const priorChanges = h.changes.length;
  h.setNow(1_070_000);
  h.fireTimeouts();
  assert.equal(h.controller.state().managerReady, false);
  assert.ok(h.changes.length > priorChanges, 'lease expiry drives the UI state callback');
  assert.equal(h.changes.at(-1).managerReady, false);
});

test('unlock is serialized so one response cannot bind the wrong pending password', () => {
  const h = fixture();
  h.connect();
  assert.deepEqual(plain(h.controller.unlock('first')), { ok: true });
  assert.deepEqual(plain(h.controller.unlock('second')), { ok: false, error: 'operation_pending' });
  assert.equal(h.sent.filter(frame => frame.t === 'defenseUnlock').length, 1);
  assert.equal(h.controller.state().unlockPending, true);
  h.controller.handleMessage(managerState());
  assert.equal(h.controller.state().unlockPending, false);
});

test('config waits for the exact targeted receipt and preserves a stale draft for explicit retry', () => {
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa'); h.authorize();
  h.controller.setConfigDraft({ tapAnchorSeconds: 150, enemyMarchSeconds: 45 });
  assert.deepEqual(plain(h.controller.saveConfig()), { ok: true, mutationId: 'mutation-1' });
  assert.deepEqual(h.sent.at(-1), {
    t: 'setDefenseConfig', password: 'qa', mutationId: 'mutation-1',
    baseRevision: 2, tapAnchorSeconds: 150, enemyMarchSeconds: 45
  });
  h.controller.handleMessage(managerState({
    config: { tapAnchorSeconds: 150, enemyMarchSeconds: 45, revision: 3, updatedAt: 'later' }
  }));
  assert.equal(h.controller.state().pendingConfig.mutationId, 'mutation-1');
  h.controller.handleMessage({
    t: 'defenseConfigSaved', mutationId: 'someone-else', revision: 3,
    config: { tapAnchorSeconds: 150, enemyMarchSeconds: 45, revision: 3 }
  });
  assert.equal(h.controller.state().pendingConfig.mutationId, 'mutation-1');
  h.controller.handleMessage({
    t: 'error', source: 'setDefenseConfig', mutationId: 'mutation-1',
    error: 'revision_conflict', canonicalRevision: 3
  });
  assert.equal(h.controller.state().pendingConfig, null);
  assert.deepEqual(plain(h.controller.state().configDraft), {
    tapAnchorSeconds: 150, enemyMarchSeconds: 45
  });
  assert.equal(h.controller.state().configConflict, true);
  assert.deepEqual(plain(h.controller.saveConfig()), { ok: true, mutationId: 'mutation-2' });
  assert.equal(h.sent.at(-1).baseRevision, 3);
  h.controller.handleMessage({
    t: 'defenseConfigSaved', mutationId: 'mutation-2', revision: 4,
    config: { tapAnchorSeconds: 150, enemyMarchSeconds: 45, revision: 4 }
  });
  assert.equal(h.controller.state().pendingConfig, null);
  assert.equal(h.controller.state().configConflict, false);
});

test('reconnect replays an unreceipted idempotent config mutation after automatic re-unlock', () => {
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa'); h.authorize();
  h.controller.setConfigDraft({ tapAnchorSeconds: 160, enemyMarchSeconds: 50 });
  h.controller.saveConfig();
  assert.equal(JSON.stringify(h.controller.state()).includes('"password"'), false,
    'public manager state never exposes the retained room password');
  const original = h.sent.findLast(frame => frame.t === 'setDefenseConfig');
  h.disconnect();
  h.connect();
  h.controller.handleMessage(managerState());
  const retries = h.sent.filter(frame => frame.t === 'setDefenseConfig');
  assert.equal(retries.length, 2);
  assert.deepEqual(retries[1], original,
    'the same mutation id is replayed so the server can replenish its exact receipt');
  h.controller.handleMessage({
    t: 'defenseConfigSaved', mutationId: original.mutationId, revision: 3,
    config: { tapAnchorSeconds: 160, enemyMarchSeconds: 50, revision: 3 }
  });
  assert.equal(h.controller.state().pendingConfig, null);
});

test('Fire is one click, captures server time, and remains locked until canonical acceptance or rejection', () => {
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa'); h.authorize();
  assert.deepEqual(plain(h.controller.fire()), { ok: true, mutationId: 'mutation-1' });
  assert.deepEqual(h.sent.at(-1), {
    t: 'fireDefense', password: 'qa', mutationId: 'mutation-1',
    configRevision: 2, signalAtMs: 1_000_000
  });
  assert.deepEqual(plain(h.controller.fire()), { ok: false, error: 'operation_pending' });
  h.controller.handleMessage({ t: 'defenseOrderAccepted', order: {
    id: 'order-1', revision: 5, signalAtMs: 1_000_000,
    acceptedAtMs: 1_000_005, enemyImpactAtMs: 1_240_000,
    counts: {}, delivery: {}
  } });
  assert.equal(h.controller.state().pendingFire, null);
  assert.equal(h.controller.state().activeOrder.id, 'order-1');
  assert.deepEqual(plain(h.controller.fire()), { ok: false, error: 'order_active' });
});

test('lost Fire acceptance replays the same idempotent request after reconnect', () => {
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa'); h.authorize();
  h.controller.fire();
  const original = h.sent.findLast(frame => frame.t === 'fireDefense');
  h.disconnect(); h.connect(); h.controller.handleMessage(managerState());
  const retries = h.sent.filter(frame => frame.t === 'fireDefense');
  assert.equal(retries.length, 2);
  assert.deepEqual(retries[1], original);
  assert.equal(JSON.stringify(h.controller.state()).includes('"password"'), false);
});

test('canonical reconnect state settles pending Fire and rejects stale acceptance revisions', () => {
  const active = {
    id: 'canonical-order', revision: 5, signalAtMs: 1_000_000,
    enemyImpactAtMs: 1_240_000, counts: {}, delivery: {}
  };
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa'); h.authorize();
  h.controller.fire();
  h.disconnect(); h.connect(); h.controller.handleMessage(managerState({ activeOrder: active, orderRevision: 5 }));
  assert.equal(h.controller.state().pendingFire, null);
  assert.equal(h.sent.filter(frame => frame.t === 'fireDefense').length, 1,
    'canonical active state settles Fire without replay');
  h.controller.handleMessage({
    t: 'defenseOrderCancelled', orderId: active.id, revision: 6
  });
  assert.equal(h.controller.state().activeOrder, null);
  assert.equal(h.controller.handleMessage({
    t: 'defenseOrderAccepted', order: {
      id: 'late-order', revision: 5, signalAtMs: 999_000,
      enemyImpactAtMs: 1_200_000, counts: {}, delivery: {}
    }
  }), false);
  assert.equal(h.controller.state().activeOrder, null,
    'late lower-revision acceptance cannot resurrect a terminal order');
});

test('confirmed cancel settles only on the matching terminal and preserves config and players', () => {
  const active = {
    id: 'order-1', revision: 5, enemyImpactAtMs: 1_240_000,
    counts: {}, delivery: {}
  };
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa');
  h.authorize(managerState({ activeOrder: active, orderRevision: 5 }));
  assert.deepEqual(plain(h.controller.cancel(false)), { ok: false, error: 'confirmation_required' });
  assert.deepEqual(plain(h.controller.cancel(true)), { ok: true, mutationId: 'mutation-1' });
  assert.deepEqual(h.sent.at(-1), {
    t: 'cancelDefense', password: 'qa', mutationId: 'mutation-1',
    orderId: 'order-1', orderRevision: 5
  });
  h.controller.handleMessage({ t: 'defenseOrderCancelled', orderId: 'wrong', revision: 6 });
  assert.ok(h.controller.state().pendingCancel);
  h.controller.handleMessage({ t: 'defenseOrderCancelled', orderId: 'order-1', revision: 6 });
  const state = h.controller.state();
  assert.equal(state.pendingCancel, null);
  assert.equal(state.activeOrder, null);
  assert.equal(state.config.revision, 2);
  assert.equal(state.players.length, 2);
});

test('pending cancel and player mutations replay or settle from canonical reconnect state', () => {
  const active = {
    id: 'order-1', revision: 5, enemyImpactAtMs: 1_240_000,
    counts: {}, delivery: {}
  };
  const cancel = fixture();
  cancel.connect(); cancel.clock(); cancel.controller.unlock('qa');
  cancel.authorize(managerState({ activeOrder: active, orderRevision: 5 }));
  cancel.controller.cancel(true);
  const cancelRequest = cancel.sent.findLast(frame => frame.t === 'cancelDefense');
  cancel.disconnect(); cancel.connect();
  cancel.controller.handleMessage(managerState({ activeOrder: active, orderRevision: 5 }));
  assert.deepEqual(cancel.sent.filter(frame => frame.t === 'cancelDefense').at(-1), cancelRequest);
  cancel.disconnect(); cancel.connect(); cancel.controller.handleMessage(managerState({
    activeOrder: null, orderRevision: 6
  }));
  assert.equal(cancel.controller.state().pendingCancel, null,
    'canonical terminal state settles an unreceipted cancel');

  const edit = fixture();
  edit.connect(); edit.clock(); edit.controller.unlock('qa'); edit.authorize();
  edit.controller.setPlayerMarch('p000', 44);
  const editRequest = edit.sent.findLast(frame => frame.t === 'setDefensePlayerMarch');
  edit.disconnect(); edit.connect(); edit.controller.handleMessage(managerState());
  assert.deepEqual(edit.sent.filter(frame => frame.t === 'setDefensePlayerMarch').at(-1), editRequest);
});

test('150-player hydration is atomic and restarts when roster or order epochs change', () => {
  const first = Array.from({ length: 50 }, (_, index) => player(index));
  const second = Array.from({ length: 50 }, (_, index) => player(index + 50));
  const third = Array.from({ length: 50 }, (_, index) => player(index + 100));
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa');
  h.controller.handleMessage(managerState({ items: first, total: 150, totalPages: 3 }));
  assert.equal(h.controller.state().rosterHydrated, false);
  assert.equal(h.controller.state().players.length, 0,
    'partial scans never replace the last complete visible roster');
  assert.deepEqual(h.sent.findLast(frame => frame.t === 'getDefenseManagerPlayersPage'), {
    t: 'getDefenseManagerPlayersPage', page: 2,
    baseRosterRevision: 7, baseOrderRevision: 4
  });
  h.controller.handleMessage({
    t: 'defenseManagerPlayersPage', rosterRevision: 7, orderRevision: 4,
    playersPage: {
      page: 2, pageSize: 50, total: 150, totalPages: 3,
      rosterRevision: 7, baseRosterRevision: 7, baseOrderRevision: 4, items: second
    }
  });
  assert.equal(h.controller.state().players.length, 0);
  assert.equal(h.sent.at(-1).page, 3);
  h.controller.handleMessage({
    t: 'defenseManagerPlayersPage', rosterRevision: 7, orderRevision: 4,
    playersPage: {
      page: 3, pageSize: 50, total: 150, totalPages: 3,
      rosterRevision: 7, baseRosterRevision: 7, baseOrderRevision: 4, items: third
    }
  });
  assert.equal(h.controller.state().rosterHydrated, true);
  assert.equal(h.controller.state().players.length, 150);
  assert.equal(new Set(h.controller.state().players.map(row => row.pid)).size, 150);

  h.controller.handleMessage({
    t: 'defenseProfileDelta', rosterRevision: 8, mutationId: 'external',
    pid: 'p000', removed: true, pending: false, profile: null
  });
  assert.equal(h.controller.state().rosterHydrated, false);
  assert.deepEqual(h.sent.at(-1), { t: 'getDefenseManagerPlayersPage', page: 1 });
  h.controller.handleMessage({
    t: 'error', source: 'getDefenseManagerPlayersPage', error: 'order_conflict',
    canonicalRosterRevision: 8, canonicalOrderRevision: 5
  });
  assert.deepEqual(h.sent.at(-1), { t: 'getDefenseManagerPlayersPage', page: 1 });
});

test('hydration journals same-epoch realtime deltas and preserves the old epoch during removal', () => {
  const first = Array.from({ length: 50 }, (_, index) => player(index));
  const second = Array.from({ length: 50 }, (_, index) => player(index + 50));
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa');
  h.controller.handleMessage(managerState({ items: first, total: 100, totalPages: 2 }));
  h.controller.handleMessage({
    t: 'defensePresenceDelta', pid: 'p000', connectedDevices: 0,
    audioReadyDevices: 0, clockFreshDevices: 0, readyDevices: 0
  });
  h.controller.handleMessage({
    t: 'defenseProfileDelta', mutationId: 'external-edit', rosterRevision: 7,
    profile: { ...player(60), march: 55, revision: 1 }
  });
  h.controller.handleMessage({
    t: 'defenseManagerPlayersPage', rosterRevision: 7, orderRevision: 4,
    playersPage: {
      page: 2, pageSize: 50, total: 100, totalPages: 2,
      rosterRevision: 7, baseRosterRevision: 7, baseOrderRevision: 4, items: second
    }
  });
  assert.equal(h.controller.state().players.find(row => row.pid === 'p000').connectedDevices, 0);
  assert.equal(h.controller.state().players.find(row => row.pid === 'p060').march, 55);

  h.controller.removePlayer('p001', true);
  h.controller.handleMessage({
    t: 'defenseProfileDelta', mutationId: 'mutation-1', rosterRevision: 8,
    pid: 'p001', removed: true, pending: false, profile: null
  });
  assert.equal(h.controller.state().rosterHydrated, false);
  assert.ok(h.controller.state().players.some(row => row.pid === 'p001'),
    'old complete epoch remains visible until the replacement epoch is fully hydrated');
});

test('an ACK journal deep-merges activeRound without losing immutable audience metadata', () => {
  const first = Array.from({ length: 50 }, (_, index) => capturedPlayer(index));
  const second = Array.from({ length: 50 }, (_, index) => capturedPlayer(index + 50));
  const active = {
    id: 'order-5', revision: 5, enemyImpactAtMs: 1_240_000,
    counts: { targetedProfiles: 100 },
    delivery: {
      targetedProfiles: 100, deliveredScheduledProfiles: 0,
      audioReadyProfiles: 0, redUnconfirmedProfiles: 100
    }
  };
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa');
  h.controller.handleMessage(managerState({
    items: first, total: 100, totalPages: 2, activeOrder: active, orderRevision: 5
  }));
  const target = second[10];
  assert.equal(h.controller.handleMessage({
    t: 'defenseAckSaved', orderId: active.id, revision: active.revision, pid: target.pid,
    profileDelivery: {
      pid: target.pid, goAtMs: target.activeRound.goAtMs, tooLate: false,
      outcome: 'scheduled', acknowledgedDevices: 1, scheduledDevices: 1,
      deliveredScheduled: true, audioReady: true
    }
  }), true);
  h.controller.handleMessage({
    t: 'defenseManagerPlayersPage', rosterRevision: 7, orderRevision: 5,
    playersPage: {
      page: 2, pageSize: 50, total: 100, totalPages: 2,
      rosterRevision: 7, baseRosterRevision: 7, baseOrderRevision: 5, items: second
    }
  });
  const merged = h.controller.state().players.find(row => row.pid === target.pid).activeRound;
  assert.equal(merged.deliveredScheduled, true);
  assert.equal(merged.targeted, true);
  assert.equal(merged.connectedAtAcceptance, true);
  assert.equal(merged.validAtAcceptance, true);
  assert.equal(merged.displayName, target.activeRound.displayName);
  assert.equal(merged.goAtMs, target.activeRound.goAtMs);
});

test('profileGeneration protects manager edit/remove and manager code has no audio scheduler dependency', () => {
  const h = fixture();
  h.connect(); h.clock(); h.controller.unlock('qa'); h.authorize();
  assert.deepEqual(plain(h.controller.setPlayerMarch('p000', 44)), {
    ok: true, mutationId: 'mutation-1'
  });
  assert.deepEqual(h.sent.at(-1), {
    t: 'setDefensePlayerMarch', password: 'qa', mutationId: 'mutation-1',
    pid: 'p000', profileGeneration: 1, baseRevision: 0, march: 44
  });
  h.controller.handleMessage({
    t: 'defenseProfileDelta', mutationId: 'mutation-1', rosterRevision: 7,
    profile: { ...player(0), march: 44, revision: 1 }
  });
  assert.equal(h.controller.state().pendingPlayerMutation, null);
  assert.deepEqual(plain(h.controller.removePlayer('p001', false)), {
    ok: false, error: 'confirmation_required'
  });
  assert.deepEqual(plain(h.controller.removePlayer('p001', true)), {
    ok: true, mutationId: 'mutation-2'
  });
  assert.deepEqual(h.sent.at(-1), {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'mutation-2',
    pid: 'p001', profileGeneration: 2, baseRevision: 4
  });
  h.controller.handleMessage({
    t: 'error', source: 'removeDefensePlayer', mutationId: 'mutation-2',
    error: 'profile_generation_conflict', canonicalProfileGeneration: 9
  });
  assert.equal(h.controller.state().pendingPlayerMutation, null);
  assert.equal(h.controller.state().lastError.error, 'profile_generation_conflict');

  const source = fs.readFileSync(path.join(__dirname, '../public/defense-manager.js'), 'utf8');
  assert.doesNotMatch(source, /BattleAudio|BattleCues|createCueScheduler|\.play(?:Go|Beep|Count)/);
});
