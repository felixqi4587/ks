const assert = require('node:assert/strict');
const { basename } = require('node:path');
const { chromium } = require('playwright');
const { makeQaRoom, qaRoomUrl, installQaWebSocketGuard } = require('./support/qa-kvk.cjs');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const room = makeQaRoom({ title: basename(__filename, '.cjs') });
const url = qaRoomUrl(base, room, { notour: 1 });
const meKey = `kingshoter_r_${room}_me`;
const deviceKey = `kvk:${room}:delivery-device:v1`;
const originalDeviceId = '11111111-1111-4111-8111-111111111111';
const secondDeviceId = '22222222-2222-4222-8222-222222222222';
const profileOwnershipKey = '33333333-3333-4333-8333-333333333333';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const playerContext = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  const secondPlayerContext = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  const managerContext = await browser.newContext({ viewport: { width: 375, height: 1100 }, locale: 'zh-CN' });
  await Promise.all([installQaWebSocketGuard(playerContext, room), installQaWebSocketGuard(secondPlayerContext, room), installQaWebSocketGuard(managerContext, room)]);
  const player = await playerContext.newPage();
  const secondPlayer = await secondPlayerContext.newPage();
  const manager = await managerContext.newPage();
  const errors = [];
  player.on('pageerror', error => errors.push(`player: ${error.message}`));
  secondPlayer.on('pageerror', error => errors.push(`second player: ${error.message}`));
  manager.on('pageerror', error => errors.push(`manager: ${error.message}`));

  try {
    await player.addInitScript(({ storageKey, deliveryKey, seededDevice, ownerKey }) => {
      localStorage.setItem(storageKey, JSON.stringify({
        pid: '001', playerId: '001', name: 'Test 001', march: 32,
        marchRevision: 0, identityMode: 'playerId', editable: true, profileKey: ownerKey
      }));
      localStorage.setItem(deliveryKey, seededDevice);
    }, { storageKey: meKey, deliveryKey: deviceKey, seededDevice: originalDeviceId, ownerKey: profileOwnershipKey });
    await secondPlayer.addInitScript(({ storageKey, deliveryKey, seededDevice }) => {
      localStorage.setItem(storageKey, JSON.stringify({
        pid: '001', playerId: '001', name: 'Test 001', march: 32,
        marchRevision: 0, identityMode: 'playerId', editable: false
      }));
      localStorage.setItem(deliveryKey, seededDevice);
    }, { storageKey: meKey, deliveryKey: deviceKey, seededDevice: secondDeviceId });

    await manager.goto(url);
    await manager.evaluate(({ roomName, ownerKey }) => new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      const timer = setTimeout(() => reject(new Error('canonical player seed timed out')), 5000);
      socket.onerror = () => { clearTimeout(timer); reject(new Error('canonical player seed failed')); };
      socket.onopen = () => socket.send(JSON.stringify({
        t: 'registerPlayer', pid: '001', playerId: '001', name: 'Test 001', march: 32,
        identityMode: 'playerId', alliance: '', profileKey: ownerKey
      }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.t !== 'state' || !message.room.players['001']) return;
        clearTimeout(timer); socket.close(); resolve();
      };
    }), { roomName: room, ownerKey: profileOwnershipKey });
    await Promise.all([player.goto(url), secondPlayer.goto(url)]);
    await manager.waitForFunction(() => document.querySelector('#roster .rp[data-pid="001"]'), null, { timeout: 5000 });

    await player.locator('#soundGate').click().catch(() => {});
    await player.locator('#cmdUnlock').click();
    await player.locator('#pwInput').fill('own-removal-password');
    await player.locator('#pwGo').click();
    await player.locator('#console').waitFor({ state: 'visible', timeout: 5000 });

    await manager.locator('#soundGate').click().catch(() => {});
    await manager.locator('#cmdUnlock').click();
    await manager.locator('#pwInput').fill('own-removal-password');
    await manager.locator('#pwGo').click();
    await manager.locator('#console').waitFor({ state: 'visible', timeout: 5000 });

    await manager.locator('#roster .roster-actions[data-pid="001"]').click();
    assert.match(await manager.locator('#rosterActionsMenu [data-action="remove"]').textContent(), /删除玩家/);
    await manager.locator('#rosterActionsMenu [data-action="remove"]').click();
    assert.match(await manager.locator('#removePlayerTitle').textContent(), /删除/);
    for (const id of ['removePlayerCancel', 'removePlayerConfirm']) {
      const box = await manager.locator(`#${id}`).boundingBox();
      assert.ok(box && box.height >= 44, `${id} keeps a 44px touch target`);
    }
    assert.equal(await manager.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, '375px removal UI has no horizontal page overflow');
    await manager.locator('#removePlayerConfirm').click();
    await player.locator('#fillCard').waitFor({ state: 'visible', timeout: 5000 });
    await player.locator('#youChip').waitFor({ state: 'hidden', timeout: 5000 });
    await secondPlayer.locator('#fillCard').waitFor({ state: 'visible', timeout: 5000 });
    await secondPlayer.locator('#youChip').waitFor({ state: 'hidden', timeout: 5000 });

    assert.equal(await player.evaluate(key => localStorage.getItem(key), meKey), null, 'remote removal clears the saved reconnect profile');
    assert.equal(await player.evaluate(key => localStorage.getItem(key), deviceKey), null, 'remote removal clears the room-local delivery device ID');
    assert.equal(await secondPlayer.evaluate(key => localStorage.getItem(key), meKey), null, 'every open device with the same PID clears its saved profile');
    assert.equal(await secondPlayer.evaluate(key => localStorage.getItem(key), deviceKey), null, 'every open device with the same PID clears its delivery device ID');
    assert.equal(await player.locator('#console').isVisible(), true, 'remote own-player removal preserves commander unlock');
    await player.waitForTimeout(1200);
    assert.equal(await player.locator('#roster .rp[data-pid="001"]').count(), 0, 'the same connection does not auto-register the removed profile');
    assert.equal(await secondPlayer.locator('#roster .rp[data-pid="001"]').count(), 0, 'a second same-PID connection also does not auto-register');

    await player.locator('#identityNickname').click();
    await player.locator('#pid').fill('Rejoined Tester');
    await player.locator('#marchRange').fill('37');
    await player.locator('#saveBtn').click();
    await player.locator('#youChip').waitFor({ state: 'visible', timeout: 5000 });
    const replacementDeviceId = await player.evaluate(key => localStorage.getItem(key), deviceKey);
    assert.match(replacementDeviceId || '', /^[0-9a-f-]{36}$/i, 'explicit re-registration creates a new device UUID');
    assert.notEqual(replacementDeviceId, originalDeviceId, 'the removed device identity is never reused');
    assert.deepEqual(errors, []);
    console.log(`✓ own removal clears and explicitly regenerates device identity (${room})`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
