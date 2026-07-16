const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadRoom, createRoomHarness, claimRoom } = require('./room-harness.cjs');

async function send(h, message) {
  await h.room.webSocketMessage(h.ws, JSON.stringify(message));
}

async function register(h, pid, march = 30) {
  await send(h, {
    t: 'registerPlayer', registrationId: `register-${pid}`,
    pid, playerId: pid, identityMode: 'playerId', name: `Captain ${pid}`,
    march, profileKey: crypto.randomUUID()
  });
}

function command(type, kingdom, pairs, modeRevision) {
  return {
    t: 'cmd', password: 'commander-secret', cmd: {
      type, kingdom, modeRevision, anchorUTC: 1010,
      payload: { kingdom, leadSeconds: 10, firstPress: 1010, pairs }
    }
  };
}

function cancel(kingdom) {
  return { t: 'cmd', password: 'commander-secret', cmd: { type: 'cancel', kingdom } };
}

function stagePairs(h, kingdom) {
  return h.room.room.live.staged[kingdom] && h.room.room.live.staged[kingdom].pairs;
}

const WEAK = '930000001';
const WEAK2 = '930000002';
const MAIN = '930000003';

function doublePairs() {
  return [
    { pid: WEAK, role: 'weak' },
    { pid: WEAK2, role: 'main' }
  ];
}

function triplePairs() {
  return [
    { pid: WEAK, role: 'weak' },
    { pid: WEAK2, role: 'weak2' },
    { pid: MAIN, role: 'main' }
  ];
}

async function createRallyHarness(playerIds = [WEAK, WEAK2, MAIN]) {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '1' },
    nowMs: 1_000_000
  });
  await claimRoom(h);
  for (const pid of playerIds) await register(h, pid);
  h.reset();
  return h;
}

async function setMode(h, kingdom, mode, baseRevision) {
  await send(h, {
    t: 'setRallyMode', mutationId: `mode-${kingdom}-${mode}-${baseRevision}`,
    password: 'commander-secret', kingdom, mode, baseRevision
  });
}

async function stage(h, kingdom, pairs, modeRevision = 0) {
  await send(h, {
    t: 'stage', password: 'commander-secret',
    staged: { kingdom, modeRevision, pairs }
  });
}

test('Double Fire then Cancel restores the canonical two-captain stage', async () => {
  const h = await createRallyHarness([WEAK, WEAK2]);

  await send(h, command('double_rally', 1, doublePairs(), 0));
  assert.equal(stagePairs(h, 1), null);
  await send(h, cancel(1));

  assert.deepEqual(stagePairs(h, 1), [
    { pid: '930000001', role: 'weak' },
    { pid: '930000002', role: 'main' }
  ]);
  assert.equal(h.room.room.live.commands[1], null);
});

test('Triple Fire then Cancel restores the canonical three-captain stage', async () => {
  const h = await createRallyHarness();
  await setMode(h, 1, 'triple', 0);

  await send(h, command('triple_rally', 1, triplePairs(), 1));
  assert.equal(stagePairs(h, 1), null);
  await send(h, cancel(1));

  assert.deepEqual(stagePairs(h, 1), [
    { pid: '930000001', role: 'weak' },
    { pid: '930000002', role: 'weak2' },
    { pid: '930000003', role: 'main' }
  ]);
  assert.equal(h.room.room.live.commands[1], null);
});

test('Triple to Double before Cancel drops only weak2 from restored staging', async () => {
  const h = await createRallyHarness();
  await setMode(h, 1, 'triple', 0);
  await send(h, command('triple_rally', 1, triplePairs(), 1));

  await setMode(h, 1, 'double', 1);
  await send(h, cancel(1));

  assert.deepEqual(stagePairs(h, 1), [
    { pid: WEAK, role: 'weak' },
    { pid: MAIN, role: 'main' }
  ]);
  assert.equal(h.room.room.live.commands[1], null);
});

