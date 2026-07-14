const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadRoom, createRoomHarness } = require('./room-harness.cjs');

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const DISPATCH_NOW_MS = 1_000_000;

const DISPATCH_IDS = {
  a1: '11111111-1111-4111-8111-111111111111',
  a2: '22222222-2222-4222-8222-222222222222',
  b1: '33333333-3333-4333-8333-333333333333',
  member: '44444444-4444-4444-8444-444444444444',
  commander: '55555555-5555-4555-8555-555555555555',
  stale: '66666666-6666-4666-8666-666666666666',
  unready: '77777777-7777-4777-8777-777777777777',
  classicOnly: '88888888-8888-4888-8888-888888888888',
  canonical: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
};

function prepareReliableSocket(harness) {
  harness.room.delivery = { v: 1, roomName: '', commands: [] };
  harness.room._deliveryLoaded = true;
  harness.room.writeSocketAttachment(harness.ws, {
    pid: '001', deviceId: DEVICE_ID, soundReady: true, clientBuild: 'classic-2026.07'
  });
  harness.room.initializeReliableAttachment(harness.ws);
  harness.reset();
  return harness;
}

function installDispatchRoom(harness, nowMs = DISPATCH_NOW_MS) {
  harness.room.room.players = {
    '700001': { name: 'A', march: 31 },
    '700002': { name: 'B', march: 30 },
    '700003': { name: 'Member', march: 25 }
  };
  harness.room.room.live = {
    mode: 'idle', commands: { 1: null, 2: null },
    staged: { 1: null, 2: null }, sim: null
  };
  harness.room.delivery = {
    v: 1, roomName: harness.roomName, commands: []
  };
  harness.room.devices = [];
  harness.room.deliveryAcks = [];
  harness.room._deliveryLoaded = true;
  harness.room.authOK = async () => true;
  harness.room.nowMs = () => nowMs;
  harness.room.now = () => new Date(nowMs).toISOString();
  return harness;
}

function doubleRallyMessage() {
  return {
    t: 'cmd', password: 'commander-secret',
    cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 1010,
      payload: {
        leadSeconds: 10, firstPress: 1010, kingdom: 1,
        pairs: [
          { pid: '700001', role: 'weak', pressUTC: 1010 },
          { pid: '700002', role: 'main', pressUTC: 1011 }
        ]
      }
    }
  };
}

function canonicalDoubleRally(id = 'command-reliable-dispatch') {
  return {
    id, type: 'double_rally', kingdom: 1,
    payload: {
      leadSeconds: 10,
      pairs: [
        { pid: '700001', role: 'weak', march: 31, pressUTC: 1010 },
        { pid: '700002', role: 'main', march: 30, pressUTC: 1011 }
      ]
    }
  };
}

async function loadWorker() {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'worker.js'));
  url.searchParams.set('testRun', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

async function constructDurableRoom(Room, durableName) {
  const privateWrites = [];
  let initialized;
  const state = {
    id: { name: durableName },
    storage: {
      async get() { return null; },
      async put(key, value) { privateWrites.push([key, structuredClone(value)]); },
      async setAlarm() {},
      async deleteAlarm() {}
    },
    getWebSockets() { return []; },
    blockConcurrencyWhile(callback) {
      initialized = callback();
      return initialized;
    }
  };
  const room = new Room(state, { MASTER: 'separate-master-override' });
  await initialized;
  room.nowMs = () => DISPATCH_NOW_MS;
  return { room, privateWrites };
}

function reliableSocket(harness, {
  pid,
  deviceId,
  view = 'player',
  soundReady = true,
  shadow = true,
  audioArmed = true,
  armedUntilMs = DISPATCH_NOW_MS + 20_000,
  onSend = null
}) {
  let attachment = null;
  const raw = [];
  const ws = {
    send(message) {
      raw.push(message);
      if (onSend) onSend(JSON.parse(message), message);
    },
    close() { this.closed = true; },
    serializeAttachment(value) { attachment = structuredClone(value); },
    deserializeAttachment() { return attachment == null ? null : structuredClone(attachment); }
  };
  harness.room.attachSocket(ws, harness.roomName);
  harness.room.initializeReliableAttachment(ws);
  harness.room.writeSocketAttachment(ws, {
    pid, deviceId, soundReady, clientBuild: 'classic-2026.07'
  });
  harness.room.writeReliableAttachment(ws, {
    view, shadow, audioArmed, armedUntilMs
  });
  return {
    ws,
    raw,
    messages() { return raw.map(message => JSON.parse(message)); },
    shadowCommands() { return this.messages().filter(message => message.t === 'deliveryShadowCommand'); }
  };
}

test('worker Durable Object names become trusted business room names at the real Room constructor boundary', async () => {
  const { default: worker, Room } = await loadWorker();
  let capturedName = '';
  const request = new Request('https://qa-kvk.invalid/api/ws?room=qa-kvk-worker-boundary');
  const response = await worker.fetch(request, {
    ROOM: {
      idFromName(name) {
        capturedName = name;
        return { name };
      },
      get(id) {
        return {
          async fetch() {
            assert.equal(id.name, capturedName);
            return new Response(null, { status: 204 });
          }
        };
      }
    }
  });
  assert.equal(response.status, 204);

  const { room, privateWrites } = await constructDurableRoom(Room, capturedName);
  const dispatched = await room.dispatchDeliveryForCommand(
    canonicalDoubleRally('worker-boundary-dispatch'), DISPATCH_NOW_MS
  );

  assert.deepEqual({
    capturedName,
    roomName: room.roomName,
    dispatched,
    privateWriteKeys: privateWrites.map(([key]) => key)
  }, {
    capturedName: 'r:qa-kvk-worker-boundary',
    roomName: 'qa-kvk-worker-boundary',
    dispatched: true,
    privateWriteKeys: ['delivery:v1']
  });
});

test('Room normalization preserves legacy names, strips one owned prefix, and keeps non-QA rooms gated', async () => {
  const { Room } = await loadRoom();
  const cases = [
    { durableName: 'qa-kvk-legacy', roomName: 'qa-kvk-legacy', dispatched: true },
    { durableName: 'operation-room', roomName: 'operation-room', dispatched: false },
    { durableName: 'r:operation-room', roomName: 'operation-room', dispatched: false },
    { durableName: 'r:r:qa-kvk-double', roomName: 'r:qa-kvk-double', dispatched: false }
  ];

  for (const item of cases) {
    const { room, privateWrites } = await constructDurableRoom(Room, item.durableName);
    const dispatched = await room.dispatchDeliveryForCommand(
      canonicalDoubleRally(`normalization-${item.durableName}`), DISPATCH_NOW_MS
    );
    assert.deepEqual({
      roomName: room.roomName,
      dispatched,
      privateWriteKeys: privateWrites.map(([key]) => key)
    }, {
      roomName: item.roomName,
      dispatched: item.dispatched,
      privateWriteKeys: item.dispatched ? ['delivery:v1'] : []
    }, item.durableName);
  }
});

test('constructor loads Reliable delivery state separately from the Core room', async () => {
  const { Room } = await loadRoom();
  const storageReads = [];
  let initialized;
  const state = {
    id: { name: 'qa-kvk-constructor' },
    storage: {
      async get(key) {
        storageReads.push(key);
        if (key === 'delivery:v1') return { v: 1, roomName: 'qa-kvk-constructor', commands: [] };
        return null;
      }
    },
    blockConcurrencyWhile(callback) {
      initialized = callback();
      return initialized;
    }
  };

  const room = new Room(state, { MASTER: 'separate-master-override' });
  await initialized;

  assert.deepEqual(storageReads, ['room', 'delivery:v1']);
  assert.deepEqual(room.delivery, { v: 1, roomName: 'qa-kvk-constructor', commands: [] });
  assert.equal(Object.prototype.hasOwnProperty.call(room.room, 'delivery'), false);
});

test('Reliable attachment wrappers preserve Core identity and unknown fields while enforcing their whitelist', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-wrapper' });
  h.room.writeSocketAttachment(h.ws, {
    pid: '001',
    deviceId: '00000000-0000-4000-8000-000000000001',
    soundReady: true,
    clientBuild: 'classic-2026.07'
  });

  const written = h.room.writeReliableAttachment(h.ws, {
    roomName: 'operation-room',
    pid: 'forged',
    deviceId: 'forged',
    soundReady: false,
    clientBuild: 'forged',
    v: 99,
    qa: false,
    view: 'commander',
    shadow: true,
    audioArmed: true,
    armedUntilMs: 1234,
    lastProbeId: 'probe-1',
    probeExpiresAtMs: 5678,
    nextProbeAtMs: 9012
  });

  assert.equal(written.roomName, 'qa-kvk-wrapper');
  assert.equal(written.pid, '001');
  assert.equal(written.deviceId, '00000000-0000-4000-8000-000000000001');
  assert.equal(written.soundReady, true);
  assert.equal(written.clientBuild, 'classic-2026.07');
  assert.equal(written.v, 1);
  assert.equal(written.qa, true);
  assert.equal(written.view, 'commander');
  assert.equal(written.shadow, true);

  h.room.writeSocketAttachment(h.ws, { roomName: 'operation-room', qa: true });
  assert.equal(h.room.readReliableAttachment(h.ws).qa, false, 'QA is recomputed from the Core-bound room');
});

