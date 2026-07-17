const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUmd(file) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, globalThis: {},
    Object, Array, String, Number, JSON, Math, RegExp, TypeError, Error
  }, { filename: file });
  return module.exports;
}

const DefenseController = loadUmd(path.join(__dirname, '../public/defense-controller.js'));
const DefenseDomain = loadUmd(path.join(__dirname, '../public/defense-domain.js'));
const BattleIdentity = loadUmd(path.join(__dirname, '../public/battle-identity.js'));
const BattleStatus = loadUmd(path.join(__dirname, '../public/battle-status.js'));
const BattleDelivery = loadUmd(path.join(__dirname, '../public/battle-delivery.js'));
const BattleCues = loadUmd(path.join(__dirname, '../public/battle-cues.js'));

const DEVICE_ID = '30000000-0000-4000-8000-000000000003';
const PROFILE_KEY = '10000000-0000-4000-8000-000000000001';
const REGISTRATION_ID = '20000000-0000-4000-8000-000000000002';

function personalOrder(overrides = {}) {
  return {
    id: 'order-1', revision: 3,
    signalAtMs: 900_000, acceptedAtMs: 900_020,
    tapAnchorSeconds: 180, enemyMarchSeconds: 30,
    enemyLaunchAtMs: 1_080_000, enemyImpactAtMs: 1_110_000,
    completeAtMs: 1_081_000,
    pid: '900000001', displayName: 'Kimchi', march: 30,
    marchRevision: 0, goAtMs: 1_080_000, tooLate: false,
    ...overrides
  };
}

function profile(overrides = {}) {
  return {
    pid: '900000001', identityMode: 'playerId', playerId: '900000001',
    name: 'Kimchi', march: 30, revision: 0, pendingRemoval: false,
    profileKey: PROFILE_KEY, ...overrides
  };
}

function fixture(options = {}) {
  let nowMs = options.nowMs ?? 1_060_000;
  let audioNowMs = options.audioNowMs ?? nowMs;
  let connected = false;
  let clockFresh = options.clockFresh ?? true;
  let generation = 1;
  let transportSendEnabled = options.transportSendEnabled ?? true;
  const ackTimers = [];
  const sent = [];
  const saved = [];
  const schedules = [];
  const scheduleBehaviors = [];
  const cancellations = [];
  const driftCancellations = [];
  const ackEntries = [];
  const ackPauses = [];
  const ackRetries = [];
  const status = [];
  let confirmed = options.confirmed || null;
  const prefill = options.prefill || null;
  let audioState = options.audioState || {
    userEnabled: false, audioContextRunning: false, carrierAlive: false
  };
  let scheduledPlanId = '';
  let scheduledEvents = [];
  let missingCueId = options.missingCueId || '';
  const ids = [PROFILE_KEY, REGISTRATION_ID,
    '40000000-0000-4000-8000-000000000004',
    '50000000-0000-4000-8000-000000000005'];

  const transport = {
    send(message) { sent.push(structuredClone(message)); return connected && transportSendEnabled; },
    connected() { return connected; },
    clockFresh() { return clockFresh; },
    serverNowMs() { return nowMs; },
    generation() { return generation; }
  };
  const identityStore = {
    readConfirmed() { return confirmed && structuredClone(confirmed); },
    readRallyPrefill() { return prefill && structuredClone(prefill); },
    saveConfirmed(value) {
      confirmed = value && structuredClone(value);
      saved.push(confirmed);
      return confirmed;
    },
    deviceId() { return DEVICE_ID; }
  };
  const audio = {
    state() { return { ...audioState }; },
    enable() {
      audioState = { userEnabled: true, audioContextRunning: true, carrierAlive: true };
      return { ...audioState };
    }
  };
  const fakeCues = {
    reconcile(plans, behavior) {
      schedules.push(structuredClone(plans));
      scheduleBehaviors.push(structuredClone(behavior || {}));
      scheduledPlanId = plans[0] ? plans[0].id : '';
      scheduledEvents = plans[0] ? plans[0].events
        .filter(event => event.id !== missingCueId).map(event => ({
          key: `${plans[0].id}:${event.id}`, base: plans[0].id,
          scheduled: true, event: structuredClone(event)
        })) : [];
      return scheduledEvents.length;
    },
    cancelScope(scope) { cancellations.push(scope); if (scheduledPlanId.startsWith(scope)) scheduledPlanId = ''; return 1; },
    cancelDrifted(offset, threshold) { driftCancellations.push([offset, threshold]); scheduledPlanId = ''; return true; },
    hasFutureCue(id) { return id === scheduledPlanId; },
    snapshot() { return structuredClone(scheduledEvents); }
  };
  const cues = options.realCueScheduler ? BattleCues.createCueScheduler({
    audio: {
      schedule(event, when) {
        const nodes = [{ event: structuredClone(event), when }];
        schedules.push(nodes);
        return nodes;
      },
      cancel(nodes) { cancellations.push(`audio:${Array.isArray(nodes) ? nodes.length : 0}`); },
      nowSeconds() { return audioNowMs / 1000; }
    },
    nowMs: () => nowMs + Number(options.schedulerLagMs || 0),
    clockOffsetMs: () => 0
  }) : fakeCues;
  const fakeAckQueue = {
    enqueue(entry) { ackEntries.push(structuredClone(entry)); return true; },
    confirm(key) { ackEntries.push({ confirmed: key }); return true; },
    reject(key, reason) { ackEntries.push({ rejected: key, reason: structuredClone(reason) }); return true; },
    cancelScope(scope) { cancellations.push(`ack:${scope}`); return 1; },
    pause() { ackPauses.push(generation); return 1; },
    retryAll(force) { ackRetries.push({ generation, force: force === true }); return 0; },
    clear() {}
  };
  const ackQueue = options.realAckQueue ? BattleDelivery.createAckQueue({
    send(message) { return transport.send(message); },
    nowMs: () => nowMs,
    generation: () => generation,
    setTimeout(callback) { ackTimers.push(callback); return ackTimers.length; },
    clearTimeout() {}
  }) : fakeAckQueue;

  const controller = DefenseController.createDefenseController({
    transport, identityStore, identity: BattleIdentity, status: BattleStatus,
    domain: DefenseDomain, audio, cues, ackQueue,
    randomUUID() { return ids.shift(); },
    createNicknamePid: () => 'n_00112233445566778899aa',
    onStateChange(value) { status.push(structuredClone(value)); }
  });

  return {
    controller, sent, saved, schedules, scheduleBehaviors, cancellations, driftCancellations,
    ackEntries, ackPauses, ackRetries, status,
    connect() { connected = true; controller.connectionChanged({ connected: true, generation }); },
    disconnect() { connected = false; controller.connectionChanged({ connected: false, generation }); },
    setNow(value) { nowMs = value; },
    setAudioNow(value) { audioNowMs = value; },
    setClockFresh(value) { clockFresh = value; },
    setAudioState(value) { audioState = { ...value }; controller.audioChanged(audioState); },
    confirmDeviceStatus(overrides = {}) {
      const current = controller.state();
      return controller.handleMessage({
        t: 'defenseDeviceStatusSaved',
        pid: current.profile && current.profile.pid,
        deviceId: DEVICE_ID,
        soundReady: audioState.userEnabled === true && audioState.audioContextRunning === true &&
          audioState.carrierAlive === true,
        clockFresh,
        ...overrides
      });
    },
    allowAllCues() { missingCueId = ''; },
    nextGeneration() { generation += 1; },
    setTransportSendEnabled(value) { transportSendEnabled = value === true; },
    runAckTimers() {
      const pending = ackTimers.splice(0);
      pending.forEach(callback => callback());
    }
  };
}

