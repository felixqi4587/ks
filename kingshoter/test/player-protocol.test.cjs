const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadRoom, createRoomHarness, claimRoom } = require('./room-harness.cjs');

const PROFILE_KEY = '10000000-0000-4000-8000-000000000001';
const ATTACKER_PROFILE_KEY = '20000000-0000-4000-8000-000000000002';

function profileKeyHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function addSocket(harness) {
  const sent = [];
  let attachment = null;
  const ws = {
    send(message) { sent.push(JSON.parse(message)); },
    serializeAttachment(value) { attachment = structuredClone(value); },
    deserializeAttachment() { return attachment == null ? null : structuredClone(attachment); }
  };
  harness.room.attachSocket(ws, harness.roomName);
  return { ws, sent };
}

async function withFirstDigestHeld(run) {
  const nativeCrypto = globalThis.crypto;
  let releaseDigest = null;
  let enteredResolve = null;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const cryptoWithGate = Object.create(nativeCrypto);
  const subtleWithGate = Object.create(nativeCrypto.subtle);
  Object.defineProperty(cryptoWithGate, 'subtle', { value: subtleWithGate });
  subtleWithGate.digest = (...args) => {
    if (releaseDigest) return nativeCrypto.subtle.digest(...args);
    enteredResolve();
    return new Promise((resolve, reject) => {
      releaseDigest = () => nativeCrypto.subtle.digest(...args).then(resolve, reject);
    });
  };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoWithGate });
  try {
    await run({
      waitUntilHeld: () => entered,
      release: () => releaseDigest()
    });
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, get: () => nativeCrypto });
  }
}

async function bindPlayerSocket(
  harness,
  pid,
  deviceId = '00000000-0000-4000-8000-000000000101',
  profileKey = PROFILE_KEY
) {
  if (profileKey) {
    harness.room.profileOwners = Object.assign({}, harness.room.profileOwners, {
      [pid]: profileKeyHash(profileKey)
    });
  }
  await harness.room.webSocketMessage(harness.ws, JSON.stringify({
    t: 'deviceStatus', pid, deviceId, soundReady: false
  }));
  harness.reset();
}

test('constructor migrates legacy stored players to revision zero without clamping march', async () => {
  const { Room } = await loadRoom();
  let initialized;
  const storedRoom = {
    pwHash: null,
    config: { castleName: '', rallyAllies: [], enemyWhales: [] },
    players: { legacy: { name: 'Legacy', march: 240, lastSeen: '2026-07-13T00:00:00.000Z' } },
    live: { mode: 'idle', command: null, staged: null, sim: null },
    updatedAt: null,
    updatedBy: null
  };
  const state = {
    storage: {
      async get(key) {
        assert.equal(key, 'room');
        return storedRoom;
      }
    },
    blockConcurrencyWhile(callback) {
      initialized = callback();
      return initialized;
    }
  };

  const room = new Room(state, { MASTER: 'separate-master-override' });
  await initialized;

  assert.equal(room.room.players.legacy.march, 240);
  assert.equal(room.room.players.legacy.marchRevision, 0);
});

test('private profile owners survive reload, reject invalid hashes, and never enter public state', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  const ownerHash = profileKeyHash(PROFILE_KEY);
  let persisted = null;
  h.room._deliveryLoaded = false;
  h.room._deliveryLoadPromise = null;
  h.room.profileOwners = null;
  h.room.state.storage = {
    async get(keys) {
      assert.deepEqual(keys, ['devices', 'deliveryAcks', 'profileOwners']);
      return new Map([
        ['devices', []],
        ['deliveryAcks', []],
        ['profileOwners', { '001': ownerHash, kimchi: 'not-a-hash' }]
      ]);
    },
    async put(value) { persisted = value; }
  };
  h.room.ensureDeliveryLoaded = Room.prototype.ensureDeliveryLoaded;
  h.room.persistAll = Room.prototype.persistAll;

  await h.room.ensureDeliveryLoaded();
  assert.equal(h.room.profileOwners['001'], ownerHash);
  assert.equal(h.room.profileOwners.kimchi, undefined);
  assert.equal(h.room.stateMsg().includes(ownerHash), false);
  assert.equal(h.room.stateMsg().includes(PROFILE_KEY), false);

  await h.room.persistAll();
  assert.equal(persisted.profileOwners['001'], ownerHash);
  assert.equal(JSON.stringify(persisted.room).includes(ownerHash), false);
  assert.equal(JSON.stringify(persisted).includes(PROFILE_KEY), false);
});

