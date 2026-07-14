const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-kvk.cjs');

const base = process.env.BASE || 'http://127.0.0.1:8791';
const room = makeQaRoom('player-reconnect');
const url = qaRoomUrl(base, room, { notour: 1 });
const pid = '900000051';
const meKey = `kingshoter_r_${room}_me`;

async function connectRoom(roomName) {
  const safeRoom = assertQaRoomName(roomName);
  const endpoint = new URL('/api/ws', base);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('room', safeRoom);
  const ws = new WebSocket(endpoint);
  const messages = [];
  const waiters = [];

  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (messages.length <= waiter.start || !waiter.predicate(message)) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket open timed out for ${safeRoom}`)), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket failed for ${safeRoom}`)); }, { once: true });
  });

  return {
    mark() { return messages.length; },
    send(message) { ws.send(JSON.stringify(message)); },
    waitFor(predicate, start = 0, timeout = 5000) {
      const existing = messages.slice(start).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, start, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for room message after ${timeout}ms`));
        }, timeout);
        waiters.push(waiter);
      });
    },
    close() { try { ws.close(); } catch (error) {} }
  };
}

async function seedCanonicalPlayer() {
  const socket = await connectRoom(room);
  await socket.waitFor(message => message.t === 'state');
  let start = socket.mark();
  socket.send({ t: 'registerPlayer', pid, name: 'Server Canonical', march: 40, identityMode: 'playerId', alliance: '' });
  await socket.waitFor(message => message.t === 'state' && message.room.players[pid] && message.room.players[pid].marchRevision === 0, start);

  for (const update of [
    { march: 41, baseRevision: 0, revision: 1 },
    { march: 42, baseRevision: 1, revision: 2 },
    { march: 40, baseRevision: 2, revision: 3 }
  ]) {
    const mutationId = `seed-${update.revision}`;
    start = socket.mark();
    socket.send({ t: 'updateOwnMarch', mutationId, pid, march: update.march, baseRevision: update.baseRevision });
    await Promise.all([
      socket.waitFor(message => message.t === 'playerMarchSaved' && message.mutationId === mutationId, start),
      socket.waitFor(message => message.t === 'state' && message.room.players[pid] && message.room.players[pid].march === update.march && message.room.players[pid].marchRevision === update.revision, start)
    ]);
  }
  return socket;
}

async function readSnapshot() {
  const socket = await connectRoom(room);
  const state = await socket.waitFor(message => message.t === 'state');
  socket.close();
  return state;
}

(async () => {
  const seeder = await seedCanonicalPlayer();
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: 'en-US' });
  let dropInitialState = true, dropNextSavedState = false, observedRegistrations = 0, observedInvalidMarchErrors = 0;
  await installQaWebSocketGuard(context, room, {
    shouldDropClientMessage({ data }) {
      const message = JSON.parse(String(data));
      if (message.t === 'registerPlayer') observedRegistrations += 1;
      return false;
    },
    shouldDropServerMessage({ data }) {
      const message = JSON.parse(String(data));
      if (message.t === 'error' && message.error === 'invalid_march') observedInvalidMarchErrors += 1;
      if (dropInitialState && message.t === 'state') { dropInitialState = false; return true; }
      if (!dropNextSavedState) return false;
      const player = message.t === 'state' && message.room.players[pid];
      if (!player || player.march !== 55 || player.marchRevision !== 5) return false;
      dropNextSavedState = false;
      return true;
    }
  });
  const page = await context.newPage();
  const errors = [];
  let navigations = 0;
  page.on('pageerror', error => errors.push(error.message));

  try {
    await page.addInitScript(({ key, playerId }) => {
      if (sessionStorage.getItem('reconnect-stale-seeded')) return;
      localStorage.setItem(key, JSON.stringify({
        pid: playerId,
        name: 'Stale Local',
        march: 90,
        marchRevision: 0,
        identityMode: 'playerId'
      }));
      sessionStorage.setItem('reconnect-stale-seeded', '1');
    }, { key: meKey, playerId: pid });
    await page.goto(url);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations += 1; });
    const firstStateDeadline = Date.now() + 5000;
    while (dropInitialState && Date.now() < firstStateDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(dropInitialState, false, 'the authoritative first state was deliberately held for the pre-state UI assertion');
    assert.equal(await page.locator('#fillCard').isVisible(), true, 'a stored profile waits visibly for the authoritative first state');
    assert.equal(await page.locator('#youChip').isVisible(), false, 'a stale stored profile is not collapsed before the first state');
    seeder.send({
      t: 'setConfig',
      password: 'task-five-removal',
      config: { castleName: '', rallyAllies: [], enemyWhales: [] },
      by: 'first-authoritative-state'
    });
    await page.waitForFunction(playerId => !!document.querySelector(`#roster .rp[data-pid="${playerId}"]`), pid, { timeout: 5000 });
    await page.locator('#youChip').waitFor({ state: 'visible', timeout: 5000 });

    const saved = JSON.parse(await page.evaluate(key => localStorage.getItem(key), meKey));
    const snapshot = await readSnapshot();
    assert.equal(saved.march, 40);
    assert.equal(saved.marchRevision, 3);
    assert.equal(snapshot.room.players[pid].march, 40);
    assert.equal(snapshot.room.players[pid].marchRevision, 3);

    await page.locator('#soundGate').click().catch(() => {});
    await page.locator('#editBtn').click();
    await page.locator('#marchRange').fill('55');
    const remover = await connectRoom(room);
    let initial = await remover.waitFor(message => message.t === 'state');
    let start = remover.mark();
    remover.send({ t: 'updateOwnMarch', mutationId: 'remote-draft', pid, march: 45, baseRevision: 3 });
    initial = await remover.waitFor(message => message.t === 'state' && message.room.players[pid].march === 45 && message.room.players[pid].marchRevision === 4, start);
    await page.waitForFunction(({ key }) => {
      const profile = JSON.parse(localStorage.getItem(key) || 'null');
      return profile && profile.march === 45 && profile.marchRevision === 4;
    }, { key: meKey });
    assert.equal(await page.locator('#fillCard').isVisible(), true, 'canonical broadcasts do not collapse a dirty edit');
    assert.equal(await page.locator('#marchRange').inputValue(), '55', 'canonical broadcasts do not overwrite draft fields');

    const password = 'task-five-removal';
    let updatedBy = `edit-${Date.now()}`;
    start = remover.mark();
    remover.send({
      t: 'setConfig',
      password,
      config: initial.room.config,
      baseUpdatedAt: initial.room.updatedAt,
      by: updatedBy
    });
    initial = await remover.waitFor(message => message.t === 'state' && message.room.updatedBy === updatedBy, start);

    dropNextSavedState = true;
    start = remover.mark();
    await page.locator('#saveBtn').click();
    initial = await remover.waitFor(message => message.t === 'state' && message.room.players[pid].march === 55 && message.room.players[pid].marchRevision === 5, start);
    await page.locator('#marchRange').fill('56');
    updatedBy = `draft-${Date.now()}`;
    start = remover.mark();
    remover.send({
      t: 'setConfig',
      password,
      config: initial.room.config,
      baseUpdatedAt: initial.room.updatedAt,
      by: updatedBy
    });
    await remover.waitFor(message => message.t === 'state' && message.room.updatedBy === updatedBy, start);
    await page.waitForFunction(({ key }) => {
      const profile = JSON.parse(localStorage.getItem(key) || 'null');
      return profile && profile.march === 55 && profile.marchRevision === 5;
    }, { key: meKey });
    assert.equal(await page.locator('#fillCard').isVisible(), true, 'matching ACK and state do not collapse a newer draft');
    assert.equal(await page.locator('#marchRange').inputValue(), '56', 'matching ACK and state preserve a newer draft value');

    await page.locator('#saveBtn').click();
    await page.locator('#youChip').waitFor({ state: 'visible', timeout: 5000 });
    const settled = JSON.parse(await page.evaluate(key => localStorage.getItem(key), meKey));
    assert.equal(settled.march, 56, 'matching ACK and state settle the submitted march');
    assert.equal(settled.marchRevision, 6, 'matching ACK and state persist the canonical revision');
    assert.equal(await page.locator('#fillCard').isVisible(), false, 'an unchanged submitted draft collapses only after both facts');

    start = remover.mark();
    remover.send({ t: 'removePlayer', password, pid });
    await remover.waitFor(message => message.t === 'state' && !message.room.players[pid], start);
    await page.locator('#fillCard').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#youChip').waitFor({ state: 'hidden', timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 1200));

    assert.equal(await page.evaluate(key => localStorage.getItem(key), meKey), null);
    assert.equal(await page.locator(`#roster .rp[data-pid="${pid}"]`).count(), 0);
    assert.equal(navigations, 0, 'remote removal is reconciled inline without a reload');
    const afterRemoval = await readSnapshot();
    assert.equal(afterRemoval.room.players[pid], undefined, 'the removed player is not auto-registered again on this connection');
    assert.deepEqual(errors, []);
    remover.close();

    await page.evaluate(({ key, playerId }) => localStorage.setItem(key, JSON.stringify({
      pid: playerId,
      name: 'Invalid Legacy',
      march: 999,
      marchRevision: 0,
      identityMode: 'playerId'
    })), { key: meKey, playerId: pid });
    const registrationsBeforeReload = observedRegistrations;
    const errorsBeforeReload = observedInvalidMarchErrors;
    await page.reload();
    const deadline = Date.now() + 5000;
    while ((observedRegistrations === registrationsBeforeReload || observedInvalidMarchErrors === errorsBeforeReload) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(observedRegistrations > registrationsBeforeReload, 'the missing stored profile attempted create-only registration');
    assert.ok(observedInvalidMarchErrors > errorsBeforeReload, 'the invalid stored registration was rejected before retry');
    await page.locator('#toast.show').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#fillCard').isVisible(), true, 'stored registration errors keep the profile draft visible');
    assert.equal(await page.locator('#youChip').isVisible(), false, 'stored registration errors do not leave a stale chip visible');
    await page.locator('#soundGate').click().catch(() => {});
    await page.locator('#marchRange').fill('40');
    await page.locator('#saveBtn').click();
    await page.locator('#youChip').waitFor({ state: 'visible', timeout: 5000 });
    const retried = await readSnapshot();
    assert.equal(retried.room.players[pid].march, 40, 'a corrected stored registration retries create-only registration');
    assert.equal(retried.room.players[pid].marchRevision, 0);
    seeder.close();
    console.log(`✓ server-first reconnect and inline own-device removal (${room})`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
