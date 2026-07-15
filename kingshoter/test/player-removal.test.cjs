const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness, claimRoom } = require('./room-harness.cjs');

test('player removal requires commander authentication before roster lookup', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'wrong', pid: 'missing-player' }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'bad_password' }]);
  assert.equal(h.room.room.players['001'].name, 'Test 001');
  assert.deepEqual(h.calls, []);
});

test('authenticated player removal deletes only its target and broadcasts once', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));

  assert.equal(h.room.room.players['001'], undefined);
  assert.equal(h.room.room.players.kimchi.name, 'Kimchi');
  assert.deepEqual(h.calls, ['persistAll', 'broadcast']);
  assert.deepEqual(h.sent, []);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'hb', pid: '001' }));
  assert.equal(h.room.room.players['001'], undefined, 'a deleted player heartbeat cannot recreate its profile');
  assert.deepEqual(h.calls, ['persistAll', 'broadcast']);
});

test('authenticated removal clears every staged reference atomically', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    staged: { kingdom: 1, pairs: [{ pid: '001', role: 'weak' }] }
  });
  h.room.room.live.staged[2] = { kingdom: 2, pairs: [{ pid: '001', role: 'main' }] };
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));

  assert.equal(h.room.room.players['001'], undefined);
  assert.equal(h.room.room.live.staged[1], null);
  assert.equal(h.room.room.live.staged[2], null);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.calls, ['persistAll', 'broadcast']);
});

test('only a future live command protects a captain from removal', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    nowMs: 1_000_000,
    live: {
      id: 'future-rally',
      type: 'double_rally',
      expiresUTC: 1001,
      payload: {
        pairs: [
          { pid: '001', role: 'weak' },
          { pid: 'kimchi', role: 'main' }
        ]
      }
    }
  });
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'player_in_live_command', pid: '001' }]);
  assert.equal(h.room.room.players['001'].name, 'Test 001');
  assert.deepEqual(h.calls, []);
});

test('a command expiring exactly now no longer protects a captain', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    nowMs: 1_000_000,
    live: {
      id: 'expired-rally',
      type: 'double_rally',
      expiresUTC: 1000,
      payload: {
        pairs: [
          { pid: '001', role: 'weak' },
          { pid: 'kimchi', role: 'main' }
        ]
      }
    }
  });
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));

  assert.equal(h.room.room.players['001'], undefined);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.calls, ['persistAll', 'broadcast']);
});

test('removing an already absent player is an idempotent silent no-op', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);
  delete h.room.room.players['001'];

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sent, []);
  assert.equal(h.room.room.players.kimchi.name, 'Kimchi');
});

test('player removal never treats inherited object properties as roster entries', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '__proto__' }));

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sent, []);
  assert.equal(h.room.room.players.kimchi.name, 'Kimchi');
});

test('a late staged selection cannot recreate a reference to a removed player', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));
  h.reset();

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'stage',
    password: 'commander-secret',
    staged: { kingdom: 1, pairs: [{ pid: '001', role: 'weak' }, { pid: 'kimchi', role: 'main' }] }
  }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'player_missing' }]);
  assert.equal(h.room.room.live.staged[1], null);
  assert.deepEqual(h.calls, []);
});

test('a late double-rally command cannot target a removed player', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { nowMs: 1_000_000 });
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));
  h.reset();

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd',
    password: 'commander-secret',
    cmd: {
      type: 'double_rally',
      kingdom: 1,
      anchorUTC: 1100,
      payload: {
        firstPress: 1100,
        pairs: [
          { pid: '001', role: 'weak', march: 32 },
          { pid: 'kimchi', role: 'main', march: 40 }
        ]
      }
    }
  }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'player_missing' }]);
  assert.equal(h.room.room.live.commands[1], null);
  assert.deepEqual(h.calls, []);
});

test('normalized double-rally ids stay canonical and immutable while their active command blocks removal', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { nowMs: 1_000_000 });
  const normalizedPid = '123456789012345678901234';
  h.room.room.players[normalizedPid] = {
    name: 'Long ID', march: 32, marchRevision: 0, alliance: '', ready: false, lastSeen: new Date(h.nowMs).toISOString()
  };
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd',
    password: 'commander-secret',
    cmd: {
      type: 'double_rally',
      kingdom: 1,
      anchorUTC: 1100,
      payload: {
        firstPress: 1100,
        pairs: [
          { pid: `${normalizedPid}-ignored`, role: 'weak', name: 'stale', march: 99 },
          { pid: 'kimchi', role: 'main', name: 'stale', march: 99 }
        ]
      }
    }
  }));

  const frozenPairs = [
    { pid: normalizedPid, name: 'Long ID', role: 'weak', march: 32, pressUTC: 1107 },
    { pid: 'kimchi', name: 'Kimchi', role: 'main', march: 40, pressUTC: 1100 }
  ];
  assert.deepEqual(h.room.room.live.commands[1].payload.pairs, frozenPairs);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deviceStatus', pid: normalizedPid,
    deviceId: '00000000-0000-4000-8000-000000000102', soundReady: false
  }));
  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'long-update', pid: normalizedPid, march: 33, baseRevision: 0
  }));
  assert.equal(h.room.room.players[normalizedPid].march, 33);
  assert.deepEqual(h.room.room.live.commands[1].payload.pairs, frozenPairs);
  h.reset();

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'removePlayer', password: 'commander-secret', pid: normalizedPid
  }));
  assert.deepEqual(h.sent, [{ t: 'error', error: 'player_in_live_command', pid: normalizedPid }]);
  assert.deepEqual(h.calls, []);
  assert.ok(h.room.room.players[normalizedPid]);
});
