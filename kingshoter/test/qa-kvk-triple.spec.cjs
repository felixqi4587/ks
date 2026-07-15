const { test, expect } = require('playwright/test');
const crypto = require('node:crypto');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-kvk.cjs');

const PROFILE_KEY = room => `kingshoter_r_${room}_me`;
const DEVICE_KEY = room => `kvk:${room}:delivery-device:v1`;
const seededProfiles = new Set();
const profile = (pid, name, march) => ({
  pid, playerId: pid, name, march, marchRevision: 0, identityMode: 'playerId',
  profileKey: crypto.randomUUID(), editable: true
});
const password = () => `qa-${crypto.randomBytes(12).toString('hex')}`;
const deviceId = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

function parseFrame(data) {
  try { return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); }
  catch (error) { return null; }
}

function deliveryOnlyProfile(source) {
  const copy = { ...source, editable: false };
  delete copy.profileKey;
  return copy;
}

async function ensureCanonicalProfile(baseURL, room, source) {
  const cacheKey = `${new URL(baseURL).origin}:${room}:${source.pid}`;
  if (seededProfiles.has(cacheKey)) return;
  if (!source.profileKey) throw new Error(`owner profile must seed ${source.pid} before delivery-only devices`);
  const endpoint = new URL('/api/ws', baseURL);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('room', assertQaRoomName(room));
  const registrationId = crypto.randomUUID();
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    let canonicalSeen = false;
    let ackSeen = false;
    let sent = false;
    const timer = setTimeout(() => reject(new Error(`profile seed timed out for ${source.pid}`)), 10_000);
    const finish = () => {
      if (!canonicalSeen || !ackSeen) return;
      clearTimeout(timer); seededProfiles.add(cacheKey);
      try { socket.close(); } catch (error) {}
      resolve();
    };
    socket.addEventListener('message', event => {
      const message = parseFrame(event.data);
      if (!message) return;
      if (message.t === 'state') {
        const canonical = message.room && message.room.players && message.room.players[source.pid];
        canonicalSeen = !!(canonical && canonical.name === source.name && canonical.march === source.march);
        if (!sent) {
          sent = true;
          socket.send(JSON.stringify({
            t: 'registerPlayer', registrationId, pid: source.pid, playerId: source.playerId,
            name: source.name, march: source.march, identityMode: source.identityMode,
            profileKey: source.profileKey
          }));
        }
        finish();
      } else if (message.t === 'playerRegistered' && message.registrationId === registrationId) {
        if (message.pid !== source.pid || message.editable !== true) {
          clearTimeout(timer); reject(new Error(`profile seed ownership mismatch for ${source.pid}`));
          return;
        }
        ackSeen = true; finish();
      } else if (message.t === 'error' && message.registrationId === registrationId) {
        clearTimeout(timer); reject(new Error(`profile seed failed for ${source.pid}: ${message.error}`));
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer); reject(new Error(`profile seed socket failed for ${source.pid}`));
    }, { once: true });
  });
}

function createGate(options = {}) {
  const gate = { events: [], socketUrls: [] };
  const record = (direction, url, data) => {
    if (!gate.socketUrls.includes(url)) gate.socketUrls.push(url);
    const event = { direction, url, message: parseFrame(data) };
    gate.events.push(event);
    return event;
  };
  gate.guard = {
    shouldDropClientMessage({ url, data }) {
      const event = record('client', url, data);
      return options.dropDeliveryAck === true && event.message && event.message.t === 'deliveryAck';
    },
    shouldDropServerMessage({ url, data }) {
      record('server', url, data);
      return false;
    }
  };
  return gate;
}

async function installHttpGuard(context, baseURL, blockedScripts) {
  const origin = new URL(baseURL).origin;
  const blocked = new Set(blockedScripts || []);
  await context.route('**/*', route => {
    let url;
    try { url = new URL(route.request().url()); } catch (error) { return route.abort(); }
    const filename = url.pathname.split('/').pop();
    if (blocked.has(filename)) return route.abort('blockedbyclient');
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) return route.abort('blockedbyclient');
    return route.continue();
  });
}

