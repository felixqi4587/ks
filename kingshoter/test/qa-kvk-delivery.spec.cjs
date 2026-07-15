const { test, expect } = require('playwright/test');
const crypto = require('node:crypto');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-kvk.cjs');

const LEAD_SECONDS = 15;
const PASSWORD = () => `qa-${crypto.randomBytes(12).toString('hex')}`;
const PROFILE_KEY = room => `kingshoter_r_${room}_me`;
const DEVICE_KEY = room => `kvk:${room}:delivery-device:v1`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const seededProfiles = new Set();

function parseFrame(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  } catch (error) {
    return null;
  }
}

function rawFrame(data) {
  return Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
}

function createFrameGate(initial = {}) {
  const gate = {
    sequence: 0,
    events: [],
    candidateRaw: [],
    droppedFirstCandidate: false,
    dropFirstCandidate: initial.dropFirstCandidate === true,
    blockCandidate: initial.blockCandidate === true,
    blockCommandState: initial.blockCommandState === true,
    blockedCommandStates: 0
  };

  function record(direction, data) {
    const event = {
      sequence: ++gate.sequence,
      at: Date.now(),
      direction,
      raw: rawFrame(data),
      message: parseFrame(data)
    };
    gate.events.push(event);
    return event;
  }

  gate.guardOptions = {
    shouldDropClientMessage({ data }) {
      record('client', data);
      return false;
    },
    shouldDropServerMessage({ data }) {
      const event = record('server', data);
      if (event.message && event.message.t === 'deliveryShadowCommand') {
        gate.candidateRaw.push(event.raw);
        if (gate.dropFirstCandidate && !gate.droppedFirstCandidate) {
          gate.droppedFirstCandidate = true;
          event.dropped = true;
          return true;
        }
        if (gate.blockCandidate) {
          event.dropped = true;
          return true;
        }
      }
      if (gate.blockCommandState && event.message && event.message.t === 'state') {
        const commands = event.message.room && event.message.room.live &&
          event.message.room.live.commands;
        if (Object.values(commands || {}).some(command => command && command.type === 'double_rally')) {
          gate.blockedCommandStates += 1;
          event.dropped = true;
          return true;
        }
      }
      return false;
    }
  };
  return gate;
}

function numericProfile(pid, name, march) {
  return {
    pid, playerId: pid, name, march, marchRevision: 0, identityMode: 'playerId',
    profileKey: crypto.randomUUID(), editable: true
  };
}

function deliveryOnlyProfile(profile) {
  const copy = { ...profile, editable: false };
  delete copy.profileKey;
  return copy;
}

async function ensureCanonicalProfile(baseURL, room, profile) {
  if (!profile) return;
  const cacheKey = `${new URL(baseURL).origin}:${room}:${profile.pid}`;
  if (seededProfiles.has(cacheKey)) return;
  if (!profile.profileKey) throw new Error(`owner profile must seed ${profile.pid} before delivery-only devices`);
  const endpoint = new URL('/api/ws', baseURL);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('room', assertQaRoomName(room));
  const registrationId = crypto.randomUUID();
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    let canonicalSeen = false;
    let ackSeen = false;
    let sent = false;
    const timer = setTimeout(() => reject(new Error(`profile seed timed out for ${profile.pid}`)), 10_000);
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
        const canonical = message.room && message.room.players && message.room.players[profile.pid];
        canonicalSeen = !!(canonical && canonical.name === profile.name && canonical.march === profile.march);
        if (!sent) {
          sent = true;
          socket.send(JSON.stringify({
            t: 'registerPlayer', registrationId, pid: profile.pid, playerId: profile.playerId,
            name: profile.name, march: profile.march, identityMode: profile.identityMode,
            profileKey: profile.profileKey
          }));
        }
        finish();
      } else if (message.t === 'playerRegistered' && message.registrationId === registrationId) {
        if (message.pid !== profile.pid || message.editable !== true) {
          clearTimeout(timer); reject(new Error(`profile seed ownership mismatch for ${profile.pid}`));
          return;
        }
        ackSeen = true; finish();
      } else if (message.t === 'error' && message.registrationId === registrationId) {
        clearTimeout(timer); reject(new Error(`profile seed failed for ${profile.pid}: ${message.error}`));
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer); reject(new Error(`profile seed socket failed for ${profile.pid}`));
    }, { once: true });
  });
}

