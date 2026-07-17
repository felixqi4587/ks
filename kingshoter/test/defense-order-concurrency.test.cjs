const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadRoom, createRoomHarness } = require('./room-harness.cjs');

const PROFILE_KEYS = {
  p1: '11000000-0000-4000-8000-000000000001',
  p2: '22000000-0000-4000-8000-000000000002',
  offline: '33000000-0000-4000-8000-000000000003',
  newcomer: '44000000-0000-4000-8000-000000000004'
};
const DEVICES = {
  manager: '55000000-0000-4000-8000-000000000005',
  manager2: '66000000-0000-4000-8000-000000000006',
  p1a: '77000000-0000-4000-8000-000000000007',
  p1b: '88000000-0000-4000-8000-000000000008',
  p2: '99000000-0000-4000-8000-000000000009',
  newcomer: 'aa000000-0000-4000-8000-00000000000a'
};

async function send(harness, socket, message) {
  await harness.room.webSocketMessage(socket, JSON.stringify(message));
}

function frames(sent, type) {
  return sent.filter(frame => frame.t === type);
}

function lastFrame(sent, type) {
  return frames(sent, type).at(-1);
}

function wireBytes(frame) {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

async function handshake(harness, socket, sent) {
  await send(harness, socket, { t: 'hello' });
  assert.ok(lastFrame(sent, 'defenseState'));
  sent.length = 0;
}

async function unlock(harness, socket, sent, password = 'qa') {
  await send(harness, socket, { t: 'defenseUnlock', password });
  return lastFrame(sent, 'defenseManagerState');
}

async function managerStatus(harness, socket, deviceId = DEVICES.manager, clockFresh = true) {
  await send(harness, socket, {
    t: 'defenseManagerStatus', deviceId, clockFresh,
    clockSampleAtMs: harness.room.nowMs(), clockOffsetMs: 0
  });
}

async function configure(harness, socket, input = {}) {
  await send(harness, socket, {
    t: 'setDefenseConfig', password: 'qa', mutationId: input.mutationId || 'config-1',
    baseRevision: input.baseRevision == null ? 0 : input.baseRevision,
    tapAnchorSeconds: input.tapAnchorSeconds == null ? 5 : input.tapAnchorSeconds,
    enemyMarchSeconds: input.enemyMarchSeconds == null ? 60 : input.enemyMarchSeconds
  });
}

async function setupManager(Room, options = {}) {
  const h = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}, nowMs: options.nowMs || 1_000_000,
    useRealSchedule: options.useRealSchedule === true
  });
  await handshake(h, h.ws, h.sent);
  assert.ok(await unlock(h, h.ws, h.sent));
  h.sent.length = 0;
  return h;
}

async function addPlayer(harness, {
  pid, key, march, deviceId, soundReady = true, clockFresh = true, connect = true
}) {
  const socket = harness.addSocket('defense');
  await handshake(harness, socket.ws, socket.sent);
  await send(harness, socket.ws, {
    t: 'registerPlayer', registrationId: `register-${pid}`, profileKey: key, pid,
    identityMode: 'nickname', name: pid.toUpperCase(), march
  });
  if (connect) {
    await send(harness, socket.ws, {
      t: 'defenseDeviceStatus', pid, deviceId, soundReady, clockFresh
    });
  }
  return socket;
}

test('manager clock lease and signal acceptance use exact server bounds without replacing the click time', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room);
  await configure(h, h.ws);
  assert.equal(h.room.defense.config.revision, 1);
  assert.equal(h.storage.get('defense:v1').config.enemyMarchSeconds, 60);
  const configWrites = h.storageCalls.filter(call => call.op === 'put').length;

  await configure(h, h.ws);
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, configWrites,
    'duplicate config mutation is idempotent');
  await configure(h, h.ws, { mutationId: 'config-stale', baseRevision: 0, enemyMarchSeconds: 61 });
  assert.deepEqual(lastFrame(h.sent, 'error'), {
    t: 'error', source: 'setDefenseConfig', mutationId: 'config-stale',
    error: 'config_conflict', canonicalRevision: 1
  });

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'without-clock',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'manager_clock_stale');

  await managerStatus(h, h.ws);
  const attachment = h.ws.deserializeAttachment();
  assert.equal(attachment.pid, '');
  assert.equal(attachment.deviceId, '');
  assert.equal(attachment.managerDeviceId, DEVICES.manager);
  assert.equal(attachment.managerStatusAtMs, h.room.nowMs());
  h.advanceMs(69_999);
  const acceptedSignalAtMs = h.room.nowMs() - 5_000;
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'lower-inclusive',
    configRevision: 1, signalAtMs: acceptedSignalAtMs
  });
  assert.equal(h.room.defense.activeOrder.signalAtMs, acceptedSignalAtMs,
    'the accepted client click timestamp is canonical');
  assert.equal(lastFrame(h.sent, 'defenseOrderAccepted').order.signalAtMs, acceptedSignalAtMs);
  const acceptedProjection = structuredClone(lastFrame(h.sent, 'defenseOrderAccepted').order);
  const writesAfterAcceptance = h.storageCalls.filter(call => call.op === 'put').length;
  h.advanceMs(70_001);
  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'lower-inclusive',
    configRevision: 1, signalAtMs: acceptedSignalAtMs
  });
  assert.equal(h.sent.some(frame => frame.t === 'error'), false,
    'an identical accepted Fire replays after both signal and manager leases expire');
  assert.deepEqual(lastFrame(h.sent, 'defenseOrderAccepted').order, acceptedProjection);
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesAfterAcceptance,
    'a delayed Fire replay does not rewrite canonical state');

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'lower-inclusive',
    configRevision: 1, signalAtMs: acceptedSignalAtMs + 1
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'manager_clock_stale',
    'a conflicting fingerprint cannot use replay to bypass the live lease checks');

  for (const boundary of [
    { offset: -5_001, accepted: false },
    { offset: 1_000, accepted: true },
    { offset: 1_001, accepted: false }
  ]) {
    const candidate = await setupManager(Room, { nowMs: 2_000_000 + boundary.offset + 10_000 });
    await configure(candidate, candidate.ws);
    await managerStatus(candidate, candidate.ws);
    candidate.sent.length = 0;
    const signalAtMs = candidate.room.nowMs() + boundary.offset;
    await send(candidate, candidate.ws, {
      t: 'fireDefense', password: 'qa', mutationId: `bound-${boundary.offset}`,
      configRevision: 1, signalAtMs
    });
    assert.equal(Boolean(candidate.room.defense.activeOrder), boundary.accepted, `offset ${boundary.offset}`);
    if (!boundary.accepted) assert.equal(lastFrame(candidate.sent, 'error').error, 'signal_out_of_bounds');
  }

  const expired = await setupManager(Room, { nowMs: 3_000_000 });
  await configure(expired, expired.ws);
  await managerStatus(expired, expired.ws);
  expired.advanceMs(70_000);
  await send(expired, expired.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'lease-expired',
    configRevision: 1, signalAtMs: expired.room.nowMs()
  });
  assert.equal(lastFrame(expired.sent, 'error').error, 'manager_clock_stale');
});

test('a failed initial alarm cannot durably activate an order and the same Fire may retry', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 3_500_000, useRealSchedule: true });
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  const originalSetAlarm = h.room.state.storage.setAlarm;
  let failFirstAlarm = true;
  h.room.state.storage.setAlarm = async value => {
    if (failFirstAlarm) {
      failFirstAlarm = false;
      throw new Error('injected alarm failure');
    }
    return originalSetAlarm(value);
  };
  const fire = {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-alarm-retry',
    configRevision: 1, signalAtMs: h.room.nowMs()
  };

  h.sent.length = 0;
  await send(h, h.ws, fire);
  assert.equal(lastFrame(h.sent, 'error').error, 'alarm_schedule_failed');
  assert.equal(h.room.defense.activeOrder, null);
  assert.equal(h.storage.get('defense:v1').activeOrder, null,
    'durable activation never precedes its required alarm');
  assert.equal(h.alarmAtMs(), null);

  h.sent.length = 0;
  await send(h, h.ws, fire);
  const acceptedOrder = h.room.defense.activeOrder;
  assert.equal(lastFrame(h.sent, 'defenseOrderAccepted').order.id, acceptedOrder.id);
  assert.equal(h.alarmAtMs(), acceptedOrder.completeAtMs,
    'the unchanged request can retry after the pre-activation alarm failure');
});

