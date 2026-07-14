const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { makeQaRoom, qaRoomUrl, installQaWebSocketGuard } = require('./support/qa-kvk.cjs');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const room = makeQaRoom('remove-own-device');
const url = qaRoomUrl(base, room, { notour: 1 });
const meKey = `kingshoter_r_${room}_me`;

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const playerContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: 'en-US' });
  const managerContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: 'en-US' });
  await Promise.all([
    installQaWebSocketGuard(playerContext, room),
    installQaWebSocketGuard(managerContext, room)
  ]);
  const player = await playerContext.newPage();
  const manager = await managerContext.newPage();
  const errors = [];
  player.on('pageerror', error => errors.push(`player: ${error.message}`));
  manager.on('pageerror', error => errors.push(`manager: ${error.message}`));

  try {
    await player.addInitScript(({ key }) => {
      if (!sessionStorage.getItem('own-removal-seeded')) {
        localStorage.setItem(key, JSON.stringify({ pid: '001', name: 'Test 001', march: 32 }));
        sessionStorage.setItem('own-removal-seeded', '1');
      }
    }, { key: meKey });
    await Promise.all([player.goto(url), manager.goto(url)]);
    await manager.waitForFunction(() => document.querySelector('#roster .rp[data-pid="001"]'), null, { timeout: 5000 });

    await manager.locator('#soundGate').click().catch(() => {});
    await manager.locator('#cmdUnlock').click();
    await manager.locator('#pwInput').fill('own-removal-password');
    await manager.locator('#pwGo').click();
    await manager.locator('#console').waitFor({ state: 'visible', timeout: 5000 });

    manager.once('dialog', dialog => dialog.accept());
    await manager.locator('#roster .rpi[data-pid="001"] .rpdel').click();
    await player.locator('#fillCard').waitFor({ state: 'visible', timeout: 5000 });
    await player.locator('#youChip').waitFor({ state: 'hidden', timeout: 5000 });

    assert.equal(await player.evaluate(key => localStorage.getItem(key), meKey), null, 'a player removed by another manager clears its saved reconnect profile');
    assert.equal(await player.locator('#roster .rp[data-pid="001"]').count(), 0, 'the removed profile stays absent after inline reconciliation');
    assert.deepEqual(errors, []);
    console.log('✓ a remotely removed player clears its own device identity and does not auto-return');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
