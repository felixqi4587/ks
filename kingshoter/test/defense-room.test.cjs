const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadRoom, createRoomHarness } = require('./room-harness.cjs');

const PROFILE_KEY_A = '10000000-0000-4000-8000-000000000001';
const PROFILE_KEY_B = '20000000-0000-4000-8000-000000000002';
const DEVICE_A = '30000000-0000-4000-8000-000000000003';
const DEVICE_B = '40000000-0000-4000-8000-000000000004';
const MANAGER_DEVICE = '50000000-0000-4000-8000-000000000005';

function ownerHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function send(harness, socket, message) {
  await harness.room.webSocketMessage(socket, JSON.stringify(message));
}

function lastFrame(sent, type) {
  return sent.filter(frame => frame.t === type).at(-1);
}

function wireBytes(frame) {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

async function handshake(harness, socket = harness.ws, sent = harness.sent) {
  await send(harness, socket, { t: 'hello' });
  const state = lastFrame(sent, 'defenseState');
  assert.ok(state, 'Defense must prove the surface with a canonical handshake');
  return state;
}

async function register(harness, socket, sent, input) {
  await send(harness, socket, { t: 'registerPlayer', ...input });
  return lastFrame(sent, 'defenseProfileDelta');
}

test('Defense handshake and registration keep the roster private until a successful unlock', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'defense', players: {} });
  const initial = await handshake(h);

  assert.equal(initial.ownProfile, null);
  assert.equal(initial.activeOrderForOwnProfile, null);
  assert.equal(initial.orderRevision, 0);
  assert.ok(wireBytes(initial) <= 8 * 1024, 'ordinary initial state stays within 8 KiB');
  assert.deepEqual(initial.config, {
    tapAnchorSeconds: 180,
    enemyMarchSeconds: null,
    revision: 0,
    updatedAt: null
  });
  assert.equal(Object.hasOwn(initial, 'players'), false);
  assert.equal(Object.hasOwn(initial, 'playersPage'), false);
  assert.equal(JSON.stringify(initial).includes('Test 001'), false, 'Rally roster cannot cross into Defense');

  h.reset();
  const playerIdDelta = await register(h, h.ws, h.sent, {
    registrationId: 'register-id',
    profileKey: PROFILE_KEY_A,
    pid: 'defender-a',
    identityMode: 'playerId',
    playerId: '900000001',
    name: 'Defender A',
    march: 20
  });
  assert.deepEqual(playerIdDelta, {
    t: 'defenseProfileDelta',
    registrationId: 'register-id',
    rosterRevision: 1,
    profile: {
      pid: 'defender-a', identityMode: 'playerId', playerId: '900000001',
      name: 'Defender A', march: 20, revision: 0, profileGeneration: 1,
      pendingRemoval: false
    }
  });
  assert.equal(h.room.defense.players['defender-a'].playerId, '900000001');
  assert.equal(h.room.defenseProfileOwners['defender-a'], ownerHash(PROFILE_KEY_A));
  assert.equal(JSON.stringify([...h.storage.entries()]).includes(PROFILE_KEY_A), false);
  assert.equal(h.storage.has('room'), false, 'ordinary registration cannot touch the Rally namespace');

  const nickname = h.addSocket('defense');
  await handshake(h, nickname.ws, nickname.sent);
  nickname.sent.length = 0;
  const nicknameDelta = await register(h, nickname.ws, nickname.sent, {
    registrationId: 'register-nickname',
    profileKey: PROFILE_KEY_B,
    pid: 'defender-b',
    identityMode: 'nickname',
    name: 'Mint Fox',
    march: 25
  });
  assert.equal(nicknameDelta.profile.identityMode, 'nickname');
  assert.equal(Object.hasOwn(nicknameDelta.profile, 'playerId'), false);
  assert.equal(h.sent.some(frame => frame.t === 'defenseManagerState'), false);
  assert.equal(nickname.sent.some(frame => frame.t === 'defenseManagerState'), false);

  const manager = h.addSocket('defense');
  await handshake(h, manager.ws, manager.sent);
  manager.sent.length = 0;
  await send(h, manager.ws, { t: 'defenseUnlock', password: 'qa' });
  const managerState = lastFrame(manager.sent, 'defenseManagerState');
  assert.ok(managerState);
  assert.equal(managerState.playersPage.total, 2);
  assert.deepEqual(managerState.playersPage.items.map(profile => profile.pid), ['defender-a', 'defender-b']);
  assert.equal(JSON.stringify(managerState).includes(PROFILE_KEY_A), false);
  assert.equal(JSON.stringify(managerState).includes(ownerHash(PROFILE_KEY_A)), false);
  assert.equal(h.sent.some(frame => frame.t === 'defenseManagerState'), false);

  manager.sent.length = 0;
  await send(h, h.ws, {
    t: 'updateOwnMarch', mutationId: 'bounded-profile-delta', profileKey: PROFILE_KEY_A,
    pid: 'defender-a', baseRevision: 0, march: 21
  });
  assert.ok(lastFrame(manager.sent, 'defenseProfileDelta'));
  assert.equal(manager.sent.some(frame => frame.t === 'defenseManagerState'), false,
    'profile deltas do not append the full manager roster');

  manager.sent.length = 0;
  await send(h, h.ws, {
    t: 'defenseDeviceStatus', pid: 'defender-a', deviceId: DEVICE_A,
    soundReady: true, clockFresh: true
  });
  assert.ok(lastFrame(manager.sent, 'defensePresenceDelta'));
  assert.equal(manager.sent.some(frame => frame.t === 'defenseManagerState'), false,
    'presence deltas do not append the full manager roster');

  const rejectedManager = h.addSocket('defense');
  await handshake(h, rejectedManager.ws, rejectedManager.sent);
  rejectedManager.sent.length = 0;
  await send(h, rejectedManager.ws, { t: 'defenseUnlock', password: 'wrong' });
  assert.equal(lastFrame(rejectedManager.sent, 'error').error, 'bad_password');
  assert.equal(rejectedManager.sent.some(frame => frame.t === 'defenseManagerState'), false);
});

test('a cold Defense password claim preserves the Rally room record and shares only its hash', async () => {
  const { Room } = await loadRoom();
  const rallyRecord = {
    pwHash: null,
    config: { castleName: 'Keep Me', rallyAllies: ['Ally'], enemyWhales: [] },
    players: {
      rallyOnly: {
        name: 'Rally Only', march: 30, marchRevision: 4, alliance: '', ready: false,
        lastSeen: new Date(1_000_000).toISOString()
      }
    },
    live: {
      mode: 'idle', commands: { 1: null, 2: null },
      staged: { 1: null, 2: null }, sim: null
    },
    updatedAt: 'preserve-updated-at',
    updatedBy: 'rally-manager',
    preserveUnknownField: { nested: true }
  };
  const storage = new Map([['room', rallyRecord]]);
  const h = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}, storage
  });
  h.room._rallyLoaded = false;
  h.room._rallyLoadPromise = null;
  await handshake(h);
  h.sent.length = 0;

  await send(h, h.ws, { t: 'defenseUnlock', password: 'qa' });

  const stored = h.storage.get('room');
  assert.equal(stored.pwHash, ownerHash('qa'));
  assert.deepEqual(stored.config, rallyRecord.config);
  assert.deepEqual(stored.players, rallyRecord.players);
  assert.deepEqual(stored.live, rallyRecord.live);
  assert.equal(stored.updatedAt, rallyRecord.updatedAt);
  assert.equal(stored.updatedBy, rallyRecord.updatedBy);
  assert.deepEqual(stored.preserveUnknownField, rallyRecord.preserveUnknownField);
  assert.equal(Object.hasOwn(stored, 'password'), false);

  await h.room.ensureRallyLoaded();
  assert.equal(await h.room.authOK('qa'), true, 'Rally authenticates against the shared hash');
  assert.equal(h.room.room.config.castleName, 'Keep Me');
});

