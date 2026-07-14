const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness, claimRoom } = require('./room-harness.cjs');

const IDS = {
  a1: '00000000-0000-4000-8000-000000000011',
  a2: '00000000-0000-4000-8000-000000000012',
  b1: '00000000-0000-4000-8000-000000000013'
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
    deserializeAttachment() { return attachment == null ? null : structuredClone(attachment); }
  };
  room.state.acceptWebSocket = socket => { if (socket === ws) accepted = true; return accept(socket); };
  try { room.attachSocket(ws, roomName); } finally { room.state.acceptWebSocket = accept; }
  return { ws, sent, attachment: () => ws.deserializeAttachment() };
}

async function send(room, ws, message) {
  await room.webSocketMessage(ws, JSON.stringify(message));
}

test('Room binds device identity to the sending socket before accepting a Classic ACK', async () => {
  const { Room } = await loadRoom();
  const nowMs = 1_000_000;
  const h = createRoomHarness(Room, { nowMs });
  const a1 = socketFor(h.room, h.roomName);
  const a2 = socketFor(h.room, h.roomName);
  const b1 = socketFor(h.room, h.roomName);

  await send(h.room, a1.ws, { t: 'deviceStatus', pid: '001', deviceId: IDS.a1, soundReady: true });
  await send(h.room, a2.ws, { t: 'deviceStatus', pid: '001', deviceId: IDS.a2, soundReady: true });
  await send(h.room, b1.ws, { t: 'deviceStatus', pid: 'kimchi', deviceId: IDS.b1, soundReady: true });
  assert.deepEqual(a1.sent, [{ t: 'deviceStatusSaved', pid: '001', deviceId: IDS.a1, soundReady: true }]);
  assert.deepEqual(a2.sent, [{ t: 'deviceStatusSaved', pid: '001', deviceId: IDS.a2, soundReady: true }]);
  assert.deepEqual(b1.sent, [{ t: 'deviceStatusSaved', pid: 'kimchi', deviceId: IDS.b1, soundReady: true }]);
  a1.sent.length = 0; a2.sent.length = 0; b1.sent.length = 0;
  assert.deepEqual(a1.attachment(), {
    roomName: h.roomName, pid: '001', deviceId: IDS.a1, soundReady: true
  });
  assert.equal(h.room.devices.length, 3);

  await claimRoom(h);
  await send(h.room, h.ws, {
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 1000,
      payload: {
        firstPress: 1000, leadSeconds: 10,
        pairs: [
          { pid: '001', role: 'weak', pressUTC: 1000 },
          { pid: 'kimchi', role: 'main', pressUTC: 1000 }
        ]
      }
    }
  });
  const command = h.room.room.live.commands[1];
  assert.deepEqual(command.delivery, [
    { pid: '001', expected: 2, received: 0, expired: 0 },
    { pid: 'kimchi', expected: 1, received: 0, expired: 0 }
  ]);
  h.reset();

  const ack = {
    t: 'deliveryAck', commandId: command.id, pid: '001', deviceId: IDS.a1,
    outcome: 'scheduled', targetUTC: command.payload.pairs.find(pair => pair.pid === '001').pressUTC,
    scheduledAtMs: nowMs
  };
  await send(h.room, h.ws, ack);
  assert.deepEqual(h.sent, [{
    t: 'error', source: 'deliveryAck', error: 'bad_delivery_identity',
    commandId: command.id, pid: '001', deviceId: IDS.a1
  }]);
  assert.equal(command.delivery[0].received, 0);
  assert.deepEqual(h.calls, []);
  h.reset();

  await send(h.room, a1.ws, { ...ack, deviceId: IDS.a2 });
  assert.deepEqual(a1.sent, [{
    t: 'error', source: 'deliveryAck', error: 'bad_delivery_identity',
    commandId: command.id, pid: '001', deviceId: IDS.a2
  }]);
  assert.equal(command.delivery[0].received, 0);
  a1.sent.length = 0;

  await send(h.room, a1.ws, ack);
  assert.equal(command.delivery[0].received, 1);
  assert.deepEqual(h.calls, ['persistAll', 'broadcast']);
  assert.deepEqual(a1.sent, [{
    t: 'deliveryAckSaved', commandId: command.id, pid: '001', deviceId: IDS.a1, outcome: 'scheduled',
    targetUTC: ack.targetUTC, scheduledAtMs: nowMs
  }]);
  h.reset();
  a1.sent.length = 0;
  await send(h.room, a1.ws, ack);
  assert.equal(command.delivery[0].received, 1);
  assert.deepEqual(h.calls, []);
  assert.equal(a1.sent[0].t, 'deliveryAckSaved', 'an idempotent retry receives the persisted private ACK again');

  await send(h.room, a1.ws, { ...ack, scheduledAtMs: nowMs + 1 });
  assert.deepEqual(a1.sent.at(-1), {
    t: 'error', source: 'deliveryAck', error: 'ack_conflict',
    commandId: command.id, pid: '001', deviceId: IDS.a1
  }, 'a conflict is scoped to the exact private ACK key');

  await send(h.room, a2.ws, { t: 'deviceStatus', pid: '001', deviceId: IDS.a2, soundReady: false });
  h.reset();
  await send(h.room, a2.ws, { ...ack, deviceId: IDS.a2 });
  assert.equal(command.delivery[0].received, 1);
  assert.equal(a2.sent.at(-1).error, 'bad_delivery_identity');
  assert.deepEqual(h.calls, []);

  await send(h.room, a2.ws, { t: 'deviceStatus', pid: 'kimchi', deviceId: IDS.a2, soundReady: true });
  assert.deepEqual(a2.attachment(), {
    roomName: h.roomName, pid: '001', deviceId: IDS.a2, soundReady: false
  }, 'a socket cannot change its bound player/device tuple');
  assert.deepEqual(a2.sent.at(-1), { t: 'error', source: 'deviceStatus', error: 'socket_identity_locked' });
  h.reset();
  await send(h.room, a2.ws, { ...ack, deviceId: IDS.a2 });
  assert.equal(command.delivery[0].received, 1);
  assert.equal(a2.sent.at(-1).error, 'bad_delivery_identity');
  assert.deepEqual(h.calls, []);

  const conflict = socketFor(h.room, h.roomName);
  await send(h.room, conflict.ws, { t: 'deviceStatus', pid: 'kimchi', deviceId: IDS.a1, soundReady: true });
  assert.deepEqual(conflict.attachment(), {
    roomName: h.roomName, pid: '', deviceId: '', soundReady: false
  }, 'a fresh registry device cannot be claimed by a different player');
  assert.deepEqual(conflict.sent.at(-1), { t: 'error', source: 'deviceStatus', error: 'device_owned_by_other_pid' });
});