test('existing registration always returns canonical delivery identity and exposes edit ownership explicitly', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  h.room.profileOwners = { '001': profileKeyHash(PROFILE_KEY) };
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setMarch', registrationId: 'same-owner', pid: '001', name: 'Stale', march: 900,
    profileKey: PROFILE_KEY
  }));
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'registerPlayer', registrationId: 'other-device', pid: '001', name: 'Stale 2', march: 900,
    identityMode: 'playerId', profileKey: ATTACKER_PROFILE_KEY
  }));
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'registerPlayer', registrationId: 'delivery-only', pid: '001', name: 'Stale 3', march: 900,
    identityMode: 'playerId'
  }));
  assert.equal(h.room.room.players['001'].name, 'Test 001');
  assert.equal(h.room.room.players['001'].march, 32);
  assert.equal(h.room.room.players['001'].marchRevision, 0);
  assert.deepEqual(h.sent, [
    {
      t: 'playerRegistered', registrationId: 'same-owner', pid: '001', created: false, editable: true,
      identityMode: 'playerId', name: 'Test 001', march: 32, revision: 0, playerId: '001'
    },
    {
      t: 'playerRegistered', registrationId: 'other-device', pid: '001', created: false, editable: false,
      identityMode: 'playerId', name: 'Test 001', march: 32, revision: 0, playerId: '001'
    },
    {
      t: 'playerRegistered', registrationId: 'delivery-only', pid: '001', created: false, editable: false,
      identityMode: 'playerId', name: 'Test 001', march: 32, revision: 0, playerId: '001'
    }
  ]);
  assert.deepEqual(h.calls, []);
});

test('new registration requires a private profile key and stores only its hash', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'registerPlayer', registrationId: 'missing-key', pid: 'new-profile', name: 'New', march: 35,
    identityMode: 'nickname'
  }));
  assert.deepEqual(h.sent, [{
    t: 'error', error: 'invalid_profile_key', registrationId: 'missing-key'
  }]);
  assert.equal(h.room.room.players['new-profile'], undefined);
  assert.deepEqual(h.calls, []);

  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'registerPlayer', registrationId: 'new-create', pid: 'new-profile', name: 'New', march: 35,
    identityMode: 'nickname', profileKey: PROFILE_KEY
  }));
  assert.equal(h.room.profileOwners['new-profile'], profileKeyHash(PROFILE_KEY));
  assert.equal(JSON.stringify(h.room.room).includes(PROFILE_KEY), false);
  assert.deepEqual(h.sent, [{
    t: 'playerRegistered', registrationId: 'new-create', pid: 'new-profile', created: true, editable: true,
    identityMode: 'nickname', name: 'New', march: 35, revision: 0
  }]);
  assert.deepEqual(h.calls, ['persistAll', 'broadcast']);
});

test('registration persistence failure rolls back both the public player and private owner', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  h.room.persistAll = async () => {
    h.calls.push('persistAll');
    throw new Error('storage unavailable');
  };

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'registerPlayer', registrationId: 'persist-failure', pid: 'not-saved', name: 'Not Saved', march: 35,
    identityMode: 'nickname', profileKey: PROFILE_KEY
  }));

  assert.deepEqual(h.sent, [{
    t: 'error', error: 'registration_persist_failed', registrationId: 'persist-failure', pid: 'not-saved'
  }]);
  assert.equal(h.room.room.players['not-saved'], undefined);
  assert.equal(h.room.profileOwners['not-saved'], undefined);
  assert.deepEqual(h.calls, ['persistAll']);
});

test('concurrent registrations do not lose a player while the first profile key hash is pending', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);

  await withFirstDigestHeld(async gate => {
    const first = h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'registerPlayer', pid: 'race-a', name: 'Race A', march: 35,
      identityMode: 'nickname', profileKey: PROFILE_KEY
    }));
    await gate.waitUntilHeld();
    await h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'registerPlayer', pid: 'race-b', name: 'Race B', march: 36,
      identityMode: 'nickname', profileKey: ATTACKER_PROFILE_KEY
    }));
    gate.release();
    await first;
  });

  assert.equal(h.room.room.players['race-a'].name, 'Race A');
  assert.equal(h.room.room.players['race-b'].name, 'Race B');
  assert.equal(h.room.profileOwners['race-a'], profileKeyHash(PROFILE_KEY));
  assert.equal(h.room.profileOwners['race-b'], profileKeyHash(ATTACKER_PROFILE_KEY));
  assert.deepEqual(h.calls, ['persistAll', 'broadcast', 'persistAll', 'broadcast']);
});

