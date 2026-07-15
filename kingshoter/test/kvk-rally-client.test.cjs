const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRally() {
  const source = fs.readFileSync(path.join(__dirname, '../public/kvk-rally.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, globalThis: {} });
  return module.exports;
}

const rally = loadRally();
const plain = (value) => JSON.parse(JSON.stringify(value));

test('shared rally semantics identify their exact supported build generation', () => {
  assert.equal(rally.BUILD, 2026071303);
});

test('Double, Triple, and projected legacy Triple are rally commands', () => {
  assert.equal(rally.isRallyCommand({ type: 'double_rally' }), true);
  assert.equal(rally.isRallyCommand({ type: 'triple_rally' }), true);
  assert.equal(rally.isRallyCommand({ type: 'refill' }), false);
});

test('the third captain resolves only their own immutable target', () => {
  const command = { type: 'triple_rally', anchorUTC: 10, payload: {
    firstPress: 10,
    pairs: [{ pid: 'a', role: 'weak', pressUTC: 10 }, { pid: 'b', role: 'weak2', pressUTC: 12 }, { pid: 'c', role: 'main', pressUTC: 11 }]
  } };
  assert.deepEqual(plain(rally.targetFor(command, 'b')), { anchor: 12, mine: true, role: 'weak2' });
  assert.deepEqual(plain(rally.targetFor(command, 'z')), { anchor: 10, mine: false });
});

test('only the explicit legacy projection may carry weak2 under a Double wire type', () => {
  const pair = { pid: 'b', role: 'weak2', pressUTC: 12 };
  const canonicalDouble = { type: 'double_rally', anchorUTC: 10, payload: { firstPress: 10, pairs: [pair] } };
  const projectedTriple = { type: 'double_rally', anchorUTC: 10, payload: { firstPress: 10, rallySize: 3, pairs: [pair] } };
  assert.deepEqual(plain(rally.targetFor(canonicalDouble, 'b')), { anchor: 10, mine: false });
  assert.deepEqual(plain(rally.targetFor(projectedTriple, 'b')), { anchor: 12, mine: true, role: 'weak2' });
});

test('mode reconciliation never keeps a hidden weak2 in Double', () => {
  const picks = [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }];
  assert.deepEqual(plain(rally.reconcilePicks(picks, 'double')), [{ pid: 'a', role: 'weak' }, { pid: 'c', role: 'main' }]);
  assert.deepEqual(plain(rally.rolesForMode('triple')), ['weak', 'weak2', 'main']);
});

test('malformed commands fail closed without throwing', () => {
  assert.deepEqual(plain(rally.targetFor(null, 'a')), { anchor: 0, mine: false });
  assert.deepEqual(plain(rally.targetFor({ type: 'triple_rally', anchorUTC: 20, payload: { pairs: [null] } }, 'a')), { anchor: 20, mine: false });
  for (const pair of [
    { pid: 'a', role: 'weak2' },
    { pid: 'a', role: 'weak2', pressUTC: '12' },
    { pid: 'a', role: 'not-a-role', pressUTC: 12 },
    { pid: '', role: 'weak2', pressUTC: 12 }
  ]) {
    assert.deepEqual(
      plain(rally.targetFor({ type: 'triple_rally', anchorUTC: 20, payload: { pairs: [pair] } }, 'a')),
      { anchor: 20, mine: false }
    );
  }
  assert.deepEqual(
    plain(rally.targetFor({ type: 'triple_rally', anchorUTC: '20', payload: { firstPress: '10', pairs: [] } }, 'z')),
    { anchor: 0, mine: false }
  );
  assert.equal(rally.isRallyCommand(null), false);
});

test('reconciliation returns canonical copies and rejects duplicate players and roles', () => {
  const first = { pid: 'a', role: 'weak', name: 'ignored' };
  const picks = [first, { pid: 'a', role: 'main' }, { pid: 'b', role: 'weak' }, { pid: 'c', role: 'main' }];
  assert.deepEqual(plain(rally.reconcilePicks(picks, 'double')), [
    { pid: 'a', role: 'weak' },
    { pid: 'c', role: 'main' }
  ]);
  assert.notEqual(rally.reconcilePicks([first], 'double')[0], first);
});

test('Triple fills weak, weak2, main and never silently replaces a fourth player', () => {
  let result = rally.selectPlayer([], 'a', 'triple');
  result = rally.selectPlayer(result.picks, 'b', 'triple');
  result = rally.selectPlayer(result.picks, 'c', 'triple');
  assert.deepEqual(plain(result.picks), [
    { pid: 'a', role: 'weak' },
    { pid: 'b', role: 'weak2' },
    { pid: 'c', role: 'main' }
  ]);

  const fourth = rally.selectPlayer(result.picks, 'd', 'triple');
  assert.equal(fourth.needsReplacement, true);
  assert.deepEqual(plain(fourth.picks), plain(result.picks));
  assert.deepEqual(plain(fourth.roles), ['weak', 'weak2', 'main']);
});

test('moving to an occupied Triple role swaps captains without loss', () => {
  const picks = [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }];
  assert.deepEqual(plain(rally.movePlayerToRole(picks, 'a', 'main', 'triple')), [
    { pid: 'a', role: 'main' },
    { pid: 'b', role: 'weak2' },
    { pid: 'c', role: 'weak' }
  ]);
});

test('Double selection keeps its two-role fill, replacement, and swap behavior', () => {
  let result = rally.selectPlayer([], 'a', 'double');
  result = rally.selectPlayer(result.picks, 'b', 'double');
  assert.deepEqual(plain(result.picks), [
    { pid: 'a', role: 'weak' },
    { pid: 'b', role: 'main' }
  ]);

  const third = rally.selectPlayer(result.picks, 'c', 'double');
  assert.equal(third.needsReplacement, true);
  assert.deepEqual(plain(third.picks), plain(result.picks));
  assert.deepEqual(plain(third.roles), ['weak', 'main']);

  result = rally.selectPlayer(third.picks, 'c', 'double', 'weak');
  assert.equal(result.needsReplacement, false);
  assert.deepEqual(plain(result.picks), [
    { pid: 'b', role: 'main' },
    { pid: 'c', role: 'weak' }
  ]);
  assert.deepEqual(plain(rally.movePlayerToRole(result.picks, 'c', 'main', 'double')), [
    { pid: 'b', role: 'weak' },
    { pid: 'c', role: 'main' }
  ]);
});
