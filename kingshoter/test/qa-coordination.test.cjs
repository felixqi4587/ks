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

test('QA room is fixed and every non-QA room is rejected', () => {
  const {
    assertQaRoomName,
    makeQaRoom,
    qaRoomUrl
  } = require('./support/qa-coordination.cjs');

  const room = makeQaRoom({ title: 'Classic ACK / commander silence' });
  assert.equal(room, 'qa');
  assert.equal(assertQaRoomName(room), room);
  assert.throws(() => assertQaRoomName('operation-room'), /expected qa/);
  assert.throws(() => assertQaRoomName('qa-kvk-old'), /expected qa/);
  assert.throws(() => assertQaRoomName('QA'), /expected qa/);

  const url = new URL(qaRoomUrl('http://127.0.0.1:8791', room, { notour: '1', lang: 'en' }));
  assert.equal(url.pathname, '/rally');
  assert.equal(url.searchParams.get('room'), room);
  assert.equal(url.searchParams.get('notour'), '1');
  assert.equal(url.searchParams.get('lang'), 'en');
});

test('QA Rally cleanup follows the normal commander protocol in convergence order', () => {
  const { nextQaRallyCleanupActions } = require('./support/qa-coordination.cjs');
  const nextId = (() => {
    let value = 0;
    return () => `cleanup-${++value}`;
  })();

  const active = nextQaRallyCleanupActions({
    live: { commands: { 1: { id: 'command-one' }, 2: { id: 'command-two' } }, staged: {} },
    rallyModes: { 1: { mode: 'triple', revision: 4 }, 2: { mode: 'triple', revision: 7 } },
    players: { alpha: {}, bravo: {} }
  }, 'qa', 'qa', nextId);
  assert.deepEqual(active.map(action => action.message), [
    { t: 'cmd', password: 'qa', cmd: { type: 'cancel', kingdom: 1 } },
    { t: 'cmd', password: 'qa', cmd: { type: 'cancel', kingdom: 2 } }
  ]);

  const staged = nextQaRallyCleanupActions({
    live: { commands: {}, staged: { 1: { pairs: [{ pid: 'alpha', role: 'weak' }] }, 2: { pairs: [{ pid: 'bravo', role: 'main' }] } } },
    rallyModes: { 1: { mode: 'triple', revision: 4 }, 2: { mode: 'triple', revision: 7 } },
    players: { alpha: {}, bravo: {} }
  }, 'qa', 'qa', nextId);
  assert.deepEqual(staged.map(action => action.message), [
    { t: 'stage', password: 'qa', staged: { kingdom: 1, modeRevision: 4, pairs: [] } },
    { t: 'stage', password: 'qa', staged: { kingdom: 2, modeRevision: 7, pairs: [] } }
  ]);

  const modes = nextQaRallyCleanupActions({
    live: { commands: {}, staged: {} },
    rallyModes: { 1: { mode: 'triple', revision: 4 }, 2: { mode: 'double', revision: 7 } },
    players: { alpha: {}, bravo: {} }
  }, 'qa', 'qa', nextId);
  assert.deepEqual(modes.map(action => action.message), [{
    t: 'setRallyMode', mutationId: 'cleanup-1', password: 'qa', kingdom: 1, mode: 'double', baseRevision: 4
  }]);

  const players = nextQaRallyCleanupActions({
    live: { commands: {}, staged: {} },
    rallyModes: { 1: { mode: 'double', revision: 5 }, 2: { mode: 'double', revision: 7 } },
    players: { bravo: {}, alpha: {} }
  }, 'qa', 'qa', nextId);
  assert.deepEqual(players.map(action => action.message), [{
    t: 'removePlayer', password: 'qa', pid: 'alpha' 
  }], 'cleanup removes one player, then waits for a confirming snapshot before choosing again');

  assert.deepEqual(nextQaRallyCleanupActions({
    live: { commands: {}, staged: {} },
    rallyModes: { 1: { mode: 'double', revision: 5 }, 2: { mode: 'double', revision: 7 } },
    players: {}
  }, 'qa', 'qa', nextId), []);
});

test('Room harness preserves the exact QA room in its URL and socket attachment', async () => {
  const { loadRoom, createRoomHarness } = require('./room-harness.cjs');
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  assert.equal(h.roomName, 'qa');
  assert.equal(h.room.state.id.name, 'qa');
  assert.equal(new URL(h.fetchURL).searchParams.get('room'), 'qa');
  assert.equal(h.ws.deserializeAttachment().roomName, 'qa');
});

test('QA WebSocket guard preserves raw frames and optionally transforms server frames', async () => {
  const { installQaWebSocketGuard } = require('./support/qa-coordination.cjs');
  const room = 'qa';
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