test('concurrent registrations for one pid grant editing only to the owner that created it', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);

  await withFirstDigestHeld(async gate => {
    const first = h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'registerPlayer', registrationId: 'first-device', pid: 'one-owner', name: 'First Device', march: 35,
      identityMode: 'nickname', profileKey: PROFILE_KEY
    }));
    await gate.waitUntilHeld();
    await h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'registerPlayer', registrationId: 'second-device', pid: 'one-owner', name: 'Second Device', march: 36,
      identityMode: 'nickname', profileKey: ATTACKER_PROFILE_KEY
    }));
    gate.release();
    await first;
  });

  assert.equal(h.room.room.players['one-owner'].name, 'Second Device');
  assert.equal(h.room.profileOwners['one-owner'], profileKeyHash(ATTACKER_PROFILE_KEY));
  assert.deepEqual(h.sent, [
    {
      t: 'playerRegistered', registrationId: 'second-device', pid: 'one-owner', created: true, editable: true,
      identityMode: 'nickname', name: 'Second Device', march: 36, revision: 0
    },
    {
      t: 'playerRegistered', registrationId: 'first-device', pid: 'one-owner', created: false, editable: false,
      identityMode: 'nickname', name: 'Second Device', march: 36, revision: 0
    }
  ]);
  assert.deepEqual(h.calls, ['persistAll', 'broadcast']);
});

test('recover-only registration never recreates a player removed while ownership hashing is pending', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    players: {
      'recover-race': {
        name: 'Recover Race', march: 35, marchRevision: 0,
        identityMode: 'nickname', alliance: '', ready: false,
        lastSeen: '2026-07-15T00:00:00.000Z'
      }
    }
  });
  h.room.profileOwners = { 'recover-race': profileKeyHash(PROFILE_KEY) };
  await claimRoom(h);
  h.reset();

  await withFirstDigestHeld(async gate => {
    const recovery = h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'registerPlayer', registrationId: 'recover-only-race', recoverOnly: true,
      pid: 'recover-race', name: 'Recover Race', march: 35,
      identityMode: 'nickname', profileKey: PROFILE_KEY
    }));
    await gate.waitUntilHeld();
    await h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'removePlayer', password: 'commander-secret', pid: 'recover-race'
    }));
    gate.release();
    await recovery;
  });

  assert.equal(h.room.room.players['recover-race'], undefined);
  assert.equal(h.room.profileOwners['recover-race'], undefined);
  assert.deepEqual(h.sent, [{
    t: 'error', error: 'player_missing', registrationId: 'recover-only-race', pid: 'recover-race'
  }]);
  assert.deepEqual(h.calls, ['persistAll', 'broadcast']);

  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'registerPlayer', registrationId: 'recover-only-absent', recoverOnly: true,
    pid: 'never-created', name: 'Never Created', march: 36,
    identityMode: 'nickname', profileKey: ATTACKER_PROFILE_KEY
  }));
  assert.equal(h.room.room.players['never-created'], undefined);
  assert.deepEqual(h.sent, [{
    t: 'error', error: 'player_missing', registrationId: 'recover-only-absent', pid: 'never-created'
  }]);
  assert.deepEqual(h.calls, []);
});

test('public registration rejects a full roster without evicting or releasing any owner', async () => {
  const { Room } = await loadRoom();
  const players = {};
  for (let index = 0; index < 150; index += 1) {
    const pid = String(index).padStart(3, '0');
    players[pid] = { name: pid, march: 30, marchRevision: 0, lastSeen: new Date(index * 1000).toISOString() };
  }
  const h = createRoomHarness(Room, {
    players,
    live: {
      id: 'active',
      type: 'double_rally',
      expiresUTC: 2000,
      payload: { pairs: [{ pid: '000', role: 'weak' }, { pid: '149', role: 'main' }] }
    },
    staged: { kingdom: 1, pairs: [{ pid: '001', role: 'weak' }] },
    nowMs: 1_000_000
  });
  delete h.room.room.players.kimchi;
  h.room.profileOwners = { '002': profileKeyHash(ATTACKER_PROFILE_KEY) };
  h.room.devices = [{ pid: '002', deviceId: '00000000-0000-4000-8000-000000000099', soundReady: true, lastSeenMs: 999_999 }];
  h.room.deliveryAcks = [{ commandId: 'old', pid: '002', deviceId: '00000000-0000-4000-8000-000000000099', outcome: 'scheduled', atMs: 999_999 }];
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'registerPlayer', registrationId: 'full-roster', pid: 'new-player', name: 'New', march: 35,
    identityMode: 'playerId', profileKey: PROFILE_KEY
  }));
  assert.equal(Object.keys(h.room.room.players).length, 150);
  assert.ok(h.room.room.players['000']);
  assert.ok(h.room.room.players['001']);
  assert.ok(h.room.room.players['149']);
  assert.equal(h.room.room.players['new-player'], undefined);
  assert.ok(h.room.room.players['002']);
  assert.equal(h.room.devices.length, 1);
  assert.equal(h.room.deliveryAcks.length, 1);
  assert.equal(h.room.profileOwners['002'], profileKeyHash(ATTACKER_PROFILE_KEY));
  assert.equal(h.room.profileOwners['new-player'], undefined);
  assert.deepEqual(h.sent, [{ t: 'error', error: 'roster_full', registrationId: 'full-roster' }]);
  assert.deepEqual(h.calls, []);
});

