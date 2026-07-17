const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness } = require('./room-harness.cjs');

const IDS = {
  a: '00000000-0000-4000-8000-000000000301'
};

function socketFor(room, roomName) {
  const sent = [];
  let attachment = null;
  let accepted = false;
  const accept = room.state.acceptWebSocket.bind(room.state);
  const ws = {
    send(raw) { sent.push(JSON.parse(raw)); },
    close() { this.closed = true; },
    serializeAttachment(value) {
      if (!accepted) throw new Error('serializeAttachment requires an accepted WebSocket');
      attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return attachment == null ? null : structuredClone(attachment);
    }
  };
  room.state.acceptWebSocket = socket => {
    if (socket === ws) accepted = true;
    return accept(socket);
  };
  try { room.attachSocket(ws, roomName); } finally { room.state.acceptWebSocket = accept; }
  return { ws, sent, attachment: () => ws.deserializeAttachment() };
}

function storageMetrics() {
  const metrics = {
    rows: 0,
    writes: [],
    setAlarms: 0,
    deleteAlarms: 0,
    broadcasts: 0,
    failWrites: false
  };
  const storage = {
    async get(keys) {
      if (!Array.isArray(keys)) return undefined;
      return new Map(keys.map(key => [key, key === 'profileOwners' ? {} : []]));
    },
    async put(keyOrEntries, value) {
      if (metrics.failWrites) throw new Error('storage unavailable');
      if (typeof keyOrEntries === 'string') {
        metrics.rows += 1;
        metrics.writes.push([keyOrEntries, structuredClone(value)]);
        return;
      }
      const entries = Object.entries(keyOrEntries || {});
      metrics.rows += entries.length;
      metrics.writes.push(...entries.map(([key, entry]) => [key, structuredClone(entry)]));
    },
    async setAlarm() { metrics.setAlarms += 1; },
    async deleteAlarm() { metrics.deleteAlarms += 1; }
  };
  metrics.reset = () => {
    metrics.rows = 0;
    metrics.writes.length = 0;
    metrics.setAlarms = 0;
    metrics.deleteAlarms = 0;
    metrics.broadcasts = 0;
  };
  return { metrics, storage };
}

async function budgetHarness(options = {}) {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    roomName: options.roomName || 'qa-kvk-write-budget',
    nowMs: Number.isFinite(options.nowMs) ? options.nowMs : 10_000_000
  });
  const observed = storageMetrics();
  h.room.state.storage = observed.storage;
  h.room._deliveryLoaded = true;
  h.room.profileOwners = {};
  h.room.persistAll = Room.prototype.persistAll.bind(h.room);
  h.room.persistDevices = Room.prototype.persistDevices.bind(h.room);
  h.room.broadcast = () => { observed.metrics.broadcasts += 1; };
  h.room.scheduleExpiry = async () => { observed.metrics.setAlarms += 1; };
  return { Room, h, ...observed };
}

async function send(room, ws, message) {
  await room.webSocketMessage(ws, JSON.stringify(message));
}

test('a real readiness transition writes only devices and duplicate statuses only ACK', async () => {
  const { h, metrics } = await budgetHarness();
  const player = socketFor(h.room, h.roomName);
  const status = { t: 'deviceStatus', pid: '001', deviceId: IDS.a, soundReady: true };

  await send(h.room, player.ws, status);

  assert.equal(metrics.rows, 1);
  assert.deepEqual(metrics.writes.map(([key]) => key), ['devices']);
  assert.equal(metrics.broadcasts, 1);
  assert.equal(metrics.setAlarms, 0);
  assert.deepEqual(player.sent, [{
    t: 'deviceStatusSaved', pid: '001', deviceId: IDS.a, soundReady: true
  }]);

  metrics.reset();
  player.sent.length = 0;
  for (let index = 0; index < 100; index += 1) await send(h.room, player.ws, status);

  assert.equal(metrics.rows, 0);
  assert.equal(metrics.broadcasts, 0);
  assert.equal(metrics.setAlarms, 0);
  assert.equal(player.sent.length, 100);
  assert.ok(player.sent.every(message => message.t === 'deviceStatusSaved'));
});

