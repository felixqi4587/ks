const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-coordination.cjs');

const base = process.env.BASE || process.argv[2] || 'http://127.0.0.1:8791';
const mainRoom = makeQaRoom('classic-delivery');
const noAudioRoom = makeQaRoom('classic-no-audio');
const returningRoom = makeQaRoom('classic-returning');
const stageRaceRoom = makeQaRoom('classic-stage-race');
const syncGateRoom = makeQaRoom('classic-sync-gate');
const longAckHoldRoom = makeQaRoom('classic-long-ack-hold');
const expiredReconnectRoom = makeQaRoom('classic-expired-reconnect');
const staleAudioRoom = makeQaRoom('classic-stale-audio');
const password = 'classic-delivery-password';
const profileKey = '60000000-0000-4000-8000-000000000001';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function profile(pid, name, march = 60) {
  return { pid, name, march, marchRevision: 0, identityMode: 'playerId', profileKey };
}

function packetGate(options = {}) {
  return {
    clientAcks: [],
    savedAcks: [],
    clientStages: [],
    stageSuperseded: [],
    deviceStatuses: [],
    heartbeats: [],
    holdClientAcks: options.holdClientAcks === true,
    dropFirstClientAck: options.dropFirstClientAck === true,
    dropFirstSavedAck: options.dropFirstSavedAck === true,
    clientAckDropped: false,
    savedAckDropped: false
  };
}

function gateOptions(gate) {
  return {
    shouldDropClientMessage({ data }) {
      let message = null;
      try { message = JSON.parse(String(data)); } catch (_) {}
      if (message && message.t === 'deviceStatus') gate.deviceStatuses.push(message);
      if (message && message.t === 'hb') gate.heartbeats.push(message);
      if (message && message.t === 'stage') gate.clientStages.push(message);
      if (!message || message.t !== 'deliveryAck') return false;
      gate.clientAcks.push(message);
      if (gate.holdClientAcks) return true;
      if (gate.dropFirstClientAck && !gate.clientAckDropped) {
        gate.clientAckDropped = true;
        return true;
      }
      return false;
    },
    shouldDropServerMessage({ data }) {
      let message = null;
      try { message = JSON.parse(String(data)); } catch (_) {}
      if (message && message.t === 'stageSuperseded') gate.stageSuperseded.push(message);
      if (!message || message.t !== 'deliveryAckSaved') return false;
      gate.savedAcks.push(message);
      if (gate.dropFirstSavedAck && !gate.savedAckDropped) {
        gate.savedAckDropped = true;
        return true;
      }
      return false;
    }
  };
}

async function waitUntil(read, label, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function seedRoom(browser, room, players) {
  assertQaRoomName(room);
  const context = await browser.newContext({ locale: 'en-US' });
  await installQaWebSocketGuard(context, room);
  const page = await context.newPage();
  try {
    await page.goto(qaRoomUrl(base, room, { notour: 1, lang: 'en' }), { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ roomName, records }) => new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}`);
      const timer = setTimeout(() => {
        try { socket.close(); } catch (_) {}
        reject(new Error('Timed out seeding QA room'));
      }, 7_000);
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('QA seed WebSocket failed'));
      };
      socket.onopen = () => records.forEach(record => socket.send(JSON.stringify({
        t: 'registerPlayer',
        pid: record.pid,
        name: record.name,
        march: record.march,
        identityMode: record.identityMode,
        profileKey: record.profileKey,
        alliance: ''
      })));
      socket.onmessage = event => {
        let message = null;
        try { message = JSON.parse(event.data); } catch (_) {}
        const roster = message && message.t === 'state' && message.room && message.room.players;
        if (!roster || !records.every(record => Object.prototype.hasOwnProperty.call(roster, record.pid))) return;
        clearTimeout(timer);
        socket.close();
        resolve();
      };
    }), { roomName: room, records: players });
  } finally {
    await context.close();
  }
}

async function openClient(browser, options) {
  const { room, label, ownProfile = null, noAudio = false, gate = packetGate(), errors } = options;
  assertQaRoomName(room);
  const context = await browser.newContext({
    viewport: { width: 390, height: 1100 },
    locale: 'en-US'
  });
  await context.addInitScript(({ roomName, storedProfile, disableAudio }) => {
    if (storedProfile) {
      localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify(storedProfile));
    }
    if (disableAudio) {
      const removeAudioConstructor = key => {
        try { Object.defineProperty(window, key, { configurable: true, writable: true, value: undefined }); }
        catch (_) { try { window[key] = undefined; } catch (_) {} }
      };
      removeAudioConstructor('AudioContext');
      removeAudioConstructor('webkitAudioContext');
    }
    const NativeWebSocket = window.WebSocket;
    window.__qaRoomSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__qaRoomSockets.push(this);
      }
    };
  }, { roomName: room, storedProfile: ownProfile, disableAudio: noAudio });
  await installQaWebSocketGuard(context, room, gateOptions(gate));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
  await page.goto(qaRoomUrl(base, room, { notour: 1, lang: 'en' }), { waitUntil: 'domcontentloaded' });
  if (ownProfile) {
    await page.locator('#youChip').waitFor({ state: 'visible', timeout: 7_000 });
    await page.locator('#youName').filter({ hasText: ownProfile.name }).waitFor({ timeout: 7_000 });
  }
  await page.locator('#soundGate').click({ force: true });
  if (noAudio) {
    await page.locator('#audioStatus.warn').waitFor({ state: 'visible', timeout: 3_000 });
    assert.equal(await page.evaluate(() => Boolean(window.__ac)), false, `${label} has no schedulable AudioContext`);
  } else {
    await page.waitForFunction(() => window.__ac && window.__ac.state === 'running', null, { timeout: 5_000 });
  }
  return { context, page, gate };
}

async function openTimeControlledClient(browser, options) {
  const { room, label, ownProfile, gate, timeGate, errors } = options;
  assertQaRoomName(room);
  const context = await browser.newContext({
    viewport: { width: 390, height: 1100 },
    locale: 'en-US'
  });
  await context.addInitScript(({ roomName, storedProfile }) => {
    localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify(storedProfile));
    const NativeWebSocket = window.WebSocket;
    window.__qaRoomSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__qaRoomSockets.push(this);
      }
    };
  }, { roomName: room, storedProfile: ownProfile });
  await context.route('**/api/time*', async route => {
    if (!timeGate.allowRequests) {
      timeGate.blockedRequests += 1;
      timeGate.blockedRoutes.push(route);
      return;
    }
    timeGate.successfulRequests += 1;
    await route.continue();
  });
  await installQaWebSocketGuard(context, room, gateOptions(gate));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
  await page.goto(qaRoomUrl(base, room, { notour: 1, lang: 'en' }), { waitUntil: 'domcontentloaded' });
  await page.locator('#youChip').waitFor({ state: 'visible', timeout: 7_000 });
  await page.locator('#youName').filter({ hasText: ownProfile.name }).waitFor({ timeout: 7_000 });
  await page.locator('#soundGate').click({ force: true });
  await page.waitForFunction(() => window.__ac && window.__ac.state === 'running', null, { timeout: 5_000 });
  return { context, page, gate };
}

async function openClientPageInContext(context, room, label, ownProfile, errors) {
  assertQaRoomName(room);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
  await page.goto(qaRoomUrl(base, room, { notour: 1, lang: 'en' }), { waitUntil: 'domcontentloaded' });
  await page.locator('#youChip').waitFor({ state: 'visible', timeout: 7_000 });
  await page.locator('#youName').filter({ hasText: ownProfile.name }).waitFor({ timeout: 7_000 });
  await page.locator('#soundGate').click({ force: true });
  await page.waitForFunction(() => window.__ac && window.__ac.state === 'running', null, { timeout: 5_000 });
  return page;
}

async function closeContexts(contexts) {
  for (const context of contexts.splice(0)) {
    try { await context.close(); } catch (_) {}
  }
}

async function runRegressionCase(name, failures, run) {
  try {
    await run();
    console.log(`CORE11 GREEN: ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`CORE11 RED: ${name} — ${error.message}`);
  }
}

