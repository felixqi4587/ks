const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard,
  localQaBaseURL
} = require('./support/qa-coordination.cjs');

const base = localQaBaseURL(process.env.BASE || 'http://127.0.0.1:8791');
const recoveryRoom = assertQaRoomName(makeQaRoom('registration-recovery'));
const deletionRoom = assertQaRoomName(makeQaRoom('registration-deletion'));
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptyRoom(players = {}) {
  return {
    config: { castleName: '', rallyAllies: [], enemyWhales: [] },
    players,
    rallyModes: {
      1: { mode: 'double', revision: 0 },
      2: { mode: 'double', revision: 0 }
    },
    live: {
      mode: 'idle',
      commands: { 1: null, 2: null },
      staged: { 1: null, 2: null },
      sim: null
    },
    hasPw: false,
    presence: 1,
    updatedAt: null,
    updatedBy: null
  };
}

function canonicalPlayer(pid, name, march) {
  return {
    [pid]: {
      name,
      march,
      marchRevision: 0,
      identityMode: 'playerId',
      playerId: pid,
      alliance: '',
      ready: false,
      lastSeen: '2026-07-15T00:00:00.000Z'
    }
  };
}

function installControlledWebSocket() {
  const clone = value => JSON.parse(JSON.stringify(value));
  const harness = window.__qaRegistrationProtocol = {
    sockets: [],
    roomSends: [],
    roomSocket: null
  };

  class ControlledWebSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = ControlledWebSocket.CONNECTING;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      harness.sockets.push(this);
      setTimeout(() => {
        if (this.readyState !== ControlledWebSocket.CONNECTING) return;
        this.readyState = ControlledWebSocket.OPEN;
        if (typeof this.onopen === 'function') this.onopen({ type: 'open' });
      }, 0);
    }

    send(data) {
      if (this.readyState !== ControlledWebSocket.OPEN) throw new Error('Controlled WebSocket is not open');
      let message = null;
      try { message = JSON.parse(String(data)); } catch (_) {}
      this.sent.push(message || String(data));
    }

    close() {
      if (this.readyState >= ControlledWebSocket.CLOSING) return;
      this.readyState = ControlledWebSocket.CLOSING;
      setTimeout(() => {
        if (this.readyState === ControlledWebSocket.CLOSED) return;
        this.readyState = ControlledWebSocket.CLOSED;
        if (typeof this.onclose === 'function') this.onclose({ type: 'close', code: 1000 });
      }, 0);
    }

    serverSend(message) {
      if (this.readyState !== ControlledWebSocket.OPEN) throw new Error('Cannot send from a closed controlled server');
      if (typeof this.onmessage === 'function') {
        this.onmessage({ type: 'message', data: JSON.stringify(message) });
      }
    }

    serverClose() {
      if (this.readyState === ControlledWebSocket.CLOSED) return;
      this.readyState = ControlledWebSocket.CLOSED;
      if (typeof this.onclose === 'function') this.onclose({ type: 'close', code: 1006 });
    }
  }
  ControlledWebSocket.CONNECTING = 0;
  ControlledWebSocket.OPEN = 1;
  ControlledWebSocket.CLOSING = 2;
  ControlledWebSocket.CLOSED = 3;
  window.WebSocket = ControlledWebSocket;

  Object.defineProperty(window, 'RoomSocket', {
    configurable: true,
    set(RoomSocketClass) {
      class ObservedRoomSocket extends RoomSocketClass {
        constructor(...args) {
          super(...args);
          harness.roomSocket = this;
        }

        send(message) {
          const result = super.send(message);
          harness.roomSends.push({
            generation: Number(this.connectionGeneration || 0),
            message: clone(message),
            result
          });
          return result;
        }
      }
      Object.defineProperty(window, 'RoomSocket', {
        configurable: true,
        writable: true,
        value: ObservedRoomSocket
      });
    }
  });
}

async function waitForSocket(page, index) {
  await page.waitForFunction(socketIndex => {
    const harness = window.__qaRegistrationProtocol;
    return !!(harness && harness.roomSocket && harness.sockets[socketIndex] &&
      harness.sockets[socketIndex].readyState === 1);
  }, index, { timeout: 5000 });
}

