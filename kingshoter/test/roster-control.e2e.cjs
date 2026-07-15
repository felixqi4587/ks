const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { assertQaRoomName, makeQaRoom, qaRoomUrl, installQaWebSocketGuard } = require('./support/qa-kvk.cjs');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const room = makeQaRoom('roster-control');
const url = qaRoomUrl(base, room, { notour: 1 });
const profileKey = '30000000-0000-4000-8000-000000000003';
const duplicateOne = 'n_aaaaaaaaaaaaaaaaaa1111';
const duplicateTwo = 'n_bbbbbbbbbbbbbbbbbb2222';
const players = [
  { pid: duplicateOne, name: 'Tester', march: 35, identityMode: 'nickname' },
  { pid: duplicateTwo, name: 'Tester', march: 36, identityMode: 'nickname' },
  { pid: '900000001', name: '$&', march: 37, identityMode: 'playerId' },
  { pid: '900000002', name: 'Bravo', march: 38, identityMode: 'playerId' },
  { pid: '900000003', name: 'Charlie', march: 39, identityMode: 'playerId' },
  { pid: '900000004', name: 'Delta', march: 40, identityMode: 'playerId' },
  { pid: '900000005', name: 'Echo', march: 41, identityMode: 'playerId' }
];

async function sendMessages(page, messages) {
  assertQaRoomName(room);
  await page.evaluate(({ roomName, payloads }) => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    const timer = setTimeout(() => reject(new Error('QA WebSocket timeout')), 5000);
    socket.onopen = () => {
      payloads.forEach(payload => socket.send(JSON.stringify(payload)));
      setTimeout(() => { clearTimeout(timer); socket.close(); resolve(); }, 400);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('QA WebSocket failed')); };
  }), { roomName: room, payloads: messages });
}

async function assertLayout(page, width) {
  await page.setViewportSize({ width, height: 900 });
  const result = await page.evaluate(() => {
    const roster = document.querySelector('#roster');
    const controls = Array.from(document.querySelectorAll('#roster .rp, #roster .roster-role, #roster .roster-time, #roster .roster-actions'));
    return {
      documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      rosterFits: roster.scrollWidth <= roster.clientWidth,
      height: roster.getBoundingClientRect().height,
      scrollsVertically: roster.scrollHeight > roster.clientHeight,
      minTarget: Math.min(...controls.map(control => control.getBoundingClientRect().height))
    };
  });
  assert.equal(result.documentFits, true, `${width}px page has no horizontal overflow`);
  assert.equal(result.rosterFits, true, `${width}px roster has no horizontal overflow`);
  assert.ok(result.height <= 202, `${width}px roster remains bounded`);
  assert.equal(result.scrollsVertically, true, `${width}px roster scrolls vertically`);
  assert.ok(result.minTarget >= 44, `${width}px controls keep 44px targets`);
}