test('Reliable defaults are initialized in the harness and in fetch before the first state send', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-initialize' });
  h.room.delivery = { v: 1, roomName: h.roomName, commands: [] };
  assert.deepEqual(h.room.initializeReliableAttachment(h.ws), {
    roomName: h.roomName,
    pid: '',
    deviceId: '',
    soundReady: false,
    v: 1,
    qa: true,
    view: 'player',
    shadow: false,
    audioArmed: false,
    armedUntilMs: 0,
    lastProbeId: '',
    probeExpiresAtMs: 0,
    nextProbeAtMs: 0
  });

  let server;
  let attachmentAtFirstSend = null;
  const originalPair = globalThis.WebSocketPair;
  const originalResponse = globalThis.Response;
  class FakeWebSocketPair {
    constructor() {
      let attachment = null;
      this.client = {};
      this.server = server = {
        send() { if (!attachmentAtFirstSend) attachmentAtFirstSend = structuredClone(attachment); },
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
      url: 'https://qa-kvk.invalid/api/ws?room=qa-kvk-initialize'
    });
  } finally {
    globalThis.WebSocketPair = originalPair;
    globalThis.Response = originalResponse;
  }

  assert.ok(server);
  assert.equal(attachmentAtFirstSend.v, 1);
  assert.equal(attachmentAtFirstSend.qa, true);
  assert.equal(attachmentAtFirstSend.view, 'player');
  assert.equal(attachmentAtFirstSend.shadow, false);
  assert.equal(attachmentAtFirstSend.audioArmed, false);
  assert.equal(attachmentAtFirstSend.armedUntilMs, 0);
});

test('every deliveryShadow message is rejected uniformly outside exact QA rooms without private writes', async () => {
  const { Room } = await loadRoom();
  const messages = [
    { t: 'deliveryShadowHello', v: 1, shadow: true, pid: '001', deviceId: DEVICE_ID },
    { t: 'deliveryShadowProbeAck', v: 1, probeId: 'probe', audioArmed: true },
    { t: 'deliveryShadowAck', v: 1, commandId: 'command' },
    { t: 'deliveryShadowUnknown' }
  ];

  for (const roomName of ['operation-room', 'demo', '_', 'qa-kvk-']) {
    const h = createRoomHarness(Room, { roomName: 'qa-kvk-rejection' });
    h.room.roomName = roomName;
    h.room.delivery = { v: 1, roomName: '', commands: [] };
    h.room._deliveryLoaded = true;
    h.room.writeSocketAttachment(h.ws, { roomName, qa: true });
    let attachmentWrites = 0;
    let privateWrites = 0;
    let alarmWrites = 0;
    const serialize = h.ws.serializeAttachment.bind(h.ws);
    h.ws.serializeAttachment = (value) => { attachmentWrites += 1; serialize(value); };
    h.room.persistDelivery = async () => { privateWrites += 1; };
    h.room.scheduleExpiry = async () => { alarmWrites += 1; };

    for (const message of messages) {
      h.sent.length = 0;
      await h.room.webSocketMessage(h.ws, JSON.stringify(message));
      assert.deepEqual(h.sent, [{ t: 'error', error: 'qa_room_required' }], `${roomName}: ${message.t}`);
    }
    assert.equal(attachmentWrites, 0, roomName);
    assert.equal(privateWrites, 0, roomName);
    assert.equal(alarmWrites, 0, roomName);
  }
});

