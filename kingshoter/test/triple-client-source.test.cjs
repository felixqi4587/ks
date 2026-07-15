const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');

function sliceFunction(startName, endName) {
  const start = source.indexOf(`function ${startName}`);
  const end = source.indexOf(`function ${endName}`, start);
  assert.ok(start >= 0 && end > start, `expected ${startName} before ${endName}`);
  return source.slice(start, end);
}

test('client ships an explicit Triple request and retains Double Fire', () => {
  assert.match(source, /function fireDouble\(\)/);
  assert.match(source, /function fireTriple\(\)/);
  assert.match(source, /type:\s*["']triple_rally["']/);
  assert.match(source, /function fireCurrentRally\(\)/);
  assert.doesNotMatch(source, /counter_rally|anti_rally/);
});

test('server remains the Triple timing authority', () => {
  const triple = sliceFunction('fireTriple', 'fireCurrentRally');
  assert.doesNotMatch(triple, /pressUTC|march\s*:/);
  assert.match(triple, /modeRevision/);
  assert.match(triple, /leadSeconds/);
});

test('one dynamic Fire control keeps Triple out of the Double timing body', () => {
  const current = sliceFunction('fireCurrentRally', 'consumeStageForFire');
  assert.match(current, /rallyMode\(fireKingdom\)/);
  assert.match(current, /fireTriple\(\)/);
  assert.match(current, /fireDouble\(\)/);

  const double = sliceFunction('fireDouble', 'fireTriple');
  assert.doesNotMatch(double, /triple_rally|weak2/);
  assert.match(double, /!rallyModeWritable\(commandKingdom\)/,
    'the original Double entry point must retain its own fail-closed mode guard');
  assert.match(double, /stageIntentBlocksFire\(commandKingdom\)[\s\S]*pendingRallyMode/,
    'Double must block only foreign stage intent while allowing its own complete local queue');
  assert.match(source, /function stageIntentBlocksFire\(/);
  assert.match(source, /function requiredCaptains\(/);
  assert.match(source, /function updateFireControl\(/);
});

function loadTapFire() {
  const tap = sliceFunction('tapFire', 'normalizeNickname');
  const sandbox = {
    updateFireControl() {},
    tk(key) { return key; },
    navigator: { vibrate() {} },
    setTimeout(fn) { sandbox.timers.push(fn); },
    timers: []
  };
  vm.runInNewContext(`${tap}\nthis.tapFire = tapFire;`, sandbox);
  return sandbox;
}

function fakeFireButton() {
  const classes = new Set();
  return {
    disabled: false,
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); }
    },
    classes
  };
}

test('a changed command snapshot between confirmation taps re-arms instead of firing', () => {
  const sandbox = loadTapFire();
  const button = fakeFireButton();
  const label = { textContent: '' };
  let labelKey = 'firedbl';
  let snapshot = 'k1|double|r0|lead10|weak:a,main:b';
  let fired = 0;
  sandbox.tapFire(button, label, () => labelKey, () => snapshot, () => { fired += 1; });

  button.onclick();
  snapshot = 'k2|double|r0|lead10|weak:a,main:b';
  button.onclick();
  assert.equal(fired, 0);
  assert.equal(label.textContent, 'tapagain');
  button.onclick();
  assert.equal(fired, 1);
});

test('a disabled click cancels an earlier Fire confirmation token', () => {
  const sandbox = loadTapFire();
  const button = fakeFireButton();
  const label = { textContent: '' };
  let fired = 0;
  sandbox.tapFire(button, label, () => 'firetri', () => 'k1|triple|r2|lead15|a,b,c', () => { fired += 1; });

  button.onclick();
  button.disabled = true;
  button.onclick();
  button.disabled = false;
  button.onclick();
  assert.equal(fired, 0);
  button.onclick();
  assert.equal(fired, 1);
});

test('an unchanged state refresh keeps the visible Tap again label while armed', () => {
  const sandbox = loadTapFire();
  const button = fakeFireButton();
  const label = { textContent: '' };
  let fired = 0;
  const sync = sandbox.tapFire(button, label, () => 'firetri', () => 'k1|triple|r2|lead15|a,b,c', () => { fired += 1; });

  button.onclick();
  label.textContent = 'firetri';
  sync();
  assert.equal(label.textContent, 'tapagain');
  assert.equal(button.classes.has('armed'), true);
  button.onclick();
  assert.equal(fired, 1);
});

test('Triple success waits for canonical state and command rejections are handled', () => {
  const triple = sliceFunction('fireTriple', 'fireCurrentRally');
  assert.doesNotMatch(triple, /window\.toast\(ok\s*\?\s*tk\(["']fired["']/);
  assert.match(source, /function settlePendingRallyFire\(/);
  const errors = sliceFunction('handleRallyCommandError', 'renderRallyMode');
  assert.match(errors, /if \(message\.mutationId\) return false/,
    'command rejection handling must not consume another mutation protocol error');
  assert.match(errors, /triple_disabled/);
  assert.match(errors, /invalid_rally_roster/);
  assert.match(errors, /rally_mode_conflict/);
});

test('only one Triple Fire may wait for canonical confirmation', () => {
  const control = sliceFunction('updateFireControl', 'refreshSyncPill');
  const triple = sliceFunction('fireTriple', 'fireCurrentRally');
  const current = sliceFunction('fireCurrentRally', 'fireConfirmationKey');
  assert.match(control, /pendingRallyFire/);
  assert.match(triple, /pendingRallyFire/);
  assert.match(current, /pendingRallyFire/);
  assert.match(source, /function clearPendingRallyFire\(/);
  assert.match(source, /pendingFire\.timeoutId\s*=\s*window\.setTimeout/);
  assert.match(source, /onClose[\s\S]{0,600}clearPendingRallyFire\(\)/);
});