test('a cold Rally load and Defense claim serialize one shared first password winner', async () => {
  const { Room } = await loadRoom();
  const rallyRecord = {
    pwHash: null,
    config: { castleName: 'Cold Rally', rallyAllies: [], enemyWhales: [] },
    players: {},
    live: {
      mode: 'idle', commands: { 1: null, 2: null },
      staged: { 1: null, 2: null }, sim: null
    },
    updatedAt: null,
    updatedBy: null
  };
  const h = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {},
    storage: new Map([['room', rallyRecord]])
  });
  const rally = h.addSocket('rally');
  h.room._rallyLoaded = false;
  h.room._rallyLoadPromise = null;
  h.room._sharedPasswordLoaded = false;
  h.room._sharedRoomRecord = null;
  h.room.persist = async room => h.room.state.storage.put('room', room || h.room.room);
  await handshake(h);

  const originalGet = h.room.state.storage.get;
  let releaseColdRallyRead;
  let coldRallyReadStarted;
  const rallyReadStarted = new Promise(resolve => { coldRallyReadStarted = resolve; });
  const coldRallyReadMayFinish = new Promise(resolve => { releaseColdRallyRead = resolve; });
  let holdFirstRoomRead = true;
  h.room.state.storage.get = async key => {
    if (key === 'room' && holdFirstRoomRead) {
      holdFirstRoomRead = false;
      const staleRecord = structuredClone(h.storage.get('room'));
      coldRallyReadStarted();
      await coldRallyReadMayFinish;
      return staleRecord;
    }
    return originalGet(key);
  };

  const rallyClaim = send(h, rally.ws, {
    t: 'setConfig', password: 'rally-password',
    config: rallyRecord.config, by: 'rally-claimant'
  });
  await rallyReadStarted;
  let defenseSettled = false;
  const defenseClaim = send(h, h.ws, {
    t: 'defenseUnlock', password: 'defense-password'
  }).then(() => { defenseSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(defenseSettled, false,
    'Defense claim waits behind an in-flight cold Rally room read');

  releaseColdRallyRead();
  await Promise.all([rallyClaim, defenseClaim]);
  assert.ok(lastFrame(h.sent, 'defenseManagerState'), 'the queued Defense claimant wins next');
  assert.equal(lastFrame(rally.sent, 'error').error, 'bad_password');
  assert.equal(h.storage.get('room').pwHash, ownerHash('defense-password'));
  assert.equal(await h.room.authOK('defense-password'), true);
  assert.equal(await h.room.authOK('rally-password'), false);
});

test('hot Defense and Rally first claims cannot both report success across the hash await', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}
  });
  const rally = h.addSocket('rally');
  h.room.persist = async room => h.room.state.storage.put('room', room || h.room.room);
  await handshake(h);
  h.sent.length = 0;
  rally.sent.length = 0;

  await Promise.all([
    send(h, h.ws, { t: 'defenseUnlock', password: 'defense-hot' }),
    send(h, rally.ws, {
      t: 'setConfig', password: 'rally-hot',
      config: { castleName: 'Hot Claim', rallyAllies: [], enemyWhales: [] },
      by: 'rally-hot'
    })
  ]);

  const defenseSucceeded = Boolean(lastFrame(h.sent, 'defenseManagerState'));
  const defenseFailed = lastFrame(h.sent, 'error')?.error === 'bad_password';
  const rallyFailed = lastFrame(rally.sent, 'error')?.error === 'bad_password';
  assert.equal(Number(defenseFailed) + Number(rallyFailed), 1,
    'exactly one cross-surface claimant loses');
  assert.equal(defenseSucceeded, rallyFailed);
  const expectedWinner = defenseSucceeded ? 'defense-hot' : 'rally-hot';
  const expectedLoser = defenseSucceeded ? 'rally-hot' : 'defense-hot';
  assert.equal(h.storage.get('room').pwHash, ownerHash(expectedWinner));
  assert.equal(await h.room.authOK(expectedWinner), true);
  assert.equal(await h.room.authOK(expectedLoser), false);
});

test('a conflicted first Rally claim leaves no in-memory authority for Defense', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    roomName: 'qa', surface: 'rally', players: {}
  });
  const defense = h.addSocket('defense');
  h.room.room.updatedAt = 'canonical-update';
  h.storage.set('room', structuredClone(h.room.room));
  h.room.persist = async room => h.room.state.storage.put('room', room || h.room.room);
  const before = structuredClone(h.room.room);

  await send(h, h.ws, {
    t: 'setConfig', password: 'failed-rally-claim', baseUpdatedAt: 'stale-update',
    config: { castleName: 'Must Not Apply', rallyAllies: [], enemyWhales: [] },
    by: 'failed-rally'
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'conflict');
  assert.deepEqual(h.room.room, before);
  assert.deepEqual(h.storage.get('room'), before);

  await send(h, defense.ws, { t: 'defenseUnlock', password: 'durable-winner' });
  assert.ok(lastFrame(defense.sent, 'defenseManagerState'));
  const rejected = h.addSocket('defense');
  await send(h, rejected.ws, { t: 'defenseUnlock', password: 'failed-rally-claim' });
  assert.equal(lastFrame(rejected.sent, 'error').error, 'bad_password',
    'the failed Rally password never became shared authority');
});

test('a failed first Rally persistence restores the whole room before another claim', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    roomName: 'qa', surface: 'rally', players: {}
  });
  const defense = h.addSocket('defense');
  const before = structuredClone(h.room.room);
  let failFirstPersist = true;
  h.room.persist = async room => {
    if (failFirstPersist) {
      failFirstPersist = false;
      throw new Error('injected first-claim persistence failure');
    }
    return h.room.state.storage.put('room', room || h.room.room);
  };

  await assert.rejects(send(h, h.ws, {
    t: 'setConfig', password: 'failed-persist-claim',
    config: { castleName: 'Must Roll Back', rallyAllies: ['Bad'], enemyWhales: [] },
    by: 'failed-persist'
  }), /first-claim persistence failure/);
  assert.deepEqual(h.room.room, before,
    'hash, config, attribution, and timestamps all roll back together');
  assert.equal(h.storage.has('room'), false);

  await send(h, defense.ws, { t: 'defenseUnlock', password: 'retry-winner' });
  assert.ok(lastFrame(defense.sent, 'defenseManagerState'));
  assert.equal(h.storage.get('room').pwHash, ownerHash('retry-winner'));
});

test('existing room and MASTER credentials longer than the new-claim limit remain compatible', async () => {
  const { Room } = await loadRoom();
  const legacyPassword = 'l'.repeat(300);
  const masterPassword = 'm'.repeat(300);
  const h = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {},
    env: { MASTER: masterPassword }
  });
  h.room.room.pwHash = ownerHash(legacyPassword);
  await handshake(h);
  h.sent.length = 0;
  await send(h, h.ws, { t: 'defenseUnlock', password: legacyPassword });
  assert.ok(lastFrame(h.sent, 'defenseManagerState'));

  const master = h.addSocket('defense');
  await send(h, master.ws, { t: 'defenseUnlock', password: masterPassword });
  assert.ok(lastFrame(master.sent, 'defenseManagerState'));
});