test('hello rejects a claimed identity mismatch and challenges an already Core-bound ready socket', async () => {
  const { Room } = await loadRoom();
  const h = prepareReliableSocket(createRoomHarness(Room, {
    roomName: 'qa-kvk-hello', nowMs: 1_000_000
  }));
  const sideEffects = [];
  h.room.persistDelivery = async () => { sideEffects.push('persistDelivery'); };
  h.room.scheduleExpiry = async () => { sideEffects.push('alarm'); };
  const before = h.room.readReliableAttachment(h.ws);

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deliveryShadowHello', v: 1, shadow: true, view: 'commander',
    pid: 'forged', deviceId: DEVICE_ID
  }));
  assert.deepEqual(h.sent, [{ t: 'error', error: 'core_identity_mismatch' }]);
  assert.deepEqual(h.room.readReliableAttachment(h.ws), before);
  assert.deepEqual(sideEffects, []);

  h.sent.length = 0;
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deliveryShadowHello', v: 1, shadow: true, view: 'commander',
    pid: '001', deviceId: DEVICE_ID
  }));

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].t, 'deliveryShadowProbe');
  assert.equal(h.sent[0].v, 1);
  assert.match(h.sent[0].probeId, /^[0-9a-f-]{36}$/i);
  assert.equal(h.sent[0].sentAtMs, 1_000_000);
  assert.equal(h.sent[0].expiresAtMs, 1_002_000);
  const attachment = h.room.readReliableAttachment(h.ws);
  assert.equal(attachment.roomName, 'qa-kvk-hello');
  assert.equal(attachment.pid, '001');
  assert.equal(attachment.deviceId, DEVICE_ID);
  assert.equal(attachment.soundReady, true);
  assert.equal(attachment.clientBuild, 'classic-2026.07');
  assert.equal(attachment.view, 'commander');
  assert.equal(attachment.shadow, true);
  assert.equal(attachment.audioArmed, false);
  assert.equal(attachment.armedUntilMs, 0);
  assert.equal(attachment.lastProbeId, h.sent[0].probeId);
  assert.equal(attachment.probeExpiresAtMs, 1_002_000);
  assert.equal(attachment.nextProbeAtMs, 1_003_000);
  assert.equal(h.room.delivery.roomName, 'qa-kvk-hello');
  assert.deepEqual(sideEffects, ['persistDelivery', 'alarm']);
});

test('probe ACK ignores wrong and expired challenges and grants exactly one 8000ms lease', async () => {
  const { Room } = await loadRoom();
  let nowMs = 2_000_000;
  const h = prepareReliableSocket(createRoomHarness(Room, {
    roomName: 'qa-kvk-probe', nowMs
  }));
  h.room.nowMs = () => nowMs;
  h.room.persistDelivery = async () => {};
  let alarms = 0;
  h.room.scheduleExpiry = async () => { alarms += 1; };

  const hello = async () => {
    h.sent.length = 0;
    await h.room.webSocketMessage(h.ws, JSON.stringify({
      t: 'deliveryShadowHello', v: 1, shadow: true, view: 'player',
      pid: '001', deviceId: DEVICE_ID
    }));
    return h.sent[0];
  };

  const firstProbe = await hello();
  alarms = 0;
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deliveryShadowProbeAck', v: 1, probeId: 'wrong-probe', audioArmed: true
  }));
  let attachment = h.room.readReliableAttachment(h.ws);
  assert.equal(attachment.audioArmed, false);
  assert.equal(attachment.armedUntilMs, 0);
  assert.equal(attachment.lastProbeId, firstProbe.probeId);
  assert.equal(alarms, 0);

  nowMs = firstProbe.expiresAtMs + 1;
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deliveryShadowProbeAck', v: 1, probeId: firstProbe.probeId, audioArmed: true
  }));
  attachment = h.room.readReliableAttachment(h.ws);
  assert.equal(attachment.audioArmed, false);
  assert.equal(attachment.lastProbeId, firstProbe.probeId);
  assert.equal(alarms, 0);

  const secondProbe = await hello();
  alarms = 0;
  nowMs = secondProbe.expiresAtMs;
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deliveryShadowProbeAck', v: 1, probeId: secondProbe.probeId, audioArmed: true
  }));
  attachment = h.room.readReliableAttachment(h.ws);
  assert.equal(attachment.audioArmed, true);
  assert.equal(attachment.armedUntilMs, nowMs + 8_000);
  assert.equal(attachment.lastProbeId, '');
  assert.equal(attachment.probeExpiresAtMs, 0);
  assert.equal(alarms, 1);

  const thirdProbe = await hello();
  alarms = 0;
  nowMs += 100;
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deliveryShadowProbeAck', v: 1, probeId: thirdProbe.probeId, audioArmed: false
  }));
  attachment = h.room.readReliableAttachment(h.ws);
  assert.equal(attachment.audioArmed, false);
  assert.equal(attachment.armedUntilMs, 0);
  assert.equal(alarms, 1);
});

test('Reliable persistence uses only delivery:v1 and probe send failures stay contained', async () => {
  const { Room } = await loadRoom();
  const h = prepareReliableSocket(createRoomHarness(Room, {
    roomName: 'qa-kvk-persist', nowMs: 3_000_000
  }));
  const puts = [];
  h.room.state.storage = { async put(...args) { puts.push(args); } };
  await h.room.persistDelivery();
  assert.deepEqual(puts, [['delivery:v1', h.room.delivery]]);

  const originalSend = h.ws.send;
  h.ws.send = () => { throw new Error('socket closed'); };
  assert.doesNotThrow(() => h.room.issueDeliveryProbe(
    h.ws, h.room.readReliableAttachment(h.ws), 3_000_000
  ));
  h.ws.send = originalSend;
  const attachment = h.room.readReliableAttachment(h.ws);
  assert.match(attachment.lastProbeId, /^[0-9a-f-]{36}$/i);
  assert.equal(attachment.probeExpiresAtMs, 3_002_000);
  assert.equal(attachment.nextProbeAtMs, 3_003_000);
});

test('QA snapshots expose only aggregate delivery summaries and omit them when empty or non-QA', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-summary', nowMs: 4_000_000 });
  h.room.delivery = {
    v: 1,
    roomName: 'qa-kvk-summary',
    commands: [{
      commandId: 'command-public-id',
      kingdom: 1,
      issuedAtMs: 3_999_000,
      cancelledAtMs: null,
      audiences: [{
        pid: '001', role: 'weak', fireAtMs: 4_010_000,
        audioExpiresAtMs: 4_010_150, marchSeconds: 32, leadSeconds: 10
      }],
      targets: [{
        pid: '001',
        deviceId: DEVICE_ID,
        envelope: {
          t: 'deliveryShadowCommand', commandId: 'command-public-id', pid: '001',
          issuedAtMs: 3_999_000, fireAtMs: 4_010_000, audioExpiresAtMs: 4_010_150
        },
        attempts: 1,
        nextRetryAtMs: 4_000_500,
        classicAck: { result: 'scheduled', futureCueCount: 1, atMs: 4_000_010 },
        candidateAck: { result: 'would_schedule', futureCueCount: 6, atMs: 4_000_020 },
        privateAttachment: {
          audioArmed: true, armedUntilMs: 4_008_000,
          lastProbeId: 'probe-secret', probeExpiresAtMs: 4_002_000
        }
      }]
    }]
  };

  const snapshot = h.room.snapshot();
  assert.deepEqual(snapshot.deliveryShadow, {
    v: 1,
    commands: [{
      commandId: 'command-public-id',
      expectedDevices: 1,
      classicScheduled: 1,
      candidateAcked: 1,
      expired: 0,
      cancelled: false
    }]
  });
  const json = JSON.stringify(snapshot.deliveryShadow);
  for (const secret of [
    '001', DEVICE_ID, 'issuedAtMs', 'atMs', 'privateAttachment', 'audioArmed',
    'armedUntilMs', 'lastProbeId', 'probeExpiresAtMs', 'nextRetryAtMs', 'probe-secret'
  ]) {
    assert.equal(json.includes(secret), false, secret);
  }

  h.room.delivery.commands = [];
  assert.equal(Object.prototype.hasOwnProperty.call(h.room.snapshot(), 'deliveryShadow'), false);
  h.room.delivery.commands = [{
    commandId: 'forged-room-command', kingdom: 1, issuedAtMs: 1,
    cancelledAtMs: null, audiences: [], targets: []
  }];
  h.room.delivery.roomName = 'qa-kvk-summary';
  for (const roomName of ['operation-room', 'demo', '_', 'qa-kvk-']) {
    h.room.roomName = roomName;
    assert.equal(Object.prototype.hasOwnProperty.call(h.room.snapshot(), 'deliveryShadow'), false, roomName);
  }
});

