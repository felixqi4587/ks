import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOM = 'qa';
const PASSWORD = 'qa';
const ORDINARY_STATE_LIMIT = 8 * 1024;
const PERSONAL_ORDER_LIMIT = 4 * 1024;
const DELTA_LIMIT = 2 * 1024;
const MANAGER_STATE_LIMIT = 96 * 1024;

async function waitUntil(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function uuid(namespace, index) {
  return `${namespace}0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function profile(index) {
  return {
    pid: `defender-${String(index).padStart(3, '0')}`,
    profileKey: uuid('0', index),
    deviceId: uuid('1', index),
    march: 5 + (index % 116),
    name: `Defender ${String(index).padStart(3, '0')}`
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForWorker(baseURL, child, logs) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited before readiness (${child.exitCode})\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseURL}/api/time`, { cache: 'no-store' });
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for local Wrangler\n${logs.join('')}`);
}

async function startWorker() {
  const port = await freePort();
  const persistRoot = await mkdtemp(path.join(os.tmpdir(), 'kingshoter-defense-load-'));
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(command, [
    'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--persist-to', path.join(persistRoot, 'wrangler-state'), '--log-level', 'error'
  ], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  const capture = chunk => {
    logs.push(String(chunk));
    if (logs.length > 80) logs.splice(0, logs.length - 80);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const baseURL = `http://127.0.0.1:${port}`;
  await waitForWorker(baseURL, child, logs);
  return {
    baseURL,
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise(resolve => child.once('exit', resolve)),
          new Promise(resolve => setTimeout(resolve, 5_000))
        ]);
      }
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(persistRoot, { recursive: true, force: true });
    }
  };
}

class SocketProbe {
  constructor(url, label) {
    this.url = url;
    this.label = label;
    this.frames = [];
    this.waiters = new Set();
    this.socket = null;
  }

  async open() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener('message', event => {
      const raw = String(event.data);
      let value;
      try { value = JSON.parse(raw); } catch (_) { return; }
      this.frames.push({ value, bytes: Buffer.byteLength(raw, 'utf8'), atMs: Date.now() });
      for (const waiter of [...this.waiters]) waiter();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: open timeout`)), 15_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${this.label}: WebSocket open failed`));
      }, { once: true });
    });
    return this;
  }

  send(value) {
    assert.equal(this.socket.readyState, WebSocket.OPEN, `${this.label}: socket must be open`);
    this.socket.send(JSON.stringify(value));
  }

  clear() {
    this.frames.length = 0;
  }

  values(type) {
    return this.frames.filter(frame => !type || frame.value.t === type).map(frame => frame.value);
  }

  async waitFor(predicate, timeoutMs = 15_000) {
    const existing = this.frames.find(frame => predicate(frame.value));
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      let timer;
      const check = () => {
        const found = this.frames.find(frame => predicate(frame.value));
        if (!found) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(found);
      };
      timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`${this.label}: frame timeout; received ${this.frames.map(frame => frame.value.t).join(', ')}`));
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  async close() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => this.socket.addEventListener('close', resolve, { once: true }));
    this.socket.close();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3_000))]);
  }
}

