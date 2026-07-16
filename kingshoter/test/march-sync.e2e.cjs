const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { makeQaRoom, qaRoomUrl, installQaWebSocketGuard, assertQaRoomName } = require('./support/qa-kvk.cjs');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const room = makeQaRoom('march-sync');
const url = qaRoomUrl(base, room, { notour: 1, lang: 'en' });
const password = 'march-sync-password';
const pid = '810000001';
const secondPid = '810000002';
const reconnectMissingPid = '810000003';
const reconnectMismatchPid = '810000004';
const legacyPid = 'legacy-march';
const profileKey = '81000000-0000-4000-8000-000000000001';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function createPacketGate() {
  return { holdAck: false, holdState: false, acks: [], states: [], clientMutations: [] };
}

function gateOptions(gate) {
  return {
    shouldDropClientMessage({ data }) {
      try {
        const message = JSON.parse(String(data));
        if (message.t === 'setPlayerMarch') gate.clientMutations.push(message);
      } catch (_) {}
      return false;
    },
    shouldDropServerMessage({ data }) {
      try {
        const message = JSON.parse(String(data));
        if (gate.holdAck && message.t === 'playerMarchSaved') { gate.acks.push(String(data)); return true; }
        if (gate.holdState && message.t === 'state') { gate.states.push(String(data)); return true; }
      } catch (_) {}
      return false;
    }
  };
}

async function waitForValue(read, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function injectPacket(page, data) {
  await page.waitForFunction(() => Array.isArray(window.__qaRoomSockets) && window.__qaRoomSockets.some(candidate => candidate.readyState === WebSocket.OPEN && typeof candidate.onmessage === 'function'));
  await page.evaluate(packet => {
    const socket = window.__qaRoomSockets.filter(candidate => candidate.readyState === WebSocket.OPEN).at(-1);
    if (!socket || typeof socket.onmessage !== 'function') throw new Error('No current room socket for injected packet');
    socket.onmessage({ data: packet });
  }, data);
}

async function injectHeld(page, gate, kind, takeLast = false) {
  const packets = kind === 'ack' ? gate.acks : gate.states;
  const packet = takeLast ? packets.pop() : packets.shift();
  assert.ok(packet, `held ${kind} packet exists`);
  await injectPacket(page, packet);
  return JSON.parse(packet);
}

async function installSocketTracking(context) {
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__qaRoomSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) { super(...args); window.__qaRoomSockets.push(this); }
      send(data) {
        let message = null;
        try { message = JSON.parse(String(data)); } catch (_) {}
        if (window.__qaFailNextCommanderMarch && message && message.t === 'setPlayerMarch') {
          window.__qaFailNextCommanderMarch = false;
          throw new Error('QA forced commander march send failure');
        }
        return super.send(data);
      }
    };
  });
}

async function sendMessages(page, messages) {
  assertQaRoomName(room);
  await page.evaluate(({ roomName, payloads }) => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    const timer = setTimeout(() => reject(new Error('QA WebSocket timeout')), 5000);
    socket.onopen = () => {
      payloads.forEach(payload => socket.send(JSON.stringify(payload)));
      setTimeout(() => { clearTimeout(timer); socket.close(); resolve(); }, 300);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('QA WebSocket failed')); };
  }), { roomName: room, payloads: messages });
}

async function readRoom(page) {
  assertQaRoomName(room);
  return page.evaluate(roomName => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    const timer = setTimeout(() => reject(new Error('QA room snapshot timeout')), 5000);
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.t !== 'state') return;
      clearTimeout(timer); socket.close(); resolve(message.room);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('QA room snapshot failed')); };
  }), room);
}

async function enableAndUnlock(page, pageUrl = url) {
  await page.goto(pageUrl);
  await page.locator('#soundGate').click();
  await page.locator('#cmdUnlock').click();
  await page.locator('#pwInput').fill(password);
  await page.locator('#pwGo').click();
  await page.locator('#console').waitFor({ state: 'visible' });
  await page.locator(`#roster .roster-time[data-pid="${pid}"]`).waitFor();
}