test('identity-bearing heartbeat refreshes the same private binding without exposing it', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { nowMs: 2_000_000 });
  const player = socketFor(h.room, h.roomName);
  await send(h.room, player.ws, {
    t: 'hb', pid: '001', deviceId: IDS.a1, soundReady: true
  });

  assert.deepEqual(player.attachment(), {
    roomName: h.roomName, pid: '001', deviceId: IDS.a1, soundReady: true
  });
  assert.equal(h.room.devices[0].pid, '001');
  assert.equal(h.room.devices[0].deviceId, IDS.a1);
  assert.equal(JSON.stringify(h.room.snapshot()).includes(IDS.a1), false);
});

test('deviceStatusSaved is emitted only after private device persistence succeeds', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { nowMs: 2_500_000 });
  const player = socketFor(h.room, h.roomName);
  h.room.persistAll = async () => { throw new Error('storage unavailable'); };

  await assert.rejects(send(h.room, player.ws, {
    t: 'deviceStatus', pid: '001', deviceId: IDS.a1, soundReady: true
  }), /storage unavailable/);
  assert.deepEqual(player.sent, [], 'a failed persistence never sends a positive binding receipt');
});

test('attachment writes preserve fields owned by later Reliable and Triple layers', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  h.ws.serializeAttachment({ roomName: h.roomName, shadow: true, clientBuild: 19 });
  h.room.writeSocketAttachment(h.ws, { pid: '001', deviceId: IDS.a1, soundReady: true });
  assert.deepEqual(h.ws.deserializeAttachment(), {
    roomName: h.roomName,
    shadow: true,
    clientBuild: 19,
    pid: '001',
    deviceId: IDS.a1,
    soundReady: true
  });
});

