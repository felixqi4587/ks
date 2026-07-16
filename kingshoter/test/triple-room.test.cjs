const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness, claimRoom } = require('./room-harness.cjs');

test('mode updates authenticate, revision, persist once, ack, and broadcast once', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { env: { TRIPLE_RALLY_ENABLED: '1' } });
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-1', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));
  assert.deepEqual(h.room.room.rallyModes[1], { mode: 'triple', revision: 1 });
  assert.deepEqual(h.sent.at(-1), {
    t: 'rallyModeSaved', mutationId: 'm-1', kingdom: 1, mode: 'triple', revision: 1
  });
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
});

test('mode update still broadcasts canonical state when its direct ACK socket drops', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { env: { TRIPLE_RALLY_ENABLED: '1' } });
  await claimRoom(h);
  h.ws.send = () => { throw new Error('initiator disconnected'); };

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-dropped-ack', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));

  assert.deepEqual(h.room.room.rallyModes[1], { mode: 'triple', revision: 1 });
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
});

test('stale mode and stage revisions never mutate canonical state', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { env: { TRIPLE_RALLY_ENABLED: '1' } });
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-current', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));
  h.reset();

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-stale', password: 'commander-secret',
    kingdom: 1, mode: 'double', baseRevision: 0
  }));
  assert.equal(h.sent.at(-1).error, 'rally_mode_conflict');
  assert.deepEqual(h.room.room.rallyModes[1], { mode: 'triple', revision: 1 });
  assert.deepEqual(h.calls, []);

  h.sent.length = 0;
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'stage', password: 'commander-secret',
    staged: { kingdom: 1, modeRevision: 0, pairs: [{ pid: '001', role: 'weak' }] }
  }));
  assert.equal(h.sent.at(-1).error, 'rally_mode_conflict');
  assert.equal(h.room.room.live.staged[1], null);
  assert.deepEqual(h.calls, []);
});

test('Triple stage and Fire require the current mode revision and freeze canonical players', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '1' },
    roomName: 'qa-kvk-triple-dispatch',
    players: {
      a: { name: 'A', march: 20, marchRevision: 1 },
      b: { name: 'B', march: 40, marchRevision: 2 },
      c: { name: 'C', march: 30, marchRevision: 3 }
    },
    nowMs: 1_000_750
  });
  await claimRoom(h);
  h.room.delivery = { v: 1, roomName: h.roomName, commands: [] };
  h.room.persistDelivery = async () => { h.calls.push('delivery-persist'); };
  h.room.devices = [
    { pid: 'a', deviceId: '00000000-0000-4000-8000-000000000001', soundReady: true, lastSeenMs: 1_000_750 },
    { pid: 'b', deviceId: '00000000-0000-4000-8000-000000000002', soundReady: true, lastSeenMs: 1_000_750 },
    { pid: 'c', deviceId: '00000000-0000-4000-8000-000000000003', soundReady: true, lastSeenMs: 1_000_750 }
  ];
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-2', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));
  h.reset();
  const pairs = [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }];
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'stage', password: 'commander-secret', staged: { kingdom: 1, modeRevision: 1, pairs }
  }));
  assert.deepEqual(h.room.room.live.staged[1].pairs, pairs);
  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'triple_rally', kingdom: 1, modeRevision: 1,
      payload: { leadSeconds: 10, pairs }
    }
  }));
  const command = h.room.room.live.commands[1];
  assert.equal(command.type, 'triple_rally');
  assert.equal(command.anchorUTC, 1010.75);
  assert.deepEqual(command.payload.pairs.map((pair) => pair.march), [20, 40, 30]);
  assert.equal(command.payload.pairs[0].pressUTC + 20, command.payload.pairs[1].pressUTC + 40);
  assert.equal(command.payload.pairs[2].pressUTC + 30, command.payload.pairs[0].pressUTC + 21);
  assert.deepEqual(command.delivery.map((entry) => [entry.pid, entry.expected]), [['a', 1], ['b', 1], ['c', 1]]);
  assert.deepEqual(h.room.delivery.commands.at(-1).audiences.map((audience) => [audience.pid, audience.role]), [
    ['a', 'weak'], ['b', 'weak2'], ['c', 'main']
  ]);
  assert.equal(h.room.room.live.staged[1], null);
  assert.deepEqual(h.calls, ['persistAll', 'alarm', 'broadcast', 'delivery-persist', 'alarm']);
});