(async () => {
  console.log(`QA room: ${room}`);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const bootstrapContext = await browser.newContext({ locale: 'en-US' });
  const commanderAContext = await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US' });
  const commanderBContext = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'zh-CN' });
  const playerContext = await browser.newContext({ locale: 'en-US' });
  const pageErrors = [];
  const gateA = createPacketGate();
  const gateB = createPacketGate();
  try {
    await Promise.all([
      installQaWebSocketGuard(bootstrapContext, room),
      installQaWebSocketGuard(commanderAContext, room, gateOptions(gateA)),
      installQaWebSocketGuard(commanderBContext, room, gateOptions(gateB)),
      installQaWebSocketGuard(playerContext, room)
    ]);
    await Promise.all([installSocketTracking(commanderAContext), installSocketTracking(commanderBContext)]);
    await playerContext.addInitScript(({ key, playerPid, ownerKey }) => {
      localStorage.setItem(key, JSON.stringify({
        pid: playerPid, name: 'March Captain', march: 40, marchRevision: 0,
        identityMode: 'playerId', profileKey: ownerKey
      }));
    }, { key: `kingshoter_r_${room}_me`, playerPid: pid, ownerKey: profileKey });
    const bootstrap = await bootstrapContext.newPage();
    await bootstrap.goto(url);
    await sendMessages(bootstrap, [
      { t: 'setConfig', password, config: { castleName: '', rallyAllies: [], enemyWhales: [] }, by: 'march-sync-bootstrap' },
      { t: 'registerPlayer', pid, name: 'March Captain', march: 40, identityMode: 'playerId', alliance: '', profileKey },
      { t: 'registerPlayer', pid: secondPid, name: 'Second Captain', march: 44, identityMode: 'playerId', alliance: '', profileKey },
      { t: 'registerPlayer', pid: reconnectMissingPid, name: 'Reconnect Captain', march: 42, identityMode: 'playerId', alliance: '', profileKey },
      { t: 'registerPlayer', pid: reconnectMismatchPid, name: 'Mismatch Captain', march: 43, identityMode: 'playerId', alliance: '', profileKey },
      ...Array.from({ length: 4 }, (_, index) => ({
        t: 'registerPlayer', pid: `81000001${index}`, name: `Reserve ${index + 1}`, march: 35 + index,
        identityMode: 'playerId', alliance: '', profileKey
      }))
    ]);

    const commanderA = await commanderAContext.newPage();
    const commanderB = await commanderBContext.newPage();
    const player = await playerContext.newPage();
    for (const [name, page] of [['commander A', commanderA], ['commander B', commanderB], ['player', player]]) {
      page.on('pageerror', error => pageErrors.push(`${name}: ${error.message}`));
    }
    await Promise.all([
      enableAndUnlock(commanderA, qaRoomUrl(base, room, { notour: 1, lang: 'en' })),
      enableAndUnlock(commanderB, qaRoomUrl(base, room, { notour: 1, lang: 'zh' })),
      player.goto(url)
    ]);

    assert.equal(await commanderA.locator('link[href="app.css?v=2026071601"]').count(), 1);
    assert.equal(await commanderA.locator('script[src="/app.js?v=2026071601"]').count(), 1);
    assert.equal(await commanderA.locator('script[src="/kvk.js?v=2026071601"]').count(), 1);

    const canonicalBeforeLegacy = await readRoom(bootstrap);
    const legacyRoom = structuredClone(canonicalBeforeLegacy);
    legacyRoom.players[legacyPid] = { name: 'Legacy Captain', march: 240, marchRevision: 0, identityMode: 'playerId', alliance: '', ready: false };
    await injectPacket(commanderA, JSON.stringify({ t: 'state', room: legacyRoom }));
    await commanderA.locator(`#roster .roster-time[data-pid="${legacyPid}"]`).click();
    await injectPacket(commanderA, JSON.stringify({ t: 'state', room: legacyRoom }));
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true, 'legacy out-of-range march remains repairable');
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '2:00', 'legacy repair draft starts inside the accepted range');
    assert.match(await commanderA.locator('#commanderMarchLatest').textContent(), /4:00/, 'legacy canonical value remains visible');
    await commanderA.locator('#commanderMarchCancel').click();
    await injectPacket(commanderA, JSON.stringify({ t: 'state', room: canonicalBeforeLegacy }));
    await commanderA.locator(`#roster .roster-row[data-pid="${legacyPid}"]`).waitFor({ state: 'detached' });

    await commanderA.locator(`#roster .rp[data-pid="${pid}"]`).click();
    await commanderA.locator(`#roster .rp[data-pid="${secondPid}"]`).click();
    await Promise.all([
      commanderA.locator(`#pickSlots .slot[data-pid="${pid}"]`).waitFor(),
      commanderA.locator(`#pickSlots .slot[data-pid="${secondPid}"]`).waitFor(),
      commanderB.locator(`#pickSlots .slot[data-pid="${pid}"]`).waitFor(),
      commanderB.locator(`#pickSlots .slot[data-pid="${secondPid}"]`).waitFor()
    ]);

    const timeA = commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`);
    await timeA.click();
    const editorA = commanderA.locator('#commanderMarchEditor');
    await editorA.waitFor({ state: 'visible' });
    assert.equal(await timeA.getAttribute('aria-expanded'), 'true');
    assert.equal(await commanderA.locator('#commanderMarchInput').getAttribute('inputmode'), 'text');
    assert.equal(await commanderA.evaluate(() => document.activeElement && document.activeElement.id), 'commanderMarchInput');
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '0:40');
    assert.equal(await commanderA.locator('#fireDock').evaluate(element => element.classList.contains('nofix')), true, 'focused editor yields the sticky Fire dock to the keyboard');
    assert.equal(await commanderA.locator('#commanderMarchEditor').getAttribute('role'), 'group');
    assert.equal(await commanderA.locator('.commander-march-steps').getAttribute('role'), 'group');
    assert.equal(await commanderA.locator('.commander-march-steps').getAttribute('aria-label'), 'Adjust march time');
    assert.match(await commanderA.locator('[data-march-delta="-5"]').getAttribute('aria-label'), /5 seconds/i);
    assert.equal(await commanderA.locator('#commanderMarchInput').getAttribute('aria-describedby'), 'commanderMarchLatest commanderMarchStatus commanderMarchActiveHint');
    const editorTargets = await commanderA.locator('#commanderMarchEditor button, #commanderMarchInput').evaluateAll(elements => elements.filter(element => element.offsetParent !== null).map(element => element.getBoundingClientRect().height));
    assert.ok(Math.min(...editorTargets) >= 44, 'all editor controls retain 44px targets');

    const beforeInitialSave = gateA.clientMutations.length;
    await commanderA.locator('#commanderMarchInput').fill('0:45');
    await commanderA.locator('#commanderMarchSave').click();
    await waitForValue(() => gateA.clientMutations.length > beforeInitialSave, 'initial commander march mutation');
    try { await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden', timeout: 8000 }); }
    catch (_) {
      assert.fail(JSON.stringify({
        status: await commanderA.locator('#commanderMarchStatus').textContent(),
        busy: await commanderA.locator('#commanderMarchEditor').getAttribute('aria-busy'),
        draft: await commanderA.locator('#commanderMarchInput').inputValue(),
        row: await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).textContent(),
        errors: pageErrors.slice()
      }));
    }
    await Promise.all([
      commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).filter({ hasText: '0:45' }).waitFor(),
      commanderB.locator(`#roster .roster-time[data-pid="${pid}"]`).filter({ hasText: '0:45' }).waitFor(),
      commanderA.locator(`#pickSlots [data-pid="${pid}"] small`).filter({ hasText: '0:45' }).waitFor(),
      commanderB.locator(`#pickSlots [data-pid="${pid}"] small`).filter({ hasText: '0:45' }).waitFor(),
      player.waitForFunction(playerPid => {
        const state = JSON.parse(localStorage.getItem(`kingshoter_r_${new URL(location.href).searchParams.get('room')}_me`) || 'null');
        return !!(state && state.pid === playerPid && state.march === 45);
      }, pid)
    ]);

    await commanderB.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderB.locator('#commanderMarchInput').fill('0:46');
    assert.match(await commanderB.locator('#commanderMarchTitle').textContent(), /修改/);
    assert.match(await commanderB.locator('.commander-march-steps').getAttribute('aria-label'), /调整/);
    assert.match(await commanderB.locator('[data-march-delta="5"]').getAttribute('aria-label'), /5 秒/);
    const press = Math.floor(Date.now() / 1000) + 60;
    await sendMessages(commanderA, [{
      t: 'cmd', password, cmd: {
        type: 'double_rally', kingdom: 1, anchorUTC: press,
        payload: {
          firstPress: press, kingdom: 1,
          pairs: [
            { pid, role: 'weak', march: 999, pressUTC: press },
            { pid: secondPid, role: 'main', march: 999, pressUTC: press + 1 }
          ]
        }
      }
    }]);
    await sendMessages(commanderA, [{
      t: 'setPlayerMarch', mutationId: 'remote-47', password, pid, march: 47, baseRevision: 1
    }]);
    await commanderB.locator('#commanderMarchLatest').filter({ hasText: '0:47' }).waitFor();
    assert.equal(await commanderB.locator('#commanderMarchInput').inputValue(), '0:46', 'dirty draft survives canonical updates');
    assert.equal(await commanderB.evaluate(() => document.activeElement && document.activeElement.id), 'commanderMarchInput', 'remote state does not steal focus');
    const frozen = await readRoom(commanderA);
    assert.equal(frozen.live.commands['1'].payload.pairs.find(pair => pair.pid === pid).march, 45, 'active command keeps the pre-edit canonical march');
    await sendMessages(commanderA, [{ t: 'cmd', password, cmd: { type: 'cancel', kingdom: 1 } }]);

    const beforeFirstAdopt = gateB.clientMutations.length;
    assert.equal(await commanderB.locator('#commanderMarchAdopt').isDisabled(), false);
    await commanderB.locator('#commanderMarchAdopt').click();
    await commanderB.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    assert.equal(gateB.clientMutations.length, beforeFirstAdopt, 'Adopt latest sends no mutation');

    // State first: the editor remains pending until its exact ACK is released.
    gateA.acks.length = 0; gateA.holdAck = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:48');
    await commanderA.locator('#commanderMarchSave').click();
    await waitForValue(() => gateA.acks.length, 'held state-first ACK');
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).filter({ hasText: '0:48' }).waitFor();
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true);
    assert.equal(await commanderA.locator('#commanderMarchEditor').getAttribute('aria-busy'), 'true');
    assert.equal(await commanderA.evaluate(() => document.activeElement && document.activeElement.id), 'commanderMarchSave', 'pending save retains focus');
    assert.equal(await commanderA.locator('#commanderMarchCancel').evaluate(element => element.disabled), false, 'pending controls remain natively focusable');
    assert.equal(await commanderA.locator('#commanderMarchCancel').getAttribute('aria-disabled'), 'true');
    assert.equal(await commanderA.locator('#fireDock').evaluate(element => element.classList.contains('nofix')), true, 'pending focus keeps the Fire dock yielded');
    await commanderA.keyboard.press('Escape');
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true, 'pending editor blocks Escape');
    const exactStateFirstRoom = await readRoom(bootstrap);
    const regressedStateFirstRoom = structuredClone(exactStateFirstRoom);
    regressedStateFirstRoom.players[pid].march = 47;
    regressedStateFirstRoom.players[pid].marchRevision -= 1;
    gateA.holdState = true;
    await injectPacket(commanderA, JSON.stringify({ t: 'state', room: regressedStateFirstRoom }));
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '0:48', 'same-row click cannot overwrite a pending draft');
    await commanderA.locator('#commanderMarchStatus').filter({ hasText: /Waiting/i }).waitFor();
    gateA.holdAck = false;
    await injectHeld(commanderA, gateA, 'ack');
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true, 'late ACK cannot settle against a regressed canonical snapshot');
    gateA.holdState = false;
    await injectPacket(commanderA, JSON.stringify({ t: 'state', room: exactStateFirstRoom }));
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });

    // ACK first: the exact ACK alone cannot close until the canonical snapshot arrives.
    gateA.acks.length = 0; gateA.states.length = 0; gateA.holdAck = true; gateA.holdState = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:49');
    await commanderA.locator('#commanderMarchSave').click();
    await waitForValue(() => gateA.acks.length && gateA.states.length, 'held ACK-first packets');
    gateA.holdAck = false;
    await injectHeld(commanderA, gateA, 'ack');
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true);
    assert.equal(await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).textContent(), '0:48');
    gateA.holdState = false;
    await injectHeld(commanderA, gateA, 'state');
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });

    // A tuple-mismatched ACK is consumed but never counts as confirmation.
    gateA.acks.length = 0; gateA.states.length = 0; gateA.holdAck = true; gateA.holdState = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:50');
    await commanderA.locator('#commanderMarchSave').click();
    await waitForValue(() => gateA.acks.length && gateA.states.length, 'held mismatch packets');
    const mismatchMutation = gateA.clientMutations.at(-1);
    await injectPacket(commanderA, JSON.stringify({
      t: 'playerMarchSaved', mutationId: mismatchMutation.mutationId, pid,
      march: mismatchMutation.march + 1, revision: mismatchMutation.baseRevision + 1
    }));
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true);
    gateA.holdState = false;
    await injectHeld(commanderA, gateA, 'state');
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true);
    gateA.holdAck = false;
    await injectHeld(commanderA, gateA, 'ack');
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });

    // A newer commander write supersedes a pending write before its late ACK.
    gateA.acks.length = 0; gateA.holdAck = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:51');
    await commanderA.locator('#commanderMarchSave').click();
    await waitForValue(() => gateA.acks.length, 'held superseded ACK');
    await commanderB.locator(`#roster .roster-time[data-pid="${pid}"]`).filter({ hasText: '0:51' }).waitFor();
    await commanderB.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderB.locator('#commanderMarchInput').fill('0:52');
    await commanderB.locator('#commanderMarchSave').click();
    await commanderB.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    await commanderA.locator('#commanderMarchStatus').filter({ hasText: /Another commander/i }).waitFor();
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '0:51');
    assert.match(await commanderA.locator('#commanderMarchLatest').textContent(), /0:52/);
    const supersededMutation = gateA.clientMutations.at(-1);
    gateA.holdAck = false;
    await injectHeld(commanderA, gateA, 'ack');
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true, 'late superseded ACK cannot close');
    await commanderA.locator('#commanderMarchRetry').click();
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    const retryMutation = gateA.clientMutations.at(-1);
    assert.notEqual(retryMutation.mutationId, supersededMutation.mutationId);
    assert.equal(retryMutation.baseRevision, 7, 'Retry uses the newest canonical revision');

    // Same-value stale writer receives conflict, not a false success; Adopt sends nothing.
    await commanderB.locator(`#roster .roster-time[data-pid="${pid}"]`).filter({ hasText: '0:51' }).waitFor();
    await commanderB.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderB.locator('#commanderMarchInput').fill('0:53');
    gateB.states.length = 0; gateB.holdState = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:53');
    await commanderA.locator('#commanderMarchSave').click();
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    await waitForValue(() => gateB.states.length, 'state hidden from same-value loser');
    await commanderB.locator('#commanderMarchSave').click();
    await commanderB.locator('#commanderMarchStatus').filter({ hasText: /保留了你的草稿/ }).waitFor();
    assert.equal(await commanderB.locator('#commanderMarchInput').inputValue(), '0:53');
    const beforeAdopt = gateB.clientMutations.length;
    await commanderB.locator('#commanderMarchAdopt').click();
    await commanderB.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    assert.equal(gateB.clientMutations.length, beforeAdopt, 'same-value Adopt sends nothing');
    gateB.holdState = false;
    await injectHeld(commanderB, gateB, 'state', true);

    // Invalid values never send, and a dirty editor cannot be replaced by another row.
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    const beforeInvalid = gateA.clientMutations.length;
    for (const invalid of ['0:04', '0:99', '1:60', '2:60', '3:01']) {
      await commanderA.locator('#commanderMarchInput').fill(invalid);
      await commanderA.locator('#commanderMarchSave').click();
      await commanderA.locator('#commanderMarchStatus').filter({ hasText: /5–120/ }).waitFor();
      assert.equal(await commanderA.locator('#commanderMarchInput').getAttribute('aria-invalid'), 'true');
    }
    assert.equal(gateA.clientMutations.length, beforeInvalid);
    await commanderA.locator('#commanderMarchInput').fill('0:54');
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '0:54', 'same-row click preserves a dirty draft');
    await commanderA.locator(`#roster .roster-time[data-pid="${secondPid}"]`).click();
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '0:54');
    assert.match(await commanderA.locator('#commanderMarchTitle').textContent(), /March Captain/);

    // A synchronous false send creates no pending request and keeps the draft editable.
    const beforeFalseSend = gateA.clientMutations.length;
    await commanderA.evaluate(() => { window.__qaFailNextCommanderMarch = true; });
    await commanderA.locator('#commanderMarchSave').click();
    await commanderA.locator('#commanderMarchStatus').filter({ hasText: /Not saved/i }).waitFor();
    assert.equal(gateA.clientMutations.length, beforeFalseSend);
    assert.equal(await commanderA.locator('#commanderMarchEditor').getAttribute('aria-busy'), 'false');
    assert.equal(await commanderA.locator('#commanderMarchInput').isEnabled(), true);
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '0:54');
    await commanderA.locator('#commanderMarchCancel').click();

    // Focus falls back to the visible search when the original row is filtered out.
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderA.locator('#rosterSearch').fill('Second Captain');
    await commanderA.locator('#commanderMarchCancel').click();
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    await commanderA.waitForFunction(() => document.activeElement && document.activeElement.id === 'rosterSearch');
    await commanderA.locator('#rosterSearch').fill('');

    // Close before ACK: preserve the draft, clear transport pending, and never auto-resend.
    gateA.acks.length = 0; gateA.states.length = 0; gateA.holdAck = true; gateA.holdState = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:54');
    await commanderA.locator('#commanderMarchSave').click();
    await waitForValue(() => gateA.acks.length && gateA.states.length, 'held close-before-ACK packets');
    const sentBeforeClose = gateA.clientMutations.length;
    const socketsBeforeClose = await commanderA.evaluate(() => {
      const socket = window.__qaRoomSockets.filter(candidate => candidate.readyState === WebSocket.OPEN).at(-1);
      const count = window.__qaRoomSockets.length; socket.close(); return count;
    });
    await commanderA.locator('#commanderMarchStatus').filter({ hasText: /Not saved/i }).waitFor();
    await commanderA.waitForFunction(count => window.__qaRoomSockets.length > count && window.__qaRoomSockets.at(-1).readyState === WebSocket.OPEN, socketsBeforeClose);
    assert.equal(gateA.clientMutations.length, sentBeforeClose, 'reconnect does not resend an uncertain mutation');
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '0:54');
    gateA.holdAck = false; gateA.holdState = false;
    await injectHeld(commanderA, gateA, 'state', true);
    await commanderA.locator('#commanderMarchStatus').filter({ hasText: /Another commander/i }).waitFor();
    await commanderA.locator('#commanderMarchAdopt').click();
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });

    // ACK then reconnect: remain pending until the exact first fresh snapshot is released.
    gateA.acks.length = 0; gateA.states.length = 0; gateA.holdAck = true; gateA.holdState = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:55');
    await commanderA.locator('#commanderMarchSave').click();
    await waitForValue(() => gateA.acks.length && gateA.states.length, 'held ACK-then-reconnect packets');
    gateA.holdAck = false;
    await injectHeld(commanderA, gateA, 'ack');
    const ackReconnectMutationCount = gateA.clientMutations.length;
    const socketsBeforeAckReconnect = await commanderA.evaluate(() => {
      const socket = window.__qaRoomSockets.filter(candidate => candidate.readyState === WebSocket.OPEN).at(-1);
      const count = window.__qaRoomSockets.length; socket.close(); return count;
    });
    await commanderA.waitForFunction(count => window.__qaRoomSockets.length > count && window.__qaRoomSockets.at(-1).readyState === WebSocket.OPEN, socketsBeforeAckReconnect);
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true);
    assert.equal(await commanderA.locator('#commanderMarchEditor').getAttribute('aria-busy'), 'true');
    assert.equal(gateA.clientMutations.length, ackReconnectMutationCount);
    await waitForValue(() => gateA.states.length >= 2, 'fresh reconnect snapshot');
    gateA.holdState = false;
    await injectHeld(commanderA, gateA, 'state', true);
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });

    // ACK seen + reconnect + present but non-exact canonical becomes retryable instead of staying pending forever.
    const mismatchBaseRoom = await readRoom(bootstrap);
    gateA.acks.length = 0; gateA.states.length = 0; gateA.holdAck = true; gateA.holdState = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${reconnectMismatchPid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:46');
    await commanderA.locator('#commanderMarchSave').click();
    await waitForValue(() => gateA.acks.length && gateA.states.length, 'held reconnect-mismatch packets');
    gateA.holdAck = false;
    await injectHeld(commanderA, gateA, 'ack');
    const socketsBeforeMismatchReconnect = await commanderA.evaluate(() => {
      const socket = window.__qaRoomSockets.filter(candidate => candidate.readyState === WebSocket.OPEN).at(-1);
      const count = window.__qaRoomSockets.length; socket.close(); return count;
    });
    await commanderA.waitForFunction(count => window.__qaRoomSockets.length > count && window.__qaRoomSockets.at(-1).readyState === WebSocket.OPEN, socketsBeforeMismatchReconnect);
    await waitForValue(() => gateA.states.length >= 2, 'fresh reconnect-mismatch snapshot');
    await injectPacket(commanderA, JSON.stringify({ t: 'state', room: mismatchBaseRoom }));
    await commanderA.locator('#commanderMarchStatus').filter({ hasText: /Another commander/i }).waitFor();
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '0:46');
    assert.equal(await commanderA.locator('#commanderMarchEditor').getAttribute('aria-busy'), 'false');
    const beforeMismatchAdopt = gateA.clientMutations.length;
    await commanderA.locator('#commanderMarchAdopt').click();
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    assert.equal(gateA.clientMutations.length, beforeMismatchAdopt);
    gateA.holdState = false;
    await injectHeld(commanderA, gateA, 'state', true);
    await commanderA.locator(`#roster .roster-time[data-pid="${reconnectMismatchPid}"]`).filter({ hasText: '0:46' }).waitFor();

    // ACK seen + disconnect + missing first fresh snapshot must not leave a hidden permanent pending editor.
    gateA.acks.length = 0; gateA.states.length = 0; gateA.holdAck = true; gateA.holdState = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${reconnectMissingPid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:46');
    await commanderA.locator('#commanderMarchSave').click();
    await waitForValue(() => gateA.acks.length && gateA.states.length, 'held ACK-seen packets');
    gateA.holdAck = false;
    await injectHeld(commanderA, gateA, 'ack');
    await sendMessages(bootstrap, [{ t: 'removePlayer', password, pid: reconnectMissingPid }]);
    await waitForValue(() => gateA.states.length >= 2, 'held ACK-seen removal state');
    const socketsBeforeMissingReconnect = await commanderA.evaluate(() => {
      const socket = window.__qaRoomSockets.filter(candidate => candidate.readyState === WebSocket.OPEN).at(-1);
      const count = window.__qaRoomSockets.length; socket.close(); return count;
    });
    await commanderA.waitForFunction(count => window.__qaRoomSockets.length > count && window.__qaRoomSockets.at(-1).readyState === WebSocket.OPEN, socketsBeforeMissingReconnect);
    await waitForValue(() => gateA.states.length >= 3, 'fresh ACK-seen missing snapshot');
    gateA.holdState = false;
    await injectHeld(commanderA, gateA, 'state', true);
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true, 'missing reconnect clears the pending lock');
    await commanderA.locator('#commanderMarchCancel').click();

    // Missing player: keep stale state across refresh, then close on the first fresh snapshot.
    gateA.states.length = 0; gateA.holdState = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${secondPid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:46');
    await sendMessages(bootstrap, [{ t: 'removePlayer', password, pid: secondPid }]);
    await waitForValue(() => gateA.states.length, 'held removal state');
    await commanderA.locator('#commanderMarchSave').click();
    await commanderA.locator('#commanderMarchStatus').filter({ hasText: /gone|refreshing/i }).waitFor();
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '0:46');
    await commanderA.keyboard.press('Escape');
    assert.equal(await commanderA.locator('#commanderMarchEditor').isVisible(), true, 'stale refresh blocks Escape and preserves the draft');
    await waitForValue(() => gateA.states.length >= 2, 'fresh missing-player snapshot');
    gateA.holdState = false;
    await injectHeld(commanderA, gateA, 'state', true);
    await commanderA.locator('#commanderMarchEditor').waitFor({ state: 'hidden' });
    await commanderA.locator(`#roster .roster-row[data-pid="${secondPid}"]`).waitFor({ state: 'detached' });

    const storedPlayer = await player.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), `kingshoter_r_${room}_me`);
    assert.equal(storedPlayer.pid, pid);
    assert.equal(storedPlayer.march, 55, 'player local storage reconciles to the commander update');

    // A matching password failure locks the console and purges credentials without deleting the draft.
    gateA.acks.length = 0; gateA.states.length = 0; gateA.holdAck = true; gateA.holdState = true;
    await commanderA.locator(`#roster .roster-time[data-pid="${pid}"]`).click();
    await commanderA.locator('#commanderMarchInput').fill('0:56');
    await commanderA.locator('#commanderMarchSave').click();
    await waitForValue(() => gateA.acks.length && gateA.states.length, 'held bad-password packets');
    const badPasswordMutation = gateA.clientMutations.at(-1);
    await injectPacket(commanderA, JSON.stringify({ t: 'error', error: 'bad_password', mutationId: badPasswordMutation.mutationId }));
    await commanderA.locator('#console').waitFor({ state: 'hidden' });
    assert.equal(await commanderA.evaluate(key => localStorage.getItem(key), `kingshoter_r_${room}_pw`), null);
    assert.equal(await commanderA.locator('#commanderMarchInput').inputValue(), '0:56');
    assert.equal(await commanderA.locator('#commanderMarchEditor').evaluate(element => element.classList.contains('hide')), false, 'draft remains in memory while the locked console is hidden');
    assert.deepEqual(pageErrors, []);
    console.log(`✓ commander march synchronization (${room})`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
