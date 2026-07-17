const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/defense.html'), 'utf8')
  .replace(/<link[^>]+rel="stylesheet"[^>]*>/gi, '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const css = [
  fs.readFileSync(path.join(root, 'public/app.css'), 'utf8'),
  fs.readFileSync(path.join(root, 'public/battle-ui.css'), 'utf8'),
  fs.readFileSync(path.join(root, 'public/defense.css'), 'utf8')
].join('\n');
const controllerSource = fs.readFileSync(path.join(root, 'public/defense-controller.js'), 'utf8');
const domainSource = fs.readFileSync(path.join(root, 'public/defense-domain.js'), 'utf8');
const drawerSource = fs.readFileSync(path.join(root, 'public/battle-drawer.js'), 'utf8');
const virtualListSource = fs.readFileSync(path.join(root, 'public/virtual-list.js'), 'utf8');
const managerSource = fs.readFileSync(path.join(root, 'public/defense-manager.js'), 'utf8');

async function install(page) {
  await page.setContent(html);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: controllerSource });
  await page.evaluate(() => {
    document.querySelector('#defenseJoin').hidden = true;
    document.querySelector('#defenseRoom').hidden = false;
    document.querySelector('#defenseProfileCard').hidden = true;
    document.querySelector('#defenseProgressCard').hidden = false;
    const you = document.querySelector('#defenseYouCard');
    you.hidden = false;
    document.querySelector('#defenseYouName').textContent =
      'A defender nickname that is deliberately much longer than one mobile line 绝对很长的昵称';
    document.querySelector('#defenseYouMarch').textContent = '2:00';
    const progress = document.querySelector('#defenseProgress');
    progress.setAttribute('aria-valuenow', '120');
    progress.setAttribute('aria-valuetext', '2:00 march time');
    progress.querySelector('.defense-progress__fill').style.width = '100%';
  });
}

