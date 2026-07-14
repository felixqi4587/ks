const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness, claimRoom } = require('./room-harness.cjs');

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

test('legacy setMarch and registerPlayer are zero-I/O create-only no-ops for an existing pid', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'setMarch', pid: '001', name: 'Stale', march: 900 }));
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'registerPlayer', pid: '001', name: 'Stale 2', march: 900, identityMode: 'playerId'
  }));
  assert.equal(h.room.room.players['001'].name, 'Test 001');
  assert.equal(h.room.room.players['001'].march, 32);
  assert.equal(h.room.room.players['001'].marchRevision, 0);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.calls, []);
});

test('registration keeps the 150-player cap without evicting active or staged captains', async () => {
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
  h.room.devices = [{ pid: '002', deviceId: '00000000-0000-4000-8000-000000000099', soundReady: true, lastSeenMs: 999_999 }];
  h.room.deliveryAcks = [{ commandId: 'old', pid: '002', deviceId: '00000000-0000-4000-8000-000000000099', outcome: 'scheduled', atMs: 999_999 }];
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'registerPlayer', pid: 'new-player', name: 'New', march: 35, identityMode: 'playerId'
  }));
  assert.equal(Object.keys(h.room.room.players).length, 150);
  assert.ok(h.room.room.players['000']);
  assert.ok(h.room.room.players['001']);
  assert.ok(h.room.room.players['149']);
  assert.ok(h.room.room.players['new-player']);
  assert.equal(h.room.room.players['002'], undefined);
  assert.equal(h.room.devices.length, 0);
  assert.equal(h.room.deliveryAcks.length, 0);
  assert.deepEqual(h.calls, ['persistAll', 'broadcast']);
});

test('player and commander updates acknowledge mutationId and broadcast canonical revision', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'own-1', pid: '001', march: 33, baseRevision: 0
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

test('Fire freezes canonical march values and exact Main landing offset from stale sender snapshots', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'before-fire', pid: '001', march: 33, baseRevision: 0
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
    t: 'updateOwnMarch', mutationId: 'after-fire', pid: '001', march: 34, baseRevision: 1
  }));
  assert.deepEqual(h.room.room.live.commands[1].payload.pairs, [
    { pid: '001', name: 'Test 001', role: 'weak', march: 33, pressUTC: 1006 },
    { pid: 'kimchi', name: 'Kimchi', role: 'main', march: 40, pressUTC: 1000 }
  ]);
});