async function installHttpOriginGuard(context, baseURL) {
  const allowedOrigin = new URL(baseURL).origin;
  await context.route('**/*', route => {
    let requested;
    try { requested = new URL(route.request().url()); } catch (error) { return route.abort(); }
    if (['http:', 'https:'].includes(requested.protocol) && requested.origin !== allowedOrigin) {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
}

async function openDevice(browser, baseURL, room, options) {
  assertQaRoomName(room);
  const {
    key,
    profile = null,
    deviceId,
    gate = createFrameGate(),
    errors,
    viewport = { width: 390, height: 1000 }
  } = options;
  await ensureCanonicalProfile(baseURL, room, profile);
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await installHttpOriginGuard(context, baseURL);
  await installQaWebSocketGuard(context, room, {
    ...gate.guardOptions,
    expectedOrigin: baseURL
  });
  await context.addInitScript(({ roomName, storedProfile, storedDeviceId }) => {
    if (storedProfile) {
      localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify(storedProfile));
    }
    localStorage.setItem(`kvk:${roomName}:delivery-device:v1`, storedDeviceId);
  }, { roomName: room, storedProfile: profile, storedDeviceId: deviceId });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${key}: ${error.message}`));
  await page.goto(qaRoomUrl(baseURL, room, {
    notour: '1',
    lang: 'en',
    deliveryQa: '1',
    deliveryShadow: '1'
  }), { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => !!window.__kvkDeliveryQa)).toBe(true);
  await page.locator('#soundGate').click();
  await page.waitForFunction(() => window.__ac && window.__ac.state === 'running');
  if (profile) {
    await page.locator('#youChip').waitFor({ state: 'visible' });
    await page.locator('#youName').filter({ hasText: profile.name }).waitFor();
  }
  return { key, context, page, profile, deviceId, gate };
}

async function openClassicDevice(browser, baseURL, room, options) {
  assertQaRoomName(room);
  const {
    key,
    profile,
    deviceId,
    gate = createFrameGate(),
    errors,
    viewport = { width: 390, height: 1000 }
  } = options;
  await ensureCanonicalProfile(baseURL, room, profile);
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await installHttpOriginGuard(context, baseURL);
  await installQaWebSocketGuard(context, room, {
    ...gate.guardOptions,
    expectedOrigin: baseURL
  });
  await context.addInitScript(({ roomName, storedProfile, storedDeviceId }) => {
    localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify(storedProfile));
    localStorage.setItem(`kvk:${roomName}:delivery-device:v1`, storedDeviceId);
  }, { roomName: room, storedProfile: profile, storedDeviceId: deviceId });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${key}: ${error.message}`));
  await page.goto(qaRoomUrl(baseURL, room, {
    notour: '1',
    lang: 'en'
  }), { waitUntil: 'domcontentloaded' });
  const url = new URL(page.url());
  expect(url.searchParams.has('deliveryQa')).toBe(false);
  expect(url.searchParams.has('deliveryShadow')).toBe(false);
  expect(await page.evaluate(() => window.__kvkDeliveryQa)).toBeUndefined();
  await page.locator('#soundGate').click();
  await page.waitForFunction(() => window.__ac && window.__ac.state === 'running');
  await page.locator('#youChip').waitFor({ state: 'visible' });
  await page.locator('#youName').filter({ hasText: profile.name }).waitFor();
  return { key, context, page, profile, deviceId, gate };
}

