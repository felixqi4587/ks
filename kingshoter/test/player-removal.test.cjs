const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

async function loadRoom() {
  const source = fs.readFileSync(path.join(root, 'src/room.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}-${Math.random()}`);
}

function harness(Room, options = {}) {
  const sent = [];
  const calls = [];
  const room = Object.create(Room.prototype);
  room.env = { MASTER: 'separate-master-override' };
  room.room = {
    pwHash: null,
    config: { castleName: '', rallyAllies: [], enemyWhales: [] },
    players: {
      '001': { name: '001', march: 32, ready: false, lastSeen: '2026-07-13T00:00:00.000Z' },
      kimchi: { name: 'Kimchi', march: 32, ready: false, lastSeen: '2026-07-13T00:00:00.000Z' }
    },
    live: {
      mode: options.live ? 'live' : 'idle',
      commands: { 1: options.live ? { payload: { pairs: [{ pid: '001' }] } } : null, 2: null },
      staged: { 1: options.staged ? { pairs: [{ pid: '001', role: 'weak' }] } : null, 2: null },
      sim: null
    },
    updatedAt: null,
    updatedBy: null
  };
  room.persist = async () => { calls.push('persist'); };
  room.broadcast = () => { calls.push('broadcast'); };
  const ws = { send(message) { sent.push(JSON.parse(message)); } };
  return { room, ws, sent, calls };
}

async function claimRoom(h) {
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setConfig',
    password: 'commander-secret',
    config: h.room.room.config,
    by: 'test-claim'
  }));
  h.sent.length = 0;
  h.calls.length = 0;
}

test('player removal requires commander authentication', async () => {
  const { Room } = await loadRoom();
  const h = harness(Room);
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'wrong', pid: 'missing-player' }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'bad_password' }]);
  assert.equal(h.room.room.players['001'].name, '001');
  assert.deepEqual(h.calls, []);
});

test('authenticated player removal deletes only its target and broadcasts once', async () => {
  const { Room } = await loadRoom();
  const h = harness(Room);
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));

  assert.equal(h.room.room.players['001'], undefined);
  assert.equal(h.room.room.players.kimchi.name, 'Kimchi');
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
  assert.deepEqual(h.sent, []);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'hb', pid: '001' }));
  assert.equal(h.room.room.players['001'], undefined, 'a deleted player heartbeat cannot recreate its profile');
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
});

for (const state of ['staged', 'live']) {
  test(`player removal protects a captain referenced by a ${state} order`, async () => {
    const { Room } = await loadRoom();
    const h = harness(Room, { [state]: true });
    await claimRoom(h);

    await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));

    assert.deepEqual(h.sent, [{ t: 'error', error: 'player_in_use' }]);
    assert.equal(h.room.room.players['001'].name, '001');
    assert.deepEqual(h.calls, []);
  });
}

test('removing an already absent player is an idempotent no-op', async () => {
  const { Room } = await loadRoom();
  const h = harness(Room);
  await claimRoom(h);
  delete h.room.room.players['001'];

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sent, []);
  assert.equal(h.room.room.players.kimchi.name, 'Kimchi');
});

test('player removal never treats inherited object properties as roster entries', async () => {
  const { Room } = await loadRoom();
  const h = harness(Room);
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '__proto__' }));

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sent, []);
  assert.equal(h.room.room.players.kimchi.name, 'Kimchi');
});

test('a late staged selection cannot recreate a reference to a removed player', async () => {
  const { Room } = await loadRoom();
  const h = harness(Room);
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));
  h.sent.length = 0;
  h.calls.length = 0;

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
  const h = harness(Room);
  h.room.scheduleExpiry = async () => { h.calls.push('alarm'); };
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: '001' }));
  h.sent.length = 0;
  h.calls.length = 0;

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd',
    password: 'commander-secret',
    cmd: {
      type: 'double_rally',
      kingdom: 1,
      anchorUTC: Math.floor(Date.now() / 1000) + 10,
      payload: { pairs: [{ pid: '001', march: 32 }, { pid: 'kimchi', march: 32 }] }
    }
  }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'player_missing' }]);
  assert.equal(h.room.room.live.commands[1], null);
  assert.deepEqual(h.calls, []);
});

test('double-rally stores the same normalized player ids it validates', async () => {
  const { Room } = await loadRoom();
  const h = harness(Room);
  const normalizedPid = '123456789012345678901234';
  h.room.room.players[normalizedPid] = { name: 'Long ID', march: 32, ready: false };
  h.room.scheduleExpiry = async () => { h.calls.push('alarm'); };
  await claimRoom(h);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd',
    password: 'commander-secret',
    cmd: {
      type: 'double_rally',
      kingdom: 1,
      anchorUTC: Math.floor(Date.now() / 1000) + 10,
      payload: { pairs: [{ pid: `${normalizedPid}-ignored`, march: 32 }, { pid: 'kimchi', march: 32 }] }
    }
  }));

  assert.equal(h.room.room.live.commands[1].payload.pairs[0].pid, normalizedPid);
  h.sent.length = 0;
  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'removePlayer', password: 'commander-secret', pid: normalizedPid }));
  assert.deepEqual(h.sent, [{ t: 'error', error: 'player_in_use' }], 'normalized stored references must remain protected from deletion');
});