test('constructor migration removes contaminated delivery payloads from the Core room', async () => {
  const { Room } = await loadRoom();
  let initialized;
  const storedRoom = {
    pwHash: null,
    config: { castleName: '', rallyAllies: [], enemyWhales: [] },
    players: {},
    live: { mode: 'idle', commands: { 1: null, 2: null }, staged: { 1: null, 2: null }, sim: null },
    updatedAt: null,
    updatedBy: null,
    delivery: { pid: 'PRIVATE-CONSTRUCTOR-PID', deviceId: DEVICE_ID },
    deliveryShadow: { lastProbeId: 'PRIVATE-CONSTRUCTOR-PROBE' }
  };
  const state = {
    id: { name: 'qa-kvk-contaminated-constructor' },
    storage: {
      async get(key) {
        if (key === 'room') return structuredClone(storedRoom);
        return { v: 1, roomName: 'qa-kvk-contaminated-constructor', commands: [] };
      }
    },
    blockConcurrencyWhile(callback) {
      initialized = callback();
      return initialized;
    }
  };

  const room = new Room(state, { MASTER: 'separate-master-override' });
  await initialized;

  assert.equal(Object.prototype.hasOwnProperty.call(room.room, 'delivery'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(room.room, 'deliveryShadow'), false);
  assert.doesNotMatch(JSON.stringify(room.room), /PRIVATE-CONSTRUCTOR/);
});

test('snapshots scrub contaminated delivery keys in populated QA, empty QA, and non-QA rooms', async () => {
  const { Room } = await loadRoom();
  const cases = [
    { roomName: 'qa-kvk-contaminated-summary', commands: true, aggregate: true },
    { roomName: 'qa-kvk-contaminated-empty', commands: false, aggregate: false },
    { roomName: 'operation-room', commands: true, aggregate: false }
  ];

  for (const item of cases) {
    const h = createRoomHarness(Room, { roomName: 'qa-kvk-contaminated-base', nowMs: 5_000_000 });
    h.room.roomName = item.roomName;
    h.room.room.delivery = { pid: 'PRIVATE-SNAPSHOT-PID', deviceId: DEVICE_ID };
    h.room.room.deliveryShadow = {
      commands: [{ pid: 'PRIVATE-SNAPSHOT-PID', lastProbeId: 'PRIVATE-SNAPSHOT-PROBE' }]
    };
    h.room.delivery = {
      v: 1,
      roomName: item.roomName,
      commands: item.commands ? [{
        commandId: 'bounded-command', kingdom: 1, issuedAtMs: 4_999_000,
        cancelledAtMs: null, audiences: [], targets: []
      }] : []
    };

    const snapshot = h.room.snapshot();
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'delivery'), false, item.roomName);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'deliveryShadow'), item.aggregate, item.roomName);
    if (item.aggregate) {
      assert.deepEqual(snapshot.deliveryShadow, {
        v: 1,
        commands: [{
          commandId: 'bounded-command', expectedDevices: 0, classicScheduled: 0,
          candidateAcked: 0, expired: 0, cancelled: false
        }]
      });
    }
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE-SNAPSHOT/, item.roomName);
    assert.equal(JSON.stringify(snapshot).includes(DEVICE_ID), false, item.roomName);
  }
});

test('a rejected Reliable write leaves hello attachment, model, Core room, identity, and alarm untouched', async () => {
  const { Room } = await loadRoom();
  const h = prepareReliableSocket(createRoomHarness(Room, {
    roomName: 'qa-kvk-persist-failure', nowMs: 6_000_000
  }));
  const beforeAttachment = h.room.readReliableAttachment(h.ws);
  const beforeDelivery = structuredClone(h.room.delivery);
  const beforeRoom = structuredClone(h.room.room);
  let alarms = 0;
  h.room.state.storage = {
    async put(key) {
      assert.equal(key, 'delivery:v1');
      throw new Error('storage unavailable');
    }
  };
  h.room.scheduleExpiry = async () => { alarms += 1; };

  await assert.doesNotReject(h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deliveryShadowHello', v: 1, shadow: true, view: 'commander',
    pid: '001', deviceId: DEVICE_ID
  })));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'delivery_persist_failed' }]);
  assert.deepEqual(h.room.readReliableAttachment(h.ws), beforeAttachment);
  assert.deepEqual(h.room.delivery, beforeDelivery);
  assert.deepEqual(h.room.room, beforeRoom);
  assert.equal(h.room.readSocketAttachment(h.ws).pid, '001');
  assert.equal(h.room.readSocketAttachment(h.ws).deviceId, DEVICE_ID);
  assert.equal(alarms, 0);

  const closed = prepareReliableSocket(createRoomHarness(Room, {
    roomName: 'qa-kvk-persist-closed', nowMs: 6_100_000
  }));
  closed.room.state.storage = { async put() { throw new Error('storage unavailable'); } };
  closed.ws.send = () => { throw new Error('socket closed'); };
  await assert.doesNotReject(closed.room.webSocketMessage(closed.ws, JSON.stringify({
    t: 'deliveryShadowHello', v: 1, shadow: true, view: 'player',
    pid: '001', deviceId: DEVICE_ID
  })));
});

