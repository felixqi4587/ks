const assert = require('node:assert/strict');
const { basename } = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-kvk.cjs');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const suiteTitle = basename(__filename, '.cjs');
const password = 'kvk-core-multibrowser-password';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function stripDeliveryAggregate(message) {
  const snapshot = structuredClone(message);
  const commands = snapshot && snapshot.t === 'state' && snapshot.room && snapshot.room.live && snapshot.room.live.commands;
  Object.values(commands || {}).filter(Boolean).forEach(command => { delete command.delivery; });
  return snapshot;
}

function assertCompatibilityTransform() {
  const snapshot = stripDeliveryAggregate({
    t: 'state',
    room: { live: { commands: { 1: { id: 'qa-command', delivery: [{ pid: '900000001', expected: 1, received: 1 }] } } } }
  });
  assert.equal(Object.hasOwn(snapshot.room.live.commands[1], 'delivery'), false,
    'a Classic compatibility snapshot omits the additive delivery aggregate');
}

function requestedProjects(argv) {
  let project = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let requested = null;
    if (argument.startsWith('--project=')) requested = argument.slice('--project='.length);
    else if (argument === '--project') requested = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
    if (project !== null) throw new Error('Duplicate --project argument');
    project = requested;
  }
  if (project === null) project = 'chromium';
  if (!['chromium', 'firefox', 'webkit', 'all'].includes(project)) {
    throw new Error(`Unsupported project: ${project || '<empty>'}; expected chromium, firefox, webkit, or all`);
  }
  return project === 'all' ? ['chromium', 'firefox', 'webkit'] : [project];
}

function playerProfile(pid, name, march) {
  return { pid, name, march, marchRevision: 0, identityMode: 'playerId' };
}

function packetGate(options = {}) {
  return {
    clientAcks: [],
    savedAcks: [],
    deviceStatuses: [],
    deviceStatusSaved: [],
    heartbeats: [],
    serverStateFrames: [],
    ignoredClientFrames: [],
    transformedLegacyFrames: [],
    holdClientAcks: options.holdClientAcks === true,
    dropFirstClientAck: options.dropFirstClientAck === true,
    dropFirstSavedAck: options.dropFirstSavedAck === true,
    ignoreDeliveryProtocol: options.ignoreDeliveryProtocol === true,
    legacyTransport: options.legacyTransport === true,
    clientAckDropped: false,
    savedAckDropped: false
  };
}

function gateOptions(gate) {
  const options = {
    shouldDropClientMessage({ data }) {
      let message = null;
      try { message = JSON.parse(String(data)); } catch (_) {}
      if (message && message.t === 'deviceStatus') gate.deviceStatuses.push(message);
      if (message && message.t === 'hb') gate.heartbeats.push(message);
      if (message && message.t === 'deliveryAck') gate.clientAcks.push(message);
      if (gate.ignoreDeliveryProtocol && message && ['deviceStatus', 'deliveryAck'].includes(message.t)) {
        gate.ignoredClientFrames.push(data);
        return true;
      }
      if (!message || message.t !== 'deliveryAck') return false;
      if (gate.dropFirstClientAck && !gate.clientAckDropped) {
        gate.clientAckDropped = true;
        return true;
      }
      if (gate.holdClientAcks) return true;
      return false;
    },
    shouldDropServerMessage({ data }) {
      let message = null;
      try { message = JSON.parse(String(data)); } catch (_) {}
      if (message && message.t === 'state') gate.serverStateFrames.push(data);
      if (message && message.t === 'deviceStatusSaved') gate.deviceStatusSaved.push(message);
      if (!message || message.t !== 'deliveryAckSaved') return false;
      gate.savedAcks.push(message);
      if (gate.dropFirstSavedAck && !gate.savedAckDropped) {
        gate.savedAckDropped = true;
        return true;
      }
      return false;
    }
  };
  if (gate.legacyTransport) {
    options.transformServerMessage = ({ data }) => {
      let message = null;
      try { message = JSON.parse(String(data)); } catch (_) {}
      if (!message || message.t !== 'state') return data;
      const transformed = JSON.stringify(stripDeliveryAggregate(message));
      gate.transformedLegacyFrames.push(transformed);
      return transformed;
    };
  }
  return options;
}

async function waitUntil(read, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function lastStatePlayerRecord(gate, pid) {
  for (let index = gate.serverStateFrames.length - 1; index >= 0; index -= 1) {
    let state = null;
    try { state = JSON.parse(String(gate.serverStateFrames[index])); } catch (_) {}
    if (state && state.room && state.room.players && state.room.players[pid]) {
      return state.room.players[pid];
    }
  }
  return null;
}

async function assertMarchSynchronized(roles, expected) {
  const time = `${Math.floor(expected.march / 60)}:${String(expected.march % 60).padStart(2, '0')}`;
  await Promise.all(roles.map(async role => {
    try {
      await waitUntil(() => {
        const record = lastStatePlayerRecord(role.gate, expected.pid);
        return record && record.march === expected.march && record.marchRevision === expected.marchRevision;
      }, `${role.label} raw canonical march ${expected.march}/${expected.marchRevision}`, 8_000);
      await role.page.waitForFunction(({ pid, renderedTime }) =>
        document.querySelector(`#roster .roster-time[data-pid="${pid}"]`)?.textContent === renderedTime,
      { pid: expected.pid, renderedTime: time }, { timeout: 8_000 });
    } catch (error) {
      const rendered = await role.page.locator(`#roster .roster-time[data-pid="${expected.pid}"]`)
        .textContent().catch(() => '<missing>');
      throw new Error(`${role.label} march synchronization failed: ${JSON.stringify({
        expected: { march: expected.march, marchRevision: expected.marchRevision, rendered: time },
        lastObservedRecord: lastStatePlayerRecord(role.gate, expected.pid),
        rendered
      })}`, { cause: error });
    }
  }));
}

async function clickCommanderMarchAdoptWithTrustedPointer(page) {
  await page.locator('#commanderMarchInput').focus();
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id),
    'commanderMarchInput', 'pointer regression starts with the editor input focused');

  const box = await page.locator('#commanderMarchAdopt').boundingBox();
  assert.ok(box, 'visible Adopt has a pointer target box');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.evaluate(() => {
    window.__qaAdoptPointerTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    window.__qaAdoptPointerTrace = [];
    window.__qaAdoptPointerListener = event => window.__qaAdoptPointerTrace.push({
      type: event.type,
      target: event.target.id || event.target.tagName,
      trusted: event.isTrusted
    });
    window.__qaAdoptPointerTypes.forEach(type =>
      document.addEventListener(type, window.__qaAdoptPointerListener, true));
  });

  let afterDown = null;
  let trace = [];
  let pointerIsDown = false;
  try {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    pointerIsDown = true;
    await page.waitForTimeout(50);
    afterDown = await page.evaluate(({ x, y }) => ({
      hit: (document.elementFromPoint(x, y) || {}).id || '',
      position: getComputedStyle(document.querySelector('#fireDock')).position,
      nofix: document.querySelector('#fireDock').classList.contains('nofix')
    }), point);
  } finally {
    try {
      if (pointerIsDown) await page.mouse.up();
    } finally {
      trace = await page.evaluate(() => {
        const result = window.__qaAdoptPointerTrace.slice();
        window.__qaAdoptPointerTypes.forEach(type =>
          document.removeEventListener(type, window.__qaAdoptPointerListener, true));
        delete window.__qaAdoptPointerTypes;
        delete window.__qaAdoptPointerTrace;
        delete window.__qaAdoptPointerListener;
        return result;
      });
    }
  }

  const diagnostic = JSON.stringify({ afterDown, trace });
  const first = type => trace.find(event => event.type === type);
  assert.deepEqual(first('pointerdown'), {
    type: 'pointerdown', target: 'commanderMarchAdopt', trusted: true
  }, `trusted pointerdown starts on Adopt (${diagnostic})`);
  assert.equal(afterDown.position, 'static',
    `Fire dock stays yielded while the pointer is down (${diagnostic})`);
  assert.equal(afterDown.hit, 'commanderMarchAdopt',
    `Adopt remains topmost after pointerdown (${diagnostic})`);
  assert.deepEqual(first('click'), {
    type: 'click', target: 'commanderMarchAdopt', trusted: true
  }, `trusted pointer click finishes on Adopt (${diagnostic})`);
}

