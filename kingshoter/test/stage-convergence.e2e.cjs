const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { makeQaRoom, qaRoomUrl, installQaWebSocketGuard, assertQaRoomName } = require('./support/qa-kvk.cjs');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const pid = '900000001';
const secondPid = '900000002';
const password = 'stage-convergence-password';
const profileKey = '40000000-0000-4000-8000-000000000001';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForValue(read, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function rawMessages(page, room, messages) {
  assertQaRoomName(room);
  await page.evaluate(({ roomName, payloads }) => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    const timer = setTimeout(() => reject(new Error('QA raw socket timeout')), 5000);
    socket.onopen = () => {
      payloads.forEach(payload => socket.send(JSON.stringify(payload)));
      setTimeout(() => { clearTimeout(timer); socket.close(); resolve(); }, 300);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('QA raw socket failed')); };
  }), { roomName: room, payloads: messages });
}

async function readRoom(page, room) {
  assertQaRoomName(room);
  return page.evaluate(roomName => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    const timer = setTimeout(() => reject(new Error('QA state timeout')), 5000);
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.t !== 'state') return;
      clearTimeout(timer); socket.close(); resolve(message.room);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('QA state socket failed')); };
  }), room);
}

async function openCommander(page, room) {
  await page.goto(qaRoomUrl(base, room, { notour: 1, lang: 'en' }));
  await page.locator('#soundGate').click();
  await rawMessages(page, room, [{
    t: 'registerPlayer', pid, name: 'Convergence Captain', march: 40,
    identityMode: 'playerId', profileKey
  }]);
  await page.locator('#cmdUnlock').click();
  await page.locator('#pwInput').fill(password);
  await page.locator('#pwGo').click();
  await page.locator('#console').waitFor({ state: 'visible' });
  await page.locator(`#roster .rp[data-pid="${pid}"]`).waitFor();
}

async function overlapCase(browser) {
  const room = makeQaRoom('stage-overlap');
  const context = await browser.newContext({ locale: 'en-US' });
  let hideK2 = false;
  try {
    await installQaWebSocketGuard(context, room, {
      shouldDropServerMessage({ data }) {
        if (!hideK2) return false;
        try {
          const message = JSON.parse(String(data));
          const staged = message.t === 'state' && message.room && message.room.live && message.room.live.staged && message.room.live.staged['2'];
          return !!(staged && staged.pairs && staged.pairs.some(pair => pair.pid === pid));
        } catch (_) { return false; }
      }
    });
    const page = await context.newPage();
    await openCommander(page, room);
    hideK2 = true;
    await rawMessages(page, room, [{ t: 'stage', password, staged: { kingdom: 2, pairs: [{ pid, role: 'weak' }] } }]);
    await page.evaluate(playerPid => {
      document.querySelector(`#roster .rp[data-pid="${playerPid}"]`).click();
      document.querySelector(`#roster .rp[data-pid="${playerPid}"]`).click();
    }, pid);
    await page.waitForTimeout(800);
    hideK2 = false;
    const server = await readRoom(page, room);
    assert.equal(await page.locator(`#roster .rp[data-pid="${pid}"]`).getAttribute('aria-pressed'), 'false');
    assert.equal(server.live.staged['1'], null);
    console.log(`✓ overlapping stages converge (${room})`);
  } finally { await context.close(); }
}

async function reconnectCase(browser) {
  const room = makeQaRoom('stage-reconnect');
  const context = await browser.newContext({ locale: 'en-US' });
  let dropFirstStage = true;
  try {
    await installQaWebSocketGuard(context, room, {
      shouldDropClientMessage({ data }) {
        try {
          const message = JSON.parse(String(data));
          if (dropFirstStage && message.t === 'stage') { dropFirstStage = false; return true; }
        } catch (_) {}
        return false;
      }
    });
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.__qaStageSockets = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) { super(...args); window.__qaStageSockets.push(this); }
      };
    });
    const page = await context.newPage();
    await openCommander(page, room);
    await page.locator(`#roster .rp[data-pid="${pid}"]`).click();
    await page.evaluate(() => window.__qaStageSockets[0].close());
    await page.waitForFunction(() => window.__qaStageSockets.length >= 2 && window.__qaStageSockets.at(-1).readyState === 1);
    await page.waitForTimeout(500);
    const server = await readRoom(page, room);
    assert.equal(await page.locator(`#roster .rp[data-pid="${pid}"]`).getAttribute('aria-pressed'), 'false');
    assert.equal(server.live.staged['1'], null);
    assert.equal(server.live.staged['2'], null);
    console.log(`✓ reconnect snapshot converges (${room})`);
  } finally { await context.close(); }
}

