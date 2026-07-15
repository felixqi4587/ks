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

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const raceContext = await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US' });
  const retryContext = await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US' });
  const abortContext = await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US' });
  const pageErrors = [];
  const raceLookups = [];
  const retryRegistrations = [];
  const abortLookups = [];
  let retryLookupCount = 0;

  try {
    await Promise.all([
      installQaWebSocketGuard(raceContext, room),
      installQaWebSocketGuard(retryContext, room, {
        shouldDropClientMessage({ data }) {
          const message = JSON.parse(String(data));
          if (message.t !== 'registerPlayer') return false;
          retryRegistrations.push(message);
          return false;
        }
      }),
      installQaWebSocketGuard(abortContext, room)
    ]);

    await raceContext.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const requestUrl = typeof input === 'string' ? input : input && input.url;
        if (!String(requestUrl || '').includes('/api/lookup')) return nativeFetch(input, init);
        const lookupInit = Object.assign({}, init || {});
        delete lookupInit.signal;
        return nativeFetch(input, lookupInit);
      };
    });
    await retryContext.addInitScript(() => {
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
    for (const [name, page] of [['race', racePage], ['retry', retryPage], ['abort', abortPage]]) {
      page.on('pageerror', error => pageErrors.push(`${name}: ${error.message}`));
    }
    await Promise.all([racePage.goto(url), retryPage.goto(url), abortPage.goto(url)]);
    await Promise.all([enableSound(racePage), enableSound(retryPage), enableSound(abortPage)]);

    assert.equal(await racePage.locator('link[href="app.css?v=30"]').count(), 1, 'the identity CSS cache version is exact');
    assert.equal(await racePage.locator('script[src="app.js?v=11"]').count(), 1, 'the shared socket cache version is exact');
    assert.equal(await racePage.locator('script[src="kvk.js?v=41"]').count(), 1, 'the identity script cache version is exact');
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

    await abortPage.locator('#pid').fill('333333');
    await waitFor(() => abortLookups.includes('333333'), 'normal lookup request before abort');
    await abortPage.locator('#pid').fill('444444');
    await waitFor(() => abortLookups.includes('444444'), 'replacement lookup request');
    await abortPage.locator('#nameOut').filter({ hasText: 'Current Abort Name' }).waitFor({ state: 'visible' });
    assert.ok(await abortPage.evaluate(() => window.__identityAbortCount >= 1), 'the prior native lookup controller is aborted');
    await delay(1300);
    assert.match(await abortPage.locator('#nameOut').textContent(), /Current Abort Name/);
    assert.doesNotMatch(await abortPage.locator('#nameOut').textContent(), /not found|lookup failed|Stale Abort Name/i);

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
    assert.equal(await readProfile(retryPage), null, 'only canonical room state persists a nickname profile');
    await retryPage.evaluate(() => window.__qaRoomSockets.at(-1).close(4000, 'QA reconnect'));
    await waitFor(() => retryRegistrations.length >= 1, 'false-send nickname profile resend after reconnect', 12000);
    assert.equal(retryRegistrations[0].pid, failedRegistration.pid, 'reconnect reuses the exact transient nickname routing key');
    assert.equal(retryRegistrations[0].name, failedRegistration.name);
    assert.equal(retryRegistrations[0].march, failedRegistration.march);
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
    assert.equal(await retryPage.locator('#identityPlayerId').isDisabled(), true);
    assert.equal(await retryPage.locator('#identityNickname').isDisabled(), true);
    assert.equal(await retryPage.locator('#pid').getAttribute('readonly'), '');
    assert.equal(await retryPage.locator('#pid').inputValue(), 'Tester', 'existing nickname edit shows the display name, not its opaque pid');
    assert.match(await retryPage.locator('#identityLabel').textContent(), /Nickname/i);
    await setMarch(retryPage, 47);
    await retryPage.locator('#saveBtn').click();
    await retryPage.locator('#youChip').waitFor({ state: 'visible', timeout: 8000 });
    const editedRetryProfile = await readProfile(retryPage);
    assert.equal(editedRetryProfile.pid, retryProfile.pid, 'march-only edit cannot replace an existing identity');
    assert.equal(editedRetryProfile.name, 'Tester');
    assert.equal(editedRetryProfile.march, 47);

    assert.deepEqual(pageErrors, []);
    console.log(`✓ Player ID and nickname identity modes (${room})`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
