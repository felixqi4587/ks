const { test, expect } = require('playwright/test');
const {
  QA_PASSWORD,
  assertQaRoomName,
  makeQaRoom,
  qaDefenseUrl,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-coordination.cjs');

function parseFrame(data) {
  try { return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); }
  catch (error) { return null; }
}

function surfaceGate(surface) {
  const gate = { surface, urls: [], client: [], server: [] };
  gate.guardOptions = {
    shouldDropClientMessage({ url, data }) {
      gate.urls.push(url);
      gate.client.push(parseFrame(data));
      return false;
    },
    shouldDropServerMessage({ url, data }) {
      gate.urls.push(url);
      gate.server.push(parseFrame(data));
      return false;
    }
  };
  return gate;
}

async function installHttpOriginGuard(context, baseURL) {
  const allowedOrigin = new URL(baseURL).origin;
  await context.route('**/*', route => {
    let requested;
    try { requested = new URL(route.request().url()); }
    catch (error) { return route.abort(); }
    if (['http:', 'https:'].includes(requested.protocol) && requested.origin !== allowedOrigin) {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
}

function installAudioInspection() {
  window.__qaAudioEngines = [];
  window.__qaCueSchedulers = [];
  function intercept(globalName, factoryName, sinkName) {
    let current;
    Object.defineProperty(window, globalName, {
      configurable: true,
      get() { return current; },
      set(api) {
        if (!api || typeof api[factoryName] !== 'function') { current = api; return; }
        const wrapped = Object.assign({}, api);
        wrapped[factoryName] = function (...args) {
          const instance = api[factoryName](...args);
          window[sinkName].push(instance);
          return instance;
        };
        current = Object.freeze(wrapped);
      }
    });
  }
  intercept('BattleAudio', 'createAudioEngine', '__qaAudioEngines');
  intercept('BattleCues', 'createCueScheduler', '__qaCueSchedulers');
}

async function openSurface(browser, baseURL, room, surface, errors) {
  assertQaRoomName(room);
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 390, height: 1000 }
  });
  const gate = surfaceGate(surface);
  await installHttpOriginGuard(context, baseURL);
  await installQaWebSocketGuard(context, room, {
    ...gate.guardOptions,
    expectedOrigin: baseURL
  });
  await context.addInitScript(installAudioInspection);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${surface}: ${error.message}`));
  const url = surface === 'defense'
    ? qaDefenseUrl(baseURL, room, { lang: 'en', notour: '1' })
    : qaRoomUrl(baseURL, room, { lang: 'en', notour: '1' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (surface === 'defense') {
    await page.waitForFunction(() => !!window.__kingshoterDefenseMounted);
    await expect(page.locator('#defenseRoom')).toBeVisible();
  } else {
    await expect(page.locator('#roomView')).toBeVisible();
  }
  await expect.poll(() => gate.urls.length).toBeGreaterThan(0);
  return { context, page, gate };
}

function assertSurfaceUrls(gate, room) {
  expect(gate.urls.length).toBeGreaterThan(0);
  for (const value of new Set(gate.urls)) {
    const url = new URL(value);
    expect(url.pathname).toBe('/api/ws');
    expect(url.searchParams.get('room')).toBe(room);
    expect(url.searchParams.get('surface')).toBe(gate.surface);
  }
}

async function registerDefenseProfile(page, name, march) {
  await page.locator('#defenseModeNickname').click();
  await page.locator('#defenseIdentityValue').fill(name);
  await page.locator('#defenseMarchRange').fill(String(march));
  await page.locator('#defenseSaveProfile').click();
  await expect(page.locator('#defenseYouCard')).toBeVisible();
  await expect(page.locator('#defenseYouName')).toHaveText(name);
  return page.evaluate(() => window.defensePageController.state().profile);
}

async function enableDefenseAlerts(page) {
  await page.locator('#defenseAudioRow').click();
  await expect.poll(() => page.evaluate(() =>
    window.defensePageController.state().readiness.green
  ), { timeout: 15_000 }).toBe(true);
}

async function unlockDefenseManager(page) {
  await page.locator('#defenseConsoleEntry').click();
  await expect(page.locator('#defenseManagerUnlock')).toBeVisible();
  await page.locator('#defenseManagerPassword').fill(QA_PASSWORD);
  await page.locator('#defenseManagerUnlockSubmit').click();
  await expect.poll(() => page.evaluate(() => {
    const state = window.defenseManagerController.state();
    return state.authorized && state.managerReady;
  }), { timeout: 15_000 }).toBe(true);
  await expect(page.locator('#defenseManagerDrawer')).toHaveAttribute('aria-hidden', 'false');
}

async function saveDefenseTiming(page, anchorSeconds, enemyMarchSeconds) {
  await page.locator('#defenseManagerAnchor').fill(String(anchorSeconds));
  await page.locator('#defenseManagerEnemyMarch').fill(String(enemyMarchSeconds));
  await page.locator('#defenseManagerSaveTiming').click();
  await expect.poll(() => page.evaluate(() => {
    const state = window.defenseManagerController.state();
    return state.pendingConfig ? null : state.config;
  })).toMatchObject({ tapAnchorSeconds: anchorSeconds, enemyMarchSeconds });
}

async function inspection(page) {
  return page.evaluate(() => ({
    audio: (window.__qaAudioEngines || []).map(engine => engine.state()),
    cues: (window.__qaCueSchedulers || []).flatMap(scheduler => scheduler.snapshot()),
    personal: window.defensePageController ? window.defensePageController.state().personal : null,
    title: document.querySelector('#defensePersonalTitle')?.textContent || '',
    countdown: document.querySelector('#defenseCountdown')?.textContent || ''
  }));
}

async function cancelAndCleanDefense(page, pid) {
  const active = await page.evaluate(() => window.defenseManagerController.state().activeOrder);
  if (active) {
    await page.locator('#defenseManagerCancel').click();
    await expect(page.locator('#defenseManagerCancelConfirm')).toBeVisible();
    await page.locator('#defenseManagerCancelYes').click();
    await expect.poll(() => page.evaluate(() =>
      window.defenseManagerController.state().activeOrder
    )).toBeNull();
  }
  const exists = await page.evaluate(value =>
    window.defenseManagerController.state().players.some(player => player.pid === value), pid
  );
  if (!exists) return;
  const removed = await page.evaluate(value =>
    window.defenseManagerController.removePlayer(value, true), pid
  );
  expect(removed.ok).toBe(true);
  await expect.poll(() => page.evaluate(value =>
    window.defenseManagerController.state().players.some(player => player.pid === value), pid
  )).toBe(false);
}

test('canonical Rally and Defense routes keep exact surfaces while a manager-only Defense round stays silent and cleans qa', async ({ browser, baseURL }, testInfo) => {
  test.slow();
  const room = makeQaRoom(testInfo);
  const errors = [];
  const actors = [];
  let manager = null;
  let defenseProfile = null;
  try {
    const rally = await openSurface(browser, baseURL, room, 'rally', errors);
    actors.push(rally);
    const defender = await openSurface(browser, baseURL, room, 'defense', errors);
    actors.push(defender);
    manager = await openSurface(browser, baseURL, room, 'defense', errors);
    actors.push(manager);

    defenseProfile = await registerDefenseProfile(defender.page, 'QA Defender', 45);
    expect(defenseProfile.pid).toMatch(/^n_[0-9a-f]{22}$/);
    await enableDefenseAlerts(defender.page);
    await unlockDefenseManager(manager.page);
    await saveDefenseTiming(manager.page, 180, 30);

    await expect.poll(() => manager.page.evaluate(value =>
      window.defenseManagerController.state().players.some(player =>
        player.pid === value && player.name === 'QA Defender'
      ), defenseProfile.pid
    )).toBe(true);

    const managerBefore = await inspection(manager.page);
    expect(managerBefore.personal.captured).toBe(false);
    expect(managerBefore.cues).toEqual([]);
    expect(managerBefore.audio).toEqual([
      { userEnabled: false, audioContextRunning: false, carrierAlive: false }
    ]);

    await expect(manager.page.locator('#defenseManagerFire')).toBeEnabled();
    await manager.page.locator('#defenseManagerFire').click();
    await expect.poll(() => manager.page.evaluate(() =>
      window.defenseManagerController.state().activeOrder
    )).not.toBeNull();
    await expect.poll(() => defender.page.evaluate(() =>
      window.defensePageController.state().personal.captured
    )).toBe(true);
    await expect.poll(async () => (await inspection(defender.page)).cues.length).toBeGreaterThan(0);

    const managerAfter = await inspection(manager.page);
    expect(managerAfter.personal.captured).toBe(false);
    expect(managerAfter.cues).toEqual([]);
    expect(managerAfter.audio).toEqual(managerBefore.audio);

    await cancelAndCleanDefense(manager.page, defenseProfile.pid);
    await expect.poll(() => defender.page.evaluate(() =>
      window.defensePageController.state().personal.captured
    )).toBe(false);
    await expect.poll(async () => (await inspection(defender.page)).cues).toEqual([]);

    assertSurfaceUrls(rally.gate, room);
    assertSurfaceUrls(defender.gate, room);
    assertSurfaceUrls(manager.gate, room);
    expect(rally.gate.server.filter(Boolean).every(frame => !String(frame.t).startsWith('defense'))).toBe(true);
    for (const gate of [defender.gate, manager.gate]) {
      expect(gate.server.filter(Boolean).every(frame => frame.t !== 'state')).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    if (manager && defenseProfile) {
      try { await cancelAndCleanDefense(manager.page, defenseProfile.pid); } catch (error) {}
    }
    await Promise.all(actors.map(async actor => {
      try { await actor.context.close(); } catch (error) {}
    }));
  }
});
