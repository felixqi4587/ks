const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function load() {
  return import(`${pathToFileURL(path.join(__dirname, '../src/rally-mode.js')).href}?t=${Date.now()}`);
}

test('missing state defaults both kingdoms to independent Double revision zero', async () => {
  const { normalizeRallyModes } = await load();
  assert.deepEqual(normalizeRallyModes(null), {
    1: { mode: 'double', revision: 0 },
    2: { mode: 'double', revision: 0 }
  });
});

test('unsupported modes and malformed revisions atomically normalize to Double revision zero', async () => {
  const { normalizeRallyModes } = await load();
  assert.deepEqual(normalizeRallyModes({
    1: { mode: 'unsupported', revision: 9 },
    2: { mode: 'triple', revision: '7' }
  }), {
    1: { mode: 'double', revision: 0 },
    2: { mode: 'double', revision: 0 }
  });
});

test('Triple to Double atomically drops only weak2 from that kingdom', async () => {
  const { transitionRallyMode } = await load();
  const result = transitionRallyMode({
    rallyModes: { 1: { mode: 'triple', revision: 4 }, 2: { mode: 'double', revision: 2 } },
    staged: {
      1: { kingdom: 1, pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }] },
      2: { kingdom: 2, pairs: [{ pid: 'd', role: 'weak' }] }
    }
  }, { kingdom: 1, mode: 'double', baseRevision: 4 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rallyModes[1], { mode: 'double', revision: 5 });
  assert.deepEqual(result.staged[1].pairs, [{ pid: 'a', role: 'weak' }, { pid: 'c', role: 'main' }]);
  assert.deepEqual(result.staged[2].pairs, [{ pid: 'd', role: 'weak' }]);
});

test('a stale mode or stage revision never overwrites current state', async () => {
  const { transitionRallyMode, validateStagedPairs } = await load();
  const modes = { 1: { mode: 'triple', revision: 7 }, 2: { mode: 'double', revision: 0 } };
  assert.deepEqual(transitionRallyMode({ rallyModes: modes, staged: { 1: null, 2: null } }, {
    kingdom: 1, mode: 'double', baseRevision: 6
  }), { ok: false, error: 'rally_mode_conflict', record: { mode: 'triple', revision: 7 } });
  assert.equal(validateStagedPairs({
    modeRecord: modes[1], modeRevision: 6, pairs: [], players: {}
  }).error, 'rally_mode_conflict');
});

test('the emergency gate normalizes both modes and staged weak2 without touching commands', async () => {
  const { disableTripleModes } = await load();
  const result = disableTripleModes({
    rallyModes: { 1: { mode: 'triple', revision: 2 }, 2: { mode: 'triple', revision: 9 } },
    staged: {
      1: { kingdom: 1, pairs: [{ pid: 'a', role: 'weak2' }, { pid: 'b', role: 'main' }] },
      2: null
    }
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.rallyModes, {
    1: { mode: 'double', revision: 3 }, 2: { mode: 'double', revision: 10 }
  });
  assert.deepEqual(result.staged[1].pairs, [{ pid: 'b', role: 'main' }]);
});

test('the emergency gate removes stale weak2 even when the mode is already Double', async () => {
  const { disableTripleModes } = await load();
  const otherKingdom = { kingdom: 2, pairs: [{ pid: 'd', role: 'weak' }] };
  const result = disableTripleModes({
    rallyModes: { 1: { mode: 'double', revision: 3 }, 2: { mode: 'double', revision: 8 } },
    staged: {
      1: { kingdom: 1, pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }] },
      2: otherKingdom
    }
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.rallyModes, {
    1: { mode: 'double', revision: 3 }, 2: { mode: 'double', revision: 8 }
  });
  assert.deepEqual(result.staged[1].pairs, [{ pid: 'a', role: 'weak' }, { pid: 'c', role: 'main' }]);
  assert.strictEqual(result.staged[2], otherKingdom);
});

test('partial Triple staging accepts unique allowed roles and rejects duplicates', async () => {
  const { validateStagedPairs } = await load();
  const players = { a: {}, b: {}, c: {} };
  assert.deepEqual(validateStagedPairs({
    modeRecord: { mode: 'triple', revision: 3 }, modeRevision: 3,
    pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }], players
  }), { ok: true, pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }] });
  assert.equal(validateStagedPairs({
    modeRecord: { mode: 'triple', revision: 3 }, modeRevision: 3,
    pairs: [{ pid: 'a', role: 'weak' }, { pid: 'a', role: 'main' }], players
  }).error, 'invalid_rally_roster');
});

test('staging uses the core routing-key policy and rejects reserved or malformed PIDs', async () => {
  const { validateStagedPairs } = await load();
  const players = Object.create(null);
  players.valid_1 = {};
  for (const pid of ['__proto__', 'constructor', 'has space', 'bad!']) {
    assert.equal(validateStagedPairs({
      modeRecord: { mode: 'triple', revision: 1 }, modeRevision: 1,
      pairs: [{ pid, role: 'weak' }], players
    }).error, 'invalid_rally_roster', pid);
  }
  assert.deepEqual(validateStagedPairs({
    modeRecord: { mode: 'triple', revision: 1 }, modeRevision: 1,
    pairs: [{ pid: ' valid_1 ', role: 'weak' }], players
  }), { ok: true, pairs: [{ pid: 'valid_1', role: 'weak' }] });
});

test('QA gate never enables an operation room and the global gate enables all rooms', async () => {
  const { isTripleAllowed } = await load();
  const qaOnly = { TRIPLE_RALLY_ENABLED: '0', TRIPLE_RALLY_QA_ENABLED: '1' };
  assert.equal(isTripleAllowed(qaOnly, 'qa'), true);
  assert.equal(isTripleAllowed(qaOnly, 'qa-kvk-chromium-42'), false);
  assert.equal(isTripleAllowed(qaOnly, 'operation-room'), false);
  assert.equal(isTripleAllowed(qaOnly, 'practice-room'), false);
  assert.equal(isTripleAllowed({ TRIPLE_RALLY_ENABLED: '1' }, 'operation-room'), true);
});