test('Triple Fire rejects a captain already live in the other kingdom without mutating either command', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '1' },
    roomName: 'qa-kvk-triple-cross-kingdom-live',
    nowMs: 1_000_000,
    players: {
      a: { name: 'A', march: 20, marchRevision: 0 },
      b: { name: 'B', march: 40, marchRevision: 0 },
      c: { name: 'C', march: 30, marchRevision: 0 }
    }
  });
  await claimRoom(h);
  h.room.room.rallyModes[2] = { mode: 'triple', revision: 1 };
  const existing = {
    id: 'kingdom-one-live', type: 'double_rally', kingdom: 1, expiresUTC: 2_000,
    payload: { pairs: [{ pid: 'a', role: 'weak' }] }
  };
  h.room.room.live.commands[1] = existing;
  h.reset();

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'triple_rally', kingdom: 2, modeRevision: 1,
      payload: {
        leadSeconds: 10,
        pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }]
      }
    }
  }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'rally_live', pid: 'a', kingdom: 1 }]);
  assert.strictEqual(h.room.room.live.commands[1], existing);
  assert.equal(h.room.room.live.commands[2], null);
  assert.deepEqual(h.calls, []);
});

test('Triple disabled makes no mutation', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { env: { TRIPLE_RALLY_ENABLED: '0' } });
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-3', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));
  assert.equal(h.sent.at(-1).error, 'triple_disabled');
  assert.deepEqual(h.room.room.rallyModes[1], { mode: 'double', revision: 0 });
  assert.deepEqual(h.calls, []);
});

test('QA-only gate permits generated QA rooms but normalizes an operation-room state', async () => {
  const { Room } = await loadRoom();
  const env = { TRIPLE_RALLY_ENABLED: '0', TRIPLE_RALLY_QA_ENABLED: '1' };
  const qa = createRoomHarness(Room, { env, roomName: 'qa-kvk-unit-gate' });
  await claimRoom(qa);
  await qa.room.webSocketMessage(qa.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-qa', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));
  assert.equal(qa.room.room.rallyModes[1].mode, 'triple');

  const operation = createRoomHarness(Room, { env, roomName: 'qa-kvk-unit-operation-simulation' });
  operation.room.roomName = 'operation-room';
  operation.room.room.rallyModes[1] = { mode: 'triple', revision: 2 };
  await operation.room.applyTripleGate();
  assert.equal(operation.room.room.rallyModes[1].mode, 'double');
});

test('a stale QA socket attachment cannot enable Triple for an operation-room Durable Object', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '0', TRIPLE_RALLY_QA_ENABLED: '1' },
    roomName: 'qa-kvk-stale-attachment'
  });
  await claimRoom(h);
  h.room.roomName = 'operation-room';
  h.reset();

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-forged-room', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));

  assert.deepEqual(h.sent, [{
    t: 'error', error: 'triple_disabled', mutationId: 'm-forged-room'
  }]);
  assert.deepEqual(h.room.room.rallyModes[1], { mode: 'double', revision: 0 });
  assert.deepEqual(h.calls, []);

  Room.prototype.broadcast.call(h.room);
  assert.equal(h.sent.at(-1).room.capabilities.tripleRally, false);
});

test('Core device delivery is not blocked by a pending Triple rollback persistence failure', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '0', TRIPLE_RALLY_QA_ENABLED: '0' },
    roomName: 'qa-kvk-core-gate-isolation',
    nowMs: 2_000_000
  });
  h.room.room.rallyModes[1] = { mode: 'triple', revision: 4 };
  h.room.persist = async () => { throw new Error('rollback storage unavailable'); };

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deviceStatus', pid: '001',
    deviceId: '00000000-0000-4000-8000-000000000020', soundReady: true
  }));

  assert.equal(h.sent.at(-1).t, 'deviceStatusSaved');
  assert.equal(h.room.room.rallyModes[1].mode, 'triple');
});

