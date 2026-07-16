const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-kvk.cjs');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const room = makeQaRoom('identity-input');
const url = qaRoomUrl(base, room, { notour: 1 });
const meKey = `kingshoter_r_${room}_me`;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out: ${message}`);
}

async function enableSound(page) {
  await page.locator('#soundGate').click();
  await page.locator('#roomView.presound').waitFor({ state: 'detached', timeout: 5000 }).catch(async () => {
    assert.equal(await page.locator('#roomView').evaluate(element => element.classList.contains('presound')), false);
  });
}

async function setMarch(page, seconds) {
  await page.locator('#marchRange').fill(String(seconds));
  assert.equal(await page.locator('#marchRange').inputValue(), String(seconds));
}

async function selectNickname(page) {
  await page.locator('#identityNickname').click();
  assert.equal(await page.locator('#identityNickname').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#identityPlayerId').getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#pid').getAttribute('inputmode'), 'text');
  assert.match(await page.locator('#identityLabel').textContent(), /Nickname/i);
}

async function readProfile(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), meKey);
}

async function broadcastDeviceStatus(page, pid) {
  await page.evaluate(({ roomName, playerId }) => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    const timer = setTimeout(() => reject(new Error('pending registration broadcast timeout')), 5000);
    socket.onopen = () => socket.send(JSON.stringify({
      t: 'deviceStatus', pid: playerId,
      deviceId: '40000000-0000-4000-8000-000000000004', soundReady: false
    }));
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.t !== 'deviceStatusSaved') return;
      clearTimeout(timer); socket.close(); resolve();
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('pending registration broadcast failed')); };
  }), { roomName: room, playerId: pid });
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const raceContext = await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US' });
  const retryContext = await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US' });
  const abortContext = await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US' });
  const pendingContext = await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US' });
  const pageErrors = [];
  const raceLookups = [];
  const raceRegistrations = [];
  const raceProfileUpdates = [];
  const retryRegistrations = [];
  const retryProfileUpdates = [];
  const abortLookups = [];
  const pendingRegistrations = [];
  let retryLookupCount = 0;
  let holdPendingCanonical = true;
  let pendingCanonicalDrops = 0;
  let dropNextRetryProfileUpdate = false;
  let dropNextRetryProfileAck = false;
  let droppedRetryProfileAck = null;
  let dropNextRetryRegistrationAck = false;
  let droppedRetryRegistrationAck = null;

  try {
    await Promise.all([
      installQaWebSocketGuard(raceContext, room, {
        shouldDropClientMessage({ data }) {
          const message = JSON.parse(String(data));
          if (message.t === 'registerPlayer') raceRegistrations.push(message);
          if (message.t === 'updateOwnProfile') raceProfileUpdates.push(message);
          return false;
        }
      }),
      installQaWebSocketGuard(retryContext, room, {
        shouldDropClientMessage({ data }) {
          const message = JSON.parse(String(data));
          if (message.t === 'registerPlayer') retryRegistrations.push(message);
          if (message.t === 'updateOwnProfile') {
            retryProfileUpdates.push(message);
            if (dropNextRetryProfileUpdate) {
              dropNextRetryProfileUpdate = false;
              return true;
            }
          }
          return false;
        },
        shouldDropServerMessage({ data }) {
          const message = JSON.parse(String(data));
          if (dropNextRetryRegistrationAck && message.t === 'playerRegistered') {
            dropNextRetryRegistrationAck = false;
            droppedRetryRegistrationAck = message;
            return true;
          }
          if (dropNextRetryProfileAck && message.t === 'playerProfileSaved') {
            dropNextRetryProfileAck = false;
            droppedRetryProfileAck = message;
            return true;
          }
          return false;
        }
      }),
      installQaWebSocketGuard(abortContext, room),
      installQaWebSocketGuard(pendingContext, room, {
        shouldDropClientMessage({ data }) {
          const message = JSON.parse(String(data));
          if (message.t === 'registerPlayer') pendingRegistrations.push(message);
          return false;
        },
        shouldDropServerMessage({ data }) {
          if (!holdPendingCanonical) return false;
          try {
            const message = JSON.parse(String(data));
            const players = message.t === 'state' && message.room && message.room.players;
            if (players && Object.values(players).some(player => player && player.name === 'Pending Draft')) {
              pendingCanonicalDrops += 1;
              return true;
            }
          } catch (_) {}
          return false;
        }
      })
    ]);

    await raceContext.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      const NativeWebSocket = window.WebSocket;
      window.__qaRaceSockets = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__qaRaceSockets.push(this);
        }
        send(data) {
          const message = JSON.parse(String(data));
          if (message.t === 'registerPlayer' && !window.__qaFailedPlayerRegistration) {
            window.__qaFailedPlayerRegistration = message;
            throw new Error('QA forced Player ID registration disconnect');
          }
          return super.send(data);
        }
      };
      window.fetch = (input, init) => {
        const requestUrl = typeof input === 'string' ? input : input && input.url;
        if (!String(requestUrl || '').includes('/api/lookup')) return nativeFetch(input, init);
        const lookupInit = Object.assign({}, init || {});
        delete lookupInit.signal;
        return nativeFetch(input, lookupInit);
      };
    });
    await retryContext.addInitScript(() => {
      Object.defineProperty(window, 'RoomSocket', {
        configurable: true,
        set(RoomSocketClass) {
          class ExposedRoomSocket extends RoomSocketClass {
            constructor(...args) {
              super(...args);
              window.__qaRoomSocket = this;
            }
          }
          Object.defineProperty(window, 'RoomSocket', {
            configurable: true,
            writable: true,
            value: ExposedRoomSocket
          });
        }
      });
      const NativeWebSocket = window.WebSocket;
      window.__qaRoomSockets = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__qaRoomSockets.push(this);
        }
        send(data) {
          const message = JSON.parse(String(data));
          if (message.t === 'registerPlayer' && !window.__qaFailedRegistration) {
            window.__qaFailedRegistration = message;
            throw new Error('QA forced disconnected send');
          }
          return super.send(data);
        }
      };
    });
    await abortContext.addInitScript(() => {
      const NativeAbortController = window.AbortController;
      window.__identityAbortCount = 0;
      window.AbortController = class extends NativeAbortController {
        abort(reason) {
          window.__identityAbortCount += 1;
          return super.abort(reason);
        }
      };
    });

    await raceContext.route('**/api/lookup?*', async route => {
      const fid = new URL(route.request().url()).searchParams.get('fid');
      await new Promise(resolve => {
        raceLookups.push({
          fid,
          async reply(body) {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(body)
            });
            resolve();
          }
        });
      });
    });
    retryContext.on('request', request => {
      if (new URL(request.url()).pathname === '/api/lookup') retryLookupCount += 1;
    });
    await retryContext.route('**/api/lookup?*', async route => {
      const fid = new URL(route.request().url()).searchParams.get('fid');
      const nickname = fid === '900000777' ? 'Converted Player' :
        fid === '900000888' ? 'Reconciled Player' :
        fid === '222222' ? 'Current Player' : `Player ${fid}`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, fid, nickname })
      });
    });
    await abortContext.route('**/api/lookup?*', async route => {
      const fid = new URL(route.request().url()).searchParams.get('fid');
      abortLookups.push(fid);
      if (fid === '333333') {
        await delay(1200);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, fid, nickname: 'Stale Abort Name' })
        }).catch(() => {});
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, fid, nickname: 'Current Abort Name' })
      });
    });

    const racePage = await raceContext.newPage();
    const retryPage = await retryContext.newPage();
    const abortPage = await abortContext.newPage();
    const pendingPage = await pendingContext.newPage();
    for (const [name, page] of [['race', racePage], ['retry', retryPage], ['abort', abortPage], ['pending', pendingPage]]) {
      page.on('pageerror', error => pageErrors.push(`${name}: ${error.message}`));
    }
    await Promise.all([racePage.goto(url), retryPage.goto(url), abortPage.goto(url), pendingPage.goto(url)]);
    await Promise.all([enableSound(racePage), enableSound(retryPage), enableSound(abortPage), enableSound(pendingPage)]);

    assert.equal(await racePage.locator('link[href="app.css?v=2026071601"]').count(), 1, 'the identity CSS cache version is exact');
    assert.equal(await racePage.locator('script[src="/app.js?v=2026071601"]').count(), 1, 'the shared socket cache version is exact');
    assert.equal(await racePage.locator('script[src="/kvk.js?v=2026071601"]').count(), 1, 'the identity script cache version is exact');
    assert.equal(await racePage.locator('#identityMode').getAttribute('role'), 'radiogroup');
    assert.match(await racePage.locator('#identityMode').getAttribute('aria-label'), /Identity/i);
    assert.equal(await racePage.locator('#identityPlayerId').getAttribute('role'), 'radio');
    assert.equal(await racePage.locator('#identityPlayerId').getAttribute('aria-checked'), 'true');
    assert.equal(await racePage.locator('#identityPlayerId').getAttribute('tabindex'), '0');
    assert.equal(await racePage.locator('#identityNickname').getAttribute('tabindex'), '-1');
    assert.equal(await racePage.locator('#pid').getAttribute('inputmode'), 'numeric');
    assert.equal(await racePage.locator('#identityLabel').getAttribute('for'), 'pid');
    assert.equal(await racePage.locator('#nameOut').getAttribute('role'), 'status');
    assert.equal(await racePage.locator('#nameOut').getAttribute('aria-live'), 'polite');
    assert.doesNotMatch(await racePage.locator('#identityNickname').textContent(), /For testing|测试用/i);

    const playerRadio = racePage.locator('#identityPlayerId');
    const nicknameRadio = racePage.locator('#identityNickname');
    await playerRadio.focus();
    await playerRadio.press('ArrowRight');
    assert.equal(await nicknameRadio.getAttribute('aria-checked'), 'true');
    assert.equal(await racePage.evaluate(() => document.activeElement && document.activeElement.id), 'identityNickname');
    await nicknameRadio.press('Home');
    assert.equal(await playerRadio.getAttribute('aria-checked'), 'true');
    assert.equal(await racePage.evaluate(() => document.activeElement && document.activeElement.id), 'identityPlayerId');
    await playerRadio.press('End');
    assert.equal(await nicknameRadio.getAttribute('aria-checked'), 'true');
    await nicknameRadio.press('ArrowUp');
    assert.equal(await playerRadio.getAttribute('aria-checked'), 'true');

    for (const modeId of ['identityPlayerId', 'identityNickname']) {
      await racePage.locator(`#${modeId}`).click();
      assert.doesNotMatch(await racePage.locator('#pid').getAttribute('placeholder'), /For testing|测试用/i);
      const mobile = await racePage.evaluate(() => ({
        documentScroll: document.documentElement.scrollWidth,
        documentClient: document.documentElement.clientWidth,
        cardScroll: document.querySelector('#fillCard').scrollWidth,
        cardClient: document.querySelector('#fillCard').clientWidth,
        playerHeight: document.querySelector('#identityPlayerId').getBoundingClientRect().height,
        nicknameHeight: document.querySelector('#identityNickname').getBoundingClientRect().height
      }));
      assert.ok(mobile.documentScroll <= mobile.documentClient, `${modeId} does not create page overflow at 375px`);
      assert.ok(mobile.cardScroll <= mobile.cardClient, `${modeId} does not overflow the identity card at 375px`);
      assert.ok(mobile.playerHeight >= 44 && mobile.nicknameHeight >= 44, 'both identity options have 44px touch targets');
    }

    await selectNickname(pendingPage);
    await pendingPage.locator('#pid').fill('Pending Draft');
    await setMarch(pendingPage, 43);
    await pendingPage.locator('#saveBtn').click();
    await waitFor(() => pendingRegistrations.length === 1 && pendingCanonicalDrops > 0,
      'canonical state held while a new registration is pending');
    assert.equal(await pendingPage.locator('#identityPlayerId').isDisabled(), true,
      'pending registration locks Player ID mode before canonical confirmation');
    assert.equal(await pendingPage.locator('#identityNickname').isDisabled(), true,
      'pending registration locks Nickname mode before canonical confirmation');
    assert.equal(await pendingPage.locator('#pid').getAttribute('readonly'), '',
      'pending registration protects the submitted identity draft from later overwrite');
    assert.equal(await pendingPage.locator('#saveBtn').isDisabled(), true,
      'pending registration disables duplicate Save attempts');
    holdPendingCanonical = false;
    await broadcastDeviceStatus(pendingPage, pendingRegistrations[0].pid);
    await pendingPage.locator('#youChip').waitFor({ state: 'visible', timeout: 8000 });
    const pendingProfile = await readProfile(pendingPage);
    assert.equal(pendingProfile.name, 'Pending Draft');
    assert.equal(pendingProfile.profileKey, pendingRegistrations[0].profileKey);

    await playerRadio.click();
    await racePage.locator('#pid').fill('111111');
    await waitFor(() => raceLookups.length === 1, 'first delayed Player ID lookup');
    await racePage.locator('#pid').fill('222222');
    await waitFor(() => raceLookups.length === 2, 'second delayed Player ID lookup');
    const staleLookup = raceLookups.find(entry => entry.fid === '111111');
    const currentLookup = raceLookups.find(entry => entry.fid === '222222');
    assert.ok(staleLookup && currentLookup, 'both exact numeric drafts reached lookup');
    await currentLookup.reply({ ok: true, fid: '222222', nickname: 'Current Player' });
    await racePage.locator('#nameOut').filter({ hasText: 'Current Player' }).waitFor({ state: 'visible' });
    await staleLookup.reply({ ok: true, fid: '111111', nickname: 'Stale Player' });
    await delay(100);
    assert.match(await racePage.locator('#nameOut').textContent(), /Current Player/);
    assert.doesNotMatch(await racePage.locator('#nameOut').textContent(), /Stale Player/);
    await selectNickname(racePage);
    assert.equal(await racePage.locator('#pid').inputValue(), '');
    assert.equal(await racePage.locator('#nameOut').textContent(), '');
    assert.equal(await racePage.locator('#nameOut').getAttribute('data-name'), '');
    assert.doesNotMatch(await racePage.locator('#pid').getAttribute('placeholder'), /For testing|测试用/i);
    await racePage.locator('#pid').fill('Race Draft');
    await playerRadio.click();
    assert.equal(await racePage.locator('#pid').inputValue(), '222222', 'new-player Player ID draft survives a mode switch');
    await waitFor(() => raceLookups.length === 3, 'restored Player ID lookup before cross-mode stale reply');
    const crossModeLookup = raceLookups[2];
    await selectNickname(racePage);
    assert.equal(await racePage.locator('#pid').inputValue(), 'Race Draft', 'new-player nickname draft survives a mode switch');
    await crossModeLookup.reply({ ok: true, fid: '222222', nickname: 'Cross Mode Stale' });
    await delay(100);
    assert.equal(await racePage.locator('#pid').inputValue(), 'Race Draft');
    assert.equal(await racePage.locator('#nameOut').textContent(), '');
    assert.equal(await racePage.locator('#nameOut').getAttribute('data-name'), '');
    await playerRadio.click();
    assert.equal(await racePage.locator('#pid').inputValue(), '222222');
    await waitFor(() => raceLookups.length === 4, 'restored Player ID lookup after returning from nickname mode');
    await raceLookups[3].reply({ ok: true, fid: '222222', nickname: 'Current Player' });
    await racePage.locator('#nameOut').filter({ hasText: 'Current Player' }).waitFor({ state: 'visible' });

    await abortPage.locator('#pid').fill('333333');
    await waitFor(() => abortLookups.includes('333333'), 'normal lookup request before abort');
    await abortPage.locator('#pid').fill('444444');
    await waitFor(() => abortLookups.includes('444444'), 'replacement lookup request');
    await abortPage.locator('#nameOut').filter({ hasText: 'Current Abort Name' }).waitFor({ state: 'visible' });
    assert.ok(await abortPage.evaluate(() => window.__identityAbortCount >= 1), 'the prior native lookup controller is aborted');
    await delay(1300);
    assert.match(await abortPage.locator('#nameOut').textContent(), /Current Abort Name/);
    assert.doesNotMatch(await abortPage.locator('#nameOut').textContent(), /not found|lookup failed|Stale Abort Name/i);

    await setMarch(racePage, 44);
    await racePage.locator('#saveBtn').click();
    await racePage.waitForFunction(() => !!window.__qaFailedPlayerRegistration);
    const failedPlayerRegistration = await racePage.evaluate(() => window.__qaFailedPlayerRegistration);
    assert.equal(raceRegistrations.length, 0, 'the forced false-send never reached the room socket');
    assert.equal(failedPlayerRegistration.pid, '222222');
    assert.equal(failedPlayerRegistration.playerId, '222222', 'new Player ID registration is explicit');
    assert.equal(failedPlayerRegistration.name, 'Current Player');
    assert.equal(failedPlayerRegistration.march, 44);
    assert.equal(failedPlayerRegistration.identityMode, 'playerId');
    assert.match(failedPlayerRegistration.profileKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'a new player registration carries a private edit capability');
    assert.equal(await readProfile(racePage), null, 'only canonical room state persists a Player ID profile');
    await racePage.evaluate(() => window.__qaRaceSockets.at(-1).close(4000, 'QA Player ID reconnect'));
    await waitFor(() => raceRegistrations.length >= 1, 'false-send Player ID profile resend after reconnect', 12000);
    assert.equal(raceRegistrations[0].pid, failedPlayerRegistration.pid);
    assert.equal(raceRegistrations[0].playerId, failedPlayerRegistration.playerId, 'reconnect keeps the explicit Player ID');
    assert.equal(raceRegistrations[0].name, failedPlayerRegistration.name);
    assert.equal(raceRegistrations[0].march, failedPlayerRegistration.march);
    assert.equal(raceRegistrations[0].profileKey, failedPlayerRegistration.profileKey,
      'a disconnected registration retry keeps the same edit capability');
    await racePage.locator('#youChip').waitFor({ state: 'visible', timeout: 8000 });
    const raceProfile = await readProfile(racePage);
    assert.equal(raceProfile.pid, '222222');
    assert.equal(raceProfile.playerId, '222222');
    assert.equal(raceProfile.identityMode, 'playerId');
    assert.equal(raceProfile.profileKey, failedPlayerRegistration.profileKey,
      'the private edit capability is retained only in the local profile');

    await selectNickname(retryPage);
    await retryPage.locator('#pid').fill('  Tester  ');
    await setMarch(retryPage, 45);
    await retryPage.locator('#saveBtn').click();
    await retryPage.waitForFunction(() => !!window.__qaFailedRegistration);
    const failedRegistration = await retryPage.evaluate(() => window.__qaFailedRegistration);
    assert.equal(retryRegistrations.length, 0, 'the forced false-send never reached the room socket');
    assert.match(failedRegistration.pid, /^n_[0-9a-f]{22}$/);
    assert.equal(failedRegistration.name, 'Tester');
    assert.equal(failedRegistration.march, 45);
    assert.equal(failedRegistration.identityMode, 'nickname');
    assert.match(failedRegistration.profileKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(await readProfile(retryPage), null, 'only canonical room state persists a nickname profile');
    dropNextRetryRegistrationAck = true;
    await retryPage.evaluate(() => window.__qaRoomSockets.at(-1).close(4000, 'QA reconnect'));
    await waitFor(() => retryRegistrations.length >= 1, 'false-send nickname profile resend after reconnect', 12000);
    assert.equal(retryRegistrations[0].pid, failedRegistration.pid, 'reconnect reuses the exact transient nickname routing key');
    assert.equal(retryRegistrations[0].name, failedRegistration.name);
    assert.equal(retryRegistrations[0].march, failedRegistration.march);
    assert.equal(retryRegistrations[0].profileKey, failedRegistration.profileKey);
    assert.equal(retryRegistrations[0].registrationId, failedRegistration.registrationId,
      'registration retry keeps the exact ACK correlation id');
    await waitFor(() => droppedRetryRegistrationAck, 'persisted registration with dropped ACK');
    assert.equal(await readProfile(retryPage), null, 'canonical state without the private ACK cannot claim edit ownership');
    await retryPage.evaluate(() => window.__qaRoomSockets.at(-1).close(4000, 'QA registration ACK retry'));
    await waitFor(() => retryRegistrations.length >= 2, 'existing-player registration ACK retry', 12000);
    assert.equal(retryRegistrations[1].registrationId, failedRegistration.registrationId,
      'ACK-loss reconnect reuses the pending registration attempt');
    assert.equal(retryRegistrations[1].profileKey, failedRegistration.profileKey,
      'ACK-loss reconnect reuses the private edit capability');
    await retryPage.locator('#youChip').waitFor({ state: 'visible', timeout: 8000 });

    const abortLookupBaseline = abortLookups.length;
    await selectNickname(abortPage);
    await abortPage.locator('#pid').fill('Tester');
    await setMarch(abortPage, 46);
    await abortPage.locator('#saveBtn').click();
    await abortPage.locator('#youChip').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(abortLookups.length, abortLookupBaseline, 'nickname Save does not request /api/lookup');
    assert.equal(retryLookupCount, 0, 'nickname retry and reconnect never request /api/lookup');

    const retryProfile = await readProfile(retryPage);
    const abortProfile = await readProfile(abortPage);
    assert.equal(retryProfile.identityMode, 'nickname');
    assert.equal(abortProfile.identityMode, 'nickname');
    assert.equal(retryProfile.profileKey, failedRegistration.profileKey);
    assert.match(abortProfile.profileKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(retryProfile.name, 'Tester');
    assert.equal(abortProfile.name, 'Tester');
    assert.match(retryProfile.pid, /^n_[0-9a-f]{22}$/);
    assert.match(abortProfile.pid, /^n_[0-9a-f]{22}$/);
    assert.notEqual(retryProfile.pid, abortProfile.pid, 'equal nicknames receive separate opaque routing keys');
    await retryPage.waitForFunction(({ first, second }) => {
      return !!document.querySelector(`#roster .rp[data-pid="${first}"]`) &&
        !!document.querySelector(`#roster .rp[data-pid="${second}"]`);
    }, { first: retryProfile.pid, second: abortProfile.pid }, { timeout: 8000 });

    await retryPage.locator('#editBtn').click();
    assert.equal(await retryPage.locator('#identityPlayerId').isDisabled(), false);
    assert.equal(await retryPage.locator('#identityNickname').isDisabled(), false);
    assert.equal(await retryPage.locator('#pid').getAttribute('readonly'), null);
    assert.equal(await retryPage.locator('#pid').inputValue(), 'Tester', 'existing nickname edit shows the display name, not its opaque pid');
    assert.match(await retryPage.locator('#identityLabel').textContent(), /Nickname/i);
    assert.doesNotMatch(await retryPage.locator('body').textContent(), new RegExp(retryProfile.pid), 'opaque nickname routing pid is never visible');
    await retryPage.locator('#identityPlayerId').click();
    await retryPage.locator('#pid').fill('900000777');
    await retryPage.locator('#identityNickname').click();
    await retryPage.locator('#pid').fill('Tester Two');
    await retryPage.locator('#identityPlayerId').click();
    assert.equal(await retryPage.locator('#pid').inputValue(), '900000777');
    await retryPage.locator('#identityNickname').click();
    assert.equal(await retryPage.locator('#pid').inputValue(), 'Tester Two');

    const oldRetryRoster = retryPage.locator(`#roster .roster-row[data-pid="${retryProfile.pid}"]`);
    await retryPage.locator('#identityPlayerId').click();
    await retryPage.locator('#pid').fill(raceProfile.playerId);
    await retryPage.locator('#nameOut').filter({ hasText: 'Current Player' }).waitFor({ state: 'visible' });
    await setMarch(retryPage, 47);
    const conflictUpdateCount = retryProfileUpdates.length;
    await retryPage.locator('#saveBtn').click();
    await waitFor(() => retryProfileUpdates.length === conflictUpdateCount + 1, 'duplicate Player ID profile update');
    await retryPage.waitForFunction(() => !document.querySelector('#identityPlayerId').disabled);
    assert.deepEqual(await readProfile(retryPage), retryProfile, 'Player ID conflict keeps the old canonical local profile');
    assert.equal(await retryPage.locator('#pid').inputValue(), raceProfile.playerId, 'conflicting Player ID draft remains available');
    assert.equal(await oldRetryRoster.locator('.roster-name').textContent(), 'Tester');
    assert.match(await oldRetryRoster.locator('.roster-time').textContent(), /0:45/);

    await retryPage.locator('#pid').fill('900000777');
    await retryPage.locator('#nameOut').filter({ hasText: 'Converted Player' }).waitFor({ state: 'visible' });
    dropNextRetryProfileUpdate = true;
    const droppedUpdateCount = retryProfileUpdates.length;
    await retryPage.locator('#saveBtn').click();
    await waitFor(() => retryProfileUpdates.length === droppedUpdateCount + 1, 'dropped profile update');
    const droppedUpdate = retryProfileUpdates.at(-1);
    assert.equal(droppedUpdate.t, 'updateOwnProfile');
    assert.equal(droppedUpdate.pid, retryProfile.pid, 'profile update keeps the immutable routing pid');
    assert.equal(droppedUpdate.identityMode, 'playerId');
    assert.equal(droppedUpdate.playerId, '900000777');
    assert.equal(droppedUpdate.name, 'Converted Player');
    assert.equal(droppedUpdate.march, 47);
    assert.equal(droppedUpdate.baseRevision, retryProfile.marchRevision);
    assert.equal(droppedUpdate.profileKey, retryProfile.profileKey,
      'profile edits prove ownership independently of the public audio device binding');
    assert.equal(await retryPage.locator('#identityPlayerId').isDisabled(), true, 'pending profile save locks identity mode');
    assert.equal(await retryPage.locator('#identityNickname').isDisabled(), true);
    assert.equal(await retryPage.locator('#saveBtn').isDisabled(), true, 'pending profile save disables Save');
    assert.equal(await retryPage.locator('#pid').getAttribute('readonly'), '');
    assert.deepEqual(await readProfile(retryPage), retryProfile, 'a pending save does not optimistically persist identity');
    assert.equal(await oldRetryRoster.locator('.roster-name').textContent(), 'Tester', 'pending save keeps the old roster identity');
    assert.match(await oldRetryRoster.locator('.roster-time').textContent(), /0:45/);

    await retryPage.evaluate(() => window.__qaRoomSockets.at(-1).close(4000, 'QA profile update disconnect'));
    await retryPage.waitForFunction(() => !document.querySelector('#identityPlayerId').disabled, null, { timeout: 12000 });
    assert.deepEqual(await readProfile(retryPage), retryProfile, 'disconnect keeps the old canonical local profile');
    await retryPage.waitForFunction(() => {
      const socket = window.__qaRoomSockets.at(-1);
      return socket && socket.readyState === 1 && document.querySelector('#netlab').textContent !== 'Connecting…';
    }, null, { timeout: 12000 });
    assert.equal(await retryPage.locator('#pid').inputValue(), '900000777');
    assert.equal(await retryPage.locator('#nameOut').getAttribute('data-name'), 'Converted Player', 'direct retry preserves the resolved Player ID name');

    const successUpdateCount = retryProfileUpdates.length;
    await retryPage.locator('#saveBtn').click();
    await waitFor(() => retryProfileUpdates.length === successUpdateCount + 1, 'retried profile update');
    await retryPage.locator('#youChip').waitFor({ state: 'visible', timeout: 8000 });
    const editedRetryProfile = await readProfile(retryPage);
    assert.equal(editedRetryProfile.pid, retryProfile.pid, 'nickname to Player ID keeps the routing pid');
    assert.equal(editedRetryProfile.identityMode, 'playerId');
    assert.equal(editedRetryProfile.playerId, '900000777');
    assert.equal(editedRetryProfile.name, 'Converted Player');
    assert.equal(editedRetryProfile.march, 47);
    assert.equal(editedRetryProfile.marchRevision, retryProfile.marchRevision + 1);
    const remoteRetryRoster = abortPage.locator(`#roster .roster-row[data-pid="${retryProfile.pid}"]`);
    await abortPage.waitForFunction(({ pid, name }) => {
      const row = document.querySelector(`#roster .roster-row[data-pid="${pid}"]`);
      return row && row.querySelector('.roster-name').textContent === name;
    }, { pid: retryProfile.pid, name: 'Converted Player' }, { timeout: 8000 });
    assert.equal(await remoteRetryRoster.locator('.roster-name').textContent(), 'Converted Player');
    assert.match(await remoteRetryRoster.locator('.roster-time').textContent(), /0:47/);

    await retryPage.locator('#editBtn').click();
    await retryPage.locator('#pid').fill('900000999');
    await retryPage.locator('#nameOut').filter({ hasText: 'Player 900000999' }).waitFor({ state: 'visible' });
    await setMarch(retryPage, 48);
    dropNextRetryProfileUpdate = true;
    const refreshMissUpdateCount = retryProfileUpdates.length;
    await retryPage.locator('#saveBtn').click();
    await waitFor(() => retryProfileUpdates.length === refreshMissUpdateCount + 1, 'refresh-miss profile update');
    assert.equal(await retryPage.evaluate(() => window.__qaRoomSocket.refresh()), true, 'test exercises RoomSocket.refresh');
    await retryPage.waitForFunction(() => !document.querySelector('#saveBtn').disabled, null, { timeout: 12000 });
    assert.deepEqual(await readProfile(retryPage), editedRetryProfile, 'mismatching fresh state unlocks the original canonical profile');
    assert.equal(await retryPage.locator('#nameOut').getAttribute('data-name'), 'Player 900000999', 'refresh mismatch preserves the resolved retry name');

    await retryPage.locator('#pid').fill('900000888');
    await retryPage.locator('#nameOut').filter({ hasText: 'Reconciled Player' }).waitFor({ state: 'visible' });
    await setMarch(retryPage, 49);
    dropNextRetryProfileAck = true;
    droppedRetryProfileAck = null;
    const ackLostUpdateCount = retryProfileUpdates.length;
    await retryPage.locator('#saveBtn').click();
    await waitFor(() => droppedRetryProfileAck, 'server-applied profile update with dropped ACK');
    assert.equal(retryProfileUpdates.length, ackLostUpdateCount + 1);
    assert.equal(droppedRetryProfileAck.playerId, '900000888');
    await abortPage.waitForFunction(({ pid, name }) => {
      const row = document.querySelector(`#roster .roster-row[data-pid="${pid}"]`);
      return row && row.querySelector('.roster-name').textContent === name;
    }, { pid: retryProfile.pid, name: 'Reconciled Player' }, { timeout: 8000 });
    assert.deepEqual(await readProfile(retryPage), editedRetryProfile, 'a matching state alone does not settle before reconnect reconciliation');
    assert.equal(await retryPage.evaluate(() => window.__qaRoomSocket.refresh()), true, 'ACK-lost reconciliation uses RoomSocket.refresh');
    assert.equal(await retryPage.locator('#saveBtn').isDisabled(), true, 'ACK-lost refresh keeps the mutation pending until a fresh snapshot');
    await retryPage.locator('#youChip').waitFor({ state: 'visible', timeout: 12000 });
    const reconciledRetryProfile = await readProfile(retryPage);
    assert.equal(reconciledRetryProfile.pid, retryProfile.pid);
    assert.equal(reconciledRetryProfile.identityMode, 'playerId');
    assert.equal(reconciledRetryProfile.playerId, '900000888');
    assert.equal(reconciledRetryProfile.name, 'Reconciled Player');
    assert.equal(reconciledRetryProfile.march, 49);
    assert.equal(reconciledRetryProfile.marchRevision, editedRetryProfile.marchRevision + 1);
    await delay(200);
    assert.equal(retryProfileUpdates.length, ackLostUpdateCount + 1, 'ACK-lost reconciliation does not duplicate the mutation');

    await retryPage.locator('#editBtn').click();
    await retryPage.locator('#identityNickname').click();
    assert.equal(await retryPage.locator('#pid').inputValue(), 'Tester Two', 'switching back restores the independent nickname draft');

    await racePage.locator('#editBtn').click();
    assert.equal(await racePage.locator('#pid').inputValue(), '222222');
    await racePage.locator('#identityNickname').click();
    assert.equal(await racePage.locator('#pid').inputValue(), 'Race Draft', 'existing Player ID profile restores its nickname draft');
    await racePage.locator('#pid').fill('Race Captain');
    await setMarch(racePage, 48);
    const raceUpdateCount = raceProfileUpdates.length;
    await racePage.locator('#saveBtn').click();
    await waitFor(() => raceProfileUpdates.length === raceUpdateCount + 1, 'Player ID to nickname profile update');
    await racePage.locator('#youChip').waitFor({ state: 'visible', timeout: 8000 });
    const raceNicknameUpdate = raceProfileUpdates.at(-1);
    assert.equal(raceNicknameUpdate.pid, raceProfile.pid, 'Player ID to nickname keeps the routing pid');
    assert.equal(raceNicknameUpdate.identityMode, 'nickname');
    assert.equal(raceNicknameUpdate.name, 'Race Captain');
    assert.equal(raceNicknameUpdate.profileKey, raceProfile.profileKey);
    assert.equal(Object.hasOwn(raceNicknameUpdate, 'playerId'), false, 'nickname mutation omits stale Player ID metadata');
    const editedRaceProfile = await readProfile(racePage);
    assert.equal(editedRaceProfile.pid, raceProfile.pid);
    assert.equal(editedRaceProfile.identityMode, 'nickname');
    assert.equal(editedRaceProfile.name, 'Race Captain');
    assert.equal(editedRaceProfile.march, 48);
    assert.equal(Object.hasOwn(editedRaceProfile, 'playerId'), false, 'nickname canonical localStorage clears stale Player ID metadata');
    const remoteRaceRoster = abortPage.locator(`#roster .roster-row[data-pid="${raceProfile.pid}"]`);
    await abortPage.waitForFunction(({ pid, name }) => {
      const row = document.querySelector(`#roster .roster-row[data-pid="${pid}"]`);
      return row && row.querySelector('.roster-name').textContent === name;
    }, { pid: raceProfile.pid, name: 'Race Captain' }, { timeout: 8000 });
    assert.equal(await remoteRaceRoster.locator('.roster-name').textContent(), 'Race Captain');
    assert.match(await remoteRaceRoster.locator('.roster-time').textContent(), /0:48/);

    await racePage.locator('#editBtn').click();
    await racePage.locator('#pid').fill('Kimchi');
    const unchangedMarch = await racePage.locator('#marchRange').inputValue();
    await racePage.locator('#saveBtn').click();
    await racePage.locator('#youName').filter({ hasText: 'Kimchi' }).waitFor({ timeout: 8000 });

    for (const openPage of [racePage, abortPage]) {
      await openPage.waitForFunction(({ pid, name }) => {
        const row = document.querySelector(`#roster .roster-row[data-pid="${pid}"] .roster-name`);
        const laneNames = Array.from(document.querySelectorAll('#lanes .lname')).map(node => node.textContent);
        return row && row.textContent === name && laneNames.some(value => value.includes(name)) &&
          laneNames.every(value => !value.includes('Race Captain'));
      }, { pid: raceProfile.pid, name: 'Kimchi' }, { timeout: 8000 });
    }
    assert.equal(await racePage.locator('#marchRange').inputValue(), unchangedMarch);

    await racePage.locator('#editBtn').click();
    await racePage.locator('#identityPlayerId').click();
    assert.equal(await racePage.locator('#pid').inputValue(), '222222', 'switching back restores the independent Player ID draft');

    assert.deepEqual(pageErrors, []);
    console.log(`✓ Player ID and nickname identity modes (${room})`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
