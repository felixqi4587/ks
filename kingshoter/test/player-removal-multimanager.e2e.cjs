const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const room = `remove-multi-${Date.now()}`;
const url = `${base}/kvk?room=${room}&notour=1`;

async function unlock(page, password) {
  await page.locator('#soundGate').click().catch(() => {});
  await page.locator('#cmdUnlock').click();
  await page.locator('#pwInput').fill(password);
  await page.locator('#pwGo').click();
  await page.locator('#console').waitFor({ state: 'visible', timeout: 5000 });
}

async function rowClick(page, pid) {
  await page.locator(`#roster .rp[data-pid="${pid}"]`).evaluate(el => el.click());
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const a = await (await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' })).newPage();
  const b = await (await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' })).newPage();
  const errors = [];
  a.on('pageerror', error => errors.push(`A: ${error.message}`));
  b.on('pageerror', error => errors.push(`B: ${error.message}`));

  try {
    await Promise.all([a.goto(url), b.goto(url)]);
    await a.evaluate(roomName => new Promise(resolve => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      let sent = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'setMarch', pid: '001', name: 'Test 001', march: 32, alliance: '' }));
        ws.send(JSON.stringify({ t: 'setMarch', pid: 'kimchi', name: 'Kimchi', march: 40, alliance: '' }));
        sent = true;
      };
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (sent && message.t === 'state' && message.room.players['001'] && message.room.players.kimchi) { ws.close(); resolve(); }
      };
    }), room);

    await unlock(a, 'multi-remove-password');
    await rowClick(a, '001');
    await rowClick(a, 'kimchi');
    await a.waitForFunction(() => document.querySelectorAll('#roster .rp.sel').length === 2);
    assert.equal(await a.locator('#fireDouble').isDisabled(), false, 'manager A can fire with two valid picks');

    await unlock(b, 'multi-remove-password');
    await b.waitForFunction(() => document.querySelectorAll('#roster .rp.sel').length === 2, null, { timeout: 5000 });
    await rowClick(b, '001');
    await rowClick(b, 'kimchi');
    await b.waitForFunction(() => document.querySelectorAll('#roster .rp.sel').length === 0);
    assert.equal(await a.locator('#roster .rp.sel').count(), 2, 'manager A still has local picks after B clears shared staging');

    b.once('dialog', dialog => dialog.accept());
    await b.locator('#roster .rpi[data-pid="001"] .rpdel').click();
    await b.locator('#roster .rp[data-pid="001"]').waitFor({ state: 'detached', timeout: 5000 });
    await a.locator('#roster .rp[data-pid="001"]').waitFor({ state: 'detached', timeout: 5000 });

    assert.doesNotMatch(await a.locator('#pickSlots').textContent(), /Test 001/, 'deleted captain is pruned from another manager’s local slots');
    assert.equal(await a.locator('#fireDouble').isDisabled(), true, 'another manager’s deletion disables fire until two real players are selected');

    b.once('dialog', dialog => dialog.accept());
    await b.locator('#roster .rpi[data-pid="kimchi"] .rpdel').click();
    await b.locator('#roster .rp[data-pid="kimchi"]').waitFor({ state: 'detached', timeout: 5000 });
    await a.locator('#roster .rp[data-pid="kimchi"]').waitFor({ state: 'detached', timeout: 5000 });
    assert.doesNotMatch(await a.locator('#pickSlots').textContent(), /Kimchi/, 'deleting the final player clears stale role slots in the empty roster state');
    assert.equal((await a.locator('#pickCnt').textContent()).trim(), '0/2', 'empty roster reports zero selected captains');
    assert.equal(await a.locator('#fireDouble').isDisabled(), true, 'empty roster keeps Fire disabled');
    assert.deepEqual(errors, []);
    console.log('✓ cross-manager deletion prunes stale local picks and prevents ghost fire');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
