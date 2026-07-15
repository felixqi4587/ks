const { chromium } = require('playwright');
const { basename } = require('node:path');
const { assertQaRoomName, makeQaRoom, qaRoomUrl, installQaWebSocketGuard, localQaBaseURL } = require('./support/qa-kvk.cjs');

(async () => {
  const host = localQaBaseURL(process.argv[2] || 'http://127.0.0.1:8791');
  const room = makeQaRoom({ title: basename(__filename, '.cjs') });
  const url = qaRoomUrl(host, room, { notour: 1 });
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  let pass = 0;
  let fail = 0;
  const ok = (condition, label) => {
    condition ? pass++ : fail++;
    console.log(`${condition ? '✓' : '✗ FAIL'} ${label}`);
  };

  async function player(fid, march) {
    const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: 'en-US' });
    await installQaWebSocketGuard(context, room, { expectedOrigin: host });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.locator('#soundGate').click();
    await page.locator('#pid').fill(fid);
    await page.waitForTimeout(650);
    await page.locator('#marchRange').fill(String(march));
    await page.locator('#saveBtn').click();
    await page.waitForTimeout(350);
    return page;
  }

  const commander = await player('900000071', 80);
  const captainA = await player('900000072', 60);
  const captainB = await player('900000073', 50);
  const joiner = await player('900000074', 40);
  await commander.locator('#cmdUnlock').click();
  await commander.locator('#pwInput').fill('alert-test-password');
  await commander.locator('#pwGo').click();
  await commander.waitForTimeout(800);

  const rows = commander.locator('#roster .rp');
  await rows.filter({ hasText: '900000072' }).click();
  await rows.filter({ hasText: '900000073' }).click();
  await commander.locator('#fireDouble').click();
  await commander.locator('#fireDouble').click();
  await joiner.waitForTimeout(700);

  const joinCue = await joiner.evaluate(() => Object.keys(window.__cues || {}).some((key) => key.includes('-join:')));
  ok(joinCue, 'an ordinary registered player books the next rally join countdown');

  await joiner.locator('#tabDef').click();
  await joiner.waitForTimeout(150);
  ok(await joiner.locator('#defenseDemoNote').count() === 1, 'Defense labels its animation as a non-live demonstration');
  ok(/^▶/.test((await joiner.locator('#dpp').textContent()) || ''), 'Defense demonstration is paused by default');
  assertQaRoomName(room);

  await Promise.all([commander.close(), captainA.close(), captainB.close(), joiner.close()]);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('ERR', error.message);
  process.exit(2);
});