async function openActor(browser, baseURL, room, options) {
  assertQaRoomName(room);
  await ensureCanonicalProfile(baseURL, room, options.profile);
  const gate = options.gate || createGate();
  const context = await browser.newContext({
    viewport: options.viewport || { width: 390, height: 1050 },
    locale: 'en-US'
  });
  try {
    await installHttpGuard(context, baseURL, options.blockScripts || []);
    await installQaWebSocketGuard(context, room, {
      ...gate.guard,
      expectedOrigin: baseURL
    });
    await context.addInitScript(({ roomName, storedProfile, storedDeviceId }) => {
      localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify(storedProfile));
      localStorage.setItem(`kvk:${roomName}:delivery-device:v1`, storedDeviceId);
    }, { roomName: room, storedProfile: options.profile, storedDeviceId: options.deviceId });
    const page = await context.newPage();
    page.on('pageerror', error => options.errors.push(`${options.key}: ${error.message}`));
    await page.goto(qaRoomUrl(baseURL, room, { notour: '1', lang: 'en' }), { waitUntil: 'domcontentloaded' });
    await page.locator('#soundGate').click();
    await page.waitForFunction(() => window.__ac && window.__ac.state === 'running');
    await page.locator('#youChip').waitFor({ state: 'visible' });
    await page.locator('#youName').filter({ hasText: options.profile.name }).waitFor();
    await expect.poll(() => gate.events.some(event => event.direction === 'server' && event.message &&
      event.message.t === 'deviceStatusSaved' && event.message.pid === options.profile.pid &&
      event.message.deviceId === options.deviceId && event.message.soundReady === true), {
      timeout: 15_000
    }).toBe(true);
    return { ...options, context, page, gate, closed: false };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function closeActor(actor) {
  if (!actor || actor.closed) return;
  actor.closed = true;
  await actor.context.close();
}

async function closeActors(actors) {
  for (const actor of [...actors].reverse()) await closeActor(actor).catch(() => {});
}

async function roomState(request, baseURL, room) {
  assertQaRoomName(room);
  const url = new URL('/api/ws', baseURL);
  url.searchParams.set('room', room);
  const response = await request.get(url.toString());
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.t).toBe('state');
  return body.room;
}

async function waitForPlayerCount(request, baseURL, room, count) {
  await expect.poll(async () => Object.keys((await roomState(request, baseURL, room)).players || {}).length, {
    timeout: 15_000
  }).toBe(count);
}

async function unlock(page, value) {
  await page.locator('#cmdUnlock').click();
  await page.locator('#pwInput').fill(value);
  await page.locator('#pwGo').click();
  await page.locator('#console').waitFor({ state: 'visible' });
}

async function setTriple(commander, observer, request, baseURL, room, enabled) {
  const input = commander.locator('#tripleMode');
  await expect(input).toBeChecked({ checked: !enabled });
  await input.click();
  await expect.poll(async () => (await roomState(request, baseURL, room)).rallyModes['1'].mode).toBe(enabled ? 'triple' : 'double');
  await expect(observer.locator('#tripleMode')).toBeChecked({ checked: enabled });
}

async function selectCaptain(commander, observer, pid) {
  await commander.locator(`#roster .rp[data-pid="${pid}"]`).click();
  await expect(observer.locator(`#pickSlots .slot[data-pid="${pid}"]`)).toBeVisible();
}

async function cueBases(page, commandId) {
  return page.evaluate(id => [...new Set(Object.values(window.__cues || {})
    .filter(cue => cue && typeof cue.base === 'string' && cue.base.startsWith(id))
    .map(cue => cue.base))].sort(), commandId);
}

async function expectCueBases(page, commandId, expected) {
  await expect.poll(() => cueBases(page, commandId), { timeout: 12_000 }).toEqual(expected);
}