test('Fire never exposes an uncommitted candidate through concurrent manager hello', async () => {
  const { Room } = await loadRoom();
  for (const blockedStage of ['alarm', 'persist']) {
    const h = await setupManager(Room, {
      nowMs: blockedStage === 'alarm' ? 3_700_000 : 3_800_000,
      useRealSchedule: true
    });
    await configure(h, h.ws);
    await managerStatus(h, h.ws);
    const originalSetAlarm = h.room.state.storage.setAlarm;
    const originalPut = h.room.state.storage.put;
    let releaseBlockedStage;
    let blockedStageStarted;
    const reachedBlockedStage = new Promise(resolve => { blockedStageStarted = resolve; });
    const blockedStageMayFail = new Promise(resolve => { releaseBlockedStage = resolve; });
    if (blockedStage === 'alarm') {
      h.room.state.storage.setAlarm = async () => {
        blockedStageStarted();
        await blockedStageMayFail;
        throw new Error('injected delayed alarm failure');
      };
    } else {
      h.room.state.storage.setAlarm = originalSetAlarm;
      h.room.state.storage.put = async (key, value) => {
        if (key === 'defense:v1') {
          blockedStageStarted();
          await blockedStageMayFail;
          throw new Error('injected delayed order persistence failure');
        }
        return originalPut(key, value);
      };
    }

    h.sent.length = 0;
    const firePromise = send(h, h.ws, {
      t: 'fireDefense', password: 'qa', mutationId: `fire-hidden-${blockedStage}`,
      configRevision: 1, signalAtMs: h.room.nowMs()
    });
    await reachedBlockedStage;
    await send(h, h.ws, { t: 'hello' });
    assert.equal(lastFrame(h.sent, 'defenseManagerState').activeOrder, null,
      `${blockedStage} await cannot expose the uncommitted manager order`);
    assert.equal(lastFrame(h.sent, 'defenseState').activeOrderForOwnProfile, null);

    releaseBlockedStage();
    await firePromise;
    assert.equal(h.room.defense.activeOrder, null);
    assert.equal(h.storage.get('defense:v1').activeOrder, null);
    assert.equal(lastFrame(h.sent, 'error').error,
      blockedStage === 'alarm' ? 'alarm_schedule_failed' : 'order_persist_failed');
  }
});

test('a concurrent default scheduler preserves the hidden Fire wake until commit', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 3_900_000, useRealSchedule: true });
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  const originalPut = h.room.state.storage.put;
  let releaseOrderPut;
  let orderPutStarted;
  const orderReachedStorage = new Promise(resolve => { orderPutStarted = resolve; });
  const orderPutMayFinish = new Promise(resolve => { releaseOrderPut = resolve; });
  h.room.state.storage.put = async (key, value) => {
    if (key === 'defense:v1') {
      orderPutStarted();
      await orderPutMayFinish;
    }
    return originalPut(key, value);
  };

  h.sent.length = 0;
  const firePromise = send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-pending-wake',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  await orderReachedStorage;
  const candidateWake = h.alarmAtMs();
  assert.ok(Number.isSafeInteger(candidateWake));
  assert.equal(h.room.defense.activeOrder, null,
    'the candidate wake is hidden from canonical state while persistence waits');

  await Room.prototype.scheduleExpiry.call(h.room);
  assert.equal(h.alarmAtMs(), candidateWake,
    'a Rally/default scheduling pass cannot erase the pending Defense wake');

  releaseOrderPut();
  await firePromise;
  assert.equal(h.room.defense.activeOrder.completeAtMs, candidateWake);
  assert.equal(h.alarmAtMs(), candidateWake);
});

test('a stale concurrent scheduler cannot restore a failed Fire wake after rollback', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 3_950_000, useRealSchedule: true });
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  const originalPut = h.room.state.storage.put;
  const originalGetAlarm = h.room.state.storage.getAlarm;
  let releaseOrderPut;
  let orderPutStarted;
  let releaseStaleAlarm;
  let staleAlarmStarted;
  let getAlarmCalls = 0;
  const orderReachedStorage = new Promise(resolve => { orderPutStarted = resolve; });
  const orderPutMayFail = new Promise(resolve => { releaseOrderPut = resolve; });
  const staleSchedulerReachedStorage = new Promise(resolve => { staleAlarmStarted = resolve; });
  const staleAlarmMayFinish = new Promise(resolve => { releaseStaleAlarm = resolve; });
  h.room.state.storage.put = async (key, value) => {
    if (key === 'defense:v1') {
      orderPutStarted();
      await orderPutMayFail;
      throw new Error('injected delayed order persistence failure');
    }
    return originalPut(key, value);
  };
  h.room.state.storage.getAlarm = async () => {
    getAlarmCalls += 1;
    if (getAlarmCalls === 2) {
      staleAlarmStarted();
      await staleAlarmMayFinish;
    }
    return originalGetAlarm();
  };

  h.sent.length = 0;
  const firePromise = send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-stale-scheduler-rollback',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  await orderReachedStorage;
  const staleWake = h.alarmAtMs();
  const staleScheduler = Room.prototype.scheduleExpiry.call(h.room);
  await staleSchedulerReachedStorage;

  releaseOrderPut();
  await new Promise(resolve => setImmediate(resolve));
  releaseStaleAlarm();
  await Promise.all([firePromise, staleScheduler]);

  assert.equal(lastFrame(h.sent, 'error').error, 'order_persist_failed');
  assert.equal(h.room.defense.activeOrder, null);
  assert.equal(h.storage.get('defense:v1').activeOrder, null);
  assert.equal(h.alarmAtMs(), null,
    `the stale candidate wake ${staleWake} cannot finish after rollback and become canonical`);
});

