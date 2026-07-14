const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleURL = pathToFileURL(path.join(__dirname, '..', 'src', 'room-delivery.js')).href;

const IDS = {
  a1: '00000000-0000-4000-8000-000000000001',
  a2: '00000000-0000-4000-8000-000000000002',
  b1: '00000000-0000-4000-8000-000000000003',
  c1: '00000000-0000-4000-8000-000000000004'
};

function rallyCommand() {
  return {
    id: 'command-1',
    type: 'triple_rally',
    payload: {
      pairs: [
        { pid: 'captain-a', role: 'weak', pressUTC: 110 },
        { pid: 'captain-b', role: 'weak2', pressUTC: 110 },
        { pid: 'captain-c', role: 'main', pressUTC: 111 }
      ]
    }
  };
}

test('delivery aggregation is pair-count agnostic, fresh-device based, and private', async () => {
  const delivery = await import(`${moduleURL}?case=aggregate`);
  const nowMs = 100_000;
  let devices = [];
  devices = delivery.touchDevice(devices, { pid: 'captain-a', deviceId: IDS.a1, soundReady: true }, nowMs - 4);
  devices = delivery.touchDevice(devices, { pid: 'captain-a', deviceId: IDS.a2, soundReady: true }, nowMs - 3);
  devices = delivery.touchDevice(devices, { pid: 'captain-b', deviceId: IDS.b1, soundReady: true }, nowMs - 2);
  devices = delivery.touchDevice(devices, { pid: 'captain-c', deviceId: IDS.c1, soundReady: false }, nowMs - 1);
  devices.push({ pid: 'captain-c', deviceId: '00000000-0000-4000-8000-000000000099', soundReady: true, lastSeenMs: nowMs - delivery.DEVICE_TTL_MS });

  const command = rallyCommand();
  command.delivery = delivery.startCommandDelivery(command, devices, nowMs);

  assert.deepEqual(command.delivery, [
    { pid: 'captain-a', expected: 2, received: 0, expired: 0 },
    { pid: 'captain-b', expected: 1, received: 0, expired: 0 },
    { pid: 'captain-c', expected: 0, received: 0, expired: 0 }
  ]);
  const serialized = JSON.stringify(command.delivery);
  for (const id of Object.values(IDS)) assert.equal(serialized.includes(id), false);
});

test('scheduled ACKs are exact, idempotent, and separated from expiry', async () => {
  const delivery = await import(`${moduleURL}?case=acks`);
  const command = rallyCommand();
  command.delivery = [
    { pid: 'captain-a', expected: 2, received: 0, expired: 0 },
    { pid: 'captain-b', expected: 1, received: 0, expired: 0 },
    { pid: 'captain-c', expected: 0, received: 0, expired: 0 }
  ];
  const base = {
    commandId: command.id,
    pid: 'captain-a',
    deviceId: IDS.a1,
    outcome: 'scheduled',
    targetUTC: 110,
    scheduledAtMs: 100_000
  };

  let result = delivery.recordCommandAck(command, [], base, 100_000);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(command.delivery[0].received, 1);
  assert.deepEqual(result.savedAck, { ...base, atMs: 100_000 });

  result = delivery.recordCommandAck(command, result.ackRecords, base, 100_001);
  assert.equal(result.changed, false);
  assert.equal(command.delivery[0].received, 1);
  assert.deepEqual(result.savedAck, { ...base, atMs: 100_000 });

  for (const conflict of [
    { ...base, outcome: 'expired' },
    { ...base, targetUTC: 111 },
    { ...base, scheduledAtMs: 100_001 }
  ]) {
    const rejected = delivery.recordCommandAck(command, result.ackRecords, conflict, 100_002);
    assert.deepEqual({ ok: rejected.ok, error: rejected.error }, { ok: false, error: 'ack_conflict' });
    assert.equal(command.delivery[0].received, 1);
  }

  result = delivery.recordCommandAck(command, result.ackRecords, { ...base, deviceId: IDS.a2 }, 100_003);
  assert.equal(result.changed, true);
  assert.equal(command.delivery[0].received, 2);

  const expired = delivery.recordCommandAck(command, result.ackRecords, {
    ...base, pid: 'captain-c', deviceId: IDS.c1, outcome: 'expired', targetUTC: 111
  }, 100_003);
  assert.equal(expired.changed, true);
  assert.equal(command.delivery[2].received, 0);
  assert.equal(command.delivery[2].expired, 1);
  assert.equal(command.delivery[2].expected, 1);

  const nonTarget = delivery.recordCommandAck(command, expired.ackRecords, {
    ...base, pid: 'ordinary-member'
  }, 100_004);
  assert.deepEqual({ ok: nonTarget.ok, error: nonTarget.error }, { ok: false, error: 'ack_target_missing' });

  const wrongTarget = delivery.recordCommandAck(command, expired.ackRecords, {
    ...base, deviceId: IDS.b1, targetUTC: 109
  }, 100_005);
  assert.deepEqual({ ok: wrongTarget.ok, error: wrongTarget.error }, { ok: false, error: 'invalid_ack_target' });
});

