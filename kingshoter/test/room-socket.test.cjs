const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const battleConnectionSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'battle-connection.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function createStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    }
  };
}

function createTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimeout(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    }
  };
}

function loadApp({
  localStorage = createStorage(),
  crypto = { randomUUID },
  timers = createTimers(),
  clockSamples = []
} = {}) {
  const sockets = [];
  const pendingClockSamples = clockSamples.slice();
  let clockNowMs = 1_000_000;
  let clockFetches = 0;
  const NativeDate = Date;
  class FakeDate extends NativeDate {
    static now() { return clockNowMs; }
  }
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
    }

    open() {
      this.readyState = 1;
      this.onopen();
    }

    receive(message) {
      this.onmessage({ data: typeof message === 'string' ? message : JSON.stringify(message) });
    }

    emitClose() {
      this.readyState = 3;
      this.onclose();
    }

    close() {
      this.readyState = 2;
    }
  }

  const context = {
    clearTimeout: timers.clearTimeout,
    crypto,
    Date: FakeDate,
    document: {},
    fetch: async () => {
      clockFetches += 1;
      const sample = pendingClockSamples.shift();
      if (!sample) throw new Error('missing clock sample');
      const startedAtMs = clockNowMs;
      return {
        async json() {
          clockNowMs += sample.rttMs;
          return { t: startedAtMs + sample.rttMs / 2 + sample.offsetMs };
        }
      };
    },
    localStorage,
    location: { protocol: 'https:', host: 'example.test' },
    navigator: { language: 'en' },
    clearInterval() {},
    setInterval() { return 1; },
    setTimeout: timers.setTimeout,
    WebSocket: FakeWebSocket
  };
  context.window = context;
  vm.runInNewContext(battleConnectionSource, context, { filename: 'public/battle-connection.js' });
  vm.runInNewContext(appSource, context, { filename: 'public/app.js' });
  return { localStorage, sockets, timers, window: context, clockFetches: () => clockFetches };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

test('RoomSocket advertises build 0 when the optional build is omitted', () => {
  const { sockets, window } = loadApp();
  const roomSocket = new window.RoomSocket('qa-kvk-build-default', () => {});

  assert.equal(roomSocket.clientBuild, 0);
  assert.equal(roomSocket.surface, 'rally');
  assert.equal(sockets[0].url, 'wss://example.test/api/ws?room=qa-kvk-build-default&surface=rally&clientBuild=0');
});

test('RoomSocket preserves a safe positive client build through reconnects', () => {
  const { sockets, timers, window } = loadApp();
  const roomSocket = new window.RoomSocket('qa kvk/build', () => {}, { clientBuild: 2026071302 });

  assert.equal(roomSocket.clientBuild, 2026071302);
  assert.equal(Object.getOwnPropertyDescriptor(roomSocket, 'clientBuild').writable, false);
  roomSocket.clientBuild = 1;
  assert.equal(roomSocket.clientBuild, 2026071302);
  assert.equal(sockets[0].url, 'wss://example.test/api/ws?room=qa%20kvk%2Fbuild&surface=rally&clientBuild=2026071302');

  sockets[0].emitClose();
  const reconnect = [...timers.pending.values()][0].callback;
  reconnect();

  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, 'wss://example.test/api/ws?room=qa%20kvk%2Fbuild&surface=rally&clientBuild=2026071302');
});

test('RoomSocket normalizes malformed client builds to 0', () => {
  const { sockets, window } = loadApp();
  const invalidBuilds = ['2026071302', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null];

  invalidBuilds.forEach((clientBuild, index) => {
    const roomSocket = new window.RoomSocket(`qa-kvk-invalid-${index}`, () => {}, { clientBuild });
    assert.equal(roomSocket.clientBuild, 0);
    assert.match(sockets[index].url, /&surface=rally&clientBuild=0$/);
  });
});

test('RoomSocket accepts the future Defense surface without changing the legacy API', () => {
  const { sockets, window } = loadApp();
  const roomSocket = new window.RoomSocket('qa', () => {}, { surface: 'defense', clientBuild: 17 });

  assert.equal(roomSocket.surface, 'defense');
  assert.equal(sockets[0].url, 'wss://example.test/api/ws?room=qa&surface=defense&clientBuild=17');
  assert.equal(typeof roomSocket.syncClock, 'function');
  assert.equal(typeof roomSocket.clockFresh, 'function');
});

