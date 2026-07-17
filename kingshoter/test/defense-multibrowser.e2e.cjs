const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, firefox, webkit } = require('playwright');
const {
  QA_PASSWORD,
  QA_ROOM,
  installQaWebSocketGuard,
  qaDefenseUrl
} = require('./support/qa-coordination.cjs');

const root = path.join(__dirname, '..');
const WAITING_TITLE = 'Waiting for the next Defense order';
const LOCAL_TIMING_COPY = 'Website timing only · the game does not send live data to this page.';
const DELIVERY_COPY = 'Website delivery status only; the game does not report participation or response.';
const METRIC_LABELS = ['Targeted', 'Scheduled', 'Audio ready', 'Red / unconfirmed'];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startIsolatedWrangler() {
  const port = await freePort();
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'kingshoter-defense-multibrowser-'));
  const child = spawn('npx', [
    'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--persist-to', statePath, '--var', 'TRIPLE_RALLY_ENABLED:0',
    '--var', 'TRIPLE_RALLY_QA_ENABLED:1', '--log-level', 'warn'
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const collect = chunk => { logs = (logs + String(chunk)).slice(-16_000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const baseURL = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`isolated Wrangler exited ${child.exitCode}\n${logs}`);
    try {
      const response = await fetch(`${baseURL}/api/time`);
      if (response.ok) return { child, statePath, baseURL, logs: () => logs };
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  child.kill('SIGTERM');
  throw new Error(`isolated Wrangler did not start\n${logs}`);
}

async function stopWrangler(server) {
  if (!server) return;
  if (server.child.exitCode == null) {
    server.child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => server.child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3_000))
    ]);
    if (server.child.exitCode == null) server.child.kill('SIGKILL');
  }
  fs.rmSync(server.statePath, { recursive: true, force: true });
}

function decodeFrame(data) {
  try {
    return JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString());
  } catch (_) {
    return null;
  }
}

async function trackedContext(browser, baseURL, label) {
  const frames = { client: [], server: [] };
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BattleConnection', {
      configurable: true,
      set(api) {
        const wrapped = Object.freeze({
          ...api,
          createRoomConnection(options, overrides) {
            const connection = api.createRoomConnection(options, overrides);
            window.__defenseConnection = connection;
            return connection;
          }
        });
        Object.defineProperty(window, 'BattleConnection', {
          configurable: true, writable: true, value: wrapped
        });
      }
    });
    Object.defineProperty(window, 'BattleCues', {
      configurable: true,
      set(api) {
        const wrapped = Object.freeze({
          createCueScheduler(options) {
            const scheduler = api.createCueScheduler(options);
            window.__defenseCueScheduler = scheduler;
            return scheduler;
          }
        });
        Object.defineProperty(window, 'BattleCues', {
          configurable: true, writable: true, value: wrapped
        });
      }
    });
  });
  await installQaWebSocketGuard(context, QA_ROOM, {
    expectedOrigin: baseURL,
    shouldDropClientMessage({ data }) {
      const message = decodeFrame(data);
      if (message) frames.client.push(message);
      return false;
    },
    shouldDropServerMessage({ data }) {
      const message = decodeFrame(data);
      if (message) frames.server.push(message);
      return false;
    }
  });
  return { context, frames, errors, label };
}

async function openDefensePage(record, baseURL) {
  const page = await record.context.newPage();
  page.on('pageerror', error => record.errors.push(error.message));
  await page.goto(qaDefenseUrl(baseURL, QA_ROOM, { lang: 'en' }), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.defensePageController?.state().handshakeComplete === true);
  record.page = page;
  return page;
}

async function openDefender(browser, baseURL, label, name, march) {
  const record = await trackedContext(browser, baseURL, label);
  const page = await openDefensePage(record, baseURL);
  await page.locator('#defenseModeNickname').click();
  await page.locator('#defenseIdentityValue').fill(name);
  await page.locator('#defenseMarchRange').fill(String(march));
  await page.locator('#defenseSaveProfile').click();
  await page.waitForFunction(expected => {
    const state = window.defensePageController?.state();
    return state?.profile?.name === expected && state.pendingRegistration == null;
  }, name);
  await page.locator('#defenseYouCard').waitFor({ state: 'visible' });
  await page.locator('#defenseAudioRow').click();
  await page.waitForFunction(() => window.defensePageController?.state().readiness.green === true, null, { timeout: 15_000 });
  assert.equal(await page.locator('#defensePersonalTitle').textContent(), WAITING_TITLE, `${label} starts waiting`);
  assert.equal((await page.evaluate(() => window.__defenseCueScheduler.snapshot())).length, 0,
    `${label} has no cue before an order`);
  return record;
}

