const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function load() {
  return import(`${pathToFileURL(path.join(__dirname, '../src/rally-targets.js')).href}?t=${Date.now()}`);
}

test('two sacrifices land together and Main lands one second later', async () => {
  const { buildTripleRallyCommand } = await load();
  const result = buildTripleRallyCommand({
    players: {
      a: { name: 'A', march: 22 },
      b: { name: 'B', march: 47 },
      c: { name: 'C', march: 31 }
    },
    pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }],
    kingdom: 2, leadSeconds: 10, serverNowSec: 1000,
    commandId: 'cmd-1', atISO: '2026-07-13T00:00:00.000Z'
  });
  assert.equal(result.ok, true);
  const byRole = Object.fromEntries(result.command.payload.pairs.map((pair) => [pair.role, pair]));
  assert.equal(Math.min(...result.command.payload.pairs.map((pair) => pair.pressUTC)), 1010);
  assert.equal(byRole.weak.pressUTC + byRole.weak.march, byRole.weak2.pressUTC + byRole.weak2.march);
  assert.equal(byRole.main.pressUTC + byRole.main.march, byRole.weak.pressUTC + byRole.weak.march + 1);
});

test('all supported leads preserve exact personal lead and invalid rosters fail', async () => {
  const { buildTripleRallyCommand } = await load();
  const players = { a: { march: 5 }, b: { march: 120 }, c: { march: 90 } };
  for (const leadSeconds of [10, 15, 30, 60]) {
    const result = buildTripleRallyCommand({
      players, pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }],
      kingdom: 1, leadSeconds, serverNowSec: 500, commandId: `c-${leadSeconds}`, atISO: 'now'
    });
    assert.equal(Math.min(...result.command.payload.pairs.map((pair) => pair.pressUTC)), 500 + leadSeconds);
  }
  assert.equal(buildTripleRallyCommand({
    players, pairs: [{ pid: 'a', role: 'weak' }, { pid: 'a', role: 'weak2' }, { pid: 'c', role: 'main' }],
    kingdom: 1, leadSeconds: 10, serverNowSec: 500, commandId: 'bad', atISO: 'now'
  }).error, 'invalid_rally_roster');
});

test('target construction rejects reserved, malformed, and inherited player keys', async () => {
  const { buildTripleRallyCommand } = await load();
  const players = Object.create({ inherited: { march: 20 } });
  Object.assign(players, { a: { march: 20 }, b: { march: 30 }, c: { march: 40 } });
  for (const pid of ['__proto__', 'constructor', 'has space', 'bad!', 'inherited']) {
    const result = buildTripleRallyCommand({
      players,
      pairs: [{ pid, role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }],
      kingdom: 1, leadSeconds: 10, serverNowSec: 500, commandId: 'invalid', atISO: 'now'
    });
    assert.equal(result.ok, false, pid);
  }
});

test('role coverage rejects missing, unknown, and duplicate roles', async () => {
  const { buildTripleRallyCommand } = await load();
  const players = { a: { march: 20 }, b: { march: 30 }, c: { march: 40 } };
  const validPairs = [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }];
  const cases = [
    ['missing', validPairs.slice(0, 2)],
    ['unknown', [validPairs[0], validPairs[1], { pid: 'c', role: 'scout' }]],
    ['duplicate', [validPairs[0], validPairs[1], { pid: 'c', role: 'weak2' }]]
  ];
  for (const [label, pairs] of cases) {
    const result = buildTripleRallyCommand({
      players, pairs, kingdom: 1, leadSeconds: 10,
      serverNowSec: 500, commandId: label, atISO: 'now'
    });
    assert.deepEqual(result, { ok: false, error: 'invalid_rally_roster' }, label);
  }
});

test('player lookup requires an own canonical record', async () => {
  const { buildTripleRallyCommand } = await load();
  const players = Object.create({ inherited: { march: 20 } });
  Object.assign(players, { a: { march: 20 }, b: { march: 30 }, c: { march: 40 } });
  for (const pid of ['missing', 'inherited']) {
    const result = buildTripleRallyCommand({
      players,
      pairs: [{ pid, role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }],
      kingdom: 1, leadSeconds: 10, serverNowSec: 500, commandId: pid, atISO: 'now'
    });
    assert.deepEqual(result, { ok: false, error: 'player_missing', pid });
  }
});

test('march validation rejects values below, above, and outside the numeric domain', async () => {
  const { buildTripleRallyCommand } = await load();
  for (const [label, march] of [['below', 4], ['above', 121], ['non-number', 'fast']]) {
    const result = buildTripleRallyCommand({
      players: { a: { march }, b: { march: 30 }, c: { march: 40 } },
      pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }],
      kingdom: 1, leadSeconds: 10, serverNowSec: 500, commandId: label, atISO: 'now'
    });
    assert.deepEqual(result, { ok: false, error: 'invalid_march', pid: 'a' }, label);
  }
});

test('unsupported lead and kingdom values are rejected', async () => {
  const { buildTripleRallyCommand } = await load();
  const base = {
    players: { a: { march: 20 }, b: { march: 30 }, c: { march: 40 } },
    pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }],
    kingdom: 1, leadSeconds: 10, serverNowSec: 500, commandId: 'invalid', atISO: 'now'
  };
  const cases = [
    ['lead below set', { leadSeconds: 9 }],
    ['lead above set', { leadSeconds: 61 }],
    ['string lead', { leadSeconds: '10' }],
    ['kingdom below range', { kingdom: 0 }],
    ['kingdom above range', { kingdom: 3 }],
    ['string kingdom', { kingdom: '1' }]
  ];
  for (const [label, override] of cases) {
    assert.deepEqual(
      buildTripleRallyCommand({ ...base, ...override }),
      { ok: false, error: 'invalid_rally_roster' },
      label
    );
  }
});

test('unequal march permutations preserve both landing offsets', async () => {
  const { buildTripleRallyCommand } = await load();
  const players = { a: { march: 5 }, b: { march: 120 }, c: { march: 90 } };
  const permutations = [
    [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }],
    [{ pid: 'c', role: 'main' }, { pid: 'a', role: 'weak2' }, { pid: 'b', role: 'weak' }]
  ];
  for (const [index, pairs] of permutations.entries()) {
    const result = buildTripleRallyCommand({
      players, pairs, kingdom: 2, leadSeconds: 15,
      serverNowSec: 2000, commandId: `permutation-${index}`, atISO: 'now'
    });
    assert.equal(result.ok, true, `permutation ${index}`);
    const byRole = Object.fromEntries(result.command.payload.pairs.map((pair) => [pair.role, pair]));
    const sacrificeLanding = byRole.weak.pressUTC + byRole.weak.march;
    assert.equal(byRole.weak2.pressUTC + byRole.weak2.march, sacrificeLanding, `permutation ${index}`);
    assert.equal(byRole.main.pressUTC + byRole.main.march, sacrificeLanding + 1, `permutation ${index}`);
    assert.equal(Math.min(...result.command.payload.pairs.map((pair) => pair.pressUTC)), 2015, `permutation ${index}`);
  }
});
