const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadRoom, createRoomHarness } = require('./room-harness.cjs');

async function loadSurface() {
  const url = pathToFileURL(path.join(__dirname, '../src/room-surface.js'));
  url.searchParams.set('testRun', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function addSocket(harness, attachment) {
  const sent = [];
  let stored = attachment == null ? null : structuredClone(attachment);
  const ws = {
    readyState: 1,
    send(value) { sent.push(JSON.parse(value)); },
    serializeAttachment(value) { stored = structuredClone(value); },
    deserializeAttachment() { return stored == null ? null : structuredClone(stored); }
  };
  harness.room.state.acceptWebSocket(ws);
  return { ws, sent, attachment: () => ws.deserializeAttachment() };
}

async function captureFetch(room, surface) {
  let server = null;
  let attachment = null;
  const sent = [];
  const originalPair = globalThis.WebSocketPair;
  const originalResponse = globalThis.Response;

  class FakeWebSocketPair {
    constructor() {
      this.client = {};
      this.server = server = {
        readyState: 1,
        send(value) { sent.push(JSON.parse(value)); },
        serializeAttachment(value) { attachment = structuredClone(value); },
        deserializeAttachment() { return attachment == null ? null : structuredClone(attachment); }
      };
    }
  }
  class FakeResponse {
    constructor(body, init = {}) { this.body = body; Object.assign(this, init); }
  }

  const url = new URL('https://qa-kvk.invalid/api/ws');
  if (surface !== undefined) url.searchParams.set('surface', surface);
  globalThis.WebSocketPair = FakeWebSocketPair;
  globalThis.Response = FakeResponse;
  try {
    const response = await room.fetch({
      headers: { get: name => name === 'Upgrade' ? 'websocket' : null },
      url: url.toString()
    });
    return { response, server, sent, attachment: () => structuredClone(attachment) };
  } finally {
    globalThis.WebSocketPair = originalPair;
    globalThis.Response = originalResponse;
  }
}

test('request surface parsing preserves only legacy/missing Rally and explicit valid surfaces', async () => {
  const { parseRequestedSurface } = await loadSurface();
  const parse = value => {
    const params = new URLSearchParams();
    if (value !== undefined) params.set('surface', value);
    return parseRequestedSurface(params);
  };

  assert.deepEqual(parse(undefined), { ok: true, surface: 'rally', legacy: true });
  assert.deepEqual(parse('rally'), { ok: true, surface: 'rally', legacy: false });
  assert.deepEqual(parse('defense'), { ok: true, surface: 'defense', legacy: false });
  assert.deepEqual(parse(''), { ok: false, error: 'invalid_surface' });
  assert.deepEqual(parse('unknown'), { ok: false, error: 'invalid_surface' });
  const repeated = new URLSearchParams('surface=rally&surface=defense');
  assert.deepEqual(parseRequestedSurface(repeated), { ok: false, error: 'invalid_surface' });
});

test('stored attachment surfaces migrate only a truly missing legacy field', async () => {
  const { inspectSocketSurface } = await loadSurface();

  assert.deepEqual(inspectSocketSurface({ roomName: 'qa-kvk-old' }), {
    ok: true, surface: 'rally', needsMigration: true
  });
  assert.deepEqual(inspectSocketSurface({ surface: 'rally' }), {
    ok: true, surface: 'rally', needsMigration: false
  });
  assert.deepEqual(inspectSocketSurface({ surface: 'defense' }), {
    ok: true, surface: 'defense', needsMigration: false
  });
  for (const surface of ['', 'unknown', null, undefined]) {
    assert.deepEqual(inspectSocketSurface({ surface }), {
      ok: false, error: 'invalid_surface'
    });
  }
});

test('malformed or unreadable hibernated attachments fail closed instead of becoming legacy Rally', async t => {
  const { Room } = await loadRoom();
  const cases = [
    ['deserialize throw', () => { throw new Error('attachment unavailable'); }],
    ['null', () => null],
    ['undefined', () => undefined],
    ['string', () => 'rally'],
    ['number', () => 1],
    ['boolean', () => false],
    ['array', () => [{ surface: 'rally' }]]
  ];

  for (const [label, deserializeAttachment] of cases) {
    await t.test(label, async () => {
      const h = createRoomHarness(Room, {
        roomName: `qa-kvk-surface-malformed-${label.replace(/\s+/g, '-')}`
      });
      let deliveryLoads = 0;
      h.room.ensureDeliveryLoaded = async () => { deliveryLoads += 1; };
      h.ws.deserializeAttachment = deserializeAttachment;
      h.reset();

      await h.room.webSocketMessage(h.ws, JSON.stringify({
        t: 'setConfig', password: 'must-not-claim-rally', config: {}, by: 'malformed'
      }));

      assert.deepEqual(h.sent, [{ t: 'error', error: 'invalid_surface' }]);
      assert.equal(deliveryLoads, 0);
      assert.equal(h.room.room.pwHash, null);
      assert.deepEqual(h.calls, []);
      assert.equal(h.room.liveCoreSockets().includes(h.ws), false);
    });
  }
});

test('a socket whose immutable attachment cannot serialize is not accepted into the live Rally set', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-surface-attach-failure' });
  let accepted = false;
  let closed = false;
  const acceptWebSocket = h.room.state.acceptWebSocket;
  h.room.state.acceptWebSocket = socket => {
    if (socket === failedSocket) accepted = true;
    return acceptWebSocket(socket);
  };
  const failedSocket = {
    readyState: 1,
    send() {},
    close() { closed = true; this.readyState = 3; },
    deserializeAttachment() { return null; },
    serializeAttachment() { throw new Error('attachment serialization failed'); }
  };

  assert.throws(
    () => h.room.attachSocket(failedSocket, h.roomName, 'rally'),
    /attachment serialization failed/
  );
  assert.equal(accepted, false, 'a socket without an immutable surface attachment must never be accepted');
  assert.equal(closed, true, 'the failed endpoint is closed defensively');
  assert.equal(h.room.liveCoreSockets().includes(failedSocket), false);
});

test('an accept-first compatibility retry closes and excludes a socket when serialization still fails', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-surface-attach-retry-failure' });
  let accepted = false;
  let closed = false;
  let attempts = 0;
  const acceptWebSocket = h.room.state.acceptWebSocket;
  h.room.state.acceptWebSocket = socket => {
    if (socket === failedSocket) accepted = true;
    return acceptWebSocket(socket);
  };
  const failedSocket = {
    readyState: 1,
    send() {},
    close() { closed = true; this.readyState = 3; },
    deserializeAttachment() { return null; },
    serializeAttachment() {
      attempts += 1;
      if (attempts === 1) throw new Error('serializeAttachment requires an accepted WebSocket');
      throw new Error('attachment serialization failed after accept');
    }
  };

  assert.throws(
    () => h.room.attachSocket(failedSocket, h.roomName, 'rally'),
    /attachment serialization failed after accept/
  );
  assert.equal(accepted, true, 'the compatibility branch retries only after the runtime requires acceptance');
  assert.equal(attempts, 2);
  assert.equal(closed, true);
  assert.equal(h.room.liveCoreSockets().includes(failedSocket), false);
});