test('player and commander updates acknowledge mutationId and broadcast canonical revision', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await bindPlayerSocket(h, '001');
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'own-1', pid: '001', profileKey: PROFILE_KEY,
    march: 33, baseRevision: 0
  }));
  assert.deepEqual(h.sent, [{ t: 'playerMarchSaved', mutationId: 'own-1', pid: '001', march: 33, revision: 1 }]);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
  assert.equal(h.room.room.updatedAt, null);
  assert.equal(h.room.room.updatedBy, null);
  h.reset();

  await claimRoom(h);
  const configVersion = h.room.room.updatedAt;
  const configAuthor = h.room.room.updatedBy;
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setPlayerMarch', mutationId: 'cmd-1', password: 'commander-secret', pid: '001', march: 34, baseRevision: 1
  }));
  assert.deepEqual(h.sent, [{ t: 'playerMarchSaved', mutationId: 'cmd-1', pid: '001', march: 34, revision: 2 }]);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
  assert.equal(h.room.room.updatedAt, configVersion);
  assert.equal(h.room.room.updatedBy, configAuthor);
});

test('socket-bound profile updates switch identity modes without changing routing attachment', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    players: {
      '001': {
        name: 'Old Nick', march: 32, marchRevision: 0, identityMode: 'nickname',
        alliance: '', ready: false, lastSeen: '2026-07-15T00:00:00.000Z'
      }
    }
  });
  const deviceId = '00000000-0000-4000-8000-000000000102';
  await bindPlayerSocket(h, '001', deviceId);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnProfile', mutationId: 'profile-to-id', pid: '001',
    profileKey: PROFILE_KEY,
    identityMode: 'playerId', playerId: '900000001', name: 'Resolved Alpha',
    march: 33, baseRevision: 0
  }));

  assert.deepEqual(h.sent, [{
    t: 'playerProfileSaved', mutationId: 'profile-to-id', pid: '001',
    identityMode: 'playerId', playerId: '900000001', name: 'Resolved Alpha',
    march: 33, revision: 1
  }]);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
  assert.equal(h.room.room.players['001'].playerId, '900000001');
  assert.equal(h.room.room.players['900000001'], undefined);
  assert.equal(h.room.readSocketAttachment(h.ws).pid, '001');
  assert.equal(h.room.readSocketAttachment(h.ws).deviceId, deviceId);

  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnProfile', mutationId: 'profile-to-nick', pid: '001',
    profileKey: PROFILE_KEY,
    identityMode: 'nickname', playerId: '900000001', name: 'New Nick',
    march: 34, baseRevision: 1
  }));

  assert.deepEqual(h.sent, [{
    t: 'playerProfileSaved', mutationId: 'profile-to-nick', pid: '001',
    identityMode: 'nickname', name: 'New Nick', march: 34, revision: 2
  }]);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
  assert.equal(Object.hasOwn(h.room.room.players['001'], 'playerId'), false);
  assert.equal(h.room.readSocketAttachment(h.ws).pid, '001');
  assert.equal(h.room.readSocketAttachment(h.ws).deviceId, deviceId);
});

test('profile updates authorize the socket attachment before accepting the requested pid', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await bindPlayerSocket(h, '001', undefined, null);
  const before = structuredClone(h.room.room.players.kimchi);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnProfile', mutationId: 'profile-spoof', pid: 'kimchi',
    identityMode: 'nickname', name: 'Spoofed', march: 41, baseRevision: 0
  }));

  assert.deepEqual(h.sent, [{
    t: 'error', error: 'core_identity_mismatch', mutationId: 'profile-spoof', pid: 'kimchi'
  }]);
  assert.deepEqual(h.room.room.players.kimchi, before);
  assert.deepEqual(h.calls, []);
});

