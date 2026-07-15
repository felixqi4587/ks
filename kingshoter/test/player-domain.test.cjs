const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function domain() {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'room-player.js'));
  url.searchParams.set('run', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test('march parser is strict and revisions migrate without data loss', async () => {
  const { parseMarchSeconds, normalizeMarchRevision, normalizePlayerRecords } = await domain();
  assert.equal(parseMarchSeconds(5), 5);
  assert.equal(parseMarchSeconds('180'), 180);
  for (const value of [4, 181, 6.5, '6.5', 'abc', '', null, Infinity, NaN]) assert.equal(parseMarchSeconds(value), null);
  assert.equal(normalizeMarchRevision(undefined), 0);
  assert.equal(normalizeMarchRevision(-1), 0);
  assert.equal(normalizeMarchRevision(8), 8);
  const inherited = Object.create({ ghost: { name: 'Inherited', march: 30 } });
  inherited.p1 = { name: 'One', march: 240 };
  const players = normalizePlayerRecords(inherited);
  assert.equal(players.p1.march, 240, 'migration must not clamp an existing record');
  assert.equal(players.p1.marchRevision, 0);
  assert.equal(players.ghost, undefined);
});

test('registration is create-only and explicit updates use optimistic revision', async () => {
  const { registerPlayer, applyPlayerMarchUpdate } = await domain();
  const players = {};
  assert.equal(registerPlayer(players, { pid: '__proto__', march: 35 }, '2026-07-14T00:00:00.000Z').error, 'invalid_pid');
  const created = registerPlayer(players, { pid: '900000001', name: 'Alpha', march: 35, identityMode: 'playerId' }, '2026-07-14T00:00:00.000Z');
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(players['900000001'].marchRevision, 0);

  const duplicate = registerPlayer(players, { pid: '900000001', name: 'Stale', march: 99, identityMode: 'playerId' }, '2026-07-14T00:01:00.000Z');
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.created, false);
  assert.equal(players['900000001'].name, 'Alpha');
  assert.equal(players['900000001'].march, 35);

  const updated = applyPlayerMarchUpdate(players, {
    mutationId: 'm-1', pid: '900000001', march: 36, baseRevision: 0
  }, { touchLastSeen: true, nowISO: '2026-07-14T00:02:00.000Z' });
  assert.deepEqual(updated, { ok: true, mutationId: 'm-1', pid: '900000001', march: 36, revision: 1 });
  assert.equal(players['900000001'].lastSeen, '2026-07-14T00:02:00.000Z');

  const conflict = applyPlayerMarchUpdate(players, {
    mutationId: 'm-2', pid: '900000001', march: 37, baseRevision: 0
  }, { touchLastSeen: false, nowISO: '2026-07-14T00:03:00.000Z' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'player_conflict');
  assert.deepEqual(conflict.latest, { pid: '900000001', march: 36, revision: 1 });
  assert.equal(players['900000001'].march, 36);
});

test('profile player ids normalize strictly and preserve legacy numeric routing ids', async () => {
  const { normalizeProfilePlayerId, profilePlayerId } = await domain();
  assert.equal(normalizeProfilePlayerId('900000001'), '900000001');
  assert.equal(normalizeProfilePlayerId('0'), '0');
  for (const value of ['', '12a', '12345678901234567', null, undefined]) {
    assert.equal(normalizeProfilePlayerId(value), '');
  }
  assert.equal(profilePlayerId('routeA', { identityMode: 'playerId', playerId: '900000001' }), '900000001');
  assert.equal(profilePlayerId('900000002', { identityMode: 'playerId' }), '900000002');
  assert.equal(profilePlayerId('routeA', { identityMode: 'playerId' }), '');
  assert.equal(profilePlayerId('900000002', { identityMode: 'nickname', playerId: '900000001' }), '');
});

test('legacy numeric routing ids remain reserved unless the record is explicitly nickname mode', async () => {
  const { applyOwnProfileUpdate, profilePlayerId, registerPlayer } = await domain();
  const players = {
    '900000009': { name: 'Legacy', march: 35, marchRevision: 0 },
    routeA: { name: 'Alpha', march: 36, marchRevision: 0, identityMode: 'nickname' }
  };

  assert.equal(profilePlayerId('900000009', players['900000009']), '900000009');
  assert.equal(registerPlayer(players, {
    pid: 'routeB', identityMode: 'playerId', playerId: '900000009', name: 'Bravo', march: 37
  }, '2026-07-15T00:00:00.000Z').error, 'player_id_conflict');
  assert.equal(applyOwnProfileUpdate(players, {
    mutationId: 'legacy-collision', pid: 'routeA', identityMode: 'playerId',
    playerId: '900000009', name: 'Alpha', march: 36, baseRevision: 0
  }).error, 'player_id_conflict');
  assert.equal(profilePlayerId('900000010', {
    name: 'Explicit Nickname', march: 38, identityMode: 'nickname'
  }), '');
});

test('whole-profile edits are atomic, keep the routing pid, and return canonical profiles', async () => {
  const { applyOwnProfileUpdate } = await domain();
  const nowISO = '2026-07-15T00:00:00.000Z';
  const players = {
    routeA: { name: 'Alpha', march: 30, marchRevision: 0, identityMode: 'nickname', lastSeen: 'before' },
    routeB: { name: 'Bravo', march: 40, marchRevision: 2, identityMode: 'playerId', playerId: '900000002' }
  };

  const updated = applyOwnProfileUpdate(players, {
    mutationId: 'profile-1', pid: 'routeA', identityMode: 'playerId',
    playerId: '900000001', name: 'Resolved Alpha', march: 31, baseRevision: 0
  }, { touchLastSeen: true, nowISO });
  assert.equal(updated.ok, true);
  assert.equal(updated.mutationId, 'profile-1');
  assert.deepEqual(updated.profile, {
    pid: 'routeA', identityMode: 'playerId', playerId: '900000001',
    name: 'Resolved Alpha', march: 31, revision: 1
  });
  assert.deepEqual(players.routeA, {
    name: 'Resolved Alpha', march: 31, marchRevision: 1, identityMode: 'playerId',
    lastSeen: nowISO, playerId: '900000001'
  });
  assert.equal(players['900000001'], undefined, 'profile identity must not replace the routing pid');

  const staleSnapshot = structuredClone(players);
  const stale = applyOwnProfileUpdate(players, {
    mutationId: 'profile-stale', pid: 'routeA', identityMode: 'nickname',
    name: 'Should Not Apply', march: 32, baseRevision: 0
  }, { touchLastSeen: true, nowISO: '2026-07-15T00:01:00.000Z' });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'player_conflict');
  assert.deepEqual(stale.profile, {
    pid: 'routeA', identityMode: 'playerId', playerId: '900000001',
    name: 'Resolved Alpha', march: 31, revision: 1
  });
  assert.deepEqual(players, staleSnapshot);

  const nickname = applyOwnProfileUpdate(players, {
    mutationId: 'profile-2', pid: 'routeA', identityMode: 'nickname',
    name: 'Alpha Nick', march: 32, baseRevision: 1
  });
  assert.equal(nickname.ok, true);
  assert.deepEqual(nickname.profile, {
    pid: 'routeA', identityMode: 'nickname', name: 'Alpha Nick', march: 32, revision: 2
  });
  assert.equal(Object.hasOwn(nickname.profile, 'playerId'), false);
  assert.equal(Object.hasOwn(players.routeA, 'playerId'), false);
});

