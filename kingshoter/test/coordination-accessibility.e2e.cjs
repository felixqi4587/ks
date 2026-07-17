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
  qaDefenseUrl,
  qaRoomUrl
} = require('./support/qa-coordination.cjs');

const root = path.join(__dirname, '..');
const widths = [320, 375, 390, 430];
const engines = [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]];

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
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'kingshoter-coordination-a11y-'));
  const child = spawn('npx', [
    'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--persist-to', statePath, '--var', 'TRIPLE_RALLY_ENABLED:0',
    '--var', 'TRIPLE_RALLY_QA_ENABLED:1', '--log-level', 'warn'
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const collect = chunk => { logs = (logs + String(chunk)).slice(-12_000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
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

async function guardedContext(browser, baseURL, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 390, height: 844 },
    locale: 'en-US',
    reducedMotion: options.reducedMotion || 'no-preference',
    hasTouch: options.hasTouch === true
  });
  await installQaWebSocketGuard(context, QA_ROOM, { expectedOrigin: baseURL });
  return context;
}

async function openSurface(context, baseURL, surface, errors) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${surface}: ${error.message}`));
  const url = surface === 'rally'
    ? qaRoomUrl(baseURL, QA_ROOM, { notour: 1, lang: 'en' })
    : qaDefenseUrl(baseURL, QA_ROOM, { lang: 'en' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (surface === 'rally') {
    await page.locator('#soundGate').click({ force: true }).catch(() => {});
    await page.waitForFunction(() => (document.querySelector('#netlab')?.textContent || '').trim().length > 0);
  } else {
    await page.waitForFunction(() => window.defensePageController?.state().handshakeComplete === true);
  }
  return page;
}

function labelFor(record) {
  return `${record.tag.toLowerCase()}${record.id ? `#${record.id}` : ''}${record.type ? `[type=${record.type}]` : ''}`;
}

async function mobileAudit(page, surface, engineName, width, failures) {
  const result = await page.evaluate(() => {
    function visible(element) {
      if (element.closest('[inert]')) return false;
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0;
    }
    function targetRect(element) {
      if (element.matches('input[type="checkbox"],input[type="radio"]')) {
        const label = element.closest('label') || document.querySelector(`label[for="${element.id}"]`);
        if (label && visible(label)) return label.getBoundingClientRect();
      }
      return element.getBoundingClientRect();
    }
    const selector = 'button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="tab"],[role="radio"]';
    const unique = [...new Set(document.querySelectorAll(selector))].filter(visible);
    const targets = unique.map(element => {
      const rect = targetRect(element);
      return { id: element.id, tag: element.tagName, type: element.type || '',
        width: rect.width, height: rect.height, fontSize: parseFloat(getComputedStyle(element).fontSize) || 0 };
    });
    const textInputs = unique.filter(element => element.matches(
      'textarea,select,input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])'
    )).map(element => ({ id: element.id, fontSize: parseFloat(getComputedStyle(element).fontSize) || 0 }));
    const criticalSelectors = location.pathname.includes('defense')
      ? ['#defenseStatusLabel', '#defenseProfileHint', '#defensePersonalTitle', '#defensePersonalSupport', '#defenseConsoleLabel']
      : ['#netlab', '#t_fill', '#marchTip', '#mapMessage', '#cmdUnlock'];
    const critical = criticalSelectors.map(selector => document.querySelector(selector)).filter(visible)
      .map(element => ({ id: element.id, fontSize: parseFloat(getComputedStyle(element).fontSize) || 0,
        text: element.textContent.trim() }));
    const status = location.pathname.includes('defense')
      ? document.querySelector('#defenseStatusLabel') : document.querySelector('#netlab');
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      targets, textInputs, critical,
      statusText: status ? status.textContent.trim() : '',
      nonEmptyAssertive: [...document.querySelectorAll('[aria-live="assertive"]')]
        .filter(visible).filter(element => element.textContent.trim()).length
    };
  });
  if (result.scrollWidth > result.clientWidth + 1) {
    failures.push(`${engineName} ${surface} ${width}px horizontal overflow ${result.scrollWidth - result.clientWidth}px`);
  }
  result.targets.filter(target => target.width < 43.5 || target.height < 43.5).forEach(target => {
    failures.push(`${engineName} ${surface} ${width}px ${labelFor(target)} target ${target.width.toFixed(1)}×${target.height.toFixed(1)} < 44×44`);
  });
  result.textInputs.filter(input => input.fontSize < 16).forEach(input => {
    failures.push(`${engineName} ${surface} ${width}px #${input.id} text input is ${input.fontSize}px < 16px`);
  });
  result.critical.filter(item => item.fontSize < 11 || !item.text).forEach(item => {
    failures.push(`${engineName} ${surface} ${width}px #${item.id} critical text is missing or ${item.fontSize}px < 11px`);
  });
  if (!result.statusText) failures.push(`${engineName} ${surface} ${width}px exposes color without a textual connection state`);
  if (result.nonEmptyAssertive > 1) failures.push(`${engineName} ${surface} ${width}px duplicates assertive live announcements`);

  await page.addStyleTag({ content: `
    :where(h1,h2,h3,p,span,button,input,select,label,output,strong,small,a,time,summary,legend) {
      font-size: 200% !important; line-height: 1.5 !important; overflow-wrap: anywhere !important;
    }
  ` });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const enlarged = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  }));
  if (enlarged.scrollWidth > enlarged.clientWidth + 1) {
    failures.push(`${engineName} ${surface} ${width}px overflows at 200% text by ${enlarged.scrollWidth - enlarged.clientWidth}px`);
  }
}

