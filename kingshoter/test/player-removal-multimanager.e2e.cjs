const assert = require('node:assert/strict');
const { basename } = require('node:path');
const { chromium } = require('playwright');
const { assertQaRoomName, makeQaRoom, qaRoomUrl, installQaWebSocketGuard } = require('./support/qa-kvk.cjs');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const room = makeQaRoom({ title: basename(__filename, '.cjs') });
const url = qaRoomUrl(base, room, { notour: 1 });

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

async function openRemove(page, pid) {
  await page.locator(`#roster .roster-actions[data-pid="${pid}"]`).click();
  await page.locator('#rosterActionsMenu [data-action="remove"]').click();
  await page.locator('#removePlayerOvl').waitFor({ state: 'visible' });
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const contextA = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  const contextB = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  await Promise.all([installQaWebSocketGuard(contextA, room), installQaWebSocketGuard(contextB, room)]);
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  const errors = [];
  a.on('pageerror', error => errors.push(`A: ${error.message}`));
  b.on('pageerror', error => errors.push(`B: ${error.message}`));

  try {
    await Promise.all([a.goto(url), b.goto(url)]);
    assertQaRoomName(room);
    await a.evaluate(roomName => new Promise(resolve => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      let sent = false;
      ws.onopen = () => {
        for (const [pid, name, march] of [['001', 'Test 001', 32], ['kimchi', 'Kimchi', 40], ['hml', 'HML', 45]]) {
          ws.send(JSON.stringify({ t: 'setMarch', pid, name, march, alliance: '' }));
        }
        sent = true;
      };
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (sent && message.t === 'state' && ['001', 'kimchi', 'hml'].every(pid => message.room.players[pid])) { ws.close(); resolve(); }
      };
    }), room);

    await unlock(a, 'multi-remove-password');
    await rowClick(a, '001');
    await rowClick(a, 'kimchi');
    await a.waitForFunction(() => document.querySelectorAll('#roster .rp.sel').length === 2);

    await unlock(b, 'multi-remove-password');
    await b.waitForFunction(() => document.querySelectorAll('#roster .rp.sel').length === 2, null, { timeout: 5000 });
    await openRemove(b, '001');
    assert.match(await b.locator('#removePlayerImpact').textContent(), /Kingdom 1.*Sacrifice/i, 'dialog lists canonical staged impact');

    await a.locator('#roster .roster-role[data-pid="001"]').click();
    await b.waitForFunction(() => /Kingdom 1.*Main/i.test(document.querySelector('#removePlayerImpact')?.textContent || ''), null, { timeout: 5000 });
    await b.locator('#removePlayerConfirm').click();
    assert.equal(await b.locator('#roster .rp[data-pid="001"]').count(), 1, 'changed impact requires a fresh confirmation click');
    assert.match(await b.locator('#removePlayerStatus').textContent(), /changed|review|again/i);
    await b.locator('#removePlayerConfirm').click();
    await Promise.all([
      b.locator('#roster .rp[data-pid="001"]').waitFor({ state: 'detached', timeout: 5000 }),
      a.locator('#roster .rp[data-pid="001"]').waitFor({ state: 'detached', timeout: 5000 })
    ]);
    assert.doesNotMatch(await a.locator('#pickSlots').textContent(), /Test 001/);
    assert.equal(await a.locator('#fireDouble').isDisabled(), true, 'removal prunes every manager and disables ghost Fire');

    await rowClick(a, 'hml');
    await a.waitForFunction(() => document.querySelectorAll('#roster .rp.sel').length === 2);
    await b.waitForFunction(() => document.querySelectorAll('#roster .rp.sel').length === 2, null, { timeout: 5000 });
    await openRemove(b, 'kimchi');
    await a.locator('#fireDouble').click();
    await a.waitForTimeout(250);
    await a.locator('#fireDouble').click();
    await b.waitForFunction(() => document.querySelector('#removePlayerConfirm')?.disabled === true && /live|active|cancel/i.test(document.querySelector('#removePlayerStatus')?.textContent || ''), null, { timeout: 5000 });
    assert.equal(await b.locator('#roster .rp[data-pid="kimchi"]').count(), 1, 'Fire while the dialog is open disables confirmation without deleting');
    await b.locator('#removePlayerCancel').click();

    await b.locator('#roster .roster-actions[data-pid="kimchi"]').click();
    const removeItem = b.locator('#rosterActionsMenu [data-action="remove"]');
    assert.equal(await removeItem.getAttribute('aria-disabled'), 'true', 'active player removal remains focusable but unavailable');
    await removeItem.focus();
    assert.equal(await b.evaluate(() => document.activeElement?.dataset.action), 'remove');
    assert.match(await b.locator('#rosterActionsExplanation').textContent(), /live|active|cancel/i);

    assertQaRoomName(room);
    const forced = await b.evaluate(({ roomName, password }) => new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      const timer = setTimeout(() => reject(new Error('forced removal timeout')), 4000);
      let before = null;
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.t === 'state' && !before) {
          before = message.room.live;
          ws.send(JSON.stringify({ t: 'removePlayer', password, pid: 'kimchi' }));
        } else if (message.t === 'error') {
          ws.close();
          const verify = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
          verify.onmessage = verifyEvent => {
            const current = JSON.parse(verifyEvent.data);
            if (current.t !== 'state') return;
            clearTimeout(timer); verify.close(); resolve({ error: message, before, after: current.room.live });
          };
        }
      };
    }), { roomName: room, password: 'multi-remove-password' });
    assert.deepEqual(forced.error, { t: 'error', error: 'player_in_live_command', pid: 'kimchi' });
    assert.deepEqual(forced.after, forced.before, 'forced rejection preserves command, staging, and live metadata atomically');
    assert.equal(await a.locator('#roster .rp[data-pid="kimchi"]').count(), 1, 'forced rejection preserves the live captain');
    assert.deepEqual(errors, []);
    console.log(`✓ staged-aware multi-manager removal and live protection (${room})`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