test('first binding after reload broadcasts canonical readiness without rewriting it', async () => {
  const { h, metrics } = await budgetHarness();
  h.room.devices = [{
    pid: '001', deviceId: IDS.a, soundReady: true, lastSeenMs: h.nowMs
  }];
  const player = socketFor(h.room, h.roomName);
  const status = { t: 'deviceStatus', pid: '001', deviceId: IDS.a, soundReady: true };

  await send(h.room, player.ws, status);

  assert.equal(metrics.rows, 0);
  assert.equal(metrics.broadcasts, 1);
  assert.deepEqual(player.sent, [{
    t: 'deviceStatusSaved', pid: '001', deviceId: IDS.a, soundReady: true
  }]);

  metrics.reset();
  player.sent.length = 0;
  await send(h.room, player.ws, status);

  assert.equal(metrics.rows, 0);
  assert.equal(metrics.broadcasts, 0);
  assert.equal(player.sent.length, 1);
  assert.equal(player.sent[0].t, 'deviceStatusSaved');
});

test('readiness edges persist once while duplicate false is a storage no-op', async () => {
  const { h, metrics } = await budgetHarness();
  const player = socketFor(h.room, h.roomName);
  const status = soundReady => ({
    t: 'deviceStatus', pid: '001', deviceId: IDS.a, soundReady
  });

  await send(h.room, player.ws, status(true));
  metrics.reset();
  player.sent.length = 0;

  await send(h.room, player.ws, status(false));
  await send(h.room, player.ws, status(false));
  await send(h.room, player.ws, status(true));

  assert.equal(metrics.rows, 2);
  assert.deepEqual(metrics.writes.map(([key]) => key), ['devices', 'devices']);
  assert.equal(metrics.broadcasts, 2);
  assert.equal(metrics.setAlarms, 0);
  assert.deepEqual(player.sent.map(message => message.soundReady), [false, false, true]);
});

test('a failed readiness write rolls back only durable registry and keeps the live socket fail-closed', async () => {
  const { h, metrics } = await budgetHarness();
  const player = socketFor(h.room, h.roomName);
  await send(h.room, player.ws, {
    t: 'deviceStatus', pid: '001', deviceId: IDS.a, soundReady: true
  });
  const devicesBefore = structuredClone(h.room.devices);
  h.room.room.live.commands[1] = {
    id: 'failed-readiness-command', type: 'double_rally', kingdom: 1,
    payload: {
      pairs: [
        { pid: '001', role: 'weak', pressUTC: 10_010 },
        { pid: 'kimchi', role: 'main', pressUTC: 10_010 }
      ]
    },
    delivery: [
      { pid: '001', expected: 1, received: 0, expired: 0 },
      { pid: 'kimchi', expected: 0, received: 0, expired: 0 }
    ]
  };
  player.sent.length = 0;
  metrics.failWrites = true;

  await assert.doesNotReject(send(h.room, player.ws, {
    t: 'deviceStatus', pid: '001', deviceId: IDS.a, soundReady: false
  }));

  assert.deepEqual(player.attachment(), {
    roomName: h.roomName, surface: 'rally', pid: '001', deviceId: IDS.a,
    soundReady: false, lastSeenMs: h.nowMs
  }, 'identity stays bound but readiness fails closed');
  assert.deepEqual(h.room.devices, devicesBefore);
  assert.deepEqual(player.sent, [{
    t: 'error', source: 'deviceStatus', error: 'device_status_persist_failed'
  }]);

  player.sent.length = 0;
  await send(h.room, player.ws, {
    t: 'deliveryAck', commandId: 'failed-readiness-command',
    pid: '001', deviceId: IDS.a, outcome: 'scheduled',
    targetUTC: 10_010, scheduledAtMs: h.nowMs
  });
  assert.equal(h.room.room.live.commands[1].delivery[0].received, 0);
  assert.equal(player.sent.at(-1).error, 'bad_delivery_identity',
    'a fresh ACK cannot pass through a readiness write failure');
});