test('registry ownership invalidates an old socket after TTL rebind', async () => {
  const { Room } = await loadRoom();
  let nowMs = 3_000_000;
  const h = createRoomHarness(Room, { nowMs });
  h.room.nowMs = () => nowMs;
  const oldOwner = socketFor(h.room, h.roomName);
  await send(h.room, oldOwner.ws, { t: 'deviceStatus', pid: '001', deviceId: IDS.a1, soundReady: true });

  nowMs += 70_000;
  const newOwner = socketFor(h.room, h.roomName);
  await send(h.room, newOwner.ws, { t: 'deviceStatus', pid: 'kimchi', deviceId: IDS.a1, soundReady: true });
  assert.deepEqual(h.room.devices.map(device => device.pid), ['kimchi']);

  await claimRoom(h);
  await send(h.room, h.ws, {
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 3000,
      payload: {
        firstPress: 3000, leadSeconds: 10,
        pairs: [
          { pid: '001', role: 'weak', pressUTC: 3000 },
          { pid: 'kimchi', role: 'main', pressUTC: 3000 }
        ]
      }
    }
  });
  const command = h.room.room.live.commands[1];
  oldOwner.sent.length = 0;
  await send(h.room, oldOwner.ws, {
    t: 'deliveryAck', commandId: command.id, pid: '001', deviceId: IDS.a1,
    outcome: 'scheduled', targetUTC: command.payload.pairs.find(pair => pair.pid === '001').pressUTC,
    scheduledAtMs: nowMs
  });
  assert.equal(oldOwner.sent.at(-1).error, 'bad_delivery_identity');
  assert.equal(command.delivery.find(item => item.pid === '001').received, 0);
  await h.room.webSocketClose(oldOwner.ws);
  assert.deepEqual(h.room.devices.map(device => device.pid), ['kimchi'], 'closing the stale socket cannot delete the new owner');
});

test('same-device sibling tabs aggregate readiness and close without deleting a live sibling', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { nowMs: 4_000_000 });
  const getSockets = h.room.state.getWebSockets.bind(h.room.state);
  h.room.state.getWebSockets = () => getSockets().filter(socket => !socket.closed);
  const ready = socketFor(h.room, h.roomName);
  const paused = socketFor(h.room, h.roomName);

  await send(h.room, ready.ws, { t: 'deviceStatus', pid: '001', deviceId: IDS.a1, soundReady: true });
  await send(h.room, paused.ws, { t: 'deviceStatus', pid: '001', deviceId: IDS.a1, soundReady: false });
  assert.equal(h.room.devices[0].soundReady, true, 'one ready sibling keeps the shared device ready');

  await h.room.webSocketClose(ready.ws);
  assert.equal(h.room.devices.length, 1);
  assert.equal(h.room.devices[0].soundReady, false, 'remaining paused sibling is retained truthfully');

  await h.room.webSocketClose(paused.ws);
  assert.equal(h.room.devices.length, 0, 'the device disappears only after its last sibling closes');
});