async function expectNoHorizontalOverflow(page, width, selectors) {
  await page.setViewportSize({ width, height: 1050 });
  const result = await page.evaluate(targets => {
    const clientWidth = document.documentElement.clientWidth;
    const offenders = [];
    for (const selector of targets) {
      const element = document.querySelector(selector);
      if (!element || element.getClientRects().length === 0) continue;
      const rect = element.getBoundingClientRect();
      if (rect.left < -1 || rect.right > clientWidth + 1 || element.scrollWidth > element.clientWidth + 1) {
        offenders.push({ selector, left: rect.left, right: rect.right, clientWidth, scrollWidth: element.scrollWidth, elementWidth: element.clientWidth });
      }
    }
    return { rootFits: document.documentElement.scrollWidth <= clientWidth + 1, offenders };
  }, selectors);
  expect(result, `horizontal overflow at ${width}px`).toEqual({ rootFits: true, offenders: [] });
}

function latestProjectedState(gate, commandId) {
  return [...gate.events].reverse().find(event => {
    if (event.direction !== 'server' || !event.message || event.message.t !== 'state') return false;
    const commands = event.message.room && event.message.room.live && event.message.room.live.commands;
    return Object.values(commands || {}).some(command => command && command.id === commandId);
  });
}

function combatFields(command) {
  return {
    id: command.id,
    type: command.type,
    kingdom: command.kingdom,
    anchorUTC: command.anchorUTC,
    firstPress: command.payload.firstPress,
    leadSeconds: command.payload.leadSeconds,
    pairs: command.payload.pairs.map(pair => ({
      pid: pair.pid, role: pair.role, march: pair.march, pressUTC: pair.pressUTC
    }))
  };
}

async function fire(page, leadSeconds) {
  await page.locator(`#lead button[data-v="${leadSeconds}"]`).click();
  await expect(page.locator('#fireDouble')).toBeEnabled();
  await page.locator('#fireDouble').click();
  await expect(page.locator('#fireDouble')).toHaveClass(/armed/);
  await page.locator('#fireDouble').click();
}

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/build');
  expect(response.ok()).toBe(true);
  const metadata = await response.json();
  expect(metadata.tripleQaEnabled).toBe(true);
  const expectedGlobal = process.env.EXPECT_TRIPLE_GLOBAL ?? (process.env.QA_BASE_URL ? '' : '0');
  if (expectedGlobal !== '') expect(metadata.tripleEnabled).toBe(expectedGlobal === '1');
});

