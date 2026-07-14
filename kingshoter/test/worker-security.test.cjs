const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

async function importSource(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}-${Math.random()}`);
}

function giftEnv(master) {
  const values = {
    lastRedeem: JSON.stringify({ ranAt: 'now', results: [{ name: 'private-player', fid: '123', rows: [] }] }),
    notifyHook: 'https://discord.com/api/webhooks/private',
    discordToken: ''
  };
  return {
    MASTER: master,
    GIFT_KV: {
      get: async (key) => values[key] || null,
      put: async () => {},
      delete: async () => {}
    }
  };
}

function post(password) {
  return new Request('https://kingshoter.test/api/g/private', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
}

test('sensitive gift reads reject GET and require the configured secret', async () => {
  const { handleGift } = await importSource('src/gift.js');
  const ctx = { waitUntil() {} };
  for (const route of ['/lastredeem', '/notifystatus', '/discordstatus']) {
    const get = await handleGift(route, new Request('https://kingshoter.test/api/g' + route), giftEnv('strong-secret'), ctx);
    assert.notEqual(get.status, 200, `${route} must not allow public GET`);
    const wrong = await handleGift(route, post('wrong'), giftEnv('strong-secret'), ctx);
    assert.equal(wrong.status, 403, `${route} must reject a wrong password`);
    const allowed = await handleGift(route, post('strong-secret'), giftEnv('strong-secret'), ctx);
    assert.equal(allowed.status, 200, `${route} must allow the configured secret`);
  }
});

test('gift authentication fails closed when MASTER is missing', async () => {
  const { handleGift } = await importSource('src/gift.js');
  const response = await handleGift('/auth', post(undefined), giftEnv(undefined), { waitUntil() {} });
  assert.notEqual(response.status, 200);
  assert.equal((await response.json()).ok, false);
});

test('room expiry uses awaited Durable Object storage alarms and propagates failures', async () => {
  const { Room } = await importSource('src/room.js');
  const calls = [];
  const room = Object.create(Room.prototype);
  room.room = { live: { commands: { 1: { expiresUTC: 200 }, 2: { expiresUTC: 150 } } } };
  room.state = { storage: {
    setAlarm: async (at) => calls.push(['set', at]),
    deleteAlarm: async () => calls.push(['delete'])
  } };

  await room.scheduleExpiry();
  assert.deepEqual(calls, [['set', 150_600]]);
  room.room.live.commands = { 1: null, 2: null };
  await room.scheduleExpiry();
  assert.deepEqual(calls[1], ['delete']);

  room.room.live.commands = { 1: { expiresUTC: 300 }, 2: null };
  room.state.storage.setAlarm = async () => { throw new Error('alarm write failed'); };
  await assert.rejects(room.scheduleExpiry(), /alarm write failed/);
});

test('room commands expire exactly on their expiry second', async () => {
  const { Room } = await importSource('src/room.js');
  const originalNow = Date.now;
  Date.now = () => 150_600;
  try {
    const room = Object.create(Room.prototype);
    room.room = {
      pwHash: null,
      live: {
        mode: 'live',
        commands: { 1: { expiresUTC: 150 }, 2: null },
        staged: { 1: null, 2: null },
        sim: null
      }
    };
    room.state = { getWebSockets: () => [] };

    assert.equal(room.snapshot().live.commands[1], null, 'late snapshots must not expose a command at the exact expiry boundary');

    let persisted = false;
    room.persist = async () => { persisted = true; };
    room.broadcast = () => {};
    room.scheduleExpiry = async () => {};
    await room.alarm();
    assert.equal(room.room.live.commands[1], null, 'the alarm must clear a command at the exact expiry boundary');
    assert.equal(persisted, true);
  } finally {
    Date.now = originalNow;
  }
});

test('wrangler config contains no plaintext MASTER variable', () => {
  const config = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
  assert.doesNotMatch(config, /^\s*MASTER\s*=/m);
});

test('the hidden gift page never persists its shared secret in localStorage', () => {
  const page = fs.readFileSync(path.join(root, 'public/saltyfish.html'), 'utf8');
  assert.doesNotMatch(page, /localStorage\.setItem\(LS_PW/);
  assert.match(page, /sessionStorage\.setItem\(LS_PW/);
});