async function unlockCommander(page) {
  await page.locator('#cmdUnlock').click();
  await page.locator('#pwInput').fill(password);
  await page.locator('#pwGo').click();
  await page.locator('#console').waitFor({ state: 'visible', timeout: 6_000 });
}

async function selectAndFire(page, firstPid, secondPid) {
  for (const pid of [firstPid, secondPid]) {
    await page.locator(`#roster .rp[data-pid="${pid}"]`).click();
    try {
      await page.waitForFunction(value => {
        const row = document.querySelector(`#roster .rp[data-pid="${value}"]`);
        return row && row.getAttribute('aria-pressed') === 'true';
      }, pid, { timeout: 8_000 });
    } catch (error) {
      const selection = await page.evaluate(value => ({
        targetPressed: document.querySelector(`#roster .rp[data-pid="${value}"]`)?.getAttribute('aria-pressed') || null,
        pressedPids: Array.from(document.querySelectorAll('#roster .rp[aria-pressed="true"]')).map(row => row.dataset.pid),
        slotPids: Array.from(document.querySelectorAll('#pickSlots .slot[data-pid]')).map(slot => slot.dataset.pid),
        fireDisabled: Boolean(document.querySelector('#fireDouble')?.disabled)
      }), pid);
      throw new Error(`Timed out selecting captain ${pid}: ${JSON.stringify(selection)}`, { cause: error });
    }
  }
  await page.locator('#lead button[data-v="30"]').click();
  await page.locator('#fireDouble').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#fireDouble').isDisabled(), false, 'two canonical captains enable Fire');
  await page.locator('#fireDouble').click();
  await page.waitForTimeout(180);
  await page.locator('#fireDouble').click();
  await page.locator('#pickSlots.frozen').waitFor({ state: 'visible', timeout: 7_000 });
}

async function readSnapshot(page, room) {
  assertQaRoomName(room);
  return page.evaluate(async roomName => {
    const response = await fetch(`/api/ws?room=${encodeURIComponent(roomName)}`);
    if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
    return response.json();
  }, room);
}

async function readHttpSnapshot(room) {
  const safeRoom = assertQaRoomName(room);
  const url = new URL('/api/ws', base);
  url.searchParams.set('room', safeRoom);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
  return response.json();
}

async function openLegacyCommander(browser, room, ownProfile, errors) {
  assertQaRoomName(room);
  const context = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  await context.addInitScript(({ roomName, storedProfile }) => {
    localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify(storedProfile));
  }, { roomName: room, storedProfile: ownProfile });
  await context.routeWebSocket(/\/api\/ws(?:\?|$)/, route => {
    const actualRoom = new URL(route.url()).searchParams.get('room') || '';
    if (actualRoom !== room) throw new Error(`Legacy guard refused non-QA room ${actualRoom || '<empty>'}`);
    const server = route.connectToServer();
    route.onMessage(data => server.send(data));
    server.onMessage(data => {
      let outgoing = data;
      try {
        const message = JSON.parse(String(data));
        const commands = message && message.t === 'state' && message.room && message.room.live && message.room.live.commands;
        Object.values(commands || {}).filter(Boolean).forEach(command => { delete command.delivery; });
        outgoing = JSON.stringify(message);
      } catch (_) {}
      route.send(outgoing);
    });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`legacy-client: ${error.message}`));
  await page.goto(qaRoomUrl(base, room, { notour: 1, lang: 'en' }), { waitUntil: 'domcontentloaded' });
  await page.locator('#youChip').waitFor({ state: 'visible', timeout: 7_000 });
  await page.locator('#soundGate').click({ force: true });
  await page.waitForFunction(() => window.__ac && window.__ac.state === 'running', null, { timeout: 5_000 });
  await unlockCommander(page);
  await page.locator('#pickSlots.frozen').waitFor({ state: 'visible', timeout: 7_000 });
  return { context, page };
}

function stageRaceGate(firstPid) {
  const gate = {
    firstPid,
    clientStages: [],
    clientCommands: [],
    heldStates: [],
    holdingServerFrames: false,
    commandStateHeld: false,
    released: false,
    route: null
  };
  gate.releaseHeld = () => {
    if (!gate.route) throw new Error('Stage-race QA route is not connected');
    gate.released = true;
    const packets = gate.heldStates.splice(0);
    packets.forEach(packet => gate.route.send(packet));
  };
  return gate;
}

async function installStageRaceGuard(context, room, gate) {
  const safeRoom = assertQaRoomName(room);
  await context.routeWebSocket(/\/api\/ws(?:\?|$)/, route => {
    const actualRoom = new URL(route.url()).searchParams.get('room') || '';
    if (actualRoom !== safeRoom) throw new Error(`Stage-race guard refused room ${actualRoom || '<empty>'}`);
    gate.route = route;
    const server = route.connectToServer();
    route.onMessage(data => {
      let message = null;
      try { message = JSON.parse(String(data)); } catch (_) {}
      if (message && message.t === 'stage') gate.clientStages.push(message);
      if (message && message.t === 'cmd' && message.cmd && message.cmd.type === 'double_rally') gate.clientCommands.push(message);
      server.send(data);
    });
    server.onMessage(data => {
      let message = null;
      try { message = JSON.parse(String(data)); } catch (_) {}
      const commands = message && message.t === 'state' && message.room && message.room.live && message.room.live.commands;
      const command = commands && commands['1'];
      const staged = message && message.t === 'state' && message.room && message.room.live && message.room.live.staged && message.room.live.staged['1'];
      const pairs = staged && Array.isArray(staged.pairs) ? staged.pairs : [];
      if (!gate.holdingServerFrames && !gate.released && !command && pairs.length === 1 && pairs[0].pid === gate.firstPid) {
        gate.holdingServerFrames = true;
      }
      if (gate.holdingServerFrames && !gate.released) {
        gate.heldStates.push(data);
        if (command) gate.commandStateHeld = true;
        return;
      }
      route.send(data);
    });
  });
}