test('window.syncClock delegates through RoomSocket and preserves the legacy clock result', async () => {
  const h = loadApp({
    clockSamples: [
      { rttMs: 80, offsetMs: 900 },
      { rttMs: 35, offsetMs: -400 },
      { rttMs: 12, offsetMs: 275 },
      { rttMs: 50, offsetMs: 700 }
    ]
  });
  new h.window.RoomSocket('qa', () => {}, { surface: 'rally', clientBuild: 2026071701 });

  const result = await h.window.syncClock();

  assert.equal(h.clockFetches(), 4);
  assert.equal(result.rttMs, 12);
  assert.equal(result.offsetMs, 275);
  assert.equal(result.rtt, 12, 'legacy callers keep the rtt field');
  assert.equal(result.offset, 275, 'legacy callers keep the offset field');
  assert.equal(h.window.clockOffset, 275);
  assert.equal(h.window.serverNow(), 1_000_177 + 275);
});

test('RoomSocket preserves state and error routing while dispatching generic messages', () => {
  const { sockets, window } = loadApp();
  const states = [];
  const errors = [];
  const messages = [];
  const roomSocket = new window.RoomSocket('qa-kvk-a', (state) => states.push(clone(state)));
  roomSocket.onError = (error) => errors.push(clone(error));
  roomSocket.onMessage = (message) => messages.push(clone(message));

  sockets[0].receive({ t: 'state', room: { players: {} } });
  sockets[0].receive({ t: 'error', error: 'player_conflict' });
  sockets[0].receive({ t: 'playerMarchSaved', mutationId: 'm1' });
  sockets[0].receive('{malformed');

  assert.deepEqual(states, [{ players: {} }]);
  assert.deepEqual(errors, [{ t: 'error', error: 'player_conflict' }]);
  assert.deepEqual(messages, [{ t: 'playerMarchSaved', mutationId: 'm1' }]);
});

test('RoomSocket ignores messages from an obsolete connection generation', () => {
  const { sockets, window } = loadApp();
  const states = [];
  const errors = [];
  const messages = [];
  const roomSocket = new window.RoomSocket('qa-kvk-generation-message', (state) => states.push(clone(state)));
  roomSocket.onError = (error) => errors.push(clone(error));
  roomSocket.onMessage = (message) => messages.push(clone(message));

  roomSocket.connect();
  sockets[0].receive({ t: 'state', room: { generation: 1 } });
  sockets[0].receive({ t: 'error', error: 'stale_error' });
  sockets[0].receive({ t: 'stale_message' });
  sockets[1].receive({ t: 'state', room: { generation: 2 } });
  sockets[1].receive({ t: 'error', error: 'current_error' });
  sockets[1].receive({ t: 'current_message' });

  assert.deepEqual(states, [{ generation: 2 }]);
  assert.deepEqual(errors, [{ t: 'error', error: 'current_error' }]);
  assert.deepEqual(messages, [{ t: 'current_message' }]);
});

test('RoomSocket ignores close events from an obsolete connection generation', () => {
  const { sockets, timers, window } = loadApp();
  let closeCalls = 0;
  const roomSocket = new window.RoomSocket('qa-kvk-generation-close', () => {});
  roomSocket.onClose = () => { closeCalls += 1; };

  roomSocket.connect();
  sockets[0].emitClose();

  assert.equal(closeCalls, 0);
  assert.equal(timers.pending.size, 0);
  assert.equal(sockets.length, 2);

  sockets[1].emitClose();
  assert.equal(closeCalls, 1);
  assert.equal(timers.pending.size, 1);
});

test('RoomSocket does not schedule the closed generation after onClose replaces it', () => {
  const { sockets, timers, window } = loadApp();
  const roomSocket = new window.RoomSocket('qa-kvk-generation-on-close', () => {});
  roomSocket.onClose = () => roomSocket.connect();

  sockets[0].emitClose();

  assert.equal(sockets.length, 2);
  assert.equal(timers.pending.size, 0);
});

