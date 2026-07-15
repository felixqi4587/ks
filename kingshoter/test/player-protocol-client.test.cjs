const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/kvk.html'), 'utf8');

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
  vm.runInNewContext(`${extractFunction('restoreResolvedPlayerName')}\n${extractFunction('handlePlayerProtocolError')}\nthis.handlePlayerProtocolError = handlePlayerProtocolError;`, sandbox);
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
      march: 41, marchRevision: 2
    },
    identityMode: 'playerId',
    cancelIdentityLookup() { sandbox.lookupsCancelled += 1; },
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
    toasts: [],
    classes
  };
  vm.runInNewContext(`${extractFunction('restoreResolvedPlayerName')}\n${extractFunction('handlePlayerProtocolError')}\nthis.handlePlayerProtocolError = handlePlayerProtocolError;`, sandbox);
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
  });
}

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

test('identity mismatch for another mutation does not disturb the current self-save', () => {
  const h = identityMismatchHarness();

  assert.equal(h.handlePlayerProtocolError({
    t: 'error', error: 'core_identity_mismatch', mutationId: 'another-save', pid: '001'
  }), false);
  assert.equal(h.pendingMarchMutation.mutationId, 'march-save-1');
  assert.equal(h.refreshes, 0);
  assert.deepEqual(h.toasts, []);
});