test('hello distinguishes every Core identity failure from malformed shadow protocol', async () => {
  const { Room } = await loadRoom();
  const cases = [
    { name: 'empty pid', message: { pid: '' }, error: 'core_identity_mismatch' },
    { name: 'wrong pid', message: { pid: 'kimchi' }, error: 'core_identity_mismatch' },
    { name: 'wrong device', message: { deviceId: 'wrong-device' }, error: 'core_identity_mismatch' },
    { name: 'sound not ready', ready: false, error: 'core_identity_mismatch' },
    { name: 'wrong version', message: { v: 2 }, error: 'bad_delivery_hello' },
    { name: 'shadow disabled', message: { shadow: false }, error: 'bad_delivery_hello' }
  ];

  for (const item of cases) {
    const h = prepareReliableSocket(createRoomHarness(Room, {
      roomName: 'qa-kvk-invalid-hello', nowMs: 7_000_000
    }));
    if (item.ready === false) h.room.writeSocketAttachment(h.ws, { soundReady: false });
    let persists = 0;
    let alarms = 0;
    h.room.persistDelivery = async () => { persists += 1; };
    h.room.scheduleExpiry = async () => { alarms += 1; };
    const before = h.room.readReliableAttachment(h.ws);
    const message = {
      t: 'deliveryShadowHello', v: 1, shadow: true, view: 'commander',
      pid: '001', deviceId: DEVICE_ID, ...(item.message || {})
    };

    await h.room.webSocketMessage(h.ws, JSON.stringify(message));

    assert.deepEqual(h.sent, [{ t: 'error', error: item.error }], item.name);
    assert.deepEqual(h.room.readReliableAttachment(h.ws), before, item.name);
    assert.equal(persists, 0, item.name);
    assert.equal(alarms, 0, item.name);
  }
});

test('an unsupported deliveryShadow frame in QA gets a bounded error without mutation', async () => {
  const { Room } = await loadRoom();
  const h = prepareReliableSocket(createRoomHarness(Room, {
    roomName: 'qa-kvk-unsupported', nowMs: 8_000_000
  }));
  const beforeAttachment = h.room.readReliableAttachment(h.ws);
  const beforeDelivery = structuredClone(h.room.delivery);
  let persists = 0;
  let alarms = 0;
  h.room.persistDelivery = async () => { persists += 1; };
  h.room.scheduleExpiry = async () => { alarms += 1; };

  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deliveryShadowFutureVersion', v: 99, privateValue: 'must-not-echo'
  }));

  assert.deepEqual(h.sent, [{ t: 'error', error: 'unsupported_delivery_message' }]);
  assert.deepEqual(h.room.readReliableAttachment(h.ws), beforeAttachment);
  assert.deepEqual(h.room.delivery, beforeDelivery);
  assert.equal(persists, 0);
  assert.equal(alarms, 0);
});

test('Fire completes exact Classic order before targeting only selected currently armed shadow devices', async () => {
  const { Room } = await loadRoom();
  const h = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-dispatch-order', nowMs: DISPATCH_NOW_MS
  }));
  const events = [];
  const socket = (options) => reliableSocket(h, {
    ...options,
    onSend(message) {
      if (message.t === 'deliveryShadowCommand') events.push(`candidate:${options.deviceId}`);
    }
  });
  const a1 = socket({ pid: '700001', deviceId: DISPATCH_IDS.a1 });
  const a2 = socket({ pid: '700001', deviceId: DISPATCH_IDS.a2 });
  const b1 = socket({ pid: '700002', deviceId: DISPATCH_IDS.b1 });
  const member = socket({ pid: '700003', deviceId: DISPATCH_IDS.member });
  const commander = socket({ pid: '700003', deviceId: DISPATCH_IDS.commander, view: 'commander' });
  const stale = socket({
    pid: '700001', deviceId: DISPATCH_IDS.stale, armedUntilMs: DISPATCH_NOW_MS
  });
  const unready = socket({
    pid: '700002', deviceId: DISPATCH_IDS.unready, soundReady: false
  });
  const classicOnly = socket({
    pid: '700002', deviceId: DISPATCH_IDS.classicOnly, shadow: false
  });
  h.room.persistAll = async () => { events.push('classic-persist'); };
  h.room.scheduleExpiry = async () => { events.push('alarm'); };
  h.room.broadcast = () => { events.push('classic-broadcast'); };
  h.room.persistDelivery = async () => { events.push('delivery-persist'); };

  await h.room.webSocketMessage(h.ws, JSON.stringify(doubleRallyMessage()));

  assert.deepEqual(events.slice(0, 3), [
    'classic-persist', 'alarm', 'classic-broadcast'
  ]);
  const classicIndex = events.indexOf('classic-broadcast');
  const candidateIndexes = events
    .map((event, index) => event.startsWith('candidate:') ? index : -1)
    .filter(index => index >= 0);
  assert.equal(candidateIndexes.length, 3);
  assert.ok(candidateIndexes.every(index => index > classicIndex), JSON.stringify(events));

  const command = h.room.room.live.commands[1];
  const commands = [a1, a2, b1].flatMap(candidate => candidate.shadowCommands());
  assert.deepEqual(commands, [
    {
      t: 'deliveryShadowCommand', v: 1, shadow: true,
      commandId: command.id, pid: '700001', role: 'weak', kingdom: 1,
      issuedAtMs: DISPATCH_NOW_MS, fireAtMs: 1_010_000,
      audioExpiresAtMs: 1_010_150, marchSeconds: 31, leadSeconds: 10
    },
    {
      t: 'deliveryShadowCommand', v: 1, shadow: true,
      commandId: command.id, pid: '700001', role: 'weak', kingdom: 1,
      issuedAtMs: DISPATCH_NOW_MS, fireAtMs: 1_010_000,
      audioExpiresAtMs: 1_010_150, marchSeconds: 31, leadSeconds: 10
    },
    {
      t: 'deliveryShadowCommand', v: 1, shadow: true,
      commandId: command.id, pid: '700002', role: 'main', kingdom: 1,
      issuedAtMs: DISPATCH_NOW_MS, fireAtMs: 1_012_000,
      audioExpiresAtMs: 1_012_150, marchSeconds: 30, leadSeconds: 10
    }
  ]);
  assert.equal(commands.some(message => Object.prototype.hasOwnProperty.call(message, 'deviceId')), false);
  for (const silent of [member, commander, stale, unready, classicOnly]) {
    assert.deepEqual(silent.shadowCommands(), []);
  }
  assert.deepEqual(h.room.delivery.commands[0].targets.map(target => target.deviceId), [
    DISPATCH_IDS.a1, DISPATCH_IDS.a2, DISPATCH_IDS.b1
  ]);
});