function automaticReadyTimeline(device, minimumSequence = 0) {
  const events = device.gate.events.filter(event => event.sequence > minimumSequence);
  const ack = events.find(event => event.direction === 'client' &&
    event.message && event.message.t === 'deliveryShadowProbeAck' &&
    event.message.audioArmed === true);
  if (!ack) return null;
  const probe = events.find(event => event.sequence < ack.sequence &&
    event.direction === 'server' && event.message &&
    event.message.t === 'deliveryShadowProbe' &&
    event.message.probeId === ack.message.probeId);
  if (!probe) return null;
  const hello = [...events].reverse().find(event => event.sequence < probe.sequence &&
    event.direction === 'client' && event.message &&
    event.message.t === 'deliveryShadowHello' &&
    event.message.pid === device.profile.pid &&
    event.message.deviceId === device.deviceId);
  if (!hello) return null;
  const saved = [...events].reverse().find(event => event.sequence < hello.sequence &&
    event.direction === 'server' && event.message &&
    event.message.t === 'deviceStatusSaved' &&
    event.message.pid === device.profile.pid &&
    event.message.deviceId === device.deviceId &&
    event.message.soundReady === true);
  return saved ? { saved, hello, probe, ack } : null;
}

async function waitForAutomaticReady(device, minimumSequence = 0) {
  let timeline = null;
  await expect.poll(() => {
    timeline = automaticReadyTimeline(device, minimumSequence);
    return !!timeline;
  }, { timeout: 20_000 }).toBe(true);
  expect([
    timeline.saved.sequence,
    timeline.hello.sequence,
    timeline.probe.sequence,
    timeline.ack.sequence
  ]).toEqual([
    timeline.saved.sequence,
    timeline.hello.sequence,
    timeline.probe.sequence,
    timeline.ack.sequence
  ].sort((a, b) => a - b));
  return timeline;
}

async function waitForFreshArmed(device, maximumAgeMs = 2_500) {
  const latest = () => [...device.gate.events].reverse().find(event =>
    event.direction === 'client' && event.message &&
    event.message.t === 'deliveryShadowProbeAck' &&
    event.message.audioArmed === true);
  const current = latest();
  if (current && Date.now() - current.at <= maximumAgeMs) return current;
  const previousSequence = current ? current.sequence : 0;
  await expect.poll(() => {
    const event = latest();
    return !!event && event.sequence > previousSequence && Date.now() - event.at <= maximumAgeMs;
  }, { timeout: 12_000 }).toBe(true);
  return latest();
}

async function registerNickname(device, name, march) {
  const { page } = device;
  await page.locator('#identityNickname').click();
  await page.locator('#pid').fill(name);
  await page.locator('#marchRange').fill(String(march));
  await page.locator('#saveBtn').click();
  await page.locator('#youChip').waitFor({ state: 'visible' });
  const profile = await page.evaluate(room => JSON.parse(
    localStorage.getItem(`kingshoter_r_${room}_me`) || 'null'
  ), new URL(page.url()).searchParams.get('room'));
  device.profile = profile;
  expect(profile.identityMode).toBe('nickname');
  expect(profile.pid).toMatch(/^n_[0-9a-f]{22}$/);
  return profile;
}

async function unlockCommander(page, password) {
  await page.locator('#cmdUnlock').click();
  await page.locator('#pwInput').fill(password);
  await page.locator('#pwGo').click();
  await page.locator('#console').waitFor({ state: 'visible' });
}

async function roomSnapshot(request, baseURL, room) {
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
  await expect.poll(async () => Object.keys(
    (await roomSnapshot(request, baseURL, room)).players || {}
  ).length).toBe(count);
}