test('Defense readiness requires one open tab to hold sound and clock readiness on the same device', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'defense', players: {} });
  await handshake(h);
  await register(h, h.ws, h.sent, {
    registrationId: 'register-ready-owner', profileKey: PROFILE_KEY_A, pid: 'ready-owner',
    identityMode: 'nickname', name: 'Ready Owner', march: 30
  });

  const sibling = h.addSocket('defense');
  await handshake(h, sibling.ws, sibling.sent);
  await register(h, sibling.ws, sibling.sent, {
    registrationId: 'recover-ready-owner', profileKey: PROFILE_KEY_A, pid: 'ready-owner',
    identityMode: 'nickname', name: 'ignored', march: 99
  });
  const manager = h.addSocket('defense');
  await handshake(h, manager.ws, manager.sent);
  manager.sent.length = 0;
  await send(h, manager.ws, { t: 'defenseUnlock', password: 'qa' });

  h.sent.length = 0;
  sibling.sent.length = 0;
  manager.sent.length = 0;
  await send(h, h.ws, {
    t: 'defenseDeviceStatus', pid: 'ready-owner', deviceId: DEVICE_A,
    soundReady: true, clockFresh: false
  });
  await send(h, sibling.ws, {
    t: 'defenseDeviceStatus', pid: 'ready-owner', deviceId: DEVICE_A,
    soundReady: false, clockFresh: true
  });

  const splitPresence = {
    pid: 'ready-owner', connectedDevices: 1,
    audioReadyDevices: 1, clockFreshDevices: 1, readyDevices: 0
  };
  assert.deepEqual(h.room.defensePresence('ready-owner'), splitPresence,
    'two tabs cannot combine separate sound and clock flags into one green device');
  assert.deepEqual(h.room.defensePlayerSnapshot(h.ws).readiness, splitPresence,
    'the ordinary player snapshot carries the same non-composable readiness');
  assert.deepEqual(lastFrame(manager.sent, 'defensePresenceDelta'), {
    t: 'defensePresenceDelta', ...splitPresence
  });
  let managerState = h.room.defenseManagerSnapshot(manager.ws);
  assert.equal(managerState.counts.readyProfiles, 0);
  assert.equal(managerState.playersPage.items[0].readyDevices, 0);

  manager.sent.length = 0;
  await send(h, sibling.ws, {
    t: 'defenseDeviceStatus', pid: 'ready-owner', deviceId: DEVICE_A,
    soundReady: true, clockFresh: true
  });
  assert.equal(h.room.defensePresence('ready-owner').readyDevices, 1,
    'one tab with both flags makes its device ready');
  managerState = h.room.defenseManagerSnapshot(manager.ws);
  assert.equal(managerState.counts.readyProfiles, 1);
  assert.equal(managerState.playersPage.items[0].readyDevices, 1);

  manager.sent.length = 0;
  await h.room.webSocketClose(sibling.ws);
  assert.deepEqual(lastFrame(manager.sent, 'defensePresenceDelta'), {
    t: 'defensePresenceDelta', pid: 'ready-owner', connectedDevices: 1,
    audioReadyDevices: 1, clockFreshDevices: 0, readyDevices: 0
  }, 'a closed ready tab immediately stops contributing to readiness');
});

