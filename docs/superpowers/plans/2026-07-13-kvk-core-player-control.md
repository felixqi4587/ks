# KvK Core Player Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the working Classic KvK countdown while making player identity, march time, commander roster management, removal, commander audio routing, and exact command receipt truthful and synchronized across devices.

**Architecture:** Keep `Room` as the room-state authority, but move player and delivery mutations into small pure modules that the Durable Object handler calls. The browser stores only room-local identity/device keys, derives every selected-player display from canonical room state, and acknowledges a command only after its own future personal cues are actually scheduled. Classic remains the only production audio engine; this plan creates no Reliable, Triple, Push, or streaming transport.

**Tech Stack:** Cloudflare Workers and Durable Objects, browser JavaScript without a build step, HTML/CSS, Node.js test runner, Playwright Chromium/Firefox/WebKit, GitNexus.

## Global Constraints

- Every non-`qa-kvk-*` room is an operation room. Every automated WebSocket test must use a generated `qa-kvk-*` room, and the shared guard rejects all operation rooms through one generic predicate before connecting.
- Classic state-snapshot WebSocket delivery plus the existing AudioContext scheduler remains the production default and rollback baseline.
- A selected lead of 10, 15, 30, or 60 seconds must start each captain's personal countdown at that exact value.
- Main and Sacrifice retain independent immutable `pressUTC` values; an edit after Fire must never reschedule an active command.
- An unselected commander device is silent. A commander selected as a captain receives that captain's personal countdown. An ordinary registered member receives one generic JOIN countdown.
- Player ID is the default and recommended identity. Nickname mode exists for testing, uses an opaque browser-local routing key, and never merges equal nicknames across browsers.
- `room.players[pid].march` and `marchRevision` are canonical. A reconnect or heartbeat must never overwrite them.
- March updates accept only integer seconds from 5 through 180 inclusive; values are rejected rather than clamped.
- A staged player may be removed, clearing all staged references atomically. A player in an unexpired live command may not be removed.
- Green `Received` means at least one exact `commandId + pid + deviceId` acknowledgement after successful future personal-cue scheduling. WebSocket state, heartbeat freshness, AudioContext state, and Push-provider acceptance are not `Received`.
- The ACK/device aggregation must iterate `command.payload.pairs` without requiring exactly two targets, so later rally types can reuse storage without changing Classic semantics.
- No Reliable shadow delivery, Triple Rally behavior, Web Push, Battle Audio Stream, native app, SMS, phone, Discord, or platform promotion is implemented in this plan.
- Do not modify the current countdown formula or `scheduleBeeps()` unless a new failing regression test proves it is necessary.
- Preserve the no-build frontend and all unrelated user changes. Stage and commit only the files named in each task.
- Before editing every existing function, method, or class, run upstream GitNexus impact for that symbol. Warn the user before any HIGH or CRITICAL edit, then continue within the approved scope.
- Before every implementation commit, run `gitnexus_detect_changes({scope:"all", repo:"kingshot"})` and verify only the expected symbols and flows are reported.
- Desktop automation proves routing, timing calculations, synchronization, and deduplication only; it must not be described as physical iOS or Android background-delivery proof.
- Before any browser-test command in this plan, start `cd /Users/ff/Documents/kingshot/kingshoter && npm run dev -- --port 8791` in a separate terminal and wait for Wrangler's ready line; stop that process after the task's browser tests finish.

## Shared Interfaces

These names are fixed across this plan and are dependencies for later approved plans.

```js
// src/room-player.js
parseMarchSeconds(value) // => integer 5..180 or null
normalizeMarchRevision(value) // => non-negative integer, otherwise 0
normalizeRoutingKey(value) // => safe string up to 24 chars, or ""
normalizeMutationId(value) // => non-empty string up to 64 chars, or ""
normalizePlayerRecords(players) // => normalized own-property record map
registerPlayer(players, input, nowISO) // => { ok, created, pid, player } or { ok:false, error }
applyPlayerMarchUpdate(players, input, options) // => mutation result
activeCommandPids(live, nowSec) // => Set<string>
clearStagedPlayer(live, pid) // => [{ kingdom, role }]
removePlayerAtomic(room, pid, nowSec) // => explicit result
freezeDoubleRally(players, pairs, firstPress) // => canonical two-role immutable pair array or error
rallyTargetPids(command) // => unique target PIDs from any-length payload.pairs

// public/app.js
window.getRoomDeviceId(room) // => room-local crypto.randomUUID()
sock.onMessage = function (message) {} // every non-state/non-error WebSocket message

// public/kvk.js
canonicalPick(pid, role, players) // => {pid,role,name,march,marchRevision} or null
selectOrReplacePlayer(pid)
openReplacement(pid, availableRoles)
applyReplacement(pid, role)
renderSlots(kingdom = fireKingdom)

// test/support/qa-kvk.cjs
assertQaRoomName(room) // exact lowercase qa-kvk-* grammar, total length <= 48
makeQaRoom(testInfo)
qaRoomUrl(baseURL, room, params = {})
installQaWebSocketGuard(context, room, options = {})
// options:
//   shouldDropClientMessage?: ({ url, data }) => boolean
//   shouldDropServerMessage?: ({ url, data }) => boolean

// test/room-harness.cjs
loadRoom() // => Promise<{ Room }>
createRoomHarness(Room, options = {})
// options: { roomName = "qa-kvk-harness", env, players, nowMs, live, staged }
// harness.roomName and harness.fetchURL preserve that exact QA room;
// harness.ws supports merge-safe serializeAttachment()/deserializeAttachment().
claimRoom(harness, password = "commander-secret")
// harness.reset() clears sent/calls only
```

The core WebSocket contracts are additive:

```js
{ t: "registerPlayer", pid, name, march, identityMode: "playerId" | "nickname", alliance: "" }
{ t: "updateOwnMarch", mutationId, pid, march, baseRevision }
{ t: "setPlayerMarch", mutationId, password, pid, march, baseRevision }
{ t: "playerMarchSaved", mutationId, pid, march, revision }
{ t: "deviceStatus", pid, deviceId, soundReady }
{ t: "hb", pid, deviceId, soundReady }
{ t: "deliveryAck", commandId, pid, deviceId, outcome: "scheduled" | "expired", targetUTC, scheduledAtMs }
```

---

### Task 1: Create the QA-room gate and importable Room harness

**Files:**
- Create: `kingshoter/test/support/qa-kvk.cjs`
- Create: `kingshoter/test/qa-kvk.test.cjs`
- Create: `kingshoter/test/room-harness.cjs`
- Modify: `kingshoter/package.json:1-13`
- Test: `kingshoter/test/qa-kvk.test.cjs`

**Interfaces:**
- Consumes: Playwright `BrowserContext.routeWebSocket()` and Node `pathToFileURL()`.
- Produces: the four QA helper exports and three Room-harness exports listed in Shared Interfaces.

- [ ] **Step 1: Write the failing QA helper test**

Create `test/qa-kvk.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('QA rooms are generated safely and every non-QA room is rejected', () => {
  const {
    assertQaRoomName,
    makeQaRoom,
    qaRoomUrl
  } = require('./support/qa-kvk.cjs');

  const room = makeQaRoom({ title: 'Classic ACK / commander silence' });
  assert.match(room, /^qa-kvk-[a-z0-9-]+$/);
  assert.equal(assertQaRoomName(room), room);
  assert.throws(() => assertQaRoomName('operation-room'), /qa-kvk/);
  assert.throws(() => assertQaRoomName('alerts-123'), /qa-kvk/);
  assert.throws(() => assertQaRoomName('qa_kvk_wrong'), /qa-kvk/);

  const url = new URL(qaRoomUrl('http://127.0.0.1:8791', room, { notour: '1', lang: 'en' }));
  assert.equal(url.pathname, '/kvk.html');
  assert.equal(url.searchParams.get('room'), room);
  assert.equal(url.searchParams.get('notour'), '1');
  assert.equal(url.searchParams.get('lang'), 'en');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test test/qa-kvk.test.cjs
```

Expected: FAIL with `Cannot find module './support/qa-kvk.cjs'`.

- [ ] **Step 3: Implement the QA helper with a single bidirectional WebSocket route**

Create `test/support/qa-kvk.cjs`:

```js
const { randomBytes } = require('node:crypto');

function assertQaRoomName(room) {
  const value = String(room || '');
  if (!/^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/.test(value)) {
    throw new Error(`Refusing non-QA KvK room: ${value || '<empty>'}; expected qa-kvk-*`);
  }
  return value;
}

function makeQaRoom(testInfo) {
  const source = typeof testInfo === 'string'
    ? testInfo
    : testInfo && testInfo.title
      ? testInfo.title
      : 'core';
  const label = String(source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'core';
  return assertQaRoomName(`qa-kvk-${label}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
}