async function mutate(page, room, payload) {
  assertQaRoomName(room);
  return page.evaluate(({ roomName, message }) => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
    let sent = false;
    const timer = setTimeout(() => {
      try { socket.close(); } catch (error) {}
      reject(new Error('mutation_timeout'));
    }, 10_000);
    const finish = value => {
      clearTimeout(timer);
      try { socket.close(); } catch (error) {}
      resolve(value);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('mutation_socket_error'));
    };
    socket.onmessage = event => {
      let parsed;
      try { parsed = JSON.parse(String(event.data)); } catch (error) { return; }
      if (parsed.t === 'error') {
        clearTimeout(timer);
        try { socket.close(); } catch (error) {}
        reject(new Error(parsed.error || 'mutation_error'));
        return;
      }
      if (parsed.t !== 'state') return;
      if (!sent) {
        sent = true;
        socket.send(JSON.stringify(message));
        return;
      }
      if (message.t !== 'cmd') return;
      const kingdom = Number(message.cmd.kingdom || 1);
      const command = parsed.room.live.commands[kingdom];
      if (message.cmd.type === 'cancel' && !command) finish(null);
      else if (command && command.type === message.cmd.type) finish(command);
    };
  }), { roomName: room, message: payload });
}

async function sendDouble(page, room, password, options) {
  return mutate(page, room, {
    t: 'cmd',
    password,
    cmd: {
      type: 'double_rally',
      kingdom: options.kingdom,
      anchorUTC: options.firstPress,
      payload: {
        leadSeconds: options.leadSeconds,
        firstPress: options.firstPress,
        kingdom: options.kingdom,
        pairs: [
          { pid: options.weakPid, role: 'weak' },
          { pid: options.mainPid, role: 'main' }
        ]
      }
    }
  });
}

async function cancel(page, room, password, kingdom) {
  return mutate(page, room, {
    t: 'cmd', password, cmd: { type: 'cancel', kingdom }
  });
}

async function deliverySummary(request, baseURL, room, commandId) {
  const snapshot = await roomSnapshot(request, baseURL, room);
  const commands = snapshot.deliveryShadow && snapshot.deliveryShadow.commands;
  return (commands || []).find(command => command.commandId === commandId) || null;
}

async function waitForDeliverySummary(request, baseURL, room, commandId, expected) {
  await expect.poll(() => deliverySummary(request, baseURL, room, commandId), {
    timeout: 15_000
  }).toMatchObject(expected);
}

async function cueEntries(page, commandId) {
  return page.evaluate(id => Object.entries(window.__cues || {})
    .filter(([, cue]) => cue && typeof cue.base === 'string' && cue.base.startsWith(`${id}-`))
    .map(([key, cue]) => ({
      key,
      base: cue.base,
      targetMs: cue.t,
      nodeCount: Array.isArray(cue.nodes) ? cue.nodes.length : 0
    })), commandId);
}

async function futureCueEntries(page, commandId) {
  return page.evaluate(id => {
    const now = window.serverNow();
    return Object.entries(window.__cues || {})
      .filter(([, cue]) => cue && cue.base && cue.base.startsWith(`${id}-`) && cue.t > now)
      .map(([key, cue]) => ({ key, base: cue.base, targetMs: cue.t }));
  }, commandId);
}

function futureCueCountAt(message, nowMs) {
  const offsets = new Set([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, message.leadSeconds]);
  return [...offsets].filter(offset =>
    message.fireAtMs - offset * 1000 > nowMs - 150).length;
}

async function assertCandidateArrivalTruth(device, commandId, candidate) {
  const ack = device.gate.events.find(event => event.direction === 'client' &&
    event.message && event.message.t === 'deliveryShadowAck' &&
    event.message.commandId === commandId && event.message.result === 'would_schedule');
  expect(ack).toBeTruthy();
  const frame = [...device.gate.events].reverse().find(event =>
    event.sequence < ack.sequence && event.direction === 'server' && !event.dropped &&
    event.message && event.message.t === 'deliveryShadowCommand' &&
    event.message.commandId === commandId);
  expect(frame).toBeTruthy();
  const clockOffset = await device.page.evaluate(() => Number(window.clockOffset) || 0);
  const countAtArrival = futureCueCountAt(frame.message, frame.at + clockOffset);
  const countAtAck = futureCueCountAt(frame.message, ack.at + clockOffset);
  expect(ack.message.futureCueCount).toBe(candidate.count);
  expect(candidate.count).toBeGreaterThanOrEqual(countAtAck);
  expect(candidate.count).toBeLessThanOrEqual(countAtArrival);
}