async function serverSend(page, socketIndex, message) {
  await page.evaluate(({ index, frame }) => {
    window.__qaRegistrationProtocol.sockets[index].serverSend(frame);
  }, { index: socketIndex, frame: message });
}

async function reconnect(page, socketIndex) {
  const refreshed = await page.evaluate(index => {
    const harness = window.__qaRegistrationProtocol;
    harness.sockets[index].serverClose();
    return harness.roomSocket.refresh();
  }, socketIndex);
  assert.equal(refreshed, true);
  await waitForSocket(page, socketIndex + 1);
}

async function socketRegistrations(page, socketIndex) {
  return page.evaluate(index => window.__qaRegistrationProtocol.sockets[index].sent
    .filter(message => message && message.t === 'registerPlayer'), socketIndex);
}

async function observedRegistrations(page) {
  return page.evaluate(() => window.__qaRegistrationProtocol.roomSends
    .filter(entry => entry.message && entry.message.t === 'registerPlayer'));
}

async function readProfile(page, room) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), `kingshoter_r_${room}_me`);
}

async function createClient(browser, { room, pid, name, march }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  await installQaWebSocketGuard(context, room, { expectedOrigin: base });
  await context.addInitScript(installControlledWebSocket);
  await context.route('**/api/lookup?*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, fid: pid, nickname: name })
  }));
  await context.route('**/api/time', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ t: Date.now() })
  }));

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(qaRoomUrl(base, room, { notour: 1 }), { waitUntil: 'domcontentloaded' });
  await waitForSocket(page, 0);
  await serverSend(page, 0, { t: 'state', room: emptyRoom() });
  await page.locator('#soundGate').click();
  await page.locator('#roomView.presound').waitFor({ state: 'detached', timeout: 5000 }).catch(async () => {
    assert.equal(await page.locator('#roomView').evaluate(element => element.classList.contains('presound')), false);
  });
  await page.locator('#identityPlayerId').click();
  await page.locator('#pid').fill(pid);
  await page.locator('#nameOut').filter({ hasText: name }).waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#marchRange').fill(String(march));
  assert.equal(await page.locator('#marchRange').inputValue(), String(march));
  return { context, page, errors, room, pid, name, march };
}

async function startUncertainRegistration(client) {
  const { page, pid, name, march } = client;
  await page.locator('#saveBtn').click();
  await page.waitForFunction(expectedPid => window.__qaRegistrationProtocol.roomSends.some(entry =>
    entry.result === true && entry.message && entry.message.t === 'registerPlayer' &&
    entry.message.pid === expectedPid), pid, { timeout: 5000 });

  const observed = (await observedRegistrations(page)).filter(entry => entry.message.pid === pid);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].result, true, 'the initial RoomSocket registration send succeeds before disconnect');
  const registration = observed[0].message;
  assert.equal(registration.recoverOnly, undefined);
  assert.equal(registration.playerId, pid);
  assert.equal(registration.name, name);
  assert.equal(registration.march, march);
  assert.match(registration.profileKey, uuidV4);
  assert.match(registration.registrationId, uuidV4);
  return registration;
}

async function assertRetryState(client, socketIndex, registration) {
  const { page, room, pid, march } = client;
  await page.locator('#saveBtn').filter({ hasText: /^Retry$/ }).waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(150);
  assert.deepEqual(await socketRegistrations(page, socketIndex), [],
    'a missing reconnect snapshot never emits an automatic creating registration');
  assert.equal(await readProfile(page, room), null, 'uncertain ownership is not persisted before ACK and state converge');
  assert.equal(await page.locator('#pid').inputValue(), pid, 'the exact pending identity remains available for retry');
  assert.equal(await page.locator('#marchRange').inputValue(), String(march));
  assert.equal(registration.pid, pid);
}

