const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');

async function loadRoom() {
  const url = pathToFileURL(path.join(root, 'src/room.js'));
  url.searchParams.set('testRun', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function createRoomHarness(Room, options = {}) {
  const sent = [];
  const calls = [];
  const roomName = require('./support/qa-kvk.cjs').assertQaRoomName(options.roomName || 'qa-kvk-harness');
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const sockets = [];
  const state = {
    id: { name: roomName },
    getWebSockets() { return sockets.slice(); },
    acceptWebSocket(socket) { if (!sockets.includes(socket)) sockets.push(socket); }
  };
  const room = Object.create(Room.prototype);
  room.state = state;
  room.env = Object.assign({ MASTER: 'separate-master-override' }, options.env || {});
  room.roomName = roomName;
  room.room = {
    pwHash: null,
    config: { castleName: '', rallyAllies: [], enemyWhales: [] },
    players: Object.assign({
      '001': { name: 'Test 001', march: 32, marchRevision: 0, alliance: '', ready: false, lastSeen: new Date(nowMs).toISOString() },
      kimchi: { name: 'Kimchi', march: 40, marchRevision: 0, alliance: '', ready: false, lastSeen: new Date(nowMs).toISOString() }
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
  if (typeof room.normalizeLive === 'function') room.normalizeLive();
  room.nowMs = () => nowMs;
  room.now = () => new Date(nowMs).toISOString();
  room.persist = async () => { calls.push('persist'); };
  room.persistAll = async () => { calls.push('persistAll'); };
  room.broadcast = () => { calls.push('broadcast'); };
  room.scheduleExpiry = async () => { calls.push('alarm'); };
  let attachment = null;
  const ws = {
    send(message) { sent.push(JSON.parse(message)); },
    serializeAttachment(value) { attachment = structuredClone(value); },
    deserializeAttachment() { return attachment == null ? null : structuredClone(attachment); }
  };
  if (typeof room.attachSocket === 'function') room.attachSocket(ws, roomName);
  else {
    ws.serializeAttachment({ roomName });
    state.acceptWebSocket(ws);
  }
  const fetchURL = new URL('/api/ws', 'https://qa-kvk.invalid');
  fetchURL.searchParams.set('room', roomName);
  return {
    room,
    ws,
    sent,
    calls,
    nowMs,
    roomName,
    fetchURL: fetchURL.toString(),
    fetchRequest(init = {}) { return new Request(fetchURL, init); },
    reset() { sent.length = 0; calls.length = 0; }
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