test('an accepted order freezes one connected-profile audience and manager metrics across later changes', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 4_000_000 });
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  const p1a = await addPlayer(h, {
    pid: 'p1', key: PROFILE_KEYS.p1, march: 20, deviceId: DEVICES.p1a
  });
  const p1b = h.addSocket('defense');
  await handshake(h, p1b.ws, p1b.sent);
  await send(h, p1b.ws, {
    t: 'registerPlayer', registrationId: 'recover-p1', profileKey: PROFILE_KEYS.p1,
    pid: 'p1', identityMode: 'nickname', name: 'ignored', march: 99
  });
  await send(h, p1b.ws, {
    t: 'defenseDeviceStatus', pid: 'p1', deviceId: DEVICES.p1b,
    soundReady: true, clockFresh: true
  });
  p1b.sent.length = 0;
  const p2 = await addPlayer(h, {
    pid: 'p2', key: PROFILE_KEYS.p2, march: 120, deviceId: DEVICES.p2
  });
  await addPlayer(h, {
    pid: 'offline', key: PROFILE_KEYS.offline, march: 30,
    deviceId: 'bb000000-0000-4000-8000-00000000000b', connect: false
  });
  h.room.defense.players.invalid = {
    name: 'Invalid', march: 999, marchRevision: 0, identityMode: 'nickname',
    lastSeen: new Date(h.room.nowMs()).toISOString()
  };
  h.addSocket('defense', {
    defenseProfilePid: 'invalid', pid: 'invalid',
    deviceId: 'cc000000-0000-4000-8000-00000000000c',
    soundReady: false, clockFresh: true
  });

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-frozen',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  const order = h.room.defense.activeOrder;
  assert.deepEqual(order.rosterAtAcceptance.map(profile => profile.pid), ['invalid', 'offline', 'p1', 'p2']);
  assert.deepEqual(order.audience.map(profile => profile.pid), ['p1', 'p2'],
    'two devices for p1 still produce one immutable profile target');
  assert.equal(order.audience.find(profile => profile.pid === 'p1').march, 20);
  assert.equal(order.audience.find(profile => profile.pid === 'p2').tooLate, true);
  const acceptedForManager = lastFrame(h.sent, 'defenseOrderAccepted').order;
  assert.equal(Object.hasOwn(acceptedForManager, 'audience'), false);
  assert.equal(Object.hasOwn(acceptedForManager, 'goAtMs'), false, 'manager-only projection is silent');
  assert.equal(acceptedForManager.counts.registeredAtAcceptance, 4);
  assert.equal(acceptedForManager.counts.targetedProfiles, 2);
  assert.equal(acceptedForManager.counts.offlineRosterProfiles, 1);
  assert.equal(acceptedForManager.counts.invalidTimeProfiles, 1);
  assert.equal(acceptedForManager.counts.tooLateProfiles, 1);
  const p1Target = order.audience.find(profile => profile.pid === 'p1');
  const p2Target = order.audience.find(profile => profile.pid === 'p2');
  assert.equal(Object.hasOwn(acceptedForManager, 'profiles'), false,
    'manager order summary does not duplicate the paged profile rows');
  assert.equal(Object.hasOwn(acceptedForManager.delivery, 'profiles'), false,
    'manager delivery summary does not duplicate profile-level delivery rows');
  const acceptedManagerState = lastFrame(h.sent, 'defenseManagerState');
  const frozenRows = acceptedManagerState.playersPage.items.map(item => ({
    pid: item.pid,
    ...item.activeRound
  }));
  assert.deepEqual(frozenRows, [
    {
      pid: 'invalid', displayName: 'Invalid', identityMode: 'nickname', march: 999,
      marchRevision: 0, connectedAtAcceptance: true, validAtAcceptance: false,
      targeted: false, goAtMs: null, tooLate: false, outcome: null,
      acknowledgedDevices: 0, scheduledDevices: 0,
      deliveredScheduled: false, audioReady: false
    },
    {
      pid: 'offline', displayName: 'OFFLINE', identityMode: 'nickname', march: 30,
      marchRevision: 0, connectedAtAcceptance: false, validAtAcceptance: true,
      targeted: false, goAtMs: null, tooLate: false, outcome: null,
      acknowledgedDevices: 0, scheduledDevices: 0,
      deliveredScheduled: false, audioReady: false
    },
    {
      pid: 'p1', displayName: 'P1', identityMode: 'nickname', march: 20,
      marchRevision: 0, connectedAtAcceptance: true, validAtAcceptance: true,
      targeted: true, goAtMs: p1Target.goAtMs, tooLate: false, outcome: 'unconfirmed',
      acknowledgedDevices: 0, scheduledDevices: 0,
      deliveredScheduled: false, audioReady: false
    },
    {
      pid: 'p2', displayName: 'P2', identityMode: 'nickname', march: 120,
      marchRevision: 0, connectedAtAcceptance: true, validAtAcceptance: true,
      targeted: true, goAtMs: p2Target.goAtMs, tooLate: true, outcome: 'too_late',
      acknowledgedDevices: 0, scheduledDevices: 0,
      deliveredScheduled: false, audioReady: false
    }
  ]);
  assert.equal(/profileKey|secret/i.test(JSON.stringify(acceptedManagerState.playersPage)), false,
    'manager projections never leak profile ownership credentials');
  const frozenProfilesBeforeLiveChanges = structuredClone(frozenRows);
  assert.equal(frames(p1a.sent, 'defenseOrderAccepted').length, 1);
  assert.equal(frames(p1b.sent, 'defenseOrderAccepted').length, 1);
  assert.equal(lastFrame(p1a.sent, 'defenseOrderAccepted').order.goAtMs,
    lastFrame(p1b.sent, 'defenseOrderAccepted').order.goAtMs);
  assert.ok(wireBytes(lastFrame(p1a.sent, 'defenseOrderAccepted')) <= 4 * 1024,
    'a personal accepted-order frame stays within 4 KiB');

  const frozenCounts = structuredClone(lastFrame(h.sent, 'defenseManagerState').activeOrder.counts);
  await h.room.webSocketClose(p2.ws);
  const newcomer = await addPlayer(h, {
    pid: 'newcomer', key: PROFILE_KEYS.newcomer, march: 15, deviceId: DEVICES.newcomer
  });
  const newcomerState = lastFrame(newcomer.sent, 'defenseState');
  assert.equal(newcomerState.activeOrderForOwnProfile, null, 'new profile waits for the next round');
  assert.deepEqual(lastFrame(h.sent, 'defenseManagerState').activeOrder.counts, frozenCounts);
  let liveManagerRows = h.room.defenseManagerSnapshot(h.ws).playersPage.items;
  assert.equal(liveManagerRows.find(item => item.pid === 'newcomer').activeRound, null,
    'a newcomer has canonical next-round status without fabricated frozen facts');
  assert.deepEqual(liveManagerRows.filter(item => item.activeRound).map(item => ({
    pid: item.pid, ...item.activeRound
  })), frozenProfilesBeforeLiveChanges,
    'disconnects and newcomers cannot rewrite the accepted roster facts');

  newcomer.sent.length = 0;
  await send(h, newcomer.ws, {
    t: 'updateOwnMarch', mutationId: 'newcomer-after-fire', profileKey: PROFILE_KEYS.newcomer,
    pid: 'newcomer', baseRevision: 0, march: 16
  });
  assert.equal(lastFrame(newcomer.sent, 'defenseProfileDelta').appliesNextRound, true,
    'every active-round march edit is next-round-only, even for an uncaptured newcomer');
  liveManagerRows = h.room.defenseManagerSnapshot(h.ws).playersPage.items;
  assert.equal(liveManagerRows.find(item => item.pid === 'newcomer').march, 16);
  assert.equal(liveManagerRows.find(item => item.pid === 'newcomer').activeRound, null);

  p1a.sent.length = 0;
  await send(h, p1a.ws, {
    t: 'updateOwnMarch', mutationId: 'p1-after-fire', profileKey: PROFILE_KEYS.p1,
    pid: 'p1', baseRevision: 0, march: 40
  });
  assert.equal(h.room.defense.activeOrder.audience.find(profile => profile.pid === 'p1').march, 20);
  assert.equal(lastFrame(p1a.sent, 'defenseProfileDelta').appliesNextRound, true);
  liveManagerRows = h.room.defenseManagerSnapshot(h.ws).playersPage.items;
  assert.equal(liveManagerRows.find(item => item.pid === 'p1').march, 40,
    'the flat row exposes the canonical next-round march');
  assert.deepEqual(liveManagerRows.filter(item => item.activeRound).map(item => ({
    pid: item.pid, ...item.activeRound
  })), frozenProfilesBeforeLiveChanges,
    'player edits apply to the next round without rewriting frozen manager rows');

  h.sent.length = 0;
  const originalPut = h.room.state.storage.put;
  let failManagerEdit = true;
  h.room.state.storage.put = async (key, value) => {
    if (failManagerEdit && key === 'defense:v1') {
      failManagerEdit = false;
      throw new Error('injected manager march persistence failure');
    }
    return originalPut(key, value);
  };
  await send(h, h.ws, {
    t: 'setDefensePlayerMarch', password: 'qa', mutationId: 'manager-p1-fail',
    pid: 'p1', profileGeneration: 1, baseRevision: 1, march: 45
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'profile_persist_failed');
  assert.equal(h.room.defense.players.p1.march, 40);
  assert.equal(h.room.defense.players.p1.marchRevision, 1);
  assert.equal(h.room.defense.activeOrder.audience.find(profile => profile.pid === 'p1').march, 20);
  assert.equal(frames(h.sent, 'defenseProfileDelta').length, 0,
    'failed manager persistence emits no success delta');

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'setDefensePlayerMarch', password: 'qa', mutationId: 'manager-p1-next-round',
    pid: 'p1', profileGeneration: 1, baseRevision: 1, march: 50
  });
  assert.equal(h.room.defense.players.p1.march, 50);
  assert.equal(h.room.defense.players.p1.marchRevision, 2);
  assert.equal(h.room.defense.activeOrder.audience.find(profile => profile.pid === 'p1').march, 20,
    'manager override cannot rewrite the frozen active audience');
  assert.equal(lastFrame(h.sent, 'defenseProfileDelta').appliesNextRound, true);
  const writesAfterManagerEdit = h.storageCalls.filter(call => call.op === 'put').length;
  await send(h, h.ws, {
    t: 'setDefensePlayerMarch', password: 'qa', mutationId: 'manager-p1-next-round',
    pid: 'p1', profileGeneration: 1, baseRevision: 1, march: 50
  });
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesAfterManagerEdit,
    'identical manager march mutation replays without a second write');
  await send(h, h.ws, {
    t: 'setDefensePlayerMarch', password: 'qa', mutationId: 'manager-p1-stale',
    pid: 'p1', profileGeneration: 1, baseRevision: 1, march: 55
  });
  assert.deepEqual(lastFrame(h.sent, 'error'), {
    t: 'error', source: 'setDefensePlayerMarch', mutationId: 'manager-p1-stale',
    error: 'player_conflict', canonicalRevision: 2
  });

  const goAtMs = order.audience.find(profile => profile.pid === 'p1').goAtMs;
  h.sent.length = 0;
  await send(h, p1a.ws, {
    t: 'hb', pid: 'p1', deviceId: DEVICES.p1a,
    soundReady: false, clockFresh: false
  });
  h.sent.length = 0;
  const writesBeforeForgedAck = h.storageCalls.filter(call => call.op === 'put').length;
  await send(h, p1a.ws, {
    t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1a, goAtMs, outcome: 'scheduled',
    audioReady: true, clockFresh: true
  });
  assert.equal(lastFrame(p1a.sent, 'error').error, 'ack_readiness_mismatch');
  assert.deepEqual(lastFrame(p1a.sent, 'error'), {
    t: 'error', source: 'defenseOrderAck', error: 'ack_readiness_mismatch',
    orderId: order.id, orderRevision: order.revision, revision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1a, outcome: 'scheduled'
  });
  assert.equal(h.room.defenseAcks.length, 0);
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesBeforeForgedAck);

  h.sent.length = 0;
  await send(h, p1a.ws, {
    t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1a, goAtMs, outcome: 'audio_unready',
    audioReady: false, clockFresh: false
  });
  assert.deepEqual(lastFrame(h.sent, 'defenseAckSaved').profileDelivery, {
    pid: 'p1', goAtMs, tooLate: false, acknowledgedDevices: 1,
    scheduledDevices: 0, deliveredScheduled: false, audioReady: false,
    outcome: 'audio_unready'
  }, 'the first device failure creates one profile-level acknowledged device');
  assert.ok(wireBytes(lastFrame(h.sent, 'defenseAckSaved')) <= 2 * 1024);

  await send(h, p1a.ws, {
    t: 'hb', pid: 'p1', deviceId: DEVICES.p1a,
    soundReady: true, clockFresh: true
  });
  h.sent.length = 0;
  await send(h, p1a.ws, {
    t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1a, goAtMs, outcome: 'scheduled',
    audioReady: true, clockFresh: true
  });
  assert.deepEqual(lastFrame(h.sent, 'defenseAckSaved').profileDelivery, {
    pid: 'p1', goAtMs, tooLate: false, acknowledgedDevices: 1,
    scheduledDevices: 1, deliveredScheduled: true, audioReady: true,
    outcome: 'scheduled'
  }, 'upgrading the old device replaces its failure without fabricating a second device');
  await send(h, p1b.ws, {
    t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1b, goAtMs, outcome: 'scheduled',
    audioReady: true, clockFresh: true
  });
  assert.deepEqual(lastFrame(h.sent, 'defenseAckSaved').profileDelivery, {
    pid: 'p1', goAtMs, tooLate: false, acknowledgedDevices: 2,
    scheduledDevices: 2, deliveredScheduled: true, audioReady: true,
    outcome: 'scheduled'
  }, 'a genuinely new device increments both acknowledged and scheduled device counts');
  assert.equal(frames(h.sent, 'defenseManagerState').length, 0,
    'bounded ACK deltas never drag the full manager roster behind them');
  assert.equal(frames(h.sent, 'defenseAckSaved').length, 2);
  for (const ackDelta of frames(h.sent, 'defenseAckSaved')) {
    assert.ok(wireBytes(ackDelta) <= 2 * 1024, 'an ACK delta stays within 2 KiB');
  }
  const metrics = h.room.defenseManagerSnapshot(h.ws).activeOrder.delivery;
  assert.equal(metrics.targetedProfiles, 2);
  assert.equal(metrics.deliveredScheduledProfiles, 1,
    'manager delivery metrics dedupe multiple devices by profile');
  assert.equal(metrics.audioReadyProfiles, 1);
  const deliveredProfiles = h.room.defenseManagerSnapshot(h.ws).playersPage.items;
  const frozenP1 = frozenProfilesBeforeLiveChanges.find(profile => profile.pid === 'p1');
  const { pid: frozenP1Pid, ...frozenP1Round } = frozenP1;
  assert.equal(frozenP1Pid, 'p1');
  assert.deepEqual(deliveredProfiles.find(profile => profile.pid === 'p1').activeRound, {
    ...frozenP1Round,
    acknowledgedDevices: 2, scheduledDevices: 2,
    outcome: 'scheduled', deliveredScheduled: true, audioReady: true
  }, 'profile rows merge profile-level delivery without changing frozen identity or timing');
  assert.equal(deliveredProfiles.find(profile => profile.pid === 'p2').activeRound.outcome, 'too_late');

  h.sent.length = 0;
  const writesBeforeDuplicateAck = h.storageCalls.filter(call => call.op === 'put').length;
  await send(h, p1b.ws, {
    t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1b, goAtMs, outcome: 'scheduled',
    audioReady: true, clockFresh: true
  });
  assert.deepEqual(lastFrame(h.sent, 'defenseAckSaved').profileDelivery,
    {
      pid: 'p1', goAtMs, tooLate: false, acknowledgedDevices: 2,
      scheduledDevices: 2, deliveredScheduled: true, audioReady: true,
      outcome: 'scheduled'
    });
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesBeforeDuplicateAck,
    'an unchanged ACK still returns current aggregate truth without another row write');
  assert.equal(frames(h.sent, 'defenseManagerState').length, 0);

  h.sent.length = 0;
  const writesBeforeDuplicate = h.storageCalls.filter(call => call.op === 'put').length;
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-frozen',
    configRevision: 1, signalAtMs: order.signalAtMs
  });
  assert.equal(lastFrame(h.sent, 'defenseOrderAccepted').order.id, order.id);
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesBeforeDuplicate);
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'next-blocked',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'order_active');
});

