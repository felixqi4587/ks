const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const battleConnectionSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'battle-connection.js'), 'utf8'
);
const battleModule = { exports: {} };
vm.runInNewContext(
  battleConnectionSource,
  {
    module: battleModule,
    exports: battleModule.exports,
    globalThis: {},
    Number,
    Promise,
    Date,
    Math,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }
);
const BattleConnection = battleModule.exports;

test('browser UMD loading exposes BattleConnection on the global object', () => {
  const browserGlobal = {};
  vm.runInNewContext(battleConnectionSource, {
    globalThis: browserGlobal,
    Number,
    Promise,
    Date,
    Math,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });

  assert.equal(typeof browserGlobal.BattleConnection, 'object');
  assert.equal(typeof browserGlobal.BattleConnection.createRoomConnection, 'function');
  assert.equal(browserGlobal.BattleConnection.CLOCK_SYNC_INTERVAL_MS, 180_000);
});

function createRuntime() {
  let nowMs = 1_000_000;
  let nextTimerId = 1;
  let fetchCount = 0;
  const fetchSamples = [];
  const intervals = new Map();
  const timeouts = new Map();
  const sockets = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }

    open() {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }

    receive(message) {
      if (this.onmessage) this.onmessage({
        data: typeof message === 'string' ? message : JSON.stringify(message)
      });
    }

    emitClose() {
      this.readyState = 3;
      if (this.onclose) this.onclose();
    }

    send(value) {
      this.sent.push(value);
    }

    close() {
      this.readyState = 2;
    }
  }

  const runtime = {
    WebSocket: FakeWebSocket,
    location: { protocol: 'https:', host: 'example.test' },
    now: () => nowMs,
    random: () => 0,
    fetch: async () => {
      fetchCount += 1;
      const sample = fetchSamples.shift();
      if (!sample) throw new Error('missing clock sample');
      const startedAtMs = nowMs;
      if (sample.error) {
        nowMs += sample.rttMs || 0;
        throw sample.error;
      }
      return {
        async json() {
          nowMs += sample.rttMs;
          return { t: startedAtMs + sample.rttMs / 2 + sample.offsetMs };
        }
      };
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(callback, delay) {
      const id = nextTimerId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    }
  };

  return {
    runtime,
    sockets,
    timeouts,
    intervals,
    queueClockSample(rttMs, offsetMs) {
      fetchSamples.push({ rttMs, offsetMs });
    },
    queueClockFailure(rttMs = 0) {
      fetchSamples.push({ rttMs, error: new Error('clock unavailable') });
    },
    setNow(value) {
      nowMs = value;
    },
    now() {
      return nowMs;
    },
    fetchCount() {
      return fetchCount;
    }
  };
}

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function queueSuccessfulSync(harness, offsetMs = 250) {
  [80, 35, 12, 50].forEach((rttMs) => harness.queueClockSample(rttMs, offsetMs));
}

test('constructs a surface-scoped WebSocket URL and rejects unknown surfaces', () => {
  const rally = createRuntime();
  const connection = BattleConnection.createRoomConnection({
    room: 'qa room/name', surface: 'rally', clientBuild: 2026071603
  }, rally.runtime);

  assert.equal(rally.sockets.length, 0, 'creation is inert until start');
  connection.start();
  assert.equal(rally.sockets[0].url,
    'wss://example.test/api/ws?room=qa%20room%2Fname&surface=rally&clientBuild=2026071603');

  const defense = createRuntime();
  BattleConnection.createRoomConnection({
    room: 'qa', surface: 'defense', clientBuild: 7
  }, defense.runtime).start();
  assert.equal(defense.sockets[0].url,
    'wss://example.test/api/ws?room=qa&surface=defense&clientBuild=7');

  assert.throws(() => BattleConnection.createRoomConnection({
    room: 'qa', surface: 'spectator', clientBuild: 7
  }, createRuntime().runtime), /surface/i);
});

test('uses ws rather than wss when the page is served over HTTP', () => {
  const h = createRuntime();
  h.runtime.location.protocol = 'http:';
  const connection = BattleConnection.createRoomConnection({
    room: 'qa', surface: 'rally', clientBuild: 2026071603, manageClock: false
  }, h.runtime);

  connection.start();
  assert.equal(h.sockets[0].url,
    'ws://example.test/api/ws?room=qa&surface=rally&clientBuild=2026071603');
});

