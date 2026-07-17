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
  assert.match(clientSource, /\[10, 15, 30, 60\]\.map\(function \(v\)/);
  assert.match(clientSource, /var commandKingdom = fireKingdom, commandLead = lead/);
  assert.match(clientSource, /leadSeconds: commandLead/);
  assert.match(clientSource, /var countdownLead = Number\(c\.payload && c\.payload\.leadSeconds\)/);
  assert.match(clientSource, /schedulePrepareCue\(c\.id \+ "-me", tg\.anchor, countdownLead, win\)/);
});

test('ordinary members retain one generic JOIN path while commanders are excluded', () => {
  assert.match(clientSource, /function shouldBookJoinAudio\(\) \{\s*return !!myPid && !isCommanderDevice\(\);\s*\}/);
  assert.match(clientSource, /if \(!personal && canJoin\)[\s\S]*scheduleBeeps\(joinKey, myTarget\(join\)\.anchor, win\)/);
  assert.match(clientSource, /return rows\.slice\(0, 6\)/);
  assert.match(clientSource, /!rallies\.some\(function \(command\) \{ return myTarget\(command\)\.mine; \}\)/);
});

test('cancel restores the staged team instead of clearing it', () => {
  assert.match(roomSource, /const restoredStage = cancelledRallyStage\([\s\S]*this\.room\.live\.commands\[kd\] = null;[\s\S]*this\.room\.live\.staged\[kd\] = restoredStage/);
  assert.match(roomSource, /if \(type !== "cancel"\) \{\s*this\.room\.live\.staged\[kd\] = null;\s*\}/);
});

test('reconnect and clock drift only replan future command-scoped cues', () => {
  assert.match(clientSource, /if \(e\.base\.indexOf\("locktest"\) === 0 \|\| e\.t <= nowMs\) continue/);
  assert.match(clientSource, /if \(!alive\) \{ stopCue\(e\); delete scheduledBeeps\[k\]/);
  assert.match(clientSource, /Math\.abs\(\(e\.off \|\| 0\) - window\.clockOffset\) > 300/);
  assert.match(clientSource, /if \(moved\) scheduleAllCues\(\)/);
});