test('every Defense ACK rejection carries only its safe exact queue identity', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 4_500_000 });
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  const player = await addPlayer(h, {
    pid: 'p1', key: PROFILE_KEYS.p1, march: 20, deviceId: DEVICES.p1a
  });
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-ack-errors',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  const order = h.room.defense.activeOrder;
  const target = order.audience[0];
  const base = {
    t: 'error', source: 'defenseOrderAck', orderId: order.id,
    orderRevision: order.revision, revision: order.revision,
    pid: 'p1', outcome: 'scheduled'
  };

  player.sent.length = 0;
  await send(h, player.ws, {
    t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1b, goAtMs: target.goAtMs,
    outcome: 'scheduled', audioReady: true, clockFresh: true
  });
  assert.deepEqual(lastFrame(player.sent, 'error'), {
    ...base, deviceId: DEVICES.p1b, error: 'bad_ack_identity'
  }, 'identity failures identify the incoming queue entry, not the socket device');

  player.sent.length = 0;
  await send(h, player.ws, {
    t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1a, goAtMs: target.goAtMs,
    outcome: 'scheduled', audioReady: false, clockFresh: true
  });
  assert.deepEqual(lastFrame(player.sent, 'error'), {
    ...base, deviceId: DEVICES.p1a, error: 'ack_readiness_mismatch'
  });

  player.sent.length = 0;
  const staleOrderId = 'stale-order-a';
  await send(h, player.ws, {
    t: 'defenseOrderAck', orderId: staleOrderId, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1a, goAtMs: target.goAtMs,
    outcome: 'scheduled', audioReady: true, clockFresh: true
  });
  assert.deepEqual(lastFrame(player.sent, 'error'), {
    ...base, orderId: staleOrderId, deviceId: DEVICES.p1a, error: 'ack_target_missing'
  }, 'a stale plan A rejection cannot be mistaken for the current plan B queue entry');

  const originalPut = h.room.state.storage.put;
  h.room.state.storage.put = async (key, value) => {
    if (key === 'defenseAcks:v1') throw new Error('injected ack persistence failure');
    return originalPut(key, value);
  };
  player.sent.length = 0;
  await send(h, player.ws, {
    t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1a, goAtMs: target.goAtMs,
    outcome: 'scheduled', audioReady: true, clockFresh: true
  });
  assert.deepEqual(lastFrame(player.sent, 'error'), {
    ...base, deviceId: DEVICES.p1a, error: 'ack_persist_failed'
  });
  assert.equal(h.room.defenseAcks.length, 0);

  player.sent.length = 0;
  await send(h, player.ws, {
    t: 'defenseOrderAck', orderId: ' '.repeat(65), orderRevision: -1,
    pid: '', deviceId: 'not-a-device', goAtMs: target.goAtMs,
    outcome: 'not-an-outcome', audioReady: true, clockFresh: true
  });
  const malformed = lastFrame(player.sent, 'error');
  assert.deepEqual(malformed, {
    t: 'error', source: 'defenseOrderAck', error: 'bad_ack_identity'
  }, 'malformed incoming identity fields are omitted rather than echoed raw');
});