test('cancel, refill, and ping remain independent of Triple rollback persistence', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '0', TRIPLE_RALLY_QA_ENABLED: '0' },
    roomName: 'qa-kvk-core-command-isolation', nowMs: 2_000_000
  });
  await claimRoom(h);
  h.room.room.rallyModes[1] = { mode: 'triple', revision: 4 };
  h.room.room.live.commands[1] = {
    id: 'active-triple', type: 'triple_rally', kingdom: 1,
    anchorUTC: 1990, expiresUTC: 3000, payload: { pairs: [] }
  };
  h.room.persist = async () => { throw new Error('rollback storage unavailable'); };

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd', password: 'commander-secret', cmd: { type: 'cancel', kingdom: 1 }
  }));
  assert.equal(h.room.room.live.commands[1], null);
  assert.deepEqual(h.calls.slice(0, 3), ['persistAll', 'alarm', 'broadcast']);

  for (const type of ['refill', 'ping']) {
    h.reset();
    await h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'cmd', password: 'commander-secret', cmd: {
        type, kingdom: 1, anchorUTC: 2010, payload: {}
      }
    }));
    assert.equal(h.room.room.live.commands[1].type, type);
    assert.deepEqual(h.calls.slice(0, 3), ['persistAll', 'alarm', 'broadcast']);
  }
  assert.deepEqual(h.room.room.rallyModes[1], { mode: 'triple', revision: 4 });
});

test('gate and mode persistence failures restore their complete in-memory state', async () => {
  const { Room } = await loadRoom();
  const rollback = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '0' }, roomName: 'qa-kvk-gate-rollback'
  });
  const staged = { kingdom: 1, pairs: [{ pid: '001', role: 'weak2' }] };
  rollback.room.room.rallyModes[1] = { mode: 'triple', revision: 4 };
  rollback.room.room.live.staged[1] = staged;
  rollback.room.persist = async () => { throw new Error('gate persist failed'); };

  await assert.rejects(() => rollback.room.applyTripleGate(), /gate persist failed/);
  assert.deepEqual(rollback.room.room.rallyModes[1], { mode: 'triple', revision: 4 });
  assert.strictEqual(rollback.room.room.live.staged[1], staged);
  assert.deepEqual(rollback.calls, []);

  const mode = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '1' }, roomName: 'qa-kvk-mode-rollback'
  });
  await claimRoom(mode);
  mode.room.persist = async () => { throw new Error('mode persist failed'); };
  await assert.rejects(() => mode.room.webSocketMessage(mode.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-persist-fail', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  })), /mode persist failed/);
  assert.deepEqual(mode.room.room.rallyModes[1], { mode: 'double', revision: 0 });
  assert.equal(mode.room.room.live.staged[1], null);
  assert.deepEqual(mode.calls, []);
});

test('real broadcast projects by socket build and merge-safe attachments retain room identity', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { env: { TRIPLE_RALLY_ENABLED: '1' }, roomName: 'qa-kvk-build-broadcast' });
  function socket(build, deviceId, failSend = false) {
    const messages = [];
    let attachment = null;
    const ws = {
      send(value) {
        if (failSend) throw new Error('socket send failed');
        messages.push(JSON.parse(value));
      },
      serializeAttachment(value) { attachment = structuredClone(value); },
      deserializeAttachment() { return attachment == null ? null : structuredClone(attachment); }
    };
    h.room.attachSocket(ws, h.roomName);
    h.room.writeSocketAttachment(ws, { clientBuild: build, deviceId, pid: 'a' });
    h.room.writeSocketAttachment(ws, { lastProbeId: 'probe-1' });
    return { ws, messages };
  }
  const legacy = socket(0, '00000000-0000-4000-8000-000000000010');
  socket(0, '00000000-0000-4000-8000-000000000012', true);
  const current = socket(2026071601, '00000000-0000-4000-8000-000000000011');
  h.room.room.live.commands[1] = {
    id: 'c', type: 'triple_rally', kingdom: 1,
    payload: { pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }] }
  };
  let snapshotCalls = 0;
  const snapshot = h.room.snapshot.bind(h.room);
  h.room.snapshot = () => { snapshotCalls += 1; return snapshot(); };
  Room.prototype.broadcast.call(h.room);
  assert.equal(snapshotCalls, 1);
  assert.equal(legacy.messages.at(-1).room.live.commands[1].type, 'double_rally');
  assert.equal(legacy.messages.at(-1).room.capabilities.tripleRally, false);
  assert.equal(current.messages.at(-1).room.live.commands[1].type, 'triple_rally');
  assert.equal(current.messages.at(-1).room.capabilities.tripleRally, true);
  assert.equal(Object.prototype.hasOwnProperty.call(h.room.snapshot(), 'capabilities'), false);
  const attachment = h.room.readSocketAttachment(current.ws);
  assert.equal(attachment.roomName, h.roomName);
  assert.equal(attachment.clientBuild, 2026071601);
  assert.equal(attachment.lastProbeId, 'probe-1');
  assert.equal(attachment.deviceId, '00000000-0000-4000-8000-000000000011');
});