function qaRoomUrl(baseURL, room, params = {}) {
  const safeRoom = assertQaRoomName(room);
  const url = new URL('/kvk.html', baseURL);
  url.searchParams.set('room', safeRoom);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function installQaWebSocketGuard(context, room, options = {}) {
  const safeRoom = assertQaRoomName(room);
  const dropClient = options.shouldDropClientMessage;
  const dropServer = options.shouldDropServerMessage;
  if (dropClient !== undefined && typeof dropClient !== 'function') throw new TypeError('shouldDropClientMessage must be a function');
  if (dropServer !== undefined && typeof dropServer !== 'function') throw new TypeError('shouldDropServerMessage must be a function');

  await context.routeWebSocket(/\/api\/ws(?:\?|$)/, route => {
    const url = route.url();
    const actualRoom = new URL(url).searchParams.get('room') || '';
    if (actualRoom !== safeRoom) {
      throw new Error(`Refusing WebSocket room ${actualRoom || '<empty>'}; guard allows only ${safeRoom}`);
    }
    const server = route.connectToServer();
    route.onMessage(data => {
      if (!dropClient || !dropClient({ url, data })) server.send(data);
    });
    server.onMessage(data => {
      if (!dropServer || !dropServer({ url, data })) route.send(data);
    });
  });
}

module.exports = {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
};
```

- [ ] **Step 4: Write the failing harness-contract test**

Append to `test/qa-kvk.test.cjs` before creating the harness:

```js
test('Room harness preserves the exact QA room in its URL and socket attachment', async () => {
  const { loadRoom, createRoomHarness } = require('./room-harness.cjs');
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { roomName: 'qa-kvk-unit' });
  assert.equal(h.roomName, 'qa-kvk-unit');
  assert.equal(h.room.state.id.name, 'qa-kvk-unit');
  assert.equal(new URL(h.fetchURL).searchParams.get('room'), 'qa-kvk-unit');
  assert.equal(h.ws.deserializeAttachment().roomName, 'qa-kvk-unit');
  assert.throws(() => createRoomHarness(Room, { roomName: 'operation-room' }), /qa-kvk/);
});
```

- [ ] **Step 5: Run the harness test and verify RED**

Run:

```bash
node --test test/qa-kvk.test.cjs
```

Expected: the QA helper case passes, then the harness case FAILS with `Cannot find module './room-harness.cjs'`.

- [ ] **Step 6: Make Worker modules importable from CommonJS tests**

Add `"type": "module"` after `"private": true` in `package.json`. Create `test/room-harness.cjs`:

```js
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
```

- [ ] **Step 7: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: all existing 18 tests plus both QA-room/harness tests PASS. No harness can construct a non-`qa-kvk-*` request or attachment.

- [ ] **Step 8: Detect scope and commit**

Run GitNexus change detection, verify only test infrastructure and `package.json` are reported, then commit:

```bash
git add kingshoter/package.json kingshoter/test/support/qa-kvk.cjs kingshoter/test/qa-kvk.test.cjs kingshoter/test/room-harness.cjs
git commit -m "test: guard disposable KVK QA rooms"
```

---

### Task 2: Build canonical player-domain mutations as pure functions

**Files:**
- Create: `kingshoter/src/room-player.js`
- Create: `kingshoter/test/player-domain.test.cjs`
- Test: `kingshoter/test/player-domain.test.cjs`

**Interfaces:**
- Consumes: no room transport; operates on plain room/player objects.
- Produces: every `src/room-player.js` interface listed in Shared Interfaces.

- [ ] **Step 1: Write failing domain tests**

Create `test/player-domain.test.cjs` with these exact cases:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function domain() {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'room-player.js'));
  url.searchParams.set('run', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test('march parser is strict and revisions migrate without data loss', async () => {
  const { parseMarchSeconds, normalizeMarchRevision, normalizePlayerRecords } = await domain();
  assert.equal(parseMarchSeconds(5), 5);
  assert.equal(parseMarchSeconds('180'), 180);
  for (const value of [4, 181, 6.5, '6.5', 'abc', '', null, Infinity, NaN]) assert.equal(parseMarchSeconds(value), null);
  assert.equal(normalizeMarchRevision(undefined), 0);
  assert.equal(normalizeMarchRevision(-1), 0);
  assert.equal(normalizeMarchRevision(8), 8);
  const inherited = Object.create({ ghost: { name: 'Inherited', march: 30 } });
  inherited.p1 = { name: 'One', march: 240 };
  const players = normalizePlayerRecords(inherited);
  assert.equal(players.p1.march, 240, 'migration must not clamp an existing record');
  assert.equal(players.p1.marchRevision, 0);
  assert.equal(players.ghost, undefined);
});

test('registration is create-only and explicit updates use optimistic revision', async () => {
  const { registerPlayer, applyPlayerMarchUpdate } = await domain();
  const players = {};
  assert.equal(registerPlayer(players, { pid: '__proto__', march: 35 }, '2026-07-14T00:00:00.000Z').error, 'invalid_pid');
  const created = registerPlayer(players, { pid: '900000001', name: 'Alpha', march: 35, identityMode: 'playerId' }, '2026-07-14T00:00:00.000Z');
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(players['900000001'].marchRevision, 0);

  const duplicate = registerPlayer(players, { pid: '900000001', name: 'Stale', march: 99, identityMode: 'playerId' }, '2026-07-14T00:01:00.000Z');
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.created, false);
  assert.equal(players['900000001'].name, 'Alpha');
  assert.equal(players['900000001'].march, 35);

  const updated = applyPlayerMarchUpdate(players, {
    mutationId: 'm-1', pid: '900000001', march: 36, baseRevision: 0
  }, { touchLastSeen: true, nowISO: '2026-07-14T00:02:00.000Z' });
  assert.deepEqual(updated, { ok: true, mutationId: 'm-1', pid: '900000001', march: 36, revision: 1 });
  assert.equal(players['900000001'].lastSeen, '2026-07-14T00:02:00.000Z');

  const conflict = applyPlayerMarchUpdate(players, {
    mutationId: 'm-2', pid: '900000001', march: 37, baseRevision: 0
  }, { touchLastSeen: false, nowISO: '2026-07-14T00:03:00.000Z' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'player_conflict');
  assert.deepEqual(conflict.latest, { pid: '900000001', march: 36, revision: 1 });
  assert.equal(players['900000001'].march, 36);
});

test('staged removal is atomic while an unexpired command blocks it', async () => {
  const { removePlayerAtomic } = await domain();
  const room = {
    players: { p1: { name: 'One', march: 30, marchRevision: 0 } },
    live: {
      staged: {
        1: { kingdom: 1, pairs: [{ pid: 'p1', role: 'weak' }] },
        2: { kingdom: 2, pairs: [{ pid: 'p1', role: 'main' }] }
      },
      commands: { 1: null, 2: null }
    }
  };
  const removed = removePlayerAtomic(room, 'p1', 100);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.cleared, [{ kingdom: 1, role: 'weak' }, { kingdom: 2, role: 'main' }]);
  assert.equal(room.players.p1, undefined);
  assert.equal(room.live.staged[1], null);
  assert.equal(room.live.staged[2], null);

  room.players.p1 = { name: 'One', march: 30, marchRevision: 0 };
  room.live.staged[1] = { kingdom: 1, pairs: [{ pid: 'p1', role: 'weak' }] };
  room.live.commands[1] = { id: 'c1', expiresUTC: 101, payload: { pairs: [{ pid: 'p1' }] } };
  const blocked = removePlayerAtomic(room, 'p1', 100);
  assert.deepEqual(blocked, { ok: false, error: 'player_in_live_command', pid: 'p1' });
  assert.ok(room.players.p1);
  assert.deepEqual(room.live.staged[1].pairs, [{ pid: 'p1', role: 'weak' }]);

  room.live.commands[1].expiresUTC = 100;
  assert.equal(removePlayerAtomic(room, 'p1', 100).ok, true, 'expiry at now is not active');
});

test('double-rally snapshot uses canonical values and generic target extraction has no pair-count assumption', async () => {
  const { freezeDoubleRally, rallyTargetPids } = await domain();
  const players = {
    weak: { name: 'Weak', march: 40, marchRevision: 2 },
    main: { name: 'Main', march: 50, marchRevision: 3 },
    third: { name: 'Third', march: 60, marchRevision: 1 }
  };
  const frozen = freezeDoubleRally(players, [
    { pid: 'weak', role: 'weak', name: 'stale', march: 99 },
    { pid: 'main', role: 'main', name: 'stale', march: 99 }
  ], 1000);
  assert.equal(frozen.ok, true);
  assert.deepEqual(frozen.pairs, [
    { pid: 'weak', name: 'Weak', role: 'weak', march: 40, pressUTC: 1009 },
    { pid: 'main', name: 'Main', role: 'main', march: 50, pressUTC: 1000 }
  ]);
  assert.deepEqual(rallyTargetPids({ payload: { pairs: [
    { pid: 'weak' }, { pid: 'main' }, { pid: 'third' }, { pid: 'weak' }
  ] } }), ['weak', 'main', 'third']);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/player-domain.test.cjs
```

Expected: FAIL because `src/room-player.js` does not exist.

- [ ] **Step 3: Implement the pure player module**

Create `src/room-player.js` with strict normalization, revisioned updates, staged cleanup, active-command checks, and canonical double-rally freezing. Use this complete implementation:

```js
export const MARCH_MIN = 5;
export const MARCH_MAX = 180;

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

export function normalizeRoutingKey(value) {
  const key = String(value == null ? '' : value).trim().slice(0, 24);
  if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') return '';
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : '';
}

export function normalizeMutationId(value) {
  const id = String(value == null ? '' : value).trim();
  return id && id.length <= 64 ? id : '';
}

export function parseMarchSeconds(value) {
  if (value === '' || value == null || typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number >= MARCH_MIN && number <= MARCH_MAX ? number : null;
}

export function normalizeMarchRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function normalizePlayerRecords(players) {
  const source = players && typeof players === 'object' ? players : {};
  const result = Object.create(null);
  for (const pid of Object.keys(source)) {
    const player = source[pid] && typeof source[pid] === 'object' ? source[pid] : {};
    result[pid] = Object.assign({}, player, { marchRevision: normalizeMarchRevision(player.marchRevision) });
  }
  return result;
}

function cleanName(value) {
  return Array.from(String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim().replace(/\s+/g, ' ')).slice(0, 24).join('');
}

export function registerPlayer(players, input, nowISO) {
  const pid = normalizeRoutingKey(input && input.pid);
  const march = parseMarchSeconds(input && input.march);
  if (!pid) return { ok: false, error: 'invalid_pid' };
  if (march == null) return { ok: false, error: 'invalid_march' };
  if (own(players, pid)) return { ok: true, created: false, pid, player: players[pid] };
  const mode = input && input.identityMode === 'nickname' ? 'nickname' : 'playerId';
  const name = cleanName(input && input.name) || pid;
  players[pid] = {
    name,
    march,
    marchRevision: 0,
    identityMode: mode,
    alliance: cleanName(input && input.alliance),
    ready: false,
    lastSeen: nowISO
  };
  return { ok: true, created: true, pid, player: players[pid] };
}

export function applyPlayerMarchUpdate(players, input, options = {}) {
  const mutationId = normalizeMutationId(input && input.mutationId);
  const pid = normalizeRoutingKey(input && input.pid);
  const march = parseMarchSeconds(input && input.march);
  if (!mutationId) return { ok: false, error: 'invalid_mutation', mutationId: '' };
  if (!pid || !own(players, pid)) return { ok: false, error: 'player_missing', mutationId, pid };
  if (march == null) return { ok: false, error: 'invalid_march', mutationId, pid };
  const player = players[pid];
  const currentRevision = normalizeMarchRevision(player.marchRevision);
  if (!Number.isInteger(input.baseRevision) || input.baseRevision !== currentRevision) {
    return {
      ok: false,
      error: 'player_conflict',
      mutationId,
      pid,
      latest: { pid, march: player.march, revision: currentRevision }
    };
  }
  player.march = march;
  player.marchRevision = currentRevision + 1;
  if (options.touchLastSeen) player.lastSeen = options.nowISO;
  return { ok: true, mutationId, pid, march, revision: player.marchRevision };
}

export function rallyTargetPids(command) {
  const pairs = command && command.payload && Array.isArray(command.payload.pairs) ? command.payload.pairs : [];
  const seen = new Set();
  const result = [];
  for (const pair of pairs) {
    const pid = normalizeRoutingKey(pair && pair.pid);
    if (pid && !seen.has(pid)) { seen.add(pid); result.push(pid); }
  }
  return result;
}

export function activeCommandPids(live, nowSec) {
  const result = new Set();
  const commands = live && live.commands && typeof live.commands === 'object' ? live.commands : {};
  for (const key of Object.keys(commands)) {
    const command = commands[key];
    if (command && Number(command.expiresUTC) > nowSec) {
      for (const pid of rallyTargetPids(command)) result.add(pid);
    }
  }
  return result;
}

export function clearStagedPlayer(live, pidValue) {
  const pid = normalizeRoutingKey(pidValue);
  const cleared = [];
  if (!pid || !live || !live.staged) return cleared;
  for (const kingdom of [1, 2]) {
    const staged = live.staged[kingdom];
    const pairs = staged && Array.isArray(staged.pairs) ? staged.pairs : [];
    for (const pair of pairs) if (pair.pid === pid) cleared.push({ kingdom, role: pair.role });
    const kept = pairs.filter(pair => pair.pid !== pid);
    live.staged[kingdom] = kept.length ? Object.assign({}, staged, { pairs: kept }) : null;
  }
  return cleared;
}

export function removePlayerAtomic(room, pidValue, nowSec) {
  const pid = normalizeRoutingKey(pidValue);
  if (!pid || !own(room && room.players, pid)) return { ok: false, error: 'player_missing', pid };
  if (activeCommandPids(room.live, nowSec).has(pid)) return { ok: false, error: 'player_in_live_command', pid };
  const cleared = clearStagedPlayer(room.live, pid);
  delete room.players[pid];
  return { ok: true, pid, cleared };
}

export function freezeDoubleRally(players, pairsValue, firstPressValue) {
  const pairs = Array.isArray(pairsValue) ? pairsValue : [];
  const firstPress = Number(firstPressValue);
  if (pairs.length !== 2 || !Number.isFinite(firstPress)) return { ok: false, error: 'invalid_rally' };
  const byRole = Object.create(null);
  for (const input of pairs) {
    const pid = normalizeRoutingKey(input && input.pid);
    const role = input && input.role === 'main' ? 'main' : 'weak';
    if (!pid || !own(players, pid) || byRole[role]) return { ok: false, error: 'player_missing' };
    byRole[role] = { pid, player: players[pid] };
  }
  if (!byRole.weak || !byRole.main || byRole.weak.pid === byRole.main.pid) return { ok: false, error: 'player_missing' };
  const weakMarch = Number(byRole.weak.player.march);
  const mainMarch = Number(byRole.main.player.march);
  if (!Number.isFinite(weakMarch) || !Number.isFinite(mainMarch)) return { ok: false, error: 'invalid_march' };
  const offset = (mainMarch - weakMarch) - 1;
  const mainPress = offset >= 0 ? firstPress : firstPress - offset;
  const weakPress = offset >= 0 ? firstPress + offset : firstPress;
  return {
    ok: true,
    pairs: [
      { pid: byRole.weak.pid, name: byRole.weak.player.name || byRole.weak.pid, role: 'weak', march: weakMarch, pressUTC: weakPress },
      { pid: byRole.main.pid, name: byRole.main.player.name || byRole.main.pid, role: 'main', march: mainMarch, pressUTC: mainPress }
    ]
  };
}
```

- [ ] **Step 4: Run the focused test and full unit suite**

Run:

```bash
node --test test/player-domain.test.cjs
npm test
```

Expected: all player-domain cases PASS and the full unit suite remains GREEN.

- [ ] **Step 5: Detect scope and commit**

Run change detection, verify the change is isolated to the new player-domain module/tests, then commit:

```bash
git add kingshoter/src/room-player.js kingshoter/test/player-domain.test.cjs
git commit -m "feat: add canonical KVK player mutations"
```

---

### Task 3: Wire revisioned registration, update, Fire snapshot, and removal into Room

**Files:**
- Modify: `kingshoter/src/room.js:6-16,44-63,118-245,247-255`
- Modify: `kingshoter/test/player-removal.test.cjs:1-186`
- Create: `kingshoter/test/player-protocol.test.cjs`
- Test: `kingshoter/test/player-protocol.test.cjs`
- Test: `kingshoter/test/player-removal.test.cjs`

**Interfaces:**
- Consumes: all pure player-domain functions from Task 2 and the shared Room harness from Task 1.
- Produces: create-only `registerPlayer`, revisioned own/commander updates, canonical double-rally snapshots, and staged-aware removal.

- [ ] **Step 1: Add failing protocol tests**

Create `test/player-protocol.test.cjs`. Use `loadRoom`, `createRoomHarness`, and `claimRoom`; assert these exact behaviors:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness, claimRoom } = require('./room-harness.cjs');

test('legacy setMarch and registerPlayer are create-only for an existing pid', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'setMarch', pid: '001', name: 'Stale', march: 99 }));
  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'registerPlayer', pid: '001', name: 'Stale 2', march: 88, identityMode: 'playerId' }));
  assert.equal(h.room.room.players['001'].name, 'Test 001');
  assert.equal(h.room.room.players['001'].march, 32);
  assert.equal(h.room.room.players['001'].marchRevision, 0);
});

test('registration keeps the 150-player cap without evicting active or staged captains', async () => {
  const { Room } = await loadRoom();
  const players = {};
  for (let index = 0; index < 150; index += 1) {
    const pid = String(index).padStart(3, '0');
    players[pid] = { name: pid, march: 30, marchRevision: 0, lastSeen: new Date(index * 1000).toISOString() };
  }
  const h = createRoomHarness(Room, {
    players,
    live: { id: 'active', expiresUTC: 2000, payload: { pairs: [{ pid: '000' }] } },
    staged: { kingdom: 1, pairs: [{ pid: '001', role: 'weak' }] },
    nowMs: 1_000_000
  });
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'registerPlayer', pid: 'new-player', name: 'New', march: 35, identityMode: 'playerId'
  }));
  assert.equal(Object.keys(h.room.room.players).length, 150);
  assert.ok(h.room.room.players['000']);
  assert.ok(h.room.room.players['001']);
  assert.ok(h.room.room.players['new-player']);
  assert.equal(h.room.room.players['002'], undefined);
});

test('player and commander updates acknowledge mutationId and broadcast canonical revision', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'own-1', pid: '001', march: 33, baseRevision: 0
  }));
  assert.deepEqual(h.sent, [{ t: 'playerMarchSaved', mutationId: 'own-1', pid: '001', march: 33, revision: 1 }]);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
  assert.equal(h.room.room.updatedAt, null);
  assert.equal(h.room.room.updatedBy, null);
  h.reset();

  await claimRoom(h);
  const configVersion = h.room.room.updatedAt;
  const configAuthor = h.room.room.updatedBy;
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setPlayerMarch', mutationId: 'cmd-1', password: 'commander-secret', pid: '001', march: 34, baseRevision: 1
  }));
  assert.deepEqual(h.sent, [{ t: 'playerMarchSaved', mutationId: 'cmd-1', pid: '001', march: 34, revision: 2 }]);
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
  assert.equal(h.room.room.updatedAt, configVersion);
  assert.equal(h.room.room.updatedBy, configAuthor);
});

test('heartbeat refreshes presence without changing canonical march or revision', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await h.room.webSocketMessage(h.ws, JSON.stringify({ t: 'hb', pid: '001' }));
  assert.equal(h.room.room.players['001'].march, 32);
  assert.equal(h.room.room.players['001'].marchRevision, 0);
});

test('wrong-password commander update authenticates before existence-sensitive errors', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setPlayerMarch', mutationId: 'cmd-x', password: 'wrong', pid: 'missing', march: 40, baseRevision: 0
  }));
  assert.deepEqual(h.sent, [{ t: 'error', error: 'bad_password', mutationId: 'cmd-x' }]);
  assert.deepEqual(h.calls, []);
});

test('Fire freezes canonical march values even when the sender submits stale snapshots', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'before-fire', pid: '001', march: 33, baseRevision: 0
  }));
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 1000,
      payload: {
        firstPress: 1000, leadSeconds: 10,
        pairs: [
          { pid: '001', role: 'weak', name: 'stale', march: 99, pressUTC: 1000 },
          { pid: 'kimchi', role: 'main', name: 'stale', march: 99, pressUTC: 1000 }
        ]
      }
    }
  }));
  assert.deepEqual(h.room.room.live.commands[1].payload.pairs, [
    { pid: '001', name: 'Test 001', role: 'weak', march: 33, pressUTC: 1006 },
    { pid: 'kimchi', name: 'Kimchi', role: 'main', march: 40, pressUTC: 1000 }
  ]);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'updateOwnMarch', mutationId: 'after-fire', pid: '001', march: 34, baseRevision: 1
  }));
  assert.deepEqual(h.room.room.live.commands[1].payload.pairs, [
    { pid: '001', name: 'Test 001', role: 'weak', march: 33, pressUTC: 1006 },
    { pid: 'kimchi', name: 'Kimchi', role: 'main', march: 40, pressUTC: 1000 }
  ]);
});
```

Update `player-removal.test.cjs` so staged removal expects one persist/broadcast and cleared staging, while only a future `expiresUTC` command expects `player_in_live_command`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test test/player-protocol.test.cjs test/player-removal.test.cjs
```

Expected: FAIL because current `setMarch` overwrites, update messages are unknown, Fire trusts stale fields, and staged removal is blocked.

- [ ] **Step 3: Run required impact analysis and report risk**

Run:

```text
gitnexus_impact({repo:"kingshot", target:"constructor", file_path:"kingshoter/src/room.js", kind:"Method", direction:"upstream"})
gitnexus_impact({repo:"kingshot", target:"webSocketMessage", file_path:"kingshoter/src/room.js", kind:"Method", direction:"upstream"})
```

Expected graph result is LOW, but explicitly report that `webSocketMessage` is a framework callback and manual architectural risk is HIGH because it handles every room mutation.