async function unlockRally(page) {
  await page.locator('#cmdUnlock').click();
  if (await page.locator('#pwOvl').evaluate(element => element.classList.contains('show'))) {
    await page.locator('#pwInput').fill(QA_PASSWORD);
    await page.locator('#pwGo').click();
  }
  await page.locator('#console[data-drawer-state="command"]').waitFor({ timeout: 10_000 });
}

async function unlockDefense(page) {
  await page.locator('#defenseConsoleEntry').click();
  if (await page.locator('#defenseManagerUnlock').isVisible()) {
    await page.locator('#defenseManagerPassword').fill(QA_PASSWORD);
    await page.locator('#defenseManagerUnlockSubmit').click();
  }
  await page.locator('#defenseManagerDrawer[data-drawer-state="command"]').waitFor({ timeout: 10_000 });
}

async function bootstrapPassword(browser, baseURL) {
  const context = await guardedContext(browser, baseURL);
  const errors = [];
  const page = await openSurface(context, baseURL, 'defense', errors);
  await unlockDefense(page);
  assert.deepEqual(errors, []);
  await context.close();
}

async function keyboardFocus(page, id) {
  // A real Tab establishes keyboard modality in every engine. WebKit inherits the
  // host's "Tab through all controls" preference, so target selection itself is
  // deterministic while :focus-visible still comes from keyboard modality.
  await page.keyboard.press('Tab');
  await page.locator(`#${id}`).focus();
  assert.equal(await page.evaluate(target => document.activeElement && document.activeElement.id === target, id), true,
    `keyboard focus reaches #${id}`);
}