async function unlockManager(page) {
  await page.locator('#defenseConsoleEntry').click();
  if (await page.locator('#defenseManagerUnlock').isVisible()) {
    await page.locator('#defenseManagerPassword').fill(QA_PASSWORD);
    await page.locator('#defenseManagerUnlockSubmit').click();
  }
  await page.locator('#defenseManagerDrawer[data-drawer-state="command"]').waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => window.defenseManagerController?.state().managerReady === true, null, { timeout: 15_000 });
}

async function openManager(browser, baseURL, label) {
  const record = await trackedContext(browser, baseURL, label);
  const page = await openDefensePage(record, baseURL);
  await unlockManager(page);
  assert.equal((await page.evaluate(() => window.defensePageController.state().profile)), null,
    'manager-only page has no player profile');
  assert.deepEqual(await page.evaluate(() => window.__defenseCueScheduler.snapshot()), [],
    'manager-only page begins without personal cues');
  return record;
}

async function saveTiming(manager, anchor, enemyMarch) {
  const page = manager.page;
  const previousRevision = await page.evaluate(() => window.defenseManagerController.state().config.revision);
  await page.locator('#defenseManagerAnchor').fill(String(anchor));
  await page.locator('#defenseManagerEnemyMarch').fill(String(enemyMarch));
  await page.locator('#defenseManagerSaveTiming').click();
  await page.waitForFunction(({ anchor, enemyMarch, previousRevision }) => {
    const state = window.defenseManagerController?.state();
    return state?.pendingConfig == null && state.config.revision > previousRevision &&
      state.config.tapAnchorSeconds === anchor && state.config.enemyMarchSeconds === enemyMarch;
  }, { anchor, enemyMarch, previousRevision });
}

function messages(record, direction, type, predicate = () => true) {
  return record.frames[direction].filter(message => message.t === type && predicate(message));
}

async function fireDefenseRound(manager) {
  const prior = await manager.page.evaluate(() => window.defenseManagerController.state().activeOrder?.id || '');
  await manager.page.locator('#defenseManagerFire').click();
  await manager.page.waitForFunction(previous => {
    const order = window.defenseManagerController?.state().activeOrder;
    return order && order.id !== previous;
  }, prior, { timeout: 15_000 });
  return manager.page.evaluate(() => {
    const order = window.defenseManagerController.state().activeOrder;
    return { id: order.id, revision: order.revision, signalAtMs: order.signalAtMs };
  });
}

async function waitForPersonal(record, order) {
  await record.page.waitForFunction(expected => {
    const personal = window.defensePageController?.state().personal;
    return personal?.captured === true && personal.id === expected.id && personal.revision === expected.revision &&
      personal.tooLate === false;
  }, order, { timeout: 15_000 });
  await record.page.waitForFunction(expected => {
    const state = window.defensePageController.state();
    return state.readiness.green === true && state.personal?.id === expected;
  }, order.id, { timeout: 15_000 });
}

async function verifyScheduledOnce(record, order) {
  await record.page.waitForFunction(expected => {
    const personal = window.defensePageController?.state().personal;
    if (!personal || personal.id !== expected.id) return false;
    const entries = window.__defenseCueScheduler?.snapshot() || [];
    return entries.length > 0 && entries.every(entry => entry.base === personal.planId && entry.scheduled === true);
  }, order, { timeout: 15_000 });
  await record.page.waitForFunction(expected => {
    return window.defensePageController?.state().personal?.id === expected &&
      window.defensePageController.state().readiness.green === true;
  }, order.id);
  const acks = messages(record, 'client', 'defenseOrderAck', message => message.orderId === order.id);
  assert.equal(acks.length, 1, `${record.label} sends one ACK for ${order.id}`);
  assert.equal(acks[0].outcome, 'scheduled', `${record.label} confirms scheduled audio`);
  const state = await record.page.evaluate(() => ({
    personal: window.defensePageController.state().personal,
    support: document.querySelector('#defensePersonalSupport').textContent,
    cues: window.__defenseCueScheduler.snapshot()
  }));
  assert.equal(state.personal.captured, true, `${record.label} is captured`);
  assert.equal(state.personal.tooLate, false, `${record.label} has a future cue`);
  assert.equal(state.support, LOCAL_TIMING_COPY, `${record.label} uses truthful website-only wording`);
  assert.equal(new Set(state.cues.map(cue => cue.key)).size, state.cues.length, `${record.label} has no duplicate cues`);
  return state;
}