- [ ] **Step 4: Import and initialize canonical player state**

Add imports at the top of `src/room.js`:

```js
import {
  normalizeMutationId,
  normalizePlayerRecords,
  normalizeRoutingKey,
  registerPlayer,
  applyPlayerMarchUpdate,
  removePlayerAtomic,
  freezeDoubleRally
} from './room-player.js';
```

After loading the room in `Room.constructor`, assign:

```js
this.room.players = normalizePlayerRecords(this.room.players);
```

- [ ] **Step 5: Replace legacy registration and add explicit update branches**

Replace the existing `setMarch` branch with a branch accepting both legacy and new registration messages, always create-only. A newly created registration applies the existing 150-player cap: build its protected set from `activeCommandPids(this.room.live, nowSec)` plus every staged PID, evict oldest unprotected `lastSeen` records only, then call `persist()` and `broadcast()` once. An already-existing PID is an idempotent no-op and must not touch name, march, revision, storage, or broadcasts. Add `updateOwnMarch` and authenticated `setPlayerMarch` branches. On update success, call `persist()` once, send `playerMarchSaved`, then call `broadcast()` once. Neither updates nor removal modify `updatedAt`/`updatedBy`. On failure, send:

```js
ws.send(JSON.stringify(Object.assign({ t: 'error' }, result)));
```

For `setPlayerMarch`, authenticate before invoking `applyPlayerMarchUpdate`; include normalized `mutationId` in `bad_password`.

- [ ] **Step 6: Canonicalize Fire and make removal staged-aware**

Inside the `double_rally` command branch, replace client-supplied pair validation with:

```js
const frozen = freezeDoubleRally(this.room.players, payload.pairs, payload.firstPress != null ? payload.firstPress : c.anchorUTC);
if (!frozen.ok) return ws.send(JSON.stringify({ t: 'error', error: frozen.error }));
payload = Object.assign({}, payload, {
  pairs: frozen.pairs,
  firstPress: Math.min(...frozen.pairs.map(pair => pair.pressUTC))
});
```

Keep the existing password/master authentication as the first existence-sensitive operation in `removePlayer`, then replace its mutation body with:

```js
const result = removePlayerAtomic(this.room, m.pid, Math.floor(this.nowMs() / 1000));
if (!result.ok) return ws.send(JSON.stringify({ t: 'error', error: result.error, pid: result.pid }));
await this.persist();
this.broadcast();
return;
```

Add a testable clock method next to `now()`:

```js
nowMs() { return Date.now(); }
```

Use `this.nowMs()` in command/removal expiry comparisons touched by this task.

- [ ] **Step 7: Run protocol, removal, command-scope, and full tests**

Run:

```bash
node --test test/player-protocol.test.cjs test/player-removal.test.cjs test/command-scope.test.cjs
npm test
```

Expected: all tests PASS; counter-rally artifacts remain absent.

- [ ] **Step 8: Detect scope and commit**

Run change detection; expected symbols are `Room.constructor`, `Room.webSocketMessage`, `Room.nowMs`, and new player-domain calls. Commit:

```bash
git add kingshoter/src/room.js kingshoter/test/player-protocol.test.cjs kingshoter/test/player-removal.test.cjs
git commit -m "feat: enforce canonical KVK player protocol"
```

---

### Task 4: Add generic RoomSocket success events and room-local device IDs

**Files:**
- Modify: `kingshoter/public/app.js:128-144`
- Create: `kingshoter/test/room-socket.test.cjs`
- Test: `kingshoter/test/room-socket.test.cjs`

**Interfaces:**
- Consumes: WebSocket messages produced by Room.
- Produces: `RoomSocket.onMessage(message)` for non-state/non-error messages and `getRoomDeviceId(room)`.

- [ ] **Step 1: Write the failing isolated socket test**

Create a VM-backed test that provides `window`, `localStorage`, and a fake `WebSocket`. It must construct `RoomSocket`, send one `state`, one `error`, and one `playerMarchSaved` message through the fake socket, and assert the third reaches `onMessage`. It must also assert two calls to `getRoomDeviceId('qa-kvk-a')` are equal while `getRoomDeviceId('qa-kvk-b')` differs and uses keys `kvk:<room>:delivery-device:v1`.

Use exact assertions:

```js
assert.deepEqual(states, [{ players: {} }]);
assert.deepEqual(errors, [{ t: 'error', error: 'player_conflict' }]);
assert.deepEqual(messages, [{ t: 'playerMarchSaved', mutationId: 'm1' }]);
assert.equal(first, second);
assert.notEqual(first, otherRoom);
assert.match(first, /^[0-9a-f-]{36}$/i);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/room-socket.test.cjs
```

Expected: FAIL because unknown messages are discarded and `getRoomDeviceId` does not exist.

- [ ] **Step 3: Run impact analysis for the exact app.js methods**

Run:

```text
gitnexus_impact({repo:"kingshot", target:"constructor", file_path:"kingshoter/public/app.js", kind:"Method", direction:"upstream"})
gitnexus_impact({repo:"kingshot", target:"connect", file_path:"kingshoter/public/app.js", kind:"Method", direction:"upstream"})
```

Expected: LOW; repository search confirms KvK is the only `RoomSocket` consumer.

- [ ] **Step 4: Implement the additive client interfaces**

Initialize `this.onMessage = null` in the constructor. Replace the message dispatcher with:

```js
ws.onmessage = (event) => {
  let message;
  try { message = JSON.parse(event.data); } catch (_) { return; }
  if (message.t === 'state') this.onState(message.room);
  else if (message.t === 'error') { if (this.onError) this.onError(message); }
  else if (this.onMessage) this.onMessage(message);
};
```

Add before `RoomSocket`:

```js
window.getRoomDeviceId = (room) => {
  const key = `kvk:${String(room)}:delivery-device:v1`;
  let value = '';
  try { value = localStorage.getItem(key) || ''; } catch (e) {}
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    value = crypto.randomUUID();
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  return value;
};
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --test test/room-socket.test.cjs
npm test
```

Expected: PASS. Run change detection, then commit:

```bash
git add kingshoter/public/app.js kingshoter/test/room-socket.test.cjs
git commit -m "feat: expose KVK socket success events"
```

---

### Task 5: Reconcile player identity from the first room snapshot

**Files:**
- Modify: `kingshoter/public/kvk.js:15-29,844-909,911-976,1014-1022`
- Modify: `kingshoter/test/player-removal-own-device.e2e.cjs:1-80`
- Modify: `kingshoter/test/defense.cjs:1-20`
- Create: `kingshoter/test/player-reconnect.e2e.cjs`
- Test: `kingshoter/test/player-reconnect.e2e.cjs`

**Interfaces:**
- Consumes: create-only registration and `playerMarchSaved` from Tasks 3–4.
- Produces: server-first reconnect, pending mutation reconciliation, and local profile shape `{pid,name,march,marchRevision,identityMode}`.

- [ ] **Step 1: Write the failing reconnect E2E**

Use `makeQaRoom`, `qaRoomUrl`, and one isolated browser context. Seed local storage with march 90/revision 0, create the same server player at march 40/revision 3, reload, and assert:

```js
assert.equal(saved.march, 40);
assert.equal(saved.marchRevision, 3);
assert.equal(snapshot.room.players[pid].march, 40);
```

Also remove the player through a second WebSocket after the first page has observed it; assert the page clears `kingshoter_r_<room>_me` and returns to `#fillCard` without auto-registering during that connection.

Before either legacy regression is run in this task, replace its ad-hoc room construction with `makeQaRoom`, build its page URL with `qaRoomUrl`, and install `installQaWebSocketGuard(context, room)` before the first page opens. This applies to `player-removal-own-device.e2e.cjs` and `defense.cjs`; their behavior assertions stay unchanged.

- [ ] **Step 2: Run local Wrangler and verify RED**

Terminal A:

```bash
npm run dev -- --port 8791
```

Terminal B:

```bash
BASE=http://127.0.0.1:8791 node test/player-reconnect.e2e.cjs
```

Expected: FAIL because `connect.onOpen` sends stale `setMarch` before the first state.

- [ ] **Step 3: Run impact analysis and report client-state risk**

Run upstream impact for `connect`, `onState`, `showInCard`, and `wireRoom` in `kingshoter/public/kvk.js`. Expected graph risk is LOW, but report that `connect/onState` are central browser-state roots.

- [ ] **Step 4: Implement first-snapshot reconciliation**

Add state:

```js
var initialStateSeen = false, ownPlayerSeen = false, registrationPending = false, pendingMarchMutation = null;
var myProfile = null, deviceId = window.getRoomDeviceId(ROOM);
try { myProfile = JSON.parse(localStorage.getItem(LS('me')) || 'null'); } catch (e) {}
if (myProfile && myProfile.pid) myPid = myProfile.pid;
```

Add helpers:

```js
function saveProfile(profile) {
  myProfile = profile;
  myPid = profile && profile.pid ? profile.pid : '';
  if (profile) wr(LS('me'), JSON.stringify(profile));
  else { try { localStorage.removeItem(LS('me')); } catch (e) {} }
}

function adoptCanonicalPlayer(pid, player) {
  if (!myProfile || pid !== myProfile.pid) return;
  saveProfile(Object.assign({}, myProfile, {
    name: player.name || pid,
    march: player.march,
    marchRevision: Number.isInteger(player.marchRevision) ? player.marchRevision : 0
  }));
  showInCard(myProfile);
}

function registerStoredProfile() {
  if (!myProfile || registrationPending || !sock) return;
  registrationPending = sock.send({
    t: 'registerPlayer', pid: myProfile.pid, name: myProfile.name,
    march: myProfile.march, identityMode: myProfile.identityMode || 'playerId', alliance: ''
  });
}
```

Delete the `setMarch` send from `sock.onOpen`. In `onState`, before assigning `room = r`, distinguish the first snapshot from a later present-to-missing transition. The first missing snapshot may call `registerStoredProfile()`; a later removal after `ownPlayerSeen` must call `saveProfile(null)`, clear `myPid`, show `#fillCard`, and never re-register on that connection.

Configure `sock.onMessage = handleSocketMessage`; add a `handleSocketMessage` branch for `playerMarchSaved` that marks only the matching `mutationId` as acknowledged. Close the pending edit only when both that ACK and a state containing the same pid/march/revision have arrived.

- [ ] **Step 5: Make player Save explicit rather than reconnect-driven**

