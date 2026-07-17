const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const PUBLIC = path.join(__dirname, '../public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};

function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/time') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ t: Date.now() }));
      return;
    }
    const relative = url.pathname === '/' || url.pathname === '/defense'
      ? 'defense.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC, relative);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end('not found'); return;
    }
    response.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function player(index, overrides = {}) {
  return {
    pid: `p${String(index).padStart(3, '0')}`,
    identityMode: index % 2 ? 'nickname' : 'playerId',
    playerId: index % 2 ? undefined : String(900000000 + index),
    name: index % 2 ? `Player ${index}` : `Kimchi ${index}`,
    march: 20 + (index % 80), revision: 0, profileGeneration: index + 1,
    pendingRemoval: false, connectedDevices: index % 11 ? 1 : 0,
    audioReadyDevices: index % 7 ? 1 : 0, clockFreshDevices: 1,
    readyDevices: index % 7 && index % 11 ? 1 : 0, activeRound: null,
    ...overrides
  };
}

function installDefenseSocket(page, options = {}) {
  let roster = Array.from({ length: options.count || 150 }, (_, index) => player(index));
  let rosterRevision = roster.length;
  let orderRevision = 0;
  let config = { tapAnchorSeconds: 180, enemyMarchSeconds: 30, revision: 1, updatedAt: null };
  let activeOrder = null;
  let ownProfile = null;
  const outbound = [];

  function activeRow(row) {
    if (!activeOrder) return { ...row, activeRound: null };
    const goAtMs = activeOrder.enemyImpactAtMs - row.march * 1000;
    return {
      ...row,
      activeRound: {
        displayName: row.name, identityMode: row.identityMode,
        playerId: row.playerId, march: row.march, marchRevision: row.revision,
        connectedAtAcceptance: row.connectedDevices > 0, validAtAcceptance: true,
        targeted: row.connectedDevices > 0, goAtMs,
        tooLate: false, outcome: 'unconfirmed', acknowledgedDevices: 0,
        scheduledDevices: 0, deliveredScheduled: false, audioReady: false
      }
    };
  }

  function pageProjection(pageNumber) {
    const items = roster.slice((pageNumber - 1) * 50, pageNumber * 50).map(activeRow);
    return {
      page: pageNumber, pageSize: 50, total: roster.length,
      totalPages: Math.max(1, Math.ceil(roster.length / 50)),
      rosterRevision, baseRosterRevision: rosterRevision,
      baseOrderRevision: orderRevision, items
    };
  }

  function counts() {
    return {
      registeredProfiles: roster.length,
      connectedProfiles: roster.filter(row => row.connectedDevices > 0).length,
      audioReadyProfiles: roster.filter(row => row.audioReadyDevices > 0).length,
      readyProfiles: roster.filter(row => row.readyDevices > 0).length,
      pendingRemovalProfiles: roster.filter(row => row.pendingRemoval).length
    };
  }

  function managerOrder() {
    if (!activeOrder) return null;
    const targeted = roster.filter(row => row.connectedDevices > 0).length;
    return {
      ...activeOrder,
      counts: {
        registeredAtAcceptance: roster.length, targetedProfiles: targeted,
        offlineRosterProfiles: roster.length - targeted,
        invalidTimeProfiles: 0, tooLateProfiles: 0
      },
      delivery: {
        targetedProfiles: targeted, deliveredScheduledProfiles: 0,
        audioReadyProfiles: 0, redUnconfirmedProfiles: targeted,
        offlineRosterProfiles: roster.length - targeted,
        invalidTimeProfiles: 0, tooLateProfiles: 0
      }
    };
  }

  function managerState() {
    const order = managerOrder();
    return {
      t: 'defenseManagerState', config: { ...config }, counts: counts(),
      issues: order ? [
        { code: 'offline_roster', count: order.counts.offlineRosterProfiles },
        { code: 'red_unconfirmed', count: order.delivery.redUnconfirmedProfiles }
      ].filter(issue => issue.count) : [],
      distribution: [], activeOrder: order, playersPage: pageProjection(1),
      managerClockFresh: true, managerLeaseUntilMs: Date.now() + 70_000,
      rosterRevision, orderRevision
    };
  }

  function defenseState() {
    let personal = null;
    if (activeOrder && ownProfile) {
      personal = {
        ...activeOrder, pid: ownProfile.pid, displayName: ownProfile.name,
        march: ownProfile.march, marchRevision: ownProfile.revision,
        goAtMs: activeOrder.enemyImpactAtMs - ownProfile.march * 1000,
        tooLate: false
      };
    }
    return {
      t: 'defenseState', config: { ...config }, ownProfile,
      activeOrderForOwnProfile: personal,
      readiness: ownProfile ? {
        pid: ownProfile.pid, connectedDevices: 1, audioReadyDevices: 0,
        clockFreshDevices: 1, readyDevices: 0
      } : { pid: '', connectedDevices: 0, audioReadyDevices: 0, clockFreshDevices: 0, readyDevices: 0 },
      orderRevision
    };
  }

  function send(socket, value) { socket.send(JSON.stringify(value)); }

  return page.routeWebSocket(/\/api\/ws\?/, socket => {
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      outbound.push(message);
      if (message.t === 'hello') send(socket, defenseState());
      else if (message.t === 'defenseUnlock') send(socket, managerState());
      else if (message.t === 'defenseManagerStatus') {
        send(socket, {
          t: 'defenseManagerStatusSaved', managerClockFresh: message.clockFresh === true,
          managerLeaseUntilMs: Date.now() + 70_000, orderRevision
        });
      } else if (message.t === 'getDefenseManagerPlayersPage') {
        send(socket, {
          t: 'defenseManagerPlayersPage', playersPage: pageProjection(message.page),
          rosterRevision, orderRevision,
          activeOrderId: activeOrder && activeOrder.id,
          activeOrderRevision: activeOrder && activeOrder.revision
        });
      } else if (message.t === 'setDefenseConfig') {
        config = {
          tapAnchorSeconds: message.tapAnchorSeconds,
          enemyMarchSeconds: message.enemyMarchSeconds,
          revision: config.revision + 1, updatedAt: new Date().toISOString()
        };
        send(socket, { t: 'defenseConfigSaved', mutationId: message.mutationId, config: { ...config }, revision: config.revision });
        send(socket, managerState());
      } else if (message.t === 'setDefensePlayerMarch') {
        const index = roster.findIndex(row => row.pid === message.pid);
        if (index >= 0) roster[index] = { ...roster[index], march: message.march, revision: roster[index].revision + 1 };
        send(socket, {
          t: 'defenseProfileDelta', mutationId: message.mutationId,
          rosterRevision, profile: index >= 0 ? { ...roster[index] } : null,
          appliesNextRound: !!activeOrder
        });
      } else if (message.t === 'removeDefensePlayer') {
        const index = roster.findIndex(row => row.pid === message.pid);
        if (index >= 0) roster.splice(index, 1);
        rosterRevision += 1;
        send(socket, {
          t: 'defenseProfileDelta', mutationId: message.mutationId,
          pid: message.pid, removed: true, pending: false,
          rosterRevision, profile: null
        });
      } else if (message.t === 'registerPlayer') {
        ownProfile = {
          pid: message.pid, identityMode: message.identityMode,
          playerId: message.playerId, name: message.name, march: message.march,
          revision: 0, profileGeneration: rosterRevision + 1, pendingRemoval: false
        };
        roster.push(player(roster.length, {
          ...ownProfile, connectedDevices: 1, audioReadyDevices: 0,
          clockFreshDevices: 1, readyDevices: 0
        }));
        rosterRevision += 1;
        send(socket, {
          t: 'defenseProfileDelta', registrationId: message.registrationId,
          rosterRevision, profile: { ...ownProfile }
        });
        send(socket, defenseState());
      } else if (message.t === 'defenseDeviceStatus' || message.t === 'hb') {
        if (ownProfile) send(socket, {
          t: 'defenseDeviceStatusSaved', pid: ownProfile.pid,
          deviceId: message.deviceId, soundReady: message.soundReady === true,
          clockFresh: message.clockFresh === true
        });
      } else if (message.t === 'fireDefense') {
        orderRevision += 1;
        const signalAtMs = message.signalAtMs;
        activeOrder = {
          id: `order-${orderRevision}`, revision: orderRevision,
          signalAtMs, acceptedAtMs: signalAtMs + 5,
          tapAnchorSeconds: config.tapAnchorSeconds,
          enemyMarchSeconds: config.enemyMarchSeconds,
          enemyLaunchAtMs: signalAtMs + config.tapAnchorSeconds * 1000,
          enemyImpactAtMs: signalAtMs + (config.tapAnchorSeconds + config.enemyMarchSeconds) * 1000,
          completeAtMs: signalAtMs + (config.tapAnchorSeconds + 1) * 1000
        };
        const accepted = ownProfile ? {
          ...activeOrder, pid: ownProfile.pid, displayName: ownProfile.name,
          march: ownProfile.march, marchRevision: ownProfile.revision,
          goAtMs: activeOrder.enemyImpactAtMs - ownProfile.march * 1000,
          tooLate: false
        } : managerOrder();
        send(socket, { t: 'defenseOrderAccepted', order: accepted });
        send(socket, defenseState());
        send(socket, managerState());
      } else if (message.t === 'cancelDefense') {
        const id = activeOrder && activeOrder.id;
        orderRevision += 1;
        activeOrder = null;
        send(socket, { t: 'defenseOrderCancelled', orderId: id, revision: orderRevision });
        send(socket, defenseState());
        send(socket, managerState());
      }
    });
  }).then(() => ({ outbound }));
}