test('a second publicly bound audio device cannot overwrite an owned player profile', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  h.room.profileOwners = { '001': profileKeyHash(PROFILE_KEY) };
  await bindPlayerSocket(h, '001', '00000000-0000-4000-8000-000000000101');
  const attacker = addSocket(h);
  await h.room.webSocketMessage(attacker.ws, JSON.stringify({
    t: 'deviceStatus', pid: '001',
    deviceId: '00000000-0000-4000-8000-000000000202', soundReady: true
  }));
  attacker.sent.length = 0;
  h.calls.length = 0;
  const before = structuredClone(h.room.room.players['001']);

  await h.room.webSocketMessage(attacker.ws, JSON.stringify({
    t: 'updateOwnProfile', mutationId: 'attacker-profile', pid: '001',
    profileKey: ATTACKER_PROFILE_KEY, identityMode: 'nickname',
    name: 'Hijacked', march: 99, baseRevision: 0
  }));

  assert.deepEqual(attacker.sent, [{
    t: 'error', error: 'profile_owner_mismatch', mutationId: 'attacker-profile', pid: '001'
  }]);
  assert.deepEqual(h.room.room.players['001'], before);
  assert.deepEqual(h.calls, []);

  attacker.sent.length = 0;
  await h.room.webSocketMessage(attacker.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'attacker-march', pid: '001',
    profileKey: ATTACKER_PROFILE_KEY, march: 98, baseRevision: 0
  }));
  assert.deepEqual(attacker.sent, [{
    t: 'error', error: 'profile_owner_mismatch', mutationId: 'attacker-march', pid: '001'
  }]);
  assert.deepEqual(h.room.room.players['001'], before);
  assert.deepEqual(h.calls, []);
});

test('an old owner cannot finish an update after commander removal and secure re-registration', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  h.room.profileOwners = { '001': profileKeyHash(PROFILE_KEY) };
  await bindPlayerSocket(h, '001');
  await claimRoom(h);

  await withFirstDigestHeld(async gate => {
    const staleUpdate = h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'updateOwnProfile', mutationId: 'stale-owner', pid: '001',
      profileKey: PROFILE_KEY, identityMode: 'nickname', name: 'Hijacked',
      march: 99, baseRevision: 0
    }));
    await gate.waitUntilHeld();
    await h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'removePlayer', password: 'commander-secret', pid: '001'
    }));
    await h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'registerPlayer', pid: '001', name: 'New Owner', march: 32,
      identityMode: 'nickname', profileKey: ATTACKER_PROFILE_KEY
    }));
    h.sent.length = 0;
    gate.release();
    await staleUpdate;
  });

  assert.deepEqual(h.sent, [{
    t: 'error', error: 'profile_owner_mismatch', mutationId: 'stale-owner', pid: '001'
  }]);
  assert.equal(h.room.room.players['001'].name, 'New Owner');
  assert.equal(h.room.room.players['001'].march, 32);
  assert.equal(h.room.profileOwners['001'], profileKeyHash(ATTACKER_PROFILE_KEY));
});

test('legacy players without a private owner remain audio-capable but fail closed for self edits', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await bindPlayerSocket(h, '001', undefined, null);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnProfile', mutationId: 'legacy-profile', pid: '001',
    profileKey: PROFILE_KEY, identityMode: 'nickname', name: 'Changed', march: 33, baseRevision: 0
  }));
  assert.deepEqual(h.sent, [{
    t: 'error', error: 'profile_owner_mismatch', mutationId: 'legacy-profile', pid: '001'
  }]);
  assert.equal(h.room.room.players['001'].name, 'Test 001');

  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'legacy-march', pid: '001',
    profileKey: PROFILE_KEY, march: 33, baseRevision: 0
  }));
  assert.deepEqual(h.sent, [{
    t: 'error', error: 'profile_owner_mismatch', mutationId: 'legacy-march', pid: '001'
  }]);
  assert.equal(h.room.room.players['001'].march, 32);
  assert.deepEqual(h.calls, []);
});

test('profile updates reject duplicate player ids without persistence or broadcast', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    players: {
      kimchi: {
        name: 'Kimchi', march: 40, marchRevision: 0, identityMode: 'playerId',
        playerId: '900000002', alliance: '', ready: false,
        lastSeen: '2026-07-15T00:00:00.000Z'
      }
    }
  });
  await bindPlayerSocket(h, '001');
  const before = structuredClone(h.room.room.players['001']);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnProfile', mutationId: 'profile-duplicate', pid: '001',
    profileKey: PROFILE_KEY,
    identityMode: 'playerId', playerId: '900000002', name: 'Alpha',
    march: 33, baseRevision: 0
  }));

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].t, 'error');
  assert.equal(h.sent[0].error, 'player_id_conflict');
  assert.equal(h.sent[0].mutationId, 'profile-duplicate');
  assert.equal(h.sent[0].pid, '001');
  assert.deepEqual(h.room.room.players['001'], before);
  assert.deepEqual(h.calls, []);
});