(async () => {
  console.log(`QA room: ${room}`);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US' });
  const errors = [];
  let hideK2Stage = false;
  try {
    await installQaWebSocketGuard(context, room, {
      shouldDropServerMessage({ data }) {
        if (!hideK2Stage) return false;
        try {
          const message = JSON.parse(String(data));
          const pairs = message.t === 'state' && message.room && message.room.live && message.room.live.staged && message.room.live.staged['2'] && message.room.live.staged['2'].pairs;
          return Array.isArray(pairs) && pairs.some(pair => pair.pid === '900000005');
        } catch (_) { return false; }
      }
    });
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__qaRosterSocketCount = (window.__qaRosterSocketCount || 0) + 1;
          if (window.__qaRosterSocketCount === 1) {
            this.addEventListener('message', event => {
              try {
                const message = JSON.parse(String(event.data));
                if (message.t === 'state') {
                  window.__qaRosterStateSequence = (window.__qaRosterStateSequence || 0) + 1;
                  const staged = message.room && message.room.live && message.room.live.staged;
                  const pairs = staged && staged['1'] && staged['1'].pairs;
                  window.__qaRosterCanonicalK1 = Array.isArray(pairs) ? pairs.map(pair => pair.pid) : [];
                }
              } catch (_) {}
            });
          }
        }
        send(data) {
          let message = null;
          try { message = JSON.parse(String(data)); } catch (_) {}
          if (window.__qaFailNextStage && message && message.t === 'stage') {
            window.__qaFailNextStage = false;
            throw new Error('QA forced stage send failure');
          }
          return super.send(data);
        }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.locator('#soundGate').click();
    await sendMessages(page, players.map(player => Object.assign({ t: 'registerPlayer', profileKey }, player)));
    await page.locator('#cmdUnlock').click();
    await page.locator('#pwInput').fill('roster-password');
    await page.locator('#pwGo').click();
    await page.locator('#console').waitFor({ state: 'visible' });

    assert.equal(await page.locator('link[href="app.css?v=2026071502"]').count(), 1);
    assert.equal(await page.locator('script[src="/app.js?v=2026071502"]').count(), 1);
    assert.equal(await page.locator('script[src="/kvk.js?v=2026071502"]').count(), 1);
    await page.locator('#roster .roster-row').first().waitFor();
    assert.equal(await page.locator('#roster .roster-row').count(), 7);
    assert.equal(await page.locator('#rosterSearchWrap').isVisible(), true);
    await assertLayout(page, 375);
    await assertLayout(page, 390);

    const suffixOne = page.locator(`#roster .roster-row[data-pid="${duplicateOne}"] .roster-name-suffix`);
    const suffixTwo = page.locator(`#roster .roster-row[data-pid="${duplicateTwo}"] .roster-name-suffix`);
    assert.match(await suffixOne.textContent(), /1111/);
    assert.match(await suffixTwo.textContent(), /2222/);
    const uniqueSuffix = page.locator('#roster .roster-row[data-pid="900000001"] .roster-name-suffix');
    assert.equal(await uniqueSuffix.count(), 1);
    assert.equal(await uniqueSuffix.isHidden(), true);
    assert.equal(await uniqueSuffix.textContent(), '');
    assert.equal(await page.locator('#roster .roster-time[data-pid="900000001"]').getAttribute('aria-label'), "Edit $&'s march time · 0:37");

    const primary = pid => page.locator(`#roster .rp[data-pid="${pid}"]`);
    const expectStage = async (pid, staged, afterSequence) => {
      await page.waitForFunction(({ targetPid, expected, sequence }) => {
        const button = document.querySelector(`#roster .rp[data-pid="${targetPid}"]`);
        const inSlot = Array.from(document.querySelectorAll('#pickSlots .slot[data-pid]')).some(slot => slot.dataset.pid === targetPid);
        const canonical = Array.isArray(window.__qaRosterCanonicalK1) && window.__qaRosterCanonicalK1.includes(targetPid);
        return (window.__qaRosterStateSequence || 0) > sequence && canonical === expected && button &&
          (button.getAttribute('aria-pressed') === 'true') === expected && inSlot === expected;
      }, { targetPid: pid, expected: staged, sequence: afterSequence });
      assert.equal(await primary(pid).getAttribute('aria-pressed'), staged ? 'true' : 'false');
    };
    const expectCanonicalStage = async (pids, afterSequence) => {
      const expected = pids.slice().sort();
      await page.waitForFunction(({ targetPids, sequence }) => {
        const canonical = Array.isArray(window.__qaRosterCanonicalK1) ? window.__qaRosterCanonicalK1.slice().sort() : [];
        return (window.__qaRosterStateSequence || 0) > sequence && canonical.length === targetPids.length &&
          canonical.every((pid, index) => pid === targetPids[index]);
      }, { targetPids: expected, sequence: afterSequence });
    };
    const rosterOrder = () => page.locator('#roster .roster-row').evaluateAll(rows => rows.map(row => row.dataset.pid));

    const interruptedTarget = primary('900000004');
    await interruptedTarget.scrollIntoViewIfNeeded();
    const original = await interruptedTarget.elementHandle();
    const box = await interruptedTarget.boundingBox();
    assert.ok(original);
    assert.ok(box);
    await original.evaluate(node => {
      window.__qaInterruptedRosterClickTrusted = null;
      node.addEventListener('click', event => { window.__qaInterruptedRosterClickTrusted = event.isTrusted; }, { once: true });
    });
    const stateSequence = await page.evaluate(() => window.__qaRosterStateSequence || 0);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await sendMessages(page, []);
    await page.waitForFunction(sequence => (window.__qaRosterStateSequence || 0) > sequence, stateSequence);
    assert.equal(await original.evaluate(node => node.isConnected), true, 'room broadcasts preserve the pressed roster button');
    const stageSequence = await page.evaluate(() => window.__qaRosterStateSequence || 0);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.__qaInterruptedRosterClickTrusted), true, 'mouseup produces a trusted click');
    assert.equal(await primary('900000004').getAttribute('aria-pressed'), 'true');
    await expectStage('900000004', true, stageSequence);
    assert.equal(await primary('900000004').getAttribute('aria-pressed'), 'true', 'selection survives the canonical stage snapshot');
    const unstageSequence = await page.evaluate(() => window.__qaRosterStateSequence || 0);
    await primary('900000004').click();
    await expectStage('900000004', false, unstageSequence);

    const stableA = '900000001', stableB = '900000002', stableC = '900000003', stableD = '900000004';
    let canonicalSequence = await page.evaluate(() => window.__qaRosterStateSequence || 0);
    await sendMessages(page, [{
      t: 'stage', password: 'roster-password',
      staged: { kingdom: 1, pairs: [{ pid: stableA, role: 'weak' }, { pid: stableC, role: 'main' }] }
    }]);
    await expectCanonicalStage([stableA, stableC], canonicalSequence);
    const oldOrder = await rosterOrder();
    assert.deepEqual(oldOrder.slice(0, 4), [stableA, stableC, stableB, stableD]);

    const stableTarget = primary(stableB);
    await stableTarget.scrollIntoViewIfNeeded();
    await stableTarget.focus();
    const stableButton = await stableTarget.elementHandle();
    const stableRow = await page.locator(`#roster .roster-row[data-pid="${stableB}"]`).elementHandle();
    const stableBox = await stableTarget.boundingBox();
    assert.ok(stableButton);
    assert.ok(stableRow);
    assert.ok(stableBox);
    await stableRow.evaluate(row => {
      window.__qaStableRosterRowMutations = 0;
      window.__qaStableRosterRowObserver = new MutationObserver(records => {
        records.forEach(record => {
          const moved = Array.from(record.removedNodes).concat(Array.from(record.addedNodes)).some(node => node === row);
          if (moved) window.__qaStableRosterRowMutations += 1;
        });
      });
      window.__qaStableRosterRowObserver.observe(row.parentElement, { childList: true });
    });
    await stableButton.evaluate(node => {
      window.__qaStableRosterClickTrusted = null;
      node.addEventListener('click', event => { window.__qaStableRosterClickTrusted = event.isTrusted; }, { once: true });
    });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.matches('.rp[data-pid="900000002"]')), true);
    await page.mouse.move(stableBox.x + stableBox.width / 2, stableBox.y + stableBox.height / 2);
    await page.mouse.down();
    canonicalSequence = await page.evaluate(() => window.__qaRosterStateSequence || 0);
    await sendMessages(page, [{
      t: 'stage', password: 'roster-password',
      staged: { kingdom: 1, pairs: [{ pid: stableA, role: 'weak' }, { pid: stableD, role: 'main' }] }
    }]);
    await expectCanonicalStage([stableA, stableD], canonicalSequence);
    const newOrder = await rosterOrder();
    assert.deepEqual(newOrder, oldOrder, 'an active roster pointer freezes surrounding row order too');
    assert.equal(oldOrder.indexOf(stableB), newOrder.indexOf(stableB), 'stable B keeps its final sorted index');
    assert.equal(await page.evaluate(() => window.__qaStableRosterRowMutations), 0, 'stable B row is never removed or reinserted');
    assert.equal(await stableRow.evaluate(row => row.isConnected), true);
    assert.equal(await stableButton.evaluate(node => node.isConnected), true);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.matches('.rp[data-pid="900000002"]')), true, 'stable B keeps focus during surrounding reorder');
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.__qaStableRosterClickTrusted), true, 'stable B mouseup produces a trusted click');
    await page.locator('#replaceOvl').waitFor({ state: 'visible' });
    await page.waitForFunction(({ first, second, third, fourth }) => {
      const order = Array.from(document.querySelectorAll('#roster .roster-row')).map(row => row.dataset.pid);
      return order.slice(0, 4).join(',') === [first, second, third, fourth].join(',');
    }, { first: stableA, second: stableD, third: stableB, fourth: stableC });
    await page.locator('#replaceCancel').click();
    await page.evaluate(() => window.__qaStableRosterRowObserver.disconnect());

    canonicalSequence = await page.evaluate(() => window.__qaRosterStateSequence || 0);
    await sendMessages(page, [{
      t: 'stage', password: 'roster-password',
      staged: { kingdom: 1, pairs: [{ pid: stableA, role: 'weak' }, { pid: stableC, role: 'main' }] }
    }]);
    await expectCanonicalStage([stableA, stableC], canonicalSequence);
    const movingOrderBefore = await rosterOrder();
    assert.deepEqual(movingOrderBefore.slice(0, 4), [stableA, stableC, stableB, stableD]);
    const movingTarget = primary(stableB);
    await movingTarget.scrollIntoViewIfNeeded();
    const movingButton = await movingTarget.elementHandle();
    const movingRow = await page.locator(`#roster .roster-row[data-pid="${stableB}"]`).elementHandle();
    const movingBox = await movingTarget.boundingBox();
    assert.ok(movingButton);
    assert.ok(movingRow);
    assert.ok(movingBox);
    await movingRow.evaluate(row => {
      window.__qaMovingRosterRowMutations = 0;
      window.__qaMovingRosterOrderAtPointerUp = null;
      window.__qaMovingRosterMutationsAtPointerUp = null;
      window.__qaMovingRosterRowObserver = new MutationObserver(records => {
        records.forEach(record => {
          const moved = Array.from(record.removedNodes).concat(Array.from(record.addedNodes)).some(node => node === row);
          if (moved) window.__qaMovingRosterRowMutations += 1;
        });
      });
      window.__qaMovingRosterRowObserver.observe(row.parentElement, { childList: true });
    });
    await movingButton.evaluate(node => {
      window.__qaMovingRosterClickTrusted = null;
      node.addEventListener('pointerup', () => {
        window.__qaMovingRosterOrderAtPointerUp = Array.from(document.querySelectorAll('#roster .roster-row')).map(row => row.dataset.pid);
        window.__qaMovingRosterMutationsAtPointerUp = window.__qaMovingRosterRowMutations;
      }, { once: true });
      node.addEventListener('click', event => { window.__qaMovingRosterClickTrusted = event.isTrusted; }, { once: true });
    });
    await page.mouse.move(movingBox.x + movingBox.width / 2, movingBox.y + movingBox.height / 2);
    await page.mouse.down();
    canonicalSequence = await page.evaluate(() => window.__qaRosterStateSequence || 0);
    await sendMessages(page, [{
      t: 'stage', password: 'roster-password',
      staged: { kingdom: 1, pairs: [{ pid: stableC, role: 'weak' }, { pid: stableD, role: 'main' }] }
    }]);
    await expectCanonicalStage([stableC, stableD], canonicalSequence);
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => window.__qaMovingRosterOrderAtPointerUp), movingOrderBefore,
      'an active roster pointer freezes the entire row order until pointerup');
    assert.equal(await page.evaluate(() => window.__qaMovingRosterMutationsAtPointerUp), 0,
      'the pressed moving row is never removed or reinserted before pointerup');
    assert.equal(await page.evaluate(() => window.__qaMovingRosterClickTrusted), true,
      'a moving-row mouseup still produces a trusted click');
    await page.locator('#replaceOvl').waitFor({ state: 'visible' });
    await page.locator('#replaceCancel').click();
    await page.evaluate(() => window.__qaMovingRosterRowObserver.disconnect());

    canonicalSequence = await page.evaluate(() => window.__qaRosterStateSequence || 0);
    await sendMessages(page, [{ t: 'stage', password: 'roster-password', staged: { kingdom: 1, pairs: [] } }]);
    await expectCanonicalStage([], canonicalSequence);
    assert.equal(await page.locator('#roster .rp[aria-pressed="true"]').count(), 0, 'stable-row scenario clears canonical stage');

    await primary('900000001').click();
    await primary('900000002').click();
    assert.equal(await page.locator('#roster .rp[aria-pressed="true"]').count(), 2);
    await page.locator('#roster .roster-role[data-pid="900000001"]').click();
    await page.locator('#roster .roster-time[data-pid="900000001"]').click({ force: true });
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#roster .roster-actions[data-pid="900000001"]').click();
    assert.equal(await page.locator('#roster .rp[aria-pressed="true"]').count(), 2, 'sibling controls never toggle selection');
    await page.evaluate(() => { window.__qaFailNextStage = true; });
    await primary('900000002').click();
    await page.waitForFunction(() => document.querySelectorAll('#roster .rp[aria-pressed="true"]').length === 2);
    assert.equal(await primary('900000002').getAttribute('aria-pressed'), 'true', 'send(false) restores the prior picks');

    await primary('900000003').click();
    await page.locator('#replaceOvl').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#roster .rp[aria-pressed="true"]').count(), 2, 'third tap does not silently shift a pick');
    await page.locator('#replaceWeak').focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'replaceCancel', 'modal wraps backward focus');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'replaceWeak', 'modal wraps forward focus');
    assert.equal(await page.locator('.wrap').getAttribute('inert'), '', 'replacement makes the background inert');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.wrap').getAttribute('inert'), null, 'closing replacement restores the background');
    await page.waitForFunction(() => document.activeElement && document.activeElement.matches('.rp[data-pid="900000003"]'));
    await primary('900000003').click();
    await page.locator('#replaceOvl').waitFor({ state: 'visible' });
    await page.locator('#replaceCancel').click();
    await page.waitForFunction(() => document.activeElement && document.activeElement.matches('.rp[data-pid="900000003"]'));
    assert.equal(await page.locator('#roster .rp[aria-pressed="true"]').count(), 2);
    await primary('900000003').click();
    await page.locator('#replaceWeak').click();
    assert.equal(await primary('900000003').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#pickSlots .slot.weak').getAttribute('data-pid'), '900000003');
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.matches('.rp[data-pid="900000003"]')), true, 'Apply keeps focus after the canonical stage snapshot');
    await sendMessages(page, [{
      t: 'setPlayerMarch', mutationId: 'roster-remote-1', password: 'roster-password',
      pid: '900000003', march: 49, baseRevision: 0
    }]);
    await page.locator('#roster .roster-time[data-pid="900000003"]').filter({ hasText: '0:49' }).waitFor();
    await page.locator('#pickSlots .slot.weak small').filter({ hasText: '0:49' }).waitFor();

    await page.locator('#rosterSearch').fill('Tester');
    assert.equal(await page.locator('#roster .roster-row:visible').count(), 2);
    await page.locator('#rosterSearch').fill('900000002');
    assert.equal(await page.locator('#roster .roster-row:visible').count(), 1);
    await page.locator('#rosterSearch').fill('no-results');
    assert.equal(await page.locator('#roster .roster-row:visible').count(), 0);
    assert.equal(await page.locator('#pickSlots .slot.filled').count(), 2, 'zero-result search preserves slots');
    assert.equal(await page.locator('#fireDouble').isDisabled(), false, 'zero-result search preserves Fire readiness');
    await page.locator('#rosterSearch').fill('');

    hideK2Stage = true;
    await sendMessages(page, [{
      t: 'stage', password: 'roster-password',
      staged: { kingdom: 2, pairs: [{ pid: '900000005', role: 'weak' }] }
    }]);
    await primary('900000005').click();
    await page.locator('#replaceWeak').click();
    await page.waitForFunction(() => {
      const rejected = document.querySelector('#roster .rp[data-pid="900000005"]');
      const weak = document.querySelector('#pickSlots .slot.weak');
      return rejected && rejected.getAttribute('aria-pressed') === 'false' && weak && weak.dataset.pid === '900000003';
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.matches('.rp[data-pid="900000005"]')), true, 'rejected Apply restores focus after rollback');
    hideK2Stage = false;

    await primary('900000004').click();
    await page.locator('#replaceOvl').waitFor({ state: 'visible' });
    await sendMessages(page, [{ t: 'removePlayer', password: 'roster-password', pid: '900000004' }]);
    await page.locator('#roster .roster-row[data-pid="900000004"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#replaceOvl').isVisible(), false, 'remote removal closes a stale replacement');
    assert.equal(await page.locator('#rosterSearchWrap').isVisible(), false, 'search hides at six players');
    assert.equal(await page.locator('#rosterSearch').inputValue(), '', 'hidden search is cleared');
    assert.deepEqual(errors, []);
    console.log(`✓ canonical vertical roster controls (${room})`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
