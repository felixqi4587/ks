const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const identityPath = path.join(__dirname, '../public/battle-identity.js');
const identityModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(identityPath, 'utf8'), {
  module: identityModule, exports: identityModule.exports, globalThis: {},
  Object, Array, String, Number, JSON, Math, RegExp, TypeError, Error
}, { filename: identityPath });
const BattleIdentity = identityModule.exports;
const html = fs.readFileSync(path.join(__dirname, '../public/rally.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

test('BattleIdentity exposes the same frozen browser UMD surface', () => {
  const globalThis = {};
  vm.runInNewContext(fs.readFileSync(identityPath, 'utf8'), {
    globalThis, Object, Array, String, Number, JSON, Math, RegExp, TypeError, Error
  }, { filename: identityPath });
  assert.equal(Object.isFrozen(globalThis.BattleIdentity), true);
  assert.deepEqual(Object.keys(globalThis.BattleIdentity).sort(), Object.keys(BattleIdentity).sort());
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values
  };
}

test('identity drafts switch both ways without retaining the other mode value', () => {
  const playerId = BattleIdentity.normalizeDraft({
    identityMode: 'playerId', playerId: '900000777', name: 'Resolved Player', march: 34
  });
  assert.deepEqual(plain(playerId), {
    ok: true,
    profile: { identityMode: 'playerId', playerId: '900000777', name: 'Resolved Player', march: 34 }
  });

  const nickname = BattleIdentity.normalizeDraft({
    identityMode: 'nickname', playerId: '900000777', name: '  Kimchi  ', march: '35'
  });
  assert.deepEqual(plain(nickname), {
    ok: true,
    profile: { identityMode: 'nickname', name: 'Kimchi', march: 35 }
  });
  assert.equal(Object.hasOwn(nickname.profile, 'playerId'), false);
});

test('nickname cleaning removes direction controls, limits Unicode characters, and escapes HTML on demand', () => {
  const cleaned = BattleIdentity.cleanNickname(`  <Kimchi & \u202e>${'鯨'.repeat(30)}  `);
  assert.equal(Array.from(cleaned).length, 24);
  assert.equal(cleaned.includes('\u202e'), false);
  assert.equal(BattleIdentity.escapeHtml(`<Kimchi & "Whale"'>`), '&lt;Kimchi &amp; &quot;Whale&quot;&#39;&gt;');
});

test('identity validation accepts only Player IDs and march times in the 5–120 range', () => {
  for (const march of [5, 120, '5', '120']) {
    assert.equal(BattleIdentity.normalizeDraft({ identityMode: 'nickname', name: 'A', march }).ok, true);
  }
  for (const march of [4, 121, 5.5, '', null, true]) {
    assert.deepEqual(plain(BattleIdentity.normalizeDraft({ identityMode: 'nickname', name: 'A', march })), {
      ok: false, error: 'invalid_march'
    });
  }
  assert.deepEqual(plain(BattleIdentity.normalizeDraft({
    identityMode: 'playerId', playerId: '9x', name: 'A', march: 30
  })), { ok: false, error: 'invalid_player_id' });
  assert.deepEqual(plain(BattleIdentity.normalizeDraft({
    identityMode: 'nickname', name: '\u0000\u202e', march: 30
  })), { ok: false, error: 'invalid_nickname' });
});

test('confirmed profile and device keys are isolated by room and surface', () => {
  const storage = memoryStorage();
  const rally = BattleIdentity.createIdentityStore({
    room: 'qa', surface: 'rally', storage,
    randomUUID: () => '10000000-0000-4000-8000-000000000001'
  });
  const defense = BattleIdentity.createIdentityStore({
    room: 'qa', surface: 'defense', storage,
    randomUUID: () => '20000000-0000-4000-8000-000000000002'
  });
  const otherRoom = BattleIdentity.createIdentityStore({ room: 'other', surface: 'defense', storage });

  assert.deepEqual(plain(rally.keys()), {
    confirmed: 'kingshoter_r_qa_me',
    device: 'kvk:qa:delivery-device:v1',
    rallyConfirmed: 'kingshoter_r_qa_me'
  });
  assert.deepEqual(plain(defense.keys()), {
    confirmed: 'kingshoter_defense_r_qa_me',
    device: 'defense:qa:delivery-device:v1',
    rallyConfirmed: 'kingshoter_r_qa_me'
  });
  assert.notEqual(defense.keys().confirmed, otherRoom.keys().confirmed);

  rally.saveConfirmed({ pid: 'route-rally', identityMode: 'nickname', name: 'Rally', march: 34 });
  defense.saveConfirmed({ pid: 'route-defense', identityMode: 'nickname', name: 'Defense', march: 35 });
  assert.equal(rally.readConfirmed().pid, 'route-rally');
  assert.equal(defense.readConfirmed().pid, 'route-defense');
  assert.equal(rally.deviceId(), '10000000-0000-4000-8000-000000000001');
  assert.equal(defense.deviceId(), '20000000-0000-4000-8000-000000000002');
});

test('Rally reads and writes the unchanged legacy profile and device keys', () => {
  const legacy = {
    pid: 'legacy-route', identityMode: 'playerId', playerId: '900000001',
    name: 'Legacy', march: 41, profileKey: 'owner-secret'
  };
  const storage = memoryStorage({
    kingshoter_r_qa_me: JSON.stringify(legacy),
    'kvk:qa:delivery-device:v1': 'ABCDEF00-0000-4000-8000-000000000003'
  });
  const rally = BattleIdentity.createIdentityStore({ room: 'qa', surface: 'rally', storage });
  assert.deepEqual(plain(rally.readConfirmed()), legacy);
  assert.equal(rally.deviceId(), 'abcdef00-0000-4000-8000-000000000003');

  rally.saveConfirmed(null);
  assert.equal(storage.getItem('kingshoter_r_qa_me'), null);
});

test('Defense may prefill from Rally without becoming confirmed or copying ownership secrets', () => {
  const storage = memoryStorage({
    kingshoter_r_qa_me: JSON.stringify({
      pid: 'same-public-route', identityMode: 'nickname', playerId: 'stale-id',
      name: '  Kimchi  ', march: 34, profileKey: 'rally-secret', editable: true
    })
  });
  const defense = BattleIdentity.createIdentityStore({
    room: 'qa', surface: 'defense', storage, rallyPrefill: true
  });

  assert.equal(defense.readConfirmed(), null);
  assert.deepEqual(plain(defense.readRallyPrefill()), {
    sourceSurface: 'rally', pid: 'same-public-route',
    identityMode: 'nickname', name: 'Kimchi', march: 34
  });
  assert.equal(storage.getItem('kingshoter_defense_r_qa_me'), null);
  assert.equal(Object.hasOwn(defense.readRallyPrefill(), 'profileKey'), false);
});

test('Defense prefill accepts legacy numeric Rally profiles without an identityMode field', () => {
  const storage = memoryStorage({
    kingshoter_r_qa_me: JSON.stringify({ pid: '900000123', name: 'Legacy Captain', march: 42 })
  });
  const defense = BattleIdentity.createIdentityStore({
    room: 'qa', surface: 'defense', storage, rallyPrefill: true
  });
  assert.deepEqual(plain(defense.readRallyPrefill()), {
    sourceSurface: 'rally', pid: '900000123', identityMode: 'playerId',
    playerId: '900000123', name: 'Legacy Captain', march: 42
  });
  assert.equal(defense.readConfirmed(), null);
});

test('Rally identity input keeps its existing class and adds the shared 16px contract class', () => {
  assert.match(html, /<input\s+id="pid"\s+class="[^"]*\bidentityinput\b[^"]*\bbattle-identity-input\b[^"]*"/);
  assert.match(html, /<script\s+src="\/battle-identity\.js\?v=2026071701"><\/script>/);
});