async function verifyManagerTruth(manager) {
  const page = manager.page;
  await page.locator('#defenseManagerOpenManage').click();
  await page.locator('#defenseManagerDrawer[data-drawer-state="manage"]').waitFor();
  await page.locator('#defenseManagerStatusTab').click();
  assert.equal(await page.locator('#defenseManagerDisclaimer').textContent(), DELIVERY_COPY);
  const labels = (await page.locator('#defenseManagerMetrics .defense-manager__metric').allTextContents())
    .map(value => value.replace(/\s+/g, ' ').trim());
  for (const expected of METRIC_LABELS) {
    assert.equal(labels.some(value => value.includes(expected)), true, `manager metric includes “${expected}”`);
  }
  await page.locator('#defenseManagerBack').click();
  await page.locator('#defenseManagerDrawer[data-drawer-state="command"]').waitFor();
}

async function cancelRound(manager, order, participants) {
  await manager.page.locator('#defenseManagerCancel').click();
  await manager.page.locator('#defenseManagerCancelConfirm').waitFor({ state: 'visible' });
  await manager.page.locator('#defenseManagerCancelYes').click();
  await manager.page.waitForFunction(expected => !window.defenseManagerController.state().activeOrder &&
    window.defenseManagerController.state().config.revision === expected.configRevision,
  { configRevision: await manager.page.evaluate(() => window.defenseManagerController.state().config.revision) });
  for (const record of participants) {
    await record.page.waitForFunction(expected => {
      const state = window.defensePageController?.state();
      return state.personal?.captured === false && state.announcement?.kind === 'cancelled' &&
        state.announcement?.key.startsWith(expected + ':');
    }, order.id, { timeout: 15_000 });
    assert.equal(await record.page.locator('#defenseCountdownLive').textContent(), 'Order cancelled',
      `${record.label} announces cancellation`);
    assert.deepEqual(await record.page.evaluate(() => window.__defenseCueScheduler.snapshot()), [],
      `${record.label} cancels future cues`);
    assert.equal(await record.page.evaluate(() => window.defensePageController.state().readiness.green), true,
      `${record.label} stays ready after cancellation`);
    assert.ok(await record.page.evaluate(() => window.defensePageController.state().profile?.pid),
      `${record.label} keeps its profile after cancellation`);
  }
}

async function reconnectWithFutureCue(record, order) {
  const beforeGeneration = await record.page.evaluate(() => window.defensePageController.state());
  assert.equal(beforeGeneration.personal.id, order.id);
  await record.context.setOffline(true);
  await record.page.evaluate(() => window.__defenseConnection.socket().close());
  await record.page.waitForFunction(() => window.defensePageController.state().connected === false, null, { timeout: 10_000 });
  await record.context.setOffline(false);
  await record.page.evaluate(() => window.__defenseConnection.kick());
  await record.page.waitForFunction(expected => {
    const state = window.defensePageController?.state();
    return state.connected && state.handshakeComplete && state.readiness.green &&
      state.personal?.captured && state.personal.id === expected;
  }, order.id, { timeout: 20_000 });
  const projection = await record.page.evaluate(() => ({
    now: Date.now(),
    cues: window.__defenseCueScheduler.snapshot(),
    personal: window.defensePageController.state().personal
  }));
  assert.equal(new Set(projection.cues.map(cue => cue.key)).size, projection.cues.length,
    `${record.label} reconnect does not duplicate future cues`);
  assert.equal(projection.cues.every(cue => cue.scheduled && cue.atMs > projection.now - 250), true,
    `${record.label} reconnect retains only future scheduled cues`);
  assert.equal(messages(record, 'client', 'defenseOrderAck', message => message.orderId === order.id).length, 1,
    `${record.label} reconnect does not duplicate its order ACK`);
}

async function verifyConfigPersistence(browser, baseURL, anchor, enemyMarch) {
  const manager = await openManager(browser, baseURL, 'persisted manager');
  try {
    const config = await manager.page.evaluate(() => window.defenseManagerController.state().config);
    assert.equal(config.tapAnchorSeconds, anchor, 'Defense countdown anchor persists in the room');
    assert.equal(config.enemyMarchSeconds, enemyMarch, 'Enemy march time persists in the room');
  } finally {
    await manager.context.close();
  }
}

async function closeRecord(record) {
  if (!record) return;
  assert.deepEqual(record.errors, [], `${record.label} has no page errors`);
  await record.context.close();
}