test('dispatch retries byte-identical envelopes only while the exact socket lease remains current', async () => {
  const { Room } = await loadRoom();
  const h = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-dispatch-bytes', nowMs: DISPATCH_NOW_MS
  }));
  const a1 = reliableSocket(h, {
    pid: '700001', deviceId: DISPATCH_IDS.a1,
    armedUntilMs: DISPATCH_NOW_MS + 1_500
  });
  const a2 = reliableSocket(h, {
    pid: '700001', deviceId: DISPATCH_IDS.a2,
    armedUntilMs: DISPATCH_NOW_MS + 20_000
  });
  h.room.persistDelivery = async () => {};
  h.room.scheduleExpiry = async () => {};

  await h.room.dispatchDeliveryForCommand(
    canonicalDoubleRally('command-byte-stable'), DISPATCH_NOW_MS
  );
  const firstBytes = a1.raw.find(message => JSON.parse(message).t === 'deliveryShadowCommand');
  assert.ok(firstBytes);
  const secondDeviceFirstBytes = a2.raw.find(
    message => JSON.parse(message).t === 'deliveryShadowCommand'
  );
  assert.equal(secondDeviceFirstBytes, firstBytes);

  h.room.writeSocketAttachment(a2.ws, { soundReady: false });
  assert.equal(h.room.flushDeliveryTargets(DISPATCH_NOW_MS + 500), true);
  const deliveryBytes = a1.raw.filter(message => JSON.parse(message).t === 'deliveryShadowCommand');
  assert.deepEqual(deliveryBytes, [firstBytes, firstBytes]);
  assert.deepEqual(
    a2.raw.filter(message => JSON.parse(message).t === 'deliveryShadowCommand'),
    [firstBytes],
    'the send path rechecks current Core soundReady on every retry'
  );

  h.room.writeReliableAttachment(a1.ws, {
    audioArmed: true, armedUntilMs: DISPATCH_NOW_MS + 1_500
  });
  assert.equal(h.room.flushDeliveryTargets(DISPATCH_NOW_MS + 1_500), true);
  assert.deepEqual(
    a1.raw.filter(message => JSON.parse(message).t === 'deliveryShadowCommand'),
    [firstBytes, firstBytes],
    'the send path rechecks armedUntilMs instead of trusting the earlier target admission'
  );
  assert.deepEqual(
    a2.raw.filter(message => JSON.parse(message).t === 'deliveryShadowCommand'),
    [firstBytes]
  );
});

test('an exact armed probe ACK activates every still-actionable pending record but hello activates none', async () => {
  const { Room } = await loadRoom();
  const h = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-probe-activation', nowMs: DISPATCH_NOW_MS
  }));
  let events = [];
  const player = reliableSocket(h, {
    pid: '700001', deviceId: DISPATCH_IDS.a1,
    shadow: false, audioArmed: false, armedUntilMs: 0,
    onSend(message) {
      if (message.t === 'deliveryShadowCommand') events.push(`candidate:${message.commandId}`);
    }
  });
  h.room.persistDelivery = async () => { events.push('delivery-persist'); };
  h.room.broadcast = () => { events.push('aggregate-broadcast'); };
  h.room.scheduleExpiry = async () => { events.push('alarm'); };

  const first = canonicalDoubleRally('pending-first');
  const second = canonicalDoubleRally('pending-second');
  second.payload.pairs[0].pressUTC = 1013;
  second.payload.pairs[1].pressUTC = 1014;
  const expired = canonicalDoubleRally('pending-expired');
  expired.payload.pairs[0].pressUTC = 999;
  expired.payload.pairs[1].pressUTC = 999;
  await h.room.dispatchDeliveryForCommand(first, DISPATCH_NOW_MS);
  await h.room.dispatchDeliveryForCommand(second, DISPATCH_NOW_MS);
  await h.room.dispatchDeliveryForCommand(expired, DISPATCH_NOW_MS);
  assert.deepEqual(h.room.delivery.commands.map(record => record.targets.length), [0, 0, 0]);

  events = [];
  player.raw.length = 0;
  await h.room.webSocketMessage(player.ws, JSON.stringify({
    t: 'deliveryShadowHello', v: 1, shadow: true, view: 'player',
    pid: '700001', deviceId: DISPATCH_IDS.a1
  }));
  const probe = player.messages().find(message => message.t === 'deliveryShadowProbe');
  assert.ok(probe);
  assert.deepEqual(h.room.delivery.commands.map(record => record.targets.length), [0, 0, 0]);
  assert.deepEqual(events, ['delivery-persist', 'alarm']);

  events = [];
  player.raw.length = 0;
  await h.room.webSocketMessage(player.ws, JSON.stringify({
    t: 'deliveryShadowProbeAck', v: 1,
    probeId: probe.probeId, audioArmed: true
  }));

  assert.deepEqual(h.room.delivery.commands.map(record => record.targets.length), [1, 1, 0]);
  assert.deepEqual(player.shadowCommands().map(message => message.commandId), [
    'pending-first', 'pending-second'
  ]);
  assert.equal(h.room.readReliableAttachment(player.ws).armedUntilMs, DISPATCH_NOW_MS + 8_000);
  assert.deepEqual(events, [
    'candidate:pending-first', 'candidate:pending-second',
    'delivery-persist', 'aggregate-broadcast', 'alarm'
  ]);
});

test('candidate ACK identity comes from its attached target and publishes only after private persistence', async () => {
  const { Room } = await loadRoom();
  const h = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-candidate-identity', nowMs: DISPATCH_NOW_MS
  }));
  const a1 = reliableSocket(h, { pid: '700001', deviceId: DISPATCH_IDS.a1 });
  const a2 = reliableSocket(h, { pid: '700001', deviceId: DISPATCH_IDS.a2 });
  h.room.persistDelivery = async () => {};
  h.room.scheduleExpiry = async () => {};
  await h.room.dispatchDeliveryForCommand(
    canonicalDoubleRally('candidate-identity'), DISPATCH_NOW_MS
  );
  a1.raw.length = 0;
  a2.raw.length = 0;
  const events = [];
  h.room.persistDelivery = async () => { events.push('delivery-persist'); };
  h.room.broadcast = () => { events.push('aggregate-broadcast'); };
  h.room.scheduleExpiry = async () => { events.push('alarm'); };

  await h.room.webSocketMessage(a2.ws, JSON.stringify({
    t: 'deliveryShadowAck', v: 1, commandId: 'candidate-identity',
    result: 'would_schedule', futureCueCount: 6.5
  }));
  assert.deepEqual(events, [], 'a fractional cue count is not an exact candidate ACK');

  await h.room.webSocketMessage(a2.ws, JSON.stringify({
    t: 'deliveryShadowAck', v: 1, commandId: 'candidate-identity',
    result: 'would_schedule', futureCueCount: 6
  }));

  const targets = h.room.delivery.commands[0].targets;
  assert.equal(targets.find(target => target.deviceId === DISPATCH_IDS.a1).candidateAck, null);
  assert.deepEqual(targets.find(target => target.deviceId === DISPATCH_IDS.a2).candidateAck, {
    result: 'would_schedule', futureCueCount: 6, atMs: DISPATCH_NOW_MS
  });
  assert.deepEqual(events, ['delivery-persist', 'aggregate-broadcast', 'alarm']);
  assert.deepEqual(h.room.snapshot().deliveryShadow.commands[0], {
    commandId: 'candidate-identity', expectedDevices: 2,
    classicScheduled: 0, candidateAcked: 1, expired: 0, cancelled: false
  });
  assert.doesNotMatch(JSON.stringify(h.room.delivery), /forged/);
});