async function newerIntentAfterRejectionCase(browser) {
  const room = makeQaRoom('stage-newer-intent');
  const context = await browser.newContext({ locale: 'en-US' });
  let hideRemoteStage = false;
  const heldErrors = [];
  try {
    await installQaWebSocketGuard(context, room, {
      shouldDropServerMessage({ data }) {
        try {
          const message = JSON.parse(String(data));
          if (message.t === 'error' && message.error === 'player_staged_other_kingdom') {
            heldErrors.push(String(data));
            return true;
          }
          const remote = message.t === 'state' && message.room && message.room.live && message.room.live.staged && message.room.live.staged['2'];
          return !!(hideRemoteStage && remote && remote.pairs && remote.pairs.some(pair => pair.pid === pid));
        } catch (_) { return false; }
      }
    });
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.__qaStageIntentSockets = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) { super(...args); window.__qaStageIntentSockets.push(this); }
      };
    });
    const page = await context.newPage();
    await openCommander(page, room);
    await rawMessages(page, room, [{
      t: 'registerPlayer', pid: secondPid, name: 'Newer Captain', march: 41,
      identityMode: 'playerId', profileKey
    }]);
    await page.locator(`#roster .rp[data-pid="${secondPid}"]`).waitFor();

    hideRemoteStage = true;
    await rawMessages(page, room, [{ t: 'stage', password, staged: { kingdom: 2, pairs: [{ pid, role: 'weak' }] } }]);
    await page.locator(`#roster .rp[data-pid="${pid}"]`).click();
    await waitForValue(() => heldErrors.length, 'held older stage rejection');
    await page.locator(`#roster .rp[data-pid="${pid}"]`).click();
    await page.locator(`#roster .rp[data-pid="${secondPid}"]`).click();
    assert.ok(heldErrors.length, 'older stage rejection is held while newer intent queues');

    hideRemoteStage = false;
    await page.evaluate(packet => {
      const socket = window.__qaStageIntentSockets.filter(candidate => candidate.readyState === WebSocket.OPEN).at(-1);
      if (!socket || typeof socket.onmessage !== 'function') throw new Error('No current stage socket');
      socket.onmessage({ data: packet });
    }, heldErrors.shift());
    await page.waitForFunction(playerPid => document.querySelector(`#roster .rp[data-pid="${playerPid}"]`)?.getAttribute('aria-pressed') === 'true', secondPid);
    const server = await readRoom(page, room);
    assert.deepEqual(server.live.staged['1'].pairs.map(pair => pair.pid), [secondPid]);
    assert.deepEqual(server.live.staged['2'].pairs.map(pair => pair.pid), [pid]);
    console.log(`✓ rejected older stage preserves newer intent (${room})`);
  } finally { await context.close(); }
}

async function registrationCollisionCase(browser) {
  const room = makeQaRoom('stage-registration-collision');
  const context = await browser.newContext({ locale: 'en-US' });
  const selfPid = '900000099';
  let heldRemovalState = false;
  let selfRegistrations = 0;
  try {
    await installQaWebSocketGuard(context, room, {
      shouldDropClientMessage({ data }) {
        try {
          const message = JSON.parse(String(data));
          if (message.t === 'registerPlayer' && message.pid === selfPid) {
            selfRegistrations += 1;
            return true;
          }
        } catch (_) {}
        return false;
      },
      shouldDropServerMessage({ data }) {
        if (!heldRemovalState) return false;
        try {
          const message = JSON.parse(String(data));
          return message.t === 'state' && message.room && !message.room.players[pid];
        } catch (_) { return false; }
      }
    });
    const page = await context.newPage();
    await openCommander(page, room);
    await page.locator('#pid').fill(selfPid);
    await page.locator('#marchRange').fill('40');
    await page.locator('#saveBtn').click();
    await waitForValue(() => selfRegistrations, 'explicit registration at the transport gate');
    assert.equal(selfRegistrations, 1, 'explicit registration is pending at the transport gate');

    heldRemovalState = true;
    await rawMessages(page, room, [{ t: 'removePlayer', password, pid }]);
    await page.locator(`#roster .rp[data-pid="${pid}"]`).click();
    await page.waitForFunction(playerPid => document.querySelector(`#roster .rp[data-pid="${playerPid}"]`)?.getAttribute('aria-pressed') === 'false', pid, { timeout: 5000 });

    await page.waitForTimeout(100);
    assert.equal(await page.locator('#saveBtn').isDisabled(), true,
      'an unscoped stage error leaves the explicit registration pending');
    assert.equal(selfRegistrations, 1, 'unscoped stage player_missing does not consume registration state');
    heldRemovalState = false;
    const server = await readRoom(page, room);
    assert.equal(server.live.staged['1'], null);
    console.log(`✓ stage and registration errors stay scoped (${room})`);
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try { await overlapCase(browser); await reconnectCase(browser); await newerIntentAfterRejectionCase(browser); await registrationCollisionCase(browser); }
  finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