test('stale profile updates return the canonical profile without persistence or broadcast', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    players: {
      '001': {
        name: 'Canonical', march: 35, marchRevision: 2, identityMode: 'playerId',
        playerId: '900000001', alliance: '', ready: false,
        lastSeen: '2026-07-15T00:00:00.000Z'
      }
    }
  });
  await bindPlayerSocket(h, '001');
  const before = structuredClone(h.room.room.players['001']);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnProfile', mutationId: 'profile-stale', pid: '001',
    profileKey: PROFILE_KEY,
    identityMode: 'nickname', name: 'Stale', march: 34, baseRevision: 1
  }));

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].t, 'error');
  assert.equal(h.sent[0].error, 'player_conflict');
  assert.equal(h.sent[0].mutationId, 'profile-stale');
  assert.equal(h.sent[0].pid, '001');
  assert.deepEqual(h.sent[0].profile, {
    pid: '001', identityMode: 'playerId', playerId: '900000001',
    name: 'Canonical', march: 35, revision: 2
  });
  assert.deepEqual(h.room.room.players['001'], before);
  assert.deepEqual(h.calls, []);
});

test('profile persistence failure restores the original record and does not broadcast', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await bindPlayerSocket(h, '001');
  const original = h.room.room.players['001'];
  const before = structuredClone(original);
  h.room.persist = async () => {
    h.calls.push('persist');
    throw new Error('storage unavailable');
  };

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnProfile', mutationId: 'profile-persist-fail', pid: '001',
    profileKey: PROFILE_KEY,
    identityMode: 'nickname', name: 'Not Saved', march: 33, baseRevision: 0
  }));

  assert.deepEqual(h.sent, [{
    t: 'error', error: 'profile_persist_failed',
    mutationId: 'profile-persist-fail', pid: '001'
  }]);
  assert.equal(h.room.room.players['001'], original);
  assert.deepEqual(h.room.room.players['001'], before);
  assert.deepEqual(h.calls, ['persist']);
});

test('self march persistence failure rolls back the in-memory player and reports the mutation', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await bindPlayerSocket(h, '001');
  const before = structuredClone(h.room.room.players['001']);
  h.room.persist = async () => {
    h.calls.push('persist');
    throw new Error('storage unavailable');
  };

  await assert.doesNotReject(() => h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'self-march-persist-fail', pid: '001',
    profileKey: PROFILE_KEY, march: 99, baseRevision: 0
  })));

  assert.deepEqual(h.sent, [{
    t: 'error', error: 'profile_persist_failed',
    mutationId: 'self-march-persist-fail', pid: '001'
  }]);
  assert.deepEqual(h.room.room.players['001'], before);
  assert.deepEqual(h.calls, ['persist']);
});

test('commander march persistence failure rolls back the in-memory player and reports the mutation', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);
  const before = structuredClone(h.room.room.players['001']);
  h.room.persist = async () => {
    h.calls.push('persist');
    throw new Error('storage unavailable');
  };

  await assert.doesNotReject(() => h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setPlayerMarch', mutationId: 'commander-march-persist-fail',
    password: 'commander-secret', pid: '001', march: 99, baseRevision: 0
  })));

  assert.deepEqual(h.sent, [{
    t: 'error', error: 'profile_persist_failed',
    mutationId: 'commander-march-persist-fail', pid: '001'
  }]);
  assert.deepEqual(h.room.room.players['001'], before);
  assert.deepEqual(h.calls, ['persist']);
});

test('profile update still broadcasts persisted canonical state when the sender drops during ACK', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await bindPlayerSocket(h, '001');
  let persistedPlayer = null;
  h.room.persist = async () => {
    h.calls.push('persist');
    persistedPlayer = structuredClone(h.room.room.players['001']);
  };
  h.ws.send = () => { throw new Error('initiator disconnected'); };

  await assert.doesNotReject(() => h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnProfile', mutationId: 'profile-dropped', pid: '001',
    profileKey: PROFILE_KEY,
    identityMode: 'playerId', playerId: '900000001', name: 'Saved Alpha',
    march: 36, baseRevision: 0
  })));

  assert.deepEqual(persistedPlayer, h.room.room.players['001']);
  assert.equal(persistedPlayer.name, 'Saved Alpha');
  assert.equal(persistedPlayer.playerId, '900000001');
  assert.equal(persistedPlayer.march, 36);
  assert.equal(persistedPlayer.marchRevision, 1);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
});