test('RoomSocket cancels obsolete reconnect timers and stale callbacks cannot reconnect', () => {
  const { sockets, timers, window } = loadApp();
  const roomSocket = new window.RoomSocket('qa-kvk-generation-timer', () => {});

  sockets[0].emitClose();
  assert.equal(timers.pending.size, 1);
  const staleReconnect = [...timers.pending.values()][0].callback;

  roomSocket.connect();
  assert.equal(timers.pending.size, 0);
  assert.equal(sockets.length, 2);

  staleReconnect();
  assert.equal(sockets.length, 2);
});

test('RoomSocket close cancels a pending reconnect and invalidates its callback', () => {
  const { sockets, timers, window } = loadApp();
  const roomSocket = new window.RoomSocket('qa-kvk-generation-dead', () => {});

  sockets[0].emitClose();
  const staleReconnect = [...timers.pending.values()][0].callback;
  roomSocket.close();

  assert.equal(timers.pending.size, 0);
  staleReconnect();
  assert.equal(sockets.length, 1);
});

test('RoomSocket refresh replaces and closes the prior generation without dispatching its close', () => {
  const { sockets, timers, window } = loadApp();
  let closeCalls = 0;
  const roomSocket = new window.RoomSocket('qa-kvk-generation-refresh', () => {});
  roomSocket.onClose = () => { closeCalls += 1; };
  const first = sockets[0];

  assert.equal(roomSocket.refresh(), true);

  assert.equal(sockets.length, 2);
  assert.equal(first.readyState, 2);
  assert.equal(closeCalls, 0);
  assert.equal(timers.pending.size, 0);
  first.emitClose();
  assert.equal(closeCalls, 0);
});

test('getRoomDeviceId persists stable UUIDs under room-local keys', () => {
  const storage = createStorage();
  const { window } = loadApp({ localStorage: storage });
  assert.equal(typeof window.getRoomDeviceId, 'function');

  const first = window.getRoomDeviceId('qa-kvk-a');
  const second = window.getRoomDeviceId('qa-kvk-a');
  const otherRoom = window.getRoomDeviceId('qa-kvk-b');

  assert.equal(first, second);
  assert.notEqual(first, otherRoom);
  assert.match(first, /^[0-9a-f-]{36}$/i);
  assert.deepEqual([...storage.values.keys()], [
    'kvk:qa-kvk-a:delivery-device:v1',
    'kvk:qa-kvk-b:delivery-device:v1'
  ]);
  assert.equal(storage.values.get('kvk:qa-kvk-a:delivery-device:v1'), first);
  assert.equal(storage.values.get('kvk:qa-kvk-b:delivery-device:v1'), otherRoom);
});

test('getRoomDeviceId tolerates unavailable localStorage', () => {
  let uuidCalls = 0;
  const localStorage = {
    getItem() { throw new Error('storage unavailable'); },
    setItem() { throw new Error('storage unavailable'); }
  };
  const crypto = {
    randomUUID() {
      uuidCalls += 1;
      return randomUUID();
    }
  };
  const { window } = loadApp({ localStorage, crypto });
  assert.equal(typeof window.getRoomDeviceId, 'function');

  const value = window.getRoomDeviceId('qa-kvk-errors');

  assert.match(value, /^[0-9a-f-]{36}$/i);
  assert.equal(uuidCalls, 1);
});

test('getRoomDeviceId replaces a malformed 36-character value with a canonical UUID', () => {
  const storage = createStorage();
  storage.values.set('kvk:qa-kvk-malformed:delivery-device:v1', '------------------------------------');
  const replacement = '00000000-0000-4000-8000-000000000099';
  const { window } = loadApp({ localStorage: storage, crypto: { randomUUID: () => replacement } });

  assert.equal(window.getRoomDeviceId('qa-kvk-malformed'), replacement);
  assert.equal(storage.values.get('kvk:qa-kvk-malformed:delivery-device:v1'), replacement);
});

test('getRoomDeviceId canonicalizes a stored uppercase UUID for exact ACK matching', () => {
  const storage = createStorage();
  const key = 'kvk:qa-kvk-uppercase:delivery-device:v1';
  storage.values.set(key, 'ABCDEF00-0000-4000-8000-000000000099');
  const { window } = loadApp({ localStorage: storage });

  assert.equal(window.getRoomDeviceId('qa-kvk-uppercase'), 'abcdef00-0000-4000-8000-000000000099');
  assert.equal(storage.values.get(key), 'abcdef00-0000-4000-8000-000000000099');
});