test('one hundred initialized sockets produce zero canonical rows across heartbeat rounds', async () => {
  const { h, metrics } = await budgetHarness();
  const players = [];
  for (let index = 1; index <= 100; index += 1) {
    const player = socketFor(h.room, h.roomName);
    const deviceId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await send(h.room, player.ws, {
      t: 'deviceStatus', pid: '001', deviceId, soundReady: true
    });
    players.push({ player, deviceId });
  }
  metrics.reset();

  for (let round = 0; round < 4; round += 1) {
    h.room._lastHbCast = undefined;
    for (const { player, deviceId } of players) {
      await send(h.room, player.ws, {
        t: 'hb', pid: '001', deviceId, soundReady: true
      });
    }
  }

  assert.equal(metrics.rows, 0);
  assert.equal(metrics.setAlarms, 0);
  assert.equal(metrics.broadcasts, 0);
});

test('one hundred live bindings stay zero-write after the canonical 70s TTL', async () => {
  let nowMs = 40_000_000;
  const { h, metrics } = await budgetHarness({ nowMs });
  h.room.nowMs = () => nowMs;
  const players = [];
  for (let index = 1; index <= 100; index += 1) {
    const player = socketFor(h.room, h.roomName);
    const deviceId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await send(h.room, player.ws, {
      t: 'deviceStatus', pid: '001', deviceId, soundReady: true
    });
    players.push({ player, deviceId });
  }
  metrics.reset();
  nowMs += 70_001;

  for (const { player, deviceId } of players) {
    await send(h.room, player.ws, {
      t: 'hb', pid: '001', deviceId, soundReady: true
    });
  }

  assert.equal(metrics.rows, 0, 'TTL aging alone never refreshes canonical device rows');
  assert.equal(metrics.broadcasts, 0);
  assert.equal(metrics.setAlarms, 0);
});

test('heartbeat persists a real readiness edge once and leaves its duplicate transient', async () => {
  const { h, metrics } = await budgetHarness();
  const player = socketFor(h.room, h.roomName);
  await send(h.room, player.ws, {
    t: 'deviceStatus', pid: '001', deviceId: IDS.a, soundReady: true
  });
  metrics.reset();

  await send(h.room, player.ws, {
    t: 'hb', pid: '001', deviceId: IDS.a, soundReady: false
  });
  await send(h.room, player.ws, {
    t: 'hb', pid: '001', deviceId: IDS.a, soundReady: false
  });

  assert.equal(metrics.rows, 1);
  assert.deepEqual(metrics.writes.map(([key]) => key), ['devices']);
  assert.equal(metrics.broadcasts, 1);
  assert.equal(metrics.setAlarms, 0);
});

test('snapshot and Fire derive live presence/readiness from socket attachments', async () => {
  const { h, metrics } = await budgetHarness({ nowMs: 20_000_000 });
  const player = socketFor(h.room, h.roomName);
  await send(h.room, player.ws, {
    t: 'hb', pid: '001', deviceId: IDS.a, soundReady: true
  });
  h.room.devices = [];
  h.room.room.players['001'].lastSeen = '2000-01-01T00:00:00.000Z';
  metrics.reset();

  const snapshot = h.room.snapshot();
  assert.equal(snapshot.players['001'].lastSeen, new Date(h.nowMs).toISOString());
  assert.equal(h.room.room.players['001'].lastSeen, '2000-01-01T00:00:00.000Z');

  await send(h.room, h.ws, {
    t: 'cmd', password: 'separate-master-override', cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 20_010,
      payload: {
        firstPress: 20_010, leadSeconds: 10,
        pairs: [
          { pid: '001', role: 'weak', pressUTC: 20_010 },
          { pid: 'kimchi', role: 'main', pressUTC: 20_010 }
        ]
      }
    }
  });

  assert.deepEqual(h.room.room.live.commands[1].delivery, [
    { pid: '001', expected: 1, received: 0, expired: 0 },
    { pid: 'kimchi', expected: 0, received: 0, expired: 0 }
  ]);
});

