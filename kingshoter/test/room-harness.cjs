const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');

async function loadRoom() {
  const url = pathToFileURL(path.join(root, 'src/room.js'));
  url.searchParams.set('testRun', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function createRoomHarness(Room, options = {}) {
  const calls = [];
  const roomName = String(options.roomName || 'qa');
  if (!roomName) throw new Error('Room harness requires a room name');
  let currentNowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const sockets = [];
  const storage = options.storage instanceof Map
    ? options.storage
    : new Map(Object.entries(options.storage || {}));
  const storageCalls = [];
  let alarmAtMs = null;
  const clone = value => value == null ? value : structuredClone(value);
  const state = {
    id: { name: roomName },
    getWebSockets() { return sockets.slice(); },
    acceptWebSocket(socket) { if (!sockets.includes(socket)) sockets.push(socket); },
    storage: {
      async get(key) {
        if (Array.isArray(key)) {
          return new Map(key.filter(name => storage.has(name)).map(name => [name, clone(storage.get(name))]));
        }
        return clone(storage.get(key));
      },
      async put(key, value) {
        if (typeof key === 'string') {
          storage.set(key, clone(value));
          storageCalls.push({ op: 'put', keys: [key] });
          return;
        }
        const keys = Object.keys(key || {});
        for (const name of keys) storage.set(name, clone(key[name]));
        storageCalls.push({ op: 'put', keys });
      },
      async getAlarm() { return alarmAtMs; },
      async setAlarm(value) {
        alarmAtMs = value;
        storageCalls.push({ op: 'setAlarm', atMs: value });
      },
      async deleteAlarm() {
        alarmAtMs = null;
        storageCalls.push({ op: 'deleteAlarm' });
      }
    }
  };
  const room = Object.create(Room.prototype);
  room.state = state;
  room.env = Object.assign({ MASTER: 'separate-master-override' }, options.env || {});
  room.roomName = roomName;
  room.room = {
    pwHash: null,
    config: { castleName: '', rallyAllies: [], enemyWhales: [] },
    players: Object.assign({
      '001': { name: 'Test 001', march: 32, marchRevision: 0, alliance: '', ready: false, lastSeen: new Date(currentNowMs).toISOString() },
      kimchi: { name: 'Kimchi', march: 40, marchRevision: 0, alliance: '', ready: false, lastSeen: new Date(currentNowMs).toISOString() }
    }, options.players || {}),
    live: {
      mode: options.live ? 'live' : 'idle',
      commands: { 1: options.live || null, 2: null },
      staged: { 1: options.staged || null, 2: null },
      sim: null
    },
    updatedAt: null,
    updatedBy: null
  };
  room.devices = [];
  room.deliveryAcks = [];
  room._deliveryLoaded = true;
  room._deliveryLoadPromise = null;
  room._rallyLoaded = true;
  room._rallyLoadPromise = null;
  room._defenseLoaded = false;
  room._defenseLoadPromise = null;
  if (typeof room.normalizeLive === 'function') room.normalizeLive();
  room.nowMs = () => currentNowMs;
  room.now = () => new Date(currentNowMs).toISOString();
  room.persist = async () => { calls.push('persist'); };
  room.persistAll = async () => { calls.push('persistAll'); };
  room.persistDevices = async () => { calls.push('persistDevices'); };
  room.broadcast = () => { calls.push('broadcast'); };
  if (!options.useRealSchedule) room.scheduleExpiry = async () => { calls.push('alarm'); };
  function addSocket(surface = 'rally', initialAttachment = {}) {
    const socketSent = [];
    let attachment = null;
    const ws = {
      readyState: 1,
      send(message) { socketSent.push(JSON.parse(message)); },
      close() { this.readyState = 3; },
      serializeAttachment(value) { attachment = structuredClone(value); },
      deserializeAttachment() { return attachment == null ? null : structuredClone(attachment); }
    };
    if (typeof room.attachSocket === 'function') room.attachSocket(ws, roomName, surface);
    else {
      ws.serializeAttachment({ roomName, surface });
      state.acceptWebSocket(ws);
    }
    if (initialAttachment && Object.keys(initialAttachment).length) {
      const current = ws.deserializeAttachment() || {};
      ws.serializeAttachment({ ...current, ...clone(initialAttachment), surface });
    }
    return { ws, sent: socketSent };
  }
  const primary = addSocket(options.surface || 'rally', options.attachment || {});
  const ws = primary.ws;
  const sent = primary.sent;
  const fetchURL = new URL('/api/ws', 'https://coordination.test.invalid');
  fetchURL.searchParams.set('room', roomName);
  return {
    room,
    ws,
    sent,
    calls,
    nowMs: currentNowMs,
    roomName,
    storage,
    storageCalls,
    sockets,
    addSocket,
    alarmAtMs() { return alarmAtMs; },
    setNowMs(value) { currentNowMs = Number(value); return currentNowMs; },
    advanceMs(value) { currentNowMs += Number(value); return currentNowMs; },
    fetchURL: fetchURL.toString(),
    fetchRequest(init = {}) { return new Request(fetchURL, init); },
    reset() { sent.length = 0; calls.length = 0; storageCalls.length = 0; }
  };
}

async function claimRoom(harness, password = 'commander-secret') {
  await harness.room.webSocketMessage(harness.ws, JSON.stringify({
    t: 'setConfig',
    password,
    config: harness.room.room.config,
    by: 'test-claim'
  }));
  harness.reset();
  return harness;
}

module.exports = { loadRoom, createRoomHarness, claimRoom };