test('concurrent managers serialize password claim and active-order first writer', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'defense', players: {}, nowMs: 5_000_000 });
  const second = h.addSocket('defense');
  await handshake(h, h.ws, h.sent);
  await handshake(h, second.ws, second.sent);
  await Promise.all([
    send(h, h.ws, { t: 'defenseUnlock', password: 'qa' }),
    send(h, second.ws, { t: 'defenseUnlock', password: 'other-password' })
  ]);
  assert.ok(lastFrame(h.sent, 'defenseManagerState'));
  assert.equal(lastFrame(second.sent, 'error').error, 'bad_password');

  const third = h.addSocket('defense');
  await handshake(h, third.ws, third.sent);
  await unlock(h, third.ws, third.sent, 'qa');
  await configure(h, h.ws);
  await managerStatus(h, h.ws, DEVICES.manager);
  await managerStatus(h, third.ws, DEVICES.manager2);
  h.sent.length = 0;
  third.sent.length = 0;
  await Promise.all([
    send(h, h.ws, {
      t: 'fireDefense', password: 'qa', mutationId: 'fire-first',
      configRevision: 1, signalAtMs: h.room.nowMs()
    }),
    send(h, third.ws, {
      t: 'fireDefense', password: 'qa', mutationId: 'fire-second',
      configRevision: 1, signalAtMs: h.room.nowMs()
    })
  ]);
  assert.equal(h.room.defense.activeOrder.mutationId, 'fire-first');
  assert.ok(lastFrame(h.sent, 'defenseOrderAccepted'));
  assert.equal(lastFrame(third.sent, 'error').error, 'order_active');
  assert.equal(h.room.defense.orderRevision, 1);
});

test('captured reconnect restores only its future cue, queued removal purges on cancellation, and stale frames cannot resurrect it', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 6_000_000 });
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  const original = await addPlayer(h, {
    pid: 'p1', key: PROFILE_KEYS.p1, march: 20, deviceId: DEVICES.p1a
  });
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-cancel',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  const order = structuredClone(h.room.defense.activeOrder);

  await h.room.webSocketClose(original.ws);
  const reconnect = h.addSocket('defense');
  await handshake(h, reconnect.ws, reconnect.sent);
  await send(h, reconnect.ws, {
    t: 'registerPlayer', registrationId: 'reconnect-p1', profileKey: PROFILE_KEYS.p1,
    pid: 'p1', identityMode: 'nickname', name: 'ignored', march: 99
  });
  const restored = lastFrame(reconnect.sent, 'defenseState').activeOrderForOwnProfile;
  assert.equal(restored.id, order.id);
  assert.equal(restored.goAtMs, order.audience[0].goAtMs);
  assert.ok(restored.goAtMs > h.room.nowMs());

  const newcomer = await addPlayer(h, {
    pid: 'newcomer', key: PROFILE_KEYS.newcomer, march: 15, deviceId: DEVICES.newcomer
  });
  assert.equal(lastFrame(newcomer.sent, 'defenseState').activeOrderForOwnProfile, null);

  await send(h, h.ws, {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'remove-captured',
    pid: 'p1', profileGeneration: 1, baseRevision: order.revision
  });
  assert.ok(h.room.defense.players.p1);
  assert.deepEqual(h.room.defense.pendingRemovalPids, ['p1']);
  assert.equal(lastFrame(h.sent, 'defenseProfileDelta').pending, true);

  await send(h, h.ws, {
    t: 'cancelDefense', password: 'qa', mutationId: 'cancel-1',
    orderId: order.id, orderRevision: order.revision
  });
  const cancelled = lastFrame(h.sent, 'defenseOrderCancelled');
  assert.deepEqual(cancelled, { t: 'defenseOrderCancelled', orderId: order.id, revision: 2 });
  assert.equal(h.room.defense.activeOrder, null);
  assert.equal(h.room.defense.lastTerminal.status, 'cancelled');
  assert.equal(h.room.defense.players.p1, undefined);
  assert.equal(h.room.defenseProfileOwners.p1, undefined);

  const putsAfterCancel = h.storageCalls.filter(call => call.op === 'put').length;
  await send(h, h.ws, {
    t: 'cancelDefense', password: 'qa', mutationId: 'cancel-1',
    orderId: order.id, orderRevision: order.revision
  });
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, putsAfterCancel,
    'an idempotent cancellation never rewrites an already atomic purge bundle');

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'remove-captured',
    pid: 'p1', profileGeneration: 1, baseRevision: order.revision
  });
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, putsAfterCancel,
    'a queued removal replay after cancellation is read-only');
  assert.deepEqual(lastFrame(h.sent, 'defenseProfileDelta'), {
    t: 'defenseProfileDelta', mutationId: 'remove-captured', pid: 'p1',
    removed: true, pending: false, rosterRevision: 3, profile: null
  }, 'a stale queued outcome projects the canonical terminal removal');

  reconnect.sent.length = 0;
  await send(h, reconnect.ws, {
    t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1a, goAtMs: order.audience[0].goAtMs,
    outcome: 'scheduled', audioReady: true, clockFresh: true
  });
  assert.notEqual(h.room.defense.activeOrder && h.room.defense.activeOrder.id, order.id);
  assert.equal(frames(reconnect.sent, 'defenseOrderAccepted').length, 0);

  const staleOwner = h.addSocket('defense');
  await handshake(h, staleOwner.ws, staleOwner.sent);
  staleOwner.sent.length = 0;
  await send(h, staleOwner.ws, {
    t: 'registerPlayer', registrationId: 'removed-owner-after-terminal',
    profileKey: PROFILE_KEYS.p1, pid: 'p1', identityMode: 'nickname',
    name: 'Must Not Return', march: 20
  });
  assert.equal(lastFrame(staleOwner.sent, 'error').error, 'profile_removed',
    'queued terminal purge tombstones the old owner credential');
  assert.equal(h.room.defense.players.p1, undefined);
});

