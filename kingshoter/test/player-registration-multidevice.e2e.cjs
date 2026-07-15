const assert = require('node:assert/strict');
const { basename } = require('node:path');
const { chromium } = require('playwright');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard,
  localQaBaseURL
} = require('./support/qa-kvk.cjs');

const base = localQaBaseURL(process.env.BASE || 'http://127.0.0.1:8791');
const room = assertQaRoomName(makeQaRoom({ title: basename(__filename, '.cjs') }));
const url = qaRoomUrl(base, room, { notour: 1 });
const pid = '880000321';
const playerName = 'Multidevice Captain';
const march = 37;
const meKey = `kingshoter_r_${room}_me`;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out: ${message}`);
}

function parseFrame(data) {
  try { return JSON.parse(String(data)); }
  catch (_) { return null; }
}

function createGate() {
  const gate = { client: [], server: [] };
  gate.options = {
    expectedOrigin: base,
    shouldDropClientMessage({ data }) {
      const message = parseFrame(data);
      if (message) gate.client.push(message);
      return false;
    },
    shouldDropServerMessage({ data }) {
      const message = parseFrame(data);
      if (message) gate.server.push(message);
      return false;
    }
  };
  return gate;
}

function registrationFor(gate, registrationId) {
  return gate.server.find(message => message && message.t === 'playerRegistered' &&
    message.registrationId === registrationId && message.pid === pid);
}

function canonicalStateFor(gate) {
  return gate.server.filter(message => message && message.t === 'state' &&
    message.room && message.room.players && message.room.players[pid]).at(-1);
}

async function preparePlayer(page) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#soundGate').click();
  await page.locator('#roomView.presound').waitFor({ state: 'detached', timeout: 5000 }).catch(async () => {
    assert.equal(await page.locator('#roomView').evaluate(element => element.classList.contains('presound')), false);
  });
  await page.locator('#identityPlayerId').click();
  await page.locator('#pid').fill(pid);
  await page.locator('#nameOut').filter({ hasText: playerName }).waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#marchRange').fill(String(march));
  assert.equal(await page.locator('#marchRange').inputValue(), String(march));
}

async function readProfile(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), meKey);
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const firstContext = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  const firstGate = createGate();
  const secondGate = createGate();
  const pageErrors = [];

  try {
    await Promise.all([
      installQaWebSocketGuard(firstContext, room, firstGate.options),
      installQaWebSocketGuard(secondContext, room, secondGate.options)
    ]);
    for (const context of [firstContext, secondContext]) {
      await context.route('**/api/lookup?*', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, fid: pid, nickname: playerName })
      }));
    }

    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();
    firstPage.on('pageerror', error => pageErrors.push(`first: ${error.message}`));
    secondPage.on('pageerror', error => pageErrors.push(`second: ${error.message}`));
    const pairs = [
      { label: 'first', page: firstPage, gate: firstGate },
      { label: 'second', page: secondPage, gate: secondGate }
    ];

    await Promise.all(pairs.map(({ page }) => preparePlayer(page)));
    await Promise.all(pairs.map(({ page }) => page.locator('#saveBtn').click()));

    await waitFor(() => pairs.every(({ gate }) => gate.client.some(message =>
      message.t === 'registerPlayer' && message.pid === pid)), 'both registration requests');
    for (const pair of pairs) {
      pair.registration = pair.gate.client.find(message => message.t === 'registerPlayer' && message.pid === pid);
      assert.equal(pair.registration.identityMode, 'playerId');
      assert.equal(pair.registration.playerId, pid);
      assert.equal(pair.registration.name, playerName);
      assert.equal(pair.registration.march, march);
      assert.match(pair.registration.profileKey, uuidV4);
      assert.match(pair.registration.registrationId, uuidV4);
    }
    assert.notEqual(pairs[0].registration.profileKey, pairs[1].registration.profileKey,
      'independent devices propose independent private profile capabilities');

    await waitFor(() => pairs.every(({ gate, registration }) =>
      registrationFor(gate, registration.registrationId)), 'both registration ACKs');
    await waitFor(() => pairs.every(({ gate }) => canonicalStateFor(gate)),
      'both devices receive the canonical room state');
    await Promise.all(pairs.map(({ page }) => page.locator('#youChip').waitFor({ state: 'visible', timeout: 10000 })));
    await waitFor(async () => {
      const profiles = await Promise.all(pairs.map(({ page }) => readProfile(page)));
      return profiles.every(profile => profile && profile.pid === pid && typeof profile.editable === 'boolean');
    }, 'both local profiles converge');

    for (const pair of pairs) {
      pair.ack = registrationFor(pair.gate, pair.registration.registrationId);
      pair.state = canonicalStateFor(pair.gate);
      pair.profile = await readProfile(pair.page);
      assert.equal(pair.ack.editable, pair.profile.editable,
        `${pair.label} local capability matches its own ACK`);
      assert.equal(pair.profile.pid, pid);
      assert.equal(pair.profile.playerId, pid);
      assert.equal(pair.profile.name, playerName);
      assert.equal(pair.profile.march, march);
      assert.equal(pair.state.room.players[pid].playerId, pid);
      assert.equal(pair.state.room.players[pid].name, playerName);
      assert.equal(pair.state.room.players[pid].march, march);
      assert.equal(await pair.page.locator('#youChip').isVisible(), true);
      assert.equal((await pair.page.locator('#youName').textContent()).trim(), `You · ${playerName}`);
      assert.equal(await pair.page.locator(`#roster .roster-row[data-pid="${pid}"]`).count(), 1,
        `${pair.label} UI binds its personal chip to the one canonical PID`);
    }

    const editablePairs = pairs.filter(pair => pair.profile.editable === true);
    const readOnlyPairs = pairs.filter(pair => pair.profile.editable === false);
    assert.equal(editablePairs.length, 1, 'exactly one racing device owns the profile capability');
    assert.equal(readOnlyPairs.length, 1, 'exactly one racing device is delivery-only');
    const owner = editablePairs[0];
    const readOnly = readOnlyPairs[0];
    assert.equal(owner.ack.created, true);
    assert.equal(readOnly.ack.created, false);
    assert.equal(owner.profile.profileKey, owner.registration.profileKey,
      'only the winning device persists its own profile capability');
    assert.match(owner.profile.profileKey, uuidV4);
    assert.equal(Object.hasOwn(readOnly.profile, 'profileKey'), false,
      'delivery-only localStorage never retains its rejected capability');

    await waitFor(() => pairs.every(({ gate }) => gate.client.some(message =>
      message.t === 'deviceStatus' && message.pid === pid && message.soundReady === true)),
    'both devices publish sound-ready delivery bindings');
    for (const pair of pairs) {
      pair.deviceStatus = pair.gate.client.find(message => message.t === 'deviceStatus' &&
        message.pid === pid && message.soundReady === true);
      assert.match(pair.deviceStatus.deviceId, uuidV4);
      await waitFor(() => pair.gate.server.some(message => message.t === 'deviceStatusSaved' &&
        message.pid === pid && message.deviceId === pair.deviceStatus.deviceId && message.soundReady === true),
      `${pair.label} deviceStatusSaved`);
    }
    assert.notEqual(pairs[0].deviceStatus.deviceId, pairs[1].deviceStatus.deviceId,
      'the same captain keeps an independent delivery device on each browser');

    assert.equal((await readOnly.page.locator('#editBtn').textContent()).trim(), 'Change player');
    assert.match(await readOnly.page.locator('#editBtn').getAttribute('title'), /receives alerts only/i);
    assert.equal(readOnly.gate.client.some(message => message.t === 'updateOwnProfile'), false);
    await readOnly.page.locator('#editBtn').click();
    await readOnly.page.locator('#fillCard').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(readOnly.gate.client.some(message => message.t === 'updateOwnProfile'), false,
      'Change player clears the delivery-only binding instead of opening a profile mutation');
    assert.equal(await readOnly.page.evaluate(key => localStorage.getItem(key), meKey), null,
      'Change player removes the read-only local profile before any new registration');
    assert.equal(await owner.page.locator(`#roster .roster-row[data-pid="${pid}"]`).count(), 1,
      'the delivery-only device cannot mutate the canonical player');

    assert.deepEqual(pageErrors, []);
    console.log(`✓ simultaneous multi-device registration converges safely (${room})`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(`QA room: ${room}`);
  console.error(error);
  process.exit(1);
});