test('a hibernation close loads private delivery state before removing one socket device', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { nowMs: 4_500_000 });
  const closing = socketFor(h.room, h.roomName);
  h.room.writeSocketAttachment(closing.ws, { pid: '001', deviceId: IDS.a1, soundReady: true });
  const storedDevices = [
    { pid: '001', deviceId: IDS.a1, soundReady: true, lastSeenMs: h.nowMs },
    { pid: 'kimchi', deviceId: IDS.b1, soundReady: true, lastSeenMs: h.nowMs }
  ];
  const storedAcks = [
    { commandId: 'old-command', pid: '001', deviceId: IDS.a1, outcome: 'scheduled', atMs: h.nowMs },
    { commandId: 'old-command', pid: 'kimchi', deviceId: IDS.b1, outcome: 'scheduled', atMs: h.nowMs }
  ];
  h.room.devices = [];
  h.room.deliveryAcks = [];
  h.room._deliveryLoaded = false;
  h.room._deliveryLoadPromise = null;
  h.room.state.storage = {
    async get() { return new Map([['devices', storedDevices], ['deliveryAcks', storedAcks]]); }
  };
  let persisted = null;
  h.room.persistAll = async () => {
    persisted = { devices: structuredClone(h.room.devices), deliveryAcks: structuredClone(h.room.deliveryAcks) };
  };

  await h.room.webSocketClose(closing.ws);

  assert.deepEqual(persisted.devices, [storedDevices[1]], 'only the closing socket device is removed');
  assert.deepEqual(persisted.deliveryAcks, storedAcks, 'persisted command receipt history survives hibernation close');
});

test('a failed ACK persistence never leaks green delivery state or a saved confirmation', async () => {
  const { Room } = await loadRoom();
  const nowMs = 5_000_000;
  const h = createRoomHarness(Room, { nowMs });
  const player = socketFor(h.room, h.roomName);
  await send(h.room, player.ws, { t: 'deviceStatus', pid: '001', deviceId: IDS.a1, soundReady: true });
  await claimRoom(h);
  await send(h.room, h.ws, {
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 5000,
      payload: {
        firstPress: 5000, leadSeconds: 10,
        pairs: [
          { pid: '001', role: 'weak', pressUTC: 5000 },
          { pid: 'kimchi', role: 'main', pressUTC: 5000 }
        ]
      }
    }
  });
  const command = h.room.room.live.commands[1];
  h.room.persistAll = async () => { throw new Error('storage unavailable'); };
  player.sent.length = 0;
  await send(h.room, player.ws, {
    t: 'deliveryAck', commandId: command.id, pid: '001', deviceId: IDS.a1,
    outcome: 'scheduled', targetUTC: command.payload.pairs.find(pair => pair.pid === '001').pressUTC,
    scheduledAtMs: nowMs
  });
  assert.equal(command.delivery.find(item => item.pid === '001').received, 0);
  assert.equal(h.room.deliveryAcks.length, 0);
  assert.deepEqual(player.sent, [{
    t: 'error', source: 'deliveryAck', error: 'delivery_persist_failed',
    commandId: command.id, pid: '001', deviceId: IDS.a1
  }]);
});

test('a late commander stage cannot revive staged slots after Fire', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { nowMs: 6_000_000 });
  await claimRoom(h);
  await send(h.room, h.ws, {
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 6010,
      payload: {
        firstPress: 6010, leadSeconds: 10,
        pairs: [
          { pid: '001', role: 'weak', pressUTC: 6010 },
          { pid: 'kimchi', role: 'main', pressUTC: 6010 }
        ]
      }
    }
  });
  const command = h.room.room.live.commands[1];
  h.reset();

  await send(h.room, h.ws, {
    t: 'stage', password: 'commander-secret',
    staged: { kingdom: 1, pairs: [{ pid: '001', role: 'weak' }] }
  });

  assert.equal(h.room.room.live.staged[1], null);
  assert.deepEqual(h.sent, [{ t: 'stageSuperseded', kingdom: 1, commandId: command.id }]);
  assert.deepEqual(h.calls, [], 'the stale stage is a private no-op, not another room mutation');
});
