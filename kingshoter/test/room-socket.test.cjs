const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

function loadApp({ localStorage = createStorage(), crypto = { randomUUID }, timers = createTimers() } = {}) {
  const sockets = [];
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
    document: {},
    localStorage,
    location: { protocol: 'https:', host: 'example.test' },
    navigator: { language: 'en' },
    setTimeout: timers.setTimeout,
    WebSocket: FakeWebSocket
  };
  context.window = context;
  vm.runInNewContext(appSource, context, { filename: 'public/app.js' });
  return { localStorage, sockets, timers, window: context };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

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