async function verifyLiveRegion(engineName, browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await page.route('http://defense.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://defense.test/defense?room=qa&lang=en');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: `
    window.__nowMs = 1000000;
    window.__wire = [];
    window.BattleIdentity = {
      normalizeDraft(value) { return { ok: true, profile: value }; },
      cleanNickname(value) { return String(value || '').slice(0, 24); },
      createIdentityStore() {
        const confirmed = { pid: '900000001', identityMode: 'playerId', playerId: '900000001',
          name: 'Kimchi', march: 30, revision: 0, pendingRemoval: false,
          profileKey: '10000000-0000-4000-8000-000000000001' };
        return { readConfirmed: () => ({ ...confirmed }), readRallyPrefill: () => null,
          saveConfirmed: () => true, deviceId: () => '30000000-0000-4000-8000-000000000003' };
      }
    };
    window.BattleStatus = { deriveReadiness(input) {
      const green = input.userEnabled && input.audioContextRunning && input.carrierAlive &&
        input.connected && input.clockFresh;
      return { level: green ? 'ready' : 'not_ready', green, reasons: green ? [] : ['not_ready'] };
    } };
    window.BattleAudio = { createAudioEngine() {
      const ready = { userEnabled: true, audioContextRunning: true, carrierAlive: true };
      return { state: () => ({ ...ready }), enable: () => ({ ...ready }), playConfirm() {},
        resume() {}, requestWakeLock() {}, dispose() {} };
    } };
    window.BattleCues = { createCueScheduler() {
      let entries = [];
      return { reconcile(plans) {
          entries = plans.flatMap(plan => plan.events.map(event => ({
            key: plan.id + ':' + event.id, base: plan.id, scheduled: true, event
          })));
          return entries.length;
        }, snapshot: () => entries.slice(), cancelScope(scope) {
          const before = entries.length; entries = entries.filter(entry => !entry.base.startsWith(scope));
          return before - entries.length;
        }, cancelDrifted() { return false; }, dispose() {} };
    } };
    window.BattleDelivery = { createAckQueue() { return {
      enqueue() { return true; }, confirm() { return true; }, reject() { return true; },
      cancel() { return true; }, cancelScope() { return 1; }, pause() { return 0; },
      retryAll() { return 0; }, clear() {}
    }; } };
    window.BattleConnection = { createRoomConnection(options) {
      let connected = false;
      return { start() {
          connected = true;
          options.onConnectionChange({ connected: true, generation: 1 });
          options.onMessage({ t: 'defenseState', config: {},
            ownProfile: { pid: '900000001', identityMode: 'playerId', playerId: '900000001',
              name: 'Kimchi', march: 30, revision: 0, pendingRemoval: false },
            activeOrderForOwnProfile: { id: 'live-order', revision: 3, completeAtMs: 1022000,
              pid: '900000001', displayName: 'Kimchi', march: 30, marchRevision: 0,
              goAtMs: 1020000, tooLate: false }, readiness: {}, orderRevision: 3 });
        }, send(message) { window.__wire.push({ ...message }); return connected; },
        serverNowMs: () => window.__nowMs, clockFresh: () => true, generation: () => 1,
        connected: () => connected, stop() { connected = false; } };
    } };
  ` });
  await page.addScriptTag({ content: domainSource });
  await page.addScriptTag({ content: drawerSource });
  await page.addScriptTag({ content: virtualListSource });
  await page.addScriptTag({ content: managerSource });
  await page.addScriptTag({ content: controllerSource });

  const result = await page.evaluate(async () => {
    const live = document.querySelector('#defenseCountdownLive');
    const statusLabel = document.querySelector('#defenseStatusLabel');
    let mutations = 0;
    let statusMutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    const statusObserver = new MutationObserver(records => { statusMutations += records.length; });
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    statusObserver.observe(statusLabel, { childList: true, characterData: true, subtree: true });
    const frozenProgressBefore = document.querySelector('#defenseProgress').getAttribute('aria-valuenow');
    const frozenYouBefore = document.querySelector('#defenseYouMarch').textContent;
    window.defensePageController.handleMessage({
      t: 'defenseProfileDelta', profile: { pid: '900000001', identityMode: 'playerId',
        playerId: '900000001', name: 'Kimchi', march: 44, revision: 1, pendingRemoval: false }
    });
    const frozenProgressDuring = document.querySelector('#defenseProgress').getAttribute('aria-valuenow');
    const frozenYouDuring = document.querySelector('#defenseYouMarch').textContent;
    window.__nowMs = 1020000;
    window.defensePageController.tick();
    await Promise.resolve();
    const nowText = live.textContent;
    const afterNow = mutations;
    const statusAfterNow = statusMutations;
    for (let index = 0; index < 8; index += 1) window.defensePageController.tick();
    await Promise.resolve();
    const repeatedMutations = mutations - afterNow;
    const repeatedStatusMutations = statusMutations - statusAfterNow;
    window.defensePageController.handleMessage({
      t: 'defenseOrderCancelled', orderId: 'live-order', revision: 4
    });
    await Promise.resolve();
    const cancelledText = live.textContent;
    const canonicalProgressAfter = document.querySelector('#defenseProgress').getAttribute('aria-valuenow');
    const canonicalYouAfter = document.querySelector('#defenseYouMarch').textContent;
    window.defensePageController.handleMessage({
      t: 'defenseOrderAccepted', order: { id: 'live-order-2', revision: 5, completeAtMs: 1042000,
        pid: '900000001', displayName: 'Kimchi', march: 30, marchRevision: 0,
        goAtMs: 1040000, tooLate: false }
    });
    window.__nowMs = 1040000;
    window.defensePageController.tick();
    await Promise.resolve();
    const secondNow = live.textContent;
    window.__nowMs = 1041001;
    window.defensePageController.tick();
    await Promise.resolve();
    const completedText = live.textContent;
    observer.disconnect();
    statusObserver.disconnect();
    document.querySelector('#defenseLanguage').click();
    const zhAria = {
      language: document.querySelector('#defenseLanguage').getAttribute('aria-label'),
      identity: document.querySelector('#defenseIdentityMode').getAttribute('aria-label'),
      minus: document.querySelector('#defenseMarchMinus').getAttribute('aria-label'),
      plus: document.querySelector('#defenseMarchPlus').getAttribute('aria-label'),
      profile: document.querySelector('#defenseYouCard').getAttribute('aria-label'),
      room: document.querySelector('#defenseRoomLabel').textContent
    };
    return { frozenProgressBefore, frozenProgressDuring, canonicalProgressAfter,
      frozenYouBefore, frozenYouDuring, canonicalYouAfter,
      nowText, repeatedMutations, repeatedStatusMutations, cancelledText, secondNow, completedText, zhAria };
  });
  assert.deepEqual(result, {
    frozenProgressBefore: '30', frozenProgressDuring: '30', canonicalProgressAfter: '44',
    frozenYouBefore: '0:30', frozenYouDuring: '0:30', canonicalYouAfter: '0:44',
    nowText: 'Now', repeatedMutations: 0, repeatedStatusMutations: 0,
    cancelledText: 'Order cancelled',
    secondNow: 'Now', completedText: '',
    zhAria: { language: '切换语言', identity: '身份类型', minus: '减少行军时间',
      plus: '增加行军时间', profile: '你的防守资料', room: '房间 · qa' }
  }, `${engineName} live region transitions are exact and chatter-free`);
  await page.close();
}