function commandPair(command, pid) {
  return command.payload.pairs.find(pair => pair.pid === pid);
}

async function serverNowSeconds(page) {
  return page.evaluate(() => window.serverNow() / 1000);
}

test('eight isolated devices preserve Classic authority and Reliable device truth', async ({
  browser, baseURL, request
}, testInfo) => {
  test.slow();
  const room = assertQaRoomName(makeQaRoom(testInfo));
  const password = PASSWORD();
  const errors = [];
  const a1Gate = createFrameGate({ dropFirstCandidate: true });
  const profiles = {
    a: numericProfile('930000001', 'Captain A', 31),
    b: numericProfile('930000002', 'Captain B', 30),
    member: numericProfile('930000003', 'Member', 25),
    commander: numericProfile('930000004', 'Commander Captain', 32)
  };
  const definitions = [
    { key: 'commander-only', deviceId: '88888888-8888-4888-8888-888888888888' },
    { key: 'captain-a-1', profile: profiles.a, deviceId: '11111111-1111-4111-8111-111111111111', gate: a1Gate },
    { key: 'captain-b', profile: profiles.b, deviceId: '33333333-3333-4333-8333-333333333333' },
    { key: 'ordinary-member', profile: profiles.member, deviceId: '44444444-4444-4444-8444-444444444444' },
    { key: 'captain-a-2', profile: deliveryOnlyProfile(profiles.a), deviceId: '22222222-2222-4222-8222-222222222222' },
    { key: 'same-name-1', deviceId: '66666666-6666-4666-8666-666666666666' },
    { key: 'same-name-2', deviceId: '77777777-7777-4777-8777-777777777777' },
    { key: 'selected-commander', profile: profiles.commander, deviceId: '55555555-5555-4555-8555-555555555555' }
  ];
  const devices = [];
  try {
    for (const definition of definitions) {
      devices.push(await openDevice(browser, baseURL, room, {
        ...definition,
        gate: definition.gate || createFrameGate(),
        errors
      }));
    }
    expect(new Set(devices.map(device => device.context)).size).toBe(8);
    expect(new Set(devices.map(device => device.deviceId)).size).toBe(8);
    const byKey = Object.fromEntries(devices.map(device => [device.key, device]));

    const nicknameOne = await registerNickname(byKey['same-name-1'], 'Same Name', 28);
    const nicknameTwo = await registerNickname(byKey['same-name-2'], 'Same Name', 29);
    expect(nicknameOne.pid).not.toBe(nicknameTwo.pid);

    await Promise.all(devices.filter(device => device.profile).map(device =>
      waitForAutomaticReady(device)));
    await waitForPlayerCount(request, baseURL, room, 6);
    const roster = (await roomSnapshot(request, baseURL, room)).players;
    expect(roster[nicknameOne.pid].name).toBe('Same Name');
    expect(roster[nicknameTwo.pid].name).toBe('Same Name');
    expect(byKey['commander-only'].gate.events.some(event =>
      event.direction === 'client' && event.message &&
      event.message.t === 'deliveryShadowHello')).toBe(false);

    await unlockCommander(byKey['commander-only'].page, password);
    await unlockCommander(byKey['selected-commander'].page, password);
    await Promise.all([
      byKey['captain-a-1'],
      byKey['captain-a-2'],
      byKey['captain-b']
    ].map(device => waitForFreshArmed(device)));

    const issuedFrom = await serverNowSeconds(byKey['commander-only'].page);
    const firstPress = Math.ceil(issuedFrom) + LEAD_SECONDS;
    const first = await sendDouble(byKey['commander-only'].page, room, password, {
      kingdom: 1,
      firstPress,
      leadSeconds: LEAD_SECONDS,
      weakPid: profiles.a.pid,
      mainPid: profiles.b.pid
    });
    expect(first.payload.leadSeconds).toBe(LEAD_SECONDS);
    expect(Math.min(...first.payload.pairs.map(pair => pair.pressUTC))).toBe(firstPress);
    expect(firstPress - issuedFrom).toBeGreaterThanOrEqual(LEAD_SECONDS);
    expect(firstPress - issuedFrom).toBeLessThan(LEAD_SECONDS + 1.1);
    expect(commandPair(first, profiles.b.pid).pressUTC).toBe(firstPress + 2);

    await expect.poll(() => a1Gate.candidateRaw.length).toBeGreaterThanOrEqual(2);
    expect(new Set(a1Gate.candidateRaw).size).toBe(1);
    await waitForDeliverySummary(request, baseURL, room, first.id, {
      commandId: first.id,
      expectedDevices: 3,
      classicScheduled: 3,
      candidateAcked: 3,
      expired: 0,
      cancelled: false
    });
    const retryCount = a1Gate.candidateRaw.length;
    await delay(1_300);
    expect(a1Gate.candidateRaw.length).toBe(retryCount);
    expect(retryCount).toBe(2);

    for (const key of ['captain-a-1', 'captain-a-2', 'captain-b']) {
      const device = byKey[key];
      const entries = await cueEntries(device.page, first.id);
      const pid = key === 'captain-b' ? profiles.b.pid : profiles.a.pid;
      const go = entries.filter(entry => entry.base === `${first.id}-me` && entry.key.endsWith(':0'));
      expect(go).toHaveLength(1);
      expect(go[0].nodeCount).toBeGreaterThan(0);
      expect(go[0].targetMs).toBe(commandPair(first, pid).pressUTC * 1000);
      const candidate = await device.page.evaluate(id => window.__kvkDeliveryQa.events
        .find(event => event.kind === 'candidate' && event.commandId === id), first.id);
      expect(candidate).toMatchObject({ result: 'would_schedule' });
      await assertCandidateArrivalTruth(device, first.id, candidate);
    }
    const bEntries = await cueEntries(byKey['captain-b'].page, first.id);
    const prepare = bEntries.find(entry => entry.base === `${first.id}-me` && entry.key.endsWith(`:${LEAD_SECONDS}`));
    expect(prepare).toMatchObject({
      targetMs: (commandPair(first, profiles.b.pid).pressUTC - LEAD_SECONDS) * 1000
    });
    expect(prepare.nodeCount).toBeGreaterThan(0);

    const memberEntries = await cueEntries(byKey['ordinary-member'].page, first.id);
    expect(new Set(memberEntries.filter(entry => entry.base === `${first.id}-join`)
      .map(entry => entry.base))).toEqual(new Set([`${first.id}-join`]));
    expect((await cueEntries(byKey['commander-only'].page, first.id))).toEqual([]);
    expect((await cueEntries(byKey['selected-commander'].page, first.id))).toEqual([]);

    await cancel(byKey['commander-only'].page, room, password, 1);
    await waitForDeliverySummary(request, baseURL, room, first.id, {
      commandId: first.id,
      cancelled: true
    });
    await expect.poll(async () => (await Promise.all(devices.map(device =>
      futureCueEntries(device.page, first.id)))).flat().length).toBe(0);

    await Promise.all([
      byKey['selected-commander'],
      byKey['captain-b']
    ].map(device => waitForFreshArmed(device)));
    const secondPress = Math.ceil(await serverNowSeconds(byKey['commander-only'].page)) + LEAD_SECONDS;
    const second = await sendDouble(byKey['commander-only'].page, room, password, {
      kingdom: 2,
      firstPress: secondPress,
      leadSeconds: LEAD_SECONDS,
      weakPid: profiles.commander.pid,
      mainPid: profiles.b.pid
    });
    await expect.poll(async () => (await cueEntries(
      byKey['selected-commander'].page, second.id
    )).filter(entry => entry.base === `${second.id}-me` && entry.key.endsWith(':0')).length).toBe(1);
    await cancel(byKey['commander-only'].page, room, password, 2);
    await expect.poll(async () => (await futureCueEntries(
      byKey['selected-commander'].page, second.id
    )).length).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(devices.map(device => device.context.close().catch(() => {})));
  }
});