(async () => {
  let server;
  const browsers = [];
  const records = [];
  try {
    server = await startIsolatedWrangler();
    const chromiumBrowser = await chromium.launch({ headless: true });
    const firefoxBrowser = await firefox.launch({ headless: true });
    const webkitBrowser = await webkit.launch({ headless: true });
    browsers.push(chromiumBrowser, firefoxBrowser, webkitBrowser);

    const manager = await openManager(chromiumBrowser, server.baseURL, 'manager-only Chromium');
    records.push(manager);
    await saveTiming(manager, 30, 10);

    const chromeDefender = await openDefender(chromiumBrowser, server.baseURL, 'Chromium defender', 'Chrome Guard', 20);
    const firefoxDefender = await openDefender(firefoxBrowser, server.baseURL, 'Firefox defender', 'Firefox Guard', 21);
    const webkitDefender = await openDefender(webkitBrowser, server.baseURL, 'WebKit manager+defender', 'WebKit Guard', 22);
    records.push(chromeDefender, firefoxDefender, webkitDefender);
    await unlockManager(webkitDefender.page);

    for (const defender of [chromeDefender, firefoxDefender, webkitDefender]) {
      assert.equal(await defender.page.locator('#defensePersonalTitle').textContent(), WAITING_TITLE,
        `${defender.label} waits before round one`);
    }

    const firstOrder = await fireDefenseRound(manager);
    for (const defender of [chromeDefender, firefoxDefender, webkitDefender]) await waitForPersonal(defender, firstOrder);
    for (const defender of [chromeDefender, firefoxDefender, webkitDefender]) await verifyScheduledOnce(defender, firstOrder);

    assert.equal(await manager.page.locator('#defenseManagerPersonalCue').isHidden(), true,
      'manager-only page has no personal cue pill');
    assert.deepEqual(await manager.page.evaluate(() => window.__defenseCueScheduler.snapshot()), [],
      'manager-only page stays silent during an active round');
    assert.equal(messages(manager, 'client', 'defenseOrderAck', message => message.orderId === firstOrder.id).length, 0,
      'manager-only page sends no personal ACK');
    await webkitDefender.page.locator('#defenseManagerPersonalCue').waitFor({ state: 'visible' });
    assert.match(await webkitDefender.page.locator('#defenseManagerPersonalCue').textContent(), /^Your cue · /,
      'manager+defender sees its ordinary personal cue in the manager header');
    assert.equal(messages(webkitDefender, 'client', 'defenseOrderAck', message => message.orderId === firstOrder.id).length, 1,
      'manager+defender still owns only one ordinary personal delivery path');
    await verifyManagerTruth(manager);

    const lateDefender = await openDefender(chromiumBrowser, server.baseURL, 'next-round defender', 'Late Guard', 19);
    records.push(lateDefender);
    assert.equal(await lateDefender.page.evaluate(() => window.defensePageController.state().personal.captured), false,
      'a player registered after Fire does not join the current frozen audience');
    assert.equal(await lateDefender.page.locator('#defensePersonalTitle').textContent(), WAITING_TITLE,
      'a player registered after Fire keeps waiting for the next round');
    assert.equal(messages(lateDefender, 'client', 'defenseOrderAck', message => message.orderId === firstOrder.id).length, 0,
      'a player outside the frozen audience sends no ACK for the current round');

    await reconnectWithFutureCue(firefoxDefender, firstOrder);
    await cancelRound(manager, firstOrder, [chromeDefender, firefoxDefender, webkitDefender]);
    assert.equal(await lateDefender.page.evaluate(() => window.defensePageController.state().readiness.green), true,
      'the next-round player remains ready while the first round is cancelled');

    await verifyConfigPersistence(chromiumBrowser, server.baseURL, 30, 10);

    const secondOrder = await fireDefenseRound(manager);
    const secondParticipants = [chromeDefender, firefoxDefender, webkitDefender, lateDefender];
    for (const defender of secondParticipants) await waitForPersonal(defender, secondOrder);
    for (const defender of secondParticipants) await verifyScheduledOnce(defender, secondOrder);
    assert.equal(await lateDefender.page.evaluate(() => window.defensePageController.state().personal.id), secondOrder.id,
      'the newly registered player is automatically ready for the next round');
    assert.equal(messages(manager, 'client', 'defenseOrderAck', message => message.orderId === secondOrder.id).length, 0,
      'manager-only page remains silent on repeated rounds');
    await cancelRound(manager, secondOrder, secondParticipants);

    for (const record of records) assert.deepEqual(record.errors, [], `${record.label} has no page errors`);
    console.log('✓ Defense multibrowser: waiting, manager silence, personal cues, reconnect, cancel, persistence, next/repeated rounds');
  } finally {
    for (const record of records.reverse()) {
      try { await closeRecord(record); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
    }
    for (const browser of browsers.reverse()) {
      try { await browser.close(); } catch (_) {}
    }
    await stopWrangler(server);
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