test('a cold Defense fetch does not read or write Rally storage namespaces', async () => {
  const { Room } = await loadRoom();
  const reads = [];
  const writes = [];
  let initialized;
  const sockets = [];
  const state = {
    id: { name: 'r:qa-kvk-defense-cold-start' },
    storage: {
      async get(key) { reads.push(key); return null; },
      async put(key, value) { writes.push([key, value]); }
    },
    getWebSockets() { return sockets.slice(); },
    acceptWebSocket(socket) { sockets.push(socket); },
    blockConcurrencyWhile(callback) {
      initialized = callback();
      return initialized;
    }
  };
  const room = new Room(state, { MASTER: 'separate-master-override' });
  await initialized;

  const result = await captureFetch(room, 'defense');

  assert.equal(result.response.status, 101);
  assert.deepEqual(result.sent, [{ t: 'error', error: 'defense_not_available' }]);
  assert.deepEqual(reads, [], 'Defense cold start cannot inspect Rally room or delivery state');
  assert.deepEqual(writes, [], 'Defense cold start cannot migrate or persist Rally state');
});

test('missing and explicit Rally fetches retain the Rally handshake and bind immutable Rally surface', async () => {
  const { Room } = await loadRoom();
  for (const surface of [undefined, 'rally']) {
    const h = createRoomHarness(Room, { roomName: `qa-kvk-surface-${surface || 'legacy'}` });
    let deliveryLoads = 0;
    let tripleGates = 0;
    let stateReads = 0;
    h.room.ensureDeliveryLoaded = async () => { deliveryLoads += 1; };
    h.room.applyTripleGate = async () => { tripleGates += 1; };
    h.room.stateMsg = () => {
      stateReads += 1;
      return JSON.stringify({ t: 'state', room: { marker: 'rally' } });
    };

    const result = await captureFetch(h.room, surface);
    assert.equal(result.response.status, 101);
    assert.deepEqual(result.sent, [{ t: 'state', room: { marker: 'rally' } }]);
    assert.equal(result.attachment().surface, 'rally');
    assert.deepEqual({ deliveryLoads, tripleGates, stateReads }, {
      deliveryLoads: 1, tripleGates: 1, stateReads: 1
    });
    assert.throws(
      () => h.room.writeSocketAttachment(result.server, { surface: 'defense' }),
      /surface_immutable/
    );
    assert.equal(result.attachment().surface, 'rally');
  }
});