test('a fresh room device ID cannot be rebound across players and removal scrubs private facts', async () => {
  const delivery = await import(`${moduleURL}?case=device-rebind`);
  let devices = delivery.touchDevice([], { pid: 'captain-a', deviceId: IDS.a1, soundReady: true }, 1_000);
  devices = delivery.touchDevice(devices, { pid: 'captain-b', deviceId: IDS.a1, soundReady: true }, 1_001);
  assert.deepEqual(devices.map(device => [device.pid, device.deviceId]), [['captain-a', IDS.a1]]);

  const cleaned = delivery.removePlayerDelivery(
    devices.concat([{ pid: 'captain-a', deviceId: IDS.a2, soundReady: true, lastSeenMs: 1_001 }]),
    [
      { commandId: 'one', pid: 'captain-a', deviceId: IDS.a2, outcome: 'scheduled', atMs: 1_001 },
      { commandId: 'one', pid: 'captain-b', deviceId: IDS.a1, outcome: 'scheduled', atMs: 1_001 }
    ],
    'captain-a'
  );
  assert.equal(cleaned.devices.some(device => device.pid === 'captain-a'), false);
  assert.equal(cleaned.ackRecords.some(record => record.pid === 'captain-a'), false);
  assert.equal(cleaned.devices.length, 0);
  assert.equal(cleaned.ackRecords.length, 1);
});

test('Core socket identity is exact, sound-ready, and merge-safe for later fields', async () => {
  const delivery = await import(`${moduleURL}?case=attachment`);
  const raw = {
    roomName: 'qa-kvk-delivery-domain',
    pid: ' captain-a ',
    deviceId: IDS.a1,
    soundReady: true,
    shadow: true,
    clientBuild: 17
  };
  const core = delivery.normalizeCoreSocketAttachment(raw, raw.roomName);
  const merged = { ...raw, ...core };
  assert.equal(merged.shadow, true);
  assert.equal(merged.clientBuild, 17);
  assert.deepEqual(core, {
    roomName: 'qa-kvk-delivery-domain',
    pid: 'captain-a',
    deviceId: IDS.a1,
    soundReady: true
  });
  assert.equal(delivery.coreAttachmentMatchesAck(merged, { pid: 'captain-a', deviceId: IDS.a1 }), true);
  assert.equal(delivery.coreAttachmentMatchesAck({ ...merged, soundReady: false }, { pid: 'captain-a', deviceId: IDS.a1 }), false);
  assert.equal(delivery.coreAttachmentMatchesAck(merged, { pid: 'captain-a', deviceId: IDS.a2 }), false);
  assert.equal(delivery.coreAttachmentMatchesAck(merged, { pid: 'captain-b', deviceId: IDS.a1 }), false);
  assert.equal(delivery.coreAttachmentMatchesAck(null, { pid: 'captain-a', deviceId: IDS.a1 }), false);
  assert.equal(delivery.registryMatchesAck([
    { pid: 'captain-a', deviceId: IDS.a1, soundReady: true, lastSeenMs: 999 }
  ], merged, 1_000), true);
  assert.equal(delivery.registryMatchesAck([
    { pid: 'captain-b', deviceId: IDS.a1, soundReady: true, lastSeenMs: 999 }
  ], merged, 1_000), false);

  let bound = delivery.bindCoreSocketIdentity(raw, [], {
    pid: 'captain-a', deviceId: IDS.a1, soundReady: true
  }, 1_000);
  assert.equal(bound.ok, true);
  assert.equal(bound.attachment.soundReady, true);
  bound = delivery.bindCoreSocketIdentity(bound.attachment, bound.devices, {
    pid: 'captain-a', deviceId: IDS.a1, soundReady: false
  }, 1_001);
  assert.equal(bound.ok, true);
  assert.equal(bound.attachment.soundReady, false);
  assert.equal(delivery.bindCoreSocketIdentity(bound.attachment, bound.devices, {
    pid: 'captain-b', deviceId: IDS.a1, soundReady: true
  }, 1_002).error, 'socket_identity_locked');
  assert.equal(delivery.bindCoreSocketIdentity(null, bound.devices, {
    pid: 'captain-b', deviceId: IDS.a1, soundReady: true
  }, 1_002).error, 'device_owned_by_other_pid');
  const afterExpiry = delivery.bindCoreSocketIdentity(null, bound.devices, {
    pid: 'captain-b', deviceId: IDS.a1, soundReady: true
  }, 1_001 + delivery.DEVICE_TTL_MS);
  assert.equal(afterExpiry.ok, true);
  assert.deepEqual(afterExpiry.devices.map(device => device.pid), ['captain-b']);
  assert.equal(delivery.registryMatchesAck(afterExpiry.devices, merged, 1_001 + delivery.DEVICE_TTL_MS), false,
    'an old socket attachment cannot ACK after its device ID is reassigned');
});