test('self march updates require the socket-bound player while commander override stays authenticated', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'unbound-forgery', pid: 'kimchi', march: 41, baseRevision: 0
  }));
  assert.deepEqual(h.sent, [{
    t: 'error', error: 'core_identity_mismatch', mutationId: 'unbound-forgery', pid: 'kimchi'
  }]);
  assert.equal(h.room.room.players.kimchi.march, 40);
  assert.deepEqual(h.calls, []);

  h.reset();
  await bindPlayerSocket(h, '001');
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'bound-forgery', pid: 'kimchi', march: 41, baseRevision: 0
  }));
  assert.deepEqual(h.sent, [{
    t: 'error', error: 'core_identity_mismatch', mutationId: 'bound-forgery', pid: 'kimchi'
  }]);
  assert.equal(h.room.room.players.kimchi.march, 40);
  assert.deepEqual(h.calls, []);

  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'bound-self', pid: '001', profileKey: PROFILE_KEY,
    march: 33, baseRevision: 0
  }));
  assert.deepEqual(h.sent, [{
    t: 'playerMarchSaved', mutationId: 'bound-self', pid: '001', march: 33, revision: 1
  }]);
  assert.equal(h.room.room.players['001'].march, 33);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);

  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setPlayerMarch', mutationId: 'commander-override', password: 'commander-secret',
    pid: 'kimchi', march: 41, baseRevision: 0
  }));
  assert.deepEqual(h.sent, [{
    t: 'playerMarchSaved', mutationId: 'commander-override', pid: 'kimchi', march: 41, revision: 1
  }]);
  assert.equal(h.room.room.players.kimchi.march, 41);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
});

test('commander march update still broadcasts once when the initiator drops during ACK', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);
  h.ws.send = () => { throw new Error('initiator disconnected'); };

  await assert.doesNotReject(() => h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setPlayerMarch', mutationId: 'cmd-dropped', password: 'commander-secret',
    pid: '001', march: 35, baseRevision: 0
  })));

  assert.equal(h.room.room.players['001'].march, 35);
  assert.equal(h.room.room.players['001'].marchRevision, 1);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
});

test('heartbeat refreshes presence without changing canonical march or revision', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'hb', pid: '001' }));
  assert.equal(h.room.room.players['001'].march, 32);
  assert.equal(h.room.room.players['001'].marchRevision, 0);
});

test('wrong-password commander update authenticates before existence-sensitive errors', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setPlayerMarch', mutationId: 'cmd-x', password: 'wrong', pid: 'missing', march: 40, baseRevision: 0
  }));
  assert.deepEqual(h.sent, [{ t: 'error', error: 'bad_password', mutationId: 'cmd-x' }]);
  assert.deepEqual(h.calls, []);
});

test('stage atomically rejects a player already staged in the other kingdom', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);
  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'stage', password: 'commander-secret',
    staged: { kingdom: 1, pairs: [{ pid: '001', role: 'weak' }, { pid: 'kimchi', role: 'main' }] }
  }));
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
  h.reset();

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'stage', password: 'commander-secret',
    staged: { kingdom: 2, pairs: [{ pid: '001', role: 'weak' }] }
  }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'player_staged_other_kingdom', pid: '001', kingdom: 1 }]);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.room.room.live.staged[1].pairs, [
    { pid: '001', role: 'weak' },
    { pid: 'kimchi', role: 'main' }
  ]);
  assert.equal(h.room.room.live.staged[2], null);
});

test('two commander sockets cannot concurrently stage one player in both kingdoms', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);
  const secondSent = [];
  const secondCommander = { send(message) { secondSent.push(JSON.parse(message)); } };
  h.reset();

  await Promise.all([
    h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'stage', password: 'commander-secret', staged: { kingdom: 1, pairs: [{ pid: '001', role: 'weak' }] }
    })),
    h.room.webSocketMessage(secondCommander, JSON.stringify({
      t: 'stage', password: 'commander-secret', staged: { kingdom: 2, pairs: [{ pid: '001', role: 'weak' }] }
    }))
  ]);

  const staged = [h.room.room.live.staged[1], h.room.room.live.staged[2]];
  assert.equal(staged.filter(Boolean).length, 1);
  assert.equal(staged.filter(Boolean)[0].pairs[0].pid, '001');
  const errors = h.sent.concat(secondSent).filter(message => message.t === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'player_staged_other_kingdom');
  assert.equal(errors[0].pid, '001');
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
});

