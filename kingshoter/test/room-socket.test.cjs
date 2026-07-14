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

function loadApp({ localStorage = createStorage(), crypto = { randomUUID } } = {}) {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }

    receive(message) {
      this.onmessage({ data: typeof message === 'string' ? message : JSON.stringify(message) });
    }
  }

  const context = {
    crypto,
    document: {},
    localStorage,
    location: { protocol: 'https:', host: 'example.test' },
    navigator: { language: 'en' },
    WebSocket: FakeWebSocket
  };
  context.window = context;
  vm.runInNewContext(appSource, context, { filename: 'public/app.js' });
  return { localStorage, sockets, window: context };
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