test('explicit Defense fetch returns only defense_not_available before any Rally load or projection', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-surface-defense' });
  const touched = [];
  h.room.ensureDeliveryLoaded = async () => { touched.push('delivery'); };
  h.room.applyTripleGate = async () => { touched.push('triple'); };
  h.room.stateMsg = () => { touched.push('state'); return '{}'; };

  const result = await captureFetch(h.room, 'defense');
  assert.equal(result.response.status, 101);
  assert.deepEqual(result.sent, [{ t: 'error', error: 'defense_not_available' }]);
  assert.deepEqual(touched, []);
  assert.equal(result.attachment().surface, 'defense');
  assert.throws(
    () => h.room.writeSocketAttachment(result.server, { surface: 'rally' }),
    /surface_immutable/
  );
  assert.equal(result.attachment().surface, 'defense');
});

test('empty and unknown fetch surfaces fail closed before accepting or touching Rally', async () => {
  const { Room } = await loadRoom();
  for (const surface of ['', 'unknown']) {
    const h = createRoomHarness(Room, { roomName: `qa-kvk-surface-invalid-${surface || 'empty'}` });
    const touched = [];
    h.room.ensureDeliveryLoaded = async () => { touched.push('delivery'); };
    h.room.applyTripleGate = async () => { touched.push('triple'); };
    h.room.stateMsg = () => { touched.push('state'); return '{}'; };

    const result = await captureFetch(h.room, surface);
    assert.equal(result.response.status, 400);
    assert.equal(result.server, null);
    assert.deepEqual(JSON.parse(result.response.body), { t: 'error', error: 'invalid_surface' });
    assert.deepEqual(touched, []);
  }
});

test('first hibernated legacy message migrates to Rally before loading Rally delivery', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-surface-hibernated-legacy' });
  h.ws.serializeAttachment({
    roomName: h.roomName, pid: '', deviceId: '', soundReady: false, clientBuild: 0
  });
  let surfaceAtDeliveryLoad = null;
  h.room.ensureDeliveryLoaded = async () => {
    surfaceAtDeliveryLoad = h.ws.deserializeAttachment().surface;
  };

  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'hello' }));
  assert.equal(surfaceAtDeliveryLoad, 'rally');
  assert.equal(h.ws.deserializeAttachment().surface, 'rally');
});

test('a Defense first message after hibernation cannot load or mutate Rally state', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-surface-hibernated-defense' });
  h.ws.serializeAttachment({
    roomName: h.roomName, surface: 'defense', pid: '', deviceId: '', soundReady: false
  });
  let deliveryLoads = 0;
  h.room.ensureDeliveryLoaded = async () => { deliveryLoads += 1; };
  h.reset();

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setConfig', password: 'would-claim-rally', config: {}, by: 'defense'
  }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'defense_not_available' }]);
  assert.equal(deliveryLoads, 0);
  assert.equal(h.room.room.pwHash, null);
  assert.deepEqual(h.calls, []);
});

test('an invalid stored surface fails closed before Rally load, projection, or mutation', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-surface-hibernated-invalid' });
  h.ws.serializeAttachment({
    roomName: h.roomName, surface: 'unknown', pid: '', deviceId: '', soundReady: false
  });
  let deliveryLoads = 0;
  h.room.ensureDeliveryLoaded = async () => { deliveryLoads += 1; };
  h.reset();

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setConfig', password: 'would-claim-rally', config: {}, by: 'invalid'
  }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'invalid_surface' }]);
  assert.equal(deliveryLoads, 0);
  assert.equal(h.room.room.pwHash, null);
  assert.deepEqual(h.calls, []);
});

test('Rally broadcasts exclude Defense and invalid attachments but preserve legacy Rally sockets', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-surface-broadcast' });
  h.ws.serializeAttachment({
    roomName: h.roomName, surface: 'rally', pid: '', deviceId: '', soundReady: false, clientBuild: 0
  });
  h.reset();
  const legacy = addSocket(h, { roomName: h.roomName, pid: '', deviceId: '', soundReady: false });
  const defense = addSocket(h, { roomName: h.roomName, surface: 'defense' });
  const invalid = addSocket(h, { roomName: h.roomName, surface: 'unknown' });

  Room.prototype.broadcast.call(h.room);

  assert.equal(h.sent.at(-1).t, 'state');
  assert.equal(legacy.sent.at(-1).t, 'state');
  assert.deepEqual(defense.sent, []);
  assert.deepEqual(invalid.sent, []);
});

test('Defense and invalid close/error callbacks cannot load or rebroadcast Rally state', async () => {
  const { Room } = await loadRoom();
  for (const surface of ['defense', 'unknown']) {
    const h = createRoomHarness(Room, { roomName: `qa-kvk-surface-close-${surface}` });
    h.ws.serializeAttachment({ roomName: h.roomName, surface });
    let deliveryLoads = 0;
    let closed = 0;
    h.ws.close = () => { closed += 1; };
    h.room.ensureDeliveryLoaded = async () => { deliveryLoads += 1; };
    h.reset();

    await Room.prototype.webSocketClose.call(h.room, h.ws);
    Room.prototype.webSocketError.call(h.room, h.ws);

    assert.equal(closed, 1);
    assert.equal(deliveryLoads, 0);
    assert.deepEqual(h.calls, []);
  }
});
