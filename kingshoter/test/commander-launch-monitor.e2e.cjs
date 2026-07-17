const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard,
  localQaBaseURL
} = require('./support/qa-coordination.cjs');

const CAPTAINS = [
  { pid: '910000001', march: 34 },
  { pid: '910000002', march: 36 },
  { pid: '910000003', march: 38 },
  { pid: '910000004', march: 40 }
];
const MEMBER = { pid: '910000005', march: 42 };

function check(condition, label) {
  assert.ok(condition, label);
  console.log(`✓ ${label}`);
}

(async () => {
  const host = localQaBaseURL(process.argv[2] || 'http://127.0.0.1:8791');
  const room = makeQaRoom('commander-launch-monitor');
  const url = qaRoomUrl(host, room, { notour: 1, lang: 'en' });
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  const contexts = [];
  const pageErrors = [];

  async function openPage(label, width = 390) {
    const context = await browser.newContext({
      viewport: { width, height: 1_300 },
      locale: 'en-US'
    });
    contexts.push(context);
    await installQaWebSocketGuard(context, room, { expectedOrigin: host });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(`${label}: ${error.message}`));
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.locator('#soundGate').click({ force: true }).catch(() => {});
    await page.waitForTimeout(150);
    return page;
  }

  async function registerPlayer(player) {
    const page = await openPage(player.pid);
    await page.locator('#pid').fill(player.pid);
    await page.waitForTimeout(1_700);
    await page.locator('#marchRange').fill(String(player.march));
    await page.locator('#saveBtn').click();
    await page.locator('#youChip').waitFor({ state: 'visible', timeout: 8_000 });
    return page;
  }

  async function unlockCommander(page) {
    await page.locator('#cmdUnlock').click();
    await page.locator('#pwInput').fill('666');
    await page.locator('#pwGo').click();
    await page.locator('#console[data-drawer-state="command"]').waitFor({ timeout: 8_000 });
    await page.locator('#commanderCommandPane').waitFor({ state: 'visible', timeout: 8_000 });
  }

  async function selectPair(page, kingdom, pair) {
    await page.locator(`#kingdomPick button[data-k="${kingdom}"]`).click();
    await page.locator('#commanderManageOpen').click();
    await page.locator('#commanderManagePane').waitFor({ state: 'visible' });
    for (const player of pair) {
      await page.locator(`#roster .rp[data-pid="${player.pid}"]`).click();
    }
    await page.waitForFunction(
      () => document.querySelector('#pickCnt')?.textContent?.trim() === '2/2',
      null,
      { timeout: 8_000 }
    );
    await page.locator('#commanderManageBack').click();
    await page.locator('#commanderCommandPane').waitFor({ state: 'visible' });
  }

  async function fireDouble(page) {
    await page.locator('#lead button[data-v="30"]').click();
    await page.locator('#fireDouble').click();
    await page.waitForTimeout(250);
    await page.locator('#fireDouble').click();
  }

  async function rallyCueKeys(page) {
    return page.evaluate(() => Object.keys(window.__cues || {}).filter(key => /-(?:me|join):/.test(key)));
  }

  try {
    const captainPages = [];
    for (const player of CAPTAINS) captainPages.push(await registerPlayer(player));
    const memberPage = await registerPlayer(MEMBER);
    const commanderPage = await openPage('unselected-commander');
    await unlockCommander(commanderPage);

    await selectPair(commanderPage, 1, CAPTAINS.slice(0, 2));
    await fireDouble(commanderPage);
    await commanderPage.locator('#commanderLaunchMonitor .clm-row').first().waitFor({ state: 'visible', timeout: 8_000 });

    await selectPair(commanderPage, 2, CAPTAINS.slice(2, 4));
    await fireDouble(commanderPage);
    await commanderPage.waitForFunction(
      () => document.querySelectorAll('#commanderLaunchMonitor .clm-row').length === 4,
      null,
      { timeout: 8_000 }
    );

    const monitorState = await commanderPage.evaluate(() => ({
      monitorHidden: document.querySelector('#commanderLaunchMonitor').classList.contains('hide'),
      heroHidden: document.querySelector('#phero').classList.contains('hide'),
      names: [...document.querySelectorAll('#commanderLaunchMonitor .clm-name')].map(node => node.textContent.trim()),
      rows: document.querySelectorAll('#commanderLaunchMonitor .clm-row').length
    }));
    check(!monitorState.monitorHidden, 'unselected commander sees the silent launch monitor');
    check(monitorState.heroHidden, 'unselected commander does not see the personal-style hero countdown');
    check(monitorState.rows === 4, 'monitor combines every captain from both live kingdoms');
    for (const captain of CAPTAINS) {
      check(monitorState.names.includes(captain.pid), `monitor includes captain ${captain.pid}`);
    }
    check((await rallyCueKeys(commanderPage)).length === 0, 'unselected commander books no personal or JOIN rally audio');

    const firstCaptain = captainPages[0];
    await firstCaptain.locator('#phero').waitFor({ state: 'visible', timeout: 8_000 });
    const captainTitle = (await firstCaptain.locator('#pheroTitle').textContent() || '').trim();
    check(/YOU|\ud83d\ude97/i.test(captainTitle), `selected captain keeps the personal hero (${captainTitle})`);
    check(await firstCaptain.locator('#commanderLaunchMonitor').evaluate(node => node.classList.contains('hide')), 'selected captain does not see the commander monitor');
    check((await rallyCueKeys(firstCaptain)).some(key => key.includes('-me:')), 'selected captain books a personal launch cue');

    await memberPage.locator('#phero').waitFor({ state: 'visible', timeout: 8_000 });
    const memberTitle = (await memberPage.locator('#pheroTitle').textContent() || '').trim();
    check(/Whales|\ud83d\udc0b/i.test(memberTitle), `ordinary member keeps the shared JOIN hero (${memberTitle})`);
    check(await memberPage.locator('#commanderLaunchMonitor').evaluate(node => node.classList.contains('hide')), 'ordinary member never sees the commander monitor');
    check((await rallyCueKeys(memberPage)).some(key => key.includes('-join:')), 'ordinary member keeps one shared JOIN cue');

    await unlockCommander(firstCaptain);
    await firstCaptain.locator('#phero').waitFor({ state: 'visible', timeout: 8_000 });
    const selectedCommanderTitle = (await firstCaptain.locator('#pheroTitle').textContent() || '').trim();
    check(/YOU|\ud83d\ude97/i.test(selectedCommanderTitle), `selected commander still sees the personal hero (${selectedCommanderTitle})`);
    check(await firstCaptain.locator('#commanderLaunchMonitor').evaluate(node => node.classList.contains('hide')), 'personal countdown takes priority over commander monitor');
    const selectedCommanderCues = await rallyCueKeys(firstCaptain);
    check(selectedCommanderCues.some(key => key.includes('-me:')), 'selected commander retains personal launch audio');
    check(!selectedCommanderCues.some(key => key.includes('-join:')), 'selected commander never books JOIN audio');

    for (const width of [320, 390, 430]) {
      await commanderPage.setViewportSize({ width, height: 1_300 });
      await commanderPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await commanderPage.evaluate(() => {
        const monitor = document.querySelector('#commanderLaunchMonitor');
        const rect = monitor.getBoundingClientRect();
        return {
          pageOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
          monitorLeft: rect.left,
          monitorRight: rect.right,
          monitorOverflow: monitor.scrollWidth > monitor.clientWidth + 1,
          rowOverflow: [...monitor.querySelectorAll('.clm-row')].some(row => row.scrollWidth > row.clientWidth + 1),
          offenders: [...document.querySelectorAll('body *')].map(node => {
            const bounds = node.getBoundingClientRect();
            return { selector: `${node.tagName.toLowerCase()}#${node.id}.${node.className}`, left: bounds.left, right: bounds.right };
          }).filter(item => item.left < -1 || item.right > window.innerWidth + 1).slice(0, 8)
        };
      });
      if (layout.pageOverflow > 1) {
        console.warn(`! ${width}px existing page overflow outside the monitor: ${layout.pageOverflow}px ${JSON.stringify(layout.offenders)}`);
      }
      check(layout.monitorLeft >= -1 && layout.monitorRight <= width + 1, `${width}px monitor remains inside the viewport`);
      check(!layout.monitorOverflow, `${width}px monitor has no horizontal overflow`);
      check(!layout.rowOverflow, `${width}px monitor rows do not overflow`);
    }

    assertQaRoomName(room);
    check(pageErrors.length === 0, `no browser page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
    console.log(`\nAll commander launch monitor browser checks passed in ${room}`);
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(() => {})));
    await browser.close().catch(() => {});
  }
})().catch(error => {
  console.error('ERR', error.stack || error.message);
  process.exit(1);
});