async function openStageRaceCommander(browser, room, gate, errors) {
  const context = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  await installStageRaceGuard(context, room, gate);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`stage-race-commander: ${error.message}`));
  await page.goto(qaRoomUrl(base, room, { notour: 1, lang: 'en' }), { waitUntil: 'domcontentloaded' });
  await page.locator('#soundGate').click({ force: true });
  await page.waitForFunction(() => window.__ac && window.__ac.state === 'running', null, { timeout: 5_000 });
  return { context, page };
}

(async () => {
  assertQaRoomName(mainRoom);
  assertQaRoomName(noAudioRoom);
  assertQaRoomName(returningRoom);
  assertQaRoomName(stageRaceRoom);
  assertQaRoomName(syncGateRoom);
  assertQaRoomName(longAckHoldRoom);
  assertQaRoomName(expiredReconnectRoom);
  assertQaRoomName(staleAudioRoom);
  console.log(`Classic delivery QA rooms: ${mainRoom}, ${noAudioRoom}, ${returningRoom}, ${stageRaceRoom}, ${syncGateRoom}, ${longAckHoldRoom}, ${expiredReconnectRoom}, ${staleAudioRoom}`);

  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  const openContexts = [];
  const errors = [];
  const core11Failures = [];

  try {
    await runRegressionCase('large clock correction stops stale personal audio and reports Expired', core11Failures, async () => {
      const contexts = [];
      const caseErrors = [];
      try {
        const targetProfile = profile('973000001', 'Clock Drift Captain');
        const peerProfile = profile('973000002', 'Clock Drift Peer');
        await seedRoom(browser, staleAudioRoom, [targetProfile, peerProfile]);
        const targetGate = packetGate();
        const timeGate = {
          allowRequests: false,
          blockedRequests: 0,
          blockedRoutes: [],
          successfulRequests: 0
        };
        const target = await openTimeControlledClient(browser, {
          room: staleAudioRoom,
          label: 'clock-drift-captain',
          ownProfile: targetProfile,
          gate: targetGate,
          timeGate,
          errors: caseErrors
        });
        const peer = await openClient(browser, {
          room: staleAudioRoom,
          label: 'clock-drift-peer',
          ownProfile: peerProfile,
          gate: packetGate(),
          errors: caseErrors
        });
        const commander = await openClient(browser, {
          room: staleAudioRoom,
          label: 'clock-drift-commander',
          gate: packetGate(),
          errors: caseErrors
        });
        contexts.push(target.context, peer.context, commander.context);
        await waitUntil(() => timeGate.blockedRequests >= 1, 'initial captain clock sync held');
        await target.page.evaluate(() => { window.clockOffset = -30_000; });
        await unlockCommander(commander.page);
        await delay(300);
        for (const pid of [targetProfile.pid, peerProfile.pid]) {
          await commander.page.locator(`#roster .rp[data-pid="${pid}"]`).click();
          await commander.page.waitForFunction(value => {
            const row = document.querySelector(`#roster .rp[data-pid="${value}"]`);
            return row && row.getAttribute('aria-pressed') === 'true';
          }, pid, { timeout: 8_000 });
        }
        await commander.page.locator('#lead button[data-v="10"]').click();
        await commander.page.locator('#fireDouble').click();
        await commander.page.waitForTimeout(180);
        await commander.page.locator('#fireDouble').click();
        await commander.page.locator('#pickSlots.frozen').waitFor({ state: 'visible', timeout: 7_000 });

        const firedSnapshot = await readSnapshot(commander.page, staleAudioRoom);
        const firedCommand = Object.values(firedSnapshot.room.live.commands).find(Boolean);
        const targetPair = firedCommand.payload.pairs.find(pair => pair.pid === targetProfile.pid);
        await target.page.waitForFunction(commandId => Object.entries(window.__cues || {}).some(([key, cue]) => key.startsWith(`${commandId}-me:`) && cue.nodes && cue.nodes.length > 0), firedCommand.id, { timeout: 5_000 });
        const booked = await target.page.evaluate(commandId => {
          const tracked = [];
          Object.entries(window.__cues || {}).forEach(([key, cue]) => {
            if (!key.startsWith(`${commandId}-me:`) || !cue.nodes || cue.nodes.length === 0) return;
            cue.nodes.forEach(node => {
              const record = { key, stopCalls: 0, lastStopAt: null };
              const originalStop = node.o.stop;
              node.o.stop = function (...args) {
                record.stopCalls += 1;
                record.lastStopAt = args.length ? Number(args[0]) : null;
                return originalStop.apply(this, args);
              };
              tracked.push(record);
            });
          });
          window.__qaDriftStopRecords = tracked;
          return {
            cueCount: new Set(tracked.map(record => record.key)).size,
            nodeCount: tracked.length,
            goNodeCount: tracked.filter(record => record.key.endsWith(':0')).length,
            offset: window.clockOffset
          };
        }, firedCommand.id);
        assert.ok(booked.nodeCount > 0, 'wrong negative offset prebooks personal WebAudio nodes');
        assert.ok(booked.goNodeCount > 0, 'wrong negative offset prebooks a stale GO node');
        assert.ok(booked.offset < -25_000, 'captain is deliberately running on the wrong negative offset');
        assert.equal(targetGate.clientAcks.length, 0, 'unsynced captain cannot ACK the wrongly booked cue');

        const correctionDelay = Math.max(0, targetPair.pressUTC * 1000 - Date.now() + 1_200);
        assert.ok(correctionDelay < 13_000, '10-second target keeps the drift correction test bounded');
        await delay(correctionDelay);
        assert.equal(targetGate.clientAcks.length, 0, 'clock sync remains held until after the real personal target');
        timeGate.allowRequests = true;
        const blockedRoutes = timeGate.blockedRoutes.splice(0);
        await Promise.all(blockedRoutes.map(route => route.continue()));
        await waitUntil(() => timeGate.successfulRequests >= 3, 'fresh real clock correction completes', 6_000);
        await waitUntil(() => targetGate.savedAcks.some(message => message.commandId === firedCommand.id), 'corrected expired ACK persists', 7_000);
        await commander.page.locator(`#pickSlots .slot[data-pid="${targetProfile.pid}"] .delivery.expired`).waitFor({ timeout: 7_000 });
        await delay(250);

        const cancellation = await target.page.evaluate(commandId => {
          const records = window.__qaDriftStopRecords || [];
          const activeNodes = Object.entries(window.__cues || {})
            .filter(([key]) => key.startsWith(`${commandId}-me:`))
            .reduce((count, [, cue]) => count + ((cue.nodes && cue.nodes.length) || 0), 0);
          return {
            allTrackedStopped: records.length > 0 && records.every(record => record.stopCalls > 0),
            allGoNodesStopped: records.filter(record => record.key.endsWith(':0')).length > 0 && records.filter(record => record.key.endsWith(':0')).every(record => record.stopCalls > 0),
            trackedNodes: records.length,
            stoppedNodes: records.filter(record => record.stopCalls > 0).length,
            trackedGoNodes: records.filter(record => record.key.endsWith(':0')).length,
            stoppedGoNodes: records.filter(record => record.key.endsWith(':0') && record.stopCalls > 0).length,
            activeNodes,
            records
          };
        }, firedCommand.id);
        const expiredAck = targetGate.clientAcks.find(message => message.commandId === firedCommand.id);
        assert.deepEqual({
          allTrackedStopped: cancellation.allTrackedStopped,
          allGoNodesStopped: cancellation.allGoNodesStopped,
          stoppedNodes: cancellation.stoppedNodes,
          stoppedGoNodes: cancellation.stoppedGoNodes,
          activeNodes: cancellation.activeNodes,
          outcome: expiredAck && expiredAck.outcome,
          targetUTC: expiredAck && expiredAck.targetUTC,
          correctedAfterTarget: expiredAck && expiredAck.scheduledAtMs >= targetPair.pressUTC * 1000,
          pageErrors: caseErrors
        }, {
          allTrackedStopped: true,
          allGoNodesStopped: true,
          stoppedNodes: booked.nodeCount,
          stoppedGoNodes: booked.goNodeCount,
          activeNodes: 0,
          outcome: 'expired',
          targetUTC: targetPair.pressUTC,
          correctedAfterTarget: true,
          pageErrors: []
        }, `correcting a past target must silence every stale node: ${JSON.stringify(cancellation.records)}`);
        console.log(`CORE11 stale-audio evidence: room=${staleAudioRoom} tracked=${cancellation.trackedNodes} stopped=${cancellation.stoppedNodes} goTracked=${cancellation.trackedGoNodes} goStopped=${cancellation.stoppedGoNodes} active=${cancellation.activeNodes} outcome=${expiredAck.outcome}`);
      } finally {
        await closeContexts(contexts);
      }
    });

    if (process.env.CORE11_DRIFT_ONLY === '1') {
      if (core11Failures.length > 0) {
        throw new AggregateError(
          core11Failures.map(result => result.error),
          core11Failures.map(result => `${result.name}: ${result.error.message}`).join('\n')
        );
      }
      return;
    }

    await runRegressionCase('reconnect state waits for a fresh successful clock sync before ACK/green', core11Failures, async () => {
      const contexts = [];
      const caseErrors = [];
      try {
        const targetProfile = profile('970000001', 'Sync Gated Captain');
        const peerProfile = profile('970000002', 'Sync Gated Peer');
        await seedRoom(browser, syncGateRoom, [targetProfile, peerProfile]);
        const targetGate = packetGate();
        const timeGate = {
          allowRequests: true,
          blockedRequests: 0,
          blockedRoutes: [],
          successfulRequests: 0
        };
        const target = await openTimeControlledClient(browser, {
          room: syncGateRoom,
          label: 'sync-gated-captain',
          ownProfile: targetProfile,
          gate: targetGate,
          timeGate,
          errors: caseErrors
        });
        const peer = await openClient(browser, {
          room: syncGateRoom,
          label: 'sync-gated-peer',
          ownProfile: peerProfile,
          gate: packetGate(),
          errors: caseErrors
        });
        const commander = await openClient(browser, {
          room: syncGateRoom,
          label: 'sync-gated-commander',
          gate: packetGate(),
          errors: caseErrors
        });
        contexts.push(target.context, peer.context, commander.context);
        await waitUntil(() => timeGate.successfulRequests >= 4, 'captain initial successful clock sync');
        await unlockCommander(commander.page);
        await delay(300);

        timeGate.allowRequests = false;
        const successfulBeforeReconnect = timeGate.successfulRequests;
        await target.page.evaluate(() => window.__qaRoomSockets[window.__qaRoomSockets.length - 1].close());
        await selectAndFire(commander.page, targetProfile.pid, peerProfile.pid);
        const firedSnapshot = await readSnapshot(commander.page, syncGateRoom);
        const firedCommand = Object.values(firedSnapshot.room.live.commands).find(Boolean);
        const targetPair = firedCommand.payload.pairs.find(pair => pair.pid === targetProfile.pid);
        assert.ok(targetPair.pressUTC * 1000 > Date.now() + 5_000, 'sync-gated captain still has a future personal launch cue');
        await target.page.waitForFunction(() => window.__qaRoomSockets.length >= 2 && window.__qaRoomSockets[window.__qaRoomSockets.length - 1].readyState === WebSocket.OPEN, null, { timeout: 6_000 });
        await waitUntil(() => timeGate.blockedRequests >= 1, 'reconnect clock request held before response');
        await delay(500);

        const preSyncAckCount = targetGate.clientAcks.filter(message => message.commandId === firedCommand.id).length;
        const preSyncGreenCount = await commander.page.locator(`#pickSlots .slot[data-pid="${targetProfile.pid}"] .delivery.received`).count();
        timeGate.allowRequests = true;
        const blockedRoutes = timeGate.blockedRoutes.splice(0);
        await Promise.all(blockedRoutes.map(route => route.continue()));
        await waitUntil(() => timeGate.successfulRequests >= successfulBeforeReconnect + 3, 'fresh reconnect clock sync completes', 6_000);
        await waitUntil(() => targetGate.savedAcks.some(message => message.commandId === firedCommand.id), 'post-sync delivery ACK persists', 7_000);
        await commander.page.locator(`#pickSlots .slot[data-pid="${targetProfile.pid}"] .delivery.received`).waitFor({ timeout: 7_000 });

        assert.deepEqual({
          clockWasHeld: timeGate.blockedRequests > 0,
          preSyncAckCount,
          preSyncGreenCount,
          postSyncAck: targetGate.clientAcks.some(message => message.commandId === firedCommand.id),
          postSyncPersisted: targetGate.savedAcks.some(message => message.commandId === firedCommand.id),
          pageErrors: caseErrors
        }, {
          clockWasHeld: true,
          preSyncAckCount: 0,
          preSyncGreenCount: 0,
          postSyncAck: true,
          postSyncPersisted: true,
          pageErrors: []
        }, 'a reconnect may not reuse stale sync state to claim delivery');
      } finally {
        await closeContexts(contexts);
      }
    });

    await runRegressionCase('delivery ACK retries beyond 12 seconds on the same open socket', core11Failures, async () => {
      const contexts = [];
      const caseErrors = [];
      try {
        const targetProfile = profile('971000001', 'Long Hold Captain');
        const peerProfile = profile('971000002', 'Long Hold Peer');
        await seedRoom(browser, longAckHoldRoom, [targetProfile, peerProfile]);
        const targetGate = packetGate({ holdClientAcks: true });
        const target = await openClient(browser, {
          room: longAckHoldRoom,
          label: 'long-hold-captain',
          ownProfile: targetProfile,
          gate: targetGate,
          errors: caseErrors
        });
        const peer = await openClient(browser, {
          room: longAckHoldRoom,
          label: 'long-hold-peer',
          ownProfile: peerProfile,
          gate: packetGate(),
          errors: caseErrors
        });
        const commander = await openClient(browser, {
          room: longAckHoldRoom,
          label: 'long-hold-commander',
          gate: packetGate(),
          errors: caseErrors
        });
        contexts.push(target.context, peer.context, commander.context);
        await unlockCommander(commander.page);
        await delay(300);
        await selectAndFire(commander.page, targetProfile.pid, peerProfile.pid);
        await waitUntil(() => targetGate.clientAcks.length >= 1, 'first held delivery ACK');
        const holdStartedAt = Date.now();
        await delay(12_250);
        const socketBeforeRelease = await target.page.evaluate(() => ({
          count: window.__qaRoomSockets.length,
          open: window.__qaRoomSockets.filter(socket => socket.readyState === WebSocket.OPEN).length
        }));
        const heldAckCount = targetGate.clientAcks.length;
        const greenBeforeRelease = await commander.page.locator(`#pickSlots .slot[data-pid="${targetProfile.pid}"] .delivery.received`).count();
        targetGate.holdClientAcks = false;
        await waitUntil(() => targetGate.savedAcks.length >= 1, 'delivery ACK retry after 12-second hold release', 9_000);
        await commander.page.locator(`#pickSlots .slot[data-pid="${targetProfile.pid}"] .delivery.received`).waitFor({ timeout: 7_000 });
        const socketAfterPersistence = await target.page.evaluate(() => ({
          count: window.__qaRoomSockets.length,
          open: window.__qaRoomSockets.filter(socket => socket.readyState === WebSocket.OPEN).length
        }));
        const snapshot = await readSnapshot(commander.page, longAckHoldRoom);
        const command = Object.values(snapshot.room.live.commands).find(Boolean);
        const delivery = command.delivery.find(value => value.pid === targetProfile.pid);
        assert.deepEqual({
          heldForMoreThan12Seconds: Date.now() - holdStartedAt > 12_000,
          heldAckCountAtRelease: heldAckCount >= 1,
          retriedAfterRelease: targetGate.clientAcks.length > heldAckCount,
          greenBeforeRelease,
          socketBeforeRelease,
          socketAfterPersistence,
          received: delivery.received,
          pageErrors: caseErrors
        }, {
          heldForMoreThan12Seconds: true,
          heldAckCountAtRelease: true,
          retriedAfterRelease: true,
          greenBeforeRelease: 0,
          socketBeforeRelease: { count: 1, open: 1 },
          socketAfterPersistence: { count: 1, open: 1 },
          received: 1,
          pageErrors: []
        }, 'ACK delivery must recover without a reconnect after a long same-socket outage');
      } finally {
        await closeContexts(contexts);
      }
    });

    await runRegressionCase('late selected-captain reconnect persists exact expired outcome', core11Failures, async () => {
      const contexts = [];
      const caseErrors = [];
      try {
        const targetProfile = profile('972000001', 'Expired Captain');
        const peerProfile = profile('972000002', 'Expired Peer');
        await seedRoom(browser, expiredReconnectRoom, [targetProfile, peerProfile]);
        const targetGate = packetGate();
        const target = await openClient(browser, {
          room: expiredReconnectRoom,
          label: 'expired-captain-initial',
          ownProfile: targetProfile,
          gate: targetGate,
          errors: caseErrors
        });
        const peer = await openClient(browser, {
          room: expiredReconnectRoom,
          label: 'expired-peer',
          ownProfile: peerProfile,
          gate: packetGate(),
          errors: caseErrors
        });
        const commander = await openClient(browser, {
          room: expiredReconnectRoom,
          label: 'expired-commander',
          gate: packetGate(),
          errors: caseErrors
        });
        contexts.push(target.context, peer.context, commander.context);
        await unlockCommander(commander.page);
        await delay(300);
        for (const pid of [targetProfile.pid, peerProfile.pid]) {
          await commander.page.locator(`#roster .rp[data-pid="${pid}"]`).click();
          await commander.page.waitForFunction(value => {
            const row = document.querySelector(`#roster .rp[data-pid="${value}"]`);
            return row && row.getAttribute('aria-pressed') === 'true';
          }, pid);
        }
        await waitUntil(async () => {
          const snapshot = await readSnapshot(commander.page, expiredReconnectRoom);
          const staged = snapshot.room.live.staged['1'];
          return staged && staged.pairs && staged.pairs.length === 2;
        }, 'two canonical staged captains before disconnect');
        await target.page.close();
        await delay(200);
        await commander.page.locator('#lead button[data-v="10"]').click();
        await commander.page.locator('#fireDouble').click();
        await commander.page.waitForTimeout(180);
        await commander.page.locator('#fireDouble').click();
        await commander.page.locator('#pickSlots.frozen').waitFor({ state: 'visible', timeout: 7_000 });

        const firedSnapshot = await readSnapshot(commander.page, expiredReconnectRoom);
        const firedCommand = Object.values(firedSnapshot.room.live.commands).find(Boolean);
        const targetPair = firedCommand.payload.pairs.find(pair => pair.pid === targetProfile.pid);
        assert.equal(targetGate.clientAcks.length, 0, 'disconnected captain cannot ACK before the personal target');
        const reconnectDelay = Math.max(0, targetPair.pressUTC * 1000 - Date.now() + 1_200);
        assert.ok(reconnectDelay < 13_000, '10-second QA target keeps the late-reconnect test bounded');
        await delay(reconnectDelay);
        await openClientPageInContext(target.context, expiredReconnectRoom, 'expired-captain-late', targetProfile, caseErrors);
        await waitUntil(() => targetGate.savedAcks.some(message => message.commandId === firedCommand.id), 'late expired ACK persistence', 7_000);
        await commander.page.locator(`#pickSlots .slot[data-pid="${targetProfile.pid}"] .delivery.expired`).waitFor({ timeout: 7_000 });

        const expiredAck = targetGate.clientAcks.find(message => message.commandId === firedCommand.id);
        const persistedAck = targetGate.savedAcks.find(message => message.commandId === firedCommand.id);
        const finalSnapshot = await readSnapshot(commander.page, expiredReconnectRoom);
        const stillLive = Object.values(finalSnapshot.room.live.commands).find(command => command && command.id === firedCommand.id);
        const delivery = stillLive.delivery.find(value => value.pid === targetProfile.pid);
        assert.deepEqual({
          clientOutcome: expiredAck && expiredAck.outcome,
          clientTargetUTC: expiredAck && expiredAck.targetUTC,
          clientWasLate: expiredAck && expiredAck.scheduledAtMs >= targetPair.pressUTC * 1000,
          persistedOutcome: persistedAck && persistedAck.outcome,
          persistedTargetUTC: persistedAck && persistedAck.targetUTC,
          commandStillLive: Boolean(stillLive),
          received: delivery.received,
          expired: delivery.expired,
          pageErrors: caseErrors
        }, {
          clientOutcome: 'expired',
          clientTargetUTC: targetPair.pressUTC,
          clientWasLate: true,
          persistedOutcome: 'expired',
          persistedTargetUTC: targetPair.pressUTC,
          commandStillLive: true,
          received: 0,
          expired: 1,
          pageErrors: []
        }, 'a late reconnect must report Expired rather than Received or silence');
      } finally {
        await closeContexts(contexts);
      }
    });

    const commanderProfile = profile('930000004', 'Commander Observer');
    const captainAProfile = profile('930000001', 'Captain Persisted');
    const captainBProfile = profile('930000002', 'Captain Retry');
    const joinerProfile = profile('930000003', 'Ordinary Member');
    await seedRoom(browser, mainRoom, [commanderProfile, captainAProfile, captainBProfile, joinerProfile]);

    const commanderGate = packetGate();
    const captainAGate = packetGate({ dropFirstSavedAck: true });
    const captainBGate = packetGate({ dropFirstClientAck: true });
    const joinerGate = packetGate();
    const commander = await openClient(browser, { room: mainRoom, label: 'commander', ownProfile: commanderProfile, gate: commanderGate, errors });
    const captainA = await openClient(browser, { room: mainRoom, label: 'captain-a', ownProfile: captainAProfile, gate: captainAGate, errors });
    const captainB = await openClient(browser, { room: mainRoom, label: 'captain-b', ownProfile: captainBProfile, gate: captainBGate, errors });
    const joiner = await openClient(browser, { room: mainRoom, label: 'joiner', ownProfile: joinerProfile, gate: joinerGate, errors });
    openContexts.push(commander.context, captainA.context, captainB.context, joiner.context);

    await unlockCommander(commander.page);
    await delay(500);
    await selectAndFire(commander.page, captainAProfile.pid, captainBProfile.pid);

    await waitUntil(() => captainAGate.clientAcks.length >= 2 && captainAGate.savedAcks.length >= 2, 'persisted-ACK retry after first deliveryAckSaved is dropped');
    await waitUntil(() => captainBGate.clientAcks.length >= 2 && captainBGate.savedAcks.length >= 1, 'client ACK retry after first deliveryAck is dropped');
    await commander.page.locator(`#pickSlots .slot[data-pid="${captainAProfile.pid}"] .delivery.received`).waitFor({ timeout: 8_000 });
    await commander.page.locator(`#pickSlots .slot[data-pid="${captainBProfile.pid}"] .delivery.received`).waitFor({ timeout: 8_000 });

    const captainACues = await captainA.page.evaluate(() => Object.keys(window.__cues || {}));
    const captainBCues = await captainB.page.evaluate(() => Object.keys(window.__cues || {}));
    const commanderCues = await commander.page.evaluate(() => Object.keys(window.__cues || {}));
    const joinerCues = await joiner.page.evaluate(() => Object.keys(window.__cues || {}));
    assert.ok(captainACues.some(key => key.includes('-me:')), 'selected captain A schedules personal countdown cues');
    assert.ok(captainBCues.some(key => key.includes('-me:')), 'selected captain B schedules personal countdown cues');
    assert.ok(!captainACues.some(key => key.includes('-join:')), 'selected captain A never schedules JOIN cues');
    assert.ok(!captainBCues.some(key => key.includes('-join:')), 'selected captain B never schedules JOIN cues');
    assert.ok(!commanderCues.some(key => /-(?:me|join):/.test(key)), 'registered unselected commander remains silent');
    assert.ok(joinerCues.some(key => key.includes('-join:')), 'ordinary member schedules the generic JOIN countdown');
    assert.equal(commanderGate.clientAcks.length, 0, 'unselected commander never sends a delivery ACK');
    assert.equal(joinerGate.clientAcks.length, 0, 'ordinary member never sends a delivery ACK');

    assert.equal(captainAGate.clientAcks.length, 2, 'lost deliveryAckSaved causes exactly one client retry');
    assert.equal(captainAGate.savedAcks.length, 2, 'server returns deliveryAckSaved for the original and idempotent retry');
    assert.deepEqual(captainAGate.clientAcks[1], captainAGate.clientAcks[0], 'persisted-ACK retry keeps the immutable ACK payload');
    assert.equal(captainBGate.clientAcks.length, 2, 'lost first client ACK causes exactly one retry');
    assert.deepEqual(captainBGate.clientAcks[1], captainBGate.clientAcks[0], 'client retry keeps the immutable ACK payload');

    const stableCounts = {
      captainAClient: captainAGate.clientAcks.length,
      captainAServer: captainAGate.savedAcks.length,
      captainBClient: captainBGate.clientAcks.length,
      captainBServer: captainBGate.savedAcks.length
    };
    await delay(2_700);
    assert.deepEqual({
      captainAClient: captainAGate.clientAcks.length,
      captainAServer: captainAGate.savedAcks.length,
      captainBClient: captainBGate.clientAcks.length,
      captainBServer: captainBGate.savedAcks.length
    }, stableCounts, 'clients stop retrying after the exact persisted deliveryAckSaved arrives');

    const snapshot = await readSnapshot(commander.page, mainRoom);
    const liveCommand = Object.values(snapshot.room.live.commands).find(Boolean);
    assert.ok(liveCommand, 'fired command remains live in the QA room');
    const deliveryA = liveCommand.delivery.find(value => value.pid === captainAProfile.pid);
    const deliveryB = liveCommand.delivery.find(value => value.pid === captainBProfile.pid);
    assert.equal(deliveryA.received, 1, 'idempotent server retry never double-counts captain A');
    assert.equal(deliveryB.received, 1, 'dropped client packet produces one persisted captain B receipt');
    assert.equal(snapshot.room.live.staged['1'], null, 'rapid staging followed by Fire cannot resurrect a stale staged selection');
    assert.equal(await commander.page.locator('#pickSlots .slot.frozen').count(), 2, 'Fire keeps both frozen captain slots visible');
    assert.equal(await commander.page.locator('#pickSlots .sx').count(), 0, 'frozen slots expose no remove control');
    assert.equal(await commander.page.locator('#pickSlots #swapRoles').count(), 0, 'frozen slots expose no swap control');

    const legacy = await openLegacyCommander(browser, mainRoom, commanderProfile, errors);
    openContexts.push(legacy.context);
    assert.equal(await legacy.page.locator('#pickSlots .slot.frozen').count(), 2, 'legacy snapshot keeps both frozen slots visible');
    assert.equal(await legacy.page.locator('#pickSlots .delivery').count(), 0, 'legacy snapshot omits delivery status badges without crashing');
    assert.equal(await legacy.page.locator('#pickSlots .sx').count(), 0, 'legacy snapshot remains read-only without remove controls');
    assert.equal(await legacy.page.locator('#pickSlots #swapRoles').count(), 0, 'legacy snapshot remains read-only without swap controls');
    assert.deepEqual(errors, [], 'main Classic delivery scenario has no page errors');

    for (const context of openContexts.splice(0)) await context.close();

    const mutedProfile = profile('940000001', 'No Audio Captain');
    const healthyProfile = profile('940000002', 'Healthy Captain');
    await seedRoom(browser, noAudioRoom, [mutedProfile, healthyProfile]);
    const mutedGate = packetGate();
    const healthyGate = packetGate();
    const noAudioCommander = await openClient(browser, { room: noAudioRoom, label: 'no-audio-commander', gate: packetGate(), errors });
    const mutedCaptain = await openClient(browser, { room: noAudioRoom, label: 'no-audio-captain', ownProfile: mutedProfile, noAudio: true, gate: mutedGate, errors });
    const healthyCaptain = await openClient(browser, { room: noAudioRoom, label: 'healthy-captain', ownProfile: healthyProfile, gate: healthyGate, errors });
    openContexts.push(noAudioCommander.context, mutedCaptain.context, healthyCaptain.context);

    await unlockCommander(noAudioCommander.page);
    await delay(500);
    await selectAndFire(noAudioCommander.page, mutedProfile.pid, healthyProfile.pid);
    await noAudioCommander.page.locator(`#pickSlots .slot[data-pid="${healthyProfile.pid}"] .delivery.received`).waitFor({ timeout: 8_000 });
    await noAudioCommander.page.locator(`#pickSlots .slot[data-pid="${mutedProfile.pid}"] .delivery.missing`).waitFor({ timeout: 8_000 });

    const mutedCues = await mutedCaptain.page.evaluate(() => Object.keys(window.__cues || {}));
    const healthyCues = await healthyCaptain.page.evaluate(() => Object.keys(window.__cues || {}));
    assert.ok(!mutedCues.some(key => key.includes('-me:')), 'unschedulable AudioContext creates no personal cue');
    assert.equal(mutedGate.clientAcks.length, 0, 'unschedulable AudioContext never sends a delivery ACK');
    assert.equal(await noAudioCommander.page.locator(`#pickSlots .slot[data-pid="${mutedProfile.pid}"] .delivery.received`).count(), 0, 'unschedulable AudioContext never turns the commander status green');
    assert.match(await noAudioCommander.page.locator(`#pickSlots .slot[data-pid="${mutedProfile.pid}"] .delivery.missing`).textContent(), /No confirmation/i);
    assert.ok(healthyCues.some(key => key.includes('-me:')), 'healthy peer still schedules its personal countdown');
    assert.ok(healthyGate.clientAcks.length >= 1, 'healthy peer still sends its delivery ACK');

    const noAudioSnapshot = await readSnapshot(noAudioCommander.page, noAudioRoom);
    const noAudioCommand = Object.values(noAudioSnapshot.room.live.commands).find(Boolean);
    const mutedDelivery = noAudioCommand.delivery.find(value => value.pid === mutedProfile.pid);
    const healthyDelivery = noAudioCommand.delivery.find(value => value.pid === healthyProfile.pid);
    assert.equal(mutedDelivery.expected, 0, 'server does not expect delivery from a red/no-audio device');
    assert.equal(mutedDelivery.received, 0, 'server records no false receipt from a red/no-audio device');
    assert.equal(healthyDelivery.received, 1, 'healthy device remains independently confirmed');
    assert.deepEqual(errors, [], 'all Classic delivery browser scenarios have no page errors');

    for (const context of openContexts.splice(0)) await context.close();

    const returningProfile = profile('950000001', 'Returning Captain');
    const returningPeerProfile = profile('950000002', 'Returning Peer');
    const emptySnapshot = await readHttpSnapshot(returningRoom);
    assert.deepEqual(Object.keys(emptySnapshot.room.players), [], 'returning-profile QA room starts with an empty canonical roster');
    await seedRoom(browser, returningRoom, [returningProfile]);
    const returningStartedAt = Date.now();
    const returningGate = packetGate({ holdClientAcks: true });
    const returningCaptain = await openClient(browser, {
      room: returningRoom,
      label: 'returning-captain',
      ownProfile: returningProfile,
      gate: returningGate,
      errors
    });
    openContexts.push(returningCaptain.context);
    assert.match(await returningCaptain.page.locator('#youName').textContent(), /Returning Captain/, 'stored profile binds to its existing canonical player');

    await seedRoom(browser, returningRoom, [returningPeerProfile]);
    const returningPeer = await openClient(browser, {
      room: returningRoom,
      label: 'returning-peer',
      ownProfile: returningPeerProfile,
      gate: packetGate(),
      errors
    });
    const returningCommander = await openClient(browser, {
      room: returningRoom,
      label: 'returning-commander',
      gate: packetGate(),
      errors
    });
    openContexts.push(returningPeer.context, returningCommander.context);
    await unlockCommander(returningCommander.page);
    await selectAndFire(returningCommander.page, returningProfile.pid, returningPeerProfile.pid);
    await waitUntil(() => returningGate.clientAcks.length >= 1, 'returning captain first delivery ACK');

    const preAckSnapshot = await readSnapshot(returningCommander.page, returningRoom);
    const preAckCommand = Object.values(preAckSnapshot.room.live.commands).find(Boolean);
    const preAckDelivery = preAckCommand.delivery.find(value => value.pid === returningProfile.pid);
    assert.equal(preAckDelivery.expected, 1, 'returning canonical identity publishes the ready device before immediate Fire');
    assert.equal(preAckDelivery.received, 0, 'held ACK proves expected=1 came from pre-Fire device registration, not ACK backfill');
    assert.equal(returningGate.heartbeats.length, 0, 'returning captain needed no 25-second heartbeat before being counted');

    returningGate.holdClientAcks = false;
    await waitUntil(() => returningGate.savedAcks.length >= 1, 'returning captain persisted delivery ACK');
    await returningCommander.page.locator(`#pickSlots .slot[data-pid="${returningProfile.pid}"] .delivery.received`).waitFor({ timeout: 8_000 });
    const returningSnapshot = await readSnapshot(returningCommander.page, returningRoom);
    const returningCommand = Object.values(returningSnapshot.room.live.commands).find(Boolean);
    const returningDelivery = returningCommand.delivery.find(value => value.pid === returningProfile.pid);
    assert.equal(returningDelivery.expected, 1, 'returning captain keeps one expected device');
    assert.equal(returningDelivery.received, 1, 'returning captain reaches one persisted receipt');
    assert.ok(returningGate.clientAcks.length >= 2, 'held first ACK retries without waiting for heartbeat');
    assert.ok(Date.now() - returningStartedAt < 20_000, 'returning-profile path completes before the 25-second heartbeat interval');
    assert.deepEqual(errors, [], 'returning-profile browser scenario has no page errors');

    for (const context of openContexts.splice(0)) await context.close();

    const raceCaptainAProfile = profile('960000001', 'Race Captain A');
    const raceCaptainBProfile = profile('960000002', 'Race Captain B');
    await seedRoom(browser, stageRaceRoom, [raceCaptainAProfile, raceCaptainBProfile]);
    const raceCaptainAGate = packetGate();
    const raceCaptainBGate = packetGate();
    const raceCaptainA = await openClient(browser, {
      room: stageRaceRoom,
      label: 'stage-race-captain-a',
      ownProfile: raceCaptainAProfile,
      gate: raceCaptainAGate,
      errors
    });
    const raceCaptainB = await openClient(browser, {
      room: stageRaceRoom,
      label: 'stage-race-captain-b',
      ownProfile: raceCaptainBProfile,
      gate: raceCaptainBGate,
      errors
    });
    const raceGate = stageRaceGate(raceCaptainAProfile.pid);
    const raceCommander = await openStageRaceCommander(browser, stageRaceRoom, raceGate, errors);
    openContexts.push(raceCaptainA.context, raceCaptainB.context, raceCommander.context);
    await unlockCommander(raceCommander.page);
    await delay(300);

    await raceCommander.page.locator(`#roster .rp[data-pid="${raceCaptainAProfile.pid}"]`).click();
    await waitUntil(() => raceGate.clientStages.length === 1, 'first pending stage mutation');
    await waitUntil(() => raceGate.heldStates.length >= 1, 'delayed one-captain staged snapshot');
    await raceCommander.page.locator(`#roster .rp[data-pid="${raceCaptainBProfile.pid}"]`).click();
    await raceCommander.page.waitForFunction(pid => {
      const row = document.querySelector(`#roster .rp[data-pid="${pid}"]`);
      return row && row.getAttribute('aria-pressed') === 'true';
    }, raceCaptainBProfile.pid);
    assert.equal(raceGate.clientStages.length, 1, 'B selection remains queued while A stage mutation is pending');
    await raceCommander.page.locator('#lead button[data-v="30"]').click();
    assert.equal(await raceCommander.page.locator('#fireDouble').isDisabled(), false, 'queued A+B pair can immediately Fire');
    await raceCommander.page.locator('#fireDouble').click();
    await raceCommander.page.waitForTimeout(100);
    await raceCommander.page.locator('#fireDouble').click();
    await waitUntil(() => raceGate.clientCommands.length === 1, 'quick double-tap Fire command');
    await waitUntil(() => raceGate.commandStateHeld, 'live command snapshot queued behind the delayed stage snapshot');
    await waitUntil(() => raceCaptainAGate.savedAcks.length >= 1 && raceCaptainBGate.savedAcks.length >= 1, 'race captains delivery receipts');

    raceGate.releaseHeld();
    await delay(1_200);
    const stageRaceSnapshot = await readSnapshot(raceCommander.page, stageRaceRoom);
    const stageRaceCommand = stageRaceSnapshot.room.live.commands['1'];
    const stageRaceUI = await raceCommander.page.evaluate(() => ({
      frozenPairPids: Array.from(document.querySelectorAll('#pickSlots .slot.frozen[data-pid]')).map(node => node.dataset.pid),
      removeControls: document.querySelectorAll('#pickSlots .sx').length,
      swapControls: document.querySelectorAll('#pickSlots #swapRoles').length,
      deliveryVisible: document.querySelectorAll('#pickSlots .delivery').length > 0
    }));
    assert.deepEqual({
      staged: stageRaceSnapshot.room.live.staged['1'],
      firedPairPids: stageRaceCommand.payload.pairs.map(pair => pair.pid),
      frozenPairPids: stageRaceUI.frozenPairPids,
      removeControls: stageRaceUI.removeControls,
      swapControls: stageRaceUI.swapControls,
      deliveryVisible: stageRaceUI.deliveryVisible,
      clientStagePackets: raceGate.clientStages.length
    }, {
      staged: null,
      firedPairPids: [raceCaptainAProfile.pid, raceCaptainBProfile.pid],
      frozenPairPids: [raceCaptainAProfile.pid, raceCaptainBProfile.pid],
      removeControls: 0,
      swapControls: 0,
      deliveryVisible: true,
      clientStagePackets: 1
    }, 'a delayed stage snapshot cannot resurrect staged state after Fire');
    assert.deepEqual(errors, [], 'stage-race browser scenario has no page errors');

    const secondManagerGate = packetGate();
    const secondManager = await openClient(browser, {
      room: stageRaceRoom,
      label: 'stage-after-live-manager',
      gate: secondManagerGate,
      errors
    });
    openContexts.push(secondManager.context);
    await unlockCommander(secondManager.page);
    await secondManager.page.locator(`#roster .rp[data-pid="${raceCaptainAProfile.pid}"]`).click();
    await waitUntil(() => secondManagerGate.clientStages.length === 1, 'second manager stage-after-live request');
    await waitUntil(() => secondManagerGate.stageSuperseded.length === 1, 'server stage-after-live rejection');
    const stageAfterLiveSnapshot = await readSnapshot(secondManager.page, stageRaceRoom);
    assert.equal(stageAfterLiveSnapshot.room.live.staged['1'], null, 'a second manager cannot create staged picks after that kingdom has a live command');
    assert.deepEqual(errors, [], 'second-manager stage-after-live check has no page errors');

    console.log('✓ selected captains schedule personal cues and frozen slots reach Received');
    console.log('✓ unselected commander stays silent; ordinary member receives JOIN only');
    console.log('✓ lost client/server ACK packets retry idempotently and stop after persistence confirmation');
    console.log('✓ fired slots are read-only and old snapshots without delivery remain compatible');
    console.log('✓ an unschedulable AudioContext never produces a green delivery status');
    console.log('✓ returning profile binds existing canonical player and reaches expected=1 + Received before heartbeat');
    console.log('✓ delayed stage snapshots cannot resurrect editable picks after Fire');
    if (core11Failures.length > 0) {
      throw new AggregateError(
        core11Failures.map(result => result.error),
        core11Failures.map(result => `${result.name}: ${result.error.message}`).join('\n')
      );
    }
  } finally {
    for (const context of openContexts.splice(0)) {
      try { await context.close(); } catch (_) {}
    }
    await browser.close();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