async function proveDelayedCommitRecovery(browser) {
  const client = await createClient(browser, {
    room: recoveryRoom,
    pid: '880000411',
    name: 'Delayed Commit Captain',
    march: 41
  });
  const { page, room, pid, name, march } = client;
  const registration = await startUncertainRegistration(client);

  await reconnect(page, 0);
  await serverSend(page, 1, { t: 'state', room: emptyRoom() });
  await assertRetryState(client, 1, registration);

  await serverSend(page, 1, {
    t: 'state',
    room: emptyRoom(canonicalPlayer(pid, name, march))
  });
  await page.waitForFunction(({ expectedPid, expectedId }) => window.__qaRegistrationProtocol.sockets[1].sent.some(message =>
    message && message.t === 'registerPlayer' && message.pid === expectedPid &&
    message.registrationId === expectedId && message.recoverOnly === true), {
    expectedPid: pid,
    expectedId: registration.registrationId
  }, { timeout: 5000 });

  const recoveryFrames = await socketRegistrations(page, 1);
  assert.equal(recoveryFrames.length, 1, 'the reconnect sends only one non-creating recovery frame');
  assert.equal(recoveryFrames[0].recoverOnly, true);
  assert.equal(recoveryFrames[0].registrationId, registration.registrationId);
  assert.equal(recoveryFrames[0].profileKey, registration.profileKey,
    'recovery retains the original private capability');

  await serverSend(page, 1, {
    t: 'playerRegistered',
    registrationId: registration.registrationId,
    pid,
    created: false,
    editable: true,
    identityMode: 'playerId',
    playerId: pid,
    name,
    march,
    revision: 0
  });
  await page.locator('#youChip').waitFor({ state: 'visible', timeout: 5000 });
  const profile = await readProfile(page, room);
  assert.equal(profile.pid, pid);
  assert.equal(profile.editable, true);
  assert.equal(profile.profileKey, registration.profileKey,
    'ACK plus delayed canonical state saves the exact key from the original send');
  assert.deepEqual(client.errors, []);
  await client.context.close();
}

async function proveDeletedCanonicalNeedsExplicitRetry(browser) {
  const client = await createClient(browser, {
    room: deletionRoom,
    pid: '880000422',
    name: 'Deleted Canonical Captain',
    march: 42
  });
  const { page, pid, name, march } = client;
  const registration = await startUncertainRegistration(client);

  await reconnect(page, 0);
  await serverSend(page, 1, {
    t: 'state',
    room: emptyRoom(canonicalPlayer(pid, name, march))
  });
  await page.waitForFunction(expectedId => window.__qaRegistrationProtocol.sockets[1].sent.some(message =>
    message && message.t === 'registerPlayer' && message.registrationId === expectedId &&
    message.recoverOnly === true), registration.registrationId, { timeout: 5000 });
  const firstRecovery = await socketRegistrations(page, 1);
  assert.equal(firstRecovery.length, 1);
  assert.equal(firstRecovery[0].recoverOnly, true);

  // The canonical player is deleted while that recovery request is in flight.
  await reconnect(page, 1);
  await serverSend(page, 2, { t: 'state', room: emptyRoom() });
  await assertRetryState(client, 2, registration);

  await page.locator('#saveBtn').click();
  await page.waitForFunction(expectedId => window.__qaRegistrationProtocol.sockets[2].sent.some(message =>
    message && message.t === 'registerPlayer' && message.registrationId === expectedId),
  registration.registrationId, { timeout: 5000 });
  const explicitFrames = await socketRegistrations(page, 2);
  assert.equal(explicitFrames.length, 1, 'one user click emits one new creation attempt');
  assert.equal(Object.hasOwn(explicitFrames[0], 'recoverOnly'), false,
    'only the explicit Retry click may send a creating registration');
  assert.equal(explicitFrames[0].registrationId, registration.registrationId);
  assert.equal(explicitFrames[0].profileKey, registration.profileKey,
    'manual retry reuses the frozen original capability rather than minting a new owner');
  const matchingSend = (await observedRegistrations(page)).at(-1);
  assert.equal(matchingSend.result, true);
  assert.equal(await readProfile(page, client.room), null,
    'a manual create still waits for its own canonical state and ACK before persistence');
  assert.deepEqual(client.errors, []);
  await client.context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    await proveDelayedCommitRecovery(browser);
    await proveDeletedCanonicalNeedsExplicitRetry(browser);
    console.log(`✓ registration recovery never auto-creates (${recoveryRoom}, ${deletionRoom})`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(`QA rooms: ${recoveryRoom}, ${deletionRoom}`);
  console.error(error);
  process.exit(1);
});
