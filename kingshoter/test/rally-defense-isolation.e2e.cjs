const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const {
  QA_PASSWORD,
  QA_ROOM,
  assertQaRoomName,
  installQaWebSocketGuard,
  qaDefenseUrl,
  qaRoomUrl
} = require('./support/qa-coordination.cjs');

const root = path.join(__dirname, '..');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

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
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'kingshoter-rally-defense-isolation-'));
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
    } catch (error) {}
    await delay(200);
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
      delay(3_000)
    ]);
    if (server.child.exitCode == null) server.child.kill('SIGKILL');
  }
  fs.rmSync(server.statePath, { recursive: true, force: true });
}

function parseFrame(data) {
  try { return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); }
  catch (error) { return null; }
}

function frameGate(surface) {
  const gate = { surface, urls: [], client: [], server: [] };
  gate.options = {
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

async function installOriginGuard(context, baseURL) {
  const origin = new URL(baseURL).origin;
  await context.route('**/*', route => {
    let requested;
    try { requested = new URL(route.request().url()); }
    catch (error) { return route.abort(); }
    if (['http:', 'https:'].includes(requested.protocol) && requested.origin !== origin) {
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

async function openActor(browser, baseURL, surface, label, errors) {
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 390, height: 1000 }
  });
  const gate = frameGate(surface);
  await installOriginGuard(context, baseURL);
  await installQaWebSocketGuard(context, QA_ROOM, {
    ...gate.options,
    expectedOrigin: baseURL
  });
  await context.addInitScript(installAudioInspection);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
  const url = surface === 'defense'
    ? qaDefenseUrl(baseURL, QA_ROOM, { notour: 1, lang: 'en' })
    : qaRoomUrl(baseURL, QA_ROOM, { notour: 1, lang: 'en' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (surface === 'defense') {
    await page.waitForFunction(() => window.defensePageController?.state().handshakeComplete === true);
  } else {
    await page.locator('#roomView').waitFor({ state: 'visible' });
    await waitFor(() => gate.server.some(frame => frame && frame.t === 'state'), `${label} Rally state`);
  }
  return { context, page, gate, label, surface };
}

async function enableRallyAlerts(page) {
  if (await page.locator('#roomView').evaluate(element => element.classList.contains('presound'))) {
    await page.locator('#soundGate').click({ force: true });
    await page.waitForFunction(() => !document.querySelector('#roomView')?.classList.contains('presound'));
  }
}

async function registerRally(actor, name, march) {
  await enableRallyAlerts(actor.page);
  await actor.page.locator('#identityNickname').click();
  await actor.page.locator('#pid').fill(name);
  await actor.page.locator('#marchRange').fill(String(march));
  await actor.page.locator('#saveBtn').click();
  await actor.page.locator('#youChip').waitFor({ state: 'visible' });
  await actor.page.locator('#youName').filter({ hasText: name }).waitFor();
  actor.profile = await actor.page.evaluate(room => JSON.parse(
    localStorage.getItem(`kingshoter_r_${room}_me`) || 'null'
  ), QA_ROOM);
  assert.match(actor.profile.pid, /^n_[0-9a-f]{22}$/);
  return actor.profile;
}

async function registerDefense(actor, name, march) {
  await actor.page.locator('#defenseModeNickname').click();
  await actor.page.locator('#defenseIdentityValue').fill(name);
  await actor.page.locator('#defenseMarchRange').fill(String(march));
  await actor.page.locator('#defenseSaveProfile').click();
  await actor.page.locator('#defenseYouCard').waitFor({ state: 'visible' });
  await actor.page.locator('#defenseAudioRow').click();
  await waitFor(() => actor.page.evaluate(() =>
    window.defensePageController.state().readiness.green
  ), 'Defense alerts ready');
  actor.profile = await actor.page.evaluate(() => window.defensePageController.state().profile);
  assert.match(actor.profile.pid, /^n_[0-9a-f]{22}$/);
  return actor.profile;
}

async function unlockRallyManager(page) {
  await enableRallyAlerts(page);
  await page.locator('#cmdUnlock').click();
  if (await page.locator('#pwOvl').evaluate(element => element.classList.contains('show'))) {
    await page.locator('#pwInput').fill(QA_PASSWORD);
    await page.locator('#pwGo').click();
  }
  await page.waitForFunction(() => document.querySelector('#console')?.dataset.drawerState === 'command');
  await page.locator('#commanderManageOpen').click();
  await page.waitForFunction(() => document.querySelector('#console')?.dataset.drawerState === 'manage');
}

async function selectRallyCaptains(page, profiles) {
  for (const profile of profiles) {
    const row = page.locator(`#roster .rp[data-pid="${profile.pid}"]`);
    await row.waitFor({ state: 'visible' });
    await row.click();
    await page.waitForFunction(pid =>
      document.querySelector(`#roster .rp[data-pid="${pid}"]`)?.getAttribute('aria-pressed') === 'true',
    profile.pid);
  }
  await page.locator('#commanderManageBack').click();
  await page.waitForFunction(() => document.querySelector('#console')?.dataset.drawerState === 'command');
}

async function rallyRoom(page) {
  return page.evaluate(async room => {
    const response = await fetch(`/api/ws?room=${encodeURIComponent(room)}`);
    if (!response.ok) throw new Error(`Rally snapshot HTTP ${response.status}`);
    return (await response.json()).room;
  }, QA_ROOM);
}

async function fireRally(page) {
  await page.locator('#lead button[data-v="10"]').click();
  assert.equal(await page.locator('#fireDouble').isDisabled(), false);
  await page.locator('#fireDouble').click();
  await page.locator('#fireDouble.armed').waitFor({ state: 'visible' });
  await page.locator('#fireDouble').click();
  return waitFor(async () => {
    const commands = (await rallyRoom(page)).live?.commands || {};
    return Object.values(commands).find(Boolean) || null;
  }, 'Rally command acceptance');
}

async function cancelRally(page) {
  await page.locator('#cancelBtn').click();
  await page.locator('#cancelBtn').click();
  await waitFor(async () => {
    const commands = (await rallyRoom(page)).live?.commands || {};
    return !Object.values(commands).some(Boolean);
  }, 'Rally cancellation');
}

async function unlockDefenseManager(page) {
  await page.locator('#defenseConsoleEntry').click();
  await page.locator('#defenseManagerPassword').fill(QA_PASSWORD);
  await page.locator('#defenseManagerUnlockSubmit').click();
  await waitFor(() => page.evaluate(() => {
    const state = window.defenseManagerController.state();
    return state.authorized && state.managerReady && state.rosterHydrated;
  }), 'Defense manager authorization');
}

async function configureDefense(page) {
  await page.locator('#defenseManagerAnchor').fill('180');
  await page.locator('#defenseManagerEnemyMarch').fill('30');
  await page.locator('#defenseManagerSaveTiming').click();
  await waitFor(() => page.evaluate(() => {
    const state = window.defenseManagerController.state();
    return !state.pendingConfig && state.config.tapAnchorSeconds === 180 &&
      state.config.enemyMarchSeconds === 30;
  }), 'Defense timing save');
}

async function fireDefense(manager, defender) {
  assert.equal(await manager.locator('#defenseManagerFire').isDisabled(), false);
  await manager.locator('#defenseManagerFire').click();
  await waitFor(() => manager.evaluate(() =>
    window.defenseManagerController.state().activeOrder
  ), 'Defense order acceptance');
  await waitFor(() => defender.evaluate(() =>
    window.defensePageController.state().personal.captured
  ), 'Defense personal capture');
}

async function cancelDefense(page) {
  await page.locator('#defenseManagerCancel').click();
  await page.locator('#defenseManagerCancelConfirm').waitFor({ state: 'visible' });
  await page.locator('#defenseManagerCancelYes').click();
  await waitFor(() => page.evaluate(() =>
    window.defenseManagerController.state().activeOrder === null
  ), 'Defense cancellation');
}

async function defenseInspection(page) {
  return page.evaluate(() => {
    const state = window.defensePageController.state();
    const personal = state.personal || {};
    return {
      profile: state.profile ? {
        pid: state.profile.pid, name: state.profile.name, march: state.profile.march
      } : null,
      personal: {
        captured: personal.captured === true,
        orderId: personal.orderId || '',
        goAtMs: Number(personal.goAtMs) || 0,
        tooLate: personal.tooLate === true,
        outcome: personal.outcome || ''
      },
      visual: {
        title: document.querySelector('#defensePersonalTitle')?.textContent || '',
        countdown: document.querySelector('#defenseCountdown')?.textContent || '',
        className: document.querySelector('#defensePersonalCard')?.className || ''
      },
      audio: (window.__qaAudioEngines || []).map(engine => engine.state()),
      cues: (window.__qaCueSchedulers || []).flatMap(scheduler => scheduler.snapshot())
    };
  });
}

async function rallyInspection(page) {
  return page.evaluate(() => ({
    visual: {
      title: document.querySelector('#pheroTitle')?.textContent || '',
      number: document.querySelector('#pheroNum')?.textContent || '',
      subtitle: document.querySelector('#pheroSub')?.textContent || '',
      className: document.querySelector('#phero')?.className || '',
      frozen: document.querySelector('#pickSlots')?.classList.contains('frozen') || false
    },
    audio: (window.__qaAudioEngines || []).map(engine => engine.state()),
    cues: Object.entries(window.__cues || {}).map(([key, cue]) => ({
      key, base: cue && cue.base || '', targetMs: Number(cue && cue.t) || 0
    })).sort((left, right) => left.key.localeCompare(right.key))
  }));
}

function serverCounts(actors) {
  return actors.map(actor => actor.gate.server.length);
}

function assertSurfaceUrls(actor) {
  assert.ok(actor.gate.urls.length > 0, `${actor.label} opened a guarded socket`);
  for (const value of new Set(actor.gate.urls)) {
    const url = new URL(value);
    assert.equal(url.pathname, '/api/ws');
    assert.equal(url.searchParams.get('room'), QA_ROOM);
    assert.equal(url.searchParams.get('surface'), actor.surface);
  }
}

test('Rally and Defense stay bidirectionally isolated in the same qa room', { timeout: 120_000 }, async t => {
  assertQaRoomName(QA_ROOM);
  let server = null;
  let browser = null;
  const actors = [];
  const errors = [];
  try {
    server = await startIsolatedWrangler();
    browser = await chromium.launch({ headless: true });
    const rallyA = await openActor(browser, server.baseURL, 'rally', 'Rally A', errors);
    const rallyB = await openActor(browser, server.baseURL, 'rally', 'Rally B', errors);
    const rallyManager = await openActor(browser, server.baseURL, 'rally', 'Rally manager', errors);
    const defender = await openActor(browser, server.baseURL, 'defense', 'Defense player', errors);
    const defenseManager = await openActor(browser, server.baseURL, 'defense', 'Defense manager', errors);
    actors.push(rallyA, rallyB, rallyManager, defender, defenseManager);

    const rallyAProfile = await registerRally(rallyA, 'QA Rally A', 35);
    const rallyBProfile = await registerRally(rallyB, 'QA Rally B', 40);
    const defenseProfile = await registerDefense(defender, 'QA Defender', 45);
    await waitFor(async () => Object.keys((await rallyRoom(rallyManager.page)).players || {}).length === 2,
      'two Rally profiles');

    await unlockRallyManager(rallyManager.page);
    await selectRallyCaptains(rallyManager.page, [rallyAProfile, rallyBProfile]);
    await unlockDefenseManager(defenseManager.page);
    await configureDefense(defenseManager.page);
    await waitFor(() => defenseManager.page.evaluate(pid => {
      const rows = window.defenseManagerController.state().players;
      return rows.length === 1 && rows[0].pid === pid && rows[0].name === 'QA Defender';
    }, defenseProfile.pid), 'isolated Defense roster');

    const rallyPlayers = (await rallyRoom(rallyManager.page)).players;
    assert.deepEqual(new Set(Object.values(rallyPlayers).map(player => player.name)),
      new Set(['QA Rally A', 'QA Rally B']));
    assert.equal(Object.values(rallyPlayers).some(player => player.name === 'QA Defender'), false);

    await delay(300);
    const defenseActors = [defender, defenseManager];
    const defenseCountsBeforeRally = serverCounts(defenseActors);
    const defenseVisualBeforeRally = await Promise.all(defenseActors.map(actor =>
      defenseInspection(actor.page)));
    const rallyCommand = await fireRally(rallyManager.page);
    assert.equal(rallyCommand.type, 'double_rally');
    await delay(400);
    assert.deepEqual(serverCounts(defenseActors), defenseCountsBeforeRally,
      'Rally fire emits no Defense WebSocket frame');
    assert.deepEqual(await Promise.all(defenseActors.map(actor => defenseInspection(actor.page))),
      defenseVisualBeforeRally, 'Rally fire changes no Defense state, visual, cue, or audio state');

    await cancelRally(rallyManager.page);
    await delay(400);
    const rallyActors = [rallyA, rallyB, rallyManager];
    const rallyCountsBeforeDefense = serverCounts(rallyActors);
    const rallyVisualBeforeDefense = await Promise.all(rallyActors.map(actor =>
      rallyInspection(actor.page)));
    const defenseManagerBefore = await defenseInspection(defenseManager.page);
    await fireDefense(defenseManager.page, defender.page);
    await delay(400);
    assert.deepEqual(serverCounts(rallyActors), rallyCountsBeforeDefense,
      'Defense fire emits no Rally WebSocket frame');
    assert.deepEqual(await Promise.all(rallyActors.map(actor => rallyInspection(actor.page))),
      rallyVisualBeforeDefense, 'Defense fire changes no Rally state, visual, cue, or audio state');

    const managerAfter = await defenseInspection(defenseManager.page);
    assert.equal(managerAfter.personal.captured, false);
    assert.deepEqual(managerAfter.cues, []);
    assert.deepEqual(managerAfter.audio, defenseManagerBefore.audio);
    const defenderAfter = await defenseInspection(defender.page);
    assert.equal(defenderAfter.personal.captured, true);
    assert.ok(defenderAfter.cues.length > 0, 'targeted defender schedules the shared countdown cues');

    await cancelDefense(defenseManager.page);
    await waitFor(() => defender.page.evaluate(() =>
      window.defensePageController.state().personal.captured === false
    ), 'Defense player cancellation');

    for (const actor of actors) assertSurfaceUrls(actor);
    for (const actor of rallyActors) {
      assert.equal(actor.gate.server.filter(Boolean).some(frame =>
        String(frame.t || '').startsWith('defense')), false,
      `${actor.label} receives no Defense frame type`);
    }
    for (const actor of defenseActors) {
      assert.equal(actor.gate.server.filter(Boolean).some(frame =>
        frame.t === 'state' || String(frame.t || '').startsWith('deliveryShadow')), false,
      `${actor.label} receives no Rally frame type`);
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    if (server) t.diagnostic(server.logs());
    throw error;
  } finally {
    await Promise.all(actors.map(async actor => {
      try { await actor.context.close(); } catch (error) {}
    }));
    if (browser) await browser.close().catch(() => {});
    await stopWrangler(server);
  }
});