test('profile validation, identity collisions, and missing players never partially mutate', async () => {
  const { applyOwnProfileUpdate } = await domain();
  const players = {
    routeA: { name: 'Alpha', march: 30, marchRevision: 0, identityMode: 'nickname' },
    routeB: { name: 'Bravo', march: 40, marchRevision: 0, identityMode: 'playerId', playerId: '900000002' }
  };
  const attempts = [
    [{ mutationId: 'bad-id', pid: 'routeA', identityMode: 'playerId', playerId: '9x', name: 'Alpha', march: 31, baseRevision: 0 }, 'invalid_player_id'],
    [{ mutationId: 'bad-name', pid: 'routeA', identityMode: 'nickname', name: ' \u0000 ', march: 31, baseRevision: 0 }, 'invalid_nickname'],
    [{ mutationId: 'bad-march', pid: 'routeA', identityMode: 'nickname', name: 'Alpha', march: 181, baseRevision: 0 }, 'invalid_march'],
    [{ mutationId: 'collision', pid: 'routeA', identityMode: 'playerId', playerId: '900000002', name: 'Alpha', march: 31, baseRevision: 0 }, 'player_id_conflict'],
    [{ mutationId: 'missing', pid: 'routeC', identityMode: 'nickname', name: 'Charlie', march: 31, baseRevision: 0 }, 'player_missing']
  ];
  for (const [input, error] of attempts) {
    const before = structuredClone(players);
    const result = applyOwnProfileUpdate(players, input, { touchLastSeen: true, nowISO: 'later' });
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
    assert.deepEqual(players, before, `${error} must leave every player unchanged`);
  }
});

