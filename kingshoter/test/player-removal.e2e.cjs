const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const room = `remove-${Date.now()}`;
const roomUrl = `${base}/kvk?room=${room}&notour=1`;

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const manager = await (await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' })).newPage();
  const observer = await (await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' })).newPage();
  const errors = [];
  manager.on('pageerror', error => errors.push(`manager: ${error.message}`));
  observer.on('pageerror', error => errors.push(`observer: ${error.message}`));

  try {
    const meKey = `kingshoter_r_${room}_me`;
    await manager.addInitScript(({ key }) => {
      if (!sessionStorage.getItem('player-removal-seeded')) {
        localStorage.setItem(key, JSON.stringify({ pid: '001', name: 'Test 001', march: 32 }));
        sessionStorage.setItem('player-removal-seeded', '1');
      }
    }, { key: meKey });
    await Promise.all([manager.goto(roomUrl), observer.goto(roomUrl)]);
    await observer.evaluate(roomName => new Promise(resolve => {
      window.__roomStates = [];
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.t === 'state') window.__roomStates.push(message.room);
      };
      ws.onopen = resolve;
      window.__observerSocket = ws;
    }), room);

    await manager.evaluate(roomName => new Promise(resolve => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      let sent = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'setMarch', pid: '001', name: 'Test 001', march: 32, alliance: '' }));
        ws.send(JSON.stringify({ t: 'setMarch', pid: 'kimchi', name: 'Kimchi', march: 32, alliance: '' }));
        sent = true;
      };
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (sent && message.t === 'state' && message.room.players['001'] && message.room.players.kimchi) { ws.close(); resolve(); }
      };
    }), room);

    await manager.waitForFunction(() => document.querySelectorAll('#roster .rp').length === 2, null, { timeout: 5000 });
    assert.equal(await manager.locator('#console').isVisible(), false, 'commander console starts locked');
    assert.equal(await manager.locator('#roster .rpdel:visible').count(), 0, 'delete controls are not visible before unlock');

    await manager.locator('#soundGate').click().catch(() => {});
    await manager.locator('#cmdUnlock').click();
    await manager.locator('#pwInput').fill('remove-test-password');
    await manager.locator('#pwGo').click();
    await manager.locator('#console').waitFor({ state: 'visible', timeout: 5000 });

    const untouched = manager.locator('#roster .rp[data-pid="kimchi"]');
    await untouched.evaluate(el => el.click());
    assert.match(await untouched.getAttribute('class'), /\bsel\b/, 'existing captain selection still works');
    await untouched.evaluate(el => el.click());
    assert.doesNotMatch(await untouched.getAttribute('class'), /\bsel\b/, 'existing captain unselection still works');

    const target = manager.locator('#roster .rp[data-pid="001"]');
    const remove = manager.locator('#roster .rpi[data-pid="001"] .rpdel[data-pid="001"]');
    await remove.waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await remove.getAttribute('aria-label'), 'Remove Test 001 from this room');
    const removeBox = await remove.boundingBox();
    assert.ok(removeBox && removeBox.width >= 44 && removeBox.height >= 44, 'delete control keeps a 44px mobile touch target');

    let cancelledPrompt = '';
    manager.once('dialog', async dialog => {
      cancelledPrompt = dialog.message();
      await dialog.dismiss();
    });
    await remove.click();
    assert.match(cancelledPrompt, /Remove Test 001 from this room\?/);
    assert.equal(await target.count(), 1, 'cancelling confirmation keeps the player');
    assert.equal(await target.getAttribute('class'), 'rp', 'delete click never also selects the captain');

    let confirmation = '';
    manager.once('dialog', async dialog => {
      confirmation = dialog.message();
      await dialog.accept();
    });
    const reload = manager.waitForEvent('load', { timeout: 5000 });
    await remove.click();
    await reload;
    await manager.locator('#console').waitFor({ state: 'visible', timeout: 5000 });
    assert.match(confirmation, /Remove Test 001 from this room\?/);
    assert.equal(await manager.evaluate(key => localStorage.getItem(key), meKey), null, 'deleting this device profile clears its reconnect registration');
    assert.equal(await manager.locator('#roster .rp.sel').count(), 0, 'delete click never selects a captain');
    assert.equal(await manager.locator('#roster .rp[data-pid="001"]').count(), 0, 'removed player stays absent after the deleting device reloads');
    assert.equal(await manager.locator('#roster .rp[data-pid="kimchi"]').count(), 1, 'unrelated player remains');

    await observer.waitForFunction(() => {
      const state = window.__roomStates[window.__roomStates.length - 1];
      return state && !state.players['001'] && state.players.kimchi;
    }, null, { timeout: 5000 });
    assert.deepEqual(errors, []);
    console.log('✓ authenticated roster deletion is confirmed and synchronized to another device');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
