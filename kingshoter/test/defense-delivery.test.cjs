const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function delivery() {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'defense-delivery.js'));
  url.searchParams.set('run', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

const deviceId = (suffix) => `00000000-0000-4000-8000-${Number(suffix).toString(16).padStart(12, '0')}`;

function order() {
  return {
    id: 'order-1',
    revision: 12,
    rosterAtAcceptance: [
      {
        pid: 'p1', displayName: 'One', identityMode: 'nickname', playerId: '',
        march: 30, marchRevision: 1, connectedAtAcceptance: true, validAtAcceptance: true
      },
      {
        pid: 'p2', displayName: 'Two', identityMode: 'nickname', playerId: '',
        march: 120, marchRevision: 2, connectedAtAcceptance: true, validAtAcceptance: true
      },
      {
        pid: 'p3', displayName: 'Three', identityMode: 'playerId', playerId: '900000003',
        march: 40, marchRevision: 3, connectedAtAcceptance: true, validAtAcceptance: true
      },
      {
        pid: 'p4', displayName: 'Offline', identityMode: 'nickname', playerId: '',
        march: 50, marchRevision: 4, connectedAtAcceptance: false, validAtAcceptance: true
      },
      {
        pid: 'p5', displayName: 'Invalid', identityMode: 'nickname', playerId: '',
        march: 4, marchRevision: 5, connectedAtAcceptance: true, validAtAcceptance: false
      }
    ],
    audience: [
      {
        pid: 'p1', displayName: 'One', identityMode: 'nickname', playerId: '',
        march: 30, marchRevision: 1, goAtMs: 1_100_000, tooLate: false
      },
      {
        pid: 'p2', displayName: 'Two', identityMode: 'nickname', playerId: '',
        march: 120, marchRevision: 2, goAtMs: 990_000, tooLate: true
      },
      {
        pid: 'p3', displayName: 'Three', identityMode: 'playerId', playerId: '900000003',
        march: 40, marchRevision: 3, goAtMs: 1_090_000, tooLate: false
      }
    ]
  };
}

function ack(pid, device, outcome, overrides = {}) {
  const target = order().audience.find(profile => profile.pid === pid);
  const readiness = {
    scheduled: { audioReady: true, clockFresh: true },
    audio_unready: { audioReady: false, clockFresh: true },
    clock_stale: { audioReady: true, clockFresh: false },
    schedule_failed: { audioReady: true, clockFresh: true },
    too_late: { audioReady: true, clockFresh: true }
  }[outcome] || { audioReady: true, clockFresh: true };
  return {
    orderId: 'order-1',
    orderRevision: 12,
    pid,
    deviceId: device,
    goAtMs: target && target.goAtMs,
    outcome,
    ...readiness,
    ...overrides
  };
}

test('Defense device normalization requires stable shared identity validators and explicit readiness truth', async () => {
  const { normalizeDefenseDevice } = await delivery();
  assert.deepEqual(normalizeDefenseDevice({
    pid: 'p1',
    deviceId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
    soundReady: true,
    clockFresh: false,
    lastSeenMs: 1_000_000
  }), {
    pid: 'p1',
    deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    soundReady: true,
    clockFresh: false,
    lastSeenMs: 1_000_000
  });

  for (const invalid of [
    null,
    { pid: '__proto__', deviceId: deviceId(1), soundReady: true, clockFresh: true, lastSeenMs: 1 },
    { pid: 'p1', deviceId: 'not-a-uuid', soundReady: true, clockFresh: true, lastSeenMs: 1 },
    { pid: 'p1', deviceId: deviceId(1), soundReady: 'yes', clockFresh: true, lastSeenMs: 1 },
    { pid: 'p1', deviceId: deviceId(1), soundReady: true, clockFresh: null, lastSeenMs: 1 },
    { pid: 'p1', deviceId: deviceId(1), soundReady: true, clockFresh: true, lastSeenMs: Infinity }
  ]) {
    assert.equal(normalizeDefenseDevice(invalid), null);
  }
});

test('all five canonical ACK outcomes save against the exact order/profile/device/GO target', async () => {
  const { recordDefenseAck } = await delivery();
  let records = [];
  const attempts = [
    ack('p1', deviceId(1), 'scheduled'),
    ack('p1', deviceId(2), 'audio_unready'),
    ack('p1', deviceId(3), 'clock_stale'),
    ack('p1', deviceId(4), 'schedule_failed'),
    ack('p2', deviceId(5), 'too_late')
  ];
  for (let index = 0; index < attempts.length; index++) {
    const result = recordDefenseAck(order(), records, attempts[index], 1_000_000 + index);
    assert.equal(result.ok, true, attempts[index].outcome);
    assert.equal(result.changed, true);
    records = result.ackRecords;
  }
  assert.equal(records.length, 5);
  assert.deepEqual(records.map(record => record.outcome), [
    'scheduled', 'audio_unready', 'clock_stale', 'schedule_failed', 'too_late'
  ]);
  assert.ok(records.every(record =>
    record.orderId === 'order-1' && record.orderRevision === 12 && record.atMs >= 1_000_000
  ));
});

test('ACK validation rejects forged order, revision, audience, GO, outcome, and readiness combinations atomically', async () => {
  const { recordDefenseAck } = await delivery();
  const attempts = [
    [ack('p1', deviceId(1), 'scheduled', { orderId: 'forged' }), 'ack_target_missing'],
    [ack('p1', deviceId(1), 'scheduled', { orderRevision: 11 }), 'ack_target_missing'],
    [{ ...ack('p1', deviceId(1), 'scheduled'), pid: 'p4' }, 'ack_target_missing'],
    [ack('p1', deviceId(1), 'scheduled', { goAtMs: 1_100_001 }), 'invalid_ack_target'],
    [ack('p1', deviceId(1), 'invented'), 'invalid_ack'],
    [ack('p1', 'not-a-uuid', 'scheduled'), 'invalid_ack'],
    [ack('p1', deviceId(1), 'scheduled', { audioReady: false }), 'invalid_ack_outcome'],
    [ack('p1', deviceId(1), 'scheduled', { clockFresh: false }), 'invalid_ack_outcome'],
    [ack('p1', deviceId(1), 'audio_unready', { audioReady: true }), 'invalid_ack_outcome'],
    [ack('p1', deviceId(1), 'clock_stale', { clockFresh: true }), 'invalid_ack_outcome'],
    [ack('p1', deviceId(1), 'schedule_failed', { audioReady: false }), 'invalid_ack_outcome'],
    [ack('p1', deviceId(1), 'too_late'), 'invalid_ack_outcome'],
    [ack('p2', deviceId(1), 'scheduled'), 'invalid_ack_outcome']
  ];

  for (const [message, error] of attempts) {
    const records = [{ sentinel: true }];
    const before = structuredClone(records);
    const result = recordDefenseAck(order(), records, message, 1_000_000);
    assert.equal(result.ok, false, JSON.stringify(message));
    assert.equal(result.error, error, JSON.stringify(message));
    assert.deepEqual(records, before, 'input records must remain untouched');
  }
});

test('ACK dedupe is exact, retryable failures upgrade before GO, and scheduled never downgrades', async () => {
  const { recordDefenseAck } = await delivery();
  const message = ack('p1', deviceId(10), 'scheduled');
  const first = recordDefenseAck(order(), [], message, 1_000_000);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);

  const duplicate = recordDefenseAck(order(), first.ackRecords, { ...message }, 1_000_100);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(duplicate.savedAck, first.savedAck);
  assert.deepEqual(duplicate.ackRecords, first.ackRecords);

  for (const downgrade of [
    { ...message, outcome: 'schedule_failed' },
    { ...message, audioReady: false },
    { ...message, clockFresh: false },
    { ...message, goAtMs: message.goAtMs + 1 }
  ]) {
    const result = recordDefenseAck(order(), first.ackRecords, downgrade, 1_000_200);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ack_conflict');
    assert.deepEqual(result.ackRecords, first.ackRecords);
  }

  for (const [index, failure] of ['audio_unready', 'clock_stale', 'schedule_failed'].entries()) {
    const initial = recordDefenseAck(order(), [], ack('p1', deviceId(20 + index), failure), 1_010_000);
    assert.equal(initial.ok, true, failure);
    const upgraded = recordDefenseAck(
      order(),
      initial.ackRecords,
      ack('p1', deviceId(20 + index), 'scheduled'),
      1_099_999
    );
    assert.equal(upgraded.ok, true, failure);
    assert.equal(upgraded.changed, true, failure);
    assert.equal(upgraded.ackRecords.length, 1, failure);
    assert.deepEqual(upgraded.savedAck, {
      ...ack('p1', deviceId(20 + index), 'scheduled'),
      atMs: 1_099_999
    });

    const windowClosed = recordDefenseAck(
      order(),
      initial.ackRecords,
      ack('p1', deviceId(20 + index), 'scheduled'),
      1_100_000
    );
    assert.equal(windowClosed.ok, false, failure);
    assert.equal(windowClosed.error, 'ack_window_closed', failure);
    assert.deepEqual(windowClosed.ackRecords, initial.ackRecords, failure);
  }

  const terminalLate = recordDefenseAck(order(), [], ack('p2', deviceId(30), 'too_late'), 1_000_000);
  const lateDuplicate = recordDefenseAck(order(), terminalLate.ackRecords, ack('p2', deviceId(30), 'too_late'), 1_000_100);
  assert.equal(lateDuplicate.ok, true);
  assert.equal(lateDuplicate.changed, false);
  assert.deepEqual(lateDuplicate.ackRecords, terminalLate.ackRecords);
});