async function unlockManager(page) {
  await page.locator('#defenseConsoleEntry').click();
  await page.locator('#defenseManagerUnlock').waitFor({ state: 'visible' });
  await page.locator('#defenseManagerPassword').fill('qa');
  await page.locator('#defenseManagerUnlockSubmit').click();
  await page.locator('#defenseManagerDrawer[data-drawer-state="command"]').waitFor();
  await page.waitForFunction(() => /clock synced/.test(document.querySelector('#defenseManagerConnection').textContent));
}

async function runManagerOnly(browser, baseURL, width) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const mock = await installDefenseSocket(page, { count: 150 });
  await page.goto(`${baseURL}/defense?room=qa&lang=en`);
  if (width === 390) {
    await page.locator('#defenseConsoleEntry').click();
    await page.locator('#defenseManagerUnlock').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#defenseMain').evaluate(node => node.inert), true,
      'an aria-modal manager dialog makes its background inert');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'defenseManagerPassword');
    await page.keyboard.press('Escape');
    await page.locator('#defenseManagerUnlock').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'defenseConsoleEntry',
      'Escape closes a safe dialog and restores its opener');
  }
  await unlockManager(page);
  assert.equal(await page.locator('#defenseManagerUnlock').isHidden(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

  await page.locator('#defenseManagerOpenManage').click();
  await page.locator('#defenseManagerDrawer[data-drawer-state="manage"]').waitFor();
  await page.locator('#defenseManagerPlayersTab').click();
  await page.waitForFunction(() => /150 loaded/.test(document.querySelector('#defenseManagerRosterStatus').textContent));
  const rendered = await page.locator('#defenseManagerPlayerList [role="option"]').count();
  assert.ok(rendered > 0 && rendered < 30, `${width}px virtual roster stays bounded (${rendered})`);
  assert.equal(await page.locator('#defenseManagerPlayerList [role="option"] button').count(), 0,
    'each virtual option is the only activation target; no nested button creates a second focus model');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.equal(await page.locator('[role="tab"]').count(), 2);

  if (width === 390) {
    await page.locator('#defenseManagerPlayerList').focus();
    await page.keyboard.press('Enter');
    await page.locator('#defenseManagerPlayerDetail').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'defenseManagerPlayerBack',
      'keyboard activation moves focus into the revealed detail');
    await page.locator('#defenseManagerPlayerBack').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'defenseManagerPlayerList');
    assert.equal(await page.evaluate(() => {
      const list = document.querySelector('#defenseManagerPlayerList');
      const active = document.getElementById(list.getAttribute('aria-activedescendant'));
      return Boolean(active && active.getAttribute('role') === 'option');
    }), true, 'Back restores the listbox and its selected option');
    assert.equal(await page.evaluate(() => {
      const list = document.querySelector('#defenseManagerPlayerList');
      const active = document.getElementById(list.getAttribute('aria-activedescendant'));
      const style = getComputedStyle(active);
      return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
    }), true, 'the keyboard-active option has a visible non-color-only focus treatment');
  }

  const expectedRed = Array.from({ length: 150 }, (_, index) => index)
    .filter(index => index % 11 !== 0 && !(index % 7 !== 0 && index % 11 !== 0)).length;
  assert.equal(Number(await page.locator('#defenseManagerRed').textContent()), expectedRed,
    'Red means connected but not ready; offline profiles are not relabelled red');
  await page.locator('#defenseManagerStatusTab').click();
  assert.equal(await page.locator('.defense-manager__metric').filter({ hasText: 'Red / unconfirmed' })
    .locator('strong').textContent(), String(expectedRed),
  'waiting Status uses the same truthful red count');
  await page.locator('#defenseManagerPlayersTab').click();

  if (width === 390) {
    await page.locator('#defenseManagerSearch').fill('Player 149');
    await page.waitForFunction(() => /^1 shown/.test(document.querySelector('#defenseManagerRosterStatus').textContent));
    await page.locator('.defense-manager__player-card').click();
    await page.locator('#defenseManagerPlayerDetail').waitFor({ state: 'visible' });
    await page.locator('#defenseManagerPlayerMarch').fill('44');
    await page.locator('#defenseManagerSavePlayer').click();
    await page.waitForFunction(() => document.querySelector('#defenseManagerPlayerMarch').value === '44');
    await page.locator('#defenseManagerRemovePlayer').click();
    await page.locator('#defenseManagerRemoveConfirm').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#defenseManagerDrawer').evaluate(node => node.inert), true);
    await page.keyboard.press('Escape');
    await page.locator('#defenseManagerRemoveConfirm').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'defenseManagerRemovePlayer');
    await page.locator('#defenseManagerRemovePlayer').click();
    await page.locator('#defenseManagerRemoveYes').click();
    await page.waitForFunction(() => {
      const state = window.defenseManagerController.state();
      return state.rosterHydrated && state.players.length === 149;
    });
    await page.locator('#defenseManagerPlayerDetail').waitFor({ state: 'hidden' });
    await page.locator('#defenseManagerBack').click();
    await page.locator('#defenseManagerDrawer[data-drawer-state="command"]').waitFor();
    await page.locator('#defenseManagerFire').click();
    await page.locator('#defenseManagerCancel').waitFor({ state: 'visible' });
    const audioReadyMetric = page.locator('.defense-manager__metric').filter({ hasText: 'Audio ready' });
    assert.equal(await audioReadyMetric.locator('strong').textContent(), '0',
      'an active round preserves the canonical zero instead of falling back to waiting readiness');
    assert.equal(await page.locator('.defense-manager__metric').filter({ hasText: 'Next alert' }).count(), 1,
      'active Status exposes the next website alert wave');
    await page.evaluate(() => {
      const controller = window.defenseManagerController;
      const state = controller.state();
      const profile = state.players.find(row => row.activeRound && row.activeRound.targeted && !row.activeRound.tooLate);
      controller.handleMessage({
        t: 'defenseAckSaved', orderId: state.activeOrder.id,
        revision: state.activeOrder.revision, pid: profile.pid,
        profileDelivery: {
          pid: profile.pid, goAtMs: profile.activeRound.goAtMs, tooLate: false,
          outcome: 'scheduled', acknowledgedDevices: 1, scheduledDevices: 1,
          deliveredScheduled: true, audioReady: true
        }
      });
    });
    await page.waitForFunction(() => {
      const metrics = [...document.querySelectorAll('.defense-manager__metric')];
      return metrics.some(metric => /Scheduled/.test(metric.textContent) && metric.querySelector('strong').textContent === '1') &&
        metrics.some(metric => /Audio ready/.test(metric.textContent) && metric.querySelector('strong').textContent === '1');
    });
    assert.equal(mock.outbound.filter(message => message.t === 'defenseOrderAck').length, 0,
      'a manager-only page never schedules or acknowledges personal audio');
    await page.locator('#defenseManagerCancel').click();
    await page.locator('#defenseManagerCancelConfirm').waitFor({ state: 'visible' });
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#defenseManagerCancelConfirm').evaluate(node => node.contains(document.activeElement)), true,
      'Tab remains trapped inside the active confirmation dialog');
    await page.keyboard.press('Escape');
    await page.locator('#defenseManagerCancelConfirm').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'defenseManagerCancel');
    await page.locator('#defenseManagerCancel').click();
    await page.locator('#defenseManagerCancelYes').click();
    await page.locator('#defenseManagerFire').waitFor({ state: 'visible' });
    await page.locator('#defenseManagerClose').click();
    await page.locator('#defenseManagerDrawer[data-drawer-state="closed"]').waitFor();
    await page.locator('#defenseConsoleEntry').click();
    await page.locator('#defenseManagerDrawer[data-drawer-state="command"]').waitFor();
    assert.equal(await page.locator('#defenseManagerUnlock').isHidden(), true,
      'collapsing and reopening retains successful page-memory authentication');
  }

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
    `${width}px remains horizontally safe at a 200% root text scale`);
  assert.deepEqual(pageErrors, []);
  await page.close();
}