test('Defense socket binding and rejected device persistence cannot create targetable orphan identities', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'defense', players: {} });
  await handshake(h);
  await register(h, h.ws, h.sent, {
    registrationId: 'bind-owner', profileKey: PROFILE_KEY_A, pid: 'bound-owner',
    identityMode: 'nickname', name: 'Bound Owner', march: 30
  });

  h.sent.length = 0;
  h.storageCalls.length = 0;
  await register(h, h.ws, h.sent, {
    registrationId: 'must-not-orphan', profileKey: PROFILE_KEY_B, pid: 'orphan',
    identityMode: 'nickname', name: 'Orphan', march: 31
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'defense_profile_immutable');
  assert.equal(h.room.defense.players.orphan, undefined);
  assert.equal(h.room.defenseProfileOwners.orphan, undefined);
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, 0);

  const fresh = h.addSocket('defense');
  await handshake(h, fresh.ws, fresh.sent);
  const originalPut = h.room.state.storage.put;
  let rejectRegistration = true;
  h.room.state.storage.put = async (key, value) => {
    if (rejectRegistration && key && typeof key === 'object' && key['defense:v1']) {
      rejectRegistration = false;
      throw new Error('injected registration persistence failure');
    }
    return originalPut(key, value);
  };
  fresh.sent.length = 0;
  await register(h, fresh.ws, fresh.sent, {
    registrationId: 'registration-rollback',
    profileKey: '60000000-0000-4000-8000-000000000006', pid: 'rollback-profile',
    identityMode: 'nickname', name: 'Rollback', march: 32
  });
  assert.equal(lastFrame(fresh.sent, 'error').error, 'registration_persist_failed');
  assert.equal(h.room.readDefenseAttachment(fresh.ws).defenseProfilePid, '');
  assert.equal(h.room.defense.players['rollback-profile'], undefined);

  h.sent.length = 0;
  h.storageCalls.length = 0;
  await send(h, h.ws, {
    t: 'defenseDeviceStatus', pid: 'bound-owner', deviceId: 'invalid-device',
    soundReady: true, clockFresh: true
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'invalid_device_status');
  assert.equal(lastFrame(h.sent, 'defenseDeviceStatusSaved'), undefined);
  assert.equal(h.storageCalls.length, 0,
    'an invalid status cannot write or release a client ACK retry');

  let rejectDevice = true;
  h.room.state.storage.put = async (key, value) => {
    if (rejectDevice && key === 'defenseDevices:v1') {
      rejectDevice = false;
      throw new Error('injected device persistence failure');
    }
    return originalPut(key, value);
  };
  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'defenseDeviceStatus', pid: 'bound-owner', deviceId: DEVICE_A,
    soundReady: true, clockFresh: true
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'device_status_persist_failed');
  assert.equal(lastFrame(h.sent, 'defenseDeviceStatusSaved'), undefined,
    'a failed device write cannot release a client ACK retry');
  const rolledBackAttachment = h.ws.deserializeAttachment();
  assert.equal(rolledBackAttachment.defenseProfilePid, 'bound-owner');
  assert.equal(rolledBackAttachment.pid, '');
  assert.equal(rolledBackAttachment.deviceId, '');
  assert.deepEqual(h.room.defenseConnectedPids(), []);
  assert.equal(h.room.defensePresence('bound-owner').connectedDevices, 0);
  assert.deepEqual(lastFrame(h.sent, 'defensePresenceDelta'), {
    t: 'defensePresenceDelta', pid: 'bound-owner', connectedDevices: 0,
    audioReadyDevices: 0, clockFreshDevices: 0, readyDevices: 0
  }, 'rollback republishes canonical presence after any transient attachment visibility');

  let releaseStatusWrite;
  let statusWriteStarted;
  const statusReachedStorage = new Promise(resolve => { statusWriteStarted = resolve; });
  const statusMayFail = new Promise(resolve => { releaseStatusWrite = resolve; });
  h.room.state.storage.put = async (key, value) => {
    if (key === 'defenseDevices:v1') {
      statusWriteStarted();
      await statusMayFail;
      throw new Error('delayed device persistence failure');
    }
    return originalPut(key, value);
  };
  const statusPromise = send(h, h.ws, {
    t: 'defenseDeviceStatus', pid: 'bound-owner', deviceId: DEVICE_A,
    soundReady: false, clockFresh: false
  });
  await statusReachedStorage;
  let heartbeatSettled = false;
  const heartbeatPromise = send(h, h.ws, {
    t: 'hb', pid: 'bound-owner', deviceId: DEVICE_A,
    soundReady: true, clockFresh: true
  }).then(() => { heartbeatSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heartbeatSettled, false,
    'heartbeat waits behind the canonical device-status transition');
  releaseStatusWrite();
  await Promise.all([statusPromise, heartbeatPromise]);
  const heartbeatAttachment = h.room.readDefenseAttachment(h.ws);
  assert.equal(heartbeatAttachment.pid, 'bound-owner');
  assert.equal(heartbeatAttachment.deviceId, DEVICE_A);
  assert.equal(heartbeatAttachment.soundReady, true);
  assert.equal(heartbeatAttachment.clockFresh, true);

  await send(h, h.ws, { t: 'defenseUnlock', password: 'qa' });
  let releaseManagerRaceStatus;
  let managerRaceStatusStarted;
  const managerRaceReachedStorage = new Promise(resolve => { managerRaceStatusStarted = resolve; });
  const managerRaceStatusMayFail = new Promise(resolve => { releaseManagerRaceStatus = resolve; });
  h.room.state.storage.put = async (key, value) => {
    if (key === 'defenseDevices:v1') {
      managerRaceStatusStarted();
      await managerRaceStatusMayFail;
      throw new Error('delayed manager/device attachment rollback');
    }
    return originalPut(key, value);
  };
  const failingStatus = send(h, h.ws, {
    t: 'defenseDeviceStatus', pid: 'bound-owner', deviceId: DEVICE_A,
    soundReady: false, clockFresh: false
  });
  await managerRaceReachedStorage;
  let managerStatusSettled = false;
  const freshManagerStatus = send(h, h.ws, {
    t: 'defenseManagerStatus', deviceId: MANAGER_DEVICE, clockFresh: true,
    clockSampleAtMs: h.room.nowMs(), clockOffsetMs: 0
  }).then(() => { managerStatusSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(managerStatusSettled, false,
    'manager lease update waits behind a device transition that may restore its attachment snapshot');
  releaseManagerRaceStatus();
  await Promise.all([failingStatus, freshManagerStatus]);
  const managerAttachment = h.room.readDefenseAttachment(h.ws);
  assert.equal(managerAttachment.managerAuthorized, true);
  assert.equal(managerAttachment.managerDeviceId, MANAGER_DEVICE);
  assert.equal(managerAttachment.managerClockFresh, true);
  assert.equal(managerAttachment.managerStatusAtMs, h.room.nowMs());
});

test('Defense profile edits use private ownership, optimistic revisions, and bounded presence deltas', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'defense', players: {} });
  await handshake(h);
  h.sent.length = 0;
  await register(h, h.ws, h.sent, {
    registrationId: 'register-owner', profileKey: PROFILE_KEY_A, pid: 'owner',
    identityMode: 'nickname', name: 'Owner', march: 30
  });
  h.sent.length = 0;

  await send(h, h.ws, {
    t: 'updateOwnMarch', mutationId: 'march-1', profileKey: PROFILE_KEY_A,
    pid: 'owner', baseRevision: 0, march: 31
  });
  assert.equal(lastFrame(h.sent, 'defenseProfileDelta').mutationId, 'march-1');
  assert.deepEqual(lastFrame(h.sent, 'defenseProfileDelta').profile, {
    pid: 'owner', identityMode: 'nickname', name: 'Owner', march: 31,
    revision: 1, profileGeneration: 1, pendingRemoval: false
  });
  assert.equal(lastFrame(h.sent, 'defenseProfileDelta').appliesNextRound, false,
    'a waiting self march edit applies to the current canonical waiting profile');

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'updateOwnMarch', mutationId: 'march-stale', profileKey: PROFILE_KEY_A,
    pid: 'owner', baseRevision: 0, march: 32
  });
  assert.deepEqual(lastFrame(h.sent, 'error'), {
    t: 'error', source: 'updateOwnMarch', mutationId: 'march-stale',
    error: 'player_conflict', canonicalRevision: 1
  });

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'updateOwnProfile', mutationId: 'profile-bad-owner', profileKey: PROFILE_KEY_B,
    pid: 'owner', baseRevision: 1, identityMode: 'playerId', playerId: '900000009',
    name: 'Stolen', march: 32
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'profile_owner_mismatch');
  assert.equal(h.room.defense.players.owner.name, 'Owner');

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'updateOwnProfile', mutationId: 'profile-2', profileKey: PROFILE_KEY_A,
    pid: 'owner', baseRevision: 1, identityMode: 'playerId', playerId: '900000009',
    name: 'Resolved Owner', march: 32
  });
  assert.equal(lastFrame(h.sent, 'defenseProfileDelta').profile.revision, 2);
  assert.equal(lastFrame(h.sent, 'defenseProfileDelta').profile.playerId, '900000009');
  assert.equal(lastFrame(h.sent, 'defenseProfileDelta').appliesNextRound, false);

  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'updateOwnProfile', mutationId: 'profile-stale', profileKey: PROFILE_KEY_A,
    pid: 'owner', baseRevision: 1, identityMode: 'nickname', name: 'Stale', march: 33
  });
  assert.deepEqual(lastFrame(h.sent, 'error'), {
    t: 'error', source: 'updateOwnProfile', mutationId: 'profile-stale',
    error: 'player_conflict', canonicalRevision: 2
  });

  const unauthenticatedManager = h.addSocket('defense');
  await handshake(h, unauthenticatedManager.ws, unauthenticatedManager.sent);
  unauthenticatedManager.sent.length = 0;
  h.storageCalls.length = 0;
  await send(h, unauthenticatedManager.ws, {
    t: 'setDefensePlayerMarch', password: 'wrong', mutationId: 'manager-no-probe',
    pid: 'missing-profile', baseRevision: 0, march: 40
  });
  assert.deepEqual(lastFrame(unauthenticatedManager.sent, 'error'), {
    t: 'error', source: 'setDefensePlayerMarch', mutationId: 'manager-no-probe',
    error: 'bad_password'
  });
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, 0,
    'failed manager auth neither probes roster membership nor writes');

  unauthenticatedManager.sent.length = 0;
  await send(h, unauthenticatedManager.ws, { t: 'defenseUnlock', password: 'qa' });
  unauthenticatedManager.sent.length = 0;
  await send(h, unauthenticatedManager.ws, {
    t: 'setDefensePlayerMarch', password: 'qa', mutationId: 'manager-waiting-march',
    pid: 'owner', profileGeneration: 1, baseRevision: 2, march: 33
  });
  assert.equal(lastFrame(unauthenticatedManager.sent, 'defenseProfileDelta').appliesNextRound, false,
    'a waiting manager march edit is not mislabeled as a next-round-only change');

  h.sent.length = 0;
  h.storageCalls.length = 0;
  await send(h, h.ws, {
    t: 'defenseDeviceStatus', pid: 'owner', deviceId: DEVICE_A,
    soundReady: true, clockFresh: true
  });
  assert.deepEqual(lastFrame(h.sent, 'defensePresenceDelta'), {
    t: 'defensePresenceDelta', pid: 'owner', connectedDevices: 1,
    audioReadyDevices: 1, clockFreshDevices: 1, readyDevices: 1
  });
  assert.deepEqual(h.storageCalls.filter(call => call.op === 'put').map(call => call.keys), [
    ['defenseDevices:v1']
  ]);
  assert.deepEqual(lastFrame(h.sent, 'defenseDeviceStatusSaved'), {
    t: 'defenseDeviceStatusSaved', pid: 'owner', deviceId: DEVICE_A,
    soundReady: true, clockFresh: true
  });
  assert.ok(wireBytes(lastFrame(h.sent, 'defenseDeviceStatusSaved')) <= 2 * 1024,
    'device-status persistence receipts stay below 2 KiB');
  assert.equal(h.sent.some(frame => frame.t === 'defenseState'), false,
    'a device-status receipt does not amplify into an ordinary full snapshot');

  h.storageCalls.length = 0;
  h.sent.length = 0;
  await send(h, h.ws, {
    t: 'defenseDeviceStatus', pid: 'owner', deviceId: DEVICE_A,
    soundReady: true, clockFresh: true
  });
  assert.deepEqual(h.sent, [{
    t: 'defenseDeviceStatusSaved', pid: 'owner', deviceId: DEVICE_A,
    soundReady: true, clockFresh: true
  }], 'an unchanged canonical status still releases the exact client retry without a delta');
  assert.equal(h.storageCalls.length, 0,
    'an unchanged canonical status does not rewrite the device row');

  const sibling = h.addSocket('defense');
  await handshake(h, sibling.ws, sibling.sent);
  sibling.sent.length = 0;
  await register(h, sibling.ws, sibling.sent, {
    registrationId: 'recover-owner', profileKey: PROFILE_KEY_A, pid: 'owner',
    identityMode: 'nickname', name: 'ignored', march: 99
  });
  sibling.sent.length = 0;
  h.sent.length = 0;
  await send(h, sibling.ws, {
    t: 'defenseDeviceStatus', pid: 'owner', deviceId: DEVICE_B,
    soundReady: false, clockFresh: true
  });
  assert.equal(lastFrame(sibling.sent, 'defensePresenceDelta').connectedDevices, 2);
  assert.equal(lastFrame(sibling.sent, 'defensePresenceDelta').audioReadyDevices, 1);
  assert.equal(lastFrame(sibling.sent, 'defensePresenceDelta').readyDevices, 1);
  assert.deepEqual(lastFrame(sibling.sent, 'defenseDeviceStatusSaved'), {
    t: 'defenseDeviceStatusSaved', pid: 'owner', deviceId: DEVICE_B,
    soundReady: false, clockFresh: true
  });
  assert.equal(lastFrame(h.sent, 'defenseDeviceStatusSaved'), undefined,
    'device-status receipts are sender-only even while presence deltas broadcast');

  h.storageCalls.length = 0;
  h.sent.length = 0;
  for (let index = 0; index < 20; index += 1) {
    await send(h, h.ws, {
      t: 'hb', pid: 'owner', deviceId: DEVICE_A, soundReady: true, clockFresh: true
    });
  }
  assert.equal(h.storageCalls.length, 0, 'steady heartbeats are transient');
  assert.equal(h.sent.some(frame => frame.t === 'defensePresenceDelta'), false,
    'unchanged heartbeats do not emit periodic deltas');
  assert.equal(h.calls.includes('broadcast'), false, 'Defense never enters Rally full-room broadcast');
});