test('Triple lifecycle synchronizes roles, timing, delivery truth, audience, and narrow layouts', async ({ browser, baseURL, request }, testInfo) => {
  test.slow();
  const room = makeQaRoom(testInfo);
  const secret = password();
  const errors = [];
  const actors = [];
  const p = {
    weak: profile('810000001', 'Weak One', 20),
    weak2: profile('810000002', 'Weak Two', 47),
    main: profile('810000003', 'Main', 31),
    fourth: profile('810000004', 'Fourth', 35),
    member: profile('810000005', 'Member', 40),
    observer: profile('810000006', 'Observer Commander', 45)
  };
  const add = async options => {
    const actor = await openActor(browser, baseURL, room, { ...options, errors });
    actors.push(actor);
    return actor;
  };

  try {
    const weak = await add({ key: 'weak', profile: p.weak, deviceId: deviceId(1) });
    const weak2Gate = createGate({ dropDeliveryAck: true });
    const weak2 = await add({ key: 'weak2', profile: p.weak2, deviceId: deviceId(2), gate: weak2Gate });
    const main = await add({ key: 'main', profile: p.main, deviceId: deviceId(3) });
    const fourth = await add({ key: 'fourth', profile: p.fourth, deviceId: deviceId(4) });
    const member = await add({ key: 'member', profile: p.member, deviceId: deviceId(5) });
    const commanderA = await add({ key: 'commander-a', profile: deliveryOnlyProfile(p.weak), deviceId: deviceId(6) });
    const commanderB = await add({ key: 'commander-b', profile: p.observer, deviceId: deviceId(7) });
    await waitForPlayerCount(request, baseURL, room, 6);
    await closeActor(fourth);

    await unlock(commanderA.page, secret);
    await unlock(commanderB.page, secret);
    await expect(commanderA.page.locator('#roster .rp')).toHaveCount(6);
    await setTriple(commanderA.page, commanderB.page, request, baseURL, room, true);
    let state = await roomState(request, baseURL, room);
    expect(state.rallyModes['2']).toEqual({ mode: 'double', revision: 0 });

    await selectCaptain(commanderA.page, commanderB.page, p.weak.pid);
    await selectCaptain(commanderA.page, commanderB.page, p.weak2.pid);
    await selectCaptain(commanderA.page, commanderB.page, p.main.pid);
    await expect(commanderB.page.locator('#pickCnt')).toHaveText('3/3');

    await commanderA.page.locator(`#roster .rp[data-pid="${p.fourth.pid}"]`).click();
    await expect(commanderA.page.locator('#replaceOvl')).toBeVisible();
    await expect(commanderA.page.locator('#replaceWeak2')).toBeVisible();
    await expectNoHorizontalOverflow(commanderA.page, 320, ['#console', '#roster', '#pickSlots', '#fireDock', '#replaceOvl .ob']);
    await commanderA.page.locator('#replaceWeak2').click();
    await expect(commanderB.page.locator(`#pickSlots .slot[data-pid="${p.fourth.pid}"]`)).toBeVisible();
    await expect(commanderB.page.locator(`#pickSlots .slot[data-pid="${p.weak2.pid}"]`)).toHaveCount(0);

    await commanderA.page.locator(`#roster .rp[data-pid="${p.weak2.pid}"]`).click();
    await expect(commanderA.page.locator('#replaceOvl')).toBeVisible();
    await commanderA.page.locator('#replaceWeak2').click();
    await expect(commanderB.page.locator(`#pickSlots .slot[data-pid="${p.weak2.pid}"]`)).toBeVisible();
    await expectNoHorizontalOverflow(commanderA.page, 375, ['#console', '#roster', '#pickSlots', '#fireDock']);
    await expectNoHorizontalOverflow(commanderA.page, 390, ['#console', '#roster', '#pickSlots', '#fireDock']);

    await commanderA.page.evaluate(() => { window.confirm = () => true; });
    await setTriple(commanderA.page, commanderB.page, request, baseURL, room, false);
    state = await roomState(request, baseURL, room);
    expect(state.live.staged['1'].pairs.map(pair => pair.role)).toEqual(['weak', 'main']);
    await expect(commanderB.page.locator(`#pickSlots .slot[data-pid="${p.weak2.pid}"]`)).toHaveCount(0);
    await setTriple(commanderA.page, commanderB.page, request, baseURL, room, true);
    await selectCaptain(commanderA.page, commanderB.page, p.weak2.pid);
    await expect(commanderA.page.locator('#fireDouble')).toBeEnabled();

    const beforeFrames = commanderA.gate.events.length;
    await fire(commanderA.page, 10);
    await expect.poll(async () => (await roomState(request, baseURL, room)).live.commands['1']?.type, { timeout: 12_000 }).toBe('triple_rally');
    state = await roomState(request, baseURL, room);
    const command = state.live.commands['1'];
    const byRole = Object.fromEntries(command.payload.pairs.map(pair => [pair.role, pair]));
    expect(byRole.weak.pressUTC + byRole.weak.march).toBe(byRole.weak2.pressUTC + byRole.weak2.march);
    expect(byRole.main.pressUTC + byRole.main.march).toBe(byRole.weak.pressUTC + byRole.weak.march + 1);
    expect(command.payload.firstPress).toBe(Math.min(...command.payload.pairs.map(pair => pair.pressUTC)));
    expect(command.payload.leadSeconds).toBe(10);

    const tripleFrames = commanderA.gate.events.slice(beforeFrames).filter(event => event.direction === 'client' &&
      event.message && event.message.t === 'cmd' && event.message.cmd && event.message.cmd.type === 'triple_rally');
    expect(tripleFrames).toHaveLength(1);
    expect(Object.keys(tripleFrames[0].message.cmd.payload).sort()).toEqual(['leadSeconds', 'pairs']);
    expect(tripleFrames[0].message.cmd.payload.pairs.map(pair => pair.role).sort()).toEqual(['main', 'weak', 'weak2']);
    expect(tripleFrames[0].message.cmd.payload.pairs.every(pair => Object.keys(pair).sort().join(',') === 'pid,role')).toBe(true);

    await expect.poll(async () => {
      const latest = (await roomState(request, baseURL, room)).live.commands['1'];
      return Object.fromEntries((latest.delivery || []).map(entry => [entry.pid, [entry.expected, entry.received]]));
    }, { timeout: 12_000 }).toEqual({
      [p.weak.pid]: [2, 2],
      [p.weak2.pid]: [1, 0],
      [p.main.pid]: [1, 1]
    });

    await expect(commanderA.page.locator(`#pickSlots .slot[data-pid="${p.weak.pid}"] .delivery.received`)).toContainText('Received');
    await expect(commanderA.page.locator(`#pickSlots .slot[data-pid="${p.main.pid}"] .delivery.received`)).toContainText('Received');
    await expect(commanderA.page.locator(`#pickSlots .slot[data-pid="${p.weak2.pid}"] .delivery.missing`), { timeout: 5_000 }).toContainText('No confirmation');

    await expectCueBases(weak.page, command.id, [`${command.id}-me`]);
    await expectCueBases(weak2.page, command.id, [`${command.id}-me`]);
    await expectCueBases(main.page, command.id, [`${command.id}-me`]);
    await expectCueBases(commanderA.page, command.id, [`${command.id}-me`]);
    await expectCueBases(member.page, command.id, [`${command.id}-join`]);
    await expectCueBases(commanderB.page, command.id, []);
    expect(errors).toEqual([]);
  } finally {
    await closeActors(actors);
  }
});