test('Double to Triple before Cancel restores two captains and leaves Triple Fire incomplete', async () => {
  const h = await createRallyHarness([WEAK, WEAK2]);
  await send(h, command('double_rally', 1, doublePairs(), 0));

  await setMode(h, 1, 'triple', 0);
  await send(h, cancel(1));

  const restored = doublePairs();
  assert.equal(h.room.room.rallyModes[1].mode, 'triple');
  assert.deepEqual(stagePairs(h, 1), restored);
  assert.equal(h.room.room.live.commands[1], null);

  h.reset();
  await send(h, command('triple_rally', 1, stagePairs(h, 1), 1));
  assert.equal(h.sent.at(-1).error, 'invalid_rally_roster');
  assert.deepEqual(stagePairs(h, 1), restored);
  assert.equal(h.room.room.live.commands[1], null);
});

test('a second Cancel leaves restored staging byte-for-byte unchanged', async () => {
  const h = await createRallyHarness([WEAK, WEAK2]);
  await send(h, command('double_rally', 1, doublePairs(), 0));
  await send(h, cancel(1));
  const restoredJSON = JSON.stringify(h.room.room.live.staged[1]);

  h.reset();
  await send(h, cancel(1));

  assert.equal(JSON.stringify(h.room.room.live.staged[1]), restoredJSON);
  assert.equal(h.room.room.live.commands[1], null);
  assert.deepEqual(h.calls, []);
});

test('Cancel in kingdom 1 preserves kingdom 2 staging', async () => {
  const h = await createRallyHarness();
  await stage(h, 2, [{ pid: MAIN, role: 'weak' }]);
  const kingdom2JSON = JSON.stringify(h.room.room.live.staged[2]);

  await send(h, command('double_rally', 1, doublePairs(), 0));
  await send(h, cancel(1));

  assert.deepEqual(stagePairs(h, 1), doublePairs());
  assert.equal(JSON.stringify(h.room.room.live.staged[2]), kingdom2JSON);
});

test('non-rally and empty Cancel do not create or clear staging', async () => {
  const nonRally = await createRallyHarness([WEAK]);
  await send(nonRally, command('ping', 1, [], 0));
  assert.equal(stagePairs(nonRally, 1), null);
  await send(nonRally, cancel(1));
  assert.equal(stagePairs(nonRally, 1), null);
  assert.equal(nonRally.room.room.live.commands[1], null);

  const empty = await createRallyHarness([WEAK]);
  await stage(empty, 1, [{ pid: WEAK, role: 'weak' }]);
  const stagedJSON = JSON.stringify(empty.room.room.live.staged[1]);
  empty.reset();
  await send(empty, cancel(1));
  assert.equal(JSON.stringify(empty.room.room.live.staged[1]), stagedJSON);
  assert.deepEqual(empty.calls, []);
});

test('Cancel omits missing players while preserving the remaining valid pair', async () => {
  const h = await createRallyHarness([WEAK, WEAK2]);
  await send(h, command('double_rally', 1, doublePairs(), 0));
  delete h.room.room.players[WEAK];

  await send(h, cancel(1));

  assert.deepEqual(stagePairs(h, 1), [{ pid: WEAK2, role: 'main' }]);
  assert.equal(h.room.room.live.commands[1], null);
});

test('Cancel omits staged and live cross-kingdom conflicts while preserving valid pairs', async () => {
  const h = await createRallyHarness();
  await setMode(h, 1, 'triple', 0);
  await send(h, command('triple_rally', 1, triplePairs(), 1));
  h.room.room.live.staged[2] = {
    kingdom: 2,
    pairs: [{ pid: WEAK, role: 'weak' }]
  };
  h.room.room.live.commands[2] = {
    id: 'other-kingdom-live', type: 'double_rally', kingdom: 2, expiresUTC: 2_000,
    payload: { pairs: [{ pid: WEAK2, role: 'main' }] }
  };

  await send(h, cancel(1));

  assert.deepEqual(stagePairs(h, 1), [{ pid: MAIN, role: 'main' }]);
  assert.equal(h.room.room.live.commands[1], null);
  assert.equal(h.room.room.live.commands[2].id, 'other-kingdom-live');
});