test('maximum active Defense roster uses bounded merged manager pages without losing current or frozen facts', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'defense', players: {} });
  await handshake(h);
  h.room.defense.players = {};
  const expectedPids = [];
  for (let index = 0; index < 150; index += 1) {
    const pid = `p${String(index).padStart(3, '0')}${'x'.repeat(20)}`;
    const playerId = `9${String(index).padStart(15, '0')}`;
    expectedPids.push(pid);
    assert.equal(pid.length, 24);
    assert.equal(playerId.length, 16);
    h.room.defense.players[pid] = {
      name: '😀'.repeat(24), playerId, march: 120, marchRevision: 0,
      identityMode: 'playerId',
      lastSeen: new Date(h.nowMs).toISOString()
    };
    h.addSocket('defense', {
      defenseProfilePid: pid, pid,
      deviceId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      soundReady: true, clockFresh: true
    });
  }

  const manager = h.addSocket('defense');
  await handshake(h, manager.ws, manager.sent);
  await send(h, manager.ws, { t: 'defenseUnlock', password: 'qa' });
  await send(h, manager.ws, {
    t: 'defenseManagerStatus', deviceId: MANAGER_DEVICE, clockFresh: true,
    clockSampleAtMs: h.room.nowMs(), clockOffsetMs: 0
  });
  await send(h, manager.ws, {
    t: 'setDefenseConfig', password: 'qa', mutationId: 'active-cap-config', baseRevision: 0,
    tapAnchorSeconds: 300, enemyMarchSeconds: 120
  });
  assert.ok(manager.sent.filter(frame => frame.t === 'defenseManagerState')
    .every(frame => wireBytes(frame) <= 96 * 1024),
  'unlock and configuration snapshots also stay bounded at the maximum legal roster');
  manager.sent.length = 0;
  await send(h, manager.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'active-cap-fire', configRevision: 1,
    signalAtMs: h.room.nowMs()
  });

  const snapshot = lastFrame(manager.sent, 'defenseManagerState');
  assert.equal(snapshot.playersPage.page, 1);
  assert.equal(snapshot.playersPage.pageSize, 50);
  assert.equal(snapshot.playersPage.total, 150);
  assert.equal(snapshot.playersPage.totalPages, 3);
  assert.equal(snapshot.playersPage.items.length, 50);
  assert.equal(Object.hasOwn(snapshot.activeOrder, 'profiles'), false,
    'per-profile order facts are merged into the paged player rows instead of duplicated');
  assert.equal(Object.hasOwn(snapshot.activeOrder.delivery, 'profiles'), false,
    'profile delivery details are likewise carried only by the merged rows');
  const first = snapshot.playersPage.items[0];
  assert.equal(first.name, '😀'.repeat(24));
  assert.equal(first.playerId.length, 16);
  assert.equal(first.march, 120, 'the flat row remains the canonical next-round profile');
  assert.equal(first.readyDevices, 1);
  assert.deepEqual(first.activeRound, {
    displayName: '😀'.repeat(24), identityMode: 'playerId', playerId: first.playerId,
    march: 120, marchRevision: 0, connectedAtAcceptance: true,
    validAtAcceptance: true, targeted: true,
    goAtMs: h.room.defense.activeOrder.audience[0].goAtMs,
    tooLate: false, outcome: 'unconfirmed', acknowledgedDevices: 0,
    scheduledDevices: 0, deliveredScheduled: false, audioReady: false
  }, 'each merged row keeps the immutable round facts and profile-level delivery truth');
  assert.ok(manager.sent.every(frame => wireBytes(frame) <= 96 * 1024),
    'every manager frame emitted for the maximum online roster stays within 96 KiB');

  const pages = [snapshot.playersPage];
  for (const page of [2, 3]) {
    manager.sent.length = 0;
    const writesBeforePage = h.storageCalls.filter(call => call.op === 'put').length;
    await send(h, manager.ws, {
      t: 'getDefenseManagerPlayersPage', page,
      baseRosterRevision: snapshot.playersPage.baseRosterRevision,
      baseOrderRevision: snapshot.playersPage.baseOrderRevision
    });
    const frame = lastFrame(manager.sent, 'defenseManagerPlayersPage');
    assert.ok(frame, `manager can retrieve page ${page}`);
    assert.equal(frame.playersPage.page, page);
    assert.equal(frame.playersPage.items.length, 50);
    assert.equal(frame.activeOrderId, h.room.defense.activeOrder.id);
    assert.ok(wireBytes(frame) <= 96 * 1024, `page ${page} stays within 96 KiB`);
    assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesBeforePage,
      'read-only pagination never writes canonical state');
    pages.push(frame.playersPage);
  }
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.pid)), expectedPids);
  assert.equal(/profileKey|secret/i.test(JSON.stringify(pages)), false);
});