test('connection sends only hello until a canonical Defense handshake arrives', () => {
  const f = fixture({
    prefill: { sourceSurface: 'rally', pid: 'rally-route', identityMode: 'nickname', name: 'Kimchi', march: 30 }
  });
  assert.equal(f.controller.state().draft.sourceSurface, 'rally');
  assert.equal(f.controller.state().profile, null);
  f.connect();
  assert.deepEqual(f.sent, [{ t: 'hello' }]);
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  assert.deepEqual(f.sent, [{ t: 'hello' }], 'Rally prefill never silently registers Defense');
  assert.equal(f.controller.state().readiness.green, false);
  assert.equal(f.controller.state().readiness.reasons.includes('binding_unconfirmed'), false,
    'a brand-new pre-profile user is not stuck in device confirmation');
});

test('explicit confirmation creates a Defense-only registration after handshake', () => {
  const f = fixture({
    prefill: { sourceSurface: 'rally', pid: 'rally-route', identityMode: 'nickname', name: 'Kimchi', march: 30 }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  const result = f.controller.confirmProfile({
    identityMode: 'playerId', playerId: '900000001', name: 'Kimchi', march: 30
  });
  assert.equal(result.ok, true);
  assert.deepEqual(f.sent.at(-1), {
    t: 'registerPlayer', registrationId: REGISTRATION_ID, profileKey: PROFILE_KEY,
    pid: '900000001', identityMode: 'playerId', playerId: '900000001',
    name: 'Kimchi', march: 30
  });
  assert.equal(f.saved.length, 0, 'ownership is not persisted before the canonical profile delta');

  f.controller.handleMessage({
    t: 'defenseProfileDelta', registrationId: REGISTRATION_ID,
    profile: profile()
  });
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].profileKey, PROFILE_KEY);
  assert.equal(f.controller.state().profile.pid, '900000001');
  assert.equal(f.sent.at(-1).t, 'defenseDeviceStatus');
});

test('a confirmed Defense profile rebinds only after every reconnect handshake', () => {
  const f = fixture({ confirmed: profile() });
  f.connect();
  assert.deepEqual(f.sent, [{ t: 'hello' }]);
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  assert.equal(f.sent.at(-1).t, 'registerPlayer');
  assert.equal(f.sent.at(-1).profileKey, PROFILE_KEY);

  f.disconnect();
  f.nextGeneration();
  f.connect();
  assert.equal(f.sent.at(-1).t, 'hello');
  assert.equal(f.sent.filter(message => message.t === 'registerPlayer').length, 1,
    'a profile is never sent before the new generation handshakes');
});