test('alarm persists one completion tombstone and leaves surviving profiles waiting for the next round', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 7_000_000, useRealSchedule: true });
  h.room.runDeliveryWake = async () => false;
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  const player = await addPlayer(h, {
    pid: 'p1', key: PROFILE_KEYS.p1, march: 20, deviceId: DEVICES.p1a
  });
  await addPlayer(h, {
    pid: 'offline', key: PROFILE_KEYS.offline, march: 25,
    deviceId: DEVICES.p2, connect: false
  });
  h.sent.length = 0;
  player.sent.length = 0;
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-complete',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  const first = structuredClone(h.room.defense.activeOrder);
  assert.equal(h.alarmAtMs(), first.completeAtMs);
  await send(h, player.ws, {
    t: 'defenseOrderAck', orderId: first.id, orderRevision: first.revision,
    pid: 'p1', deviceId: DEVICES.p1a, goAtMs: first.audience[0].goAtMs,
    outcome: 'scheduled', audioReady: true, clockFresh: true
  });
  assert.equal(h.room.defenseAcks.length, 1);
  await send(h, h.ws, {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'remove-before-complete',
    pid: 'offline', profileGeneration: 2, baseRevision: first.revision
  });
  assert.equal(lastFrame(h.sent, 'defenseProfileDelta').pending, true);

  h.setNowMs(first.completeAtMs);
  await Room.prototype.alarm.call(h.room);
  assert.equal(h.room.defense.activeOrder, null);
  assert.equal(h.room.defense.lastTerminal.status, 'completed');
  assert.equal(h.room.defense.lastTerminal.revision, 2);
  assert.deepEqual(lastFrame(h.sent, 'defenseOrderCompleted'), {
    t: 'defenseOrderCompleted', orderId: first.id, revision: 2
  });
  assert.equal(lastFrame(player.sent, 'defenseState').activeOrderForOwnProfile, null);
  assert.equal(h.alarmAtMs(), null);
  assert.equal(h.room.defense.players.offline, undefined);
  assert.deepEqual(h.room.defenseAcks, [], 'terminal completion clears obsolete ACK history');
  assert.deepEqual(h.storage.get('defenseAcks:v1'), []);

  const writesAfterCompletion = h.storageCalls.filter(call => call.op === 'put').length;
  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'remove-before-complete',
    pid: 'offline', profileGeneration: 2, baseRevision: first.revision
  });
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesAfterCompletion);
  assert.deepEqual(lastFrame(h.sent, 'defenseProfileDelta'), {
    t: 'defenseProfileDelta', mutationId: 'remove-before-complete', pid: 'offline',
    removed: true, pending: false, rosterRevision: 3, profile: null
  }, 'completion replay cannot resurrect a queued-removal card');

  const completions = frames(h.sent, 'defenseOrderCompleted').length;
  await Room.prototype.alarm.call(h.room);
  assert.equal(frames(h.sent, 'defenseOrderCompleted').length, completions,
    'a stale alarm cannot emit a second completion');

  await managerStatus(h, h.ws);
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-next-round',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  assert.equal(h.room.defense.activeOrder.revision, 3);
  assert.equal(h.room.defense.activeOrder.audience[0].pid, 'p1');
  assert.ok(lastFrame(player.sent, 'defenseOrderAccepted'));
  const nextOrder = h.room.defense.activeOrder;
  await send(h, player.ws, {
    t: 'defenseOrderAck', orderId: nextOrder.id, orderRevision: nextOrder.revision,
    pid: 'p1', deviceId: DEVICES.p1a, goAtMs: nextOrder.audience[0].goAtMs,
    outcome: 'scheduled', audioReady: true, clockFresh: true
  });
  assert.equal(h.room.defenseAcks.length, 1,
    'the next round starts ACK persistence from one record, not terminal history');
  assert.equal(h.storage.get('defenseAcks:v1').length, 1);
});

test('reconnect restores only a future personal cue while the wider round remains active', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 7_500_000 });
  await configure(h, h.ws, { enemyMarchSeconds: 60 });
  await managerStatus(h, h.ws);
  const early = await addPlayer(h, {
    pid: 'p1', key: PROFILE_KEYS.p1, march: 60, deviceId: DEVICES.p1a
  });
  await addPlayer(h, {
    pid: 'p2', key: PROFILE_KEYS.p2, march: 20, deviceId: DEVICES.p2
  });
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-stale-reconnect',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  const order = structuredClone(h.room.defense.activeOrder);
  const earlyTarget = order.audience.find(profile => profile.pid === 'p1');
  const lateTarget = order.audience.find(profile => profile.pid === 'p2');
  assert.ok(earlyTarget.goAtMs < lateTarget.goAtMs);
  assert.ok(earlyTarget.goAtMs < order.completeAtMs);

  h.setNowMs(earlyTarget.goAtMs);
  await h.room.webSocketClose(early.ws);
  const reconnect = h.addSocket('defense');
  await handshake(h, reconnect.ws, reconnect.sent);
  reconnect.sent.length = 0;
  await send(h, reconnect.ws, {
    t: 'registerPlayer', registrationId: 'reconnect-after-own-go',
    profileKey: PROFILE_KEYS.p1, pid: 'p1', identityMode: 'nickname',
    name: 'ignored', march: 99
  });
  assert.equal(h.room.defense.activeOrder.id, order.id,
    'the later target keeps the canonical round active');
  assert.equal(lastFrame(reconnect.sent, 'defenseState').activeOrderForOwnProfile, null,
    'the reconnect cannot re-arm a cue at or after its personal go time');
  assert.equal(frames(reconnect.sent, 'defenseOrderAccepted').length, 0);
});

test('a durable cancellation broadcasts its terminal even when alarm cleanup fails', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 7_700_000, useRealSchedule: true });
  h.room.runDeliveryWake = async () => false;
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  const player = await addPlayer(h, {
    pid: 'p1', key: PROFILE_KEYS.p1, march: 20, deviceId: DEVICES.p1a
  });
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-cancel-cleanup',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  const order = structuredClone(h.room.defense.activeOrder);
  await send(h, player.ws, {
    t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
    pid: 'p1', deviceId: DEVICES.p1a, goAtMs: order.audience[0].goAtMs,
    outcome: 'scheduled', audioReady: true, clockFresh: true
  });
  assert.equal(h.room.defenseAcks.length, 1);
  h.room._defensePersistenceFailures = 4;
  h.room._defenseFailureNotBeforeMs = h.room.nowMs() + 30_000;
  const originalDeleteAlarm = h.room.state.storage.deleteAlarm;
  let failCleanup = true;
  h.room.state.storage.deleteAlarm = async () => {
    if (failCleanup) {
      failCleanup = false;
      throw new Error('injected alarm cleanup failure');
    }
    return originalDeleteAlarm();
  };

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'cancelDefense', password: 'qa', mutationId: 'cancel-cleanup',
    orderId: order.id, orderRevision: order.revision
  });
  assert.deepEqual(lastFrame(h.sent, 'defenseOrderCancelled'), {
    t: 'defenseOrderCancelled', orderId: order.id, revision: 2
  });
  assert.equal(h.room.defense.activeOrder, null);
  assert.equal(h.storage.get('defense:v1').activeOrder, null,
    'the canonical cancellation is durable before best-effort alarm cleanup');
  assert.deepEqual(h.room.defenseAcks, [], 'terminal cancellation clears obsolete ACK history');
  assert.deepEqual(h.storage.get('defenseAcks:v1'), []);
  assert.equal(h.room._defensePersistenceFailures, 0,
    'cancellation clears completion backoff from the old round');
  assert.equal(h.room._defenseFailureNotBeforeMs, 0);
  const writesAfterCancel = h.storageCalls.filter(call => call.op === 'put').length;

  await send(h, h.ws, {
    t: 'cancelDefense', password: 'qa', mutationId: 'cancel-cleanup',
    orderId: order.id, orderRevision: order.revision
  });
  assert.equal(frames(h.sent, 'defenseOrderCancelled').length, 2,
    'the idempotent retry can replenish the terminal frame');
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesAfterCancel,
    'terminal replay performs no second bundle write');
});

test('a completion persistence failure uses bounded alarm backoff before canonical recovery', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 8_000_000, useRealSchedule: true });
  h.room.runDeliveryWake = async () => false;
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-complete-retry',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  const order = structuredClone(h.room.defense.activeOrder);
  const originalPut = h.room.state.storage.put;
  let remainingCompletionFailures = 2;
  h.room.state.storage.put = async (key, value) => {
    if (remainingCompletionFailures > 0 && key && typeof key === 'object' && key['defense:v1']) {
      remainingCompletionFailures -= 1;
      throw new Error('injected completion persistence failure');
    }
    return originalPut(key, value);
  };

  h.sent.length = 0;
  h.calls.length = 0;
  h.setNowMs(order.completeAtMs);
  await Room.prototype.alarm.call(h.room);
  assert.equal(h.room.defense.activeOrder.id, order.id);
  assert.equal(frames(h.sent, 'defenseOrderCompleted').length, 0);
  assert.equal(h.alarmAtMs(), order.completeAtMs + 500,
    'a failed durable completion cannot create a one-millisecond hot loop');
  assert.equal(h.calls.includes('broadcast'), false,
    'a Defense-only persistence retry cannot broadcast a full Rally snapshot');

  h.setNowMs(h.alarmAtMs());
  await Room.prototype.alarm.call(h.room);
  assert.equal(h.room.defense.activeOrder.id, order.id);
  assert.equal(h.alarmAtMs(), order.completeAtMs + 2_000,
    'repeated completion failures use bounded exponential spacing');
  assert.equal(h.calls.includes('broadcast'), false);

  h.setNowMs(h.alarmAtMs());
  await Room.prototype.alarm.call(h.room);
  assert.equal(h.room.defense.activeOrder, null);
  assert.equal(h.room.defense.lastTerminal.status, 'completed');
  assert.equal(frames(h.sent, 'defenseOrderCompleted').length, 1);
});