async function openRole(browser, options) {
  const {
    room, label, profile = null, deviceId = '', gate = packetGate(), errors,
    viewport = { width: 390, height: 1100 }
  } = options;
  assertQaRoomName(room);
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await installQaWebSocketGuard(context, room, gateOptions(gate));
  await context.addInitScript(({ roomName, storedProfile, seededDeviceId }) => {
    if (storedProfile) localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify(storedProfile));
    if (seededDeviceId) localStorage.setItem(`kvk:${roomName}:delivery-device:v1`, seededDeviceId);
    const NativeWebSocket = window.WebSocket;
    window.__qaRoomSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__qaRoomSockets.push(this);
        this.addEventListener('message', event => {
          try {
            const message = JSON.parse(String(event.data));
            if (message && message.t === 'state') {
              window.__qaObservedStateFrames.push(String(event.data));
              window.__qaObservedStates.push(structuredClone(message));
            }
          } catch (_) {}
        });
      }
    };
    window.__qaObservedStateFrames = [];
    window.__qaObservedStates = [];
  }, { roomName: room, storedProfile: profile, seededDeviceId: deviceId });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
  await page.goto(qaRoomUrl(base, room, { notour: 1, lang: 'en' }), { waitUntil: 'domcontentloaded' });
  if (profile) {
    await page.locator('#youChip').waitFor({ state: 'visible', timeout: 8_000 });
    await page.locator('#youName').filter({ hasText: profile.name }).waitFor({ timeout: 8_000 });
  }
  await page.locator('#soundGate').click({ force: true });
  await page.waitForFunction(() => window.__ac && window.__ac.state === 'running', null, { timeout: 7_000 });
  if (profile) await page.locator('#audioStatus').click({ force: true });
  return { context, page, gate, label };
}

async function registerNickname(role, name, march) {
  const { page } = role;
  assert.match(await page.locator('#identityPlayerId').textContent(), /Recommended/i,
    'Player ID remains the recommended identity mode');
  await page.locator('#identityNickname').click();
  await page.locator('#pid').fill(name);
  await page.locator('#marchRange').fill(String(march));
  await page.locator('#saveBtn').click();
  await page.locator('#youChip').waitFor({ state: 'visible', timeout: 8_000 });
  return page.evaluate(() => {
    const room = new URL(location.href).searchParams.get('room');
    return JSON.parse(localStorage.getItem(`kingshoter_r_${room}_me`));
  });
}

async function unlockCommander(page) {
  await page.locator('#cmdUnlock').click();
  await page.locator('#pwInput').fill(password);
  await page.locator('#pwGo').click();
  await page.locator('#console').waitFor({ state: 'visible', timeout: 8_000 });
}

async function selectPlayer(page, pid) {
  await page.locator(`#roster .rp[data-pid="${pid}"]`).click();
  await page.waitForFunction(value => {
    const row = document.querySelector(`#roster .rp[data-pid="${value}"]`);
    return row && row.getAttribute('aria-pressed') === 'true';
  }, pid, { timeout: 8_000 });
}

async function waitForSlot(page, pid, role) {
  await page.locator(`#pickSlots .slot.${role}[data-pid="${pid}"]`).waitFor({ timeout: 8_000 });
}

async function readSnapshot(page, room) {
  assertQaRoomName(room);
  return page.evaluate(async roomName => {
    const response = await fetch(`/api/ws?room=${encodeURIComponent(roomName)}`);
    if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
    return response.json();
  }, room);
}

async function fireDouble(page) {
  await page.waitForFunction(() => document.querySelector('#cdot')?.classList.contains('on'), null, { timeout: 8_000 });
  await page.locator('#lead button[data-v="10"]').click();
  await page.evaluate(() => {
    window.__qaFireClicks = [];
    document.querySelector('#fireDouble').addEventListener('click', () => window.__qaFireClicks.push(window.serverNow()), true);
  });
  await page.locator('#fireDouble').click();
  await page.locator('#fireDouble.armed').waitFor({ state: 'visible', timeout: 3_000 });
  await page.locator('#fireDouble').click();
  await page.locator('#pickSlots.frozen').waitFor({ state: 'visible', timeout: 8_000 });
  return page.evaluate(() => window.__qaFireClicks.at(-1));
}

async function cancelCommand(page, room) {
  await page.locator('#cancelBtn').click();
  await page.locator('#toast.show').waitFor({ state: 'visible', timeout: 3_000 });
  await page.locator('#cancelBtn').click();
  await waitUntil(async () => {
    const snapshot = await readSnapshot(page, room);
    return !Object.values(snapshot.room.live.commands || {}).some(Boolean);
  }, 'command cancellation');
}

async function openRemove(page, pid) {
  await page.locator(`#roster .roster-actions[data-pid="${pid}"]`).click();
  await page.locator('#rosterActionsMenu [data-action="remove"]').click();
  await page.locator('#removePlayerOvl').waitFor({ state: 'visible', timeout: 5_000 });
}

async function assertMobileRoster(page) {
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await page.evaluate(() => {
      const roster = document.querySelector('#roster');
      return {
        documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        rosterFits: roster.scrollWidth <= roster.clientWidth
      };
    });
    assert.equal(layout.documentFits, true, `${width}px page has no horizontal overflow`);
    assert.equal(layout.rosterFits, true, `${width}px roster has no horizontal overflow`);
  }
}

async function assertNoPublicDeliveryMode(page) {
  const controls = await page.evaluate(() => ({
    mode: document.querySelectorAll('#deliveryMode, [data-delivery-mode], [name="deliveryMode"]').length,
    rollback: document.querySelectorAll('#deliveryRollback, [data-delivery-rollback], [name="deliveryRollback"]').length,
    testSwitch: document.querySelectorAll('[data-delivery-test-switch], [name="deliveryTestSwitch"]').length
  }));
  assert.deepEqual(controls, { mode: 0, rollback: 0, testSwitch: 0 },
    'the production page exposes no delivery mode selector, rollback control, or hidden test switch');
}