test('ACK history remains bounded at 1200 exact device keys', async () => {
  const { recordDefenseAck } = await delivery();
  let records = [];
  for (let index = 1; index <= 1205; index++) {
    const result = recordDefenseAck(order(), records, ack('p1', deviceId(index), 'scheduled'), 1_000_000 + index);
    assert.equal(result.ok, true, String(index));
    records = result.ackRecords;
  }
  assert.equal(records.length, 1200);
  assert.equal(records[0].deviceId, deviceId(6));
  assert.equal(records.at(-1).deviceId, deviceId(1205));
});

test('delivery aggregation deduplicates multiple devices into one profile result and freezes order metrics', async () => {
  const { aggregateDefenseDelivery, recordDefenseAck } = await delivery();
  let records = [];
  for (const message of [
    ack('p1', deviceId(21), 'audio_unready'),
    ack('p1', deviceId(22), 'scheduled'),
    ack('p1', deviceId(23), 'scheduled'),
    ack('p2', deviceId(24), 'too_late')
  ]) {
    const saved = recordDefenseAck(order(), records, message, 1_000_000 + records.length);
    assert.equal(saved.ok, true);
    records = saved.ackRecords;
  }
  records.push({
    orderId: 'order-1', orderRevision: 12, pid: 'forged', deviceId: deviceId(99),
    goAtMs: 1, outcome: 'scheduled', audioReady: true, clockFresh: true, atMs: 3_000_100
  });

  const summary = aggregateDefenseDelivery(order(), records);
  assert.deepEqual({
    targetedProfiles: summary.targetedProfiles,
    deliveredScheduledProfiles: summary.deliveredScheduledProfiles,
    audioReadyProfiles: summary.audioReadyProfiles,
    redUnconfirmedProfiles: summary.redUnconfirmedProfiles,
    offlineRosterProfiles: summary.offlineRosterProfiles,
    invalidTimeProfiles: summary.invalidTimeProfiles,
    tooLateProfiles: summary.tooLateProfiles
  }, {
    targetedProfiles: 3,
    deliveredScheduledProfiles: 1,
    audioReadyProfiles: 1,
    redUnconfirmedProfiles: 1,
    offlineRosterProfiles: 1,
    invalidTimeProfiles: 1,
    tooLateProfiles: 1
  });
  assert.deepEqual(summary.profiles, [
    {
      pid: 'p1', goAtMs: 1_100_000, tooLate: false,
      acknowledgedDevices: 3, scheduledDevices: 2,
      deliveredScheduled: true, audioReady: true, outcome: 'scheduled'
    },
    {
      pid: 'p2', goAtMs: 990_000, tooLate: true,
      acknowledgedDevices: 1, scheduledDevices: 0,
      deliveredScheduled: false, audioReady: false, outcome: 'too_late'
    },
    {
      pid: 'p3', goAtMs: 1_090_000, tooLate: false,
      acknowledgedDevices: 0, scheduledDevices: 0,
      deliveredScheduled: false, audioReady: false, outcome: 'unconfirmed'
    }
  ]);
});

test('aggregation ignores ACKs from other order revisions and does not mutate order or records', async () => {
  const { aggregateDefenseDelivery } = await delivery();
  const canonicalOrder = order();
  const records = [
    { ...ack('p1', deviceId(31), 'scheduled'), atMs: 4_000_000 },
    { ...ack('p1', deviceId(32), 'scheduled'), orderRevision: 11, atMs: 4_000_001 },
    { ...ack('p1', deviceId(33), 'scheduled'), orderId: 'old-order', atMs: 4_000_002 }
  ];
  const beforeOrder = structuredClone(canonicalOrder);
  const beforeRecords = structuredClone(records);
  const summary = aggregateDefenseDelivery(canonicalOrder, records);
  assert.equal(summary.profiles[0].acknowledgedDevices, 1);
  assert.deepEqual(canonicalOrder, beforeOrder);
  assert.deepEqual(records, beforeRecords);
});
