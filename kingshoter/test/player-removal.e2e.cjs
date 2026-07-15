const assert = require('node:assert/strict');
const { basename } = require('node:path');
const { chromium } = require('playwright');
const { assertQaRoomName, makeQaRoom, qaRoomUrl, installQaWebSocketGuard } = require('./support/qa-kvk.cjs');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const room = makeQaRoom({ title: basename(__filename, '.cjs') });
const roomUrl = qaRoomUrl(base, room, { notour: 1 });
const profileKey = '30000000-0000-4000-8000-000000000001';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const managerContext = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  const observerContext = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  let removePackets = 0;
  let dropFirstAbsentState = false;
  await Promise.all([
    installQaWebSocketGuard(managerContext, room, {
      shouldDropClientMessage({ data }) {
        try { if (JSON.parse(String(data)).t === 'removePlayer') removePackets += 1; } catch (_) {}
        return false;
      },
      shouldDropServerMessage({ data }) {
        if (!dropFirstAbsentState) return false;
        try {
          const message = JSON.parse(String(data));
          if (message.t === 'state' && !message.room.players['001']) {
            dropFirstAbsentState = false;
            return true;
          }
        } catch (_) {}
        return false;
      }
    }),
    installQaWebSocketGuard(observerContext, room)
  ]);
  const manager = await managerContext.newPage();
  const observer = await observerContext.newPage();
  const errors = [];
  manager.on('pageerror', error => errors.push(`manager: ${error.message}`));
  observer.on('pageerror', error => errors.push(`observer: ${error.message}`));

  try {
    const meKey = `kingshoter_r_${room}_me`;
    await manager.addInitScript(({ key, ownerKey }) => {
      localStorage.setItem(key, JSON.stringify({ pid: '001', name: 'Test 001', march: 32, profileKey: ownerKey }));
      const nativeSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        let message = null;
        try { message = JSON.parse(String(data)); } catch (_) {}
        if (message && message.t === 'setPlayerMarch' && window.__holdMarchBadPassword) {
          window.__holdMarchBadPassword = false;
          window.__heldMarchSocket = this;
          window.__heldMarchMutation = message.mutationId;
          return;
        }
        if (message && message.t === 'removePlayer' && window.__removeSendMode === 'fail') {
          window.__removeSendMode = '';
          throw new Error('simulated remove send failure');
        }
        if (message && message.t === 'removePlayer' && window.__removeSendMode === 'persist') {
          window.__removeSendMode = '';
          window.__heldRemovalSocket = this;
          return;
        }
        if (message && message.t === 'removePlayer' && window.__removeSendMode === 'wrongpw') {
          window.__removeSendMode = '';
          message.password = 'definitely-wrong';
          data = JSON.stringify(message);
        }
        if (message && message.t === 'removePlayer' && window.__removeSendMode === 'unscoped') {
          window.__removeSendMode = '';
          nativeSend.call(this, JSON.stringify({
            t: 'stage', password: message.password,
            staged: { kingdom: 1, pairs: [{ pid: 'missing-player', role: 'weak' }] }
          }));
          window.__unscopedRemovalSocket = this;
          return;
        }
        nativeSend.call(this, data);
        if (message && message.t === 'removePlayer' && window.__removeSendMode === 'close') {
          window.__removeSendMode = '';
          window.__processedRemovalSocket = this;
        }
      };
    }, { key: meKey, ownerKey: profileKey });
    await Promise.all([manager.goto(roomUrl), observer.goto(roomUrl)]);
    assertQaRoomName(room);
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

    assertQaRoomName(room);
    await manager.evaluate(({ roomName, ownerKey }) => new Promise(resolve => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      let sent = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'setMarch', pid: '001', name: 'Test 001', march: 32, alliance: '', profileKey: ownerKey }));
        ws.send(JSON.stringify({ t: 'setMarch', pid: 'kimchi', name: 'Kimchi', march: 32, alliance: '', profileKey: ownerKey }));
        sent = true;
      };
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (sent && message.t === 'state' && message.room.players['001'] && message.room.players.kimchi) { ws.close(); resolve(); }
      };
    }), { roomName: room, ownerKey: profileKey });

    await manager.waitForFunction(() => document.querySelectorAll('#roster .rp').length === 2, null, { timeout: 5000 });
    assert.equal(await manager.locator('#console').isVisible(), false, 'commander console starts locked');
    assert.equal(await manager.locator('#roster .roster-actions:visible').count(), 0, 'player actions are not visible before unlock');

    await manager.locator('#soundGate').click().catch(() => {});
    await manager.locator('#cmdUnlock').click();
    await manager.locator('#pwInput').fill('remove-test-password');
    await manager.locator('#pwGo').click();
    await manager.locator('#console').waitFor({ state: 'visible', timeout: 5000 });

    const target = manager.locator('#roster .rp[data-pid="001"]');
    const actions = manager.locator('#roster .roster-actions[data-pid="001"]');
    const unrelatedActions = manager.locator('#roster .roster-actions[data-pid="kimchi"]');
    const dialog = manager.locator('#removePlayerOvl');
    const actionBox = await actions.boundingBox();
    assert.equal(await manager.locator('#rosterActionsMenu').count(), 0);
    assert.equal((await actions.textContent()).trim(), 'Remove');
    assert.equal(await actions.getAttribute('aria-haspopup'), null);
    assert.equal(await actions.getAttribute('aria-controls'), null);
    assert.ok(actionBox && actionBox.width >= 44 && actionBox.height >= 44, 'direct Remove keeps a 44px mobile touch target');

    await actions.click();
    await dialog.waitFor({ state: 'visible' });
    assert.equal((await manager.locator('#removePlayerTitle').textContent()).trim(), 'Remove Test 001 from this room?');
    assert.equal((await manager.locator('#removePlayerConfirm').textContent()).trim(), 'Remove player');
    await manager.locator('#removePlayerCancel').click();
    assert.equal(await target.count(), 1, 'direct Remove still requires confirmation');

    await actions.focus();
    assertQaRoomName(room);
    await manager.evaluate(roomName => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'hb', pid: '001' })); setTimeout(() => ws.close(), 300); };
    }, room);
    await manager.waitForTimeout(450);
    assert.equal(await manager.evaluate(() => document.activeElement?.matches('.roster-actions[data-pid="001"]')), true, 'heartbeat rerender preserves direct Remove focus');

    await manager.locator('#roster .roster-time[data-pid="001"]').click();
    await manager.locator('#commanderMarchInput').fill('0:36');
    assertQaRoomName(room);
    await manager.evaluate(roomName => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'ready', pid: 'kimchi', ready: true })); setTimeout(() => ws.close(), 300); };
    }, room);
    await manager.waitForTimeout(450);
    assert.equal(await manager.locator('#commanderMarchInput').inputValue(), '0:36', 'room snapshots preserve a dirty march draft');
    await manager.locator('#commanderMarchCancel').click();

    await manager.locator('#roster .roster-time[data-pid="001"]').click();
    await manager.locator('#commanderMarchInput').fill('0:36');
    await manager.evaluate(() => { window.__holdMarchBadPassword = true; });
    await manager.locator('#commanderMarchSave').click();
    await manager.locator('#roster .roster-actions[data-pid="kimchi"]').click();
    await dialog.waitFor({ state: 'visible' });
    await manager.evaluate(() => window.__heldMarchSocket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ t: 'error', error: 'bad_password', mutationId: window.__heldMarchMutation })
    })));
    await manager.locator('#console').waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal(await dialog.isVisible(), false, 'mutation-scoped bad password also closes removal UI');
    await manager.waitForFunction(() => document.activeElement?.id === 'cmdUnlock');
    assert.equal(await manager.locator('#roster .rp[data-pid="kimchi"]').count(), 1, 'credential failure never mutates the removal target');
    await manager.locator('#cmdUnlock').click();
    await manager.locator('#pwInput').fill('remove-test-password');
    await manager.locator('#pwGo').click();
    await manager.locator('#console').waitFor({ state: 'visible', timeout: 5000 });
    await manager.locator('#commanderMarchCancel').click();

    await actions.click();
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.getAttribute('role'), 'dialog');
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.equal(await manager.evaluate(() => document.activeElement && document.activeElement.id), 'removePlayerCancel', 'Cancel receives initial focus');
    await manager.keyboard.press('Shift+Tab');
    assert.equal(await manager.evaluate(() => document.activeElement && document.activeElement.id), 'removePlayerConfirm', 'dialog traps backward Tab');
    await manager.keyboard.press('Tab');
    assert.equal(await manager.evaluate(() => document.activeElement && document.activeElement.id), 'removePlayerCancel', 'dialog traps forward Tab');
    await manager.locator('#removePlayerCancel').click();
    assert.equal(await target.count(), 1, 'cancelling confirmation keeps the player');
    assert.equal(await manager.evaluate(() => document.activeElement && document.activeElement.dataset.pid), '001', 'Cancel returns focus to the current actions trigger');

    await actions.click();
    await manager.evaluate(() => { window.__removeSendMode = 'fail'; });
    await manager.locator('#removePlayerConfirm').click();
    assert.equal(removePackets, 0, 'a false send creates no pending removal request');
    assert.equal(await target.count(), 1, 'false send keeps canonical player state');
    assert.equal(await dialog.isVisible(), true, 'false send keeps the dialog retryable');
    assert.match(await manager.locator('#removePlayerStatus').textContent(), /retry|not sent|connection/i);

    await manager.evaluate(() => { window.__removeSendMode = 'persist'; });
    await manager.locator('#removePlayerConfirm').click();
    await manager.waitForFunction(() => document.querySelector('#roster .roster-actions[data-pid="kimchi"]')?.getAttribute('aria-disabled') === 'true');
    await manager.evaluate(() => window.__heldRemovalSocket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ t: 'error', error: 'remove_persist_failed', pid: '001' })
    })));
    await manager.waitForFunction(() => /retry/i.test(document.querySelector('#removePlayerStatus')?.textContent || ''));
    assert.equal(await unrelatedActions.getAttribute('aria-disabled'), 'false', 'persistence failure immediately restores unrelated Remove availability');
    await manager.locator('#removePlayerCancel').click();
    assert.equal(await unrelatedActions.getAttribute('aria-disabled'), 'false', 'Cancel preserves row availability after persistence failure');
    assert.equal(await target.count(), 1, 'persistence failure and Cancel keep the player');
    assert.equal(removePackets, 0, 'persistence failure never auto-resends removal');
    assert.equal(await dialog.isVisible(), false, 'Cancel closes the retryable persistence-failure dialog');

    await actions.click();
    await dialog.waitFor({ state: 'visible' });
    await manager.evaluate(() => {
      if (!window.__nativeRoomSocketSend) {
        window.__nativeRoomSocketSend = RoomSocket.prototype.send;
        RoomSocket.prototype.send = function (message) {
          if (message?.t === 'removePlayer' && window.__refreshRemovalOnce) {
            window.__refreshRemovalOnce = false;
            setTimeout(() => this.refresh(), 0);
            return true;
          }
          return window.__nativeRoomSocketSend.call(this, message);
        };
      }
      window.__refreshRemovalOnce = true;
    });
    await manager.locator('#removePlayerConfirm').click();
    await manager.waitForFunction(() => /retry/i.test(document.querySelector('#removePlayerStatus')?.textContent || ''), null, { timeout: 5000 });
    assert.equal(await target.count(), 1, 'generation replacement with the player present becomes manually retryable');
    assert.equal(removePackets, 0, 'refresh replacement never auto-resends');

    await manager.evaluate(() => { window.__removeSendMode = 'unscoped'; });
    await manager.locator('#removePlayerConfirm').click();
    await manager.waitForTimeout(120);
    assert.equal(await target.count(), 1, 'an unscoped player_missing error cannot prove removal');
    assert.match(await manager.locator('#removePlayerStatus').textContent(), /waiting/i, 'unscoped errors do not settle the pending target');
    await manager.locator('#removePlayerCancel').click();
    assert.equal(await unrelatedActions.getAttribute('aria-disabled'), 'true', 'another PID cannot overwrite an unresolved removal');
    await unrelatedActions.click({ force: true });
    assert.equal(await dialog.isVisible(), false, 'an unrelated unresolved removal cannot open confirmation');
    await manager.locator('#toast.show').waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await manager.locator('#toast').textContent(), /waiting|remov/i);
    await actions.click();
    await dialog.waitFor({ state: 'visible' });
    await manager.evaluate(() => window.__unscopedRemovalSocket.close());
    await manager.waitForFunction(() => /unknown/i.test(document.querySelector('#removePlayerStatus')?.textContent || ''), null, { timeout: 2000 });
    await manager.locator('#removePlayerCancel').click();
    await manager.waitForFunction(() => document.querySelector('#cdot')?.classList.contains('on'), null, { timeout: 7000 });
    await manager.locator('#roster .roster-actions[data-pid="001"]').click();
    assert.match(await manager.locator('#removePlayerStatus').textContent(), /retry/i, 'reconnect with the player present becomes manually retryable');
    assert.equal(removePackets, 0, 'reconnect with the player present does not auto-resend');
    await manager.evaluate(() => { window.__removeSendMode = 'wrongpw'; });
    await manager.locator('#removePlayerConfirm').click();
    await manager.locator('#console').waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal(await dialog.isVisible(), false, 'bad password closes the removal surface');
    assert.equal(await target.count(), 1, 'bad password never removes the player');
    await manager.waitForFunction(() => document.activeElement && document.activeElement.id === 'cmdUnlock');
    assert.equal(removePackets, 1, 'the scoped bad-password attempt is sent exactly once');

    await manager.locator('#cmdUnlock').click();
    await manager.locator('#pwInput').fill('remove-test-password');
    await manager.locator('#pwGo').click();
    await manager.locator('#console').waitFor({ state: 'visible', timeout: 5000 });
    await manager.locator('#roster .roster-actions[data-pid="001"]').click();
    dropFirstAbsentState = true;
    await manager.evaluate(() => { window.__removeSendMode = 'close'; });
    await manager.locator('#removePlayerConfirm').click();
    const processedDeadline = Date.now() + 5000;
    while (dropFirstAbsentState && Date.now() < processedDeadline) await manager.waitForTimeout(25);
    assert.equal(dropFirstAbsentState, false, 'the server processed removal before the simulated result-losing disconnect');
    await manager.evaluate(() => window.__processedRemovalSocket.close());
    await manager.waitForFunction(() => /connection|reconnect|unknown/i.test(document.querySelector('#removePlayerStatus')?.textContent || ''), null, { timeout: 1500 });
    await manager.locator('#roster .rp[data-pid="001"]').waitFor({ state: 'detached', timeout: 8000 });
    assert.equal(removePackets, 2, 'close/reconnect never auto-resends a removal');
    assert.equal(await manager.evaluate(key => localStorage.getItem(key), meKey), null, 'deleting this device profile clears its reconnect registration');
    assert.equal(await manager.locator('#console').isVisible(), true, 'own-player removal preserves commander unlock');
    assert.equal(await manager.locator('#roster .rp[data-pid="kimchi"]').count(), 1, 'unrelated player remains');

    await observer.waitForFunction(() => {
      const state = window.__roomStates[window.__roomStates.length - 1];
      return state && !state.players['001'] && state.players.kimchi;
    }, null, { timeout: 5000 });
    assert.equal(await manager.locator('link[href="app.css?v=2026071503"]').count(), 1);
    assert.equal(await manager.locator('script[src="/app.js?v=2026071503"]').count(), 1);
    assert.equal(await manager.locator('script[src="/kvk.js?v=2026071503"]').count(), 1);
    assert.deepEqual(errors, []);
    console.log(`✓ removal actions, retry, reconnect, and inline synchronization (${room})`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