async function verifySocketBinding(page, room, firstPid, secondPid) {
  const result = await page.evaluate(async ({ roomName, pidA, pidB }) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const endpoint = `${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`;
    const deviceId = 'f0000000-0000-4000-8000-000000000001';
    const open = () => new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const timer = setTimeout(() => reject(new Error('binding socket open timeout')), 5_000);
      socket.onopen = () => { clearTimeout(timer); resolve(socket); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('binding socket open failed')); };
    });
    const sendAndWait = (socket, message, predicate) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`binding response timeout for ${message.t}`)), 5_000);
      const listener = event => {
        const response = JSON.parse(String(event.data));
        if (!predicate(response)) return;
        clearTimeout(timer);
        socket.removeEventListener('message', listener);
        resolve(response);
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify(message));
    });
    const original = await open();
    const saved = await sendAndWait(original,
      { t: 'deviceStatus', pid: pidA, deviceId, soundReady: true },
      message => message.t === 'deviceStatusSaved');
    const changed = await sendAndWait(original,
      { t: 'deviceStatus', pid: pidA, deviceId, soundReady: false },
      message => message.t === 'deviceStatusSaved' && message.soundReady === false);
    const sibling = await open();
    const reconnected = await sendAndWait(sibling,
      { t: 'deviceStatus', pid: pidA, deviceId, soundReady: true },
      message => message.t === 'deviceStatusSaved');
    const locked = await sendAndWait(original,
      { t: 'deviceStatus', pid: pidB, deviceId, soundReady: true },
      message => message.t === 'error' && message.source === 'deviceStatus');
    const conflict = await open();
    const owned = await sendAndWait(conflict,
      { t: 'deviceStatus', pid: pidB, deviceId, soundReady: true },
      message => message.t === 'error' && message.source === 'deviceStatus');
    [original, sibling, conflict].forEach(socket => socket.close());
    return { saved, changed, reconnected, locked, owned };
  }, { roomName: room, pidA: firstPid, pidB: secondPid });
  assert.equal(result.saved.soundReady, true, 'the first socket binds its immutable PID/device identity');
  assert.equal(result.changed.soundReady, false, 'the same identity may change soundReady');
  assert.equal(result.reconnected.pid, firstPid, 'a same-identity reconnect remains valid');
  assert.equal(result.locked.error, 'socket_identity_locked', 'a socket cannot change PID/device after binding');
  assert.equal(result.owned.error, 'device_owned_by_other_pid', 'a fresh device ID cannot be owned by two PIDs');
}

async function verifyForgedDeliveryAcks(page, room, legitimateAck) {
  assertQaRoomName(room);
  const attempts = await page.evaluate(async ({ roomName, ack }) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const endpoint = `${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`;
    const openSocket = () => new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const timer = setTimeout(() => reject(new Error('forged ACK socket open timeout')), 5_000);
      socket.onopen = () => { clearTimeout(timer); resolve(socket); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('forged ACK socket failed')); };
    });
    const waitForMessage = (socket, predicate, label) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`forged ACK response timeout: ${label}`)), 5_000);
      const listener = event => {
        const message = JSON.parse(String(event.data));
        if (!predicate(message)) return;
        clearTimeout(timer);
        socket.removeEventListener('message', listener);
        resolve(message);
      };
      socket.addEventListener('message', listener);
    });
    const closeSocket = socket => new Promise(resolve => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(resolve, 1_000);
      socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.close(4000, 'QA forged ACK complete');
    });
    const attempt = async ({ label, binding = null, claimedDeviceId }) => {
      const socket = await openSocket();
      const received = [];
      socket.addEventListener('message', event => received.push(JSON.parse(String(event.data))));
      if (binding) {
        const saved = waitForMessage(socket, message =>
          message.t === 'deviceStatusSaved' && message.pid === binding.pid
            && message.deviceId === binding.deviceId && message.soundReady === binding.soundReady,
        `${label} deviceStatusSaved`);
        socket.send(JSON.stringify({ t: 'deviceStatus', ...binding }));
        await saved;
      }
      const rejected = waitForMessage(socket, message =>
        message.t === 'error' && message.source === 'deliveryAck'
          && message.error === 'bad_delivery_identity',
      `${label} bad_delivery_identity`);
      socket.send(JSON.stringify({ ...ack, deviceId: claimedDeviceId }));
      const response = await rejected;
      await new Promise(resolve => setTimeout(resolve, 200));
      const deliveryAckSaved = received.filter(message => message.t === 'deliveryAckSaved');
      await closeSocket(socket);
      return {
        label,
        error: { t: response.t, source: response.source, error: response.error },
        deliveryAckSaved
      };
    };

    const results = [];
    results.push(await attempt({
      label: 'unbound socket',
      claimedDeviceId: 'a1000000-0000-4000-8000-000000000001'
    }));
    results.push(await attempt({
      label: 'mismatched ready binding',
      binding: { pid: ack.pid, deviceId: 'b1000000-0000-4000-8000-000000000001', soundReady: true },
      claimedDeviceId: 'b2000000-0000-4000-8000-000000000002'
    }));
    results.push(await attempt({
      label: 'soundReady false binding',
      binding: { pid: ack.pid, deviceId: 'c1000000-0000-4000-8000-000000000001', soundReady: false },
      claimedDeviceId: 'c1000000-0000-4000-8000-000000000001'
    }));
    return results;
  }, { roomName: room, ack: legitimateAck });

  for (const attempt of attempts) {
    assert.deepEqual(attempt.error, {
      t: 'error', source: 'deliveryAck', error: 'bad_delivery_identity'
    }, `${attempt.label} receives the exact identity rejection`);
    assert.deepEqual(attempt.deliveryAckSaved, [],
      `${attempt.label} never receives deliveryAckSaved`);
  }
}

async function forceLiveRemoval(page, room, pid) {
  assertQaRoomName(room);
  return page.evaluate(({ roomName, playerId, roomPassword }) => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    const timer = setTimeout(() => reject(new Error('forced live removal timeout')), 5_000);
    socket.onopen = () => socket.send(JSON.stringify({ t: 'removePlayer', password: roomPassword, pid: playerId }));
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.t !== 'error') return;
      clearTimeout(timer);
      socket.close();
      resolve(message);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('forced live removal socket failed')); };
  }), { roomName: room, playerId: pid, roomPassword: password });
}