test('an active Triple command projects safely to a rally-module-missing target', async ({ browser, baseURL, request }, testInfo) => {
  test.slow();
  const room = makeQaRoom(testInfo);
  const secret = password();
  const errors = [];
  const actors = [];
  const p = {
    weak: profile('820000001', 'Cache Weak', 20),
    target: profile('820000002', 'Cache Target', 47),
    main: profile('820000003', 'Cache Main', 31),
    member: profile('820000004', 'Cache Member', 40),
    observer: profile('820000005', 'Cache Observer', 45)
  };
  const add = async options => {
    const actor = await openActor(browser, baseURL, room, { ...options, errors });
    actors.push(actor);
    return actor;
  };

  try {
    const weak = await add({ key: 'cache-weak', profile: p.weak, deviceId: deviceId(11) });
    const registrar = await add({ key: 'cache-target-register', profile: p.target, deviceId: deviceId(12) });
    const main = await add({ key: 'cache-main', profile: p.main, deviceId: deviceId(13) });
    const member = await add({ key: 'cache-member', profile: p.member, deviceId: deviceId(14) });
    const commanderA = await add({ key: 'cache-commander-a', profile: deliveryOnlyProfile(p.weak), deviceId: deviceId(15) });
    const commanderB = await add({ key: 'cache-commander-b', profile: p.observer, deviceId: deviceId(16) });
    await waitForPlayerCount(request, baseURL, room, 5);
    await closeActor(registrar);

    await unlock(commanderA.page, secret);
    await unlock(commanderB.page, secret);
    await setTriple(commanderA.page, commanderB.page, request, baseURL, room, true);
    await selectCaptain(commanderA.page, commanderB.page, p.weak.pid);
    await selectCaptain(commanderA.page, commanderB.page, p.target.pid);
    await selectCaptain(commanderA.page, commanderB.page, p.main.pid);
    await fire(commanderA.page, 60);
    await expect.poll(async () => (await roomState(request, baseURL, room)).live.commands['1']?.type).toBe('triple_rally');
    const before = (await roomState(request, baseURL, room)).live.commands['1'];
    const frozenCombat = combatFields(before);

    const fallbackGate = createGate();
    const fallback = await add({
      key: 'cache-fallback-target', profile: deliveryOnlyProfile(p.target), deviceId: deviceId(17), gate: fallbackGate,
      blockScripts: ['kvk-rally.js']
    });
    await expect.poll(() => !!latestProjectedState(fallbackGate, before.id), { timeout: 12_000 }).toBe(true);
    const projectedEvent = latestProjectedState(fallbackGate, before.id);
    const projectedRoom = projectedEvent.message.room;
    const projected = projectedRoom.live.commands['1'];
    expect(fallbackGate.socketUrls.length).toBeGreaterThan(0);
    expect(fallbackGate.socketUrls.every(url => new URL(url).searchParams.get('clientBuild') === '0')).toBe(true);
    expect(projectedRoom.capabilities.tripleRally).toBe(false);
    expect(projected.type).toBe('double_rally');
    expect(projected.payload.rallySize).toBe(3);
    expect(projected.payload.pairs.map(pair => pair.pid).sort()).toEqual([p.weak.pid, p.target.pid, p.main.pid].sort());
    expect(await fallback.page.evaluate(() => ({ rally: window.KvkRally, update: window.KvkUpdate && window.KvkUpdate.BUILD })))
      .toEqual({ rally: undefined, update: expect.any(Number) });

    await expectCueBases(fallback.page, before.id, [`${before.id}-me`]);
    await expectCueBases(member.page, before.id, [`${before.id}-join`]);
    await expectCueBases(commanderB.page, before.id, []);
    await expectCueBases(weak.page, before.id, [`${before.id}-me`]);
    await expectCueBases(main.page, before.id, [`${before.id}-me`]);

    const after = (await roomState(request, baseURL, room)).live.commands['1'];
    expect(combatFields(after)).toEqual(frozenCombat);
    expect(after.type).toBe('triple_rally');
    expect(errors).toEqual([]);
  } finally {
    await closeActors(actors);
  }
});

