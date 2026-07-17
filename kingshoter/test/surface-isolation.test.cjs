const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness } = require('./room-harness.cjs');

async function send(harness, socket, message) {
  await harness.room.webSocketMessage(socket, JSON.stringify(message));
}

test('Rally and Defense sockets reject cross-surface operations and never receive each other snapshots', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'rally' });
  const defense = h.addSocket('defense');

  await send(h, defense.ws, { t: 'hello' });
  assert.equal(defense.sent.at(-1).t, 'defenseState');
  assert.equal(defense.sent.some(frame => frame.t === 'state'), false);
  assert.equal(JSON.stringify(defense.sent).includes('Test 001'), false);
  assert.equal(h.sent.length, 0);

  await send(h, defense.ws, {
    t: 'setConfig', password: 'qa', config: {}, by: 'wrong-surface'
  });
  assert.deepEqual(defense.sent.at(-1), {
    t: 'error', source: 'defense', error: 'wrong_surface'
  });
  assert.equal(h.room.room.pwHash, null);

  await send(h, h.ws, {
    t: 'setDefenseConfig', password: 'qa', mutationId: 'wrong-rally',
    baseRevision: 0, tapAnchorSeconds: 5, enemyMarchSeconds: 60
  });
  assert.deepEqual(h.sent.at(-1), {
    t: 'error', source: 'rally', mutationId: 'wrong-rally', error: 'wrong_surface'
  });
  assert.equal(h.room.defense.config.revision, 0);

  await send(h, h.ws, {
    t: 'setDefensePlayerMarch', password: 'qa', mutationId: 'wrong-manager-edit',
    pid: '001', baseRevision: 0, march: 40
  });
  assert.deepEqual(h.sent.at(-1), {
    t: 'error', source: 'rally', mutationId: 'wrong-manager-edit', error: 'wrong_surface'
  });
  assert.equal(h.room.defense.players['001'], undefined);

  h.sent.length = 0;
  defense.sent.length = 0;
  Room.prototype.broadcast.call(h.room);
  assert.equal(h.sent.at(-1).t, 'state');
  assert.deepEqual(defense.sent, []);
});

test('Defense presence is surface-filtered and one hundred Defense sockets do not change Rally presence', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa', surface: 'rally' });
  const rallyPresence = h.room.snapshot().presence;
  const defenseSockets = [];
  for (let index = 0; index < 100; index += 1) {
    defenseSockets.push(h.addSocket('defense'));
  }
  assert.equal(h.room.snapshot().presence, rallyPresence);
  assert.equal(h.room.liveCoreSockets().length, 1);

  await send(h, defenseSockets[0].ws, { t: 'hello' });
  const state = defenseSockets[0].sent.at(-1);
  assert.equal(state.t, 'defenseState');
  assert.equal(Object.hasOwn(state, 'players'), false);
  assert.equal(Object.hasOwn(state, 'room'), false);
  assert.equal(JSON.stringify(state).includes('castleName'), false);
});

test('a cold Defense scheduler never erases an unreadable or due Rally alarm', async () => {
  const { Room } = await loadRoom();

  const unreadable = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}, nowMs: 2_000_000,
    useRealSchedule: true
  });
  await send(unreadable, unreadable.ws, { t: 'hello' });
  unreadable.room._rallyLoaded = false;
  await unreadable.room.state.storage.setAlarm(2_010_000);
  unreadable.storageCalls.length = 0;
  unreadable.room.state.storage.getAlarm = async () => {
    throw new Error('Rally alarm temporarily unreadable');
  };
  await Room.prototype.scheduleExpiry.call(unreadable.room);
  assert.equal(unreadable.alarmAtMs(), 2_010_000);
  assert.equal(unreadable.storageCalls.some(call => call.op === 'deleteAlarm'), false);

  const due = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}, nowMs: 3_000_000,
    useRealSchedule: true
  });
  await send(due, due.ws, { t: 'hello' });
  due.room._rallyLoaded = false;
  await due.room.state.storage.setAlarm(2_999_900);
  due.storageCalls.length = 0;
  await Room.prototype.scheduleExpiry.call(due.room);
  assert.equal(due.alarmAtMs(), 3_000_001,
    'an unknown due Rally wake is preserved at the next millisecond');

  const proposed = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}, nowMs: 4_000_000,
    useRealSchedule: true
  });
  await send(proposed, proposed.ws, { t: 'hello' });
  await send(proposed, proposed.ws, { t: 'defenseUnlock', password: 'qa' });
  await send(proposed, proposed.ws, {
    t: 'setDefenseConfig', password: 'qa', mutationId: 'cold-config',
    baseRevision: 0, tapAnchorSeconds: 5, enemyMarchSeconds: 60
  });
  await send(proposed, proposed.ws, {
    t: 'defenseManagerStatus', deviceId: '55000000-0000-4000-8000-000000000005',
    clockFresh: true, clockSampleAtMs: proposed.nowMs, clockOffsetMs: 0
  });
  proposed.room._rallyLoaded = false;
  await proposed.room.state.storage.setAlarm(4_000_500);
  proposed.room.state.storage.getAlarm = async () => {
    throw new Error('existing Rally alarm cannot be read');
  };
  proposed.sent.length = 0;
  await send(proposed, proposed.ws, {
    t: 'fireDefense', password: 'qa', mutationId: 'cold-fire',
    configRevision: 1, signalAtMs: proposed.nowMs
  });
  assert.equal(proposed.sent.at(-1).error, 'alarm_schedule_failed');
  assert.equal(proposed.room.defense.activeOrder, null);
  assert.equal(proposed.storage.get('defense:v1').activeOrder, null);
  assert.equal(proposed.alarmAtMs(), 4_000_500,
    'failed alarm inspection cannot overwrite an unknown earlier Rally wake');
});