test('candidate ACK persistence failure rolls back its fact and never exposes an unpersisted aggregate', async () => {
  const { Room } = await loadRoom();
  const h = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-candidate-rollback', nowMs: DISPATCH_NOW_MS
  }));
  const a1 = reliableSocket(h, { pid: '700001', deviceId: DISPATCH_IDS.a1 });
  h.room.persistDelivery = async () => {};
  h.room.scheduleExpiry = async () => {};
  await h.room.dispatchDeliveryForCommand(
    canonicalDoubleRally('candidate-rollback'), DISPATCH_NOW_MS
  );
  a1.raw.length = 0;
  const beforeDelivery = structuredClone(h.room.delivery);
  const beforeAggregate = structuredClone(h.room.snapshot().deliveryShadow);
  const beforeCoreRoom = structuredClone(h.room.room);
  let broadcasts = 0;
  let alarms = 0;
  h.room.persistDelivery = async () => { throw new Error('private storage unavailable'); };
  h.room.broadcast = () => { broadcasts += 1; };
  h.room.scheduleExpiry = async () => { alarms += 1; };

  await assert.doesNotReject(h.room.webSocketMessage(a1.ws, JSON.stringify({
    t: 'deliveryShadowAck', v: 1, commandId: 'candidate-rollback',
    result: 'expired', futureCueCount: 0
  })));

  assert.deepEqual(a1.messages(), [{ t: 'error', error: 'delivery_persist_failed' }]);
  assert.deepEqual(h.room.delivery, beforeDelivery);
  assert.deepEqual(h.room.snapshot().deliveryShadow, beforeAggregate);
  assert.deepEqual(h.room.room, beforeCoreRoom);
  assert.equal(broadcasts, 0);
  assert.equal(alarms, 0);
});

test('Core saved confirmation precedes canonical mirror and an idempotent retry recovers a failed private write', async () => {
  const { Room } = await loadRoom();
  const h = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-classic-mirror', nowMs: DISPATCH_NOW_MS
  }));
  let events = [];
  const player = reliableSocket(h, {
    pid: '700001', deviceId: DISPATCH_IDS.canonical,
    onSend(message) {
      if (message.t === 'deliveryAckSaved') events.push('core-saved');
    }
  });
  const command = canonicalDoubleRally('canonical-mirror');
  command.delivery = [
    { pid: '700001', expected: 1, received: 0, expired: 0 },
    { pid: '700002', expected: 0, received: 0, expired: 0 }
  ];
  h.room.persistDelivery = async () => {};
  h.room.scheduleExpiry = async () => {};
  await h.room.dispatchDeliveryForCommand(command, DISPATCH_NOW_MS);
  h.room.room.live.commands[1] = command;
  h.room.room.live.mode = 'live';
  h.room.devices = [{
    pid: '700001', deviceId: DISPATCH_IDS.canonical,
    soundReady: true, lastSeenMs: DISPATCH_NOW_MS
  }];
  player.raw.length = 0;

  let reliablePersists = 0;
  h.room.persistAll = async () => { events.push('core-persist'); };
  h.room.persistDelivery = async () => {
    events.push('reliable-persist');
    reliablePersists += 1;
    if (reliablePersists === 1) throw new Error('private delivery unavailable');
  };
  h.room.broadcast = () => { events.push('broadcast'); };
  h.room.scheduleExpiry = async () => { events.push('alarm'); };
  const rawAck = {
    t: 'deliveryAck', commandId: command.id,
    pid: ' 700001 ', deviceId: DISPATCH_IDS.canonical.toUpperCase(),
    outcome: 'scheduled', targetUTC: 1010, scheduledAtMs: DISPATCH_NOW_MS + 100
  };

  await assert.doesNotReject(h.room.webSocketMessage(player.ws, JSON.stringify(rawAck)));

  assert.deepEqual(events, [
    'core-persist', 'broadcast', 'core-saved', 'reliable-persist'
  ]);
  assert.deepEqual(player.messages(), [{
    t: 'deliveryAckSaved', commandId: command.id,
    pid: '700001', deviceId: DISPATCH_IDS.canonical,
    outcome: 'scheduled', targetUTC: 1010, scheduledAtMs: DISPATCH_NOW_MS + 100
  }]);
  assert.equal(command.delivery[0].received, 1);
  assert.equal(h.room.deliveryAcks.length, 1);
  assert.equal(h.room.delivery.commands[0].targets[0].classicAck, null);
  assert.equal(h.room.snapshot().deliveryShadow.commands[0].classicScheduled, 0);

  events = [];
  await assert.doesNotReject(h.room.webSocketMessage(player.ws, JSON.stringify(rawAck)));

  assert.deepEqual(events, [
    'core-saved', 'reliable-persist', 'broadcast', 'alarm'
  ]);
  assert.equal(command.delivery[0].received, 1, 'the Core idempotent ACK stays counted once');
  assert.deepEqual(h.room.delivery.commands[0].targets[0].classicAck, {
    result: 'scheduled', futureCueCount: 1, atMs: DISPATCH_NOW_MS
  });
  assert.equal(h.room.snapshot().deliveryShadow.commands[0].classicScheduled, 1);
  assert.deepEqual(player.messages().filter(message => message.t === 'deliveryAckSaved'), [
    {
      t: 'deliveryAckSaved', commandId: command.id,
      pid: '700001', deviceId: DISPATCH_IDS.canonical,
      outcome: 'scheduled', targetUTC: 1010, scheduledAtMs: DISPATCH_NOW_MS + 100
    },
    {
      t: 'deliveryAckSaved', commandId: command.id,
      pid: '700001', deviceId: DISPATCH_IDS.canonical,
      outcome: 'scheduled', targetUTC: 1010, scheduledAtMs: DISPATCH_NOW_MS + 100
    }
  ]);
});

test('dispatch persistence failure leaves the already persisted and broadcast Core command intact while rolling private state back', async () => {
  const { Room } = await loadRoom();
  const h = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-dispatch-rollback', nowMs: DISPATCH_NOW_MS
  }));
  const events = [];
  reliableSocket(h, {
    pid: '700001', deviceId: DISPATCH_IDS.a1,
    onSend(message) {
      if (message.t === 'deliveryShadowCommand') events.push('candidate-send');
    }
  });
  const beforeDelivery = structuredClone(h.room.delivery);
  h.room.persistAll = async () => { events.push('classic-persist'); };
  h.room.scheduleExpiry = async () => { events.push('alarm'); };
  h.room.broadcast = () => { events.push('classic-broadcast'); };
  h.room.persistDelivery = async () => {
    events.push('delivery-persist');
    throw new Error('delivery storage unavailable');
  };

  await assert.doesNotReject(
    h.room.webSocketMessage(h.ws, JSON.stringify(doubleRallyMessage()))
  );

  assert.deepEqual(events, [
    'classic-persist', 'alarm', 'classic-broadcast',
    'candidate-send', 'delivery-persist'
  ]);
  assert.equal(h.room.room.live.commands[1].type, 'double_rally');
  assert.equal(h.room.room.live.mode, 'live');
  assert.deepEqual(h.room.delivery, beforeDelivery);
  assert.equal(Object.prototype.hasOwnProperty.call(h.room.snapshot(), 'deliveryShadow'), false);
});