test('reconnect preserves a scheduled personal order until automatic rebind confirms canonical state', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  assert.equal(f.ackRetries.length, 0, 'a new unbound socket never retries ACKs');
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  assert.equal(f.controller.state().personal.captured, true);
  assert.equal(f.schedules.length, 1);
  assert.equal(f.ackEntries.length, 0, 'profile state alone cannot send an ACK before device binding');
  assert.equal(f.ackRetries.length, 0, 'profile state alone cannot release retained ACKs');
  assert.equal(f.controller.state().readiness.green, false);
  assert.ok(f.controller.state().readiness.reasons.includes('binding_unconfirmed'));
  f.confirmDeviceStatus();
  assert.equal(f.ackEntries.at(-1).payload.outcome, 'scheduled');
  assert.equal(f.ackRetries.length, 1, 'the exact saved device status confirms the initial binding');
  assert.equal(f.controller.state().readiness.green, true);

  const pausesBefore = f.ackPauses.length;
  const retriesBefore = f.ackRetries.length;
  f.disconnect();
  f.nextGeneration();
  f.connect();
  assert.equal(f.ackPauses.length, pausesBefore + 2, 'disconnect and the new generation both pause delivery');
  assert.equal(f.ackRetries.length, retriesBefore, 'the new socket remains paused before rebind');
  assert.equal(f.controller.state().readiness.green, false);
  assert.ok(f.controller.state().readiness.reasons.includes('handshake_pending'));

  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 3
  });
  const rebind = f.sent.filter(message => message.t === 'registerPlayer').at(-1);
  assert.ok(rebind && rebind.registrationId);
  assert.equal(f.controller.state().personal.captured, true);
  assert.equal(f.schedules.length, 1, 'the already scheduled Web Audio plan stays intact');
  assert.equal(f.cancellations.includes('defense:order-1:3:900000001'), false);
  assert.equal(f.ackRetries.length, retriesBefore, 'an unbound handshake cannot emit bad_ack_identity');
  assert.equal(f.controller.state().readiness.green, false);
  assert.ok(f.controller.state().readiness.reasons.includes('binding_unconfirmed'));

  f.controller.handleMessage({
    t: 'defenseProfileDelta', registrationId: rebind.registrationId,
    profile: profile()
  });
  assert.equal(f.controller.state().personal.captured, true);
  assert.equal(f.ackRetries.length, retriesBefore, 'profile delta still cannot release ACKs');
  assert.equal(f.controller.state().readiness.green, false);
  f.confirmDeviceStatus();
  assert.equal(f.ackRetries.length, retriesBefore + 1, 'matching saved device status resumes delivery once');
  assert.equal(f.controller.state().readiness.green, true);

  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 3
  });
  assert.equal(f.controller.state().personal.phase, 'waiting',
    'only a bound canonical no-active snapshot may clear the old order');
});

test('a newer unbound order revision cancels stale personal audio during automatic rebind', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  assert.equal(f.controller.state().personal.captured, true);

  f.disconnect();
  f.nextGeneration();
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 4
  });

  assert.equal(f.controller.state().personal.phase, 'waiting',
    'a canonical newer revision proves the disconnected round already ended');
  assert.ok(f.cancellations.includes('defense:order-1:3:900000001'),
    'the obsolete Web Audio plan is cancelled before automatic profile rebind completes');
  assert.ok(f.cancellations.includes('ack:defense:order-1:3:900000001'),
    'the obsolete delivery queue is cancelled with the same exact plan scope');
});

test('identical canonical state echoes publish device status only once per socket generation', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  for (let index = 0; index < 8; index += 1) {
    f.controller.handleMessage({
      t: 'defenseState', config: {}, ownProfile: profile(),
      activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
    });
  }
  assert.equal(f.sent.filter(message => message.t === 'defenseDeviceStatus').length, 1);
  assert.equal(f.ackRetries.length, 0, 'state echoes cannot confirm device binding');
  f.confirmDeviceStatus();
  f.confirmDeviceStatus();
  assert.equal(f.ackRetries.length, 1, 'saved status binding is generation-idempotent');
});

test('a deferred ACK follows current readiness until exact device binding is saved', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  assert.equal(f.ackEntries.length, 0);
  f.setAudioState({ userEnabled: true, audioContextRunning: true, carrierAlive: false });
  f.confirmDeviceStatus();
  assert.equal(f.ackEntries.length, 1);
  assert.equal(f.ackEntries[0].payload.outcome, 'audio_unready');
  assert.equal(f.ackEntries[0].payload.audioReady, false);
});

test('replacing plan A with B clears A deferred ACKs and stale errors cannot reject B', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.controller.handleMessage({
    t: 'defenseOrderAccepted', order: personalOrder({
      id: 'order-2', revision: 4, goAtMs: 1_090_000, completeAtMs: 1_091_000
    })
  });
  f.confirmDeviceStatus();
  assert.deepEqual(f.ackEntries.filter(entry => entry.payload).map(entry => entry.payload.orderId),
    ['order-2'], 'only the replacement plan flushes after exact device binding');

  f.controller.handleMessage({
    t: 'error', source: 'defenseOrderAck', error: 'ack_target_missing',
    orderId: 'order-1', orderRevision: 3, pid: '900000001', deviceId: DEVICE_ID,
    outcome: 'scheduled'
  });
  assert.equal(f.ackEntries.some(entry => entry.rejected), false,
    'a stale plan A error cannot reject the current plan B queue entry');
});