For a new profile, Save sends `registerPlayer` and waits for the room state before collapsing the form. For an existing profile, Save sends:

```js
{
  t: 'updateOwnMarch',
  mutationId: crypto.randomUUID(),
  pid: myProfile.pid,
  march,
  baseRevision: myProfile.marchRevision
}
```

Keep the draft visible on send failure, `invalid_march`, `player_missing`, or `player_conflict`.

- [ ] **Step 6: Run reconnect, removal-own-device, Defense, and unit regressions**

Run:

```bash
BASE=http://127.0.0.1:8791 node test/player-reconnect.e2e.cjs
BASE=http://127.0.0.1:8791 node test/player-removal-own-device.e2e.cjs
node test/defense.cjs http://127.0.0.1:8791
npm test
```

Expected: server march survives stale reload; remote removal clears identity; Defense still reads canonical own march.

- [ ] **Step 7: Detect scope and commit**

Expected changed symbols: `connect`, `onState`, `showInCard`, `wireRoom`, plus new local helpers. Commit:

```bash
git add kingshoter/public/kvk.js kingshoter/test/player-reconnect.e2e.cjs kingshoter/test/player-removal-own-device.e2e.cjs kingshoter/test/defense.cjs
git commit -m "feat: reconcile KVK players from room state"
```

---

### Task 6: Add Player ID and browser-local Nickname entry modes

**Files:**
- Modify: `kingshoter/public/kvk.html:55-66,160-163`
- Modify: `kingshoter/public/kvk.js:35-113,929-976`
- Modify: `kingshoter/public/app.css:287-304`
- Create: `kingshoter/test/identity-input.e2e.cjs`
- Test: `kingshoter/test/identity-input.e2e.cjs`

**Interfaces:**
- Consumes: explicit registration and profile reconciliation from Task 5.
- Produces: `Player ID — Recommended` default, `Nickname — For testing`, draft-bound lookup, and opaque nickname routing keys.

- [ ] **Step 1: Write failing identity E2E cases**

Use three isolated contexts in one generated QA room. Assert:

- default mode is Player ID and `#pid` has `inputmode="numeric"`;
- switching to Nickname changes the label and removes numeric input mode;
- nickname Save makes no `/api/lookup` request;
- two contexts entering `Tester` receive different `pid` values beginning `n_` and appear as two roster records;
- changing Player ID while a delayed lookup is pending cannot bind the old nickname;
- switching to Nickname clears an already resolved Player ID name.

Use Playwright request routing to delay and then fulfill two `/api/lookup` responses in reverse order, and assert the final `#nameOut` belongs to the current numeric ID.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
BASE=http://127.0.0.1:8791 node test/identity-input.e2e.cjs
```

Expected: FAIL because only numeric Player ID exists and lookup responses are not draft-bound.

- [ ] **Step 3: Run impact analysis for identity-rendering functions**

Run upstream impact for `renderStatics`, `showInCard`, and `wireRoom`. Expected: LOW.

- [ ] **Step 4: Add semantic identity controls**

In `kvk.html`, insert a two-button radiogroup above `#pid`, retaining the existing input ID:

```html
<div class="identityseg" id="identityMode" role="radiogroup" aria-label="Identity type">
  <button type="button" id="identityPlayerId" data-mode="playerId" role="radio" aria-checked="true">Player ID · Recommended</button>
  <button type="button" id="identityNickname" data-mode="nickname" role="radio" aria-checked="false">Nickname · For testing</button>
</div>
<div class="mwrap identityvalue">
  <span class="hint identitylabel" id="identityLabel">Player ID</span>
  <input id="pid" class="identityinput" inputmode="numeric" autocomplete="off">
</div>
```

Add bilingual strings for both mode labels, nickname placeholder, recommended/testing hints, invalid nickname, and duplicate suffix explanation.

- [ ] **Step 5: Implement normalized nickname keys and race-free lookup**

Add:

```js
var identityMode = myProfile && myProfile.identityMode === 'nickname' ? 'nickname' : 'playerId';
var lookupSequence = 0, lookupAbort = null;

function normalizeNickname(value) {
  return Array.from(String(value || '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim().replace(/\s+/g, ' ')).slice(0, 24).join('');
}

function createNicknameRoutingKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(11));
  return 'n_' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function setIdentityMode(mode) {
  identityMode = mode === 'nickname' ? 'nickname' : 'playerId';
  lookupSequence += 1;
  if (lookupAbort) lookupAbort.abort();
  lookupAbort = null;
  $('nameOut').textContent = '';
  $('nameOut').dataset.name = '';
  $('pid').value = '';
  $('pid').setAttribute('inputmode', identityMode === 'playerId' ? 'numeric' : 'text');
  $('identityLabel').textContent = identityMode === 'playerId' ? 'Player ID' : tk('nickname');
  $('identityPlayerId').setAttribute('aria-checked', identityMode === 'playerId' ? 'true' : 'false');
  $('identityNickname').setAttribute('aria-checked', identityMode === 'nickname' ? 'true' : 'false');
}
```

For lookup, capture both a monotonically increasing sequence and the exact numeric draft. Abort the previous request. Accept a response only when mode, sequence, and current input still match.

For Nickname Save, normalize the display name, generate a new `n_` key only once, and store `{identityMode:'nickname', pid, name, march, marchRevision:0}`. Never call `/api/lookup`.

- [ ] **Step 6: Add focused CSS and bump asset versions**

Style `.identityseg` as two 44px sibling buttons with visible focus and a selected state; put the former gap, label width/margin, and input flex rules in `.identityvalue`, `.identitylabel`, and `.identityinput` rather than inline attributes. Do not add horizontal page overflow at 375px. Bump `kvk.js` and `app.css` query versions in `kvk.html`.

- [ ] **Step 7: Run identity, reconnect, and unit tests**

Run:

```bash
BASE=http://127.0.0.1:8791 node test/identity-input.e2e.cjs
BASE=http://127.0.0.1:8791 node test/player-reconnect.e2e.cjs
npm test
```

Expected: all PASS; equal nicknames are separate, and numeric lookup cannot race.

- [ ] **Step 8: Detect scope and commit**

Commit only identity files:

```bash
git add kingshoter/public/kvk.html kingshoter/public/kvk.js kingshoter/public/app.css kingshoter/test/identity-input.e2e.cjs
git commit -m "feat: add KVK Player ID and nickname entry"
```

---

### Task 7: Replace horizontal chips with a canonical vertical roster

**Files:**
- Modify: `kingshoter/public/kvk.html:114-127,151-158`
- Modify: `kingshoter/public/kvk.js:738-801,857-909`
- Modify: `kingshoter/public/app.css:262-273,300-304,458-477`
- Create: `kingshoter/test/roster-control.e2e.cjs`
- Modify: `kingshoter/test/multikingdom.cjs:1-24`
- Test: `kingshoter/test/roster-control.e2e.cjs`

**Interfaces:**
- Consumes: canonical `room.players` and `{pid,role}` selections.
- Produces: `canonicalPick`, `selectOrReplacePlayer`, `openReplacement`, `applyReplacement`, and `renderSlots(kingdom)`.

- [ ] **Step 1: Write failing roster behavior and layout tests**

Create seven players in one QA room, unlock commander, and assert at 375px and 390px:

```js
assert.equal(await page.locator('#roster').evaluate(el => el.scrollWidth <= el.clientWidth), true);
assert.equal(await page.locator('#rosterSearchWrap').isVisible(), true);
assert.equal(await page.locator('#roster .roster-row').count(), 7);
assert.ok((await page.locator('#roster').boundingBox()).height <= 202);
```

Select two players, tap a third, and assert `#replaceOvl` appears while the original two selections stay unchanged. Click `#replaceWeak`, then assert only the Sacrifice PID changed. Assert clicking `.roster-time` or `.roster-actions` does not change `.rp[aria-pressed="true"]` count.

Also migrate `multikingdom.cjs` to `makeQaRoom`, `qaRoomUrl`, and `installQaWebSocketGuard` before its first page so the regression command below cannot open its former ad-hoc room.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
BASE=http://127.0.0.1:8791 node test/roster-control.e2e.cjs
```

Expected: FAIL because the roster scrolls horizontally and silently shifts the first selection.

- [ ] **Step 3: Run impact analysis and warn before CRITICAL edits**

Run:

```text
gitnexus_impact({repo:"kingshot", target:"renderRoster", file_path:"kingshoter/public/kvk.js", direction:"upstream"})
gitnexus_impact({repo:"kingshot", target:"renderSlots", file_path:"kingshoter/public/kvk.js", direction:"upstream"})
```

Expected: both CRITICAL. Report the blast radius: `renderRoster` reaches `renderKingdomPick`, `renderSlots`, `connect`, `onState`, and `openCmd`; `renderSlots` feeds back through `renderRoster`. Continue only after the warning is visible to the user.

- [ ] **Step 4: Store selections as PID and role only**

Add:

```js
function canonicalPick(pid, role, players) {
  var player = players && players[pid];
  return player ? {
    pid: pid,
    role: role === 'main' ? 'main' : 'weak',
    name: player.name || pid,
    march: player.march,
    marchRevision: Number.isInteger(player.marchRevision) ? player.marchRevision : 0
  } : null;
}

function reconcilePicks(players) {
  [1, 2].forEach(function (kingdom) {
    pickedByK[kingdom] = pickedByK[kingdom].filter(function (pick) { return !!players[pick.pid]; })
      .map(function (pick) { return { pid: pick.pid, role: pick.role === 'main' ? 'main' : 'weak' }; });
  });
}
```

Rehydrating staged picks must also create only `{pid,role}`. `fireDouble` and every renderer must call `canonicalPick` immediately before reading name or march.

- [ ] **Step 5: Add explicit replacement DOM and functions**

Add overlay hooks `#replaceOvl`, `#replaceTitle`, `#replaceWeak`, `#replaceMain`, and `#replaceCancel`. Implement:

```js
var pendingReplacementPid = '';

function openReplacement(pid, availableRoles) {
  pendingReplacementPid = pid;
  $('replaceWeak').hidden = availableRoles.indexOf('weak') < 0;
  $('replaceMain').hidden = availableRoles.indexOf('main') < 0;
  $('replaceOvl').classList.add('show');
  $('replaceTitle').textContent = tk('replace_choose');
}

function applyReplacement(pid, role) {
  var current = pickedByK[fireKingdom];
  pickedByK[fireKingdom] = current.filter(function (pick) { return pick.role !== role; })
    .concat([{ pid: pid, role: role }]);
  pendingReplacementPid = '';
  $('replaceOvl').classList.remove('show');
  renderRoster();
  stageBroadcast();
}

function selectOrReplacePlayer(pid) {
  var current = pickedByK[fireKingdom];
  var existing = current.filter(function (pick) { return pick.pid === pid; })[0];
  if (existing) {
    pickedByK[fireKingdom] = current.filter(function (pick) { return pick.pid !== pid; });
  } else if (current.length < 2) {
    var role = current.some(function (pick) { return pick.role === 'weak'; }) ? 'main' : 'weak';
    pickedByK[fireKingdom] = current.concat([{ pid: pid, role: role }]);
  } else {
    openReplacement(pid, ['weak', 'main']);
    return;
  }
  renderRoster();
  stageBroadcast();
}
```

- [ ] **Step 6: Render accessible sibling controls and canonical slots**

Each `.roster-row[data-pid]` must build sibling semantic buttons from the canonical local `pid`:

```js
var safePid = window.esc(pid);
var controls =
  '<button type="button" class="rp" data-pid="' + safePid + '" aria-pressed="false"></button>' +
  '<button type="button" class="roster-role" data-pid="' + safePid + '"></button>' +
  '<button type="button" class="roster-time" data-pid="' + safePid + '"></button>' +
  '<button type="button" class="roster-actions" data-pid="' + safePid + '" aria-haspopup="menu">⋯</button>';
```

`renderSlots(kingdom = fireKingdom)` must resolve both picks through `canonicalPick`; it may not read `pick.name` or `pick.march`.

`renderRoster` keeps selected players first, then present, then stale. It shows `#rosterSearchWrap` only when `Object.keys(room.players).length > 6`; the search input lowercases and trims its draft and filters by both canonical name and PID without changing selection state. Before calling `selectOrReplacePlayer`, the primary button checks the other kingdom's PID/role-only picks; an occupied player stays disabled and its localized explanation names that kingdom.

- [ ] **Step 7: Replace horizontal roster CSS**

Use a one-column grid, `max-height:200px`, `overflow-y:auto`, and `overflow-x:hidden`. Each row is at least 44px; `.rp` fills remaining width; role/time/actions have separate 44px targets. Search appears only for more than six players.

- [ ] **Step 8: Run roster, multi-kingdom, lead, and unit regressions**

Run:

```bash
BASE=http://127.0.0.1:8791 node test/roster-control.e2e.cjs
node test/multikingdom.cjs http://127.0.0.1:8791
for lead in 10 15 30 60; do node test/lead-timing.cjs http://127.0.0.1:8791 "$lead"; done
npm test
```

Expected: all PASS, with no horizontal roster scroll and no timing changes.

- [ ] **Step 9: Detect scope and commit**

Run change detection and inspect every process reported for the two CRITICAL renderers. Commit:

```bash
git add kingshoter/public/kvk.html kingshoter/public/kvk.js kingshoter/public/app.css kingshoter/test/roster-control.e2e.cjs kingshoter/test/multikingdom.cjs
git commit -m "feat: build canonical vertical KVK roster"
```

---

### Task 8: Add commander march editing with ACK-plus-snapshot confirmation

**Files:**
- Modify: `kingshoter/public/kvk.js:35-113,741-801,846-909`
- Modify: `kingshoter/public/app.css`
- Create: `kingshoter/test/march-sync.e2e.cjs`
- Test: `kingshoter/test/march-sync.e2e.cjs`

**Interfaces:**
- Consumes: `setPlayerMarch`, `playerMarchSaved`, canonical roster/slot rendering.
- Produces: inline `MM:SS` editor with revision conflict handling and immediate cross-device reconciliation.

- [ ] **Step 1: Write failing two-commander synchronization tests**

Open player, commander A, and commander B in isolated contexts. Edit the player's 40 seconds to 45 on A and assert A stays pending until both matching ACK and room state are observed. Then assert player page, A roster, A slots, B roster, B slots, and local storage all show `0:45`.

Open an unsaved 46-second draft on B, save 47 on A, and assert B keeps `0:46`, displays canonical `0:47` conflict information, and does not close its editor.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
BASE=http://127.0.0.1:8791 node test/march-sync.e2e.cjs
```

Expected: FAIL because commander rows have no editor or revisioned pending state.

- [ ] **Step 3: Run impact analysis for touched render/state symbols**

Rerun impact for `renderRoster`, `renderSlots`, `onState`, and `connect`; repeat the CRITICAL warning for the renderers.

- [ ] **Step 4: Implement editor lifecycle**

Add state `editingPlayerPid`, `marchDraft`, and `pendingMarchMutation`. The time button opens an inline editor identifying the player. Parse `MM:SS` with:

```js
function parseMMSS(value) {
  var match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  var seconds = Number(match[1]) * 60 + Number(match[2]);
  return Number.isInteger(seconds) && seconds >= 5 && seconds <= 180 ? seconds : null;
}
```

Provide `-5`, `-1`, `+1`, `+5`, Cancel, and Save. Save sends:

```js
{
  t: 'setPlayerMarch',
  mutationId: crypto.randomUUID(),
  password: roomPw,
  pid: editingPlayerPid,
  march: parsedSeconds,
  baseRevision: room.players[editingPlayerPid].marchRevision
}
```

Do not update canonical visible time optimistically. `handleSocketMessage` marks ACK; `onState` marks state; `settleMarchMutation()` closes only when both match. A remote state while the editor is dirty updates the displayed canonical comparison but never overwrites the draft.

Extend the existing `sock.onError` dispatcher with mutation-ID-specific branches: `invalid_march` keeps the draft and shows 5–180 inline; `player_conflict` keeps the draft, displays `latest.march/latest.revision`, and exposes both Adopt latest and Retry buttons (Retry sends a fresh `mutationId` against that latest revision); `player_missing` closes only that stale editor after the next snapshot; `bad_password` reuses the existing password purge and `lockCmd()` path. A closed socket or `sock.send(...) === false` leaves the editor open and unsaved. An error whose `mutationId` does not match `pendingMarchMutation.mutationId` cannot settle or alter the current editor.

- [ ] **Step 5: Add bilingual copy, focus return, and keyboard-safe styling**

Add exact copy for Edit march time, Save, Cancel, latest value, active countdown unchanged, invalid 5–180 range, conflict, retry, and saved confirmation. Restore focus to `.roster-time[data-pid]` on close. Keep the existing `fireDock.nofix` input-focus behavior.

- [ ] **Step 6: Run synchronization and timing regressions**

Run:

```bash
BASE=http://127.0.0.1:8791 node test/march-sync.e2e.cjs
for lead in 10 15 30 60; do node test/lead-timing.cjs http://127.0.0.1:8791 "$lead"; done
node test/defense.cjs http://127.0.0.1:8791
npm test
```

Expected: all PASS; active countdown data remains immutable.

- [ ] **Step 7: Detect scope and commit**

Commit:

```bash
git add kingshoter/public/kvk.js kingshoter/public/app.css kingshoter/test/march-sync.e2e.cjs
git commit -m "feat: synchronize commander march edits"
```

---

### Task 9: Move removal into the player-actions menu and synchronize all managers

**Files:**
- Modify: `kingshoter/public/kvk.html:151-158`
- Modify: `kingshoter/public/kvk.js:35-113,741-801,846-909`
- Modify: `kingshoter/public/app.css`
- Modify: `kingshoter/test/player-removal.e2e.cjs`
- Modify: `kingshoter/test/player-removal-multimanager.e2e.cjs`
- Modify: `kingshoter/test/player-removal-own-device.e2e.cjs`
- Test: the three removal E2E files

**Interfaces:**
- Consumes: staged-aware server removal and canonical selections.
- Produces: `⋯` menu, impact-aware confirmation, active-command protection, and synchronized cleanup.

- [ ] **Step 1: Update E2E expectations to the approved removal behavior**

Replace `.rpdel` usage with `.roster-actions[data-pid]`, then `button[data-action="remove"]`. Add a selected/staged removal scenario that asserts the confirmation lists `Kingdom 1 · Sacrifice`, accepts removal, and leaves both managers with the PID absent and Fire disabled. Add an active-command scenario where the menu item is disabled and a forced WebSocket request receives `player_in_live_command` without clearing staging.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
BASE=http://127.0.0.1:8791 node test/player-removal.e2e.cjs
BASE=http://127.0.0.1:8791 node test/player-removal-multimanager.e2e.cjs
BASE=http://127.0.0.1:8791 node test/player-removal-own-device.e2e.cjs
```

Expected: FAIL because the old persistent delete button blocks selected/staged removal and has no impact summary.

- [ ] **Step 3: Run impact analysis for roster/state functions**

Rerun impact for `renderRoster` and `onState`; report the existing CRITICAL roster risk.

- [ ] **Step 4: Implement player actions and accessible confirmation**

The `⋯` button opens a menu with `data-action="edit-march"` and `data-action="remove"`. The removal overlay must expose `#removePlayerOvl`, `#removePlayerTitle`, `#removePlayerImpact`, `#removePlayerCancel`, and `#removePlayerConfirm`.

Compute staged impact from both kingdoms. Disable only when `room.live.commands` contains an unexpired command whose `payload.pairs` includes the PID. On confirm send:

```js
{ t: 'removePlayer', password: roomPw, pid: pendingRemovePid }
```

Do not alter local picks until the room broadcast removes the player. `onState` calls `reconcilePicks(nextPlayers)` before rendering all rosters and slots. If the removed PID is the current device identity after it was previously observed, clear `kingshoter_r_<room>_me` and `kvk:<room>:delivery-device:v1`, blank the in-memory profile/PID/device values, and return to registration without auto-registering on that connection.

- [ ] **Step 5: Add focus return and 44px styles**

Menu and modal buttons must be semantic, at least 44px, keyboard focusable, and return focus to the originating `.roster-actions` button on Cancel/error. Add bilingual `player_in_live_command`, staged impact, pending, and removed copy.

- [ ] **Step 6: Run removal and cross-manager regressions**

Run all three removal E2E files, `roster-control.e2e.cjs`, `march-sync.e2e.cjs`, and `npm test`. Expected: all PASS.

- [ ] **Step 7: Detect scope and commit**

Commit:

