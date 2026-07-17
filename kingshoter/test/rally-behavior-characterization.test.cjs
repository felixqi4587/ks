const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rallySource = fs.readFileSync(path.join(__dirname, '../public/kvk-rally.js'), 'utf8');
const rallySandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(rallySource, rallySandbox);
const rally = rallySandbox.module.exports;
const clientSource = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');
const roomSource = fs.readFileSync(path.join(__dirname, '../src/room.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

test('Double and Triple captains keep exact personal press targets', () => {
  const double = {
    type: 'double_rally', anchorUTC: 100,
    payload: { firstPress: 110, pairs: [
      { pid: 'sac', role: 'weak', pressUTC: 110 },
      { pid: 'main', role: 'main', pressUTC: 114 }
    ] }
  };
  assert.deepEqual(plain(rally.targetFor(double, 'sac')), { anchor: 110, mine: true, role: 'weak' });
  assert.deepEqual(plain(rally.targetFor(double, 'main')), { anchor: 114, mine: true, role: 'main' });
  assert.deepEqual(plain(rally.targetFor(double, 'member')), { anchor: 110, mine: false });

  const triple = {
    type: 'triple_rally', anchorUTC: 200,
    payload: { firstPress: 210, rallySize: 3, pairs: [
      { pid: 'sac1', role: 'weak', pressUTC: 210 },
      { pid: 'sac2', role: 'weak2', pressUTC: 211 },
      { pid: 'main', role: 'main', pressUTC: 212 }
    ] }
  };
  assert.deepEqual(plain(rally.rolesForMode('triple')), ['weak', 'weak2', 'main']);
  assert.deepEqual(plain(rally.targetFor(triple, 'sac2')), { anchor: 211, mine: true, role: 'weak2' });
  assert.deepEqual(plain(rally.targetFor(triple, 'member')), { anchor: 210, mine: false });
});

test('the selected lead is the personal countdown lead for every supported option', () => {
  const prepareContext = {
    scheduledBeeps: {}, ensureAudio() {},
    ac: { state: 'running', currentTime: 20 },
    window: { serverNow: () => 1_000_000, clockOffset: 0, __beeps: 0 },
    beep(when) {
      return {
        when,
        o: { stop() {}, disconnect() {} },
        g: { disconnect() {}, gain: { cancelScheduledValues() {}, setValueAtTime() {} } }
      };
    },
    Number
  };
  vm.runInNewContext(extractFunction(clientSource, 'schedulePrepareCue'), prepareContext);
  for (const leadSeconds of [10, 15, 30, 60]) {
    const target = 1_100;
    const prepared = [];
    const command = {
      id: `lead-${leadSeconds}`,
      type: 'double_rally',
      payload: {
        firstPress: 1_090,
        leadSeconds,
        pairs: [{ pid: 'captain', role: 'main', pressUTC: target }]
      }
    };
    const context = {
      room: { live: { commands: { 1: command, 2: null } } },
      reconcileCues() {}, pruneDeliveryAckState() {},
      liveCommands: () => [command],
      myTarget: value => rally.targetFor(value, 'captain'),
      scheduleBeeps() {},
      schedulePrepareCue(key, targetSec, lead) {
        prepared.push({ key, startsAt: targetSec - lead, lead });
      },
      acknowledgeClassicCommand() {}, shouldBookJoinAudio: () => false,
      cancelJoinCues() {}, activeCommand: () => command,
      isRallyCommand: rally.isRallyCommand, Number
    };
    vm.runInNewContext(extractFunction(clientSource, 'scheduleAllCues'), context);
    context.scheduleAllCues();
    assert.deepEqual(prepared, [{
      key: `${command.id}-me`, startsAt: target - leadSeconds, lead: leadSeconds
    }]);
    prepareContext.schedulePrepareCue(command.id, target, leadSeconds, 360_000);
    const exactCue = prepareContext.scheduledBeeps[`${command.id}:${leadSeconds}`];
    assert.equal(exactCue.t, (target - leadSeconds) * 1000);
    assert.equal(exactCue.nodes[0].when, 20 + (target - leadSeconds - 1_000));
  }
});

test('ordinary members retain one generic JOIN path while commanders are excluded', () => {
  assert.match(clientSource, /function shouldBookJoinAudio\(\) \{\s*return !!myPid && !isCommanderDevice\(\);\s*\}/);
  assert.match(clientSource, /if \(!personal && canJoin\)[\s\S]*scheduleBeeps\(joinKey, myTarget\(join\)\.anchor, win\)/);
  assert.match(clientSource, /return rows\.slice\(0, 6\)/);
  assert.match(clientSource, /!rallies\.some\(function \(command\) \{ return myTarget\(command\)\.mine; \}\)/);
});

test('an ordinary member follows only the nearest upcoming rally and obsolete JOIN cues are removed', () => {
  const old = { id: 'old', type: 'double_rally', payload: { firstPress: 990, pairs: [] } };
  const later = {
    id: 'later', type: 'double_rally',
    payload: { firstPress: 1_030, leadSeconds: 10, pairs: [
      { pid: 'captain', role: 'weak', pressUTC: 1_030 }
    ] }
  };
  const sooner = { id: 'sooner', type: 'double_rally', payload: { firstPress: 1_015, pairs: [] } };
  function route(pid, commander) {
    const booked = [];
    const stoppedJoin = [];
    const context = {
      room: { live: { commands: { 1: later, 2: sooner } } },
      myPid: pid, window: { serverNowSec: () => 1_000 },
      liveCommands: () => [old, later, sooner], simCommand: () => null,
      myTarget: command => rally.targetFor(command, pid),
      reconcileCues() {}, pruneDeliveryAckState() {},
      scheduleBeeps(key, anchor) { booked.push({ key, anchor }); },
      schedulePrepareCue() {}, acknowledgeClassicCommand() {},
      shouldBookJoinAudio: () => !!pid && !commander,
      cancelJoinCues(keep) { stoppedJoin.push(keep || 'all'); },
      isRallyCommand: rally.isRallyCommand, Number
    };
    vm.runInNewContext([
      extractFunction(clientSource, 'activeCommand'),
      extractFunction(clientSource, 'scheduleAllCues')
    ].join('\n'), context);
    context.scheduleAllCues();
    return { booked, stoppedJoin };
  }

  assert.deepEqual(route('ordinary', false), {
    booked: [{ key: 'sooner-join', anchor: 1_015 }], stoppedJoin: ['sooner-join']
  });
  assert.deepEqual(route('captain', false), {
    booked: [{ key: 'later-me', anchor: 1_030 }], stoppedJoin: ['all']
  });
  assert.deepEqual(route('manager', true), { booked: [], stoppedJoin: ['all'] });
});

test('profile reconnect recovery is non-creating and preserves the frozen registration capability', () => {
  const messages = [];
  const pending = {
    pid: 'captain', name: 'Captain', march: 34, identityMode: 'nickname',
    profileKey: '10000000-0000-4000-8000-000000000002',
    registrationId: 'registration-frozen', manualRetry: true,
    ackSeen: true, stateSeen: true, canonicalPlayer: { name: 'stale' },
    editable: true, everSent: true
  };
  const context = {
    pendingRegistrationProfile: pending, registrationPending: false,
    draftActive: false, sock: { send(message) { messages.push(plain(message)); return true; } },
    syncIdentityControls() {}, restoreResolvedPlayerName() {},
    window: { toast() {} }, tk: value => value
  };
  vm.runInNewContext([
    extractFunction(clientSource, 'resetPendingRegistrationConnectionEvidence'),
    extractFunction(clientSource, 'registerPendingProfile')
  ].join('\n'), context);
  assert.equal(context.resetPendingRegistrationConnectionEvidence(), true);
  assert.equal(context.pendingRegistrationProfile.ackSeen, false);
  assert.equal(context.pendingRegistrationProfile.stateSeen, false);
  assert.equal(context.registerPendingProfile(true), true);
  assert.deepEqual(messages, [{
    t: 'registerPlayer', pid: 'captain', name: 'Captain', march: 34,
    identityMode: 'nickname', alliance: '',
    profileKey: pending.profileKey, registrationId: pending.registrationId,
    recoverOnly: true
  }]);
  assert.equal(context.pendingRegistrationProfile.registrationId, 'registration-frozen');
  assert.equal(context.pendingRegistrationProfile.profileKey, pending.profileKey);

  const saves = [];
  const settled = {
    pendingRegistrationProfile: {
      ...pending, ackSeen: false, stateSeen: false, canonicalPlayer: null,
      editable: null, draftVersion: 0
    },
    registrationPending: true, draftVersion: 0, draftActive: true,
    ownPlayerSeen: false, myProfile: null, deviceId: '', ROOM: 'qa',
    nicknameDraftRoutingKey: 'temporary', viewMode: 'attack',
    cancelIdentityLookup() {}, sendDeviceStatus() {}, showInCard() {},
    showExistingIdentity() {}, renderDefense() {},
    window: {
      getRoomDeviceId: () => '20000000-0000-4000-8000-000000000002',
      mmss: value => String(value), toast() {}
    },
    tk: value => value
  };
  settled.saveProfile = function (profile) {
    settled.myProfile = plain(profile);
    saves.push(plain(profile));
  };
  vm.runInNewContext([
    extractFunction(clientSource, 'acceptPendingRegistration'),
    extractFunction(clientSource, 'handlePlayerRegistrationAck')
  ].join('\n'), settled);
  assert.equal(settled.handlePlayerRegistrationAck({
    t: 'playerRegistered', registrationId: 'registration-frozen', pid: 'captain',
    created: false, editable: true
  }), true);
  assert.equal(saves.length, 0, 'ACK alone cannot settle without canonical room state');
  assert.equal(settled.acceptPendingRegistration({
    name: 'Captain Canonical', march: 36, marchRevision: 4, identityMode: 'nickname'
  }), true);
  assert.deepEqual(saves, [{
    pid: 'captain', name: 'Captain Canonical', march: 36, marchRevision: 4,
    identityMode: 'nickname', editable: true, profileKey: pending.profileKey
  }]);
  assert.equal(settled.pendingRegistrationProfile, null);
  assert.equal(settled.registrationPending, false);
});

test('cancel restores the staged team instead of clearing it', () => {
  assert.match(roomSource, /const restoredStage = cancelledRallyStage\([\s\S]*this\.room\.live\.commands\[kd\] = null;[\s\S]*this\.room\.live\.staged\[kd\] = restoredStage/);
  assert.match(roomSource, /if \(type !== "cancel"\) \{\s*this\.room\.live\.staged\[kd\] = null;\s*\}/);
});

test('reconnect and clock drift keep command-scoped cancellation wiring', () => {
  assert.match(clientSource, /if \(e\.base\.indexOf\("locktest"\) === 0 \|\| e\.t <= nowMs\) continue/);
  assert.match(clientSource, /if \(!alive\) \{ stopCue\(e\); delete scheduledBeeps\[k\]/);
  assert.match(clientSource, /Math\.abs\(\(e\.off \|\| 0\) - window\.clockOffset\) > 300/);
  assert.match(clientSource, /if \(moved\) scheduleAllCues\(\)/);
});