test('dispatch derives QA only from the Core-bound room and rebinds contaminated private room state', async () => {
  const { Room } = await loadRoom();
  const qa = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-core-bound-dispatch', nowMs: DISPATCH_NOW_MS
  }));
  reliableSocket(qa, { pid: '700001', deviceId: DISPATCH_IDS.a1 });
  qa.room.delivery.roomName = 'operation-room';
  qa.room.persistDelivery = async () => {};
  qa.room.scheduleExpiry = async () => {};

  assert.equal(await qa.room.dispatchDeliveryForCommand(
    canonicalDoubleRally('core-bound-qa'), DISPATCH_NOW_MS
  ), true);
  assert.equal(qa.room.delivery.roomName, qa.roomName);
  assert.equal(qa.room.delivery.commands[0].targets.length, 1);

  const operation = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-operation-fixture', nowMs: DISPATCH_NOW_MS
  }));
  reliableSocket(operation, { pid: '700001', deviceId: DISPATCH_IDS.a1 });
  operation.room.roomName = 'operation-room';
  operation.room.delivery.roomName = 'qa-kvk-forged-private-state';
  let privateWrites = 0;
  operation.room.persistDelivery = async () => { privateWrites += 1; };
  operation.room.scheduleExpiry = async () => {};

  assert.equal(await operation.room.dispatchDeliveryForCommand(
    canonicalDoubleRally('forged-private-qa'), DISPATCH_NOW_MS
  ), false);
  assert.deepEqual(operation.room.delivery.commands, []);
  assert.equal(privateWrites, 0);
});

test('probe activation persistence failure rolls pending targets back before any aggregate broadcast', async () => {
  const { Room } = await loadRoom();
  const h = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-probe-rollback', nowMs: DISPATCH_NOW_MS
  }));
  const player = reliableSocket(h, {
    pid: '700001', deviceId: DISPATCH_IDS.a1,
    shadow: false, audioArmed: false, armedUntilMs: 0
  });
  h.room.persistDelivery = async () => {};
  h.room.scheduleExpiry = async () => {};
  await h.room.dispatchDeliveryForCommand(
    canonicalDoubleRally('probe-rollback'), DISPATCH_NOW_MS
  );
  await h.room.webSocketMessage(player.ws, JSON.stringify({
    t: 'deliveryShadowHello', v: 1, shadow: true, view: 'player',
    pid: '700001', deviceId: DISPATCH_IDS.a1
  }));
  const probe = player.messages().find(message => message.t === 'deliveryShadowProbe');
  assert.ok(probe);
  player.raw.length = 0;
  const beforeDelivery = structuredClone(h.room.delivery);
  const beforeAggregate = structuredClone(h.room.snapshot().deliveryShadow);
  let broadcasts = 0;
  let alarms = 0;
  h.room.persistDelivery = async () => { throw new Error('private storage unavailable'); };
  h.room.broadcast = () => { broadcasts += 1; };
  h.room.scheduleExpiry = async () => { alarms += 1; };

  await assert.doesNotReject(h.room.webSocketMessage(player.ws, JSON.stringify({
    t: 'deliveryShadowProbeAck', v: 1,
    probeId: probe.probeId, audioArmed: true
  })));

  assert.equal(player.messages().at(-1).error, 'delivery_persist_failed');
  assert.deepEqual(h.room.delivery, beforeDelivery);
  assert.deepEqual(h.room.snapshot().deliveryShadow, beforeAggregate);
  assert.equal(broadcasts, 0);
  assert.equal(alarms, 0);
});

test('Core rejection paths never reach the Reliable mirror', async () => {
  const { Room } = await loadRoom();
  const h = installDispatchRoom(createRoomHarness(Room, {
    roomName: 'qa-kvk-mirror-rejections', nowMs: DISPATCH_NOW_MS
  }));
  const player = reliableSocket(h, {
    pid: '700001', deviceId: DISPATCH_IDS.a1
  });
  const command = canonicalDoubleRally('mirror-rejections');
  command.delivery = [
    { pid: '700001', expected: 1, received: 0, expired: 0 },
    { pid: '700002', expected: 0, received: 0, expired: 0 }
  ];
  h.room.persistDelivery = async () => {};
  h.room.scheduleExpiry = async () => {};
  await h.room.dispatchDeliveryForCommand(command, DISPATCH_NOW_MS);
  h.room.room.live.commands[1] = command;
  h.room.room.live.mode = 'live';
  const registry = {
    pid: '700001', deviceId: DISPATCH_IDS.a1,
    soundReady: true, lastSeenMs: DISPATCH_NOW_MS
  };
  h.room.devices = [registry];
  player.raw.length = 0;
  let privateWrites = 0;
  h.room.persistDelivery = async () => { privateWrites += 1; };
  h.room.broadcast = () => {};
  h.room.scheduleExpiry = async () => {};
  h.room.persistAll = async () => {};
  const ack = {
    t: 'deliveryAck', commandId: command.id,
    pid: '700001', deviceId: DISPATCH_IDS.a1,
    outcome: 'scheduled', targetUTC: 1010,
    scheduledAtMs: DISPATCH_NOW_MS + 100
  };

  await h.room.webSocketMessage(player.ws, JSON.stringify({ ...ack, outcome: 'invalid' }));
  await h.room.webSocketMessage(player.ws, JSON.stringify({
    ...ack, pid: '700002', targetUTC: 1011
  }));
  h.room.devices = [];
  await h.room.webSocketMessage(player.ws, JSON.stringify(ack));
  h.room.devices = [registry];
  h.room.persistAll = async () => { throw new Error('Core storage unavailable'); };
  await h.room.webSocketMessage(player.ws, JSON.stringify(ack));

  assert.equal(privateWrites, 0);
  assert.equal(command.delivery[0].received, 0);
  assert.equal(h.room.deliveryAcks.length, 0);
  assert.equal(h.room.delivery.commands[0].targets[0].classicAck, null);
  assert.deepEqual(player.messages().map(message => message.error), [
    'invalid_ack', 'bad_delivery_identity', 'bad_delivery_identity', 'delivery_persist_failed'
  ]);

  h.room.persistAll = async () => {};
  await h.room.webSocketMessage(player.ws, JSON.stringify(ack));
  assert.equal(privateWrites, 1);
  await h.room.webSocketMessage(player.ws, JSON.stringify({
    ...ack, scheduledAtMs: ack.scheduledAtMs + 1
  }));
  assert.equal(privateWrites, 1, 'a Core ack_conflict cannot write a second comparison fact');
  assert.equal(player.messages().at(-1).error, 'ack_conflict');
});