test('Defense enforces the 150-profile cap and idempotent revision-protected manager removal', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'defense', players: {} });
  await handshake(h);
  h.room.defense.players = {};
  for (let index = 0; index < 150; index += 1) {
    const pid = `p${String(index).padStart(3, '0')}`;
    h.room.defense.players[pid] = {
      name: pid, march: 30, marchRevision: 0, identityMode: 'nickname',
      lastSeen: new Date(h.nowMs).toISOString()
    };
  }
  h.sent.length = 0;
  await register(h, h.ws, h.sent, {
    registrationId: 'over-cap', profileKey: PROFILE_KEY_A, pid: 'overflow',
    identityMode: 'nickname', name: 'Overflow', march: 30
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'roster_full');
  assert.equal(Object.keys(h.room.defense.players).length, 150);

  const capManager = h.addSocket('defense');
  await handshake(h, capManager.ws, capManager.sent);
  capManager.sent.length = 0;
  await send(h, capManager.ws, { t: 'defenseUnlock', password: 'qa' });
  const capSnapshot = lastFrame(capManager.sent, 'defenseManagerState');
  assert.equal(capSnapshot.playersPage.total, 150);
  assert.equal(capSnapshot.playersPage.pageSize, 50);
  assert.equal(capSnapshot.playersPage.totalPages, 3);
  assert.ok(wireBytes(capSnapshot) <= 96 * 1024,
    'the first bounded page of a 150-profile waiting roster stays within 96 KiB');

  capManager.sent.length = 0;
  const managerKeepalive = {
    t: 'defenseManagerStatus', deviceId: MANAGER_DEVICE, clockFresh: true,
    clockSampleAtMs: h.room.nowMs(), clockOffsetMs: 0
  };
  await send(h, capManager.ws, managerKeepalive);
  await send(h, capManager.ws, managerKeepalive);
  const leaseReceipts = capManager.sent.filter(frame => frame.t === 'defenseManagerStatusSaved');
  assert.equal(leaseReceipts.length, 2);
  assert.deepEqual(leaseReceipts.at(-1), {
    t: 'defenseManagerStatusSaved', managerClockFresh: true,
    managerLeaseUntilMs: h.room.nowMs() + 70_000, orderRevision: 0
  });
  assert.ok(leaseReceipts.every(frame => wireBytes(frame) <= 2 * 1024),
    'periodic manager lease receipts stay below 2 KiB');
  assert.equal(capManager.sent.some(frame => frame.t === 'defenseManagerState'), false,
    'periodic manager status never resends the 150-profile roster');

  h.room.defense.players = {};
  h.room.defenseProfileOwners = {};
  h.sent.length = 0;
  await register(h, h.ws, h.sent, {
    registrationId: 'remove-me', profileKey: PROFILE_KEY_A, pid: 'remove-me',
    identityMode: 'nickname', name: 'Remove Me', march: 30
  });
  const manager = h.addSocket('defense');
  await handshake(h, manager.ws, manager.sent);
  await send(h, manager.ws, { t: 'defenseUnlock', password: 'qa' });
  manager.sent.length = 0;
  h.storageCalls.length = 0;
  const removal = {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'remove-1',
    pid: 'remove-me', profileGeneration: 1, baseRevision: 0
  };
  await send(h, manager.ws, removal);
  assert.equal(h.room.defense.players['remove-me'], undefined);
  assert.equal(h.room.defenseProfileOwners['remove-me'], undefined);
  assert.deepEqual(h.storage.get('defenseRemovedOwners:v1'), [
    { pid: 'remove-me', ownerHash: ownerHash(PROFILE_KEY_A) }
  ]);
  assert.deepEqual(lastFrame(manager.sent, 'defenseProfileDelta'), {
    t: 'defenseProfileDelta', mutationId: 'remove-1', pid: 'remove-me',
    removed: true, pending: false, rosterRevision: 2, profile: null
  });
  const putsAfterFirst = h.storageCalls.filter(call => call.op === 'put').length;
  await send(h, manager.ws, removal);
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, putsAfterFirst,
    'duplicate removal is replayed without a second canonical write');

  const staleOwner = h.addSocket('defense');
  await handshake(h, staleOwner.ws, staleOwner.sent);
  staleOwner.sent.length = 0;
  const writesBeforeStaleOwner = h.storageCalls.filter(call => call.op === 'put').length;
  await register(h, staleOwner.ws, staleOwner.sent, {
    registrationId: 'stale-owner-reconnect', profileKey: PROFILE_KEY_A, pid: 'remove-me',
    identityMode: 'nickname', name: 'Must Stay Removed', march: 30
  });
  assert.equal(lastFrame(staleOwner.sent, 'error').error, 'profile_removed');
  assert.equal(h.room.defense.players['remove-me'], undefined);
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesBeforeStaleOwner,
    'a removed owner credential cannot recreate its profile');

  const replacementKey = '70000000-0000-4000-8000-000000000007';
  staleOwner.sent.length = 0;
  await register(h, staleOwner.ws, staleOwner.sent, {
    registrationId: 'explicit-reregister', profileKey: replacementKey, pid: 'remove-me',
    identityMode: 'nickname', name: 'Explicit Replacement', march: 31
  });
  assert.equal(lastFrame(staleOwner.sent, 'defenseProfileDelta').profile.name,
    'Explicit Replacement');
  assert.equal(h.room.defenseProfileOwners['remove-me'], ownerHash(replacementKey));
  assert.deepEqual(h.room.defenseRemovedOwners.filter(entry => entry.pid === 'remove-me'), [
    { pid: 'remove-me', ownerHash: ownerHash(PROFILE_KEY_A) }
  ], 'fresh ownership retains older removed credentials in the bounded deny set');
  const writesAfterReplacement = h.storageCalls.filter(call => call.op === 'put').length;
  manager.sent.length = 0;
  await send(h, manager.ws, removal);
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesAfterReplacement);
  assert.deepEqual(lastFrame(manager.sent, 'defenseProfileDelta'), {
    t: 'defenseProfileDelta', mutationId: 'remove-1', pid: 'remove-me',
    removed: false, pending: false, rosterRevision: 3,
    profile: {
      pid: 'remove-me', identityMode: 'nickname', name: 'Explicit Replacement',
      march: 31, revision: 0, profileGeneration: 2, pendingRemoval: false
    }
  }, 'an old immediate-remove replay projects the live replacement canonically');

  await send(h, manager.ws, {
    ...removal, mutationId: 'remove-2', profileGeneration: 2, baseRevision: 0
  });
  assert.equal(h.room.defense.players['remove-me'], undefined);
  assert.deepEqual(h.room.defenseRemovedOwners.filter(entry => entry.pid === 'remove-me'), [
    { pid: 'remove-me', ownerHash: ownerHash(PROFILE_KEY_A) },
    { pid: 'remove-me', ownerHash: ownerHash(replacementKey) }
  ]);

  for (const [registrationId, profileKey] of [
    ['old-owner-generation-a', PROFILE_KEY_A],
    ['old-owner-generation-b', replacementKey]
  ]) {
    const oldGeneration = h.addSocket('defense');
    await handshake(h, oldGeneration.ws, oldGeneration.sent);
    oldGeneration.sent.length = 0;
    await register(h, oldGeneration.ws, oldGeneration.sent, {
      registrationId, profileKey, pid: 'remove-me',
      identityMode: 'nickname', name: 'Must Stay Removed', march: 31
    });
    assert.equal(lastFrame(oldGeneration.sent, 'error').error, 'profile_removed',
      `${registrationId} cannot resurrect the twice-removed profile`);
  }
  const thirdGeneration = h.addSocket('defense');
  await handshake(h, thirdGeneration.ws, thirdGeneration.sent);
  thirdGeneration.sent.length = 0;
  const thirdKey = '80000000-0000-4000-8000-000000000008';
  await register(h, thirdGeneration.ws, thirdGeneration.sent, {
    registrationId: 'explicit-third-generation', profileKey: thirdKey, pid: 'remove-me',
    identityMode: 'nickname', name: 'Third Generation', march: 32
  });
  assert.equal(lastFrame(thirdGeneration.sent, 'defenseProfileDelta').profile.name,
    'Third Generation', 'a genuinely new owner key can explicitly register');

  await send(h, manager.ws, {
    ...removal, mutationId: 'remove-stale', pid: 'missing',
    profileGeneration: 3, baseRevision: 99
  });
  const conflict = lastFrame(manager.sent, 'error');
  assert.equal(conflict.error, 'order_conflict');
  assert.equal(conflict.canonicalRevision, 0);
  assert.equal(manager.ws.deserializeAttachment().pid, '', 'manager-only socket never becomes a defender');
  assert.equal(manager.ws.deserializeAttachment().deviceId, '');

  await send(h, manager.ws, {
    t: 'defenseManagerStatus', deviceId: MANAGER_DEVICE, clockFresh: true,
    clockSampleAtMs: h.nowMs, clockOffsetMs: 0
  });
  assert.equal(manager.ws.deserializeAttachment().pid, '');
  assert.equal(manager.ws.deserializeAttachment().deviceId, '');
  assert.equal(manager.ws.deserializeAttachment().managerDeviceId, MANAGER_DEVICE);
});

test('WebSocket ingress caps operational frames and passwords before expensive processing', async () => {
  const { Room } = await loadRoom();
  const oversized = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}
  });
  await handshake(oversized);
  oversized.reset();
  const oversizedRaw = JSON.stringify({
    t: 'registerPlayer', registrationId: 'oversized-name', profileKey: PROFILE_KEY_A,
    pid: 'oversized', identityMode: 'nickname', name: 'x'.repeat(70 * 1024), march: 30
  });
  await oversized.room.webSocketMessage(oversized.ws, oversizedRaw);
  assert.equal(oversized.ws.readyState, 3, 'a frame above 64 KiB is closed before JSON parsing');
  assert.equal(oversized.storageCalls.length, 0);
  assert.equal(oversized.room.defense.players.oversized, undefined);

  const binary = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}
  });
  await handshake(binary);
  binary.reset();
  await binary.room.webSocketMessage(binary.ws, new Uint8Array([1, 2, 3]));
  assert.equal(binary.ws.readyState, 3, 'non-string operational frames are rejected before parsing');
  assert.equal(binary.storageCalls.length, 0);

  const password = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}
  });
  await handshake(password);
  password.reset();
  await send(password, password.ws, {
    t: 'defenseUnlock', password: 'p'.repeat(257)
  });
  assert.equal(lastFrame(password.sent, 'error').error, 'bad_password');
  assert.equal(password.storage.has('room'), false,
    'an oversized password is rejected before hashing or claiming storage');
  assert.equal(password.room.readDefenseAttachment(password.ws).managerAuthorized, false);

  password.sent.length = 0;
  await send(password, password.ws, { t: 'defenseUnlock', password: 'qa' });
  assert.ok(lastFrame(password.sent, 'defenseManagerState'),
    'the rejected input leaves the shared claim lock available to a valid password');
});