test('fetch binds the canonical room, client build, and Reliable defaults before its first state send', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '1' }, roomName: 'qa-kvk-fetch-build'
  });
  let server;
  let attachmentAtFirstSend = null;
  let stateAtFirstSend = null;
  const originalPair = globalThis.WebSocketPair;
  const originalResponse = globalThis.Response;
  class FakeWebSocketPair {
    constructor() {
      let attachment = null;
      this.client = {};
      this.server = server = {
        send(value) {
          if (!attachmentAtFirstSend) {
            attachmentAtFirstSend = structuredClone(attachment);
            stateAtFirstSend = JSON.parse(value);
          }
        },
        serializeAttachment(value) { attachment = structuredClone(value); },
        deserializeAttachment() { return attachment == null ? null : structuredClone(attachment); }
      };
    }
  }
  class FakeResponse {
    constructor(body, init) { this.body = body; Object.assign(this, init); }
  }
  globalThis.WebSocketPair = FakeWebSocketPair;
  globalThis.Response = FakeResponse;
  try {
    h.room.ensureDeliveryLoaded = async () => {};
    await h.room.fetch({
      headers: { get: (name) => name === 'Upgrade' ? 'websocket' : null },
      url: 'https://qa-kvk.invalid/api/ws?room=operation-room&clientBuild=2026071601'
    });
  } finally {
    globalThis.WebSocketPair = originalPair;
    globalThis.Response = originalResponse;
  }

  assert.ok(server);
  assert.equal(attachmentAtFirstSend.roomName, h.roomName);
  assert.equal(attachmentAtFirstSend.clientBuild, 2026071601);
  assert.equal(attachmentAtFirstSend.v, 1);
  assert.equal(attachmentAtFirstSend.qa, true);
  assert.equal(attachmentAtFirstSend.view, 'player');
  assert.equal(attachmentAtFirstSend.shadow, false);
  assert.equal(attachmentAtFirstSend.audioArmed, false);
  assert.equal(attachmentAtFirstSend.lastProbeId, '');
  assert.equal(stateAtFirstSend.room.capabilities.tripleRally, true);
});

test('rollback normalizes future mode without mutating an active Triple command', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '0', TRIPLE_RALLY_QA_ENABLED: '0' },
    roomName: 'qa-kvk-rollback'
  });
  const active = { id: 'live-triple', type: 'triple_rally', expiresUTC: 2_000_000_000, payload: { pairs: [] } };
  h.room.room.rallyModes[1] = { mode: 'triple', revision: 4 };
  h.room.room.live.staged[1] = { kingdom: 1, pairs: [{ pid: 'a', role: 'weak2' }] };
  h.room.room.live.commands[1] = active;
  await h.room.applyTripleGate();
  assert.deepEqual(h.room.room.rallyModes[1], { mode: 'double', revision: 5 });
  assert.deepEqual(h.room.room.live.staged[1], null);
  assert.equal(h.room.room.live.commands[1], active);
  await claimRoom(h);
  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'double_rally', kingdom: 1, modeRevision: 5,
      payload: { leadSeconds: 10, pairs: [] }
    }
  }));
  assert.equal(h.sent.at(-1).error, 'rally_live');
  assert.equal(h.room.room.live.commands[1], active);
});

test('expiry equality permits a legacy Double request after a Double mode revision', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '1' }, roomName: 'qa-kvk-double-equality', nowMs: 1_000_000
  });
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-double-revision', password: 'commander-secret',
    kingdom: 1, mode: 'double', baseRevision: 0
  }));
  h.room.room.live.commands[1] = {
    id: 'expired-at-equality', type: 'triple_rally', expiresUTC: 1000,
    payload: { pairs: [] }
  };
  h.reset();

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 1010,
      payload: {
        firstPress: 1010, leadSeconds: 10,
        pairs: [{ pid: '001', role: 'weak' }, { pid: 'kimchi', role: 'main' }]
      }
    }
  }));

  assert.equal(h.room.room.rallyModes[1].revision, 1);
  assert.equal(h.room.room.live.commands[1].type, 'double_rally');
  assert.notEqual(h.room.room.live.commands[1].id, 'expired-at-equality');
  assert.deepEqual(h.calls.slice(0, 3), ['persistAll', 'alarm', 'broadcast']);
});