test('a selected device reconnects before cutoff with the immutable command', async ({
  browser, baseURL, request
}, testInfo) => {
  const room = assertQaRoomName(makeQaRoom(testInfo));
  const password = PASSWORD();
  const errors = [];
  const aGate = createFrameGate();
  const profiles = {
    a: numericProfile('940000001', 'Reconnect A', 31),
    b: numericProfile('940000002', 'Reconnect B', 30)
  };
  const devices = [];
  try {
    const a = await openDevice(browser, baseURL, room, {
      key: 'reconnect-a', profile: profiles.a,
      deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      gate: aGate, errors
    });
    devices.push(a);
    const b = await openDevice(browser, baseURL, room, {
      key: 'reconnect-b', profile: profiles.b,
      deviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      gate: createFrameGate(), errors
    });
    devices.push(b);
    await Promise.all([waitForAutomaticReady(a), waitForAutomaticReady(b)]);
    await waitForPlayerCount(request, baseURL, room, 2);
    await unlockCommander(b.page, password);
    await Promise.all([waitForFreshArmed(a), waitForFreshArmed(b)]);

    aGate.blockCandidate = true;
    aGate.blockCommandState = true;
    const firstPress = Math.ceil(await serverNowSeconds(b.page)) + 25;
    const command = await sendDouble(b.page, room, password, {
      kingdom: 1,
      firstPress,
      leadSeconds: LEAD_SECONDS,
      weakPid: profiles.a.pid,
      mainPid: profiles.b.pid
    });
    const frozenPairs = structuredClone(command.payload.pairs);
    await expect.poll(() => aGate.candidateRaw.length).toBeGreaterThanOrEqual(1);
    await expect.poll(() => aGate.blockedCommandStates).toBeGreaterThanOrEqual(1);

    const generationBefore = await a.page.evaluate(() =>
      window.__kvkDeliveryQa.getSocket().connectionGeneration);
    const reconnectBoundary = aGate.sequence;
    await a.context.setOffline(true);
    await a.page.evaluate(() => window.__kvkDeliveryQa.getSocket().ws.close());
    await a.page.waitForFunction(() => !window.__kvkDeliveryQa.getSocket().connected);
    aGate.blockCandidate = false;
    aGate.blockCommandState = false;
    await delay(300);
    await a.context.setOffline(false);
    await a.page.evaluate(() => window.__kvkDeliveryQa.getSocket().kick());
    await expect.poll(() => a.page.evaluate(() =>
      window.__kvkDeliveryQa.getSocket().connectionGeneration)).toBeGreaterThan(generationBefore);
    await waitForAutomaticReady(a, reconnectBoundary);

    await expect.poll(() => aGate.candidateRaw.length).toBeGreaterThanOrEqual(2);
    expect(new Set(aGate.candidateRaw).size).toBe(1);
    expect(parseFrame(aGate.candidateRaw[0]).commandId).toBe(command.id);
    await waitForDeliverySummary(request, baseURL, room, command.id, {
      commandId: command.id,
      expectedDevices: 2,
      classicScheduled: 2,
      candidateAcked: 2,
      expired: 0,
      cancelled: false
    });
    const stableFrames = aGate.candidateRaw.length;
    await delay(1_800);
    expect(aGate.candidateRaw.length).toBe(stableFrames);

    const state = await a.page.evaluate(() => window.__kvkDeliveryQa.controller.state());
    expect(state.seenCandidate.filter(id => id === command.id)).toEqual([command.id]);
    const aCues = await cueEntries(a.page, command.id);
    const go = aCues.filter(entry => entry.base === `${command.id}-me` && entry.key.endsWith(':0'));
    expect(go).toHaveLength(1);
    expect(go[0].targetMs).toBe(commandPair(command, profiles.a.pid).pressUTC * 1000);
    const afterReconnect = await roomSnapshot(request, baseURL, room);
    expect(afterReconnect.live.commands['1'].id).toBe(command.id);
    expect(afterReconnect.live.commands['1'].payload.pairs).toEqual(frozenPairs);
    await cancel(b.page, room, password, 1);
    await expect.poll(async () => (await futureCueEntries(a.page, command.id)).length).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(devices.map(device => device.context.close().catch(() => {})));
  }
});

