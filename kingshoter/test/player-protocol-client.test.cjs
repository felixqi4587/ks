const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/rally-controller.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/rally.html'), 'utf8');

test('Rally profile persistence is a compatibility adapter over BattleIdentity', () => {
  assert.match(html, /battle-identity\.js\?v=2026071701/);
  assert.ok(
    html.indexOf('/battle-identity.js?v=2026071701') < html.indexOf('/rally-controller.js?v=2026071701'),
    'identity module loads before the Rally controller'
  );
  assert.match(source, /BattleIdentity\.createIdentityStore\(\{[\s\S]{0,240}room:\s*ROOM[\s\S]{0,240}surface:\s*["']rally["']/);
  assert.match(source, /myProfile\s*=\s*identityStore\.readConfirmed\(\)/);
  assert.match(source, /deviceId\s*=\s*identityStore\.deviceId\(\)/);
  assert.match(extractFunction('saveProfile'), /identityStore\.saveConfirmed\(profile\)/);
  assert.doesNotMatch(extractFunction('saveProfile'), /localStorage|LS\(["']me["']\)/);
});

test('Rally identity storage retains fail-closed access when browser storage is unavailable', () => {
  assert.match(source, /var\s+identityStorage\s*=\s*\{/);
  assert.match(source, /getItem:\s*function\s*\(key\)\s*\{\s*return\s+rd\(key,\s*null\);\s*\}/);
  assert.match(source, /storage:\s*identityStorage/);
  assert.doesNotMatch(source, /storage:\s*localStorage/);
});

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function identityMismatchHarness() {
  const toasts = [];
  const classes = [];
  const sandbox = {
    pendingMarchMutation: { mutationId: 'march-save-1' },
    pendingRegistrationProfile: null,
    registrationPending: false,
    draftActive: false,
    nicknameDraftRoutingKey: 'nickname-key',
    myProfile: { pid: '001', name: 'Player', march: 40, marchRevision: 0 },
    identityMode: 'playerId',
    cancelIdentityLookup() {},
    showExistingIdentity() { sandbox.identityRestored = true; },
    syncIdentityControls() {},
    tk(key) { return key; },
    window: { toast(message) { toasts.push(message); } },
    sock: { refresh() { sandbox.refreshes += 1; } },
    $(id) {
      return {
        classList: {
          remove(name) { classes.push(`${id}:remove:${name}`); },
          add(name) { classes.push(`${id}:add:${name}`); }
        }
      };
    },
    identityRestored: false,
    refreshes: 0,
    toasts,
    classes
  };
  vm.runInNewContext(
    `${extractFunction('restoreResolvedPlayerName')}\n${extractFunction('armPendingRegistrationRetry')}\n${extractFunction('handlePlayerProtocolError')}\n` +
    'this.handlePlayerProtocolError = handlePlayerProtocolError;',
    sandbox
  );
  return sandbox;
}

function profileAckHarness() {
  const pending = {
    mutationId: 'profile-save-1',
    pid: 'opaque-route',
    identityMode: 'playerId',
    playerId: '900000777',
    name: 'Resolved Player',
    requestedMarch: 47,
    baseRevision: 2,
    ackSeen: false,
    stateSeen: false
  };
  const sandbox = {
    pendingMarchMutation: pending,
    settlements: 0,
    handlePlayerRegistrationAck() { return false; },
    handleKingdomNameMessage() { return false; },
    handleRallyModeMessage() { return false; },
    handleStageSuperseded() { return false; },
    handleDeviceStatusSaved() { return false; },
    handleDeliveryAckSaved() { return false; },
    handleCommanderMarchAck() { return false; },
    settlePendingMarchMutation() { sandbox.settlements += 1; }
  };
  vm.runInNewContext(`${extractFunction('profileMatchesPending')}\n${extractFunction('handleSocketMessage')}\nthis.handleSocketMessage = handleSocketMessage;`, sandbox);
  return sandbox;
}

function profileSettlementHarness() {
  const pending = {
    mutationId: 'profile-save-1',
    pid: 'opaque-route',
    identityMode: 'playerId',
    playerId: '900000777',
    name: 'Resolved Player',
    requestedMarch: 47,
    baseRevision: 2,
    ackSeen: false,
    stateSeen: false,
    draftVersion: 4,
    canonicalPlayer: null
  };
  const sandbox = {
    pendingMarchMutation: pending,
    draftVersion: 4,
    draftActive: true,
    myProfile: { pid: 'opaque-route', name: 'Old Canonical', march: 41, marchRevision: 2 },
    viewMode: 'attack',
    adoptions: 0,
    cards: 0,
    controls: [],
    toasts: [],
    handlePlayerRegistrationAck() { return false; },
    handleKingdomNameMessage() { return false; },
    handleRallyModeMessage() { return false; },
    handleStageSuperseded() { return false; },
    handleDeviceStatusSaved() { return false; },
    handleDeliveryAckSaved() { return false; },
    handleCommanderMarchAck() { return false; },
    adoptCanonicalPlayer() { sandbox.adoptions += 1; },
    syncIdentityControls(locked) { sandbox.controls.push(locked); },
    showInCard() { sandbox.cards += 1; },
    renderDefense() {},
    tk(key) { return key; },
    window: {
      mmss(value) { return String(value); },
      toast(message) { sandbox.toasts.push(message); }
    }
  };
  vm.runInNewContext(`${extractFunction('settlePendingMarchMutation')}\n${extractFunction('profileMatchesPending')}\n${extractFunction('handleSocketMessage')}\nthis.settlePendingMarchMutation = settlePendingMarchMutation;\nthis.handleSocketMessage = handleSocketMessage;`, sandbox);
  return sandbox;
}

function profileBindingQueueHarness({ bound = false, connected = true } = {}) {
  const messages = [];
  const pending = {
    mutationId: 'profile-save-queued',
    pid: 'opaque-route',
    identityMode: 'playerId',
    playerId: '900000777',
    name: 'Resolved Player',
    requestedMarch: 47,
    baseRevision: 2,
    profileKey: '20000000-0000-4000-8000-000000000002',
    connectionGeneration: 8,
    awaitingDeviceStatus: false
  };
  const sandbox = {
    pendingMarchMutation: pending,
    myPid: pending.pid,
    deviceId: '30000000-0000-4000-8000-000000000003',
    lastDeviceStatusGeneration: bound ? 8 : 7,
    lastDeviceStatusSignature: bound
      ? 'opaque-route:30000000-0000-4000-8000-000000000003:1'
      : '',
    sock: {
      connected,
      connectionGeneration: 8,
      send(message) { messages.push(structuredClone(message)); return true; }
    },
    statusRequests: 0,
    sendDeviceStatus() { sandbox.statusRequests += 1; return true; },
    deliveryAckQueue: { snapshot() { return []; } },
    resumeRejectedDeliveryAck() {},
    messages
  };
  vm.runInNewContext(
    `${extractFunction('deviceStatusBoundForProfile')}\n` +
    `${extractFunction('sendPendingOwnProfileMutation')}\n` +
    `${extractFunction('handleDeviceStatusSaved')}\n` +
    'this.deviceStatusBoundForProfile = deviceStatusBoundForProfile; ' +
    'this.sendPendingOwnProfileMutation = sendPendingOwnProfileMutation; ' +
    'this.handleDeviceStatusSaved = handleDeviceStatusSaved;',
    sandbox
  );
  return sandbox;
}

function profileErrorHarness() {
  const classes = [];
  const sandbox = {
    pendingMarchMutation: {
      mutationId: 'profile-save-1', pid: 'opaque-route', identityMode: 'playerId',
      playerId: '900000777', name: 'Resolved Player', requestedMarch: 47, baseRevision: 2
    },
    pendingRegistrationProfile: null,
    registrationPending: false,
    draftActive: false,
    nicknameDraftRoutingKey: 'nickname-key',
    myProfile: {
      pid: 'opaque-route', identityMode: 'nickname', name: 'Old Canonical',
      march: 41, marchRevision: 2, editable: true,
      profileKey: '20000000-0000-4000-8000-000000000002'
    },
    identityMode: 'playerId',
    cancelIdentityLookup() { sandbox.lookupsCancelled += 1; },
    saveProfile(profile) { sandbox.myProfile = profile; sandbox.savedProfiles.push(profile); },
    showInCard() { sandbox.cards += 1; },
    showExistingIdentity() { sandbox.identityRestored = true; },
    syncIdentityControls() { sandbox.controlsSynced += 1; },
    tk(key) { return key; },
    window: { toast(message) { sandbox.toasts.push(message); } },
    sock: { refresh() { sandbox.refreshes += 1; } },
    $(id) {
      return {
        value: id === 'pid' ? '900000777' : '',
        dataset: {},
        classList: {
          remove(name) { classes.push(`${id}:remove:${name}`); },
          add(name) { classes.push(`${id}:add:${name}`); }
        }
      };
    },
    identityRestored: false,
    controlsSynced: 0,
    lookupsCancelled: 0,
    refreshes: 0,
    cards: 0,
    savedProfiles: [],
    toasts: [],
    classes
  };
  vm.runInNewContext(
    `${extractFunction('restoreResolvedPlayerName')}\n${extractFunction('armPendingRegistrationRetry')}\n${extractFunction('handlePlayerProtocolError')}\n` +
    'this.handlePlayerProtocolError = handlePlayerProtocolError;',
    sandbox
  );
  return sandbox;
}

function registrationSettlementHarness() {
  const pending = {
    registrationId: 'registration-1', pid: '900000111', identityMode: 'playerId',
    playerId: '900000111', name: 'Captain', march: 42, profileKey: '10000000-0000-4000-8000-000000000001',
    draftVersion: 3, ackSeen: false, stateSeen: false, canonicalPlayer: null, editable: null
  };
  const sandbox = {
    pendingRegistrationProfile: pending,
    registrationPending: true,
    draftVersion: 3,
    draftActive: true,
    ownPlayerSeen: false,
    myProfile: null,
    myPid: '',
    deviceId: 'device-1',
    ROOM: 'qa-kvk-registration-client',
    nicknameDraftRoutingKey: 'nickname-route',
    viewMode: 'attack',
    saves: [],
    cards: 0,
    existing: 0,
    deviceStatuses: 0,
    toasts: [],
    saveProfile(profile) { sandbox.myProfile = profile; sandbox.myPid = profile && profile.pid || ''; sandbox.saves.push(profile); },
    cancelIdentityLookup() {},
    sendDeviceStatus() { sandbox.deviceStatuses += 1; },
    showInCard() { sandbox.cards += 1; },
    showExistingIdentity() { sandbox.existing += 1; },
    renderDefense() {},
    tk(key) { return key; },
    window: {
      getRoomDeviceId() { return 'device-2'; },
      mmss(value) { return String(value); },
      toast(message) { sandbox.toasts.push(message); }
    }
  };
  vm.runInNewContext(
    `${extractFunction('acceptPendingRegistration')}\n${extractFunction('handlePlayerRegistrationAck')}\n` +
    'this.acceptPendingRegistration = acceptPendingRegistration; this.handlePlayerRegistrationAck = handlePlayerRegistrationAck;',
    sandbox
  );
  return sandbox;
}

function pendingRegistrationRetryHarness(sendResult = true) {
  const pending = {
    registrationId: 'registration-uncertain', pid: '900000222', identityMode: 'playerId',
    playerId: '900000222', name: 'Delayed Captain', march: 44,
    profileKey: '10000000-0000-4000-8000-000000000002',
    draftVersion: 5, ackSeen: true, stateSeen: true,
    canonicalPlayer: { name: 'Delayed Captain', march: 44 }, editable: true,
    everSent: true, manualRetry: false
  };
  const sandbox = {
    pendingRegistrationProfile: pending,
    registrationPending: false,
    draftActive: false,
    sock: {
      send(message) { sandbox.messages.push(message); return sendResult; }
    },
    messages: [],
    controls: [],
    toasts: [],
    syncIdentityControls(locked) { sandbox.controls.push(locked); },
    restoreResolvedPlayerName() {},
    tk(key) { return key; },
    window: { toast(message) { sandbox.toasts.push(message); } }
  };
  vm.runInNewContext(
    `${extractFunction('armPendingRegistrationRetry')}\n${extractFunction('resetPendingRegistrationConnectionEvidence')}\n` +
    `${extractFunction('registerPendingProfile')}\n${extractFunction('reconcileMissingPendingRegistration')}\n` +
    'this.armPendingRegistrationRetry = armPendingRegistrationRetry; ' +
    'this.resetPendingRegistrationConnectionEvidence = resetPendingRegistrationConnectionEvidence; ' +
    'this.registerPendingProfile = registerPendingProfile; ' +
    'this.reconcileMissingPendingRegistration = reconcileMissingPendingRegistration;',
    sandbox
  );
  return sandbox;
}

test('identity copy and placeholders contain no testing-only qualifier', () => {
  assert.doesNotMatch(html, /For testing|测试用/);
  assert.doesNotMatch(source, /For testing|测试用|identity_testing/);
});

test('roster search indexes explicit profile Player ID without replacing routing keys', () => {
  const renderRoster = extractFunction('renderRoster');
  assert.match(renderRoster, /p\.playerId/);
  assert.match(renderRoster, /p\.pid/);
});

test('profile save ACK matches every canonical identity field before settling', () => {
  const canonical = {
    t: 'playerProfileSaved', mutationId: 'profile-save-1', pid: 'opaque-route',
    identityMode: 'playerId', playerId: '900000777', name: 'Resolved Player',
    march: 47, revision: 3
  };
  const h = profileAckHarness();

  h.handleSocketMessage(canonical);

  assert.equal(h.pendingMarchMutation.ackSeen, true);
  assert.equal(h.settlements, 1);

  for (const [field, value] of [
    ['pid', 'other-route'],
    ['identityMode', 'nickname'],
    ['playerId', '900000778'],
    ['name', 'Other Name'],
    ['march', 48],
    ['revision', 4]
  ]) {
    const mismatch = profileAckHarness();
    mismatch.handleSocketMessage(Object.assign({}, canonical, { [field]: value }));
    assert.equal(mismatch.pendingMarchMutation.ackSeen, false, `${field} mismatch must not acknowledge`);
    assert.equal(mismatch.settlements, 0, `${field} mismatch must not settle`);
  }

  const legacyMarchAck = profileAckHarness();
  legacyMarchAck.handleSocketMessage({
    t: 'playerMarchSaved', mutationId: 'profile-save-1', pid: 'opaque-route',
    march: 47, revision: 3
  });
  assert.equal(legacyMarchAck.pendingMarchMutation.ackSeen, false, 'profile updates require the canonical playerProfileSaved ACK');
  assert.equal(legacyMarchAck.settlements, 0);
});

test('nickname canonical matches only when playerId metadata is absent', () => {
  const h = profileAckHarness();
  Object.assign(h.pendingMarchMutation, {
    identityMode: 'nickname', playerId: undefined, name: 'Tester Two'
  });
  const canonical = {
    t: 'playerProfileSaved', mutationId: 'profile-save-1', pid: 'opaque-route',
    identityMode: 'nickname', name: 'Tester Two', march: 47, revision: 3
  };

  h.handleSocketMessage(canonical);
  assert.equal(h.pendingMarchMutation.ackSeen, true);

  const stalePlayerId = profileAckHarness();
  Object.assign(stalePlayerId.pendingMarchMutation, {
    identityMode: 'nickname', playerId: undefined, name: 'Tester Two'
  });
  stalePlayerId.handleSocketMessage(Object.assign({}, canonical, { playerId: '900000777' }));
  assert.equal(stalePlayerId.pendingMarchMutation.ackSeen, false);
});

test('profile save settles only after matching ACK and state in either arrival order', () => {
  const ack = {
    t: 'playerProfileSaved', mutationId: 'profile-save-1', pid: 'opaque-route',
    identityMode: 'playerId', playerId: '900000777', name: 'Resolved Player',
    march: 47, revision: 3
  };
  const canonicalPlayer = {
    identityMode: 'playerId', playerId: '900000777', name: 'Resolved Player',
    march: 47, marchRevision: 3
  };

  const ackFirst = profileSettlementHarness();
  ackFirst.handleSocketMessage(ack);
  assert.equal(ackFirst.pendingMarchMutation.ackSeen, true);
  assert.equal(ackFirst.pendingMarchMutation.stateSeen, false);
  assert.equal(ackFirst.cards, 0, 'ACK alone cannot settle');
  ackFirst.pendingMarchMutation.stateSeen = true;
  ackFirst.pendingMarchMutation.canonicalPlayer = canonicalPlayer;
  ackFirst.settlePendingMarchMutation();
  assert.equal(ackFirst.pendingMarchMutation, null);
  assert.equal(ackFirst.cards, 1);
  assert.equal(ackFirst.adoptions, 1);

  const stateFirst = profileSettlementHarness();
  stateFirst.pendingMarchMutation.stateSeen = true;
  stateFirst.pendingMarchMutation.canonicalPlayer = canonicalPlayer;
  stateFirst.settlePendingMarchMutation();
  assert.notEqual(stateFirst.pendingMarchMutation, null, 'state alone cannot settle');
  assert.equal(stateFirst.cards, 0);
  stateFirst.handleSocketMessage(ack);
  assert.equal(stateFirst.pendingMarchMutation, null);
  assert.equal(stateFirst.cards, 1);
  assert.equal(stateFirst.adoptions, 1);
});

test('profile edits wait for this socket generation to bind before sending', () => {
  const h = profileBindingQueueHarness();

  assert.equal(h.sendPendingOwnProfileMutation(), true, 'the explicit save is queued while binding');
  assert.equal(h.pendingMarchMutation.awaitingDeviceStatus, true);
  assert.notEqual(h.pendingMarchMutation.sent, true);
  assert.equal(h.statusRequests, 1, 'the queue actively requests the current generation binding');
  assert.deepEqual(h.messages, [], 'the profile mutation cannot outrun deviceStatusSaved');

  assert.equal(h.handleDeviceStatusSaved({
    t: 'deviceStatusSaved',
    pid: h.myPid,
    deviceId: h.deviceId,
    soundReady: false
  }), true);
  assert.equal(h.pendingMarchMutation.awaitingDeviceStatus, false);
  assert.equal(h.pendingMarchMutation.sent, true);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0], {
    t: 'updateOwnProfile',
    mutationId: 'profile-save-queued',
    pid: 'opaque-route',
    identityMode: 'playerId',
    playerId: '900000777',
    name: 'Resolved Player',
    march: 47,
    baseRevision: 2,
    profileKey: '20000000-0000-4000-8000-000000000002'
  });

  h.handleDeviceStatusSaved({
    t: 'deviceStatusSaved',
    pid: h.myPid,
    deviceId: h.deviceId,
    soundReady: true
  });
  assert.equal(h.messages.length, 1, 'later readiness upgrades cannot duplicate the mutation');
});

test('an unsent queued edit survives a reconnect and sends after the replacement socket binds', () => {
  const h = profileBindingQueueHarness();
  h.sendPendingOwnProfileMutation();

  h.sock.connectionGeneration = 9;
  h.pendingMarchMutation.connectionGeneration = 9;
  h.pendingMarchMutation.awaitingReconnect = true;
  assert.equal(h.handleDeviceStatusSaved({
    t: 'deviceStatusSaved',
    pid: h.myPid,
    deviceId: h.deviceId,
    soundReady: true
  }), true);

  assert.equal(h.messages.length, 1);
  assert.equal(h.pendingMarchMutation.sent, true);
  assert.equal(h.pendingMarchMutation.awaitingReconnect, false,
    'the first real send on the replacement connection starts a fresh settlement window');
});

test('only a mutation actually sent before reconnect may infer its ACK from a fresh snapshot', () => {
  const sandbox = {};
  vm.runInNewContext(
    `${extractFunction('sentProfileMutationHasFreshReconnectSnapshot')}\n` +
    'this.hasEvidence = sentProfileMutationHasFreshReconnectSnapshot;',
    sandbox
  );
  const pending = { sent: false, awaitingReconnect: true, reconnectAfterSnapshot: 4 };

  assert.equal(sandbox.hasEvidence(pending, true, 5), false,
    'a matching snapshot cannot acknowledge an edit that never left the browser');
  pending.sent = true;
  assert.equal(sandbox.hasEvidence(pending, true, 5), true);
  assert.equal(sandbox.hasEvidence(pending, false, 5), false);
  assert.equal(sandbox.hasEvidence(pending, true, 4), false);
});

test('an already-bound profile edit sends immediately while a closed socket fails normally', () => {
  const bound = profileBindingQueueHarness({ bound: true });
  assert.equal(bound.sendPendingOwnProfileMutation(), true);
  assert.equal(bound.statusRequests, 0);
  assert.equal(bound.messages.length, 1);

  const closed = profileBindingQueueHarness({ connected: false });
  assert.equal(closed.sendPendingOwnProfileMutation(), false);
  assert.equal(closed.pendingMarchMutation.awaitingDeviceStatus, false);
  assert.equal(closed.statusRequests, 0);
  assert.equal(closed.messages.length, 0);
});

test('registration persists an editable capability only after its exact ACK and canonical state', () => {
  const player = {
    identityMode: 'playerId', playerId: '900000111', name: 'Captain', march: 42, marchRevision: 0
  };
  const ack = {
    t: 'playerRegistered', registrationId: 'registration-1', pid: '900000111',
    created: true, editable: true
  };

  const stateFirst = registrationSettlementHarness();
  stateFirst.acceptPendingRegistration(player);
  assert.equal(stateFirst.pendingRegistrationProfile.stateSeen, true);
  assert.equal(stateFirst.saves.length, 0, 'canonical state alone cannot claim edit ownership');
  assert.equal(stateFirst.handlePlayerRegistrationAck(ack), true);
  assert.equal(stateFirst.pendingRegistrationProfile, null);
  assert.equal(stateFirst.saves[0].profileKey, '10000000-0000-4000-8000-000000000001');
  assert.equal(stateFirst.saves[0].editable, true);
  assert.equal(stateFirst.deviceStatuses, 1);

  const ackFirst = registrationSettlementHarness();
  assert.equal(ackFirst.handlePlayerRegistrationAck(ack), true);
  assert.notEqual(ackFirst.pendingRegistrationProfile, null, 'ACK alone cannot settle without room state');
  assert.equal(ackFirst.saves.length, 0);
  ackFirst.acceptPendingRegistration(player);
  assert.equal(ackFirst.pendingRegistrationProfile, null);
  assert.equal(ackFirst.saves[0].profileKey, '10000000-0000-4000-8000-000000000001');
});

test('a second device joins the captain for alerts without inheriting edit ownership', () => {
  const h = registrationSettlementHarness();
  h.acceptPendingRegistration({
    identityMode: 'playerId', playerId: '900000111', name: 'Canonical Captain', march: 39, marchRevision: 4
  });

  assert.equal(h.handlePlayerRegistrationAck({
    t: 'playerRegistered', registrationId: 'registration-1', pid: '900000111',
    created: false, editable: false
  }), true);
  assert.equal(h.pendingRegistrationProfile, null);
  assert.equal(h.saves[0].name, 'Canonical Captain');
  assert.equal(h.saves[0].march, 39);
  assert.equal(h.saves[0].marchRevision, 4);
  assert.equal(h.saves[0].editable, false);
  assert.equal(Object.hasOwn(h.saves[0], 'profileKey'), false, 'delivery-only devices never persist the rejected key');
  assert.equal(h.deviceStatuses, 1, 'delivery-only devices still bind for captain audio');
});

test('registration ACKs are scoped to the exact pending attempt', () => {
  const h = registrationSettlementHarness();
  assert.equal(h.handlePlayerRegistrationAck({
    t: 'playerRegistered', registrationId: 'stale-registration', pid: '900000111',
    created: true, editable: true
  }), false);
  assert.equal(h.pendingRegistrationProfile.ackSeen, false);
  assert.equal(h.registrationPending, true);
  assert.equal(h.saves.length, 0);
});

test('an uncertain sent registration keeps its capability and waits for an explicit retry', () => {
  const h = pendingRegistrationRetryHarness();
  const originalPending = h.pendingRegistrationProfile;

  assert.equal(h.armPendingRegistrationRetry(), true);

  assert.equal(h.pendingRegistrationProfile, originalPending, 'the pending owner key is retained');
  assert.equal(h.pendingRegistrationProfile.registrationId, 'registration-uncertain');
  assert.equal(h.pendingRegistrationProfile.profileKey, '10000000-0000-4000-8000-000000000002');
  assert.equal(h.pendingRegistrationProfile.manualRetry, true);
  assert.equal(h.pendingRegistrationProfile.ackSeen, false, 'an ACK from an older connection is not trusted');
  assert.equal(h.pendingRegistrationProfile.stateSeen, false, 'an older snapshot is not trusted');
  assert.equal(h.pendingRegistrationProfile.canonicalPlayer, null);
  assert.equal(h.pendingRegistrationProfile.editable, null);
  assert.equal(h.registrationPending, false);
  assert.equal(h.draftActive, true);
  assert.deepEqual(h.messages, [], 'missing reconnect snapshots never auto-create a player');
  assert.deepEqual(h.toasts, ['registration_retry']);
});

test('registration recovery is non-creating while an explicit retry reuses the frozen attempt', () => {
  const recovery = pendingRegistrationRetryHarness();
  recovery.registerPendingProfile(true);
  assert.equal(recovery.messages.length, 1);
  assert.equal(recovery.messages[0].recoverOnly, true);
  assert.equal(recovery.messages[0].registrationId, 'registration-uncertain');
  assert.equal(recovery.messages[0].profileKey, '10000000-0000-4000-8000-000000000002');

  const explicit = pendingRegistrationRetryHarness();
  explicit.pendingRegistrationProfile.manualRetry = true;
  explicit.registerPendingProfile(false);
  assert.equal(explicit.messages.length, 1);
  assert.equal(Object.hasOwn(explicit.messages[0], 'recoverOnly'), false,
    'only a user-triggered submit may create a missing player');
  assert.equal(explicit.pendingRegistrationProfile.manualRetry, false);
  assert.equal(explicit.pendingRegistrationProfile.everSent, true);
});

test('room-state registration recovery can never use a creating registration frame', () => {
  const onState = extractFunction('onState');
  assert.match(onState, /registerPendingProfile\(true\)/);
  assert.doesNotMatch(onState, /else if \(firstSnapshot && !registrationPending\) registerPendingProfile\(\)/);
});

test('reconnect clears stale evidence without invalidating a visible manual retry', () => {
  const h = pendingRegistrationRetryHarness();
  h.pendingRegistrationProfile.manualRetry = true;

  assert.equal(h.resetPendingRegistrationConnectionEvidence(), true);

  assert.equal(h.pendingRegistrationProfile.manualRetry, true);
  assert.equal(h.pendingRegistrationProfile.ackSeen, false);
  assert.equal(h.pendingRegistrationProfile.stateSeen, false);
  assert.equal(h.pendingRegistrationProfile.canonicalPlayer, null);
  assert.equal(h.pendingRegistrationProfile.editable, null);
});

test('a later missing snapshot releases a pending registration after canonical state disappeared', () => {
  const h = pendingRegistrationRetryHarness();
  h.pendingRegistrationProfile.ackSeen = false;
  h.pendingRegistrationProfile.stateSeen = true;
  h.pendingRegistrationProfile.manualRetry = false;

  assert.equal(h.reconcileMissingPendingRegistration(false), true);

  assert.equal(h.pendingRegistrationProfile.manualRetry, true);
  assert.equal(h.pendingRegistrationProfile.stateSeen, false);
  assert.deepEqual(h.messages, [], 'a commander deletion never causes an automatic creating frame');
  assert.deepEqual(h.toasts, ['registration_retry']);
});

test('a non-creating recovery miss retains the exact pending capability for manual retry', () => {
  const h = profileErrorHarness();
  h.pendingMarchMutation = null;
  h.pendingRegistrationProfile = {
    registrationId: 'recover-miss', pid: 'new-route', identityMode: 'nickname', name: 'New Player',
    march: 45, profileKey: '10000000-0000-4000-8000-000000000003',
    ackSeen: false, stateSeen: true, canonicalPlayer: { name: 'New Player', march: 45 },
    editable: null, everSent: true, manualRetry: false
  };
  h.registrationPending = true;

  assert.equal(h.handlePlayerProtocolError({
    t: 'error', error: 'player_missing', registrationId: 'recover-miss', pid: 'new-route'
  }), true);
  assert.equal(h.pendingRegistrationProfile.registrationId, 'recover-miss');
  assert.equal(h.pendingRegistrationProfile.profileKey, '10000000-0000-4000-8000-000000000003');
  assert.equal(h.pendingRegistrationProfile.manualRetry, true);
  assert.equal(h.pendingRegistrationProfile.stateSeen, false);
  assert.equal(h.registrationPending, false);
  assert.deepEqual(h.toasts, ['registration_retry']);
});

for (const error of [
  'player_id_conflict', 'invalid_player_id', 'invalid_nickname',
  'profile_persist_failed', 'player_conflict'
]) {
  test(`${error} keeps the old canonical profile and unlocks the identity draft for retry`, () => {
    const h = profileErrorHarness();
    const before = structuredClone(h.myProfile);

    assert.equal(h.handlePlayerProtocolError({
      t: 'error', error, mutationId: 'profile-save-1', pid: 'opaque-route'
    }), true);

    assert.equal(h.pendingMarchMutation, null);
    assert.deepEqual(h.myProfile, before);
    assert.equal(h.draftActive, true);
    assert.equal(h.identityRestored, false);
    assert.equal(h.controlsSynced, 1);
    assert.deepEqual(h.classes, ['fillCard:remove:hide', 'youChip:add:hide']);
    if (error === 'player_id_conflict') assert.deepEqual(h.toasts, ['player_id_taken']);
    if (error === 'player_conflict') assert.deepEqual(h.toasts, ['profile_conflict']);
    if (error === 'profile_owner_mismatch') assert.deepEqual(h.toasts, ['profile_owner_mismatch']);
  });
}

test('a rejected stored edit downgrades only profile editing while preserving captain alerts', () => {
  const h = profileErrorHarness();

  assert.equal(h.handlePlayerProtocolError({
    t: 'error', error: 'profile_owner_mismatch', mutationId: 'profile-save-1', pid: 'opaque-route'
  }), true);

  assert.equal(h.pendingMarchMutation, null);
  assert.equal(h.myProfile.pid, 'opaque-route');
  assert.equal(h.myProfile.editable, false);
  assert.equal(Object.hasOwn(h.myProfile, 'profileKey'), false);
  assert.equal(h.cards, 1);
  assert.deepEqual(h.toasts, ['profile_delivery_only']);
});

test('a missing stored player is never silently auto-created after commander removal', () => {
  assert.doesNotMatch(source, /function registerStoredProfile\(/);
  assert.doesNotMatch(extractFunction('onState'), /registerStoredProfile\(/);
});

test('identity mismatch releases a pending self-save and reconnects for a fresh socket binding', () => {
  const h = identityMismatchHarness();

  assert.equal(h.handlePlayerProtocolError({
    t: 'error', error: 'core_identity_mismatch', mutationId: 'march-save-1', pid: '001'
  }), true);
  assert.equal(h.pendingMarchMutation, null);
  assert.equal(h.draftActive, true);
  assert.equal(h.identityRestored, true);
  assert.deepEqual(h.toasts, ['identity_rebinding']);
  assert.equal(h.refreshes, 1);
  assert.deepEqual(h.classes, ['fillCard:remove:hide', 'youChip:add:hide']);
});

test('registration persistence failure releases the pending registration for a manual retry', () => {
  const h = profileErrorHarness();
  h.pendingMarchMutation = null;
  h.pendingRegistrationProfile = {
    pid: 'new-route', identityMode: 'nickname', name: 'New Player', requestedMarch: 45
  };
  h.registrationPending = true;

  assert.equal(h.handlePlayerProtocolError({
    t: 'error', error: 'registration_persist_failed', pid: 'new-route'
  }), true);
  assert.equal(h.pendingRegistrationProfile, null);
  assert.equal(h.registrationPending, false);
  assert.equal(h.draftActive, true);
  assert.deepEqual(h.toasts, ['notconn']);
});

test('a full roster releases the pending registration and tells the player to contact a commander', () => {
  const h = profileErrorHarness();
  h.pendingMarchMutation = null;
  h.pendingRegistrationProfile = {
    pid: 'new-route', identityMode: 'nickname', name: 'New Player', requestedMarch: 45
  };
  h.registrationPending = true;

  assert.equal(h.handlePlayerProtocolError({
    t: 'error', error: 'roster_full', pid: 'new-route'
  }), true);
  assert.equal(h.pendingRegistrationProfile, null);
  assert.equal(h.registrationPending, false);
  assert.equal(h.draftActive, true);
  assert.deepEqual(h.toasts, ['roster_full']);
});

test('identity mismatch for another mutation does not disturb the current self-save', () => {
  const h = identityMismatchHarness();

  assert.equal(h.handlePlayerProtocolError({
    t: 'error', error: 'core_identity_mismatch', mutationId: 'another-save', pid: '001'
  }), false);
  assert.equal(h.pendingMarchMutation.mutationId, 'march-save-1');
  assert.equal(h.refreshes, 0);
  assert.deepEqual(h.toasts, []);
});