test('a non-persistable Defense terminal uses bounded alarm backoff instead of a 1ms loop', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 8_250_000, useRealSchedule: true });
  h.room.runDeliveryWake = async () => false;
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  await addPlayer(h, {
    pid: 'p1', key: PROFILE_KEYS.p1, march: 20, deviceId: DEVICES.p1a
  });
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-terminal-exhaustion',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  const order = structuredClone(h.room.defense.activeOrder);
  await send(h, h.ws, {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'remove-terminal-exhaustion',
    pid: 'p1', profileGeneration: 1, baseRevision: order.revision
  });
  h.room.defense.rosterRevision = Number.MAX_SAFE_INTEGER;
  h.setNowMs(order.completeAtMs);

  await assert.doesNotReject(Room.prototype.alarm.call(h.room));
  assert.equal(h.room.defense.activeOrder.id, order.id);
  assert.equal(h.alarmAtMs(), h.room.nowMs() + 500);
});

test('earlier Rally alarms cannot bypass Defense completion persistence backoff', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 8_500_000, useRealSchedule: true });
  h.room.runDeliveryWake = async () => false;
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-mixed-backoff',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  const order = structuredClone(h.room.defense.activeOrder);
  const originalPut = h.room.state.storage.put;
  let defenseBundleAttempts = 0;
  let remainingFailures = 2;
  h.room.state.storage.put = async (key, value) => {
    if (key && typeof key === 'object' && key['defense:v1']) {
      defenseBundleAttempts += 1;
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('injected mixed-alarm completion failure');
      }
    }
    return originalPut(key, value);
  };

  h.setNowMs(order.completeAtMs);
  await Room.prototype.alarm.call(h.room);
  assert.equal(defenseBundleAttempts, 1);
  assert.equal(h.room._defensePersistenceFailures, 1);
  const firstRetryAt = order.completeAtMs + 500;
  assert.equal(h.room._defenseFailureNotBeforeMs, firstRetryAt);

  h.setNowMs(order.completeAtMs + 100);
  h.room.room.live.commands[1] = {
    type: 'ping', expiresUTC: Math.floor(h.room.nowMs() / 1000)
  };
  h.calls.length = 0;
  await Room.prototype.alarm.call(h.room);
  assert.equal(h.room.room.live.commands[1], null, 'the earlier Rally expiry is still processed');
  assert.equal(h.calls.includes('broadcast'), true, 'the Rally transition is still broadcast');
  assert.equal(defenseBundleAttempts, 1,
    'an earlier Rally wake cannot retry Defense before its deadline');
  assert.equal(h.room._defensePersistenceFailures, 1);
  assert.equal(h.room._defenseFailureNotBeforeMs, firstRetryAt);

  h.setNowMs(firstRetryAt);
  await Room.prototype.alarm.call(h.room);
  assert.equal(defenseBundleAttempts, 2);
  assert.equal(h.room._defensePersistenceFailures, 2);
  const secondRetryAt = firstRetryAt + 1_500;
  assert.equal(h.room._defenseFailureNotBeforeMs, secondRetryAt);

  h.setNowMs(firstRetryAt + 100);
  h.room.room.live.commands[2] = {
    type: 'ping', expiresUTC: Math.floor(h.room.nowMs() / 1000)
  };
  await Room.prototype.alarm.call(h.room);
  assert.equal(defenseBundleAttempts, 2);
  assert.equal(h.room._defensePersistenceFailures, 2);
  assert.equal(h.room._defenseFailureNotBeforeMs, secondRetryAt);

  h.setNowMs(secondRetryAt);
  await Room.prototype.alarm.call(h.room);
  assert.equal(defenseBundleAttempts, 3);
  assert.equal(h.room.defense.activeOrder, null);
  assert.equal(h.room._defensePersistenceFailures, 0);
  assert.equal(h.room._defenseFailureNotBeforeMs, 0);
});