async function runCoreScenario(browser, engineName) {
  const room = makeQaRoom({ title: suiteTitle });
  assertQaRoomName(room);
  const errors = [];
  const captainAGate = packetGate({ dropFirstSavedAck: true });
  const captainASecondGate = packetGate({ dropFirstClientAck: true, holdClientAcks: true });
  const captainBGate = packetGate();
  const ordinaryGate = packetGate();
  const selectedCommanderGate = packetGate();
  const captainAProfile = playerProfile('910000001', 'Captain A', 60);
  const captainBProfile = playerProfile('910000002', 'Captain B', 70);
  const ordinaryProfile = playerProfile('910000003', 'Ordinary Member', 80);
  const selectedCommanderProfile = playerProfile('910000004', 'Selected Commander', 65);
  const roles = [];

  try {
    const opened = await Promise.all([
      openRole(browser, { room, label: 'commander-only', errors }),
      openRole(browser, { room, label: 'captain-a', profile: captainAProfile, deviceId: '11111111-1111-4111-8111-111111111111', gate: captainAGate, errors }),
      openRole(browser, { room, label: 'captain-b', profile: captainBProfile, deviceId: '33333333-3333-4333-8333-333333333333', gate: captainBGate, errors }),
      openRole(browser, { room, label: 'ordinary-member', profile: ordinaryProfile, deviceId: '44444444-4444-4444-8444-444444444444', gate: ordinaryGate, errors }),
      openRole(browser, { room, label: 'captain-a-second-device', profile: captainAProfile, deviceId: '22222222-2222-4222-8222-222222222222', gate: captainASecondGate, errors }),
      openRole(browser, { room, label: 'nickname-tester-1', errors, viewport: { width: 375, height: 1000 } }),
      openRole(browser, { room, label: 'nickname-tester-2', errors, viewport: { width: 375, height: 1000 } }),
      openRole(browser, { room, label: 'selected-commander', profile: selectedCommanderProfile, deviceId: '55555555-5555-4555-8555-555555555555', gate: selectedCommanderGate, errors })
    ]);
    roles.push(...opened);
    const [commander, captainA, captainB, ordinary, captainASecond, testerOne, testerTwo, selectedCommander] = opened;
    assert.equal(new Set(opened.map(role => role.context)).size, 8,
      'every requested role uses an independent BrowserContext');

    const testerOneProfile = await registerNickname(testerOne, 'Tester', 55);
    const testerTwoProfile = await registerNickname(testerTwo, 'Tester', 56);
    assert.equal(testerOneProfile.identityMode, 'nickname');
    assert.equal(testerTwoProfile.identityMode, 'nickname');
    assert.match(testerOneProfile.pid, /^n_[0-9a-f]{22}$/);
    assert.match(testerTwoProfile.pid, /^n_[0-9a-f]{22}$/);
    assert.notEqual(testerOneProfile.pid, testerTwoProfile.pid,
      'equal nickname identities remain distinct opaque players');

    await Promise.all([unlockCommander(commander.page), unlockCommander(selectedCommander.page)]);
    await commander.page.waitForFunction(() => document.querySelectorAll('#roster .roster-row').length === 6);
    await assertMobileRoster(commander.page);
    await assertNoPublicDeliveryMode(commander.page);
    await verifySocketBinding(commander.page, room, captainAProfile.pid, captainBProfile.pid);

    await selectPlayer(commander.page, captainAProfile.pid);
    await selectPlayer(commander.page, captainBProfile.pid);
    await commander.page.locator(`#roster .rp[data-pid="${ordinaryProfile.pid}"]`).click();
    await commander.page.locator('#replaceOvl').waitFor({ state: 'visible' });
    assert.equal(await commander.page.locator('#roster .rp[aria-pressed="true"]').count(), 2,
      'a third player never silently replaces a captain');
    await commander.page.locator('#replaceWeak').click();
    await waitForSlot(commander.page, ordinaryProfile.pid, 'weak');
    await commander.page.locator(`#roster .rp[data-pid="${captainAProfile.pid}"]`).click();
    await commander.page.locator('#replaceOvl').waitFor({ state: 'visible' });
    await commander.page.locator('#replaceWeak').click();
    await waitForSlot(commander.page, captainAProfile.pid, 'weak');

    await commander.page.locator(`#roster .rp[data-pid="${testerOneProfile.pid}"]`).click();
    await commander.page.locator('#replaceOvl').waitFor({ state: 'visible' });
    await commander.page.locator('#replaceWeak').click();
    await waitForSlot(commander.page, testerOneProfile.pid, 'weak');
    await openRemove(commander.page, testerOneProfile.pid);
    await commander.page.locator('#removePlayerCancel').click();
    assert.equal(await commander.page.locator(`#roster .rp[data-pid="${testerOneProfile.pid}"]`).count(), 1,
      'Cancel keeps a staged player');
    await openRemove(commander.page, testerOneProfile.pid);
    await commander.page.locator('#removePlayerConfirm').click();
    await commander.page.locator(`#roster .rp[data-pid="${testerOneProfile.pid}"]`).waitFor({ state: 'detached', timeout: 8_000 });
    assert.equal(await commander.page.locator(`#pickSlots .slot[data-pid="${testerOneProfile.pid}"]`).count(), 0,
      'removing a staged player clears every staged reference');
    assert.equal(await commander.page.locator(`#pickSlots .slot[data-pid="${captainBProfile.pid}"]`).count(), 1,
      'staged removal preserves the unrelated captain');
    assert.equal(await commander.page.locator('#fireDouble').isDisabled(), true,
      'staged removal disables ghost Fire');
    await selectPlayer(commander.page, captainAProfile.pid);

    await commander.page.locator(`#roster .roster-time[data-pid="${captainAProfile.pid}"]`).click();
    await commander.page.locator('#commanderMarchInput').fill('1:02');
    await captainA.page.locator('#editBtn').click();
    await captainA.page.locator('#marchRange').fill('61');
    await captainA.page.locator('#saveBtn').click();
    await commander.page.locator('#commanderMarchLatest').filter({ hasText: '1:01' }).waitFor({ timeout: 8_000 });
    const afterPlayerMarchUpdate = await readSnapshot(commander.page, room);
    const playerMarchRecord = afterPlayerMarchUpdate.room.players[captainAProfile.pid];
    assert.equal(playerMarchRecord.march, 61, 'the player-originated march update becomes canonical');
    await assertMarchSynchronized(opened, {
      pid: captainAProfile.pid,
      march: playerMarchRecord.march,
      marchRevision: playerMarchRecord.marchRevision
    });
    assert.equal(await commander.page.locator('#commanderMarchInput').inputValue(), '1:02',
      'a remote player save preserves the commander dirty draft');
    assert.match(await commander.page.locator('#commanderMarchStatus').textContent(), /updated|draft is preserved/i,
      'a stale-base conflict is explicit instead of silently overwriting the losing draft');
    await clickCommanderMarchAdoptWithTrustedPointer(commander.page);
    try {
      await commander.page.locator('#commanderMarchEditor').waitFor({ state: 'hidden', timeout: 5_000 });
    } catch (error) {
      const adoptDiagnostic = await commander.page.evaluate(() => ({
        disabled: document.querySelector('#commanderMarchAdopt').disabled,
        ariaDisabled: document.querySelector('#commanderMarchAdopt').getAttribute('aria-disabled'),
        conflictHidden: document.querySelector('#commanderMarchConflict').classList.contains('hide'),
        status: document.querySelector('#commanderMarchStatus').textContent,
        draft: document.querySelector('#commanderMarchInput').value
      }));
      throw new Error(`commander march adopt diagnostic: ${JSON.stringify(adoptDiagnostic)}`, { cause: error });
    }
    await commander.page.locator(`#roster .roster-time[data-pid="${captainAProfile.pid}"]`).click();
    await commander.page.locator('#commanderMarchEditor').waitFor({ state: 'visible', timeout: 5_000 });
    await commander.page.locator('#commanderMarchInput').fill('1:03');
    await commander.page.locator('#commanderMarchSave').click();
    try {
      await commander.page.locator('#commanderMarchEditor').waitFor({ state: 'hidden', timeout: 8_000 });
    } catch (error) {
      const marchDiagnostic = await readSnapshot(commander.page, room);
      throw new Error(`commander march save diagnostic: ${JSON.stringify({
        status: await commander.page.locator('#commanderMarchStatus').textContent(),
        busy: await commander.page.locator('#commanderMarchEditor').getAttribute('aria-busy'),
        draft: await commander.page.locator('#commanderMarchInput').inputValue(),
        latest: await commander.page.locator('#commanderMarchLatest').textContent(),
        canonical: marchDiagnostic.room.players[captainAProfile.pid],
        pageErrors: errors
      })}`, { cause: error });
    }
    const afterCommanderMarchUpdate = await readSnapshot(commander.page, room);
    const commanderMarchRecord = afterCommanderMarchUpdate.room.players[captainAProfile.pid];
    assert.equal(commanderMarchRecord.march, 63, 'the commander-originated march update becomes canonical');
    await assertMarchSynchronized(opened, {
      pid: captainAProfile.pid,
      march: commanderMarchRecord.march,
      marchRevision: commanderMarchRecord.marchRevision
    });
    const storedCaptainProfiles = await Promise.all([captainA, captainASecond].map(async role => {
      await role.page.waitForFunction(({ roomName, playerId, march, revision }) => {
        const profile = JSON.parse(localStorage.getItem(`kingshoter_r_${roomName}_me`) || 'null');
        return profile && profile.pid === playerId && profile.march === march && profile.marchRevision === revision;
      }, {
        roomName: room,
        playerId: captainAProfile.pid,
        march: commanderMarchRecord.march,
        revision: commanderMarchRecord.marchRevision
      }, { timeout: 8_000 });
      return role.page.evaluate(roomName =>
        JSON.parse(localStorage.getItem(`kingshoter_r_${roomName}_me`) || 'null'), room);
    }));
    for (const profile of storedCaptainProfiles) {
      assert.deepEqual({
        pid: profile.pid,
        march: profile.march,
        marchRevision: profile.marchRevision
      }, {
        pid: captainAProfile.pid,
        march: commanderMarchRecord.march,
        marchRevision: commanderMarchRecord.marchRevision
      }, 'both Captain A browsers persist the synchronized canonical march and revision');
    }

    const readyDevices = [
      [captainAGate, captainAProfile.pid, '11111111-1111-4111-8111-111111111111'],
      [captainASecondGate, captainAProfile.pid, '22222222-2222-4222-8222-222222222222'],
      [captainBGate, captainBProfile.pid, '33333333-3333-4333-8333-333333333333'],
      [ordinaryGate, ordinaryProfile.pid, '44444444-4444-4444-8444-444444444444'],
      [selectedCommanderGate, selectedCommanderProfile.pid, '55555555-5555-4555-8555-555555555555']
    ];
    await waitUntil(() => readyDevices.every(([gate, pid, deviceId]) => gate.deviceStatusSaved.some(message =>
      message.pid === pid && message.deviceId === deviceId && message.soundReady === true)),
    'every exact ready PID/device binding persisted before Fire');
    await captainA.page.evaluate(({ roomName, pid, deviceId }) => new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      const timer = setTimeout(() => reject(new Error('heartbeat binding timeout')), 5_000);
      socket.onopen = () => socket.send(JSON.stringify({ t: 'deviceStatus', pid, deviceId, soundReady: true }));
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data));
        if (message.t !== 'deviceStatusSaved' || message.pid !== pid || message.deviceId !== deviceId) return;
        socket.send(JSON.stringify({ t: 'hb', pid, deviceId, soundReady: true }));
        clearTimeout(timer);
        window.__qaHeartbeatSocket = socket;
        resolve();
      };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('heartbeat binding failed')); };
    }), { roomName: room, pid: captainAProfile.pid, deviceId: '11111111-1111-4111-8111-111111111111' });
    await waitUntil(() => captainAGate.heartbeats.some(message => message.pid === captainAProfile.pid && message.soundReady === true),
      'identity-bearing heartbeat before Fire');
    await captainA.page.evaluate(() => window.__qaHeartbeatSocket.close());
    assert.equal(await commander.page.locator('#pickSlots .delivery.received').count(), 0,
      'presence, WebSocket, AudioContext, and heartbeat readiness never masquerade as Received');
    const confirmedMs = await fireDouble(commander.page);
    const fired = await readSnapshot(commander.page, room);
    const liveCommand = fired.room.live.commands['1'];
    assert.ok(liveCommand, 'the first command is live');
    assert.equal(liveCommand.payload.leadSeconds, 10, 'the command preserves the exact 10-second lead');
    assert.equal(liveCommand.payload.pairs.length, 2, 'Fire freezes exactly two captain pairs');
    const pairsByPid = pairs => Object.fromEntries(pairs.map(pair => [pair.pid, structuredClone(pair)]));
    const frozenPairsByPid = pairsByPid(liveCommand.payload.pairs);
    assert.deepEqual(Object.keys(frozenPairsByPid).sort(),
      [captainAProfile.pid, captainBProfile.pid].sort(),
      'the frozen pair snapshot is independently keyed by captain PID');
    const earliestPressMs = Math.min(...liveCommand.payload.pairs.map(pair => pair.pressUTC)) * 1000;
    assert.ok(earliestPressMs - confirmedMs >= 9_700 && earliestPressMs - confirmedMs <= 10_300,
      'the earliest personal launch is exactly 10 seconds after final confirmation');
    assert.equal(liveCommand.payload.pairs.find(pair => pair.pid === captainAProfile.pid).march, 63,
      'Fire snapshots the latest canonical march');
    assert.equal(fired.room.live.staged['1'], null, 'Fire clears canonical staging');

    const cueState = role => role.page.evaluate(() => Object.entries(window.__cues || {}).map(([key, cue]) => ({
      key,
      targetMs: cue.t,
      nodeCount: Array.isArray(cue.nodes) ? cue.nodes.length : 0
    })));
    const cueKeys = async role => (await cueState(role)).map(cue => cue.key);
    const cueBases = (cues, kind) => new Set(cues
      .filter(cue => cue.key.includes(`-${kind}:`))
      .map(cue => cue.key.replace(/:\d+$/, '')));
    const [captainACues, captainASecondCues, captainBCues, ordinaryCues, commanderCues, selectedCommanderCues] = await Promise.all([
      cueState(captainA), cueState(captainASecond), cueState(captainB), cueState(ordinary), cueState(commander), cueState(selectedCommander)
    ]);
    for (const [label, cues] of [['Captain A', captainACues], ['Captain A second device', captainASecondCues], ['Captain B', captainBCues]]) {
      assert.ok(cues.some(cue => cue.key.includes('-me:') && cue.nodeCount > 0), `${label} receives schedulable personal Classic cues`);
      assert.ok(!cues.some(cue => cue.key.includes('-join:')), `${label} never receives JOIN cues`);
    }
    assert.equal(cueBases(ordinaryCues, 'join').size, 1,
      'an ordinary member receives exactly one JOIN command/base');
    assert.ok(!ordinaryCues.some(cue => cue.key.includes('-me:')), 'an ordinary member receives no personal cue');
    assert.ok(!commanderCues.some(cue => /-(?:me|join):/.test(cue.key)), 'the commander-only browser remains silent');
    assert.ok(!selectedCommanderCues.some(cue => /-(?:me|join):/.test(cue.key)), 'an unselected registered commander remains silent');
    const captainAPersonalCue = captainACues.find(cue => cue.key.endsWith('-me:10') && cue.nodeCount > 0);
    assert.ok(captainAPersonalCue, 'Captain A books an audible exact T-10 personal cue');
    const captainAGoCue = captainACues.find(cue => cue.key.endsWith('-me:0') && cue.nodeCount > 0);
    const captainASecondGoCue = captainASecondCues.find(cue => cue.key.endsWith('-me:0') && cue.nodeCount > 0);
    const captainBGoCue = captainBCues.find(cue => cue.key.endsWith('-me:0') && cue.nodeCount > 0);
    assert.ok(captainAGoCue, 'Captain A books a schedulable personal GO cue');
    assert.ok(captainASecondGoCue, 'Captain A second device books a schedulable personal GO cue');
    assert.ok(captainBGoCue, 'Captain B books a schedulable personal GO cue');
    assert.equal(captainAGoCue.targetMs, frozenPairsByPid[captainAProfile.pid].pressUTC * 1000,
      'Captain A personal GO cue targets Captain A own frozen press time');
    assert.equal(captainASecondGoCue.targetMs, frozenPairsByPid[captainAProfile.pid].pressUTC * 1000,
      'Captain A second device targets Captain A own frozen press time');
    assert.equal(captainBGoCue.targetMs, frozenPairsByPid[captainBProfile.pid].pressUTC * 1000,
      'Captain B personal GO cue targets Captain B own frozen press time');

    await waitUntil(() => captainAGate.clientAcks.length >= 2 && captainAGate.savedAcks.length >= 2,
      'retry after the first deliveryAckSaved is lost');
    await waitUntil(() => captainASecondGate.clientAcks.length >= 2,
      'immutable retry while the second device client ACK is lost');
    assert.deepEqual(captainAGate.clientAcks[1], captainAGate.clientAcks[0],
      'a lost deliveryAckSaved retries one immutable payload');
    assert.deepEqual(captainASecondGate.clientAcks[1], captainASecondGate.clientAcks[0],
      'a lost client ACK retries one immutable payload');
    const ackTuple = message => ({
      commandId: message.commandId,
      pid: message.pid,
      deviceId: message.deviceId,
      outcome: message.outcome,
      targetUTC: message.targetUTC,
      scheduledAtMs: message.scheduledAtMs
    });
    assert.deepEqual(ackTuple(captainAGate.savedAcks.at(-1)), ackTuple(captainAGate.clientAcks[0]),
      'the primary browser stops only on its exact deliveryAckSaved tuple');
    try {
      await commander.page.locator(`#pickSlots .slot[data-pid="${captainAProfile.pid}"] .delivery`).filter({ hasText: 'Received 1/2' }).waitFor({ timeout: 8_000 });
    } catch (error) {
      const diagnosticSnapshot = await readSnapshot(commander.page, room);
      const diagnosticCommand = diagnosticSnapshot.room.live.commands['1'];
      const diagnosticBadge = await commander.page.locator(`#pickSlots .slot[data-pid="${captainAProfile.pid}"] .delivery`).textContent().catch(() => '<missing>');
      throw new Error(`Received 1/2 diagnostic: ${JSON.stringify({
        delivery: diagnosticCommand && diagnosticCommand.delivery,
        badge: diagnosticBadge,
        primaryClientAcks: captainAGate.clientAcks.length,
        primarySavedAcks: captainAGate.savedAcks.length,
        secondClientAcks: captainASecondGate.clientAcks.length,
        secondSavedAcks: captainASecondGate.savedAcks.length,
        secondHeld: captainASecondGate.holdClientAcks
      })}`, { cause: error });
    }
    let receiptSnapshot = await readSnapshot(commander.page, room);
    let captainADelivery = receiptSnapshot.room.live.commands['1'].delivery.find(value => value.pid === captainAProfile.pid);
    assert.deepEqual({ expected: captainADelivery.expected, received: captainADelivery.received }, { expected: 2, received: 1 },
      'one exact persisted device ACK produces stable Received 1/2');

    captainASecondGate.holdClientAcks = false;
    await waitUntil(() => captainASecondGate.savedAcks.length >= 1, 'second-device persisted ACK');
    assert.deepEqual(ackTuple(captainASecondGate.savedAcks.at(-1)), ackTuple(captainASecondGate.clientAcks[0]),
      'the second browser stops only on its exact deliveryAckSaved tuple');
    await commander.page.locator(`#pickSlots .slot[data-pid="${captainAProfile.pid}"] .delivery`).filter({ hasText: 'Received 2/2' }).waitFor({ timeout: 8_000 });
    await commander.page.locator(`#pickSlots .slot[data-pid="${captainBProfile.pid}"] .delivery.received`).waitFor({ timeout: 8_000 });
    receiptSnapshot = await readSnapshot(commander.page, room);
    captainADelivery = receiptSnapshot.room.live.commands['1'].delivery.find(value => value.pid === captainAProfile.pid);
    assert.deepEqual({ expected: captainADelivery.expected, received: captainADelivery.received }, { expected: 2, received: 2 },
      'the second exact persisted ACK produces Received 2/2 without double counting');
    const stableAckCounts = {
      primaryClient: captainAGate.clientAcks.length,
      primaryServer: captainAGate.savedAcks.length,
      secondClient: captainASecondGate.clientAcks.length,
      secondServer: captainASecondGate.savedAcks.length
    };
    await delay(2_300);
    assert.deepEqual({
      primaryClient: captainAGate.clientAcks.length,
      primaryServer: captainAGate.savedAcks.length,
      secondClient: captainASecondGate.clientAcks.length,
      secondServer: captainASecondGate.savedAcks.length
    }, stableAckCounts, 'exact deliveryAckSaved stops retries after persistence confirmation');

    const afterRetryWindow = await readSnapshot(commander.page, room);
    assert.deepEqual(afterRetryWindow.room.live.commands['1'].delivery,
      receiptSnapshot.room.live.commands['1'].delivery,
      'the legitimate delivery aggregate is stable before forged ACK attempts');
    receiptSnapshot = afterRetryWindow;
    const deliveryBeforeForgedAcks = structuredClone(receiptSnapshot.room.live.commands['1'].delivery);
    await verifyForgedDeliveryAcks(commander.page, room, captainAGate.clientAcks[0]);
    const afterForgedAcks = await readSnapshot(commander.page, room);
    assert.deepEqual(afterForgedAcks.room.live.commands['1'].delivery, deliveryBeforeForgedAcks,
      'unbound, mismatched, and soundReady:false ACKs cannot alter the full delivery aggregate');
    receiptSnapshot = afterForgedAcks;

    const settledDeliveryHistory = structuredClone(receiptSnapshot.room.live.commands['1'].delivery);
    const captainBClosedIndex = await captainB.page.evaluate(() => {
      const index = window.__qaRoomSockets.findLastIndex(socket => socket.readyState === WebSocket.OPEN);
      window.__qaRoomSockets[index].close(4000, 'QA history disconnect');
      return index;
    });
    await captainB.page.waitForFunction(index => window.__qaRoomSockets[index].readyState === WebSocket.CLOSED,
      captainBClosedIndex, { timeout: 5_000 });
    await commander.page.locator(`#pickSlots .slot[data-pid="${captainBProfile.pid}"] .delivery.received`).waitFor({ timeout: 5_000 });
    const disconnectedHistory = await readSnapshot(commander.page, room);
    assert.deepEqual(disconnectedHistory.room.live.commands['1'].delivery, settledDeliveryHistory,
      'connection loss cannot erase or alter persisted command receipt history');

    assert.equal(await commander.page.locator('#pickSlots .slot.frozen').count(), 2,
      'post-Fire live captain slots remain visible');
    assert.equal(await commander.page.locator('#pickSlots .sx').count(), 0,
      'post-Fire live captain slots expose no remove controls');
    assert.equal(await commander.page.locator('#pickSlots #swapRoles').count(), 0,
      'post-Fire live captain slots expose no swap control');

    await captainA.page.locator('#editBtn').click();
    await captainA.page.locator('#marchRange').fill('64');
    await captainA.page.locator('#saveBtn').click();
    await commander.page.locator(`#roster .roster-time[data-pid="${captainAProfile.pid}"]`).filter({ hasText: '1:04' }).waitFor({ timeout: 8_000 });
    const afterCaptainAEdit = await readSnapshot(commander.page, room);
    assert.equal(afterCaptainAEdit.room.players[captainAProfile.pid].march, 64,
      'Captain A later edit updates canonical march before Captain B edit');

    await commander.page.locator(`#roster .roster-time[data-pid="${captainBProfile.pid}"]`).click();
    await commander.page.locator('#commanderMarchEditor').waitFor({ state: 'visible', timeout: 5_000 });
    await commander.page.locator('#commanderMarchInput').fill('1:11');
    await commander.page.locator('#commanderMarchSave').click();
    await commander.page.locator('#commanderMarchEditor').waitFor({ state: 'hidden', timeout: 8_000 });
    await commander.page.locator(`#roster .roster-time[data-pid="${captainBProfile.pid}"]`).filter({ hasText: '1:11' }).waitFor({ timeout: 8_000 });
    const afterLiveEdits = await readSnapshot(commander.page, room);
    assert.equal(afterLiveEdits.room.players[captainAProfile.pid].march, 64,
      'Captain A canonical march remains updated after Captain B edit');
    assert.equal(afterLiveEdits.room.players[captainBProfile.pid].march, 71,
      'Captain B later edit independently updates canonical march');
    assert.deepEqual(pairsByPid(afterLiveEdits.room.live.commands['1'].payload.pairs), frozenPairsByPid,
      'both complete frozen captain pairs retain their original march and pressUTC after canonical edits');
    const [afterCaptainACues, afterCaptainASecondCues, afterCaptainBCues] = await Promise.all([
      cueState(captainA), cueState(captainASecond), cueState(captainB)
    ]);
    const afterEditCue = afterCaptainACues.find(cue => cue.key === captainAPersonalCue.key);
    assert.equal(afterEditCue && afterEditCue.targetMs, captainAPersonalCue.targetMs,
      'a later march edit cannot move Captain A exact T-10 personal audio target');
    assert.equal(afterCaptainACues.find(cue => cue.key === captainAGoCue.key)?.targetMs,
      captainAGoCue.targetMs, 'Captain A original personal GO target remains immutable');
    assert.equal(afterCaptainASecondCues.find(cue => cue.key === captainASecondGoCue.key)?.targetMs,
      captainASecondGoCue.targetMs, 'Captain A second device original personal GO target remains immutable');
    assert.equal(afterCaptainBCues.find(cue => cue.key === captainBGoCue.key)?.targetMs,
      captainBGoCue.targetMs, 'Captain B original personal GO target remains immutable');

    await commander.page.locator(`#roster .roster-actions[data-pid="${captainAProfile.pid}"]`).click();
    const activeRemove = commander.page.locator('#rosterActionsMenu [data-action="remove"]');
    assert.equal(await activeRemove.getAttribute('aria-disabled'), 'true',
      'an active captain removal remains focusable but unavailable');
    await commander.page.keyboard.press('Escape');
    const beforeRejectedRemoval = await readSnapshot(commander.page, room);
    const removalError = await forceLiveRemoval(commander.page, room, captainAProfile.pid);
    const afterRejectedRemoval = await readSnapshot(commander.page, room);
    assert.deepEqual(removalError, { t: 'error', error: 'player_in_live_command', pid: captainAProfile.pid });
    assert.deepEqual(afterRejectedRemoval.room.live, beforeRejectedRemoval.room.live,
      'live-command removal is rejected atomically without mutating live or staged state');
    assert.deepEqual(afterRejectedRemoval.room.players[captainAProfile.pid],
      beforeRejectedRemoval.room.players[captainAProfile.pid],
      'live-command removal rejection preserves the protected player full canonical record');

    await cancelCommand(commander.page, room);
    assert.equal(await commander.page.locator('#pickSlots .slot.frozen').count(), 0,
      'Cancel releases the read-only live slots');

    const beforeReconnect = await readSnapshot(commander.page, room);
    const canonicalBeforeReconnect = beforeReconnect.room.players[captainAProfile.pid];
    const socketCount = await captainASecond.page.evaluate(() => window.__qaRoomSockets.length);
    await captainASecond.page.evaluate(({ roomName, staleProfile }) => {
      localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify(staleProfile));
      window.__qaRoomSockets.filter(socket => socket.readyState === WebSocket.OPEN).at(-1).close(4000, 'QA stale reconnect');
    }, { roomName: room, staleProfile: { ...captainAProfile, march: 55, marchRevision: 0 } });
    await captainASecond.page.waitForFunction(previousCount =>
      window.__qaRoomSockets.length > previousCount && window.__qaRoomSockets.at(-1).readyState === WebSocket.OPEN,
    socketCount, { timeout: 12_000 });
    await waitUntil(async () => {
      const snapshot = await readSnapshot(commander.page, room);
      return snapshot.room.players[captainAProfile.pid].march === canonicalBeforeReconnect.march;
    }, 'stale reconnect reconciliation');
    const afterReconnect = await readSnapshot(commander.page, room);
    assert.deepEqual({
      march: afterReconnect.room.players[captainAProfile.pid].march,
      marchRevision: afterReconnect.room.players[captainAProfile.pid].marchRevision
    }, {
      march: canonicalBeforeReconnect.march,
      marchRevision: canonicalBeforeReconnect.marchRevision
    }, 'a stale reconnect cannot change canonical march or revision');
    await captainASecond.page.waitForFunction(({ roomName, playerId, march, revision }) => {
      const profile = JSON.parse(localStorage.getItem(`kingshoter_r_${roomName}_me`) || 'null');
      return profile && profile.pid === playerId && profile.march === march && profile.marchRevision === revision;
    }, { roomName: room, playerId: captainAProfile.pid, march: canonicalBeforeReconnect.march, revision: canonicalBeforeReconnect.marchRevision }, { timeout: 8_000 });

    await selectPlayer(commander.page, selectedCommanderProfile.pid);
    await selectPlayer(commander.page, captainBProfile.pid);
    await fireDouble(commander.page);
    await waitUntil(async () => (await cueState(selectedCommander))
      .some(cue => cue.key.includes('-me:') && cue.nodeCount > 0),
    'selected commander schedulable personal cue');
    const selectedCueState = await cueState(selectedCommander);
    assert.ok(selectedCueState.some(cue => cue.key.includes('-me:') && cue.nodeCount > 0),
      'a registered commander selected in a separate command receives personal cues');
    assert.ok(!selectedCueState.some(cue => cue.key.includes('-join:')),
      'a selected commander never receives JOIN cues');
    assert.ok(!(await cueKeys(commander)).some(key => /-(?:me|join):/.test(key)),
      'the commander-only browser remains silent in the separate command');
    await cancelCommand(commander.page, room);

    assert.deepEqual(errors, [], 'the consolidated core scenario has no page errors');
    console.log(`✓ ${engineName} core room ${room}`);
    return room;
  } finally {
    for (const role of roles) {
      try { await role.context.close(); } catch (_) {}
    }
  }
}