function socketURL(baseURL, surface) {
  const url = new URL('/api/ws', baseURL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('room', ROOM);
  url.searchParams.set('surface', surface);
  url.searchParams.set('clientBuild', '2026071701');
  return url.toString();
}

async function openProbe(baseURL, surface, label) {
  return new SocketProbe(socketURL(baseURL, surface), label).open();
}

async function register(probe, value, registrationId) {
  probe.send({
    t: 'registerPlayer', registrationId, profileKey: value.profileKey,
    pid: value.pid, identityMode: 'nickname', name: value.name, march: value.march
  });
  await probe.waitFor(message =>
    message.t === 'defenseProfileDelta' && message.registrationId === registrationId
  );
  const state = await probe.waitFor(message =>
    message.t === 'defenseState' && message.ownProfile && message.ownProfile.pid === value.pid
  );
  return state.value;
}

async function setReady(probe, value) {
  probe.send({
    t: 'defenseDeviceStatus', pid: value.pid, deviceId: value.deviceId,
    soundReady: true, clockFresh: true
  });
  const saved = await probe.waitFor(message =>
    message.t === 'defenseDeviceStatusSaved' && message.pid === value.pid &&
    message.deviceId === value.deviceId
  );
  assert.ok(saved.bytes <= DELTA_LIMIT, `${probe.label}: readiness receipt exceeds 2 KiB`);
}

async function run() {
  const worker = await startWorker();
  const sockets = [];
  try {
    const rally = await Promise.all([
      openProbe(worker.baseURL, 'rally', 'rally-1'),
      openProbe(worker.baseURL, 'rally', 'rally-2')
    ]);
    sockets.push(...rally);
    for (const probe of rally) {
      const state = await probe.waitFor(message => message.t === 'state');
      assert.equal(Object.hasOwn(state.value.room || {}, 'defense'), false);
    }

    const allProfiles = Array.from({ length: 150 }, (_, index) => profile(index));
    const firstHundred = await Promise.all(allProfiles.slice(0, 100).map((_, index) =>
      openProbe(worker.baseURL, 'defense', `defender-${index}`)
    ));
    sockets.push(...firstHundred);
    for (const probe of firstHundred) {
      const initial = await probe.waitFor(message => message.t === 'defenseState');
      assert.ok(initial.bytes <= ORDINARY_STATE_LIMIT, `${probe.label}: ordinary state exceeds 8 KiB`);
      assert.equal(Object.hasOwn(initial.value, 'rallyRoom'), false);
      assert.equal(Object.hasOwn(initial.value, 'rallyModes'), false);
    }
    await Promise.all(firstHundred.map((probe, index) =>
      register(probe, allProfiles[index], `register-${index}`)
    ));

    await Promise.all(firstHundred.slice(0, 50).map(probe => probe.close()));
    const replacements = await Promise.all(allProfiles.slice(100).map((_, offset) =>
      openProbe(worker.baseURL, 'defense', `defender-${100 + offset}`)
    ));
    sockets.push(...replacements);
    await Promise.all(replacements.map((probe, offset) =>
      register(probe, allProfiles[100 + offset], `register-${100 + offset}`)
    ));

    let active = firstHundred.slice(50).map((probe, offset) => ({
      probe, profile: allProfiles[50 + offset]
    })).concat(replacements.map((probe, offset) => ({
      probe, profile: allProfiles[100 + offset]
    })));
    assert.equal(active.length, 100);
    await Promise.all(active.map(({ probe, profile: value }) => setReady(probe, value)));

    const managers = await Promise.all([
      openProbe(worker.baseURL, 'defense', 'manager-1'),
      openProbe(worker.baseURL, 'defense', 'manager-2')
    ]);
    sockets.push(...managers);
    for (const manager of managers) {
      manager.send({ t: 'defenseUnlock', password: PASSWORD });
      const state = await manager.waitFor(message => message.t === 'defenseManagerState');
      assert.equal(state.value.counts.registeredProfiles, 150);
      assert.equal(state.value.counts.connectedProfiles, 100);
      assert.ok(state.bytes <= MANAGER_STATE_LIMIT, `${manager.label}: 150-profile manager state exceeds 96 KiB`);
      assert.equal(Object.hasOwn(state.value, 'rallyRoom'), false);
      assert.equal(Object.hasOwn(state.value, 'rallyModes'), false);
    }

    const nowMs = Date.now();
    await Promise.all(managers.map((manager, index) => {
      manager.send({
        t: 'defenseManagerStatus', deviceId: uuid('2', index), clockFresh: true,
        clockSampleAtMs: nowMs, clockOffsetMs: 0
      });
      return manager.waitFor(message => message.t === 'defenseManagerStatusSaved' && message.managerClockFresh === true);
    }));
    managers[0].send({
      t: 'setDefenseConfig', password: PASSWORD, mutationId: 'load-config',
      baseRevision: 0, tapAnchorSeconds: 60, enemyMarchSeconds: 120
    });
    await managers[0].waitFor(message =>
      message.t === 'defenseConfigSaved' && message.mutationId === 'load-config' && message.revision === 1
    );
    await Promise.all(active.map(({ probe }) => probe.waitFor(message =>
      message.t === 'defenseState' && message.config && message.config.revision === 1
    )));
    await Promise.all(managers.map(manager => manager.waitFor(message =>
      message.t === 'defenseManagerState' && message.config && message.config.revision === 1
    )));

    for (const probe of [...rally, ...active.map(entry => entry.probe), ...managers]) probe.clear();
    const signalAtMs = Date.now();
    managers[0].send({
      t: 'fireDefense', password: PASSWORD, mutationId: 'load-fire-a',
      configRevision: 1, signalAtMs
    });
    managers[1].send({
      t: 'fireDefense', password: PASSWORD, mutationId: 'load-fire-b',
      configRevision: 1, signalAtMs
    });

    await Promise.all(active.map(({ probe }) =>
      probe.waitFor(message => message.t === 'defenseOrderAccepted')
    ));
    await Promise.all(managers.map(manager =>
      manager.waitFor(message => message.t === 'defenseOrderAccepted')
    ));
    await waitUntil(
      () => managers.flatMap(manager => manager.values('error'))
        .filter(message => message.error === 'order_active').length === 1,
      'concurrent fire loser did not receive order_active'
    );
    const concurrentErrors = managers.flatMap(manager => manager.values('error'))
      .filter(message => message.error === 'order_active');
    assert.equal(concurrentErrors.length, 1, 'two concurrent fire mutations must create one accepted order');

    const managerOrder = managers[0].values('defenseOrderAccepted')[0].order;
    assert.equal(managerOrder.revision, 1);
    assert.equal(managerOrder.counts.targetedProfiles, 100);
    assert.equal(managerOrder.counts.registeredAtAcceptance, 150);
    for (const { probe } of active) {
      const accepted = probe.frames.filter(frame => frame.value.t === 'defenseOrderAccepted');
      assert.equal(accepted.length, 1, `${probe.label}: exactly one accepted-order frame`);
      assert.ok(accepted[0].bytes <= PERSONAL_ORDER_LIMIT, `${probe.label}: personal accepted frame exceeds 4 KiB`);
    }
    for (const probe of rally) {
      assert.equal(probe.frames.length, 0, `${probe.label}: Defense frames crossed into Rally`);
    }

    for (let index = 0; index < 20; index += 1) {
      const previous = active[index];
      await previous.probe.close();
      const replacement = await openProbe(worker.baseURL, 'defense', `reconnect-${index}`);
      sockets.push(replacement);
      await register(replacement, previous.profile, `reconnect-${index}`);
      const restored = replacement.values('defenseState')
        .find(message => message.activeOrderForOwnProfile && message.activeOrderForOwnProfile.revision === 1);
      assert.ok(restored, `${replacement.label}: future personal order must restore after reconnect`);
      assert.equal(replacement.values('defenseOrderAccepted').length, 0,
        `${replacement.label}: reconnect must not duplicate the accepted-order cue`);
      await setReady(replacement, previous.profile);
      active[index] = { probe: replacement, profile: previous.profile };
    }

    const acceptedByPid = new Map(active.map(({ probe }) => {
      const order = probe.values('defenseState')
        .find(message => message.activeOrderForOwnProfile)?.activeOrderForOwnProfile ||
        probe.values('defenseOrderAccepted')[0]?.order;
      return [order.pid, order];
    }));
    for (const { probe, profile: value } of active) {
      const order = acceptedByPid.get(value.pid);
      assert.ok(order, `${probe.label}: missing personal order for ACK`);
      probe.clear();
      probe.send({
        t: 'defenseOrderAck', orderId: order.id, orderRevision: order.revision,
        pid: value.pid, deviceId: value.deviceId, goAtMs: order.goAtMs,
        outcome: 'scheduled', audioReady: true, clockFresh: true
      });
    }
    await Promise.all(active.map(({ probe, profile: value }) =>
      probe.waitFor(message => message.t === 'defenseAckSaved' && message.pid === value.pid)
    ));
    await Promise.all(managers.map(manager => waitUntil(
      () => manager.values('defenseAckSaved').length === 100,
      `${manager.label}: ACK delivery did not converge`
    )));
    for (const { probe } of active) {
      const ack = probe.frames.find(frame => frame.value.t === 'defenseAckSaved');
      assert.ok(ack.bytes <= DELTA_LIMIT, `${probe.label}: ACK delta exceeds 2 KiB`);
      assert.equal(probe.values('defenseState').length, 0, `${probe.label}: ACK amplified into a full state`);
    }

    for (const probe of [...active.map(entry => entry.probe), ...managers, ...rally]) probe.clear();
    for (const { probe, profile: value } of active) {
      probe.send({
        t: 'hb', pid: value.pid, deviceId: value.deviceId,
        soundReady: true, clockFresh: true
      });
    }
    await new Promise(resolve => setTimeout(resolve, 1_500));
    for (const probe of active.map(entry => entry.probe)) {
      assert.equal(probe.frames.length, 0, `${probe.label}: idle heartbeat emitted a frame`);
    }
    for (const manager of managers) {
      assert.equal(manager.frames.length, 0, `${manager.label}: idle period emitted a full-state frame`);
    }
    for (const probe of rally) {
      assert.equal(probe.frames.length, 0, `${probe.label}: idle Defense traffic crossed into Rally`);
    }

    managers[0].send({
      t: 'cancelDefense', password: PASSWORD, mutationId: 'load-cancel',
      orderId: managerOrder.id, orderRevision: managerOrder.revision
    });
    await managers[0].waitFor(message =>
      message.t === 'defenseOrderCancelled' && message.orderId === managerOrder.id
    );

    process.stdout.write(JSON.stringify({
      room: ROOM,
      registeredProfiles: 150,
      targetedWebsiteProfiles: managerOrder.counts.targetedProfiles,
      defenseSocketsAtFire: active.length + managers.length,
      rallySockets: rally.length,
      reconnects: 20,
      acceptedOrderRevision: managerOrder.revision,
      gameParticipationObserved: false
    }) + '\n');
  } finally {
    await Promise.allSettled(sockets.map(socket => socket.close()));
    await worker.close();
  }
}

await run();