test('registration persists valid explicit player ids uniquely while omitted ids remain compatible', async () => {
  const { registerPlayer } = await domain();
  const players = {};
  const explicit = registerPlayer(players, {
    pid: 'routeA', identityMode: 'playerId', playerId: '900000001', name: 'Alpha', march: 35
  }, '2026-07-15T00:00:00.000Z');
  assert.equal(explicit.ok, true);
  assert.equal(players.routeA.playerId, '900000001');

  const beforeInvalid = structuredClone(players);
  assert.equal(registerPlayer(players, {
    pid: 'routeB', identityMode: 'playerId', playerId: 'invalid', name: 'Bravo', march: 36
  }, '2026-07-15T00:01:00.000Z').error, 'invalid_player_id');
  assert.deepEqual(players, beforeInvalid);

  assert.equal(registerPlayer(players, {
    pid: 'routeB', identityMode: 'playerId', playerId: '900000001', name: 'Bravo', march: 36
  }, '2026-07-15T00:01:00.000Z').error, 'player_id_conflict');
  assert.deepEqual(players, beforeInvalid);

  const legacy = registerPlayer(players, {
    pid: '900000003', identityMode: 'playerId', name: 'Legacy', march: 37
  }, '2026-07-15T00:02:00.000Z');
  assert.equal(legacy.ok, true);
  assert.equal(legacy.created, true);
  assert.equal(Object.hasOwn(players['900000003'], 'playerId'), false);
});

test('staged removal is atomic while an unexpired command blocks it', async () => {
  const { removePlayerAtomic } = await domain();
  const room = {
    players: { p1: { name: 'One', march: 30, marchRevision: 0 } },
    live: {
      staged: {
        1: { kingdom: 1, pairs: [{ pid: 'p1', role: 'weak' }] },
        2: { kingdom: 2, pairs: [{ pid: 'p1', role: 'main' }] }
      },
      commands: { 1: null, 2: null }
    }
  };
  const removed = removePlayerAtomic(room, 'p1', 100);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.cleared, [{ kingdom: 1, role: 'weak' }, { kingdom: 2, role: 'main' }]);
  assert.equal(room.players.p1, undefined);
  assert.equal(room.live.staged[1], null);
  assert.equal(room.live.staged[2], null);

  room.players.p1 = { name: 'One', march: 30, marchRevision: 0 };
  room.live.staged[1] = { kingdom: 1, pairs: [{ pid: 'p1', role: 'weak' }] };
  room.live.commands[1] = { id: 'c1', expiresUTC: 101, payload: { pairs: [{ pid: 'p1' }] } };
  const blocked = removePlayerAtomic(room, 'p1', 100);
  assert.deepEqual(blocked, { ok: false, error: 'player_in_live_command', pid: 'p1' });
  assert.ok(room.players.p1);
  assert.deepEqual(room.live.staged[1].pairs, [{ pid: 'p1', role: 'weak' }]);

  room.live.commands[1].expiresUTC = 100;
  assert.equal(removePlayerAtomic(room, 'p1', 100).ok, true, 'expiry at now is not active');
});

test('double-rally snapshot uses canonical values and generic target extraction has no pair-count assumption', async () => {
  const { freezeDoubleRally, rallyTargetPids } = await domain();
  const players = {
    weak: { name: 'Weak', march: 40, marchRevision: 2 },
    main: { name: 'Main', march: 50, marchRevision: 3 },
    third: { name: 'Third', march: 60, marchRevision: 1 }
  };
  const frozen = freezeDoubleRally(players, [
    { pid: 'weak', role: 'weak', name: 'stale', march: 99 },
    { pid: 'main', role: 'main', name: 'stale', march: 99 }
  ], 1000);
  assert.equal(frozen.ok, true);
  assert.deepEqual(frozen.pairs, [
    { pid: 'weak', name: 'Weak', role: 'weak', march: 40, pressUTC: 1009 },
    { pid: 'main', name: 'Main', role: 'main', march: 50, pressUTC: 1000 }
  ]);
  assert.deepEqual(rallyTargetPids({ payload: { pairs: [
    { pid: 'weak' }, { pid: 'main' }, { pid: 'third' }, { pid: 'weak' }
  ] } }), ['weak', 'main', 'third']);
});