test('a closed ready socket is never counted by Fire after stale canonical reload', async () => {
  const { h } = await budgetHarness({ nowMs: 25_000_000 });
  const getSockets = h.room.state.getWebSockets.bind(h.room.state);
  h.room.state.getWebSockets = () => getSockets().filter(socket => !socket.closed);
  const player = socketFor(h.room, h.roomName);
  await send(h.room, player.ws, {
    t: 'deviceStatus', pid: '001', deviceId: IDS.a, soundReady: true
  });
  const staleCanonical = structuredClone(h.room.devices);

  await h.room.webSocketClose(player.ws);
  h.room.devices = staleCanonical;
  await send(h.room, h.ws, {
    t: 'cmd', password: 'separate-master-override', cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 25_010,
      payload: {
        firstPress: 25_010, leadSeconds: 10,
        pairs: [
          { pid: '001', role: 'weak', pressUTC: 25_010 },
          { pid: 'kimchi', role: 'main', pressUTC: 25_010 }
        ]
      }
    }
  });

  assert.deepEqual(h.room.room.live.commands[1].delivery, [
    { pid: '001', expected: 0, received: 0, expired: 0 },
    { pid: 'kimchi', expected: 0, received: 0, expired: 0 }
  ]);
});

test('idle QA readiness does not maintain a recurring probe alarm', async () => {
  const { Room, h, metrics } = await budgetHarness({ nowMs: 30_000_000 });
  h.room.delivery = { v: 1, roomName: h.roomName, commands: [] };
  h.room.writeReliableAttachment(h.ws, {
    shadow: true,
    audioArmed: true,
    armedUntilMs: h.nowMs + 60_000,
    nextProbeAtMs: h.nowMs + 3_000
  });
  h.room.scheduleExpiry = Room.prototype.scheduleExpiry.bind(h.room);
  metrics.reset();

  await h.room.scheduleExpiry();

  assert.equal(metrics.setAlarms, 0);
  assert.equal(metrics.deleteAlarms, 1);
});

test('one hundred idle Defense defenders plus managers and Rally observers stay write and broadcast free', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    roomName: 'qa', surface: 'defense', players: {}, nowMs: 50_000_000
  });
  await send(h.room, h.ws, { t: 'hello' });
  h.room.defense.players = {};
  h.room.defense.rosterRevision = 100;
  h.room.defense.profileGenerationCounter = 100;

  const defenders = [];
  for (let index = 0; index < 100; index += 1) {
    const pid = `defender-${String(index).padStart(3, '0')}`;
    const deviceId = `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    h.room.defense.players[pid] = {
      name: `Defender ${index}`, march: 5 + (index % 116), marchRevision: 0,
      identityMode: 'nickname', lastSeen: new Date(h.room.nowMs()).toISOString(),
      profileGeneration: index + 1
    };
    const socket = index === 0 ? { ws: h.ws, sent: h.sent } : h.addSocket('defense');
    h.room.writeDefenseAttachment(socket.ws, {
      defenseProfilePid: pid, pid, deviceId, soundReady: true, clockFresh: true,
      lastSeenMs: h.room.nowMs()
    });
    defenders.push({ ...socket, pid, deviceId });
  }
  const managers = [0, 1].map(index => h.addSocket('defense', {
    managerAuthorized: true,
    managerDeviceId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    managerClockFresh: true, managerStatusAtMs: h.room.nowMs(),
    managerClockSampleAtMs: h.room.nowMs(), managerClockOffsetMs: 0
  }));
  const rally = [h.addSocket('rally'), h.addSocket('rally')];
  assert.equal(h.room.liveDefenseSockets().length, 102);
  assert.equal(h.room.liveCoreSockets().length, 2);

  h.storageCalls.length = 0;
  h.calls.length = 0;
  for (const socket of defenders.concat(managers, rally)) socket.sent.length = 0;
  for (let round = 0; round < 4; round += 1) {
    for (const defender of defenders) {
      await send(h.room, defender.ws, {
        t: 'hb', pid: defender.pid, deviceId: defender.deviceId,
        soundReady: true, clockFresh: true
      });
    }
  }

  assert.equal(h.storageCalls.filter(call => call.op === 'put').length, 0,
    'steady Defense readiness never writes canonical Durable Object rows');
  assert.equal(h.storageCalls.filter(call => call.op === 'setAlarm').length, 0,
    'idle Defense readiness never creates a recurring alarm');
  assert.equal(h.calls.includes('broadcast'), false,
    'Defense heartbeats never enter the Rally full-room broadcast path');
  for (const socket of defenders.concat(managers, rally)) {
    assert.equal(socket.sent.some(frame => frame.t === 'defenseState' || frame.t === 'state'), false,
      'unchanged heartbeats never emit periodic full-state frames');
  }
});
