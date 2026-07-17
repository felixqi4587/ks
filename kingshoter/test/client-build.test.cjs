const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { legacyTarget } = require('./fixtures/kvk-legacy-target.cjs');

async function load() {
  return import(`${pathToFileURL(path.join(__dirname, '../src/client-build.js')).href}?t=${Date.now()}`);
}

test('legacy projection preserves canonical state and all three personal targets', async () => {
  const mod = await load();
  const room = { live: { commands: { 1: { id: 'x', type: 'triple_rally', anchorUTC: 10, payload: {
    firstPress: 10,
    pairs: [{ pid: 'a', role: 'weak', pressUTC: 10 }, { pid: 'b', role: 'weak2', pressUTC: 11 }, { pid: 'c', role: 'main', pressUTC: 12 }]
  } }, 2: null } } };
  const canonical = structuredClone(room);
  const projected = mod.projectRoomForClient(room, 0);
  assert.deepEqual(room, canonical);
  assert.equal(room.live.commands[1].type, 'triple_rally');
  assert.equal(projected.live.commands[1].type, 'double_rally');
  assert.equal(projected.live.commands[1].payload.rallySize, 3);
  for (const pid of ['a', 'b', 'c']) assert.equal(legacyTarget(projected.live.commands[1], pid).mine, true);
  assert.strictEqual(mod.projectRoomForClient(room, mod.MIN_TRIPLE_BUILD), room);
  assert.equal(mod.projectRoomForClient(room, mod.MIN_TRIPLE_BUILD).live.commands[1].type, 'triple_rally');
  projected.live.commands[1].payload.pairs[0].role = 'mutated';
  projected.live.commands[1].payload.pairs.push({ pid: 'd', role: 'main', pressUTC: 13 });
  assert.deepEqual(room, canonical);
});

test('build metadata contains monotonic numeric versions and no secrets', async () => {
  const mod = await load();
  assert.deepEqual(mod.buildMetadata(false, true), {
    currentBuild: 2026071603,
    minKvkBuild: 2026071603,
    minRallyBuild: 2026071603,
    minDefenseBuild: 2026071603,
    minTripleBuild: 2026071603,
    tripleEnabled: false,
    tripleQaEnabled: true
  });
  assert.equal(mod.MIN_KVK_BUILD, mod.CURRENT_KVK_BUILD,
    'the forced-refresh floor must match the coherent client build');
  assert.equal(mod.MIN_RALLY_BUILD, mod.CURRENT_KVK_BUILD);
  assert.equal(mod.MIN_DEFENSE_BUILD, mod.CURRENT_KVK_BUILD);
  assert.equal(mod.MIN_TRIPLE_BUILD, mod.CURRENT_KVK_BUILD);
  assert.equal(mod.parseClientBuild('2026071603'), 2026071603);
  for (const value of ['bad', '', '0', '-1', '1.5', null, undefined, Infinity]) {
    assert.equal(mod.parseClientBuild(value), 0, String(value));
  }
});