```bash
git add kingshoter/public/kvk.html kingshoter/public/kvk.js kingshoter/public/app.css kingshoter/test/player-removal.e2e.cjs kingshoter/test/player-removal-multimanager.e2e.cjs kingshoter/test/player-removal-own-device.e2e.cjs
git commit -m "feat: make KVK player removal staged-aware"
```

---

### Task 10: Silence unselected commander devices without changing Classic timing

**Files:**
- Modify: `kingshoter/public/kvk.js:291-313`
- Modify: `kingshoter/test/mineaudio.cjs:1-33`
- Modify: `kingshoter/test/alert-truth.cjs:1-56`
- Modify: `kingshoter/test/lead-timing.cjs:1-24`
- Modify: `kingshoter/test/bg.cjs:1-24`
- Test: `kingshoter/test/mineaudio.cjs`
- Test: `kingshoter/test/alert-truth.cjs`

**Interfaces:**
- Consumes: current personal-target calculation and `body.cmdmode` commander state.
- Produces: exact audio audience rules; no ACK behavior yet.

- [ ] **Step 1: Reverse the known-wrong commander assertion**

First migrate `mineaudio.cjs`, `alert-truth.cjs`, `lead-timing.cjs`, and `bg.cjs` to `makeQaRoom`, `qaRoomUrl`, and `installQaWebSocketGuard` before any page opens. Then, in `mineaudio.cjs`, inspect command-specific cue keys rather than the cumulative beep counter. Assert:

```js
ok(captainKeys.some(key => key.includes('-me:')), 'selected captain books personal cues');
ok(joinerKeys.some(key => key.includes('-join:')), 'ordinary member books one JOIN countdown');
ok(!commanderKeys.some(key => /-(?:me|join):/.test(key)), 'unselected commander books no rally cues');
```

Add a second scenario where the commander registers a Player ID, is selected as a captain, fires, and gets `-me:` cues but never `-join:` cues.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node test/mineaudio.cjs http://127.0.0.1:8791
```

Expected: FAIL on unselected commander silence.

- [ ] **Step 3: Run impact analysis for the audio root**

Run:

```text
gitnexus_impact({repo:"kingshot", target:"scheduleAllCues", file_path:"kingshoter/public/kvk.js", direction:"upstream"})
```

GitNexus may report LOW because the scheduler is an execution root; manually report HIGH behavioral risk. Do not edit HIGH-risk `scheduleBeeps`.

- [ ] **Step 4: Implement the minimum audience predicate**

Add:

```js
function isCommanderDevice() {
  return document.body.classList.contains('cmdmode');
}

function shouldBookJoinAudio() {
  return !!myPid && !isCommanderDevice();
}
```

Keep personal scheduling first. Change only the generic branch:

```js
if (!personal && shouldBookJoinAudio()) {
  var join = activeCommand(room);
  if (join && join.type === 'double_rally') scheduleBeeps(join.id + '-join', myTarget(join).anchor, win);
}
```

User-triggered Test Sound remains unchanged.

- [ ] **Step 5: Run audio and lead regressions**

Run:

```bash
node test/mineaudio.cjs http://127.0.0.1:8791
node test/alert-truth.cjs http://127.0.0.1:8791
for lead in 10 15 30 60; do node test/lead-timing.cjs http://127.0.0.1:8791 "$lead"; done
node test/bg.cjs http://127.0.0.1:8791
```

Expected: all PASS; captain/joiner behavior and exact lead cues are unchanged.

- [ ] **Step 6: Detect scope and commit**

Commit:

```bash
git add kingshoter/public/kvk.js kingshoter/test/mineaudio.cjs kingshoter/test/alert-truth.cjs kingshoter/test/lead-timing.cjs kingshoter/test/bg.cjs
git commit -m "fix: silence unselected KVK commanders"
```

---

### Task 11: Add Classic device aggregation and exact scheduled-cue ACK

**Files:**
- Create: `kingshoter/src/room-delivery.js`
- Create: `kingshoter/test/delivery-domain.test.cjs`
- Modify: `kingshoter/src/room.js:44-52,110-118,118-245`
- Modify: `kingshoter/public/kvk.js:15-29,199-209,291-313,373-378,741-819,846-909`
- Modify: `kingshoter/public/app.css:356-357`
- Create: `kingshoter/test/classic-delivery.e2e.cjs`
- Modify: `kingshoter/test/fixes.cjs:1-24`
- Test: `kingshoter/test/delivery-domain.test.cjs`
- Test: `kingshoter/test/classic-delivery.e2e.cjs`

**Interfaces:**
- Consumes: `getRoomDeviceId`, `rallyTargetPids`, commander silence, and existing cue map.
- Produces: private device registry, public per-command aggregates, idempotent `deliveryAck`, and green-only-after-ACK UI.

- [ ] **Step 1: Write failing delivery-domain tests without a two-target assumption**

Create tests for a command containing three arbitrary target pairs. Register two fresh sound-ready devices for PID A and one for B, create the aggregate, and assert expected counts 2, 1, 0. Record A/device-1 scheduled twice and assert received remains 1; record A/device-2 and assert 2; reject a non-target PID; record an expired outcome without incrementing received. Assert serialized public command delivery contains no device IDs.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/delivery-domain.test.cjs
```

Expected: FAIL because `room-delivery.js` does not exist.

- [ ] **Step 3: Implement the bounded pure delivery module**

Create `src/room-delivery.js` with these fixed exports:

```js
import { normalizeRoutingKey, rallyTargetPids } from './room-player.js';

export const DEVICE_TTL_MS = 70000;

export function normalizeDeviceId(value) {
  const id = String(value == null ? '' : value).trim();
  return /^[0-9a-f-]{36}$/i.test(id) ? id : '';
}

export function pruneDevices(devices, nowMs) {
  return (Array.isArray(devices) ? devices : []).filter(device =>
    normalizeRoutingKey(device.pid) && normalizeDeviceId(device.deviceId) && nowMs - Number(device.lastSeenMs) < DEVICE_TTL_MS
  ).slice(-600);
}

export function touchDevice(devices, observation, nowMs) {
  const pid = normalizeRoutingKey(observation && observation.pid);
  const deviceId = normalizeDeviceId(observation && observation.deviceId);
  const next = pruneDevices(devices, nowMs).filter(device => !(device.pid === pid && device.deviceId === deviceId));
  if (pid && deviceId) next.push({ pid, deviceId, soundReady: !!observation.soundReady, lastSeenMs: nowMs });
  return next.slice(-600);
}

export function startCommandDelivery(command, devices, nowMs) {
  const fresh = pruneDevices(devices, nowMs);
  return rallyTargetPids(command).map(pid => ({
    pid,
    expected: new Set(fresh.filter(device => device.pid === pid && device.soundReady).map(device => device.deviceId)).size,
    received: 0,
    expired: 0
  }));
}

export function recordCommandAck(command, ackRecords, message, nowMs) {
  const commandId = String(message && message.commandId || '');
  const pid = normalizeRoutingKey(message && message.pid);
  const deviceId = normalizeDeviceId(message && message.deviceId);
  const outcome = message && message.outcome === 'expired' ? 'expired' : message && message.outcome === 'scheduled' ? 'scheduled' : '';
  const targetUTC = Number(message && message.targetUTC);
  const scheduledAtMs = Number(message && message.scheduledAtMs);
  if (!command || command.id !== commandId || !rallyTargetPids(command).includes(pid)) return { ok: false, error: 'ack_target_missing', ackRecords };
  if (!deviceId || !outcome || !Number.isFinite(targetUTC) || !Number.isFinite(scheduledAtMs)) return { ok: false, error: 'invalid_ack', ackRecords };
  const pair = command.payload.pairs.find(value => value.pid === pid);
  if (!pair || Math.abs(Number(pair.pressUTC) - targetUTC) > 0.001) return { ok: false, error: 'invalid_ack_target', ackRecords };
  const records = (Array.isArray(ackRecords) ? ackRecords : []).filter(record => nowMs - Number(record.atMs) < 3600000).slice(-1199);
  if (records.some(record => record.commandId === commandId && record.pid === pid && record.deviceId === deviceId)) {
    return { ok: true, changed: false, ackRecords: records };
  }
  records.push({ commandId, pid, deviceId, outcome, atMs: nowMs });
  const aggregate = command.delivery.find(value => value.pid === pid);
  if (aggregate) {
    if (outcome === 'scheduled') aggregate.received += 1;
    else aggregate.expired += 1;
    aggregate.expected = Math.max(aggregate.expected, aggregate.received + aggregate.expired);
  }
  return { ok: true, changed: true, ackRecords: records };
}

export function removePlayerDelivery(devices, ackRecords, pid) {
  return {
    devices: (Array.isArray(devices) ? devices : []).filter(device => device.pid !== pid),
    ackRecords: (Array.isArray(ackRecords) ? ackRecords : []).filter(record => record.pid !== pid)
  };
}
```

- [ ] **Step 4: Run pure delivery tests and verify GREEN**

Run:

```bash
node --test test/delivery-domain.test.cjs
```

Expected: PASS for arbitrary pair count, deduplication, expiry, and privacy.

- [ ] **Step 5: Write failing multi-context Classic ACK E2E**

Use isolated contexts for commander-only, Captain A device 1, Captain A device 2, Captain B, and ordinary member. Install the QA guard before pages. Fire once and assert:

- commander-only has no rally cues;
- both A devices and B schedule personal cues;
- ordinary member schedules JOIN but sends no `deliveryAck`;
- immediately after Fire status is `Sent`, not green;
- after ACK, A shows `Received 2/2`, B `Received ✓`;
- dropping A device 2 client `deliveryAck` with `shouldDropClientMessage` yields `Received 1/2` while its local audio cue still exists;
- duplicate room snapshots and repeated ACK messages do not increase counts or duplicate cues;
- a target whose AudioContext cannot schedule never becomes green.

Migrate `fixes.cjs` to `makeQaRoom`, `qaRoomUrl`, and `installQaWebSocketGuard` in the same RED commit, before the regression is invoked later in this task.

- [ ] **Step 6: Run impact analysis for server/client ACK integration**

Run upstream impact for `Room.constructor`, `Room.webSocketMessage`, `enableSound`, `scheduleAllCues`, `renderRoster`, `renderSlots`, `connect`, and `onState`. Repeat CRITICAL warnings for roster/slots and manual HIGH warning for the scheduler. Do not edit HIGH-risk `snapshot` or `scheduleBeeps`.