test('manager pagination restarts when the persisted roster generation changes between pages', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'defense', players: {} });
  await handshake(h);
  h.room.defense.players = Object.fromEntries(Array.from({ length: 52 }, (_, index) => {
    const pid = `paged-${String(index).padStart(3, '0')}`;
    return [pid, {
      name: pid, march: 30, marchRevision: 0, identityMode: 'nickname',
      profileGeneration: index + 1, lastSeen: new Date(h.nowMs).toISOString()
    }];
  }));
  h.room.defense.profileGenerationCounter = 52;
  h.room.defense.rosterRevision = 52;

  const manager = h.addSocket('defense');
  await handshake(h, manager.ws, manager.sent);
  manager.sent.length = 0;
  await send(h, manager.ws, { t: 'defenseUnlock', password: 'qa' });
  const firstSnapshot = lastFrame(manager.sent, 'defenseManagerState');
  assert.equal(firstSnapshot.rosterRevision, 52);
  assert.equal(firstSnapshot.playersPage.rosterRevision, 52);
  assert.equal(firstSnapshot.playersPage.baseRosterRevision, 52);
  assert.equal(firstSnapshot.playersPage.baseOrderRevision, 0);
  assert.deepEqual(firstSnapshot.playersPage.items.map(item => item.pid),
    Array.from({ length: 50 }, (_, index) => `paged-${String(index).padStart(3, '0')}`));

  manager.sent.length = 0;
  await send(h, manager.ws, {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'paged-remove-first',
    pid: 'paged-000', profileGeneration: 1, baseRevision: 0
  });
  assert.equal(h.room.defense.rosterRevision, 53);

  manager.sent.length = 0;
  const writesBeforeStalePage = h.storageCalls.filter(call => call.op === 'put').length;
  await send(h, manager.ws, {
    t: 'getDefenseManagerPlayersPage', page: 2,
    baseRosterRevision: 52, baseOrderRevision: 0
  });
  assert.deepEqual(lastFrame(manager.sent, 'error'), {
    t: 'error', source: 'getDefenseManagerPlayersPage', error: 'roster_conflict',
    canonicalRosterRevision: 53
  });
  assert.equal(lastFrame(manager.sent, 'defenseManagerPlayersPage'), undefined);
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesBeforeStalePage);

  manager.sent.length = 0;
  await send(h, manager.ws, { t: 'getDefenseManagerPlayersPage', page: 1 });
  const restartedFirst = lastFrame(manager.sent, 'defenseManagerPlayersPage');
  assert.equal(restartedFirst.rosterRevision, 53);
  assert.equal(restartedFirst.playersPage.baseRosterRevision, 53);
  assert.equal(restartedFirst.playersPage.baseOrderRevision, 0);
  await send(h, manager.ws, {
    t: 'getDefenseManagerPlayersPage', page: 2,
    baseRosterRevision: 53, baseOrderRevision: 0
  });
  const restartedSecond = lastFrame(manager.sent, 'defenseManagerPlayersPage');
  assert.equal(restartedSecond.rosterRevision, 53);
  assert.deepEqual(
    restartedFirst.playersPage.items.concat(restartedSecond.playersPage.items).map(item => item.pid),
    Array.from({ length: 51 }, (_, index) => `paged-${String(index + 1).padStart(3, '0')}`),
    'a restarted scan returns every unchanged player exactly once'
  );

  manager.sent.length = 0;
  await send(h, manager.ws, { t: 'getDefenseManagerPlayersPage', page: 2 });
  assert.deepEqual(lastFrame(manager.sent, 'error'), {
    t: 'error', source: 'getDefenseManagerPlayersPage', error: 'roster_conflict',
    canonicalRosterRevision: 53
  }, 'page 1 is the only entry point that may omit the scan epoch');

  await send(h, manager.ws, {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'paged-remove-second',
    pid: 'paged-001', profileGeneration: 2, baseRevision: 0
  });
  manager.sent.length = 0;
  await send(h, manager.ws, {
    t: 'getDefenseManagerPlayersPage', page: 2,
    baseRosterRevision: 53, baseOrderRevision: 0
  });
  assert.equal(h.room.defense.rosterRevision, 54);
  assert.deepEqual(lastFrame(manager.sent, 'error'), {
    t: 'error', source: 'getDefenseManagerPlayersPage', error: 'roster_conflict',
    canonicalRosterRevision: 54
  }, 'epoch validation precedes page bounds after page 2 disappears');

  for (let index = 0; index < 2; index += 1) {
    const added = h.addSocket('defense');
    await handshake(h, added.ws, added.sent);
    added.sent.length = 0;
    await register(h, added.ws, added.sent, {
      registrationId: `paged-add-${index}`,
      profileKey: `a${index}000000-0000-4000-8000-00000000000${index}`,
      pid: `added-${index}`, identityMode: 'nickname', name: `Added ${index}`, march: 30
    });
  }
  assert.equal(h.room.defense.rosterRevision, 56);
  manager.sent.length = 0;
  await send(h, manager.ws, { t: 'getDefenseManagerPlayersPage', page: 1 });
  const idleEpoch = lastFrame(manager.sent, 'defenseManagerPlayersPage').playersPage;
  assert.equal(idleEpoch.baseRosterRevision, 56);
  assert.equal(idleEpoch.baseOrderRevision, 0);
  await send(h, manager.ws, {
    t: 'setDefenseConfig', password: 'qa', mutationId: 'paged-config',
    baseRevision: 0, tapAnchorSeconds: 5, enemyMarchSeconds: 60
  });
  await send(h, manager.ws, {
    t: 'defenseManagerStatus', deviceId: MANAGER_DEVICE, clockFresh: true,
    clockSampleAtMs: h.room.nowMs(), clockOffsetMs: 0
  });
  await send(h, manager.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'paged-fire',
    configRevision: 1, signalAtMs: h.room.nowMs()
  });
  assert.equal(h.room.defense.orderRevision, 1);
  manager.sent.length = 0;
  await send(h, manager.ws, {
    t: 'getDefenseManagerPlayersPage', page: 2,
    baseRosterRevision: 56, baseOrderRevision: 0
  });
  assert.deepEqual(lastFrame(manager.sent, 'error'), {
    t: 'error', source: 'getDefenseManagerPlayersPage', error: 'order_conflict',
    canonicalRevision: 1, canonicalOrderRevision: 1, canonicalRosterRevision: 56
  }, 'an idle page cannot be mixed with active-round rows from a later order epoch');
});