test('reconnect readiness change replaces a frozen pending ACK before saved-status retry', () => {
  const f = fixture({
    confirmed: profile(), realAckQueue: true,
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  assert.deepEqual(f.sent.filter(message => message.t === 'defenseOrderAck').map(message => [
    message.outcome, message.audioReady
  ]), [['scheduled', true]]);

  f.disconnect();
  f.nextGeneration();
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 3
  });
  const rebind = f.sent.filter(message => message.t === 'registerPlayer').at(-1);
  f.controller.handleMessage({
    t: 'defenseProfileDelta', registrationId: rebind.registrationId, profile: profile()
  });
  f.setAudioState({ userEnabled: true, audioContextRunning: true, carrierAlive: false });
  const beforeSaved = f.sent.filter(message => message.t === 'defenseOrderAck').length;
  f.confirmDeviceStatus();
  const afterSaved = f.sent.filter(message => message.t === 'defenseOrderAck');
  assert.equal(afterSaved.length, beforeSaved + 1);
  assert.deepEqual([afterSaved.at(-1).outcome, afterSaved.at(-1).audioReady],
    ['audio_unready', false]);
  assert.equal(afterSaved.slice(beforeSaved).some(message =>
    message.outcome === 'scheduled' && message.audioReady === true), false,
  'the old frozen scheduled payload is cancelled before retryAll');
});

for (const rebindError of ['profile_removed', 'profile_owner_mismatch']) {
  test(`matching automatic rebind ${rebindError} clears stale ownership and permits fresh registration`, () => {
    const f = fixture({
      confirmed: profile(),
      audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
    });
    f.connect();
    f.controller.handleMessage({
      t: 'defenseState', config: {}, ownProfile: profile(),
      activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
    });
    f.disconnect();
    f.nextGeneration();
    f.connect();
    f.controller.handleMessage({
      t: 'defenseState', config: {}, ownProfile: null,
      activeOrderForOwnProfile: null, readiness: {}, orderRevision: 3
    });
    const rebind = f.sent.filter(message => message.t === 'registerPlayer').at(-1);
    f.controller.handleMessage({
      t: 'error', source: 'registerPlayer', mutationId: rebind.registrationId,
      error: rebindError
    });

    const cleared = f.controller.state();
    assert.equal(cleared.profile, null);
    assert.equal(cleared.pendingRegistration, null);
    assert.equal(cleared.personal.phase, 'waiting');
    assert.equal(cleared.draft.name, 'Kimchi');
    assert.equal(cleared.draft.march, 30);
    assert.equal(cleared.draft.playerId, '');
    assert.equal(Object.hasOwn(cleared.draft, 'profileKey'), false);
    assert.equal(f.saved.at(-1), null, 'stale local ownership is removed');
    assert.ok(f.cancellations.includes('defense:order-1:3:900000001'));
    assert.ok(f.cancellations.includes('ack:defense:order-1:3:900000001'));

    const result = f.controller.confirmProfile({
      identityMode: 'playerId', playerId: '900000002', name: 'Kimchi', march: 30
    });
    assert.equal(result.ok, true);
    assert.equal(result.operation, 'register');
    assert.equal(f.sent.at(-1).t, 'registerPlayer');
    assert.equal(f.sent.at(-1).pid, '900000002');
  });
}

test('an unscoped automatic-rebind error cannot clear confirmed ownership', () => {
  const f = fixture({ confirmed: profile() });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  f.controller.handleMessage({
    t: 'error', source: 'registerPlayer', error: 'profile_removed'
  });
  const state = f.controller.state();
  assert.equal(state.profile.pid, '900000001');
  assert.equal(state.pendingRegistration.blocked, true);
  assert.equal(f.saved.includes(null), false);
});

test('a transient automatic-rebind persistence failure waits for an explicit registration retry', () => {
  const f = fixture({ confirmed: profile() });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  const first = f.sent.filter(message => message.t === 'registerPlayer').at(-1);
  f.controller.handleMessage({
    t: 'error', source: 'registerPlayer', mutationId: first.registrationId,
    error: 'registration_persist_failed'
  });
  assert.equal(f.controller.state().pendingRegistration.blocked, true);

  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  assert.equal(f.sent.filter(message => message.t === 'registerPlayer').length, 1,
    'a storage outage cannot create an automatic WebSocket retry loop');
  f.controller.handleMessage({
    t: 'error', source: 'defenseDeviceStatus', error: 'profile_identity_mismatch'
  });

  const retried = f.controller.confirmProfile({
    identityMode: 'playerId', playerId: '900000001', name: 'Kimchi', march: 31
  });
  const second = f.sent.filter(message => message.t === 'registerPlayer').at(-1);
  assert.equal(retried.operation, 'rebind');
  assert.equal(second.pid, first.pid);
  assert.equal(second.profileKey, first.profileKey);
  assert.equal(second.march, 31, 'the explicit retry uses the latest safe form timing');
  assert.notEqual(second.registrationId, first.registrationId);
  assert.equal(f.sent.some(message => message.t === 'updateOwnProfile'), false,
    'an absent canonical profile is rebuilt rather than edited');
});

test('a user-entered registration conflict preserves its draft without clearing unrelated storage', () => {
  const f = fixture();
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  f.controller.confirmProfile({ identityMode: 'nickname', name: 'Test Defender', march: 41 });
  const registration = f.sent.at(-1);
  f.controller.handleMessage({
    t: 'error', source: 'registerPlayer', mutationId: registration.registrationId,
    error: 'profile_owner_mismatch'
  });
  const state = f.controller.state();
  assert.equal(state.pendingRegistration.blocked, true);
  assert.equal(state.draft.name, 'Test Defender');
  assert.equal(state.draft.march, 41);
  assert.deepEqual(f.saved, [], 'a normal registration conflict never clears local confirmed storage');
});