test('omitting the shadow flags is a zero-candidate Classic rollback', async ({
  browser, baseURL, request
}, testInfo) => {
  const room = assertQaRoomName(makeQaRoom(testInfo));
  const password = PASSWORD();
  const errors = [];
  const profiles = {
    a: numericProfile('950000001', 'Classic A', 31),
    b: numericProfile('950000002', 'Classic B', 30),
    member: numericProfile('950000003', 'Classic Member', 25)
  };
  const definitions = [
    { key: 'classic-a', profile: profiles.a, deviceId: 'c1000000-0000-4000-8000-000000000001' },
    { key: 'classic-b', profile: profiles.b, deviceId: 'c2000000-0000-4000-8000-000000000002' },
    { key: 'classic-member', profile: profiles.member, deviceId: 'c3000000-0000-4000-8000-000000000003' }
  ];
  const devices = [];
  try {
    for (const definition of definitions) {
      devices.push(await openClassicDevice(browser, baseURL, room, {
        ...definition,
        gate: createFrameGate(),
        errors
      }));
    }
    const byKey = Object.fromEntries(devices.map(device => [device.key, device]));
    await waitForPlayerCount(request, baseURL, room, 3);
    await unlockCommander(byKey['classic-b'].page, password);

    const firstPress = Math.ceil(await serverNowSeconds(byKey['classic-b'].page)) + LEAD_SECONDS;
    const command = await sendDouble(byKey['classic-b'].page, room, password, {
      kingdom: 1,
      firstPress,
      leadSeconds: LEAD_SECONDS,
      weakPid: profiles.a.pid,
      mainPid: profiles.b.pid
    });

    await expect.poll(async () => {
      const snapshot = await roomSnapshot(request, baseURL, room);
      const live = snapshot.live.commands['1'];
      return live && live.id === command.id ? live.delivery : null;
    }).toEqual([
      { pid: profiles.a.pid, expected: 1, received: 1, expired: 0 },
      { pid: profiles.b.pid, expected: 1, received: 1, expired: 0 }
    ]);
    await expect.poll(async () => (await cueEntries(
      byKey['classic-a'].page, command.id
    )).some(entry => entry.base === `${command.id}-me` && entry.key.endsWith(':0'))).toBe(true);
    await expect.poll(async () => (await cueEntries(
      byKey['classic-b'].page, command.id
    )).some(entry => entry.base === `${command.id}-me` && entry.key.endsWith(':0'))).toBe(true);
    await expect.poll(async () => (await cueEntries(
      byKey['classic-member'].page, command.id
    )).some(entry => entry.base === `${command.id}-join` && entry.key.endsWith(':0'))).toBe(true);

    for (const device of devices) {
      expect(device.gate.events.filter(event => event.message &&
        String(event.message.t || '').startsWith('deliveryShadow'))).toEqual([]);
      expect(await device.page.evaluate(() => window.__kvkDeliveryQa)).toBeUndefined();
    }
    expect((await roomSnapshot(request, baseURL, room)).deliveryShadow).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(devices.map(device => device.context.close().catch(() => {})));
  }
});
