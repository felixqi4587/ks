// concurrent multi-kingdom: firing K2 must NOT wipe K1's live rally
const { chromium } = require('playwright');
const { makeQaRoom, qaRoomUrl, installQaWebSocketGuard } = require('./support/qa-kvk.cjs');

(async () => {
  const host = process.argv[2] || 'http://127.0.0.1:8791';
  const room = makeQaRoom('multikingdom');
  const url = qaRoomUrl(host, room, { notour: 1 });
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  let pass = 0, fail = 0;
  const ok = (condition, label) => { condition ? pass++ : fail++; console.log(`${condition ? '✓' : '✗ FAIL'} ${label}`); };
  const errors = [];

  const openPage = async (label) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 1300 }, locale: 'en-US' });
    await installQaWebSocketGuard(context, room);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${label}:${error.message}`));
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('#soundGate').click().catch(() => {});
    await page.waitForTimeout(150);
    return page;
  };
  const addCaptain = async (fid, march) => {
    const page = await openPage(fid);
    await page.locator('#pid').fill(fid);
    await page.waitForTimeout(700);
    await page.locator('#marchRange').fill(String(march));
    await page.locator('#saveBtn').click();
    await page.locator('#youChip').waitFor({ state: 'visible' });
    return page;
  };
  const fire = async page => {
    await page.locator('#fireDouble').click();
    await page.waitForTimeout(240);
    await page.locator('#fireDouble').click();
    await page.waitForTimeout(250);
  };
  const pick = async (commander, kingdom, ids) => {
    await commander.locator(`#kingdomPick button[data-k="${kingdom}"]`).click();
    for (const id of ids) {
      await commander.locator(`#roster .rp[data-pid="${id}"]`).click();
    }
  };

  const p1 = await addCaptain('900000001', 60);
  await addCaptain('900000002', 60);
  const p3 = await addCaptain('900000003', 60);
  await addCaptain('900000004', 60);
  const commander = await openPage('commander');
  await commander.locator('#cmdUnlock').click();
  await commander.locator('#pwInput').fill('666');
  await commander.locator('#pwGo').click();
  await commander.locator('#console').waitFor({ state: 'visible' });
  await pick(commander, 1, ['900000001', '900000002']);
  await fire(commander);
  await pick(commander, 2, ['900000003', '900000004']);
  await fire(commander);
  await commander.waitForTimeout(800);

  const t1 = (await p1.locator('#pheroTitle').textContent() || '').trim();
  const t3 = (await p3.locator('#pheroTitle').textContent() || '').trim();
  ok(/YOU|🚗/i.test(t1) && !/Whales|🐋|Ready ·|waiting/i.test(t1), `K1 captain keeps a personal countdown after K2 fires (${t1})`);
  ok(/YOU|🚗/i.test(t3) && !/Whales|🐋|Ready ·|waiting/i.test(t3), `K2 captain has its own personal countdown (${t3})`);
  ok(errors.length === 0, `no page errors${errors.length ? ` → ${errors.join(' | ')}` : ''}`);
  await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  console.log(`\n${pass} passed, ${fail} failed (${room})`);
  process.exit(fail ? 1 : 0);
})().catch(error => { console.error('ERR', error.stack || error.message); process.exit(2); });