test('controller public state never exposes the Defense ownership capability', () => {
  const f = fixture({ confirmed: profile() });
  const before = f.controller.state();
  assert.equal(Object.hasOwn(before.profile, 'profileKey'), false);
  assert.equal(Object.hasOwn(before.draft, 'profileKey'), false);
  assert.equal(JSON.stringify(before).includes(PROFILE_KEY), false);

  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  const after = f.controller.state();
  assert.equal(Object.hasOwn(after.draft, 'profileKey'), false);
  assert.equal(JSON.stringify(after).includes(PROFILE_KEY), false);
});

test('alerts require an explicit gesture and a successful personal schedule before scheduled ACK', () => {
  const f = fixture({ confirmed: profile() });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  assert.equal(f.schedules.length, 0, 'audio-unready devices do not create a false local schedule');
  assert.equal(f.ackEntries.length, 0, 'profile state cannot ACK before exact device binding');
  f.confirmDeviceStatus();
  const unready = f.ackEntries.find(entry => entry.payload && entry.payload.outcome === 'audio_unready');
  assert.ok(unready);
  assert.equal(f.ackEntries.some(entry => entry.payload && entry.payload.outcome === 'scheduled'), false);

  f.controller.enableAlerts();
  assert.equal(f.schedules.length, 1);
  assert.equal(f.schedules[0].length, 1);
  assert.equal(f.schedules[0][0].events.at(-1).kind, 'go');
  assert.equal(f.ackEntries.some(entry => entry.payload && entry.payload.outcome === 'scheduled'), false,
    'changed readiness waits for its own exact saved status');
  f.confirmDeviceStatus();
  const scheduled = f.ackEntries.find(entry => entry.payload && entry.payload.outcome === 'scheduled');
  assert.ok(scheduled);
  assert.equal(scheduled.payload.audioReady, true);
  assert.equal(scheduled.payload.clockFresh, true);
  assert.equal(scheduled.payload.goAtMs, 1_080_000);
});

test('manager-only projections never schedule while manager plus defender schedules one personal plan', () => {
  const manager = fixture({
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  manager.connect();
  manager.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 3
  });
  manager.controller.handleMessage({
    t: 'defenseOrderAccepted', order: {
      id: 'order-1', revision: 3, counts: { targetedProfiles: 20 }
    }
  });
  assert.equal(manager.schedules.length, 0);
  assert.equal(manager.ackEntries.length, 0);

  const dual = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  dual.connect();
  dual.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  assert.equal(dual.schedules.length, 1);
  assert.equal(dual.schedules[0].length, 1);
  assert.equal(dual.schedules[0][0].id, 'defense:order-1:3:900000001');
});