test('profile generations reject stale manager edits and removals after same-pid replacement', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'defense', players: {} });
  await handshake(h);
  await register(h, h.ws, h.sent, {
    registrationId: 'aba-register-a', profileKey: PROFILE_KEY_A, pid: 'same-pid',
    identityMode: 'nickname', name: 'Generation A', march: 30
  });
  const generationA = lastFrame(h.sent, 'defenseProfileDelta').profile.profileGeneration;
  assert.ok(Number.isSafeInteger(generationA) && generationA > 0);

  const manager = h.addSocket('defense');
  await handshake(h, manager.ws, manager.sent);
  await send(h, manager.ws, { t: 'defenseUnlock', password: 'qa' });
  const managerA = lastFrame(manager.sent, 'defenseManagerState').playersPage.items
    .find(item => item.pid === 'same-pid');
  assert.equal(managerA.profileGeneration, generationA);
  await send(h, manager.ws, {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'aba-remove-a',
    pid: 'same-pid', profileGeneration: generationA, baseRevision: 0
  });
  assert.equal(h.room.defense.players['same-pid'], undefined);

  const replacement = h.addSocket('defense');
  await handshake(h, replacement.ws, replacement.sent);
  replacement.sent.length = 0;
  const replacementKey = '90000000-0000-4000-8000-000000000009';
  await register(h, replacement.ws, replacement.sent, {
    registrationId: 'aba-register-b', profileKey: replacementKey, pid: 'same-pid',
    identityMode: 'nickname', name: 'Generation B', march: 31
  });
  const generationB = lastFrame(replacement.sent, 'defenseProfileDelta').profile.profileGeneration;
  assert.ok(generationB > generationA);

  manager.sent.length = 0;
  await send(h, manager.ws, {
    t: 'setDefensePlayerMarch', password: 'qa', mutationId: 'aba-stale-edit',
    pid: 'same-pid', profileGeneration: generationA, baseRevision: 0, march: 99
  });
  assert.deepEqual(lastFrame(manager.sent, 'error'), {
    t: 'error', source: 'setDefensePlayerMarch', mutationId: 'aba-stale-edit',
    error: 'profile_generation_conflict', canonicalProfileGeneration: generationB
  });
  assert.equal(h.room.defense.players['same-pid'].march, 31);

  await send(h, manager.ws, {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'aba-stale-remove',
    pid: 'same-pid', profileGeneration: generationA, baseRevision: 0
  });
  assert.deepEqual(lastFrame(manager.sent, 'error'), {
    t: 'error', source: 'removeDefensePlayer', mutationId: 'aba-stale-remove',
    error: 'profile_generation_conflict', canonicalProfileGeneration: generationB
  });
  assert.equal(h.room.defense.players['same-pid'].name, 'Generation B');

  await send(h, manager.ws, {
    t: 'setDefensePlayerMarch', password: 'qa', mutationId: 'aba-current-edit',
    pid: 'same-pid', profileGeneration: generationB, baseRevision: 0, march: 32
  });
  assert.equal(h.room.defense.players['same-pid'].march, 32);
  await send(h, manager.ws, {
    t: 'removeDefensePlayer', password: 'qa', mutationId: 'aba-current-remove',
    pid: 'same-pid', profileGeneration: generationB, baseRevision: 0
  });
  assert.equal(h.room.defense.players['same-pid'], undefined);
});

test('legacy Defense profile generations are deterministic and write-free on cold handshakes', async () => {
  const { Room } = await loadRoom();
  const legacy = {
    version: 1,
    config: {
      tapAnchorSeconds: 180, enemyMarchSeconds: null, revision: 0, updatedAt: null
    },
    players: {
      a: { name: 'A', march: 20, marchRevision: 0, identityMode: 'nickname' },
      b: { name: 'B', march: 21, marchRevision: 0, identityMode: 'nickname', profileGeneration: 5 },
      c: { name: 'C', march: 22, marchRevision: 0, identityMode: 'nickname', profileGeneration: 5 }
    },
    rosterRevision: 7,
    profileGenerationCounter: 2,
    pendingRemovalPids: [], orderRevision: 0, activeOrder: null,
    lastTerminal: null, recentMutations: []
  };
  const storage = new Map([['defense:v1', structuredClone(legacy)]]);
  const generations = [];

  for (let reload = 0; reload < 2; reload += 1) {
    const h = createRoomHarness(Room, {
      roomName: 'qa', surface: 'defense', players: {}, storage
    });
    await handshake(h);
    generations.push(Object.fromEntries(Object.entries(h.room.defense.players)
      .map(([pid, profile]) => [pid, profile.profileGeneration])));
    assert.equal(h.storageCalls.filter(call => call.op === 'put').length, 0,
      'a read or handshake never persists the pure migration');
    assert.deepEqual(storage.get('defense:v1'), legacy,
      'cold reads leave the stored legacy record byte-for-byte equivalent');
  }
  assert.deepEqual(generations, [
    { a: 6, b: 5, c: 7 },
    { a: 6, b: 5, c: 7 }
  ]);
});

test('Defense config sends a targeted canonical receipt after persistence and on replay', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'defense', players: {} });
  await handshake(h);
  await send(h, h.ws, { t: 'defenseUnlock', password: 'qa' });
  const observer = h.addSocket('defense');
  await handshake(h, observer.ws, observer.sent);
  await send(h, observer.ws, { t: 'defenseUnlock', password: 'qa' });
  h.sent.length = 0;
  observer.sent.length = 0;
  const request = {
    t: 'setDefenseConfig', password: 'qa', mutationId: 'config-receipt',
    baseRevision: 0, tapAnchorSeconds: 15, enemyMarchSeconds: 45
  };

  await send(h, h.ws, request);
  const receipt = lastFrame(h.sent, 'defenseConfigSaved');
  assert.deepEqual(receipt, {
    t: 'defenseConfigSaved', mutationId: 'config-receipt',
    config: {
      tapAnchorSeconds: 15, enemyMarchSeconds: 45, revision: 1,
      updatedAt: new Date(h.nowMs).toISOString()
    },
    revision: 1
  });
  assert.equal(observer.sent.some(frame => frame.t === 'defenseConfigSaved'), false,
    'the mutation receipt is private to the initiating manager');
  const writesAfterFirst = h.storageCalls.filter(call => call.op === 'put').length;

  h.sent.length = 0;
  await send(h, h.ws, request);
  assert.deepEqual(lastFrame(h.sent, 'defenseConfigSaved'), receipt,
    'an idempotent retry replenishes the exact canonical receipt');
  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, writesAfterFirst);

  await send(h, h.ws, {
    ...request, mutationId: 'config-receipt-next', baseRevision: 1,
    tapAnchorSeconds: 16, enemyMarchSeconds: 46
  });
  h.sent.length = 0;
  await send(h, h.ws, request);
  assert.deepEqual(lastFrame(h.sent, 'defenseConfigSaved'), receipt,
    'a delayed replay returns the immutable receipt for that mutation');
  assert.equal(h.room.defense.config.revision, 2,
    'the targeted old receipt does not roll back the current canonical snapshot');

  const originalPut = h.room.state.storage.put;
  h.room.state.storage.put = async (key, value) => {
    if (key === 'defense:v1') throw new Error('injected config persistence failure');
    return originalPut(key, value);
  };
  h.sent.length = 0;
  await send(h, h.ws, {
    ...request, mutationId: 'config-receipt-fails', baseRevision: 2, enemyMarchSeconds: 47
  });
  assert.equal(lastFrame(h.sent, 'error').error, 'config_persist_failed');
  assert.equal(h.sent.some(frame => frame.t === 'defenseConfigSaved'), false);
});

test('removed-owner tombstones normalize and stay bounded across reloads', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}
  });
  await handshake(h);
  h.room.defenseRemovedOwners = Array.from({ length: 305 }, (_, index) => ({
    pid: `removed-${String(index).padStart(3, '0')}`,
    ownerHash: ownerHash(`removed-owner-${index}`)
  })).concat([
    { pid: 'removed-304', ownerHash: ownerHash('newest-owner-304') },
    { pid: 'bad pid', ownerHash: 'not-a-hash' }
  ]);
  await h.room.persistDefenseBundle();
  const stored = h.storage.get('defenseRemovedOwners:v1');
  assert.equal(stored.length, 300);
  assert.equal(new Set(stored.map(entry => `${entry.pid}:${entry.ownerHash}`)).size, 300,
    'the bound deduplicates exact credential generations, not every owner of one pid');
  assert.equal(stored.filter(entry => entry.pid === 'removed-304').length, 2);
  assert.deepEqual(stored.at(-1), {
    pid: 'removed-304', ownerHash: ownerHash('newest-owner-304')
  });

  const reloaded = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}, storage: h.storage
  });
  await handshake(reloaded);
  assert.deepEqual(reloaded.room.defenseRemovedOwners, stored,
    'the bounded tombstone set survives hibernation-style reload normalization');
});