test('orders connection callbacks around messages and ignores obsolete generations', () => {
  const h = createRuntime();
  const events = [];
  const connection = BattleConnection.createRoomConnection({
    room: 'qa', surface: 'rally',
    onConnectionChange(state) { events.push(`connection:${state.reason}:${state.generation}`); },
    onMessage(message) { events.push(`message:${message.t}`); }
  }, h.runtime);

  connection.start();
  const first = h.sockets[0];
  first.open();
  first.receive({ t: 'first' });
  connection.connect();
  const second = h.sockets[1];
  first.receive({ t: 'stale' });
  first.emitClose();
  second.open();
  second.receive({ t: 'second' });
  second.emitClose();

  assert.deepEqual(events, [
    'connection:connecting:1',
    'connection:open:1',
    'message:first',
    'connection:connecting:2',
    'connection:open:2',
    'message:second',
    'connection:closed:2'
  ]);
  assert.equal(connection.generation(), 2);
  assert.equal(h.timeouts.size, 1);
});

test('a stale reconnect callback cannot replace a newer socket generation', () => {
  const h = createRuntime();
  const connection = BattleConnection.createRoomConnection({ room: 'qa', surface: 'rally' }, h.runtime);

  connection.start();
  h.sockets[0].emitClose();
  const staleReconnect = [...h.timeouts.values()][0].callback;
  connection.connect();

  assert.equal(h.sockets.length, 2);
  assert.equal(h.timeouts.size, 0);
  staleReconnect();
  assert.equal(h.sockets.length, 2);
  assert.equal(connection.generation(), 2);
});

test('stop closes the socket, clears timers, and blocks later traffic', async () => {
  const h = createRuntime();
  queueSuccessfulSync(h);
  const states = [];
  const connection = BattleConnection.createRoomConnection({
    room: 'qa', surface: 'rally',
    onConnectionChange(state) { states.push(state.reason); }
  }, h.runtime);

  connection.start();
  const socket = h.sockets[0];
  socket.open();
  await settle();
  socket.emitClose();
  assert.equal(h.timeouts.size, 1);
  assert.equal(h.intervals.size, 1);

  connection.stop();
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(connection.send({ t: 'late' }), false);
  assert.equal(states.at(-1), 'stopped');
  const fetchCount = h.fetchCount();
  await connection.syncClock();
  assert.equal(h.fetchCount(), fetchCount, 'stop prevents later clock network traffic');
  const socketCount = h.sockets.length;
  connection.start();
  assert.equal(h.sockets.length, socketCount, 'a stopped connection cannot restart');
});

test('clock synchronization retains the lowest-RTT sample', async () => {
  const h = createRuntime();
  h.queueClockSample(80, 900);
  h.queueClockSample(35, -400);
  h.queueClockSample(12, 275);
  h.queueClockSample(50, 700);
  const changes = [];
  const connection = BattleConnection.createRoomConnection({
    room: 'qa', surface: 'rally', onClockChange(sample) { changes.push(sample); }
  }, h.runtime);

  const result = await connection.syncClock();

  assert.equal(result.rttMs, 12);
  assert.equal(result.offsetMs, 275);
  assert.equal(result.fresh, true);
  assert.equal(connection.serverNowMs(), h.now() + 275);
  assert.equal(connection.clockFresh(), true);
  assert.equal(changes.length, 1);
});

test('clock freshness expires at 360 seconds and failed refreshes do not renew it', async () => {
  const h = createRuntime();
  queueSuccessfulSync(h, 100);
  const connection = BattleConnection.createRoomConnection({ room: 'qa', surface: 'rally' }, h.runtime);
  const success = await connection.syncClock();
  const sampledAtMs = success.sampledAtMs;

  h.setNow(sampledAtMs + 359_999);
  assert.equal(connection.clockFresh(), true);
  h.setNow(sampledAtMs + 360_000);
  assert.equal(connection.clockFresh(), false);

  h.setNow(sampledAtMs + 359_000);
  for (let index = 0; index < 4; index += 1) h.queueClockFailure(10);
  const failed = await connection.syncClock();
  assert.equal(failed.rttMs, null);
  assert.equal(failed.sampledAtMs, sampledAtMs);
  h.setNow(sampledAtMs + 359_999);
  assert.equal(connection.clockFresh(), true);
  h.setNow(sampledAtMs + 360_000);
  assert.equal(connection.clockFresh(), false);
});

test('start performs initial clock sync and repeats it every 180 seconds', async () => {
  const h = createRuntime();
  queueSuccessfulSync(h, 125);
  queueSuccessfulSync(h, 225);
  const changes = [];
  const connection = BattleConnection.createRoomConnection({
    room: 'qa', surface: 'rally', onClockChange(sample) { changes.push(sample); }
  }, h.runtime);

  connection.start();
  await settle();
  assert.equal(changes.length, 1);
  assert.equal(h.intervals.size, 1);
  const interval = [...h.intervals.values()][0];
  assert.equal(interval.delay, 180_000);

  interval.callback();
  await settle();
  assert.equal(changes.length, 2);
  assert.equal(changes[1].offsetMs, 225);
});