test('a locally missed reconnect never schedules, backfills, or forges a canonical too_late ACK', () => {
  const f = fixture({
    confirmed: profile(), nowMs: 1_080_001,
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  assert.equal(f.schedules.length, 0);
  assert.deepEqual(f.ackEntries.filter(entry => entry.payload), []);
  assert.equal(f.controller.state().personal.phase, 'too_late');
});

test('a canonically Too-late audience target reports only too_late and stays silent', () => {
  const f = fixture({
    confirmed: profile(), nowMs: 1_060_000,
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder({ tooLate: true, goAtMs: 1_050_000 }),
    readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  assert.equal(f.schedules.length, 0);
  assert.deepEqual(
    f.ackEntries.filter(entry => entry.payload).map(entry => entry.payload.outcome),
    ['too_late']
  );
});

test('clock-stale devices ACK precisely and replan future cues after drift recovery', () => {
  const f = fixture({
    confirmed: profile(), clockFresh: false,
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  assert.equal(f.schedules.length, 0);
  assert.ok(f.ackEntries.some(entry => entry.payload && entry.payload.outcome === 'clock_stale'));

  f.setClockFresh(true);
  f.controller.clockChanged({ fresh: true, offsetMs: 420 });
  f.confirmDeviceStatus();
  assert.deepEqual(f.driftCancellations, [[420, 300]]);
  assert.equal(f.schedules.length, 1);
  assert.ok(f.ackEntries.some(entry => entry.payload && entry.payload.outcome === 'scheduled'));
});

test('an interrupted audio clock cancels stale absolute nodes and replans only future cues on recovery', () => {
  const f = fixture({
    nowMs: 1_060_000,
    audioNowMs: 1_060_000,
    confirmed: profile(),
    realCueScheduler: true,
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  const initiallyScheduled = f.schedules.length;
  assert.ok(initiallyScheduled > 6, 'the initial absolute plan includes the early warning cues');

  f.setAudioState({ userEnabled: true, audioContextRunning: false, carrierAlive: false });
  assert.ok(f.cancellations.some(value => String(value).startsWith('audio:')),
    'suspending or losing the carrier cancels the stale Web Audio timeline');

  f.setNow(1_075_000);
  f.setAudioState({ userEnabled: true, audioContextRunning: true, carrierAlive: true });
  assert.ok(f.schedules.length > initiallyScheduled,
    'recovery creates a fresh absolute plan against the resumed audio clock');
  assert.ok(f.schedules.length - initiallyScheduled <= 6,
    'only T-5 through exact Now remain eligible after the wall clock advanced');
  f.confirmDeviceStatus();
  assert.equal(f.ackEntries.at(-1).payload.outcome, 'scheduled');
});

test('a backward clock correction after exact Now never schedules or presents Now twice', () => {
  const f = fixture({
    nowMs: 1_079_800,
    audioNowMs: 1_079_800,
    confirmed: profile(),
    realCueScheduler: true,
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  assert.equal(f.schedules.length, 1, 'only exact Now remains on the first absolute plan');

  f.setNow(1_080_050);
  f.setAudioNow(1_080_050);
  f.controller.tick();
  assert.equal(f.controller.state().personal.phase, 'now');

  f.setNow(1_079_800);
  f.controller.clockChanged({ fresh: true, offsetMs: 500 });
  assert.equal(f.schedules.length, 1,
    'the already-consumed Now cue is not recreated after a backward correction');
  assert.notEqual(f.controller.state().personal.phase, 'countdown',
    'the visible personal state never rewinds to a second countdown');
});

test('an exact-T0 observation consumes a preplanned Now before a backward correction', () => {
  const f = fixture({
    nowMs: 1_079_800,
    audioNowMs: 1_079_800,
    confirmed: profile(),
    realCueScheduler: true,
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  assert.equal(f.schedules.length, 1);

  f.setNow(1_080_000);
  f.setAudioNow(1_080_000);
  f.controller.tick();
  assert.equal(f.controller.state().personal.phase, 'now');
  f.setNow(1_079_800);
  f.controller.clockChanged({ fresh: true, offsetMs: 500 });
  assert.equal(f.schedules.length, 1,
    'an exact-boundary Now that was already preplanned cannot be recreated');
  assert.equal(f.controller.state().personal.phase, 'now',
    'the visible state stays at the already-consumed Now boundary instead of rewinding');
});

test('the farthest valid GO uses a 420-second scheduling window', () => {
  const f = fixture({
    confirmed: profile(), nowMs: 1_000_000,
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile({ march: 5 }),
    activeOrderForOwnProfile: personalOrder({
      signalAtMs: 1_000_000, acceptedAtMs: 1_000_000,
      tapAnchorSeconds: 300, enemyMarchSeconds: 120,
      enemyLaunchAtMs: 1_300_000, enemyImpactAtMs: 1_420_000,
      goAtMs: 1_415_000, completeAtMs: 1_416_000,
      march: 5
    }), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  assert.deepEqual(f.scheduleBehaviors, [{ windowMs: 420_000 }]);
  assert.ok(f.ackEntries.some(entry => entry.payload && entry.payload.outcome === 'scheduled'));
});

test('scheduled ACK requires every future cue key, never a partial scheduler success', () => {
  const f = fixture({
    confirmed: profile(), missingCueId: 'count-3',
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  const outcomes = f.ackEntries.filter(entry => entry.payload).map(entry => entry.payload.outcome);
  assert.deepEqual(outcomes, ['schedule_failed']);
  assert.equal(outcomes.includes('scheduled'), false);
});

test('a stalled exact-Now tombstone is never reported as a scheduled local alert', () => {
  const f = fixture({
    nowMs: 1_080_000,
    confirmed: profile(),
    realCueScheduler: true,
    schedulerLagMs: 151,
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  assert.deepEqual(
    f.ackEntries.filter(entry => entry.payload).map(entry => entry.payload.outcome),
    ['schedule_failed'],
    'a node-less anti-replay tombstone is not a delivered local cue'
  );
  assert.equal(f.schedules.length, 0, 'the missed exact-Now cue never reached Web Audio');
  f.setNow(1_080_151);
  f.controller.tick();
  assert.equal(f.controller.state().personal.phase, 'too_late',
    'the client cannot paint a false Now after the local cue was missed');
});

test('a transient partial scheduler failure retries the complete plan before GO', () => {
  const f = fixture({
    confirmed: profile(), missingCueId: 'count-3',
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  assert.equal(f.ackEntries.at(-1).payload.outcome, 'schedule_failed');

  f.allowAllCues();
  f.setNow(1_060_999);
  f.controller.tick();
  assert.equal(f.schedules.length, 1, 'retry is rate-limited to one second');
  f.setNow(1_061_000);
  f.controller.tick();
  assert.equal(f.schedules.length, 2);
  assert.equal(f.ackEntries.at(-1).payload.outcome, 'scheduled');
});

test('canonical cancel and completion clear only that order and restore automatic waiting', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.controller.handleMessage({ t: 'defenseOrderCancelled', orderId: 'other', revision: 4 });
  assert.equal(f.controller.state().personal.captured, true);

  f.controller.handleMessage({ t: 'defenseOrderCancelled', orderId: 'order-1', revision: 4 });
  assert.equal(f.controller.state().personal.phase, 'waiting');
  assert.equal(f.controller.state().announcement.kind, 'cancelled');
  assert.equal(f.controller.state().announcement.key, 'order-1:4');
  assert.ok(f.cancellations.includes('defense:order-1:3:900000001'));

  f.setNow(2_060_000);
  f.controller.handleMessage({
    t: 'defenseOrderAccepted', order: personalOrder({
      id: 'order-2', revision: 5, signalAtMs: 1_900_000,
      enemyLaunchAtMs: 2_080_000, enemyImpactAtMs: 2_110_000,
      completeAtMs: 2_081_000, goAtMs: 2_080_000
    })
  });
  assert.equal(f.controller.state().personal.id, 'order-2');
  assert.equal(f.controller.state().announcement, null);
  assert.equal(f.schedules.length, 2, 'the next round automatically becomes ready');
  f.controller.handleMessage({ t: 'defenseOrderCompleted', orderId: 'order-2', revision: 6 });
  assert.equal(f.controller.state().personal.phase, 'waiting');
  assert.equal(f.controller.state().announcement.kind, 'completed');
});

test('live-region projection clears stale timing text and announces canonical cancellation once', () => {
  const strings = { prepare: 'Prepare', now: 'Now', cancelled: 'Order cancelled' };
  const countdown = DefenseController.liveRegionProjection({
    captured: true, planId: 'defense:o:1:p', phase: 'countdown', remainingMs: 3_000
  }, null, strings);
  assert.equal(countdown.text, '3');
  assert.equal(DefenseController.liveRegionProjection({
    captured: true, planId: 'defense:o:1:p', phase: 'now', remainingMs: 0
  }, null, strings).text, 'Now');
  const waiting = DefenseController.liveRegionProjection({ captured: false, phase: 'waiting' }, null, strings);
  assert.equal(waiting.text, '', 'waiting clears a stale digit or Now');
  const complete = DefenseController.liveRegionProjection({
    captured: true, planId: 'defense:o:1:p', phase: 'complete', remainingMs: 0
  }, null, strings);
  assert.equal(complete.text, '', 'local completion clears stale Now');
  const cancelled = DefenseController.liveRegionProjection(
    { captured: false, phase: 'waiting' }, { kind: 'cancelled', key: 'o:2' }, strings
  );
  assert.equal(cancelled.text, 'Order cancelled');
  assert.equal(cancelled.key,
    DefenseController.liveRegionProjection(
      { captured: false, phase: 'waiting' }, { kind: 'cancelled', key: 'o:2' }, strings
    ).key, 'stable keys prevent repeated high-frequency announcements');
  const canonicalComplete = DefenseController.liveRegionProjection(
    { captured: false, phase: 'waiting' }, { kind: 'completed', key: 'o:3' },
    { ...strings, complete: 'Alert complete' }
  );
  assert.equal(canonicalComplete.text, '',
    'canonical completion is visual only and never adds an unapproved live announcement');
});

test('ACK confirmation is scoped to the exact order/profile/device key', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.controller.handleMessage({
    t: 'defenseAckSaved', orderId: 'order-1', revision: 3,
    pid: '900000001', deviceId: DEVICE_ID, outcome: 'scheduled'
  });
  assert.ok(f.ackEntries.some(entry => entry.confirmed ===
    `order-1:3:900000001:${DEVICE_ID}`));
});

test('an ACK accepted for retry survives an initially failed transport send', () => {
  const f = fixture({
    confirmed: profile(), realAckQueue: true,
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  f.setTransportSendEnabled(false);
  f.controller.handleMessage({ t: 'defenseOrderAccepted', order: personalOrder() });
  assert.equal(f.sent.filter(message => message.t === 'defenseOrderAck').length, 1,
    'the queue makes its first transport attempt immediately');
  f.setTransportSendEnabled(true);
  f.runAckTimers();
  assert.equal(f.sent.filter(message => message.t === 'defenseOrderAck').length, 2,
    'the pending queue retries after the original transport attempt failed');
  assert.equal(f.controller.handleMessage({
    t: 'defenseAckSaved', orderId: 'order-1', revision: 3,
    pid: '900000001', deviceId: DEVICE_ID, outcome: 'scheduled'
  }), true, 'the matching saved receipt confirms the queued scheduled outcome');

  f.setNow(1_080_500);
  f.controller.tick();
  assert.equal(f.controller.state().personal.phase, 'now',
    'a locally scheduled and server-confirmed retry still presents the exact Now state');
});

test('a stale failure receipt cannot confirm a newer scheduled ACK for the same device key', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: false }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.confirmDeviceStatus();
  assert.equal(f.ackEntries.at(-1).payload.outcome, 'audio_unready');

  f.setAudioState({ userEnabled: true, audioContextRunning: true, carrierAlive: true });
  f.confirmDeviceStatus();
  assert.equal(f.ackEntries.at(-1).payload.outcome, 'scheduled');
  const before = f.ackEntries.filter(entry => entry.confirmed).length;
  f.controller.handleMessage({
    t: 'defenseAckSaved', orderId: 'order-1', revision: 3,
    pid: '900000001', deviceId: DEVICE_ID, outcome: 'audio_unready'
  });
  assert.equal(f.ackEntries.filter(entry => entry.confirmed).length, before,
    'the old failure receipt does not stop retrying the newer scheduled payload');
  f.controller.handleMessage({
    t: 'defenseAckSaved', orderId: 'order-1', revision: 3,
    pid: '900000001', deviceId: DEVICE_ID, outcome: 'scheduled'
  });
  assert.equal(f.ackEntries.filter(entry => entry.confirmed).length, before + 1);
});

test('a locally scheduled order presents Now for one bounded second without rescheduling audio', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  assert.equal(f.schedules.length, 1);
  f.setNow(1_080_500);
  f.controller.tick();
  assert.equal(f.controller.state().personal.phase, 'now');
  assert.equal(f.controller.state().personal.remainingMs, 0);
  assert.equal(f.schedules.length, 1, 'painting Now never schedules a second cue plan');
  f.setNow(1_081_001);
  f.controller.tick();
  assert.equal(f.controller.state().personal.phase, 'complete');
  assert.equal(f.controller.state().personal.tooLate, false);
});

test('profile errors settle pending work, preserve the draft, and re-fetch canonical state', () => {
  const f = fixture();
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: null,
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  f.controller.confirmProfile({
    identityMode: 'nickname', name: 'Draft Defender', march: 31
  });
  const registration = f.sent.at(-1);
  f.controller.handleMessage({
    t: 'error', source: 'registerPlayer', mutationId: registration.registrationId,
    error: 'roster_full'
  });
  const state = f.controller.state();
  assert.equal(state.pendingRegistration.blocked, true);
  assert.equal(state.pendingRegistration.sent, false);
  assert.equal(state.draft.name, 'Draft Defender');
  assert.equal(state.lastError.source, 'registerPlayer');
  assert.equal(state.lastError.error, 'roster_full');
  assert.equal(state.lastError.retryable, false);
  assert.equal(f.sent.at(-1).t, 'hello', 'the client asks for fresh canonical state once');
});

test('permanent ACK rejection stops that queue entry while persistence failure remains retryable', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  f.controller.handleMessage({
    t: 'error', source: 'defenseOrderAck', error: 'ack_window_closed',
    orderId: 'order-1', orderRevision: 3, pid: '900000001', deviceId: DEVICE_ID,
    outcome: 'scheduled'
  });
  assert.ok(f.ackEntries.some(entry => entry.rejected ===
    `order-1:3:900000001:${DEVICE_ID}` && entry.reason.terminal === true));

  const retryable = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  retryable.connect();
  retryable.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: personalOrder(), readiness: {}, orderRevision: 3
  });
  retryable.controller.handleMessage({ t: 'error', source: 'defenseOrderAck', error: 'ack_persist_failed' });
  assert.equal(retryable.ackEntries.some(entry => entry.rejected), false);
  assert.equal(retryable.controller.state().lastError.retryable, true);
});

test('device-status rejection stays red through aggregate presence and recovers only on exact saved status', () => {
  const f = fixture({
    confirmed: profile(),
    audioState: { userEnabled: true, audioContextRunning: true, carrierAlive: true }
  });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  f.confirmDeviceStatus();
  assert.equal(f.controller.state().readiness.green, true);
  f.controller.handleMessage({
    t: 'error', source: 'defenseDeviceStatus', error: 'device_status_persist_failed'
  });
  assert.equal(f.controller.state().readiness.green, false);
  assert.ok(f.controller.state().readiness.reasons.includes('device_status_unconfirmed'));
  f.controller.handleMessage({
    t: 'defensePresenceDelta', pid: '900000001', connectedDevices: 1,
    audioReadyDevices: 1, clockFreshDevices: 1
  });
  assert.equal(f.controller.state().readiness.green, false,
    'aggregate sibling-tab presence cannot confirm this device');
  const beforeRetry = f.sent.length;
  assert.equal(f.controller.heartbeat(), true);
  assert.equal(f.sent.length, beforeRetry + 1);
  assert.equal(f.sent.at(-1).t, 'defenseDeviceStatus',
    'the bounded heartbeat retries the full status that can receive an exact saved receipt');
  assert.equal(f.controller.state().readiness.green, false,
    'sending the retry alone cannot turn this device green');
  f.confirmDeviceStatus();
  assert.equal(f.controller.state().readiness.green, true);
});

test('unrelated snapshots and reconnects never swallow an in-flight profile edit draft', () => {
  const f = fixture({ confirmed: profile() });
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  f.controller.confirmProfile({
    identityMode: 'nickname', name: 'Edited Draft', march: 44
  });
  const mutation = f.sent.at(-1);
  assert.equal(mutation.t, 'updateOwnProfile');

  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile(),
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  assert.equal(f.controller.state().pendingUpdate.mutationId, mutation.mutationId);
  assert.equal(f.controller.state().draft.name, 'Edited Draft');

  f.disconnect();
  f.nextGeneration();
  f.connect();
  f.controller.handleMessage({
    t: 'defenseState', config: {}, ownProfile: profile({ revision: 1, march: 35 }),
    activeOrderForOwnProfile: null, readiness: {}, orderRevision: 0
  });
  assert.equal(f.controller.state().pendingUpdate.blocked, true);
  assert.equal(f.controller.state().draft.name, 'Edited Draft');
  assert.equal(f.sent.filter(message => message.t === 'updateOwnProfile').length, 1,
    'an uncertain previous mutation is never silently replayed against a new revision');

  f.controller.confirmProfile({
    identityMode: 'nickname', name: 'Edited Draft', march: 44
  });
  const retry = f.sent.at(-1);
  assert.equal(retry.t, 'updateOwnProfile');
  assert.equal(retry.baseRevision, 1);
  assert.notEqual(retry.mutationId, mutation.mutationId);
});
