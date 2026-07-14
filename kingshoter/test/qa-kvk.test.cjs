const test = require('node:test');
const assert = require('node:assert/strict');

function createWebSocketRouteHarness(url) {
  let routeHandler = null;
  let clientMessageHandler = null;
  let serverMessageHandler = null;
  const forwardedClientFrames = [];
  const forwardedServerFrames = [];
  const server = {
    send(data) { forwardedClientFrames.push(data); },
    onMessage(handler) { serverMessageHandler = handler; }
  };
  const route = {
    url() { return url; },
    connectToServer() { return server; },
    send(data) { forwardedServerFrames.push(data); },
    onMessage(handler) { clientMessageHandler = handler; }
  };
  const context = {
    async routeWebSocket(_pattern, handler) { routeHandler = handler; }
  };
  return {
    context,
    forwardedClientFrames,
    forwardedServerFrames,
    activate() { return routeHandler(route); },
    receiveClient(data) { return clientMessageHandler(data); },
    receiveServer(data) { return serverMessageHandler(data); }
  };
}

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

test('QA WebSocket guard preserves raw frames and optionally transforms server frames', async () => {
  const { installQaWebSocketGuard } = require('./support/qa-kvk.cjs');
  const room = 'qa-kvk-guard-unit';
  const url = `ws://127.0.0.1:8791/api/ws?room=${room}`;
  const rawClientFrame = Buffer.from('{"t":"client"}');
  const rawServerFrame = Buffer.from('{"t":"server"}');

  const passthrough = createWebSocketRouteHarness(url);
  await installQaWebSocketGuard(passthrough.context, room);
  passthrough.activate();
  passthrough.receiveClient(rawClientFrame);
  passthrough.receiveServer(rawServerFrame);
  assert.strictEqual(passthrough.forwardedClientFrames[0], rawClientFrame,
    'default client forwarding preserves the original raw frame');
  assert.strictEqual(passthrough.forwardedServerFrames[0], rawServerFrame,
    'default server forwarding preserves the original raw frame');

  let transformInput = null;
  const transformedFrame = Buffer.from('{"t":"transformed"}');
  const transformed = createWebSocketRouteHarness(url);
  await installQaWebSocketGuard(transformed.context, room, {
    transformServerMessage(input) {
      transformInput = input;
      return transformedFrame;
    }
  });
  transformed.activate();
  transformed.receiveClient(rawClientFrame);
  transformed.receiveServer(rawServerFrame);
  assert.strictEqual(transformed.forwardedServerFrames[0], transformedFrame,
    'the transformed server frame reaches the page');
  assert.strictEqual(transformInput.data, rawServerFrame,
    'the transform receives the untouched raw server frame');
  assert.equal(transformInput.url, url);
  assert.strictEqual(transformed.forwardedClientFrames[0], rawClientFrame,
    'the server transform does not alter client forwarding');

  await assert.rejects(
    installQaWebSocketGuard(createWebSocketRouteHarness(url).context, room, {
      transformServerMessage: true
    }),
    error => error instanceof TypeError && /transformServerMessage/.test(error.message)
  );

  const refused = createWebSocketRouteHarness('ws://127.0.0.1:8791/api/ws?room=operation-room');
  await installQaWebSocketGuard(refused.context, room, {
    transformServerMessage: data => data
  });
  assert.throws(() => refused.activate(), /Refusing WebSocket room operation-room/);
});
