const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness } = require('./room-harness.cjs');

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';

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
