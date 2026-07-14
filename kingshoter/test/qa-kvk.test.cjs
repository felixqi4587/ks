const test = require('node:test');
const assert = require('node:assert/strict');

test('QA rooms are generated safely and every non-QA room is rejected', () => {
  const {
    assertQaRoomName,
    makeQaRoom,
    qaRoomUrl
  } = require('./support/qa-kvk.cjs');

  const room = makeQaRoom({ title: 'Classic ACK / commander silence' });
  assert.match(room, /^qa-kvk-[a-z0-9-]+$/);
  assert.equal(assertQaRoomName(room), room);
  assert.throws(() => assertQaRoomName('operation-room'), /qa-kvk/);
  assert.throws(() => assertQaRoomName('alerts-123'), /qa-kvk/);
  assert.throws(() => assertQaRoomName('qa_kvk_wrong'), /qa-kvk/);

  const url = new URL(qaRoomUrl('http://127.0.0.1:8791', room, { notour: '1', lang: 'en' }));
  assert.equal(url.pathname, '/kvk.html');
  assert.equal(url.searchParams.get('room'), room);
  assert.equal(url.searchParams.get('notour'), '1');
  assert.equal(url.searchParams.get('lang'), 'en');
});

test('Room harness preserves the exact QA room in its URL and socket attachment', async () => {
  const { loadRoom, createRoomHarness } = require('./room-harness.cjs');
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-unit' });
  assert.equal(h.roomName, 'qa-kvk-unit');
  assert.equal(h.room.state.id.name, 'qa-kvk-unit');
  assert.equal(new URL(h.fetchURL).searchParams.get('room'), 'qa-kvk-unit');
  assert.equal(h.ws.deserializeAttachment().roomName, 'qa-kvk-unit');
  assert.throws(() => createRoomHarness(Room, { roomName: 'operation-room' }), /qa-kvk/);
});