test('stage rejects captains in another kingdom live command but ignores expired or cancelled commands', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { nowMs: 1_000_000 });
  await claimRoom(h);
  h.room.room.live.commands[1] = {
    id: 'kingdom-one-live', type: 'double_rally', kingdom: 1, expiresUTC: 2_000,
    payload: { pairs: [{ pid: '001', role: 'weak' }, { pid: 'kimchi', role: 'main' }] }
  };

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'stage', password: 'commander-secret',
    staged: { kingdom: 2, pairs: [{ pid: '001', role: 'weak' }] }
  }));
  assert.deepEqual(h.sent, [{
    t: 'error', error: 'player_staged_other_kingdom', pid: '001', kingdom: 1
  }]);
  assert.equal(h.room.room.live.staged[2], null);
  assert.deepEqual(h.calls, []);

  h.reset();
  h.room.room.live.commands[1].expiresUTC = 1_000;
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'stage', password: 'commander-secret',
    staged: { kingdom: 2, pairs: [{ pid: '001', role: 'weak' }] }
  }));
  assert.deepEqual(h.room.room.live.staged[2], {
    kingdom: 2, pairs: [{ pid: '001', role: 'weak' }]
  });
  assert.deepEqual(h.calls, ['persist', 'broadcast']);

  h.reset();
  h.room.room.live.staged[2] = null;
  h.room.room.live.commands[1] = null;
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'stage', password: 'commander-secret',
    staged: { kingdom: 2, pairs: [{ pid: '001', role: 'weak' }] }
  }));
  assert.deepEqual(h.room.room.live.staged[2], {
    kingdom: 2, pairs: [{ pid: '001', role: 'weak' }]
  });
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
});

test('Double Fire rejects a captain in another live command but allows expired or cancelled commands', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { nowMs: 1_000_000 });
  await claimRoom(h);
  const otherCommand = {
    id: 'kingdom-one-live', type: 'double_rally', kingdom: 1, expiresUTC: 2_000,
    payload: { pairs: [{ pid: '001', role: 'weak' }] }
  };
  h.room.room.live.commands[1] = otherCommand;
  const fire = () => h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'double_rally', kingdom: 2, anchorUTC: 1_010,
      payload: {
        firstPress: 1_010, leadSeconds: 10,
        pairs: [{ pid: '001', role: 'weak' }, { pid: 'kimchi', role: 'main' }]
      }
    }
  }));

  await fire();
  assert.deepEqual(h.sent, [{ t: 'error', error: 'rally_live', pid: '001', kingdom: 1 }]);
  assert.equal(h.room.room.live.commands[2], null);
  assert.deepEqual(h.calls, []);

  h.reset();
  h.room.room.live.commands[1] = null;
  await fire();
  assert.equal(h.room.room.live.commands[2].type, 'double_rally');
  assert.deepEqual(h.calls.slice(0, 3), ['persistAll', 'alarm', 'broadcast']);

  h.reset();
  h.room.room.live.commands[2] = null;
  h.room.room.live.commands[1] = { ...otherCommand, expiresUTC: 1_000 };
  await fire();
  assert.equal(h.room.room.live.commands[2].type, 'double_rally');
  assert.deepEqual(h.room.room.live.commands[2].payload.pairs.map(pair => pair.pid), ['001', 'kimchi']);
  assert.deepEqual(h.calls.slice(0, 3), ['persistAll', 'alarm', 'broadcast']);
});

test('Fire freezes canonical march values and exact Main landing offset from stale sender snapshots', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await bindPlayerSocket(h, '001');
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'before-fire', pid: '001', profileKey: PROFILE_KEY,
    march: 33, baseRevision: 0
  }));
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 1000,
      payload: {
        firstPress: 1000, leadSeconds: 10,
        pairs: [
          { pid: '001', role: 'weak', name: 'stale', march: 99, pressUTC: 1000 },
          { pid: 'kimchi', role: 'main', name: 'stale', march: 99, pressUTC: 1000 }
        ]
      }
    }
  }));
  assert.equal(h.room.room.live.commands[1].payload.firstPress, 1000);
  assert.deepEqual(h.room.room.live.commands[1].payload.pairs, [
    { pid: '001', name: 'Test 001', role: 'weak', march: 33, pressUTC: 1006 },
    { pid: 'kimchi', name: 'Kimchi', role: 'main', march: 40, pressUTC: 1000 }
  ]);
  assert.equal(1000 + 40, 1006 + 33 + 1, 'Main lands exactly one second after Weak');
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'after-fire', pid: '001', profileKey: PROFILE_KEY,
    march: 34, baseRevision: 1
  }));
  assert.deepEqual(h.room.room.live.commands[1].payload.pairs, [
    { pid: '001', name: 'Test 001', role: 'weak', march: 33, pressUTC: 1006 },
    { pid: 'kimchi', name: 'Kimchi', role: 'main', march: 40, pressUTC: 1000 }
  ]);
});