- [ ] **Step 7: Persist private device state and public aggregates in Room**

Load `devices` and `deliveryAcks` alongside `room` in the constructor. Add:

```js
async persistAll() {
  await this.state.storage.put({ room: this.room, devices: this.devices, deliveryAcks: this.deliveryAcks });
}
```

On `deviceStatus` and extended `hb`, update private devices and persist them on the existing 20-second throttle. At command creation, after the command gets its UUID, set:

```js
command.delivery = startCommandDelivery(command, this.devices, this.nowMs());
```

On `deliveryAck`, locate the current command by exact ID across kingdoms, call `recordCommandAck`, and only when `changed` is true assign the returned records, call `persistAll()` once, and `broadcast()` once. Invalid/spoofed/non-target ACKs do not mutate room state.

On successful player removal, call `removePlayerDelivery`, assign both private arrays, then use `persistAll()` once before broadcast.

- [ ] **Step 8: ACK only after a future personal cue exists**

Add client helpers without changing `scheduleBeeps`:

```js
var acknowledgedCommands = Object.create(null);

function hasFuturePersonalCue(baseKey) {
  var nowMs = window.serverNow();
  return Object.keys(scheduledBeeps).some(function (key) {
    var cue = scheduledBeeps[key];
    return key.indexOf(baseKey + ':') === 0 && cue.t > nowMs - 150 && cue.nodes && cue.nodes.length;
  });
}

function sendDeviceStatus() {
  if (!sock || !myPid) return false;
  return sock.send({ t: 'deviceStatus', pid: myPid, deviceId: deviceId, soundReady: soundReady });
}

function acknowledgeClassicCommand(command, target) {
  if (!sock || !target.mine || !myPid) return;
  var key = command.id + ':' + myPid + ':' + deviceId;
  var nowMs = window.serverNow();
  var outcome = target.anchor * 1000 <= nowMs ? 'expired' : hasFuturePersonalCue(command.id + '-me') ? 'scheduled' : '';
  if (!outcome || acknowledgedCommands[key]) return;
  var sent = sock.send({
    t: 'deliveryAck', commandId: command.id, pid: myPid, deviceId: deviceId,
    outcome: outcome, targetUTC: target.anchor, scheduledAtMs: nowMs
  });
  if (sent) acknowledgedCommands[key] = true;
}
```

Call `sendDeviceStatus()` after registration reconciliation, after `enableSound`, and in the 25-second heartbeat. In `scheduleAllCues`, call `acknowledgeClassicCommand` only after personal `scheduleBeeps`/`schedulePrepareCue` calls.

- [ ] **Step 9: Render truthful command status and neutral presence**

Add `deliveryForPlayer(command, pid)` with the stable return contract `{ kind: 'sent'|'received'|'missing'|'expired', text: string } | null`. It looks up the exact PID in `command.delivery`, computes command age from `Date.parse(command.at)`, and returns:

- `Sent` for the first 1.5 seconds with zero ACK;
- `Received ✓` when received is 1 and expected is at most 1;
- `Received n/m` when expected is greater than 1;
- `No confirmation` after 1.5 seconds with zero ACK;
- `Expired` when expired is nonzero and received is zero.

Both the Double slot renderer and future pair-count extensions must render the returned text as `<span class="delivery KIND">…</span>` using `window.esc(status.text)`. Use a dedicated `.delivery.received` green class. Change roster presence glyphs from green/red to neutral teal/gray and change `.syncpill.allgo` away from `--green-deep`; presence must not visually claim exact receipt.

- [ ] **Step 10: Run delivery, audio, lead, cancel, and reconnect regressions**

Run:

```bash
node --test test/delivery-domain.test.cjs
BASE=http://127.0.0.1:8791 node test/classic-delivery.e2e.cjs
node test/mineaudio.cjs http://127.0.0.1:8791
node test/fixes.cjs http://127.0.0.1:8791
node test/bg.cjs http://127.0.0.1:8791
for lead in 10 15 30 60; do node test/lead-timing.cjs http://127.0.0.1:8791 "$lead"; done
BASE=http://127.0.0.1:8791 node test/player-reconnect.e2e.cjs
npm test
```

Expected: all PASS; exact receipt is green only after scheduled-cue ACK; no duplicate or stale cues.

- [ ] **Step 11: Detect scope and commit**

Inspect all affected processes for the CRITICAL renderers and audio root. Commit:

```bash
git add kingshoter/src/room-delivery.js kingshoter/src/room.js kingshoter/public/kvk.js kingshoter/public/app.css kingshoter/test/delivery-domain.test.cjs kingshoter/test/classic-delivery.e2e.cjs kingshoter/test/fixes.cjs
git commit -m "feat: acknowledge exact Classic KVK delivery"
```

---

### Task 12: Consolidate multi-browser QA and prove Classic rollback invariants

**Files:**
- Create: `kingshoter/test/kvk-core-multibrowser.e2e.cjs`
- Modify: `kingshoter/test/lead-timing.cjs:3-7`
- Modify: `kingshoter/test/mineaudio.cjs:3-9`
- Modify: `kingshoter/test/alert-truth.cjs:3-7`
- Modify: `kingshoter/test/player-removal.e2e.cjs:4-7`
- Modify: `kingshoter/test/player-removal-multimanager.e2e.cjs:4-7`
- Modify: `kingshoter/test/player-removal-own-device.e2e.cjs:4-7`
- Modify: `kingshoter/package.json:4-10`
- Test: `kingshoter/test/kvk-core-multibrowser.e2e.cjs`

**Interfaces:**
- Consumes: every core interface and QA helper from prior tasks.
- Produces: one disposable-room acceptance suite and a repeatable command for Chromium, Firefox, and WebKit.

- [ ] **Step 1: Make every touched browser test consume the shared QA gate**

Replace ad-hoc room names with `makeQaRoom({ title: require('node:path').basename(__filename, '.cjs') })`, build URLs with `qaRoomUrl`, and call `installQaWebSocketGuard(context, room)` before opening each page. There must be no literal operation room and no fallback production host in these core tests; default base is `http://127.0.0.1:8791`.

- [ ] **Step 2: Write the consolidated acceptance suite**

For each requested engine, use independent contexts for:

1. commander-only;
2. Captain A;
3. Captain B;
4. ordinary member;
5. Captain A second device with the same numeric Player ID;
6. nickname Tester browser 1;
7. nickname Tester browser 2;
8. commander registered and selected as captain in a separate command.

Cover exact 10-second lead, personal/ordinary/commander audio routing, `Received 1/2` and `2/2`, Player ID/nickname semantics, remote march update, explicit third-player replacement, staged removal, live-command removal rejection, cancel, and reconnect without stale overwrite.

Accept `--project=chromium|firefox|webkit|all`; launch the matching Playwright browser object without using shared contexts.

- [ ] **Step 3: Add package scripts**

Add:

```json
"test:kvk-core": "node test/kvk-core-multibrowser.e2e.cjs --project=chromium",
"test:kvk-core:all": "node test/kvk-core-multibrowser.e2e.cjs --project=all"
```

- [ ] **Step 4: Install browser runtimes and run the complete local matrix**

Run:

```bash
npx playwright install chromium firefox webkit
npm test
npm run test:kvk-core:all
for lead in 10 15 30 60; do node test/lead-timing.cjs http://127.0.0.1:8791 "$lead"; done
BASE=http://127.0.0.1:8791 node test/march-sync.e2e.cjs
BASE=http://127.0.0.1:8791 node test/player-removal-multimanager.e2e.cjs
```

Expected: all unit and browser tests PASS in freshly generated `qa-kvk-*` rooms. A WebKit pass is reported as WebKit desktop automation, never as an iPhone test.

- [ ] **Step 5: Verify rollback boundary**

Add a compatibility case whose server snapshot omits the additive `delivery` aggregate and whose server ignores `deviceStatus`/`deliveryAck`. Assert the page throws no error, captains still get the same personal cues, and ordinary members still get JOIN. The shared correctness fixes remain active: unselected commander silence, identity modes, canonical march, and staged-aware removal. The production page must not expose a mode selector, rollback button, or hidden test switch.

- [ ] **Step 6: Run final syntax, scope, and dirty-tree checks**

Run:

```bash
node --check src/room-player.js
node --check src/room-delivery.js
node --check src/room.js
node --check public/app.js
node --check public/kvk.js
git status --short
```

Run `gitnexus_detect_changes({scope:"all", repo:"kingshot"})`. Expected affected scope is player registration/update/removal, commander roster/slots, Classic audio audience, and exact receipt. No Defense calculation, counter-rally, Push, stream, gift, or production-room flow may appear unexpectedly.

- [ ] **Step 7: Commit the consolidated QA suite**

```bash
git add kingshoter/package.json kingshoter/test/kvk-core-multibrowser.e2e.cjs kingshoter/test/lead-timing.cjs kingshoter/test/mineaudio.cjs kingshoter/test/alert-truth.cjs kingshoter/test/player-removal.e2e.cjs kingshoter/test/player-removal-multimanager.e2e.cjs kingshoter/test/player-removal-own-device.e2e.cjs
git commit -m "test: verify KVK core across isolated browsers"
```

## Final Acceptance Checklist

- [ ] `npm test` is green.
- [ ] Chromium, Firefox, and WebKit QA suites are green in generated `qa-kvk-*` rooms.
- [ ] No automated connection or mutation targets any operation room.
- [ ] A stale reconnect cannot change canonical march or revision.
- [ ] Player and commander march saves synchronize to every context and handle conflicts without silent overwrite.
- [ ] Fire freezes canonical values; a later edit does not change active countdown/audio.
- [ ] The roster has no horizontal scroll at 375px or 390px; replacement, edit, and removal are separate actions.
- [ ] Selected/staged removal clears every staged reference; active-command removal is atomic and rejected.
- [ ] Player ID is recommended; equal Nickname test identities remain distinct.
- [ ] Unselected commander is silent; selected commander receives personal audio; ordinary member receives one JOIN cue.
- [ ] Green `Received` is produced only by exact scheduled-cue ACK and survives later connection loss as command history.
- [ ] Presence, AudioContext, WebSocket, and heartbeat states never masquerade as `Received`.
- [ ] Classic remains the only production audio authority and has no public mode selector.
- [ ] No Reliable, Triple, Push, Stream, native-app, or external-message implementation entered this plan's commits.
- [ ] GitNexus change detection shows only the approved core scope before every commit.