async function runChineseManager(browser, baseURL) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await installDefenseSocket(page, { count: 12 });
  await page.goto(`${baseURL}/defense?room=qa&lang=zh`);
  await page.locator('#defenseConsoleEntry').click();
  assert.equal(await page.locator('#defenseManagerUnlockTitle').textContent(), '解锁防守指挥台');
  assert.equal(await page.locator('#defenseManagerUnlockSubmit').textContent(), '解锁');
  await page.locator('#defenseManagerPassword').fill('qa');
  await page.locator('#defenseManagerUnlockSubmit').click();
  await page.locator('#defenseManagerDrawer[data-drawer-state="command"]').waitFor();
  assert.equal(await page.locator('#defenseManagerTitle').textContent(), '防守指挥台');
  assert.equal(await page.locator('#defenseManagerOpenManage').textContent(), '管理');
  assert.equal(await page.locator('#defenseManagerSaveTiming').textContent(), '保存时间');
  await page.locator('#defenseManagerOpenManage').click();
  assert.deepEqual(await page.locator('[role="tab"]').allTextContents(), ['状态', '玩家']);
  assert.equal(await page.locator('#defenseManagerDisclaimer').textContent(),
    '仅显示网站送达状态；游戏不会回传参与或响应数据。');
  await page.close();
}

async function runManagerDefender(browser, baseURL) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const mock = await installDefenseSocket(page, { count: 2 });
  await page.goto(`${baseURL}/defense?room=qa&lang=en`);
  await page.locator('#defenseIdentityValue').fill('900000999');
  await page.locator('#defenseMarchRange').fill('30');
  await page.locator('#defenseSaveProfile').click();
  await page.locator('#defenseYouCard').waitFor({ state: 'visible' });
  await unlockManager(page);
  await page.locator('#defenseManagerFire').click();
  await page.locator('#defenseManagerPersonalCue').waitFor({ state: 'visible' });
  assert.match(await page.locator('#defenseManagerPersonalCue').textContent(), /Your cue/);
  assert.ok(mock.outbound.filter(message => message.t === 'defenseOrderAck').length <= 1,
    'manager+defender owns only the ordinary personal delivery path');
  await page.close();
}

(async () => {
  const server = await startServer();
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [320, 390, 430]) await runManagerOnly(browser, baseURL, width);
    await runManagerDefender(browser, baseURL);
    await runChineseManager(browser, baseURL);
    console.log('✓ Defense manager UI: mobile drawer, 150-player virtualization, edit/remove, Fire/cancel, silence, cue pill');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