test('missing optional rally and updater scripts retain default Double Fire and personal cues', async ({ browser, baseURL, request }, testInfo) => {
  const room = makeQaRoom(testInfo);
  const secret = password();
  const errors = [];
  const actors = [];
  const p = {
    weak: profile('830000001', 'Fallback Weak', 20),
    main: profile('830000002', 'Fallback Main', 31)
  };
  const add = async options => {
    const actor = await openActor(browser, baseURL, room, { ...options, errors });
    actors.push(actor);
    return actor;
  };

  try {
    const blocked = ['kvk-rally.js', 'kvk-update.js'];
    const commander = await add({ key: 'fallback-commander', profile: p.weak, deviceId: deviceId(21), blockScripts: blocked });
    const main = await add({ key: 'fallback-main', profile: p.main, deviceId: deviceId(22), blockScripts: blocked });
    await waitForPlayerCount(request, baseURL, room, 2);
    await unlock(commander.page, secret);
    await expect(commander.page.locator('#rallyModeControl')).toBeHidden();
    await selectCaptain(commander.page, commander.page, p.weak.pid);
    await selectCaptain(commander.page, commander.page, p.main.pid);
    await fire(commander.page, 10);
    await expect.poll(async () => (await roomState(request, baseURL, room)).live.commands['1']?.type).toBe('double_rally');
    const command = (await roomState(request, baseURL, room)).live.commands['1'];
    const weakPair = command.payload.pairs.find(pair => pair.role === 'weak');
    const mainPair = command.payload.pairs.find(pair => pair.role === 'main');
    expect(mainPair.pressUTC + mainPair.march).toBe(weakPair.pressUTC + weakPair.march + 1);
    expect(command.payload.leadSeconds).toBe(10);
    await expect.poll(async () => {
      const latest = (await roomState(request, baseURL, room)).live.commands['1'];
      return Object.fromEntries((latest.delivery || []).map(entry => [entry.pid, [entry.expected, entry.received]]));
    }).toEqual({ [p.weak.pid]: [1, 1], [p.main.pid]: [1, 1] });
    await expectCueBases(commander.page, command.id, [`${command.id}-me`]);
    await expectCueBases(main.page, command.id, [`${command.id}-me`]);
    expect(errors).toEqual([]);
  } finally {
    await closeActors(actors);
  }
});