async function verifyRallyDrawerFocus(browser, baseURL, engineName) {
  const context = await guardedContext(browser, baseURL);
  const errors = [];
  const page = await openSurface(context, baseURL, 'rally', errors);
  await keyboardFocus(page, 'cmdUnlock');
  assert.notEqual(await page.locator('#cmdUnlock').evaluate(element => getComputedStyle(element).outlineStyle), 'none',
    `${engineName} Rally keyboard focus is visible`);
  await unlockRally(page);
  await page.locator('#commanderManageOpen').focus();
  await page.keyboard.press('Enter');
  await page.locator('#console[data-drawer-state="manage"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'commanderManageBack', `${engineName} Rally Manage receives focus`);
  await page.keyboard.press('Enter');
  await page.locator('#console[data-drawer-state="command"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'commanderManageOpen', `${engineName} Rally returns focus to the pane trigger`);
  await page.locator('#commanderDrawerClose').click();
  await page.locator('#console[data-drawer-state="closed"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cmdUnlock', `${engineName} Rally collapse restores the console opener`);
  assert.deepEqual(errors, []);
  await context.close();
}

async function verifyDefenseDrawerFocus(browser, baseURL, engineName) {
  const context = await guardedContext(browser, baseURL);
  const errors = [];
  const page = await openSurface(context, baseURL, 'defense', errors);
  await keyboardFocus(page, 'defenseConsoleEntry');
  assert.notEqual(await page.locator('#defenseConsoleEntry').evaluate(element => getComputedStyle(element).outlineStyle), 'none',
    `${engineName} Defense keyboard focus is visible`);
  await unlockDefense(page);
  await page.locator('#defenseManagerOpenManage').focus();
  await page.keyboard.press('Enter');
  await page.locator('#defenseManagerDrawer[data-drawer-state="manage"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'defenseManagerBack', `${engineName} Defense Manage receives focus`);
  await page.keyboard.press('Enter');
  await page.locator('#defenseManagerDrawer[data-drawer-state="command"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'defenseManagerOpenManage', `${engineName} Defense returns focus to the pane trigger`);
  await page.locator('#defenseManagerClose').click();
  await page.locator('#defenseManagerDrawer[data-drawer-state="closed"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'defenseConsoleEntry', `${engineName} Defense collapse restores the console opener`);
  assert.deepEqual(errors, []);
  await context.close();
}

async function verifyReducedMotion(browser, baseURL, surface, engineName, failures) {
  const context = await guardedContext(browser, baseURL, { reducedMotion: 'reduce' });
  const errors = [];
  const page = await openSurface(context, baseURL, surface, errors);
  if (surface === 'rally') await unlockRally(page); else await unlockDefense(page);
  const selector = surface === 'rally' ? '#console' : '#defenseManagerDrawer';
  const state = await page.locator(selector).evaluate(element => ({
    motion: element.dataset.drawerMotion,
    transition: getComputedStyle(element).transitionDuration,
    settling: element.classList.contains('is-settling')
  }));
  if (state.motion !== 'static') failures.push(`${engineName} ${surface} does not mark its reduced-motion drawer static`);
  if (state.transition !== '0s') failures.push(`${engineName} ${surface} reduced-motion drawer transition remains ${state.transition}`);
  if (state.settling) failures.push(`${engineName} ${surface} leaves a reduced-motion drawer settling`);
  errors.forEach(error => failures.push(`${engineName} reduced-motion ${error}`));
  await context.close();
}

async function verifyReducedTransparency(browser, baseURL, surface, failures) {
  const context = await guardedContext(browser, baseURL);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
  });
  const url = surface === 'rally' ? qaRoomUrl(baseURL, QA_ROOM, { notour: 1, lang: 'en' })
    : qaDefenseUrl(baseURL, QA_ROOM, { lang: 'en' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (surface === 'rally') { await page.locator('#soundGate').click({ force: true }).catch(() => {}); await unlockRally(page); }
  else await unlockDefense(page);
  const selector = surface === 'rally' ? '#console .battle-drawer__header' : '#defenseManagerHandle';
  const alpha = await page.locator(selector).evaluate(element => {
    const values = getComputedStyle(element).backgroundColor.match(/[\d.]+/g).map(Number);
    return values.length > 3 ? values[3] : 1;
  });
  if (alpha !== 1) failures.push(`Chromium ${surface} reduced-transparency command surface alpha remains ${alpha}`);
  await context.close();
}

async function registerRallyCaptain(browser, baseURL, pid, march) {
  const context = await guardedContext(browser, baseURL);
  const page = await openSurface(context, baseURL, 'rally', []);
  await page.locator('#pid').fill(pid);
  await page.waitForTimeout(1_700);
  await page.locator('#marchRange').fill(String(march));
  await page.locator('#saveBtn').click();
  await page.locator('#youChip').waitFor({ state: 'visible', timeout: 10_000 });
  return { context, page, pid };
}

async function verifySilentRallyCommander(browser, baseURL) {
  const captainA = await registerRallyCaptain(browser, baseURL, '930000001', 34);
  const captainB = await registerRallyCaptain(browser, baseURL, '930000002', 36);
  const commanderContext = await guardedContext(browser, baseURL);
  const commander = await openSurface(commanderContext, baseURL, 'rally', []);
  try {
    await unlockRally(commander);
    await commander.locator('#commanderManageOpen').click();
    await commander.locator('#commanderManagePane').waitFor({ state: 'visible' });
    await commander.locator(`#roster .rp[data-pid="${captainA.pid}"]`).click();
    await commander.locator(`#roster .rp[data-pid="${captainB.pid}"]`).click();
    await commander.waitForFunction(() => document.querySelector('#pickCnt')?.textContent.trim() === '2/2');
    await commander.locator('#commanderManageBack').click();
    await commander.locator('#lead button[data-v="30"]').click();
    await commander.locator('#fireDouble').click();
    await commander.waitForTimeout(250);
    await commander.locator('#fireDouble').click();
    await commander.waitForFunction(() => document.querySelectorAll('#commanderLaunchMonitor .clm-row').length === 2,
      null, { timeout: 10_000 });
    const state = await commander.evaluate(() => ({
      monitorVisible: !document.querySelector('#commanderLaunchMonitor').classList.contains('hide'),
      rows: document.querySelectorAll('#commanderLaunchMonitor .clm-row').length,
      personalHidden: document.querySelector('#phero').classList.contains('hide'),
      personalAudio: Object.keys(window.__cues || {}).filter(key => /-(?:me|join):/.test(key))
    }));
    assert.deepEqual(state, { monitorVisible: true, rows: 2, personalHidden: true, personalAudio: [] },
      'an unselected Rally commander sees every launch visually while remaining completely silent');
    await commander.locator('#cancelBtn').click(); await commander.locator('#cancelBtn').click();
  } finally {
    await Promise.all([captainA.context.close(), captainB.context.close(), commanderContext.close()]);
  }
}

(async () => {
  let server;
  const launched = [];
  try {
    server = await startIsolatedWrangler();
    const bootstrapBrowser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    launched.push(bootstrapBrowser);
    await bootstrapPassword(bootstrapBrowser, server.baseURL);

    const failures = [];
    for (const [engineName, browserType] of engines) {
      const browser = engineName === 'Chromium'
        ? bootstrapBrowser : await browserType.launch({ headless: true });
      if (browser !== bootstrapBrowser) launched.push(browser);
      for (const width of widths) {
        for (const surface of ['rally', 'defense']) {
          const context = await guardedContext(browser, server.baseURL, { viewport: { width, height: 844 }, hasTouch: true });
          const errors = [];
          const page = await openSurface(context, server.baseURL, surface, errors);
          await mobileAudit(page, surface, engineName, width, failures);
          errors.forEach(error => failures.push(`${engineName} ${width}px ${error}`));
          await context.close();
        }
      }
      await verifyRallyDrawerFocus(browser, server.baseURL, engineName);
      await verifyDefenseDrawerFocus(browser, server.baseURL, engineName);
      await verifyReducedMotion(browser, server.baseURL, 'rally', engineName, failures);
      await verifyReducedMotion(browser, server.baseURL, 'defense', engineName, failures);
    }

    await verifyReducedTransparency(bootstrapBrowser, server.baseURL, 'rally', failures);
    await verifyReducedTransparency(bootstrapBrowser, server.baseURL, 'defense', failures);
    await verifySilentRallyCommander(bootstrapBrowser, server.baseURL);

    assert.deepEqual(failures, [], `coordination mobile accessibility failures:\n${failures.join('\n')}`);
    console.log('✓ Coordination accessibility: Rally/Defense, Chromium/Firefox/WebKit, 320–430px, 200% text, focus, preferences, silent commander');
  } finally {
    await Promise.all(launched.map(browser => browser.close().catch(() => {})));
    await stopWrangler(server);
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