async function runCompatibilityScenario(browser, engineName) {
  const room = makeQaRoom({ title: `${suiteTitle}-compatibility` });
  assertQaRoomName(room);
  const errors = [];
  const ignoredA = packetGate({ ignoreDeliveryProtocol: true, legacyTransport: true });
  const ignoredB = packetGate({ ignoreDeliveryProtocol: true, legacyTransport: true });
  const ignoredOrdinary = packetGate({ ignoreDeliveryProtocol: true, legacyTransport: true });
  const ignoredCommander = packetGate({ ignoreDeliveryProtocol: true, legacyTransport: true });
  const captainAProfile = playerProfile('920000001', 'Compatibility Captain A', 60);
  const captainBProfile = playerProfile('920000002', 'Compatibility Captain B', 70);
  const ordinaryProfile = playerProfile('920000003', 'Compatibility Member', 80);
  const roles = [];
  try {
    const opened = await Promise.all([
      openRole(browser, { room, label: 'compatibility-commander', gate: ignoredCommander, errors }),
      openRole(browser, { room, label: 'compatibility-captain-a', profile: captainAProfile, deviceId: '61111111-1111-4111-8111-111111111111', gate: ignoredA, errors }),
      openRole(browser, { room, label: 'compatibility-captain-b', profile: captainBProfile, deviceId: '62222222-2222-4222-8222-222222222222', gate: ignoredB, errors }),
      openRole(browser, { room, label: 'compatibility-member', profile: ordinaryProfile, deviceId: '63333333-3333-4333-8333-333333333333', gate: ignoredOrdinary, errors })
    ]);
    roles.push(...opened);
    const [commander, captainA, captainB, ordinary] = opened;
    await unlockCommander(commander.page);
    await selectPlayer(commander.page, captainAProfile.pid);
    await selectPlayer(commander.page, captainBProfile.pid);
    await fireDouble(commander.page);
    await waitUntil(() => ignoredA.clientAcks.length >= 1 && ignoredB.clientAcks.length >= 1,
      'legacy server ignoring delivery ACKs');
    await waitUntil(() => ignoredA.deviceStatuses.length >= 1 && ignoredB.deviceStatuses.length >= 1,
      'legacy server ignoring device status');
    const ignoredGates = [ignoredCommander, ignoredA, ignoredB, ignoredOrdinary];
    const legacyCommandFromFrame = frame => {
      let message = null;
      try { message = JSON.parse(String(frame)); } catch (_) {}
      return message && message.room && message.room.live && message.room.live.commands
        ? message.room.live.commands['1']
        : null;
    };
    await waitUntil(() => ignoredGates.every(gate => gate.transformedLegacyFrames.some(frame => {
      const command = legacyCommandFromFrame(frame);
      return command && !Object.hasOwn(command, 'delivery');
    })), 'every compatibility context proxying a delivery-free live snapshot', 8_000);
    const hasExactIgnoredFrame = (gate, message) => gate.ignoredClientFrames
      .some(frame => String(frame) === JSON.stringify(message));
    assert.ok(hasExactIgnoredFrame(ignoredA, ignoredA.deviceStatuses[0]),
      'Node gate retains Captain A exact ignored deviceStatus frame');
    assert.ok(hasExactIgnoredFrame(ignoredB, ignoredB.deviceStatuses[0]),
      'Node gate retains Captain B exact ignored deviceStatus frame');
    assert.ok(hasExactIgnoredFrame(ignoredA, ignoredA.clientAcks[0]),
      'Node gate retains Captain A exact ignored deliveryAck frame');
    assert.ok(hasExactIgnoredFrame(ignoredB, ignoredB.clientAcks[0]),
      'Node gate retains Captain B exact ignored deliveryAck frame');

    const [aCues, bCues, ordinaryCues, commanderCues] = await Promise.all([captainA, captainB, ordinary, commander]
      .map(role => role.page.evaluate(() => Object.entries(window.__cues || {}).map(([key, cue]) => ({
        key,
        nodeCount: Array.isArray(cue.nodes) ? cue.nodes.length : 0
      })))));
    assert.ok(aCues.some(cue => cue.key.includes('-me:') && cue.nodeCount > 0),
      'compatibility Captain A still gets schedulable personal Classic cues');
    assert.ok(bCues.some(cue => cue.key.includes('-me:') && cue.nodeCount > 0),
      'compatibility Captain B still gets schedulable personal Classic cues');
    assert.equal(new Set(ordinaryCues.filter(cue => cue.key.includes('-join:')).map(cue => cue.key.replace(/:\d+$/, ''))).size, 1,
      'compatibility ordinary member still gets exactly one JOIN command/base');
    assert.ok(!commanderCues.some(cue => /-(?:me|join):/.test(cue.key)),
      'compatibility unselected commander remains silent');
    const legacyFrame = ignoredCommander.transformedLegacyFrames.findLast(frame => legacyCommandFromFrame(frame));
    const legacySnapshot = JSON.parse(legacyFrame);
    const legacyCommand = legacySnapshot.room.live.commands['1'];
    assert.equal(Object.hasOwn(legacyCommand, 'delivery'), false,
      'the proxy-transformed Node-side legacy snapshot omits the additive delivery aggregate');
    try {
      await commander.page.waitForFunction(() => {
        const command = window.__qaObservedStates.findLast(state =>
          state && state.room && state.room.live && state.room.live.commands
            && state.room.live.commands['1'])?.room.live.commands['1'];
        return command && !Object.hasOwn(command, 'delivery');
      }, null, { timeout: 8_000 });
    } catch (error) {
      const pageEvidence = await commander.page.evaluate(() => ({
        count: window.__qaObservedStates.length,
        types: window.__qaObservedStates.map(state => state && state.t),
        rawCommands: window.__qaObservedStateFrames.map(frame => {
          const state = JSON.parse(frame);
          return state && state.room && state.room.live && state.room.live.commands
            ? structuredClone(state.room.live.commands)
            : null;
        }),
        commands: window.__qaObservedStates.map(state =>
          state && state.room && state.room.live && state.room.live.commands
            ? structuredClone(state.room.live.commands)
            : null)
      }));
      throw new Error(`compatibility page-observed transport diagnostic: ${JSON.stringify({
        transformedCount: ignoredCommander.transformedLegacyFrames.length,
        transformedCommand: legacyCommand,
        pageEvidence
      })}`, { cause: error });
    }
    const pageObservedLegacyCommand = await commander.page.evaluate(() => structuredClone(
      window.__qaObservedStates.findLast(state =>
        state && state.room && state.room.live && state.room.live.commands
          && state.room.live.commands['1']).room.live.commands['1']
    ));
    assert.equal(Object.hasOwn(pageObservedLegacyCommand, 'delivery'), false,
      'the command observed by the page omits delivery before application parsing');
    assert.equal(await commander.page.locator('#pickSlots .delivery').count(), 0,
      'ignored delivery protocol never creates a false Received status');
    assert.equal(await commander.page.locator('#pickSlots .slot.frozen').count(), 2,
      'legacy snapshots keep read-only live captain slots');
    assert.equal(await commander.page.locator('#pickSlots .sx').count(), 0);
    assert.equal(await commander.page.locator('#pickSlots #swapRoles').count(), 0);
    await assertNoPublicDeliveryMode(commander.page);
    assert.deepEqual(errors, [], 'the Classic rollback compatibility scenario throws no page errors');
    await cancelCommand(commander.page, room);
    console.log(`✓ ${engineName} compatibility room ${room}`);
    return room;
  } finally {
    for (const role of roles) {
      try { await role.context.close(); } catch (_) {}
    }
  }
}

async function runProject(engineName) {
  const browserType = { chromium, firefox, webkit }[engineName];
  const launchOptions = { headless: true };
  if (engineName === 'chromium') launchOptions.args = ['--autoplay-policy=no-user-gesture-required'];
  const browser = await browserType.launch(launchOptions);
  try {
    const coreRoom = await runCoreScenario(browser, engineName);
    const compatibilityRoom = await runCompatibilityScenario(browser, engineName);
    const label = engineName === 'webkit' ? 'WebKit desktop automation' : engineName[0].toUpperCase() + engineName.slice(1);
    console.log(`PASS ${label}: ${coreRoom}, ${compatibilityRoom}`);
    return { engineName, coreRoom, compatibilityRoom };
  } finally {
    await browser.close();
  }
}

(async () => {
  assertCompatibilityTransform();
  const projects = requestedProjects(process.argv.slice(2));
  const results = [];
  for (const project of projects) results.push(await runProject(project));
  console.log(`\n${results.length}/${results.length} browser projects passed in generated qa-kvk-* rooms`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