test('alarm completion and socket cancellation share one Defense mutation lock', async () => {
  const { Room } = await loadRoom();
  const h = await setupManager(Room, { nowMs: 9_000_000, useRealSchedule: true });
  h.room.runDeliveryWake = async () => false;
  await configure(h, h.ws);
  await managerStatus(h, h.ws);
  await send(h, h.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'fire-lock-race',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  const order = structuredClone(h.room.defense.activeOrder);
  h.setNowMs(order.completeAtMs);
  h.room.authOK = async () => true;

  const originalPut = h.room.state.storage.put;
  let releaseCompletion;
  let completionStarted;
  const completionReachedStorage = new Promise(resolve => { completionStarted = resolve; });
  const completionMayFinish = new Promise(resolve => { releaseCompletion = resolve; });
  let holdFirstDefenseBundle = true;
  h.room.state.storage.put = async (key, value) => {
    if (holdFirstDefenseBundle && key && typeof key === 'object' && key['defense:v1']) {
      holdFirstDefenseBundle = false;
      completionStarted();
      await completionMayFinish;
    }
    return originalPut(key, value);
  };

  h.sent.length = 0;
  const alarmPromise = Room.prototype.alarm.call(h.room);
  await completionReachedStorage;
  let cancellationSettled = false;
  const cancellationPromise = send(h, h.ws, {
    t: 'cancelDefense', password: 'qa', mutationId: 'cancel-lock-race',
    orderId: order.id, orderRevision: order.revision
  }).then(() => { cancellationSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellationSettled, false,
    'a socket mutation waits while the alarm owns the Defense transition');

  releaseCompletion();
  await Promise.all([alarmPromise, cancellationPromise]);
  assert.equal(h.room.defense.lastTerminal.status, 'completed');
  assert.equal(lastFrame(h.sent, 'error').error, 'stale_order');
  assert.equal(frames(h.sent, 'defenseOrderCancelled').length, 0);
});

test('Rally command scheduling and alarm processing survive an unreadable Defense namespace', async () => {
  const { Room } = await loadRoom();
  const commandRoom = createRoomHarness(Room, {
    roomName: 'qa', nowMs: 10_000_000, useRealSchedule: true
  });
  const unknownDefenseAlarm = commandRoom.room.nowMs() + 250;
  await commandRoom.room.state.storage.setAlarm(unknownDefenseAlarm);
  commandRoom.storageCalls.length = 0;
  const originalCommandGet = commandRoom.room.state.storage.get;
  commandRoom.room.state.storage.get = async key => {
    if (Array.isArray(key) && key.includes('defense:v1')) {
      throw new Error('injected Defense read failure');
    }
    return originalCommandGet(key);
  };
  commandRoom.room._defenseLoaded = false;
  commandRoom.room.dispatchDeliveryForCommand = async command => {
    commandRoom.calls.push(`delivery:${command.id}`);
    return true;
  };
  const anchorUTC = Math.floor(commandRoom.room.nowMs() / 1000) + 10;

  await assert.doesNotReject(send(commandRoom, commandRoom.ws, {
    t: 'cmd', password: 'separate-master-override', cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC,
      payload: {
        firstPress: anchorUTC, leadSeconds: 10,
        pairs: [
          { pid: '001', role: 'weak', pressUTC: anchorUTC },
          { pid: 'kimchi', role: 'main', pressUTC: anchorUTC }
        ]
      }
    }
  }));
  assert.equal(commandRoom.room.room.live.commands[1].type, 'double_rally');
  assert.ok(commandRoom.calls.includes('persistAll'));
  assert.ok(commandRoom.calls.includes('broadcast'),
    'durable Rally state is broadcast even though Defense cannot load');
  assert.ok(commandRoom.calls.some(call => call.startsWith('delivery:')),
    'reliable delivery dispatch is not blocked by an unrelated Defense read');
  assert.equal(commandRoom.alarmAtMs(), unknownDefenseAlarm,
    'a known earlier alarm from the unreadable surface is not overwritten');
  assert.equal(commandRoom.storageCalls.some(call => call.op === 'deleteAlarm'), false);

  const alarmRoom = createRoomHarness(Room, {
    roomName: 'qa', nowMs: 11_000_000, useRealSchedule: true
  });
  alarmRoom.room.room.live.mode = 'live';
  alarmRoom.room.room.live.commands[1] = {
    id: 'due-rally', type: 'ping', kingdom: 1,
    anchorUTC: Math.floor(alarmRoom.room.nowMs() / 1000) - 6,
    expiresUTC: Math.floor(alarmRoom.room.nowMs() / 1000)
  };
  await alarmRoom.room.state.storage.setAlarm(alarmRoom.room.nowMs());
  alarmRoom.storageCalls.length = 0;
  const originalAlarmGet = alarmRoom.room.state.storage.get;
  alarmRoom.room.state.storage.get = async key => {
    if (Array.isArray(key) && key.includes('defense:v1')) {
      throw new Error('injected Defense alarm read failure');
    }
    return originalAlarmGet(key);
  };
  alarmRoom.room._defenseLoaded = false;
  alarmRoom.room.runDeliveryWake = async () => false;
  await alarmRoom.room.state.storage.deleteAlarm();
  alarmRoom.storageCalls.length = 0;

  await assert.doesNotReject(Room.prototype.alarm.call(alarmRoom.room));
  assert.equal(alarmRoom.room.room.live.commands[1], null,
    'the due Rally transition is processed independently');
  assert.ok(alarmRoom.calls.includes('persist'));
  assert.ok(alarmRoom.calls.includes('broadcast'));
  assert.equal(alarmRoom.alarmAtMs(), alarmRoom.room.nowMs() + 500,
    'an unreadable Defense source receives the first bounded retry instead of a hot loop');
  assert.equal(alarmRoom.storageCalls.some(call => call.op === 'deleteAlarm'), false);
});

test('a failed Rally alarm transition rolls back and retries with bounded delay', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    roomName: 'qa', nowMs: 11_500_000, useRealSchedule: true
  });
  h.room.room.live.mode = 'live';
  h.room.room.live.commands[1] = {
    id: 'rally-persist-retry', type: 'ping', kingdom: 1,
    anchorUTC: Math.floor(h.room.nowMs() / 1000) - 6,
    expiresUTC: Math.floor(h.room.nowMs() / 1000) - 10
  };
  h.room.runDeliveryWake = async () => false;
  let failOnce = true;
  h.room.persist = async roomValue => {
    h.calls.push('persist');
    if (failOnce) {
      failOnce = false;
      throw new Error('injected Rally alarm persistence failure');
    }
    h.storage.set('room', structuredClone(roomValue || h.room.room));
  };

  await assert.doesNotReject(Room.prototype.alarm.call(h.room));
  assert.equal(h.room.room.live.commands[1].id, 'rally-persist-retry',
    'a failed durable transition cannot disappear from memory');
  assert.equal(h.alarmAtMs(), h.room.nowMs() + 500);

  h.setNowMs(h.alarmAtMs());
  await assert.doesNotReject(Room.prototype.alarm.call(h.room));
  assert.equal(h.room.room.live.commands[1], null);
  assert.equal(h.storage.get('room').live.commands[1], null);
  assert.ok(h.calls.includes('broadcast'));
});

test('one Rally mutation lock prevents setConfig from losing concurrent roster mutations', async t => {
  const { Room } = await loadRoom();
  const profileKey = 'ab000000-0000-4000-8000-00000000000b';
  const deviceId = 'bc000000-0000-4000-8000-00000000000c';
  const ownerHash = createHash('sha256').update(profileKey).digest('hex');

  for (const operation of ['register', 'update', 'remove']) {
    await t.test(operation, async () => {
      const h = createRoomHarness(Room, {
        roomName: 'qa', nowMs: 12_000_000 + operation.length
      });
      const player = h.addSocket('rally');
      if (operation !== 'register') {
        h.room.room.players.target = {
          name: 'Target', march: 30, marchRevision: 0, identityMode: 'nickname',
          alliance: '', ready: false, lastSeen: h.room.now()
        };
        h.room.profileOwners = { target: ownerHash };
        await send(h, player.ws, {
          t: 'deviceStatus', pid: 'target', deviceId, soundReady: true
        });
        player.sent.length = 0;
      }

      let releaseConfigPersist;
      let markConfigPersistStarted;
      const configPersistStarted = new Promise(resolve => { markConfigPersistStarted = resolve; });
      const configPersistMayFinish = new Promise(resolve => { releaseConfigPersist = resolve; });
      let persistCalls = 0;
      let operationPersistEntered = false;
      h.room.persist = async roomValue => {
        persistCalls += 1;
        const captured = structuredClone(roomValue || h.room.room);
        if (persistCalls === 1) {
          markConfigPersistStarted();
          await configPersistMayFinish;
        } else {
          operationPersistEntered = true;
          h.storage.set('room', captured);
          return;
        }
        h.storage.set('room', captured);
      };
      h.room.persistAll = async () => {
        operationPersistEntered = true;
        h.storage.set('room', structuredClone(h.room.room));
        h.storage.set('profileOwners', structuredClone(h.room.profileOwners || {}));
      };
      let releaseOperationAfterLoad;
      let markOperationPastSharedLoad;
      const operationPastSharedLoad = new Promise(resolve => { markOperationPastSharedLoad = resolve; });
      const operationMayReachMutation = new Promise(resolve => { releaseOperationAfterLoad = resolve; });
      let holdFirstDeliveryLoad = true;
      h.room.ensureDeliveryLoaded = async () => {
        if (!holdFirstDeliveryLoad) return;
        holdFirstDeliveryLoad = false;
        markOperationPastSharedLoad();
        await operationMayReachMutation;
      };
      let operationPromise;
      if (operation === 'register') {
        operationPromise = send(h, player.ws, {
          t: 'registerPlayer', registrationId: 'concurrent-register', profileKey,
          pid: 'concurrent', identityMode: 'nickname', name: 'Concurrent', march: 41
        });
      } else if (operation === 'update') {
        operationPromise = send(h, player.ws, {
          t: 'updateOwnMarch', mutationId: 'concurrent-update', profileKey,
          pid: 'target', baseRevision: 0, march: 45
        });
      } else {
        operationPromise = send(h, player.ws, {
          t: 'removePlayer', password: 'separate-master-override', pid: 'target'
        });
      }
      await operationPastSharedLoad;

      const configPromise = send(h, h.ws, {
        t: 'setConfig', password: 'separate-master-override',
        config: { castleName: `Locked ${operation}`, rallyAllies: [], enemyWhales: [] },
        by: 'concurrency-test'
      });
      await configPersistStarted;
      releaseOperationAfterLoad();
      for (let turn = 0; turn < 10 && !operationPersistEntered; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      const enteredBeforeConfigCommit = operationPersistEntered;
      releaseConfigPersist();
      await Promise.all([configPromise, operationPromise]);

      assert.equal(enteredBeforeConfigCommit, false,
        `${operation} cannot enter persistence while setConfig owns the canonical Rally transaction`);
      assert.equal(h.room.room.config.castleName, `Locked ${operation}`);
      assert.equal(h.storage.get('room').config.castleName, `Locked ${operation}`);
      if (operation === 'register') {
        assert.equal(h.room.room.players.concurrent.march, 41);
        assert.equal(h.storage.get('room').players.concurrent.march, 41);
      } else if (operation === 'update') {
        assert.equal(h.room.room.players.target.march, 45);
        assert.equal(h.storage.get('room').players.target.march, 45);
      } else {
        assert.equal(h.room.room.players.target, undefined);
        assert.equal(h.storage.get('room').players.target, undefined);
      }
    });
  }
});