async function verify(engineName, browserType) {
  const browser = await browserType.launch({ headless: true });
  try {
    for (const width of [320, 375, 390, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await install(page);
      const formControls = await page.evaluate(() => {
        document.querySelector('#defenseProfileCard').hidden = false;
        document.querySelector('#defenseYouCard').hidden = true;
        return [...document.querySelectorAll('#defenseProfileCard button, #defenseProfileCard input')]
          .filter(element => element.offsetParent !== null)
          .map(element => {
            const rect = element.getBoundingClientRect();
            return { id: element.id, width: rect.width, height: rect.height, type: element.type };
          });
      });
      for (const control of formControls) {
        assert.ok(control.width >= 44 && control.height >= 44,
          `${engineName} ${width}px ${control.id} has a 44px form hit region`);
      }
      await page.focus('#defenseModePlayerId');
      await page.keyboard.press('ArrowRight');
      assert.deepEqual(await page.evaluate(() => ({
        active: document.activeElement.id,
        playerChecked: document.querySelector('#defenseModePlayerId').getAttribute('aria-checked'),
        playerTab: document.querySelector('#defenseModePlayerId').tabIndex,
        nicknameChecked: document.querySelector('#defenseModeNickname').getAttribute('aria-checked'),
        nicknameTab: document.querySelector('#defenseModeNickname').tabIndex
      })), {
        active: 'defenseModeNickname', playerChecked: 'false', playerTab: -1,
        nicknameChecked: 'true', nicknameTab: 0
      });
      await page.keyboard.press('Home');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'defenseModePlayerId');
      await page.focus('#defenseModeNickname');
      await page.keyboard.press('Space');
      assert.deepEqual(await page.evaluate(() => ({
        active: document.activeElement.id,
        checked: document.querySelector('#defenseModeNickname').getAttribute('aria-checked')
      })), { active: 'defenseModeNickname', checked: 'true' },
      `${engineName} keyboard activation keeps focus in the custom radiogroup`);
      await page.focus('#defenseModePlayerId');
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => ({
        active: document.activeElement.id,
        checked: document.querySelector('#defenseModePlayerId').getAttribute('aria-checked')
      })), { active: 'defenseModePlayerId', checked: 'true' },
      `${engineName} Enter activation keeps focus in the custom radiogroup`);
      await page.evaluate(() => {
        document.querySelector('#defenseProfileCard').hidden = true;
        document.querySelector('#defenseYouCard').hidden = false;
      });
      const alertCopyLayout = await page.evaluate(() => {
        const label = document.querySelector('#defenseAudioLabel');
        return ['Alerts on · switch to the game', '提醒已开启 · 可切换到游戏'].map(copy => {
          label.textContent = copy;
          const style = getComputedStyle(label);
          const range = document.createRange();
          range.selectNodeContents(label);
          return { copy, fragments: range.getClientRects().length,
            textWidth: range.getBoundingClientRect().width,
            availableWidth: label.getBoundingClientRect().width,
            fontSize: parseFloat(style.fontSize) };
        });
      });
      for (const measurement of alertCopyLayout) {
        assert.equal(measurement.fragments, 1,
          `${engineName} ${width}px ready copy stays on one line: ${measurement.copy}`);
        assert.ok(measurement.textWidth <= measurement.availableWidth + 0.5,
          `${engineName} ${width}px ready copy fits without clipping: ${measurement.copy}`);
        assert.ok(measurement.fontSize >= 11,
          `${engineName} ${width}px ready copy remains at least 11px`);
      }
      const before = await page.evaluate(() => ({
        pageHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        inputFont: parseFloat(getComputedStyle(document.querySelector('#defenseIdentityValue')).fontSize),
        controls: [...document.querySelectorAll('button, input')].filter(element => element.offsetParent !== null).map(element => {
          const rect = element.getBoundingClientRect();
          return { id: element.id, width: rect.width, height: rect.height, type: element.type };
        }),
        name: (() => {
          const element = document.querySelector('#defenseYouName');
          const style = getComputedStyle(element);
          return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, overflow: style.overflow,
            textOverflow: style.textOverflow, whiteSpace: style.whiteSpace };
        })(),
        progress: {
          role: document.querySelector('#defenseProgress').getAttribute('role'),
          value: document.querySelector('#defenseProgress').getAttribute('aria-valuenow'),
          text: document.querySelector('#defenseProgress').getAttribute('aria-valuetext')
        },
        status: document.querySelector('#defenseStatus').textContent.trim(),
        statusMark: document.querySelector('#defenseStatus .battle-status-strip__mark').textContent.trim()
      }));
      assert.ok(before.scrollWidth <= before.clientWidth, `${engineName} ${width}px no horizontal overflow`);
      assert.ok(before.inputFont >= 16, `${engineName} ${width}px input prevents iOS focus zoom`);
      for (const control of before.controls) {
        assert.ok(control.width >= 44 && control.height >= 44,
          `${engineName} ${width}px ${control.id} has a 44px hit region`);
      }
      assert.equal(before.name.overflow, 'hidden');
      assert.equal(before.name.textOverflow, 'ellipsis');
      assert.equal(before.name.whiteSpace, 'nowrap');
      assert.ok(before.name.scrollWidth > before.name.clientWidth, `${engineName} ${width}px long name truncates`);
      assert.deepEqual(before.progress, { role: 'progressbar', value: '120', text: '2:00 march time' });
      assert.ok(before.status.length > 0 && before.statusMark.length > 0,
        `${engineName} status has text and a non-color marker`);

      const after = await page.evaluate(() => {
        window.__managerSnapshotFixture = {
          t: 'defenseManagerState',
          playersPage: { items: Array.from({ length: 100 }, (_, index) => ({ pid: `p${index}` })) }
        };
        return {
          pageHeight: document.documentElement.scrollHeight,
          rosterNodes: document.querySelectorAll('[data-defense-player], .defense-player-card').length
        };
      });
      assert.equal(after.pageHeight, before.pageHeight,
        `${engineName} ${width}px ordinary height is independent of 100 manager profiles`);
      assert.equal(after.rosterNodes, 0);
      await page.close();
    }
    await verifyLiveRegion(engineName, browser);
  } finally {
    await browser.close();
  }
}

(async () => {
  for (const [name, type] of [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]]) {
    await verify(name, type);
  }
  console.log('Defense ordinary mobile UI: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
