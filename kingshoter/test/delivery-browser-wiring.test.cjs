const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const HTML_PATH = path.join(PUBLIC, 'kvk.html');
const SCRIPT_PATH = path.join(PUBLIC, 'kvk.js');
const APP_PATH = path.join(PUBLIC, 'app.js');
const SHADOW_PATH = path.join(PUBLIC, 'kvk-delivery-shadow.js');
const CACHE_TEST_PATHS = [
  path.join(__dirname, 'classic-delivery-client.test.cjs'),
  path.join(__dirname, 'march-sync.e2e.cjs'),
  path.join(__dirname, 'identity-input.e2e.cjs'),
  path.join(__dirname, 'roster-control.e2e.cjs'),
  path.join(__dirname, 'player-removal.e2e.cjs')
];

const read = file => fs.readFileSync(file, 'utf8');
const html = read(HTML_PATH);
const script = read(SCRIPT_PATH);
const app = read(APP_PATH);
const shadow = read(SHADOW_PATH);

const DEVICE_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const QA_ROOM = 'qa-kvk-browser-a';
const BLOCK_START = '/* ---------- reliable delivery shadow QA ---------- */';
const BLOCK_END = '/* ---------- reliable delivery shadow QA end ---------- */';
const plain = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing production function ${name}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `missing body for production function ${name}`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated production function ${name}`);
}

function extractShadowBlock() {
  const start = script.indexOf(BLOCK_START);
  const end = script.indexOf(BLOCK_END);
  assert.notEqual(start, -1, 'Task 6 delivery shadow wiring block is missing');
  assert.ok(end > start, 'Task 6 delivery shadow wiring block is incomplete');
  return script.slice(start + BLOCK_START.length, end);
}

function loadTask5Api() {
  const context = {};
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(shadow, context, { filename: SHADOW_PATH });
  return context.KvkDeliveryShadow;
}

function createTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  const delays = [];
  return {
    delays,
    pending,
    setTimeout(callback, delay) {
      const id = nextId++;
      delays.push(delay);
      pending.set(id, { at: now + Number(delay), callback });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...pending.entries()]
          .filter(([, value]) => value.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        now = due[1].at;
        pending.delete(due[0]);
        await Promise.resolve();
        await due[1].callback();
      }
      now = target;
      await Promise.resolve();
    }
  };
}

function makeSocketClass(state) {
  return class FakeRoomSocket {
    constructor(room, onState) {
      this.room = room;
      this.onState = onState;
      this.onMessage = null;
      this.onOpen = null;
      this.onClose = null;
      this.onError = null;
      this.connectionGeneration = 1;
      this.connected = true;
      state.sockets.push(this);
      state.log.push('socket:create');
    }

    send(message) {
      const value = plain(message);
      state.log.push(`socket:send:${String(value && value.t || '')}`);
      state.sent.push(value);
      if (state.socketSend) return state.socketSend(value, this);
      return true;
    }

    async open() {
      await Promise.resolve();
      state.log.push(`socket:open:${this.connectionGeneration}`);
      if (this.onOpen) this.onOpen();
      await Promise.resolve();
    }

    async receive(message, generation = this.connectionGeneration) {
      await Promise.resolve();
      if (generation !== this.connectionGeneration) return false;
      if (this.onMessage) this.onMessage(plain(message));
      await Promise.resolve();
      return true;
    }

    async error(message, generation = this.connectionGeneration) {
      await Promise.resolve();
      if (generation !== this.connectionGeneration) return false;
      if (this.onError) this.onError(plain(message));
      await Promise.resolve();
      return true;
    }

    async reconnect() {
      this.connectionGeneration += 1;
      await this.open();
    }
  };
}

function createControllerApi(state, config) {
  const actual = loadTask5Api();
  return Object.freeze({
    isQaRoomName(room) {
      state.calls.predicate += 1;
      return actual.isQaRoomName(room);
    },
    create(options) {
      state.calls.create += 1;
      state.log.push('shadow:create');
      state.createOptions = options;
      if (config.createThrows) throw new Error('simulated create failure');
      if (Object.prototype.hasOwnProperty.call(config, 'createResult')) {
        return config.createResult;
      }
      const controller = actual.create(options);
      return Object.freeze({
        enabled: controller.enabled,
        onOpen() {
          state.calls.onOpen += 1;
          state.log.push('shadow:onOpen');
          if (config.onOpenThrows) throw new Error('simulated onOpen failure');
          if (typeof config.onOpen === 'function') {
            return config.onOpen({ controller, options, state });
          }
          return controller.onOpen();
        },
        handleMessage(message) {
          state.calls.handle += 1;
          state.log.push(`shadow:handle:${String(message && message.t || '')}`);
          if (config.handleThrows) throw new Error('simulated handle failure');
          if (typeof config.handleMessage === 'function') {
            return config.handleMessage(message, { controller, options, state });
          }
          return controller.handleMessage(message);
        },
        state() {
          return controller.state();
        }
      });
    }
  });
}

function createHarness(config = {}) {
  const query = Object.prototype.hasOwnProperty.call(config, 'query')
    ? config.query
    : `?room=${QA_ROOM}&deliveryQa=1&deliveryShadow=1`;
  const qp = new URLSearchParams(query);
  const room = (qp.get('room') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  const timers = createTimers();
  const state = {
    audioArmed: Object.prototype.hasOwnProperty.call(config, 'audioArmed')
      ? config.audioArmed : true,
    calls: { predicate: 0, create: 0, onOpen: 0, handle: 0, audioAlive: 0 },
    coreMessages: [],
    createOptions: null,
    log: [],
    sent: [],
    sockets: [],
    socketSend: config.socketSend || null,
    syncWaiters: []
  };
  const context = {
    __api: createControllerApi(state, config),
    __commander: config.commander === true,
    __deviceId: Object.prototype.hasOwnProperty.call(config, 'deviceId')
      ? config.deviceId : DEVICE_ID,
    __pid: Object.prototype.hasOwnProperty.call(config, 'pid') ? config.pid : '700001',
    __qp: qp,
    __room: room,
    __state: state,
    clearTimeout: timers.clearTimeout,
    setTimeout: timers.setTimeout
  };
  context.window = context;
  context.globalThis = context;
  context.KvkDeliveryShadow = context.__api;
  context.RoomSocket = makeSocketClass(state);
  context.serverNow = () => {
    state.calls.now = (state.calls.now || 0) + 1;
    return 1_000_000;
  };
  context.confirm = () => false;

  const harnessSource = `
    var qp = __qp, ROOM = __room;
    var sock = null, myPid = __pid, deviceId = __deviceId;
    var tripleClientAvailable = false;
    var initialStateSeen = false, registrationPending = false, pendingRegistrationProfile = null, syncedOK = false;
    var syncAttempt = 0;
    var pendingMarchMutation = null, pendingCommanderMarchMutation = null;
    var pendingStageMutation = null, roomSnapshotSequence = 0;
    var commanderMarchStatus = '', commanderMarchStatusTone = '', commanderMarchDirty = false;
    var pendingUnlock = false, roomPw = '', pendingPubWhales = null, pendingPubTok = null, room = null;
    function onState() {}
    function safeUpdateCheck() { return false; }
    function isCommanderDevice() { return __commander === true; }
    function audioAlive() { __state.calls.audioAlive += 1; return __state.audioArmed === true; }
    function handlePlayerRegistrationAck() { return false; }
    function handleRallyModeMessage() { return false; }
    function handleStageSuperseded() { return false; }
    function handleDeviceStatusSaved(message) {
      __state.log.push('core:' + String(message && message.t || ''));
      __state.coreMessages.push(message);
      return !!message && message.t === 'deviceStatusSaved' &&
        message.pid === myPid && message.deviceId === deviceId;
    }
    function handleDeliveryAckSaved(message) { return !!message && message.t === 'deliveryAckSaved'; }
    function handleCommanderMarchAck() { return false; }
    function settlePendingMarchMutation() {}
    function setNet() { __state.log.push('core:setNet'); }
    function sendDeviceStatus() {
      __state.log.push('core:deviceStatus');
      return sock.send({ t: 'deviceStatus', pid: myPid, deviceId: deviceId, soundReady: true });
    }
    function retryPendingDeliveryAcks() { __state.log.push('core:retryAcks'); }
    function resetPendingRegistrationConnectionEvidence() { return false; }
    function beginClockSync(done) {
      var attempt = ++syncAttempt;
      syncedOK = false;
      __state.log.push('core:clockSync');
      return new Promise(function (resolve) {
        __state.syncWaiters.push({
          finish: function (ok) {
            if (attempt !== syncAttempt) { resolve(false); return; }
            syncedOK = ok === true;
            if (done) done(syncedOK);
            resolve(syncedOK);
          }
        });
      });
    }
    function renderCommanderMarchEditor() {}
    function clearPendingRallyFire() {}
    function clearPendingRallyMode() {}
    function markRemovalDisconnected() {}
    function rejectPendingDeliveryAck() { return false; }
    var DEVICE_STATUS_RETRY_MS = 1200;
    function clearDeviceStatusGuards() { __state.log.push('core:clearDeviceStatusGuards'); }
    ${extractFunction(script, 'handleDeviceStatusError')}
    function handleRallyModeError() { return false; }
    function handleRallyCommandError() { return false; }
    function handleRallyStageConflict() { return false; }
    function handleCommanderMarchProtocolError() { return false; }
    function handlePlayerProtocolError() { return false; }
    function handleRemovalProtocolError() { return false; }
    function rollbackStageSelection() {}
    function tk(value) { return value; }
    function invalidateCommanderAccess() {}
    function unlockedOK() {}
    function sendWhales() {}
    ${extractFunction(script, 'handleSocketMessage')}
    ${extractShadowBlock()}
    ${extractFunction(script, 'connect')}
    globalThis.__harness = {
      connect: connect,
      currentSocket: function () { return sock; },
      resync: function () { return beginClockSync(); },
      setIdentity: function (pid, nextDeviceId) { myPid = pid; deviceId = nextDeviceId; },
      setSynced: function (value) { syncedOK = value === true; },
      identity: function () { return { pid: myPid, deviceId: deviceId }; }
    };
  `;
  vm.runInNewContext(harnessSource, context, { filename: 'public/kvk-task-6-seam.js' });

  return {
    context,
    state,
    timers,
    connect() {
      context.__harness.connect();
      return context.__harness.currentSocket();
    },
    currentSocket() {
      return context.__harness.currentSocket();
    },
    resync() {
      return context.__harness.resync();
    },
    setIdentity(pid, nextDeviceId = DEVICE_ID) {
      context.__harness.setIdentity(pid, nextDeviceId);
    },
    setSynced(value) {
      context.__harness.setSynced(value);
    },
    async resolveSync(ok = true) {
      return this.resolveSyncAt(0, ok);
    },
    async resolveSyncAt(index, ok = true) {
      assert.ok(index >= 0 && index < state.syncWaiters.length, 'clock sync is pending');
      const waiter = state.syncWaiters.splice(index, 1)[0];
      await Promise.resolve();
      waiter.finish(ok);
      await Promise.resolve();
    }
  };
}

function ready(overrides = {}) {
  return {
    t: 'deviceStatusSaved',
    pid: '700001',
    deviceId: DEVICE_ID,
    soundReady: true,
    ...overrides
  };
}

function probe(overrides = {}) {
  return {
    t: 'deliveryShadowProbe',
    v: 1,
    probeId: 'probe-browser-a',
    sentAtMs: 999_900,
    expiresAtMs: 1_001_900,
    ...overrides
  };
}

function sentType(state, type) {
  return state.sent.filter(message => message.t === type);
}

test('the updater bootstrap and isolated delivery controller load in one build generation', () => {
  const updateIndex = html.indexOf('<script src="/kvk-update.js?v=2026071603"></script>');
  const appIndex = html.indexOf('<script src="/app.js?v=2026071603"></script>');
  const shadowTag = '<script src="/kvk-delivery-shadow.js?v=2026071603"></script>';
  const shadowIndex = html.indexOf(shadowTag);
  const rallyTag = '<script src="/kvk-rally.js?v=2026071603"></script>';
  const rallyIndex = html.indexOf(rallyTag);
  const kvkIndex = html.indexOf('<script src="/kvk.js?v=2026071603"></script>');

  assert.ok(updateIndex >= 0, 'supported-build updater loads');
  assert.ok(appIndex > updateIndex, 'shared app loads after the updater');
  assert.ok(shadowIndex > appIndex, 'shadow controller loads after app.js');
  assert.ok(rallyIndex > shadowIndex, 'shared rally semantics load after the isolated shadow');
  assert.ok(kvkIndex > rallyIndex, 'KvK runtime loads after both optional controllers');
  assert.equal(html.split(shadowTag).length - 1, 1, 'the controller loads exactly once');
  assert.equal(html.split(rallyTag).length - 1, 1, 'shared rally semantics load exactly once');
  assert.doesNotMatch(html.replace(shadowTag, ''), /delivery(?:Qa|Shadow)/i,
    'the QA candidate adds no HTML control, copy, style, or mode selector');
});

test('KvK cache assertions move atomically to the supported build', () => {
  const cacheSources = [html, ...CACHE_TEST_PATHS.map(read)];
  for (const source of cacheSources) {
    assert.equal(source.includes('kvk.js?v=41') || source.includes('kvk\\.js\\?v=41'), false);
    assert.equal(source.includes('kvk.js?v=2026071603') || source.includes('kvk\\.js\\?v=2026071603'), true);
  }
});

test('exact decoded room and single exact QA flags are the only activation path', () => {
  const inertQueries = [
    `?room=${QA_ROOM}`,
    `?room=${QA_ROOM}&deliveryQa=0&deliveryShadow=1`,
    `?room=${QA_ROOM}&deliveryQa=1&deliveryShadow=0`,
    `?room=${QA_ROOM}&deliveryQa=1&deliveryQa=1&deliveryShadow=1`,
    `?room=${QA_ROOM}&deliveryQa=1&deliveryQa=0&deliveryShadow=1`,
    `?room=${QA_ROOM}&deliveryQa=0&deliveryQa=1&deliveryShadow=1`,
    `?room=${QA_ROOM}&deliveryQa=1&deliveryShadow=1&deliveryShadow=1`,
    `?room=${QA_ROOM}&deliveryQa=1&deliveryShadow=1&deliveryShadow=0`,
    `?room=${QA_ROOM}&deliveryQa=1&deliveryShadow=0&deliveryShadow=1`,
    `?room=${QA_ROOM}&room=${QA_ROOM}&deliveryQa=1&deliveryShadow=1`,
    `?room=${QA_ROOM}&room=operation-room&deliveryQa=1&deliveryShadow=1`,
    `?room=${QA_ROOM}%2F&deliveryQa=1&deliveryShadow=1`,
    `?room=!${QA_ROOM}&deliveryQa=1&deliveryShadow=1`,
    `?room=${QA_ROOM}!&deliveryQa=1&deliveryShadow=1`,
    `?room=${'qa-kvk-' + 'a'.repeat(42)}&deliveryQa=1&deliveryShadow=1`,
    '?room=QA-kvk-a&deliveryQa=1&deliveryShadow=1',
    '?room=qa-kvk-a_&deliveryQa=1&deliveryShadow=1',
    '?room=qa-kvk-a-&deliveryQa=1&deliveryShadow=1',
    '?room=operation-room&deliveryQa=1&deliveryShadow=1',
    '?deliveryQa=1&deliveryShadow=1'
  ];

  for (const query of inertQueries) {
    const h = createHarness({ query });
    h.connect();
    assert.equal(h.state.calls.create, 0, query);
    assert.equal(h.state.calls.audioAlive, 0, query);
    assert.equal(h.state.calls.now || 0, 0, query);
    assert.equal(h.state.createOptions, null, query);
    assert.equal(Object.prototype.hasOwnProperty.call(h.context, '__kvkDeliveryQa'), false, query);
    assert.deepEqual(h.state.sent, [], query);
  }

  const enabled = createHarness();
  enabled.connect();
  enabled.connect();
  assert.equal(enabled.state.calls.create, 1, 'construction is once per page');
  assert.equal(enabled.state.sockets.length, 2);
  assert.ok(enabled.state.log.indexOf('shadow:create') < enabled.state.log.indexOf('socket:create'));
  assert.ok(enabled.context.__kvkDeliveryQa);
});

test('throwing or incomplete controller construction is attempted once and stays unexposed', () => {
  const cases = [
    { createThrows: true },
    { createResult: false },
    { createResult: Object.freeze({ enabled: true }) },
    {
      createResult: Object.freeze({
        enabled: true,
        onOpen() { return true; },
        handleMessage() { return true; },
        state() { return {}; },
        extra: true
      })
    },
    {
      createResult: {
        enabled: true,
        onOpen() { return true; },
        handleMessage() { return true; },
        state() { return {}; }
      }
    }
  ];
  for (const config of cases) {
    const h = createHarness(config);
    assert.doesNotThrow(() => h.connect());
    assert.doesNotThrow(() => h.connect());
    assert.equal(h.state.calls.create, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(h.context, '__kvkDeliveryQa'), false);
  }
});

test('generic dispatch is Core-first and forwards only deliveryShadow-prefixed types', async () => {
  const h = createHarness({ handleMessage: () => true });
  const socket = h.connect();
  const messages = [
    { t: 'unknownAdditive' },
    { t: 'deliveryAckSaved' },
    { t: 'deliveryShadowCommand' },
    { t: 'deliveryShadowProbe' },
    { t: 7 }
  ];
  for (const message of messages) {
    const before = h.state.log.length;
    await socket.receive(message);
    const dispatched = h.state.log.slice(before);
    assert.equal(dispatched[0], `core:${String(message.t)}`);
    if (typeof message.t === 'string' && message.t.indexOf('deliveryShadow') === 0) {
      assert.equal(dispatched[1], `shadow:handle:${message.t}`);
    } else {
      assert.equal(dispatched.some(value => value.indexOf('shadow:handle:') === 0), false);
    }
  }
  assert.equal(h.state.coreMessages.length, messages.length);
  assert.equal(h.state.calls.handle, 2);
});

test('ready bind and successful clock sync start hello in either completion order', async () => {
  for (const order of ['bind-first', 'sync-first']) {
    const h = createHarness();
    const socket = h.connect();
    await socket.open();
    assert.deepEqual(h.state.log.filter(value => value.indexOf('core:') === 0).slice(0, 4), [
      'core:setNet', 'core:deviceStatus', 'core:retryAcks', 'core:clockSync'
    ]);
    assert.equal(h.state.calls.onOpen, 0, order);
    if (order === 'bind-first') {
      await socket.receive(ready());
      assert.equal(h.state.calls.onOpen, 0, order);
      await h.resolveSync(true);
    } else {
      await h.resolveSync(true);
      assert.equal(h.state.calls.onOpen, 0, order);
      await socket.receive(ready());
    }
    assert.equal(h.state.calls.onOpen, 1, order);
    assert.equal(sentType(h.state, 'deliveryShadowHello').length, 1, order);
    const coreIndex = h.state.log.lastIndexOf('core:deviceStatusSaved');
    const shadowIndex = h.state.log.lastIndexOf('shadow:onOpen');
    assert.ok(coreIndex >= 0 && shadowIndex > coreIndex, order);
  }
});

test('wrong bind facts, failed sync, and stale generations cannot start hello', async () => {
  const h = createHarness();
  const socket = h.connect();
  await socket.open();
  await h.resolveSync(false);
  for (const message of [
    ready({ t: 'deviceSaved' }),
    ready({ pid: '700002' }),
    ready({ deviceId: '00000000-0000-4000-8000-000000000099' }),
    ready({ soundReady: false }),
    ready()
  ]) {
    await socket.receive(message);
  }
  assert.equal(h.state.calls.onOpen, 0);

  await socket.reconnect();
  const currentGeneration = socket.connectionGeneration;
  await socket.receive(ready(), currentGeneration - 1);
  await h.resolveSync(true);
  assert.equal(h.state.calls.onOpen, 0);
  await socket.receive(ready(), currentGeneration);
  assert.equal(h.state.calls.onOpen, 1);
});

test('late canonical identity stays silent until its exact ready bind', async () => {
  const h = createHarness({ pid: '' });
  const socket = h.connect();
  await socket.open();
  await h.resolveSync(true);
  await socket.receive(ready({ pid: '' }));
  assert.equal(h.state.calls.onOpen, 0);
  assert.equal(sentType(h.state, 'deliveryShadowHello').length, 0);

  h.setIdentity('700001');
  await socket.receive(ready());
  assert.equal(h.state.calls.onOpen, 1);
  assert.deepEqual(sentType(h.state, 'deliveryShadowHello')[0], {
    t: 'deliveryShadowHello', v: 1, shadow: true,
    pid: '700001', deviceId: DEVICE_ID, view: 'player'
  });
});

test('first open, reconnect, and replacement socket reuse one controller and rebind independently', async () => {
  const h = createHarness();
  const first = h.connect();
  await first.open();
  await first.receive(ready());
  await h.resolveSync(true);
  await first.receive(ready());
  assert.equal(h.state.calls.onOpen, 1, 'duplicate ready facts do not bypass the retry cadence');
  await first.receive(probe());
  assert.equal(h.state.calls.create, 1);
  assert.equal(h.state.calls.onOpen, 1);
  assert.equal(h.timers.pending.size, 0, 'valid probe confirms the first handshake');

  await first.reconnect();
  await first.receive(ready());
  await h.resolveSync(true);
  await first.receive(probe({ probeId: 'probe-reconnect' }));
  assert.equal(h.state.calls.create, 1);
  assert.equal(h.state.calls.onOpen, 2);
  assert.equal(h.timers.pending.size, 0);

  const replacement = h.connect();
  assert.notEqual(replacement, first);
  await replacement.open();
  await h.resolveSync(true);
  await replacement.receive(ready());
  await replacement.receive(probe({ probeId: 'probe-replacement' }));
  assert.equal(h.state.calls.create, 1);
  assert.equal(h.state.calls.onOpen, 3, 'socket reference participates in handshake identity');
  assert.equal(h.context.__kvkDeliveryQa.getSocket(), replacement, 'QA socket accessor stays live');
});

test('delayed messages from a replaced RoomSocket cannot bind or confirm the current socket', async () => {
  const h = createHarness();
  const first = h.connect();
  await first.open();
  await h.resolveSync(true);
  await first.receive(ready());
  await first.receive(probe({ probeId: 'probe-first-confirmed' }));
  assert.equal(h.state.calls.onOpen, 1);

  const replacement = h.connect();
  await replacement.open();
  await h.resolveSync(true);
  const helloCount = h.state.calls.onOpen;
  await first.receive(ready());
  assert.equal(h.state.calls.onOpen, helloCount,
    'an old socket ready frame cannot start the replacement handshake');

  await replacement.receive(ready());
  assert.equal(h.state.calls.onOpen, helloCount + 1);
  assert.equal(h.timers.pending.size, 1);
  const handledCount = h.state.calls.handle;
  await first.receive(probe({ probeId: 'probe-from-replaced-socket' }));
  assert.equal(h.state.calls.handle, handledCount,
    'an old socket probe never reaches the current controller session');
  assert.equal(h.timers.pending.size, 1,
    'an old socket probe cannot falsely confirm the replacement handshake');

  await replacement.receive(probe({ probeId: 'probe-replacement-confirmed' }));
  assert.equal(h.timers.pending.size, 0);
});

test('a probe-confirmed handshake survives same-generation ready false to true without another hello', async () => {
  const h = createHarness();
  const socket = h.connect();
  await socket.open();
  await h.resolveSync(true);
  await socket.receive(ready());
  await socket.receive(probe());
  assert.equal(h.state.calls.onOpen, 1);

  await socket.receive(ready({ soundReady: false }));
  await socket.receive(ready({ soundReady: true }));
  assert.equal(h.state.calls.onOpen, 1, 'server readiness recovery owns the next probe');
  await socket.receive(probe({ probeId: 'probe-after-recovery' }));
  assert.equal(h.state.calls.handle, 2);
  assert.equal(sentType(h.state, 'deliveryShadowProbeAck').length, 2);
});

test('hello retries use bounded backoff through loss and persistence failure until a valid probe', async () => {
  const h = createHarness();
  const socket = h.connect();
  await socket.open();
  await socket.receive(ready());
  await h.resolveSync(true);
  assert.equal(h.state.calls.onOpen, 1);
  assert.deepEqual(h.timers.delays, [500, 500],
    'the cancelled pre-sync guard does not consume the first hello retry delay');

  await socket.error({
    t: 'error', source: 'deliveryShadowHello', error: 'delivery_persist_failed'
  });
  await h.timers.advance(500);
  await h.timers.advance(1500);
  await h.timers.advance(5000);
  await h.timers.advance(15000);
  assert.deepEqual(h.timers.delays, [500, 500, 1500, 5000, 15000, 15000]);
  assert.equal(h.state.calls.onOpen, 5);
  assert.equal(sentType(h.state, 'deliveryShadowHello').length, 5);
  assert.equal(h.timers.pending.size, 1, 'the capped retry remains live without hot looping');

  await socket.receive(probe());
  assert.equal(h.timers.pending.size, 0, 'a handled valid probe confirms persistence');
  const callsAtProbe = h.state.calls.onOpen;
  await h.timers.advance(60_000);
  assert.equal(h.state.calls.onOpen, callsAtProbe);
});

test('every retry revalidates current socket generation and exact identity', async () => {
  const h = createHarness();
  const socket = h.connect();
  await socket.open();
  await h.resolveSync(true);
  await socket.receive(ready());
  assert.equal(h.state.calls.onOpen, 1);

  h.setIdentity('700002');
  await h.timers.advance(500);
  assert.equal(h.state.calls.onOpen, 1);
  assert.equal(h.timers.pending.size, 0);

  await socket.receive(ready({ pid: '700002' }));
  assert.equal(h.state.calls.onOpen, 2, 'a new exact identity bind creates a new handshake');
  await socket.reconnect();
  await h.timers.advance(500);
  assert.equal(h.state.calls.onOpen, 2, 'the old generation retry cannot cross reconnect');
});

test('a pending retry waits through a same-generation clock resync', async () => {
  const h = createHarness();
  const socket = h.connect();
  await socket.open();
  await h.resolveSync(true);
  await socket.receive(ready());
  assert.equal(h.state.calls.onOpen, 1);

  h.setSynced(false);
  await h.timers.advance(500);
  assert.equal(h.state.calls.onOpen, 1, 'no hello is sent against an unsynchronized clock');
  assert.equal(h.timers.pending.size, 1, 'the bounded retry remains recoverable');
  h.setSynced(true);
  await h.timers.advance(1500);
  assert.equal(h.state.calls.onOpen, 2);
});

test('ready recovery during resync restarts an unconfirmed handshake after the clock settles', async () => {
  const h = createHarness();
  const socket = h.connect();
  await socket.open();
  await h.resolveSync(true);
  await socket.receive(ready());
  assert.equal(h.state.calls.onOpen, 1);

  await socket.receive(ready({ soundReady: false }));
  assert.equal(h.timers.pending.size, 0);
  h.setSynced(false);
  await socket.receive(ready({ soundReady: true }));
  assert.equal(h.state.calls.onOpen, 1);
  assert.equal(h.timers.pending.size, 1, 'ready state remains retryable while resyncing');
  h.setSynced(true);
  await h.timers.advance(500);
  assert.equal(h.state.calls.onOpen, 2);
});

test('a superseded or hung open sync recovers through the latest same-generation sync', async () => {
  for (const order of ['superseded-first', 'latest-first']) {
    const h = createHarness();
    const socket = h.connect();
    await socket.open();
    await socket.receive(ready());
    const latestSync = h.resync();

    if (order === 'superseded-first') {
      await h.resolveSyncAt(0, true);
      assert.equal(h.state.calls.onOpen, 0,
        'the superseded open sync cannot start a handshake');
      await h.resolveSyncAt(0, true);
    } else {
      await h.resolveSyncAt(1, true);
    }
    await latestSync;
    assert.equal(h.state.calls.onOpen, 0,
      'the callback-free latest sync is recovered by the bounded waiter');
    assert.equal(h.timers.pending.size, 1);

    await h.timers.advance(500);
    assert.equal(h.state.calls.onOpen, 1, order);
    assert.equal(sentType(h.state, 'deliveryShadowHello').length, 1, order);

    if (order === 'latest-first') {
      await h.resolveSyncAt(0, true);
      assert.equal(h.state.calls.onOpen, 1,
        'a late superseded callback cannot create a second immediate hello');
      assert.equal(h.timers.pending.size, 1);
    }
  }
});

test('strict-false and throwing hello sends remain contained and retryable', async () => {
  for (const behavior of ['truthy', 'throw']) {
    const h = createHarness({
      socketSend(message) {
        if (message.t !== 'deliveryShadowHello') return true;
        if (behavior === 'throw') throw new Error('simulated closed send');
        return 1;
      }
    });
    const socket = h.connect();
    await socket.open();
    await h.resolveSync(true);
    await socket.receive(ready());
    assert.equal(h.state.calls.onOpen, 1, behavior);
    assert.equal(h.timers.pending.size, 1, behavior);
    await h.timers.advance(500);
    assert.equal(h.state.calls.onOpen, 2, behavior);
    assert.equal(h.state.coreMessages.at(-1).t, 'deviceStatusSaved', behavior);
  }
});

test('onOpen and handleMessage false or throw never suppress Core work', async () => {
  for (const config of [
    { onOpen: () => false },
    { onOpenThrows: true }
  ]) {
    const h = createHarness(config);
    const socket = h.connect();
    await socket.open();
    await socket.receive(ready());
    await h.resolveSync(true);
    assert.equal(h.state.calls.onOpen, 1);
    assert.equal(h.timers.pending.size, 1);
    assert.ok(h.state.log.includes('core:clockSync'));
    assert.ok(h.state.log.includes('core:deviceStatusSaved'));
  }

  for (const config of [
    { handleMessage: () => false },
    { handleThrows: true }
  ]) {
    const h = createHarness(config);
    const socket = h.connect();
    await socket.receive({ t: 'deliveryShadowCommand' });
    assert.equal(h.state.calls.handle, 1);
    assert.equal(h.state.coreMessages.length, 1);
    assert.equal(h.state.log[2], 'core:deliveryShadowCommand');
  }
});

test('only a strictly handled valid probe cancels an active hello retry', async () => {
  let handled = false;
  const h = createHarness({ handleMessage: () => handled });
  const socket = h.connect();
  await socket.open();
  await h.resolveSync(true);
  await socket.receive(ready());
  assert.equal(h.timers.pending.size, 1);
  await socket.receive(probe());
  assert.equal(h.timers.pending.size, 1, 'false is not confirmation');
  handled = true;
  await socket.receive(probe({ probeId: 'probe-confirmed' }));
  assert.equal(h.timers.pending.size, 0);
});

test('QA observations are copied once, bounded privately, and exposed as defensive snapshots', () => {
  const h = createHarness();
  h.connect();
  const qa = h.context.__kvkDeliveryQa;
  assert.deepEqual(Object.keys(qa).sort(), ['controller', 'events', 'getSocket']);
  assert.equal(Object.isFrozen(qa), true);

  for (let index = 0; index < 205; index += 1) {
    h.state.createOptions.observe({
      kind: 'candidate', commandId: `obs-${index}`, result: 'would_schedule', count: 11,
      pid: 'must-not-leak', deviceId: DEVICE_ID, raw: { secret: true }
    });
  }
  const first = plain(qa.events);
  assert.equal(first.length, 200);
  assert.equal(first[0].commandId, 'obs-5');
  assert.equal(first.at(-1).commandId, 'obs-204');
  assert.ok(first.every(event => Object.keys(event).every(key =>
    ['kind', 'commandId', 'result', 'count'].includes(key))));

  qa.events[0].kind = 'external-mutation';
  qa.events.push({ kind: 'external-injection' });
  Object.freeze(qa.events);
  assert.doesNotThrow(() => h.state.createOptions.observe({
    kind: 'candidate', commandId: 'obs-205', result: 'expired', count: 0
  }));
  const fresh = plain(qa.events);
  assert.equal(fresh.length, 200);
  assert.equal(fresh.at(-1).commandId, 'obs-205');
  assert.equal(fresh.some(event => event.kind.indexOf('external-') === 0), false);

  const reads = { kind: 0, commandId: 0, result: 0, count: 0 };
  const accessor = {};
  for (const key of Object.keys(reads)) {
    Object.defineProperty(accessor, key, {
      enumerable: true,
      get() {
        reads[key] += 1;
        if (reads[key] > 1) throw new Error(`${key} read twice`);
        return { kind: 'candidate', commandId: 'once', result: 'expired', count: 0 }[key];
      }
    });
  }
  assert.doesNotThrow(() => h.state.createOptions.observe(accessor));
  assert.deepEqual(reads, { kind: 1, commandId: 1, result: 1, count: 1 });
  assert.doesNotThrow(() => h.state.createOptions.observe(new Proxy({}, {
    get() { throw new Error('inaccessible observation'); }
  })));
});

test('injected boundaries use only current Core identity, live socket, strict true, and server time', () => {
  const h = createHarness({ commander: true });
  const first = h.connect();
  assert.deepEqual(plain(h.state.createOptions.getIdentity()), {
    pid: '700001', deviceId: DEVICE_ID, view: 'commander', audioArmed: true
  });
  assert.equal(h.state.calls.audioAlive, 1);
  assert.equal(h.state.createOptions.now(), 1_000_000);
  assert.equal(h.state.calls.now, 1);

  h.setIdentity('700002', '00000000-0000-4000-8000-000000000099');
  assert.deepEqual(plain(h.state.createOptions.getIdentity()), {
    pid: '700002', deviceId: '00000000-0000-4000-8000-000000000099',
    view: 'commander', audioArmed: true
  });
  assert.equal(h.state.createOptions.send({ t: 'deliveryShadowHello' }), true);
  assert.equal(first, h.currentSocket());

  const replacement = h.connect();
  assert.notEqual(replacement, first);
  assert.equal(h.state.createOptions.send({ t: 'deliveryShadowHello', replacement: true }), true);
  assert.equal(h.context.__kvkDeliveryQa.getSocket(), replacement);

  const strict = createHarness({
    socketSend(message) { return message.t === 'deliveryShadowHello' ? 1 : true; }
  });
  strict.connect();
  assert.equal(strict.state.createOptions.send({ t: 'deliveryShadowHello' }), false);
});

test('protected Core/audio/identity authorities contain no shadow wiring', () => {
  assert.equal(digest(app), 'd07458ffee6d7c8bcb83b30c11e2be8e196f3b4ed5cc58759ada8d2728f043cd',
    'app.js, the BattleConnection adapter, and getRoomDeviceId remain byte-identical');
  for (const name of [
    'handleSocketMessage',
    'handleDeviceStatusSaved',
    'sendDeviceStatus',
    'scheduleAllCues',
    'acknowledgeClassicCommand',
    'scheduleBeeps',
    'schedulePrepareCue',
    'stopCue'
  ]) {
    assert.doesNotMatch(extractFunction(script, name),
      /deliveryShadow|KvkDeliveryShadow|__kvkDeliveryQa/,
      `${name} stays outside the additive shadow path`);
  }
  assert.equal((script.match(/\bt\s*:\s*["']deliveryAck["']/g) || []).length, 1,
    'Classic keeps one production deliveryAck emitter');

  const block = extractShadowBlock();
  assert.doesNotMatch(block,
    /getRoomDeviceId|localStorage|randomUUID|scheduleAllCues|scheduleBeeps|schedulePrepareCue|acknowledgeClassicCommand|\bt\s*:\s*["']deliveryAck["']/);
  assert.doesNotMatch(block, /\b(?:const|let|class|async)\b|=>/,
    'the shipped browser seam stays ES5-compatible');
});
