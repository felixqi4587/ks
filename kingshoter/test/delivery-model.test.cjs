const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function load() {
  return import(pathToFileURL(path.join(__dirname, '../src/delivery.js')).href + '?t=' + Date.now());
}

const command = {
  id: 'cmd-1',
  type: 'double_rally',
  kingdom: 1,
  payload: {
    leadSeconds: 10,
    pairs: [
      { pid: '700001', role: 'weak', march: 31, pressUTC: 1010 },
      { pid: '700002', role: 'main', march: 30, pressUTC: 1011 }
    ]
  }
};

const attachment = (pid, deviceId) => ({
  v: 1, roomName: 'qa-kvk-model-a', qa: true, pid, deviceId,
  soundReady: true, view: 'player', shadow: true, audioArmed: true, armedUntilMs: 1_020_000,
  lastProbeId: '', probeExpiresAtMs: 0, nextProbeAtMs: 0
});

test('the QA predicate rejects every operation or malformed room uniformly', async () => {
  const { isQaRoomName } = await load();
  for (const room of ['operation-room', 'demo', '_', '', 'qa-kvk-', 'qa-kvk-bad_', 'QA-KVK-UPPER']) {
    assert.equal(isQaRoomName(room), false, room);
  }
  for (const room of ['qa-kvk-a', 'qa-kvk-20260713-7f3a']) assert.equal(isQaRoomName(room), true, room);
});

test('one immutable record holds role-specific frozen timing and two devices for one pid', async () => {
  const mod = await load();
  const state = mod.defaultDeliveryState('qa-kvk-model-a');
  state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
  const a1 = mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_000);
  const a2 = mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000002'), 1_000_000);
  const b1 = mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700002', '00000000-0000-4000-8000-000000000003'), 1_000_000);
  assert.equal(mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_001), a1);
  assert.equal(state.commands[0].targets.length, 3);
  assert.deepEqual(a1.envelope, {
    t: 'deliveryShadowCommand', v: 1, shadow: true, commandId: 'cmd-1',
    pid: '700001', role: 'weak', kingdom: 1, issuedAtMs: 1_000_000,
    fireAtMs: 1_010_000, audioExpiresAtMs: 1_010_150,
    marchSeconds: 31, leadSeconds: 10
  });
  assert.equal(a2.envelope.fireAtMs, 1_010_000);
  assert.equal(b1.envelope.fireAtMs, 1_011_000);
  for (let i = 0; i < 30; i++) {
    mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', 'extra-' + i), 1_000_000);
  }
  assert.equal(state.commands[0].targets.length, 24);
});

test('target admission requires current sound readiness and a live armed lease', async () => {
  const mod = await load();
  const invalidAttachments = [
    { ...attachment('700001', 'not-ready'), soundReady: false },
    { ...attachment('700001', 'not-armed'), audioArmed: false },
    { ...attachment('700001', 'lease-expired'), armedUntilMs: 1_000_000 }
  ];
  const targets = invalidAttachments.map((candidate) => {
    const state = mod.defaultDeliveryState('qa-kvk-model-a');
    state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
    return mod.upsertDeliveryTarget(state, 'cmd-1', candidate, 1_000_000);
  });
  assert.deepEqual(targets, [null, null, null]);
});

test('initial send and 500/1500ms retries reuse the exact envelope and stop at the cutoff', async () => {
  const mod = await load();
  const state = mod.defaultDeliveryState('qa-kvk-model-a');
  state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
  mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_000);

  const bytes = [];
  for (const now of [1_000_000, 1_000_500, 1_001_500]) {
    const due = mod.dueDeliveryTargets(state, now);
    assert.equal(due.length, 1);
    bytes.push(JSON.stringify(due[0].envelope));
    assert.equal(mod.recordDeliveryAttempt(state, due[0], now), true);
  }
  assert.equal(new Set(bytes).size, 1);
  assert.deepEqual(mod.dueDeliveryTargets(state, 1_002_000), []);

  const nearCutoff = mod.defaultDeliveryState('qa-kvk-model-a');
  nearCutoff.commands.push(mod.createDeliveryRecord(command, 1_009_600));
  mod.upsertDeliveryTarget(nearCutoff, 'cmd-1', attachment('700001', 'dev-late'), 1_009_600);
  assert.deepEqual(mod.dueDeliveryTargets(nearCutoff, 1_009_600), []);
});

test('a mirrored Core ACK must match the challenged socket identity and public output stays aggregate-only', async () => {
  const mod = await load();
  const state = mod.defaultDeliveryState('qa-kvk-model-a');
  state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
  mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_000);
  assert.equal(mod.recordClassicAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryAck', commandId: 'cmd-1', pid: 'forged',
    deviceId: 'forged', outcome: 'scheduled', targetUTC: 1010, scheduledAtMs: 1_000_100
  }, 1_000_100), false);
  assert.equal(mod.recordClassicAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryAck', commandId: 'cmd-1', pid: '700001',
    deviceId: '00000000-0000-4000-8000-000000000001', outcome: 'scheduled', targetUTC: 1010, scheduledAtMs: 1_000_100
  }, 1_000_100), true);
  assert.equal(mod.recordShadowAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-1',
    result: 'would_schedule', futureCueCount: 6
  }, 1_000_110), true);
  const summary = mod.publicDeliverySummary(state, 1_000_120);
  assert.deepEqual(summary, {
    v: 1,
    commands: [{
      commandId: 'cmd-1', expectedDevices: 1, classicScheduled: 1,
      candidateAcked: 1, expired: 0, cancelled: false
    }]
  });
  const json = JSON.stringify(summary);
  assert.doesNotMatch(json, /700001|dev-a1|forged|issuedAtMs|armedUntilMs/);
});

test('duplicate ACKs do not downgrade a success, cancel is explicit, and history is bounded', async () => {
  const mod = await load();
  const state = mod.defaultDeliveryState('qa-kvk-model-a');
  state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
  mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_000);
  mod.recordShadowAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-1',
    result: 'would_schedule', futureCueCount: 5
  }, 1_000_100);
  assert.equal(mod.recordShadowAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-1',
    result: 'duplicate', futureCueCount: 5
  }, 1_000_200), false);
  assert.equal(mod.cancelDeliveryRecord(state, 'cmd-1', 1_000_300), true);
  assert.equal(mod.publicDeliverySummary(state, 1_000_301).commands[0].cancelled, true);

  for (let i = 0; i < 40; i++) {
    const c = structuredClone(command); c.id = 'cmd-' + (i + 2);
    c.payload.pairs[0].pressUTC = 1_110 + i;
    c.payload.pairs[1].pressUTC = 1_111 + i;
    state.commands.push(mod.createDeliveryRecord(c, 1_100_000 + i));
  }
  mod.pruneDeliveryState(state, 1_100_100);
  assert.equal(state.commands.length, 32);
  assert.ok(state.commands.every((record) => record.commandId !== 'cmd-1'));
});

test('history wake and pruning use the final useful ACK timestamp', async () => {
  const mod = await load();
  const state = mod.defaultDeliveryState('qa-kvk-model-a');
  state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
  mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_000);
  mod.recordShadowAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-1',
    result: 'expired', futureCueCount: 0
  }, 1_040_000);
  assert.equal(mod.nextDeliveryWakeAt(state, 1_040_001), 1_100_000);
  assert.equal(mod.pruneDeliveryState(state, 1_099_999), false);
  assert.equal(mod.pruneDeliveryState(state, 1_100_001), true);
  assert.deepEqual(state.commands, []);
});
