# KvK Reliable Shadow Delivery and QA Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a QA-only Reliable shadow channel that challenges devices, sends immutable captain-targeted command metadata, records exact Classic and candidate acknowledgements, retries without changing timing, and proves the behavior through guarded multi-BrowserContext tests while Classic remains the sole audio authority.

**Architecture:** Keep the existing room-state broadcast and AudioContext scheduler untouched as the production path. A small pure delivery model owns versioned private state, target/device attempts, ACK facts, cancellation, expiry, and bounded summaries; the Durable Object stores that model under a separate key and multiplexes its retries with the existing single alarm. A no-audio browser adapter runs only when both the room is a valid qa-kvk-* room and deliveryShadow=1, while shared QA helpers reject every operation room before any connection.

**Tech Stack:** Cloudflare Workers and Durable Objects, WebSocket Hibernation attachments, browser JavaScript with no build step, Node.js node:test, Playwright 1.61.1, Chromium/Firefox/WebKit BrowserContexts.

## Global Constraints

- Complete docs/superpowers/plans/2026-07-13-kvk-core-player-control.md first. This plan consumes, and does not recreate, test/support/qa-kvk.cjs, test/room-harness.cjs, window.getRoomDeviceId(room), RoomSocket.onMessage, or Core's merge-safe `attachSocket/readSocketAttachment/writeSocketAttachment` methods.
- test/support/qa-kvk.cjs exports assertQaRoomName(room), makeQaRoom(testInfo), qaRoomUrl(baseURL, room, params = {}), and installQaWebSocketGuard(context, room, options = {}).
- installQaWebSocketGuard options are exactly { shouldDropClientMessage?: ({ url: string, data: string | Buffer }) => boolean, shouldDropServerMessage?: ({ url: string, data: string | Buffer }) => boolean }. It validates the expected room and the WebSocket URL room before connectToServer(), forwards frames unchanged by default, and drops only frames whose predicate returns true.
- test/room-harness.cjs exports loadRoom(): Promise<{ Room }>, createRoomHarness(Room, options = {}), and claimRoom(harness, password = 'commander-secret').
- kingshoter/package.json already has type=module when this plan starts; all tests remain .cjs.
- public/app.js already exposes window.getRoomDeviceId(room): string using local-storage key kvk:<room>:delivery-device:v1, and RoomSocket delivers additive non-state/non-error messages through .onMessage.
- The core plan's production deliveryAck/deliveryAckSaved handshake, private devices/deliveryAcks, command.delivery aggregate, Received UI, and exact Classic cue ACK remain authoritative and continue in every room. Reliable mirrors a validated, persisted Core ACK for comparison; it never replaces, delays, or intercepts the server's saved confirmation.
- Core owns attachment `roomName`, `pid`, `deviceId`, and `soundReady`. Reliable hello/probe code may read but never overwrite those fields; a shadow hello whose claimed identity does not exactly match the bound Core identity is rejected before challenge or persistence.
- Classic is always the only code allowed to create, schedule, stop, or play audio nodes. Reliable computes would-schedule facts, ACKs, retries, cancellation, and telemetry only.
- Reliable is enabled only when the URL room passes the qa-kvk-* guard and deliveryShadow=1. A non-QA room with deliveryShadow=1 still runs Classic and sends no Reliable hello.
- Every server-side message whose type begins with deliveryShadow is rejected uniformly with { t: 'error', error: 'qa_room_required' } when its WebSocket attachment is not QA. Production deliveryAck is not a shadow message and must never enter this guard. There is no room-name exception, including no branch for 1406.
- All automated and manual mutations use a newly generated qa-kvk-* room. Local QA runs before any production-connected QA run.
- Candidate messages are additive and versioned with v: 1. Old clients ignore them and room data needs no destructive migration.
- Fire persists, schedules the Classic expiry alarm, and broadcasts Classic state before any Reliable work. Reliable exceptions never cancel, delay, or re-fire an order.
- Candidate retry sends the byte-equivalent deliveryShadowCommand envelope with the same commandId, fireAtMs, and expiry. It never recalculates timing.
- Durable Object alarms are at-least-once. A repeated wake may resend the same immutable envelope; model transitions and client commandId dedupe must remain idempotent.
- Public snapshots contain aggregate counts only. pid, deviceId, socket attachment details, ACK timestamps, probe IDs, user agents, and private delivery records never appear in room.players or a public snapshot.
- Private delivery history is schema-normalized, capped at 32 commands, and pruned 60 seconds after its final useful or cancelled timestamp.
- delivery:v1 uses the existing Durable Object storage namespace; do not add a binding, class migration, or wrangler.toml change.
- Do not change core player identity UI, nickname UI, roster UI, normal commander status UI, or normal player copy in this plan.
- Do not add any out-of-scope rally mode, backup transport, audio transport, mode picker, build pipeline, build/version manifest, or native/PWA companion.
- Do not describe Playwright WebKit as physical iOS evidence. Desktop automation can prove routing, dedupe, state transitions, and timing calculations only.
- Before editing every existing function, class, or method, run GitNexus upstream impact and report the direct callers, affected processes, and risk level to the user before editing. Warn before every HIGH or CRITICAL edit, then proceed under the user's standing approval; snapshot() is already expected to be HIGH risk because it participates in fetch, alarm, close, and error flows.
- Resolve `KVK_WORKTREE` and `GITNEXUS_REPO` with the master plan's executable worktree block before using this leaf. In every GitNexus example, pass the printed literal repository name.
- Before every implementation commit, stage only the current task and run `gitnexus_detect_changes({scope:"staged", repo:"$GITNEXUS_REPO"})`; verify that only the task's named symbols and flows changed.
- Continuous `stableSince`/`Online Xm` UI is deferred. The eight-second `audioArmed` lease is a private QA readiness fact, resets on challenge failure/expiry, and is never rendered as an invented continuous duration or as Classic `Received`.
- Preserve unrelated dirty-worktree content and stage only files named by the current task.

## File and Interface Map

**Core-plan prerequisites consumed unchanged:**

- kingshoter/test/support/qa-kvk.cjs — universal QA room/network guard and fault injection.
- kingshoter/test/room-harness.cjs — ESM Room loader and Durable Object test harness.
- kingshoter/public/app.js — window.getRoomDeviceId(room) and RoomSocket.onMessage.

**Create:**

- kingshoter/src/delivery.js — pure schema, QA predicate, immutable command targets, attempts, ACKs, summaries, cancellation, expiry, and bounds.
- kingshoter/public/kvk-delivery-shadow.js — pure no-audio browser controller for hello, probe ACK, shadow computation, dedupe, and cancel.
- kingshoter/test/delivery-model.test.cjs
- kingshoter/test/room-delivery.test.cjs
- kingshoter/test/delivery-shadow-client.test.cjs
- kingshoter/test/qa-kvk-delivery-guard.test.cjs
- kingshoter/test/qa-kvk-delivery.spec.cjs
- kingshoter/playwright.qa-kvk.config.cjs
- kingshoter/docs/qa/kvk-reliable-shadow.md

**Modify:**

- kingshoter/src/room.js — private storage, socket attachments, QA protocol guard, challenge lease, targeted dispatch, ACK records, retries, cancellation, aggregate snapshot, and one-alarm orchestration.
- kingshoter/public/kvk.html — load the isolated shadow adapter after app.js and before kvk.js.
- kingshoter/public/kvk.js — instantiate the adapter behind the double gate and forward RoomSocket shadow messages without touching core audio/ACK/UI.
- kingshoter/package.json — add focused Reliable unit and QA scripts; do not change dependencies or type=module.
- kingshoter/test/worker-security.test.cjs — retain the exact Classic alarm expectation after alarm multiplexing.

---

### Task 1: Pure Versioned Delivery Model

**Files:**
- Create: kingshoter/src/delivery.js
- Create: kingshoter/test/delivery-model.test.cjs

**Interfaces:**
- Consumes: canonical double_rally command objects and normalized socket attachments.
- Produces: DELIVERY_VERSION, DELIVERY_STORAGE_KEY, DELIVERY_PROBE_INTERVAL_MS, DELIVERY_ARMED_LEASE_MS, DELIVERY_RETRY_DELAYS_MS, DELIVERY_ACK_WINDOW_MS, DELIVERY_RETRY_CUTOFF_MS, DELIVERY_AUDIO_GRACE_MS, DELIVERY_HISTORY_TTL_MS, DELIVERY_MAX_COMMANDS, isQaRoomName(room), defaultDeliveryState(roomName), normalizeDeliveryState(raw, nowMs), normalizeDeliveryAttachment(raw, roomName), createDeliveryRecord(command, nowMs), upsertDeliveryTarget(state, commandId, attachment, nowMs), dueDeliveryTargets(state, nowMs), recordDeliveryAttempt(state, action, nowMs), recordClassicAck(state, attachment, message, nowMs), recordShadowAck(state, attachment, message, nowMs), cancelDeliveryRecord(state, commandId, nowMs), publicDeliverySummary(state, nowMs), nextDeliveryWakeAt(state, nowMs), and pruneDeliveryState(state, nowMs).

- [ ] **Step 1: Write the failing model tests**

Create kingshoter/test/delivery-model.test.cjs:

~~~js
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function load() {
  return import(pathToFileURL(path.join(__dirname, '../src/delivery.js')).href + '?t=' + Date.now());
}

const command = {
  id: 'cmd-1',
  type: 'double_rally',
  kingdom: 1,
  payload: {
    leadSeconds: 10,
    pairs: [
      { pid: '700001', role: 'weak', march: 31, pressUTC: 1010 },
      { pid: '700002', role: 'main', march: 30, pressUTC: 1011 }
    ]
  }
};

const attachment = (pid, deviceId) => ({
  v: 1, roomName: 'qa-kvk-model-a', qa: true, pid, deviceId,
  view: 'player', shadow: true, audioArmed: true, armedUntilMs: 1_020_000,
  lastProbeId: '', probeExpiresAtMs: 0, nextProbeAtMs: 0
});

test('the QA predicate rejects every operation or malformed room uniformly', async () => {
  const { isQaRoomName } = await load();
  for (const room of ['operation-room', 'demo', '_', '', 'qa-kvk-', 'qa-kvk-bad_', 'QA-KVK-UPPER']) {
    assert.equal(isQaRoomName(room), false, room);
  }
  for (const room of ['qa-kvk-a', 'qa-kvk-20260713-7f3a']) assert.equal(isQaRoomName(room), true, room);
});

test('one immutable record holds role-specific frozen timing and two devices for one pid', async () => {
  const mod = await load();
  const state = mod.defaultDeliveryState('qa-kvk-model-a');
  state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
  const a1 = mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_000);
  const a2 = mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000002'), 1_000_000);
  const b1 = mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700002', '00000000-0000-4000-8000-000000000003'), 1_000_000);
  assert.equal(mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_001), a1);
  assert.equal(state.commands[0].targets.length, 3);
  assert.deepEqual(a1.envelope, {
    t: 'deliveryShadowCommand', v: 1, shadow: true, commandId: 'cmd-1',
    pid: '700001', role: 'weak', kingdom: 1, issuedAtMs: 1_000_000,
    fireAtMs: 1_010_000, audioExpiresAtMs: 1_010_150,
    marchSeconds: 31, leadSeconds: 10
  });
  assert.equal(a2.envelope.fireAtMs, 1_010_000);
  assert.equal(b1.envelope.fireAtMs, 1_011_000);
  for (let i = 0; i < 30; i++) {
    mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', 'extra-' + i), 1_000_000);
  }
  assert.equal(state.commands[0].targets.length, 24);
});

test('initial send and 500/1500ms retries reuse the exact envelope and stop at the cutoff', async () => {
  const mod = await load();
  const state = mod.defaultDeliveryState('qa-kvk-model-a');
  state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
  mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_000);

  const bytes = [];
  for (const now of [1_000_000, 1_000_500, 1_001_500]) {
    const due = mod.dueDeliveryTargets(state, now);
    assert.equal(due.length, 1);
    bytes.push(JSON.stringify(due[0].envelope));
    assert.equal(mod.recordDeliveryAttempt(state, due[0], now), true);
  }
  assert.equal(new Set(bytes).size, 1);
  assert.deepEqual(mod.dueDeliveryTargets(state, 1_002_000), []);

  const nearCutoff = mod.defaultDeliveryState('qa-kvk-model-a');
  nearCutoff.commands.push(mod.createDeliveryRecord(command, 1_009_600));
  mod.upsertDeliveryTarget(nearCutoff, 'cmd-1', attachment('700001', 'dev-late'), 1_009_600);
  assert.deepEqual(mod.dueDeliveryTargets(nearCutoff, 1_009_600), []);
});

test('a mirrored Core ACK must match the challenged socket identity and public output stays aggregate-only', async () => {
  const mod = await load();
  const state = mod.defaultDeliveryState('qa-kvk-model-a');
  state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
  mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_000);
  assert.equal(mod.recordClassicAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryAck', commandId: 'cmd-1', pid: 'forged',
    deviceId: 'forged', outcome: 'scheduled', targetUTC: 1010, scheduledAtMs: 1_000_100
  }, 1_000_100), false);
  assert.equal(mod.recordClassicAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryAck', commandId: 'cmd-1', pid: '700001',
    deviceId: '00000000-0000-4000-8000-000000000001', outcome: 'scheduled', targetUTC: 1010, scheduledAtMs: 1_000_100
  }, 1_000_100), true);
  assert.equal(mod.recordShadowAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-1',
    result: 'would_schedule', futureCueCount: 6
  }, 1_000_110), true);
  const summary = mod.publicDeliverySummary(state, 1_000_120);
  assert.deepEqual(summary, {
    v: 1,
    commands: [{
      commandId: 'cmd-1', expectedDevices: 1, classicScheduled: 1,
      candidateAcked: 1, expired: 0, cancelled: false
    }]
  });
  const json = JSON.stringify(summary);
  assert.doesNotMatch(json, /700001|dev-a1|forged|issuedAtMs|armedUntilMs/);
});

test('duplicate ACKs do not downgrade a success, cancel is explicit, and history is bounded', async () => {
  const mod = await load();
  const state = mod.defaultDeliveryState('qa-kvk-model-a');
  state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
  mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_000);
  mod.recordShadowAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-1',
    result: 'would_schedule', futureCueCount: 5
  }, 1_000_100);
  assert.equal(mod.recordShadowAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-1',
    result: 'duplicate', futureCueCount: 5
  }, 1_000_200), false);
  assert.equal(mod.cancelDeliveryRecord(state, 'cmd-1', 1_000_300), true);
  assert.equal(mod.publicDeliverySummary(state, 1_000_301).commands[0].cancelled, true);

  for (let i = 0; i < 40; i++) {
    const c = structuredClone(command); c.id = 'cmd-' + (i + 2);
    c.payload.pairs[0].pressUTC = 1_110 + i;
    c.payload.pairs[1].pressUTC = 1_111 + i;
    state.commands.push(mod.createDeliveryRecord(c, 1_100_000 + i));
  }
  mod.pruneDeliveryState(state, 1_100_100);
  assert.equal(state.commands.length, 32);
  assert.ok(state.commands.every((record) => record.commandId !== 'cmd-1'));
});

test('history wake and pruning use the final useful ACK timestamp', async () => {
  const mod = await load();
  const state = mod.defaultDeliveryState('qa-kvk-model-a');
  state.commands.push(mod.createDeliveryRecord(command, 1_000_000));
  mod.upsertDeliveryTarget(state, 'cmd-1', attachment('700001', '00000000-0000-4000-8000-000000000001'), 1_000_000);
  mod.recordShadowAck(state, attachment('700001', '00000000-0000-4000-8000-000000000001'), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-1',
    result: 'expired', futureCueCount: 0
  }, 1_040_000);
  assert.equal(mod.nextDeliveryWakeAt(state, 1_040_001), 1_100_000);
  assert.equal(mod.pruneDeliveryState(state, 1_099_999), false);
  assert.equal(mod.pruneDeliveryState(state, 1_100_001), true);
  assert.deepEqual(state.commands, []);
});
~~~

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/delivery-model.test.cjs

Expected: FAIL with ERR_MODULE_NOT_FOUND for src/delivery.js; no assertion should run before that import.

- [ ] **Step 3: Implement the complete pure model**

Create kingshoter/src/delivery.js:

~~~js
export const DELIVERY_VERSION = 1;
export const DELIVERY_STORAGE_KEY = 'delivery:v1';
export const DELIVERY_PROBE_INTERVAL_MS = 3_000;
export const DELIVERY_ARMED_LEASE_MS = 8_000;
export const DELIVERY_RETRY_DELAYS_MS = Object.freeze([500, 1_500]);
export const DELIVERY_ACK_WINDOW_MS = 2_000;
export const DELIVERY_RETRY_CUTOFF_MS = 500;
export const DELIVERY_AUDIO_GRACE_MS = 150;
export const DELIVERY_HISTORY_TTL_MS = 60_000;
export const DELIVERY_MAX_COMMANDS = 32;

const QA_ROOM_RE = /^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/;
const RESULTS = new Set(['scheduled', 'would_schedule', 'audio_unarmed', 'expired', 'duplicate']);
const SHADOW_RESULTS = new Set(['would_schedule', 'audio_unarmed', 'expired', 'duplicate']);
const DELIVERY_MAX_TARGETS = 24;

const text = (value, max) => String(value == null ? '' : value).slice(0, max);
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const int = (value, fallback) => Math.trunc(finite(value, fallback));
const role = (value) => value === 'main' ? 'main' : 'weak';

export function isQaRoomName(room) {
  return typeof room === 'string' && room.length <= 48 && QA_ROOM_RE.test(room);
}

export function defaultDeliveryState(roomName = '') {
  return { v: DELIVERY_VERSION, roomName: isQaRoomName(roomName) ? roomName : '', commands: [] };
}

export function normalizeDeliveryAttachment(raw, roomName) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const normalizedRoom = text(roomName || raw.roomName, 48);
  return {
    v: DELIVERY_VERSION,
    roomName: normalizedRoom,
    qa: isQaRoomName(normalizedRoom),
    pid: text(raw.pid, 24),
    deviceId: text(raw.deviceId, 64),
    soundReady: raw.soundReady === true,
    view: raw.view === 'commander' ? 'commander' : 'player',
    shadow: raw.shadow === true,
    audioArmed: raw.audioArmed === true,
    armedUntilMs: Math.max(0, int(raw.armedUntilMs, 0)),
    lastProbeId: text(raw.lastProbeId, 64),
    probeExpiresAtMs: Math.max(0, int(raw.probeExpiresAtMs, 0)),
    nextProbeAtMs: Math.max(0, int(raw.nextProbeAtMs, 0))
  };
}

function normalizeAck(raw) {
  if (!raw || typeof raw !== 'object' || !RESULTS.has(raw.result)) return null;
  return {
    result: raw.result,
    futureCueCount: Math.max(0, Math.min(12, int(raw.futureCueCount, 0))),
    atMs: Math.max(0, int(raw.atMs, 0))
  };
}

function normalizeAudience(raw) {
  const pid = text(raw && raw.pid, 24);
  const fireAtMs = Math.max(0, int(raw && raw.fireAtMs, 0));
  if (!pid || !fireAtMs) return null;
  return {
    pid,
    role: role(raw.role),
    fireAtMs,
    audioExpiresAtMs: Math.max(fireAtMs, int(raw.audioExpiresAtMs, fireAtMs + DELIVERY_AUDIO_GRACE_MS)),
    marchSeconds: Math.max(0, int(raw.marchSeconds, 0)),
    leadSeconds: Math.max(1, Math.min(120, int(raw.leadSeconds, 10)))
  };
}

function normalizeTarget(raw, record) {
  const pid = text(raw && raw.pid, 24);
  const deviceId = text(raw && raw.deviceId, 64);
  const audience = record.audiences.find((item) => item.pid === pid);
  if (!pid || !deviceId || !audience) return null;
  const envelope = Object.freeze({
    t: 'deliveryShadowCommand', v: DELIVERY_VERSION, shadow: true,
    commandId: record.commandId, pid, role: audience.role, kingdom: record.kingdom,
    issuedAtMs: record.issuedAtMs, fireAtMs: audience.fireAtMs,
    audioExpiresAtMs: audience.audioExpiresAtMs,
    marchSeconds: audience.marchSeconds, leadSeconds: audience.leadSeconds
  });
  return {
    pid,
    deviceId,
    envelope,
    attempts: Math.max(0, Math.min(16, int(raw.attempts, 0))),
    nextRetryAtMs: Math.max(0, int(raw.nextRetryAtMs, record.issuedAtMs)),
    classicAck: normalizeAck(raw.classicAck),
    candidateAck: normalizeAck(raw.candidateAck)
  };
}

function normalizeRecord(raw) {
  const commandId = text(raw && raw.commandId, 64);
  const issuedAtMs = Math.max(0, int(raw && raw.issuedAtMs, 0));
  if (!commandId || !issuedAtMs) return null;
  const record = {
    commandId,
    kingdom: raw.kingdom === 2 ? 2 : 1,
    issuedAtMs,
    cancelledAtMs: raw.cancelledAtMs == null ? null : Math.max(0, int(raw.cancelledAtMs, 0)),
    audiences: (Array.isArray(raw.audiences) ? raw.audiences : []).map(normalizeAudience).filter(Boolean).slice(0, 3),
    targets: []
  };
  record.targets = (Array.isArray(raw.targets) ? raw.targets : [])
    .map((target) => normalizeTarget(target, record)).filter(Boolean).slice(0, DELIVERY_MAX_TARGETS);
  return record.audiences.length ? record : null;
}

export function normalizeDeliveryState(raw, nowMs = Date.now()) {
  const source = raw && typeof raw === 'object' && raw.v === DELIVERY_VERSION ? raw : {};
  const state = defaultDeliveryState(source.roomName);
  state.commands = (Array.isArray(source.commands) ? source.commands : [])
    .map(normalizeRecord).filter(Boolean);
  pruneDeliveryState(state, nowMs);
  return state;
}

export function createDeliveryRecord(command, nowMs) {
  if (!command || command.type !== 'double_rally' || !text(command.id, 64)) return null;
  const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
  const leadSeconds = Math.max(1, Math.min(120, int(payload.leadSeconds, 10)));
  const audiences = (Array.isArray(payload.pairs) ? payload.pairs : []).slice(0, 2).map((pair) => {
    const fireAtMs = Math.round(finite(pair && pair.pressUTC, 0) * 1000);
    return normalizeAudience({
      pid: pair && pair.pid,
      role: pair && pair.role,
      fireAtMs,
      audioExpiresAtMs: fireAtMs + DELIVERY_AUDIO_GRACE_MS,
      marchSeconds: pair && pair.march,
      leadSeconds
    });
  }).filter(Boolean);
  if (audiences.length !== 2 || audiences[0].pid === audiences[1].pid) return null;
  return {
    commandId: text(command.id, 64),
    kingdom: command.kingdom === 2 ? 2 : 1,
    issuedAtMs: Math.max(0, int(nowMs, Date.now())),
    cancelledAtMs: null,
    audiences,
    targets: []
  };
}

export function upsertDeliveryTarget(state, commandId, attachment, nowMs) {
  const record = state.commands.find((item) => item.commandId === text(commandId, 64));
  const a = normalizeDeliveryAttachment(attachment, attachment && attachment.roomName);
  const audience = record && record.audiences.find((item) => item.pid === a.pid);
  if (!record || record.cancelledAtMs != null || !a.qa || !a.shadow || !a.deviceId || !audience) return null;
  if (nowMs >= audience.audioExpiresAtMs) return null;
  let target = record.targets.find((item) => item.pid === a.pid && item.deviceId === a.deviceId);
  if (target) {
    if (!target.candidateAck && nowMs < audience.fireAtMs - DELIVERY_RETRY_CUTOFF_MS) target.nextRetryAtMs = nowMs;
    return target;
  }
  if (record.targets.length >= DELIVERY_MAX_TARGETS) return null;
  target = normalizeTarget({
    pid: a.pid, deviceId: a.deviceId, attempts: 0,
    nextRetryAtMs: nowMs, classicAck: null, candidateAck: null
  }, record);
  record.targets.push(target);
  return target;
}

export function dueDeliveryTargets(state, nowMs) {
  const due = [];
  for (const record of state.commands) {
    if (record.cancelledAtMs != null) continue;
    for (const target of record.targets) {
      if (target.candidateAck || !target.nextRetryAtMs || target.nextRetryAtMs > nowMs) continue;
      if (nowMs >= target.envelope.fireAtMs - DELIVERY_RETRY_CUTOFF_MS) continue;
      due.push({
        commandId: record.commandId,
        pid: target.pid,
        deviceId: target.deviceId,
        envelope: target.envelope
      });
    }
  }
  return due;
}

function findTarget(state, input) {
  const record = state.commands.find((item) => item.commandId === text(input.commandId, 64));
  const target = record && record.targets.find((item) =>
    item.pid === text(input.pid, 24) && item.deviceId === text(input.deviceId, 64));
  return { record, target };
}

export function recordDeliveryAttempt(state, action, nowMs) {
  const { record, target } = findTarget(state, action);
  if (!record || !target || target.candidateAck || record.cancelledAtMs != null) return false;
  target.attempts = Math.min(16, target.attempts + 1);
  target.nextRetryAtMs = DELIVERY_RETRY_DELAYS_MS
    .map((delay) => record.issuedAtMs + delay)
    .find((atMs) => atMs > nowMs) || 0;
  return true;
}

export function recordClassicAck(state, attachment, message, nowMs) {
  const a = normalizeDeliveryAttachment(attachment, attachment && attachment.roomName);
  if (!a.qa || !a.shadow || !message || !['scheduled', 'expired'].includes(message.outcome)) return false;
  if (text(message.pid, 24) !== a.pid || text(message.deviceId, 64) !== a.deviceId) return false;
  const { target } = findTarget(state, {
    commandId: message.commandId, pid: a.pid, deviceId: a.deviceId
  });
  if (!target || target.classicAck) return false;
  target.classicAck = {
    result: message.outcome,
    futureCueCount: message.outcome === 'scheduled' ? 1 : 0,
    atMs: Math.max(0, int(nowMs, Date.now()))
  };
  return true;
}

export function recordShadowAck(state, attachment, message, nowMs) {
  const a = normalizeDeliveryAttachment(attachment, attachment && attachment.roomName);
  if (!a.qa || !a.shadow || !message || message.v !== DELIVERY_VERSION || !SHADOW_RESULTS.has(message.result)) return false;
  const { target } = findTarget(state, {
    commandId: message.commandId, pid: a.pid, deviceId: a.deviceId
  });
  if (!target || target.candidateAck) return false;
  const futureCueCount = Math.max(0, Math.min(12, int(message.futureCueCount, 0)));
  target.candidateAck = {
    result: message.result,
    futureCueCount,
    atMs: Math.max(0, int(nowMs, Date.now()))
  };
  target.nextRetryAtMs = 0;
  return true;
}

export function cancelDeliveryRecord(state, commandId, nowMs) {
  const record = state.commands.find((item) => item.commandId === text(commandId, 64));
  if (!record || record.cancelledAtMs != null) return false;
  record.cancelledAtMs = Math.max(0, int(nowMs, Date.now()));
  for (const target of record.targets) target.nextRetryAtMs = 0;
  return true;
}

export function publicDeliverySummary(state, nowMs) {
  const commands = state.commands.slice(-4).map((record) => ({
    commandId: record.commandId,
    expectedDevices: record.targets.length,
    classicScheduled: record.targets.filter((target) =>
      target.classicAck && target.classicAck.result === 'scheduled').length,
    candidateAcked: record.targets.filter((target) =>
      target.candidateAck && (
        target.candidateAck.result === 'would_schedule' ||
        (target.candidateAck.result === 'duplicate' && target.candidateAck.futureCueCount > 0)
      )).length,
    expired: record.targets.filter((target) =>
      (target.candidateAck && target.candidateAck.result === 'expired') ||
      (!target.candidateAck && nowMs > target.envelope.audioExpiresAtMs)).length,
    cancelled: record.cancelledAtMs != null
  }));
  return { v: DELIVERY_VERSION, commands };
}

function deliveryRecordFinalAt(record) {
  if (record.cancelledAtMs != null) return record.cancelledAtMs;
  return Math.max(
    0,
    ...record.audiences.map((audience) => audience.audioExpiresAtMs),
    ...record.targets.flatMap((target) => [
      target.classicAck ? target.classicAck.atMs : 0,
      target.candidateAck ? target.candidateAck.atMs : 0
    ])
  );
}

export function nextDeliveryWakeAt(state, nowMs) {
  let next = null;
  for (const record of state.commands) {
    if (record.cancelledAtMs == null) {
      for (const target of record.targets) {
        const at = target.candidateAck ? 0 : target.nextRetryAtMs;
        if (at && nowMs < target.envelope.fireAtMs - DELIVERY_RETRY_CUTOFF_MS) {
          next = next == null ? at : Math.min(next, at);
        }
      }
    }
    const pruneAtMs = deliveryRecordFinalAt(record) + DELIVERY_HISTORY_TTL_MS;
    if (pruneAtMs > 0) next = next == null ? Math.max(nowMs, pruneAtMs) : Math.min(next, Math.max(nowMs, pruneAtMs));
  }
  return next;
}

export function pruneDeliveryState(state, nowMs) {
  const before = state.commands.length;
  state.commands = state.commands.filter((record) => {
    return nowMs <= deliveryRecordFinalAt(record) + DELIVERY_HISTORY_TTL_MS;
  }).slice(-DELIVERY_MAX_COMMANDS);
  return state.commands.length !== before;
}
~~~

- [ ] **Step 4: Run the model tests**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/delivery-model.test.cjs

Expected: PASS for all six subtests, ending with # fail 0.

- [ ] **Step 5: Run the full pre-integration suite**

Run: cd $KVK_WORKTREE/kingshoter && npm test

Expected: all core-plan and existing unit tests pass, ending with # fail 0.

- [ ] **Step 6: Detect scope and commit**

Call gitnexus_detect_changes({scope:"staged", repo:"$GITNEXUS_REPO"}) and verify only the new delivery model symbols and delivery-model test are reported.

~~~bash
git add kingshoter/src/delivery.js kingshoter/test/delivery-model.test.cjs
git commit -m "feat: add reliable delivery shadow model"
~~~

---

### Task 2: Durable Object Private Boundary, QA Guard, and Socket Challenge

**Files:**
- Create: kingshoter/test/room-delivery.test.cjs
- Modify: kingshoter/src/room.js

**Interfaces:**
- Consumes: Task 1 model exports, the core plan's loadRoom()/createRoomHarness() helpers, and Core-owned `Room.attachSocket/readSocketAttachment/writeSocketAttachment`.
- Produces: Room.issueDeliveryProbe(ws, attachment, nowMs), Room.handleDeliveryShadowMessage(ws, message), and Room.persistDelivery(); it extends but does not recreate Core socket attachment methods.
- Core's read/write helpers preserve additive server-owned fields such as a later `clientBuild`. Reliable always passes a normalized Reliable-only patch through Core's shallow-merge writer, so a probe or hello cannot erase Core identity or another protocol's field.
- Core owns `{ roomName, pid, deviceId, soundReady }`. Reliable owns exactly `{ v, qa, view, shadow, audioArmed, armedUntilMs, lastProbeId, probeExpiresAtMs, nextProbeAtMs }`. `normalizeDeliveryAttachment()` copies bounded Core identity only for pure model decisions, but Reliable write patches never source those fields from a shadow message; server integration always begins from Core's normalized attachment and unrelated additive fields are preserved by Core's merge API.
- Private storage key is exactly delivery:v1 and never becomes a property of this.room.

- [ ] **Step 1: Run impact analysis and report the known snapshot risk**

Call these before editing:

~~~text
gitnexus_impact({target:"Room.constructor",direction:"upstream"})
gitnexus_impact({target:"Room.fetch",direction:"upstream"})
gitnexus_impact({target:"snapshot",direction:"upstream"})
gitnexus_impact({target:"webSocketMessage",direction:"upstream"})
gitnexus_impact({target:"persist",direction:"upstream"})
~~~

Expected: snapshot reports HIGH risk with three direct callers and the fetch/alarm/close/error processes. Report that blast radius to the user before changing it. If any other target is HIGH or CRITICAL, re-map and report its affected process before proceeding under the standing approval.

- [ ] **Step 2: Write failing boundary and challenge tests**

Create kingshoter/test/room-delivery.test.cjs:

~~~js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness } = require('./room-harness.cjs');

function fakeSocket(roomName) {
  let attachment = {
    roomName, pid: '', deviceId: '', soundReady: false,
    v: 1, qa: roomName.startsWith('qa-kvk-'),
    view: 'player', shadow: false, audioArmed: false, armedUntilMs: 0,
    lastProbeId: '', probeExpiresAtMs: 0, nextProbeAtMs: 0
  };
  const sent = [];
  return {
    sent,
    send(value) { sent.push(JSON.parse(value)); },
    serializeAttachment(value) { attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(attachment); }
  };
}

test('constructor loads room and private delivery records from separate keys', async () => {
  const { Room } = await loadRoom();
  let boot;
  const gets = [];
  const state = {
    blockConcurrencyWhile(fn) { boot = fn(); },
    storage: {
      async get(key) {
        if (Array.isArray(key)) {
          gets.push(...key);
          return new Map(key.map((name) => [
            name,
            name === 'delivery:v1' ? { v: 1, roomName: 'qa-kvk-load-a', commands: [] } : null
          ]));
        }
        gets.push(key);
        if (key === 'room') return null;
        if (key === 'delivery:v1') return { v: 1, roomName: 'qa-kvk-load-a', commands: [] };
        return null;
      }
    }
  };
  const instance = new Room(state, {});
  await boot;
  assert.ok(gets.includes('room'));
  assert.ok(gets.includes('delivery:v1'));
  assert.equal(instance.delivery.roomName, 'qa-kvk-load-a');
  assert.equal(Object.prototype.hasOwnProperty.call(instance.room, 'delivery'), false);
});

test('Reliable extends the Core attachment without replacing identity or later fields', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  const events = [];
  const ws = fakeSocket('qa-kvk-attach-a');
  const originalSerialize = ws.serializeAttachment.bind(ws);
  ws.serializeAttachment = (value) => { events.push('attachment'); originalSerialize(value); };
  h.room.state.acceptWebSocket = () => events.push('accept');
  h.room.attachSocket(ws, 'qa-kvk-attach-a');
  assert.deepEqual(events, ['accept', 'attachment']);
  h.room.writeSocketAttachment(ws, {
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001',
    soundReady: true, clientBuild: 7
  });
  const merged = h.room.writeSocketAttachment(ws, {
    v: 1, qa: true, view: 'player', shadow: true, audioArmed: true,
    armedUntilMs: 0, lastProbeId: '', probeExpiresAtMs: 0, nextProbeAtMs: 0
  });
  assert.equal(merged.clientBuild, 7);
  assert.equal(merged.pid, '700001');
  assert.equal(merged.deviceId, '00000000-0000-4000-8000-000000000001');
  assert.equal(merged.soundReady, true);
  assert.equal(ws.deserializeAttachment().clientBuild, 7);
  assert.equal(ws.deserializeAttachment().audioArmed, true);
});

test('all non-QA shadow messages receive the same error and never mutate storage', async () => {
  const { Room } = await loadRoom();
  for (const roomName of ['operation-room', 'demo', '_', 'qa-kvk-']) {
    const h = createRoomHarness(Room);
    const ws = fakeSocket(roomName);
    const writes = [];
    h.room.persistDelivery = async () => writes.push('delivery');
    await h.room.webSocketMessage(ws, JSON.stringify({
      t: 'deliveryShadowHello', v: 1, shadow: true, pid: '700001',
      deviceId: '00000000-0000-4000-8000-000000000001', view: 'player', audioArmed: true
    }));
    assert.deepEqual(ws.sent, [{ t: 'error', error: 'qa_room_required' }], roomName);
    assert.deepEqual(writes, [], roomName);
  }
});

test('QA hello requires the bound Core identity, never rewrites it, and sends a challenge', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  const ws = fakeSocket('qa-kvk-hello-a');
  const writes = [];
  h.room.delivery = { v: 1, roomName: '', commands: [] };
  h.room.persistDelivery = async () => writes.push('delivery');
  h.room.scheduleExpiry = async () => writes.push('alarm');
  h.room._deliveryNow = () => 50_000;
  h.room.writeSocketAttachment(ws, {
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001', soundReady: true
  });
  await h.room.webSocketMessage(ws, JSON.stringify({
    t: 'deliveryShadowHello', v: 1, shadow: true, pid: '700001',
    deviceId: '00000000-0000-4000-8000-000000000001', view: 'commander', audioArmed: true
  }));
  const saved = ws.deserializeAttachment();
  assert.equal(saved.pid, '700001');
  assert.equal(saved.deviceId, '00000000-0000-4000-8000-000000000001');
  assert.equal(saved.view, 'commander');
  assert.equal(saved.audioArmed, false);
  assert.equal(saved.probeExpiresAtMs, 52_000);
  assert.equal(saved.nextProbeAtMs, 53_000);
  assert.match(saved.lastProbeId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(ws.sent, [{
    t: 'deliveryShadowProbe', v: 1, probeId: saved.lastProbeId,
    sentAtMs: 50_000, expiresAtMs: 52_000
  }]);
  assert.deepEqual(writes, ['delivery', 'alarm']);
});

test('a shadow hello cannot claim another Core socket identity', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  h.room.writeSocketAttachment(h.ws, {
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001', soundReady: true
  });
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'deliveryShadowHello', v: 1, shadow: true, pid: '700002',
    deviceId: '00000000-0000-4000-8000-000000000002', view: 'player'
  }));
  assert.deepEqual(h.ws.sent.at(-1), { t: 'error', error: 'core_identity_mismatch' });
  assert.equal(h.ws.deserializeAttachment().pid, '700001');
  assert.equal(h.ws.deserializeAttachment().shadow, false);
});

test('only the matching unexpired probe ACK grants the eight-second audio-armed lease', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  const ws = fakeSocket('qa-kvk-probe-a');
  const attachment = ws.deserializeAttachment();
  Object.assign(attachment, {
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001', soundReady: true, shadow: true,
    lastProbeId: 'probe-1', probeExpiresAtMs: 52_000
  });
  ws.serializeAttachment(attachment);
  h.room._deliveryNow = () => 51_000;
  h.room.scheduleExpiry = async () => {};
  await h.room.webSocketMessage(ws, JSON.stringify({
    t: 'deliveryShadowProbeAck', v: 1, probeId: 'wrong', audioArmed: true
  }));
  assert.equal(ws.deserializeAttachment().audioArmed, false);
  await h.room.webSocketMessage(ws, JSON.stringify({
    t: 'deliveryShadowProbeAck', v: 1, probeId: 'probe-1', audioArmed: true
  }));
  assert.equal(ws.deserializeAttachment().audioArmed, true);
  assert.equal(ws.deserializeAttachment().armedUntilMs, 59_000);
});

test('snapshot exposes bounded aggregate counts but no private attachment or storage fields', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  h.room.delivery = {
    v: 1, roomName: 'qa-kvk-snapshot-a',
    commands: [{
      commandId: 'cmd-public', kingdom: 1, issuedAtMs: Date.now(),
      cancelledAtMs: null,
      audiences: [{ pid: '700001', role: 'weak', fireAtMs: Date.now() + 10_000,
        audioExpiresAtMs: Date.now() + 10_150, marchSeconds: 31, leadSeconds: 10 }],
      targets: [{
        pid: '700001', deviceId: 'device-secret',
        envelope: { commandId: 'cmd-public', fireAtMs: Date.now() + 10_000, audioExpiresAtMs: Date.now() + 10_150 },
        attempts: 1, nextRetryAtMs: 0,
        classicAck: { result: 'scheduled', futureCueCount: 5, atMs: Date.now() },
        candidateAck: null
      }]
    }]
  };
  const json = JSON.stringify(h.room.snapshot());
  assert.match(json, /"deliveryShadow"/);
  assert.match(json, /"classicScheduled":1/);
  assert.doesNotMatch(json, /700001|device-secret|armedUntilMs|nextRetryAtMs|classicAck|delivery:v1/);
});
~~~

- [ ] **Step 3: Run the boundary tests and verify the first missing behavior**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/room-delivery.test.cjs

Expected: FAIL because the constructor has not loaded `delivery:v1` and Reliable challenge handlers do not exist. Core `Room.attachSocket/readSocketAttachment/writeSocketAttachment` already pass their prerequisite tests and must not be recreated here.

- [ ] **Step 4: Add the private state import, constructor load, socket attachment, and public aggregate**

Add this import at the start of kingshoter/src/room.js:

~~~js
import {
  DELIVERY_VERSION,
  DELIVERY_STORAGE_KEY,
  DELIVERY_PROBE_INTERVAL_MS,
  DELIVERY_ARMED_LEASE_MS,
  DELIVERY_ACK_WINDOW_MS,
  defaultDeliveryState,
  normalizeDeliveryState,
  normalizeDeliveryAttachment,
  isQaRoomName,
  publicDeliverySummary
} from './delivery.js';
~~~

Preserve the core constructor's room, devices, and deliveryAcks loading. Add these initializers beside its existing instance fields:

~~~js
this.roomName = '';
this.delivery = defaultDeliveryState();
~~~

Inside the existing blockConcurrencyWhile callback, after core room/devices/deliveryAcks normalization and normalizeLive(), add:

~~~js
const storedDelivery = await state.storage.get(DELIVERY_STORAGE_KEY);
this.delivery = normalizeDeliveryState(storedDelivery, this._deliveryNow());
~~~

Do not replace or reinitialize this.devices, this.deliveryAcks, command.delivery, or the core persistence methods.

Add this clock method immediately after normalizeLive():

~~~js
_deliveryNow() { return Date.now(); }
~~~

Do not replace Core's WebSocket upgrade or recreate its attachment methods. Extend the existing `fetch()` only at these points:

~~~js
// after Core parses and stores the exact room
this.roomName = roomName;

// immediately after Core attachSocket(server, roomName), before the first state send
const reliableDefaults = normalizeDeliveryAttachment(
  this.readSocketAttachment(server), roomName
);
this.writeSocketAttachment(server, {
  v: reliableDefaults.v, qa: reliableDefaults.qa, view: reliableDefaults.view,
  shadow: reliableDefaults.shadow, audioArmed: reliableDefaults.audioArmed,
  armedUntilMs: reliableDefaults.armedUntilMs, lastProbeId: reliableDefaults.lastProbeId,
  probeExpiresAtMs: reliableDefaults.probeExpiresAtMs,
  nextProbeAtMs: reliableDefaults.nextProbeAtMs
});
~~~

The patch sent to `writeSocketAttachment` is derived from the already-bound current attachment, never from client-supplied identity. Core's method remains the only serializer/normalizer of `pid`, `deviceId`, and `soundReady`.

At the end of snapshot(), immediately before return r, add:

~~~js
if (isQaRoomName(this.delivery.roomName)) {
  const summary = publicDeliverySummary(this.delivery, this._deliveryNow());
  if (summary.commands.length) r.deliveryShadow = summary;
}
~~~

Do not add this.delivery to this.room and do not spread private state into r.

- [ ] **Step 5: Add the shadow-only guard and challenge handlers**

Add these methods immediately before webSocketMessage():

~~~js
async persistDelivery() {
  await this.state.storage.put(DELIVERY_STORAGE_KEY, this.delivery);
}

deliveryError(ws, error) {
  ws.send(JSON.stringify({ t: 'error', error }));
}

issueDeliveryProbe(ws, attachment, nowMs) {
  const next = normalizeDeliveryAttachment(attachment, attachment.roomName);
  next.lastProbeId = crypto.randomUUID();
  next.probeExpiresAtMs = nowMs + DELIVERY_ACK_WINDOW_MS;
  next.nextProbeAtMs = nowMs + DELIVERY_PROBE_INTERVAL_MS;
  const stored = this.writeSocketAttachment(ws, {
    v: next.v, qa: next.qa, view: next.view, shadow: next.shadow,
    audioArmed: next.audioArmed, armedUntilMs: next.armedUntilMs,
    lastProbeId: next.lastProbeId, probeExpiresAtMs: next.probeExpiresAtMs,
    nextProbeAtMs: next.nextProbeAtMs
  });
  try {
    ws.send(JSON.stringify({
      t: 'deliveryShadowProbe',
      v: DELIVERY_VERSION,
      probeId: next.lastProbeId,
      sentAtMs: nowMs,
      expiresAtMs: next.probeExpiresAtMs
    }));
  } catch (error) {}
  return stored;
}

async handleDeliveryShadowMessage(ws, message) {
  const nowMs = this._deliveryNow();
  const current = this.readSocketAttachment(ws);
  if (!current.qa) return this.deliveryError(ws, 'qa_room_required');

  if (message.t === 'deliveryShadowHello') {
    if (message.pid !== current.pid || message.deviceId !== current.deviceId ||
        !current.pid || !current.deviceId || current.soundReady !== true) {
      return this.deliveryError(ws, 'core_identity_mismatch');
    }
    const next = normalizeDeliveryAttachment({
      ...current,
      view: message.view,
      shadow: message.v === DELIVERY_VERSION && message.shadow === true,
      audioArmed: false,
      armedUntilMs: 0
    }, current.roomName);
    if (!next.shadow) return this.deliveryError(ws, 'bad_delivery_hello');
    this.delivery.roomName = current.roomName;
    this.writeSocketAttachment(ws, {
      v: next.v, qa: next.qa, view: next.view, shadow: next.shadow,
      audioArmed: next.audioArmed, armedUntilMs: next.armedUntilMs,
      lastProbeId: next.lastProbeId, probeExpiresAtMs: next.probeExpiresAtMs,
      nextProbeAtMs: next.nextProbeAtMs
    });
    this.issueDeliveryProbe(ws, next, nowMs);
    await this.persistDelivery();
    await this.scheduleExpiry();
    return;
  }

  if (message.t === 'deliveryShadowProbeAck') {
    if (!current.shadow || message.v !== DELIVERY_VERSION ||
        message.probeId !== current.lastProbeId || nowMs > current.probeExpiresAtMs) return;
    current.audioArmed = message.audioArmed === true;
    current.armedUntilMs = current.audioArmed ? nowMs + DELIVERY_ARMED_LEASE_MS : 0;
    current.lastProbeId = '';
    current.probeExpiresAtMs = 0;
    this.writeSocketAttachment(ws, {
      v: current.v, qa: current.qa, view: current.view, shadow: current.shadow,
      audioArmed: current.audioArmed, armedUntilMs: current.armedUntilMs,
      lastProbeId: current.lastProbeId, probeExpiresAtMs: current.probeExpiresAtMs,
      nextProbeAtMs: current.nextProbeAtMs
    });
    await this.scheduleExpiry();
    return;
  }

  return this.deliveryError(ws, 'unsupported_delivery_message');
}
~~~

Immediately after JSON parsing at the top of webSocketMessage(), insert:

~~~js
if (typeof m.t === 'string' && m.t.startsWith('deliveryShadow')) {
  return this.handleDeliveryShadowMessage(ws, m);
}
~~~

This insertion must remain before the core branches, but it matches deliveryShadow only. The existing production deliveryAck branch remains below it and unchanged.

- [ ] **Step 6: Run boundary, security, and full unit tests**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/room-delivery.test.cjs test/worker-security.test.cjs

Expected: all room-delivery and worker-security subtests pass, ending with # fail 0. The existing Classic alarm test still records exactly [['set', 150600], ['delete']].

Run: cd $KVK_WORKTREE/kingshoter && npm test

Expected: all tests pass, ending with # fail 0.

- [ ] **Step 7: Detect scope and commit**

Call gitnexus_detect_changes({scope:"staged", repo:"$GITNEXUS_REPO"}). Expected existing symbols: Room.constructor, Room.fetch, snapshot, and webSocketMessage; expected new symbols are the attachment, challenge, and private-persistence methods. No player, audio, or other out-of-scope flow may appear.

~~~bash
git add kingshoter/src/room.js kingshoter/test/room-delivery.test.cjs
git commit -m "feat: add private reliable socket challenge"
~~~

---

### Task 3: Classic-First Targeted Dispatch and Shadow Comparison Facts

**Files:**
- Modify: kingshoter/test/room-delivery.test.cjs
- Modify: kingshoter/src/room.js

**Interfaces:**
- Consumes: immutable Task 1 records, Task 2 attachments, canonical command.id, payload.pairs, pressUTC, march, role, and leadSeconds.
- Produces: Room.flushDeliveryTargets(nowMs), Room.dispatchDeliveryForCommand(command, nowMs), Room.recordReliableClassicAck(ws, canonicalIdentity, message, nowMs), candidate deliveryShadowCommand messages, and deliveryShadowAck processing.
- The Core production handshake remains exactly as defined by the prerequisite plan: client `{ t:'deliveryAck', commandId, pid, deviceId, outcome, targetUTC, scheduledAtMs }`, followed only after authoritative persistence by exact server `{ t:'deliveryAckSaved', ...same immutable fields }`. Reliable observes the persisted result after Core validation and never emits, consumes, delays, or substitutes the saved confirmation.
- deliveryShadowAck is exactly { t: 'deliveryShadowAck', v: 1, commandId: string, result: 'would_schedule'|'audio_unarmed'|'expired'|'duplicate', futureCueCount: integer 0..12 }. pid/deviceId fields are absent; server identity comes from the attachment.
- A duplicate ACK carries the original futureCueCount only when the first result was would_schedule; otherwise it carries 0, so a dropped success ACK can recover without misclassifying a duplicate unarmed or expired result.
- deliveryShadowCommand is exactly { t: 'deliveryShadowCommand', v: 1, shadow: true, commandId, pid, role, kingdom, issuedAtMs, fireAtMs, audioExpiresAtMs, marchSeconds, leadSeconds }.

- [ ] **Step 1: Run impact analysis before changing Fire and message routing**

~~~text
gitnexus_context({name:"webSocketMessage"})
gitnexus_impact({target:"webSocketMessage",direction:"upstream"})
gitnexus_impact({target:"broadcast",direction:"upstream"})
~~~

Expected: LOW risk based on the current graph. If the core plan changed the graph to HIGH or CRITICAL, report the new callers and processes before editing.

- [ ] **Step 2: Append failing dispatch and ACK tests**

Append to kingshoter/test/room-delivery.test.cjs:

~~~js
function armedSocket(pid, deviceId, view = 'player') {
  const ws = fakeSocket('qa-kvk-dispatch-a');
  const value = ws.deserializeAttachment();
  Object.assign(value, {
    pid, deviceId, soundReady: true, view, shadow: true, audioArmed: true,
    armedUntilMs: 1_020_000
  });
  ws.serializeAttachment(value);
  return ws;
}

function installDoubleRoom(h) {
  h.room.room.players = {
    '700001': { name: 'A', march: 31 },
    '700002': { name: 'B', march: 30 },
    '700003': { name: 'Member', march: 25 }
  };
  h.room.room.live = {
    mode: 'idle', commands: { 1: null, 2: null },
    staged: { 1: null, 2: null }, sim: null
  };
  h.room.delivery = { v: 1, roomName: 'qa-kvk-dispatch-a', commands: [] };
  h.room.authOK = async () => true;
  h.room._deliveryNow = () => 1_000_000;
}

test('Fire broadcasts Classic before sending immutable metadata only to selected devices', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  installDoubleRoom(h);
  const a1 = armedSocket('700001', '00000000-0000-4000-8000-000000000001');
  const a2 = armedSocket('700001', '00000000-0000-4000-8000-000000000002');
  const b1 = armedSocket('700002', '00000000-0000-4000-8000-000000000003');
  const member = armedSocket('700003', '00000000-0000-4000-8000-000000000004');
  const commanderOnly = armedSocket('', '00000000-0000-4000-8000-000000000005');
  const order = [];
  for (const ws of [a1, a2, b1, member, commanderOnly]) {
    const send = ws.send.bind(ws);
    ws.send = (value) => {
      const parsed = JSON.parse(value);
      if (parsed.t === 'deliveryShadowCommand') order.push('candidate:' + ws.deserializeAttachment().deviceId);
      send(value);
    };
  }
  h.room.state.getWebSockets = () => [a1, a2, b1, member, commanderOnly];
  h.room.persistAll = async () => order.push('classic-persist');
  h.room.persist = async () => order.push('classic-persist');
  h.room.scheduleExpiry = async () => order.push('alarm');
  h.room.broadcast = () => order.push('classic-broadcast');
  h.room.persistDelivery = async () => order.push('delivery-persist');

  await h.room.webSocketMessage(fakeSocket('qa-kvk-dispatch-a'), JSON.stringify({
    t: 'cmd', password: 'pw',
    cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 1010,
      payload: {
        leadSeconds: 10, firstPress: 1010, kingdom: 1,
        pairs: [
          { pid: '700001', role: 'weak', march: 31, pressUTC: 1010 },
          { pid: '700002', role: 'main', march: 30, pressUTC: 1011 }
        ]
      }
    }
  }));

  const classicIndex = order.indexOf('classic-broadcast');
  const firstCandidate = order.findIndex((entry) => entry.startsWith('candidate:'));
  assert.ok(classicIndex >= 0 && firstCandidate > classicIndex, JSON.stringify(order));
  const commands = [a1, a2, b1, member, commanderOnly]
    .flatMap((ws) => ws.sent.filter((message) => message.t === 'deliveryShadowCommand'));
  assert.equal(commands.length, 3);
  assert.deepEqual(commands.map((message) => message.deviceId), [undefined, undefined, undefined]);
  assert.deepEqual(new Set(commands.map((message) => message.commandId)).size, 1);
  assert.deepEqual(commands.map((message) => message.pid).sort(), ['700001', '700001', '700002']);
  assert.equal(member.sent.some((message) => message.t === 'deliveryShadowCommand'), false);
  assert.equal(commanderOnly.sent.some((message) => message.t === 'deliveryShadowCommand'), false);
  assert.equal(h.room.delivery.commands[0].targets.length, 3);
});

test('Classic scheduled and candidate would-schedule ACKs are per attached device', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  installDoubleRoom(h);
  const a1 = armedSocket('700001', '00000000-0000-4000-8000-000000000001');
  h.room.state.getWebSockets = () => [a1];
  h.room.persistDelivery = async () => {};
  h.room.scheduleExpiry = async () => {};
  h.room.broadcast = () => {};
  const canonical = {
    id: 'cmd-ack', type: 'double_rally', kingdom: 1,
    payload: {
      leadSeconds: 10,
      pairs: [
        { pid: '700001', role: 'weak', march: 31, pressUTC: 1010 },
        { pid: '700002', role: 'main', march: 30, pressUTC: 1011 }
      ]
    }
  };
  await h.room.dispatchDeliveryForCommand(canonical, 1_000_000);
  assert.equal(await h.room.recordReliableClassicAck(a1, {
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001'
  }, {
    t: 'deliveryAck', commandId: 'cmd-ack',
    pid: 'forged', deviceId: 'forged',
    outcome: 'scheduled', targetUTC: 1010, scheduledAtMs: 1_000_100
  }, 1_000_100), false);
  assert.equal(await h.room.recordReliableClassicAck(a1, {
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001'
  }, {
    t: 'deliveryAck', commandId: 'cmd-ack',
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001',
    outcome: 'scheduled', targetUTC: 1010, scheduledAtMs: 1_000_100
  }, 1_000_100), true);
  await h.room.webSocketMessage(a1, JSON.stringify({
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-ack',
    result: 'would_schedule', futureCueCount: 6
  }));
  const summary = h.room.snapshot().deliveryShadow.commands[0];
  assert.deepEqual(summary, {
    commandId: 'cmd-ack', expectedDevices: 1, classicScheduled: 1,
    candidateAcked: 1, expired: 0, cancelled: false
  });
  assert.equal(JSON.stringify(h.room.delivery).includes('forged'), false);
});

test('Reliable persistence failure cannot prevent the already-persisted Classic broadcast', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  installDoubleRoom(h);
  const events = [];
  h.room.state.getWebSockets = () => [armedSocket('700001', '00000000-0000-4000-8000-000000000001')];
  h.room.persistAll = async () => events.push('classic-persist');
  h.room.persist = async () => events.push('classic-persist');
  h.room.scheduleExpiry = async () => events.push('alarm');
  h.room.broadcast = () => events.push('classic-broadcast');
  h.room.persistDelivery = async () => { throw new Error('delivery storage unavailable'); };
  await h.room.webSocketMessage(fakeSocket('qa-kvk-dispatch-a'), JSON.stringify({
    t: 'cmd', password: 'pw',
    cmd: {
      type: 'double_rally', kingdom: 1, anchorUTC: 1010,
      payload: {
        leadSeconds: 10, firstPress: 1010,
        pairs: [
          { pid: '700001', role: 'weak', march: 31, pressUTC: 1010 },
          { pid: '700002', role: 'main', march: 30, pressUTC: 1011 }
        ]
      }
    }
  }));
  assert.deepEqual(events.slice(0, 3), ['classic-persist', 'alarm', 'classic-broadcast']);
  assert.equal(h.room.room.live.commands[1].type, 'double_rally');
});
~~~

- [ ] **Step 3: Run the focused test and verify dispatch is absent**

Run: cd $KVK_WORKTREE/kingshoter && node --test --test-name-pattern="Fire broadcasts|ACKs are per|persistence failure" test/room-delivery.test.cjs

Expected: FAIL with TypeError: h.room.dispatchDeliveryForCommand is not a function and no Classic assertion failure.

- [ ] **Step 4: Import the dispatch model operations**

Extend the existing delivery.js import in room.js with:

~~~js
createDeliveryRecord,
upsertDeliveryTarget,
dueDeliveryTargets,
recordDeliveryAttempt,
recordClassicAck,
recordShadowAck,
pruneDeliveryState
~~~

- [ ] **Step 5: Implement target matching, send, dispatch, and ACK recording**

Add these methods immediately before handleDeliveryShadowMessage():

~~~js
deliverySocketFor(action) {
  for (const ws of this.state.getWebSockets()) {
    const attachment = this.readSocketAttachment(ws);
    if (attachment.qa && attachment.shadow &&
        attachment.pid === action.pid && attachment.deviceId === action.deviceId) return ws;
  }
  return null;
}

flushDeliveryTargets(nowMs) {
  let changed = false;
  for (const action of dueDeliveryTargets(this.delivery, nowMs)) {
    const ws = this.deliverySocketFor(action);
    if (ws) {
      try { ws.send(JSON.stringify(action.envelope)); } catch (error) {}
    }
    changed = recordDeliveryAttempt(this.delivery, action, nowMs) || changed;
  }
  return changed;
}

async dispatchDeliveryForCommand(command, nowMs) {
  if (!isQaRoomName(this.delivery.roomName)) return;
  const record = createDeliveryRecord(command, nowMs);
  if (!record) return;
  this.delivery.commands.push(record);
  for (const ws of this.state.getWebSockets()) {
    upsertDeliveryTarget(this.delivery, record.commandId, this.readSocketAttachment(ws), nowMs);
  }
  this.flushDeliveryTargets(nowMs);
  pruneDeliveryState(this.delivery, nowMs);
  await this.persistDelivery();
  await this.scheduleExpiry();
}

async recordReliableClassicAck(ws, canonicalIdentity, message, nowMs) {
  const attachment = this.readSocketAttachment(ws);
  if (!canonicalIdentity || canonicalIdentity.pid !== attachment.pid ||
      canonicalIdentity.deviceId !== attachment.deviceId || attachment.soundReady !== true) return false;
  if (!recordClassicAck(this.delivery, attachment, message, nowMs)) return false;
  await this.persistDelivery();
  this.broadcast();
  await this.scheduleExpiry();
  return true;
}
~~~

Replace the deliveryShadowHello branch in handleDeliveryShadowMessage() with:

~~~js
if (message.t === 'deliveryShadowHello') {
  if (message.pid !== current.pid || message.deviceId !== current.deviceId ||
      !current.pid || !current.deviceId || current.soundReady !== true) {
    return this.deliveryError(ws, 'core_identity_mismatch');
  }
  const next = normalizeDeliveryAttachment({
    ...current,
    view: message.view,
    shadow: message.v === DELIVERY_VERSION && message.shadow === true,
    audioArmed: false,
    armedUntilMs: 0
  }, current.roomName);
  if (!next.shadow) return this.deliveryError(ws, 'bad_delivery_hello');
  this.delivery.roomName = current.roomName;
  this.writeSocketAttachment(ws, {
    v: next.v, qa: next.qa, view: next.view, shadow: next.shadow,
    audioArmed: next.audioArmed, armedUntilMs: next.armedUntilMs,
    lastProbeId: next.lastProbeId, probeExpiresAtMs: next.probeExpiresAtMs,
    nextProbeAtMs: next.nextProbeAtMs
  });
  this.issueDeliveryProbe(ws, next, nowMs);
  for (const record of this.delivery.commands) {
    upsertDeliveryTarget(this.delivery, record.commandId, next, nowMs);
  }
  this.flushDeliveryTargets(nowMs);
  await this.persistDelivery();
  await this.scheduleExpiry();
  return;
}
~~~

Add this branch after deliveryShadowProbeAck and before unsupported_delivery_message:

~~~js
if (message.t === 'deliveryShadowAck') {
  if (!recordShadowAck(this.delivery, current, message, nowMs)) return;
  await this.persistDelivery();
  this.broadcast();
  await this.scheduleExpiry();
  return;
}
~~~

- [ ] **Step 6: Integrate after the core Fire and ACK success points**

In the core plan's cmd branch, keep its existing persistAll()/scheduleExpiry()/broadcast() sequence. Immediately after that broadcast and before return, insert:

~~~js
const reliableCommand = type === 'double_rally' ? this.room.live.commands[kd] : null;
if (reliableCommand) {
  try { await this.dispatchDeliveryForCommand(reliableCommand, this._deliveryNow()); }
  catch (error) {}
}
~~~

Do not move or replace core command.delivery creation, private device aggregation, Classic persistence, alarm scheduling, or broadcast.

In the core deliveryAck branch, keep its existing socket identity and `recordCommandAck` validation. Reject `ok:false` exactly as Core does. For `ok:true`, first complete any authoritative persist/broadcast required when `changed:true`, then send/re-send the exact Core `deliveryAckSaved` as specified by Core. Only after that confirmation path, run this best-effort mirror for both `changed:true` and idempotent `changed:false` so a previously failed shadow write can recover from a duplicate valid Core ACK. Reliable failure must never suppress or delay `deliveryAckSaved`. The mirror also requires the Core-validated identity to match the challenged socket attachment exactly:

~~~js
try { await this.recordReliableClassicAck(ws, {
  pid: m.pid, deviceId: m.deviceId
}, m, this._deliveryNow()); }
catch (error) {}
~~~

Invalid, spoofed, non-target, non-QA, or attachment-mismatched core ACKs never reach the mirror record. A Reliable persistence error occurs after the authoritative core ACK and cannot change its result.

- [ ] **Step 7: Run focused and full tests**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/delivery-model.test.cjs test/room-delivery.test.cjs test/worker-security.test.cjs

Expected: all model, room-delivery, and worker-security tests pass, ending with # fail 0.

Run: cd $KVK_WORKTREE/kingshoter && npm test

Expected: all unit tests pass, ending with # fail 0.

- [ ] **Step 8: Detect scope and commit**

Call gitnexus_detect_changes({scope:"staged", repo:"$GITNEXUS_REPO"}). Expected affected flow: cmd -> Classic persist/alarm/broadcast, followed by isolated dispatch; ACK affects only private delivery persistence and QA aggregate broadcast. No audio function may be affected.

~~~bash
git add kingshoter/src/room.js kingshoter/test/room-delivery.test.cjs
git commit -m "feat: add classic-first shadow delivery dispatch"
~~~

---

### Task 4: One-Alarm Retries, Cancellation, Expiry, and Reconnect

**Files:**
- Modify: kingshoter/test/room-delivery.test.cjs
- Modify: kingshoter/test/worker-security.test.cjs
- Modify: kingshoter/src/room.js

**Interfaces:**
- Consumes: nextDeliveryWakeAt(), cancelDeliveryRecord(), hibernation attachments, and the existing Durable Object alarm.
- Produces: Room.nextProbeWakeAt(), Room.runDeliveryWake(nowMs), Room.cancelDeliveryCommand(commandId, nowMs), and a scheduleExpiry() that chooses the earliest Classic expiry, delivery retry, or probe wake.
- deliveryShadowCancel is exactly { t: 'deliveryShadowCancel', v: 1, shadow: true, commandId: string, cancelledAtMs: integer }.
- Retry attempts occur at issuedAtMs, issuedAtMs+500, and issuedAtMs+1500, but only while nowMs < fireAtMs-500. A reconnect may trigger one immediate resend of the same envelope while still before that cutoff.

- [ ] **Step 1: Run impact analysis for the single-alarm and cancel paths**

~~~text
gitnexus_context({name:"scheduleExpiry"})
gitnexus_impact({target:"scheduleExpiry",direction:"upstream"})
gitnexus_context({name:"alarm"})
gitnexus_impact({target:"alarm",direction:"upstream"})
gitnexus_impact({target:"webSocketMessage",direction:"upstream"})
~~~

Expected: scheduleExpiry and alarm are LOW risk in the current graph. The report must explicitly note that Cloudflare Durable Objects have one alarm and that calling setAlarm separately for delivery would overwrite Classic expiry.

- [ ] **Step 2: Append failing retry, alarm, cancel, and reconnect tests**

Append to kingshoter/test/room-delivery.test.cjs:

~~~js
test('the one alarm chooses the earliest Classic expiry, retry, or probe without changing Classic-only behavior', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  h.room.scheduleExpiry = Room.prototype.scheduleExpiry.bind(h.room);
  h.room.room.live.commands = { 1: { expiresUTC: 200 }, 2: { expiresUTC: 150 } };
  h.room.delivery = { v: 1, roomName: 'qa-kvk-alarm-a', commands: [] };
  h.room._deliveryNow = () => 100_000;
  h.room.state.getWebSockets = () => [];
  const calls = [];
  h.room.state.storage = {
    setAlarm: async (at) => calls.push(['set', at]),
    deleteAlarm: async () => calls.push(['delete'])
  };
  await h.room.scheduleExpiry();
  assert.deepEqual(calls, [['set', 150_600]]);

  const retry = armedSocket('700001', '00000000-0000-4000-8000-000000000001');
  retry.serializeAttachment({
    ...retry.deserializeAttachment(),
    audioArmed: true, armedUntilMs: 110_000, nextProbeAtMs: 120_000
  });
  h.room.state.getWebSockets = () => [retry];
  h.room.delivery.commands = [{
    commandId: 'cmd-alarm', kingdom: 1, issuedAtMs: 100_000, cancelledAtMs: null,
    audiences: [{ pid: '700001', role: 'weak', fireAtMs: 130_000,
      audioExpiresAtMs: 130_150, marchSeconds: 31, leadSeconds: 10 }],
    targets: [{
      pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001',
      envelope: {
        t: 'deliveryShadowCommand', v: 1, shadow: true, commandId: 'cmd-alarm',
        pid: '700001', role: 'weak', kingdom: 1, issuedAtMs: 100_000,
        fireAtMs: 130_000, audioExpiresAtMs: 130_150, marchSeconds: 31, leadSeconds: 10
      },
      attempts: 1, nextRetryAtMs: 100_500, classicAck: null, candidateAck: null
    }]
  }];
  await h.room.scheduleExpiry();
  assert.deepEqual(calls[1], ['set', 100_500]);

  h.room.delivery.commands = [];
  h.room.room.live.commands = { 1: null, 2: null };
  await h.room.scheduleExpiry();
  assert.deepEqual(calls[2], ['set', 110_000]);
});

test('alarm retries are byte-identical at 500 and 1500ms and stop before the fire cutoff', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  installDoubleRoom(h);
  const a1 = armedSocket('700001', '00000000-0000-4000-8000-000000000001');
  h.room.state.getWebSockets = () => [a1];
  h.room.persistDelivery = async () => {};
  h.room.persistAll = async () => {};
  h.room.persist = async () => {};
  h.room.broadcast = () => {};
  h.room.state.storage = {
    setAlarm: async () => {},
    deleteAlarm: async () => {}
  };
  const canonical = {
    id: 'cmd-retry', type: 'double_rally', kingdom: 1,
    payload: {
      leadSeconds: 10,
      pairs: [
        { pid: '700001', role: 'weak', march: 31, pressUTC: 1010 },
        { pid: '700002', role: 'main', march: 30, pressUTC: 1011 }
      ]
    }
  };
  await h.room.dispatchDeliveryForCommand(canonical, 1_000_000);
  h.room._deliveryNow = () => 1_000_500;
  await h.room.alarm();
  h.room._deliveryNow = () => 1_001_500;
  await h.room.alarm();
  h.room._deliveryNow = () => 1_009_500;
  await h.room.alarm();
  const bytes = a1.sent
    .filter((message) => message.t === 'deliveryShadowCommand')
    .map((message) => JSON.stringify(message));
  assert.equal(bytes.length, 3);
  assert.equal(new Set(bytes).size, 1);
  assert.match(bytes[0], /"commandId":"cmd-retry"/);
});

test('Cancel broadcasts Classic removal before the shadow cancel and marks the same command id', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  installDoubleRoom(h);
  const a1 = armedSocket('700001', '00000000-0000-4000-8000-000000000001');
  h.room.state.getWebSockets = () => [a1];
  h.room.persistDelivery = async () => {};
  h.room.persistAll = async () => {};
  h.room.persist = async () => {};
  h.room.scheduleExpiry = async () => {};
  const order = [];
  h.room.broadcast = () => order.push('classic-broadcast');
  const send = a1.send.bind(a1);
  a1.send = (value) => {
    const message = JSON.parse(value);
    if (message.t === 'deliveryShadowCancel') order.push('delivery-cancel');
    send(value);
  };
  const canonical = {
    id: 'cmd-cancel', type: 'double_rally', kingdom: 1,
    anchorUTC: 1010, expiresUTC: 1400,
    payload: {
      leadSeconds: 10,
      pairs: [
        { pid: '700001', role: 'weak', march: 31, pressUTC: 1010 },
        { pid: '700002', role: 'main', march: 30, pressUTC: 1011 }
      ]
    }
  };
  h.room.room.live.commands[1] = canonical;
  h.room.room.live.mode = 'live';
  await h.room.dispatchDeliveryForCommand(canonical, 1_000_000);
  order.length = 0;
  await h.room.webSocketMessage(fakeSocket('qa-kvk-dispatch-a'), JSON.stringify({
    t: 'cmd', password: 'pw', cmd: { type: 'cancel', kingdom: 1 }
  }));
  assert.ok(order.indexOf('classic-broadcast') < order.indexOf('delivery-cancel'), JSON.stringify(order));
  assert.deepEqual(a1.sent.find((message) => message.t === 'deliveryShadowCancel'), {
    t: 'deliveryShadowCancel', v: 1, shadow: true,
    commandId: 'cmd-cancel', cancelledAtMs: 1_000_000
  });
  assert.equal(h.room.delivery.commands[0].cancelledAtMs, 1_000_000);
});

test('a late hello gets the pending immutable command, while an expired reconnect stays silent', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room);
  installDoubleRoom(h);
  h.room.state.getWebSockets = () => [];
  h.room.persistDelivery = async () => {};
  h.room.scheduleExpiry = async () => {};
  const canonical = {
    id: 'cmd-reconnect', type: 'double_rally', kingdom: 1,
    payload: {
      leadSeconds: 10,
      pairs: [
        { pid: '700001', role: 'weak', march: 31, pressUTC: 1010 },
        { pid: '700002', role: 'main', march: 30, pressUTC: 1011 }
      ]
    }
  };
  await h.room.dispatchDeliveryForCommand(canonical, 1_000_000);

  const reconnect = fakeSocket('qa-kvk-dispatch-a');
  h.room.state.getWebSockets = () => [reconnect];
  h.room._deliveryNow = () => 1_001_000;
  await h.room.webSocketMessage(reconnect, JSON.stringify({
    t: 'deliveryShadowHello', v: 1, shadow: true,
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000006', view: 'player'
  }));
  assert.equal(reconnect.sent.filter((message) => message.t === 'deliveryShadowCommand').length, 1);
  assert.equal(reconnect.sent.find((message) => message.t === 'deliveryShadowCommand').commandId, 'cmd-reconnect');

  const expired = fakeSocket('qa-kvk-dispatch-a');
  h.room.state.getWebSockets = () => [expired];
  h.room._deliveryNow = () => 1_010_151;
  await h.room.webSocketMessage(expired, JSON.stringify({
    t: 'deliveryShadowHello', v: 1, shadow: true,
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000007', view: 'player'
  }));
  assert.equal(expired.sent.some((message) => message.t === 'deliveryShadowCommand'), false);
});
~~~

- [ ] **Step 3: Run focused tests and verify alarm/cancel behavior is missing**

Run: cd $KVK_WORKTREE/kingshoter && node --test --test-name-pattern="one alarm|byte-identical|Cancel broadcasts|late hello" test/room-delivery.test.cjs

Expected: FAIL because scheduleExpiry does not choose delivery retries, alarm does not resend, and no deliveryShadowCancel is emitted.

- [ ] **Step 4: Import wake and cancel operations and implement unified scheduling**

Extend the delivery.js import with:

~~~js
nextDeliveryWakeAt,
cancelDeliveryRecord
~~~

Add this method immediately before scheduleExpiry():

~~~js
nextProbeWakeAt() {
  if (!this.state || typeof this.state.getWebSockets !== 'function') return null;
  let next = null;
  for (const ws of this.state.getWebSockets()) {
    const attachment = this.readSocketAttachment(ws);
    if (!attachment.qa || !attachment.shadow) continue;
    for (const atMs of [attachment.nextProbeAtMs, attachment.audioArmed ? attachment.armedUntilMs : 0]) {
      if (!atMs) continue;
      next = next == null ? atMs : Math.min(next, atMs);
    }
  }
  return next;
}
~~~

Replace scheduleExpiry() with:

~~~js
async scheduleExpiry() {
  const classic = [1, 2]
    .map((key) => this.room.live.commands[key])
    .filter((command) => command && command.expiresUTC)
    .map((command) => command.expiresUTC * 1000 + 600);
  const nowMs = this._deliveryNow();
  const deliveryAt = this.delivery ? nextDeliveryWakeAt(this.delivery, nowMs) : null;
  const probeAt = this.nextProbeWakeAt();
  const wakeups = classic.concat([deliveryAt, probeAt]).filter((value) => Number.isFinite(value) && value > 0);
  if (wakeups.length) await this.state.storage.setAlarm(Math.min(...wakeups));
  else await this.state.storage.deleteAlarm();
}
~~~

This keeps the existing exact +600ms Classic expiry behavior when delivery is absent.

- [ ] **Step 5: Implement alarm work and recurring challenge leases**

Add this method immediately before alarm():

~~~js
async runDeliveryWake(nowMs) {
  let changed = false;
  if (this.state && typeof this.state.getWebSockets === 'function') {
    for (const ws of this.state.getWebSockets()) {
      let attachment = this.readSocketAttachment(ws);
      if (!attachment.qa || !attachment.shadow) continue;
      if (attachment.audioArmed && attachment.armedUntilMs <= nowMs) {
        attachment.audioArmed = false;
        attachment.armedUntilMs = 0;
        this.writeSocketAttachment(ws, attachment);
        changed = true;
      }
      if (attachment.nextProbeAtMs && attachment.nextProbeAtMs <= nowMs) {
        attachment = this.issueDeliveryProbe(ws, attachment, nowMs);
        changed = true;
      }
    }
  }
  changed = this.flushDeliveryTargets(nowMs) || changed;
  changed = pruneDeliveryState(this.delivery, nowMs) || changed;
  if (changed) await this.persistDelivery();
  return changed;
}
~~~

Preserve the core alarm's exact command-expiry, mode, persist/persistAll, broadcast, and schedule logic. Insert this call after its Classic expiry persistence and immediately before its existing broadcast:

~~~js
try { await this.runDeliveryWake(this._deliveryNow()); } catch (error) {}
~~~

Do not replace the core alarm method; in particular, retain whichever core persistence method owns room, devices, and deliveryAcks.

- [ ] **Step 6: Implement cancellation against the original command ID**

Add:

~~~js
async cancelDeliveryCommand(commandId, nowMs) {
  const record = this.delivery.commands.find((item) => item.commandId === commandId);
  if (!record || !cancelDeliveryRecord(this.delivery, commandId, nowMs)) return;
  const message = JSON.stringify({
    t: 'deliveryShadowCancel', v: DELIVERY_VERSION, shadow: true,
    commandId, cancelledAtMs: nowMs
  });
  for (const target of record.targets) {
    const ws = this.deliverySocketFor(target);
    if (!ws) continue;
    try { ws.send(message); } catch (error) {}
  }
  await this.persistDelivery();
  await this.scheduleExpiry();
  this.broadcast();
}
~~~

In the cmd branch, add this declaration immediately after kd is computed:

~~~js
let cancelledCommand = null;
~~~

Replace only the cancel assignment with:

~~~js
if (type === 'cancel') {
  cancelledCommand = this.room.live.commands[kd];
  this.room.live.commands[kd] = null;
} else {
~~~

After the Classic-first reliableCommand dispatch block from Task 3 and before return, add:

~~~js
if (cancelledCommand && cancelledCommand.id) {
  try { await this.cancelDeliveryCommand(cancelledCommand.id, this._deliveryNow()); }
  catch (error) {}
}
~~~

- [ ] **Step 7: Preserve the Classic alarm regression**

In kingshoter/test/worker-security.test.cjs, initialize room.delivery and room.state.getWebSockets in the existing alarm test:

~~~js
room.delivery = { v: 1, roomName: '', commands: [] };
room.state.getWebSockets = () => [];
~~~

Keep its exact assertions:

~~~js
await room.scheduleExpiry();
assert.deepEqual(calls, [['set', 150_600]]);
room.room.live.commands = { 1: null, 2: null };
await room.scheduleExpiry();
assert.deepEqual(calls[1], ['delete']);
~~~

- [ ] **Step 8: Run protocol, alarm, and full tests**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/delivery-model.test.cjs test/room-delivery.test.cjs test/worker-security.test.cjs

Expected: all tests pass, retry sends exactly three byte-identical frames, cancel references cmd-cancel, the expired reconnect receives no deliveryShadowCommand, and output ends with # fail 0.

Run: cd $KVK_WORKTREE/kingshoter && npm test

Expected: all tests pass, ending with # fail 0.

- [ ] **Step 9: Detect scope and commit**

Call gitnexus_detect_changes({scope:"staged", repo:"$GITNEXUS_REPO"}). Expected processes are Alarm -> Classic expiry plus QA delivery wake, cmd cancel -> Classic broadcast -> shadow cancel, and deliveryShadowHello -> reconnect resend. No non-QA protocol or audio process may change.

~~~bash
git add kingshoter/src/room.js kingshoter/test/room-delivery.test.cjs kingshoter/test/worker-security.test.cjs
git commit -m "feat: retry and cancel reliable shadow commands"
~~~

---

### Task 5: No-Audio Browser Shadow Controller

**Files:**
- Create: kingshoter/public/kvk-delivery-shadow.js
- Create: kingshoter/test/delivery-shadow-client.test.cjs

**Interfaces:**
- Consumes: room, enabled, send(message), now(), getIdentity(), and observe(event).
- Produces: window.KvkDeliveryShadow = { isQaRoomName(room), create(options) }; create() returns { enabled, onOpen(), handleMessage(message), state() }.
- getIdentity() returns { pid: string, deviceId: string, view: 'player'|'commander', audioArmed: boolean }.
- Classic scheduling and production deliveryAck remain entirely owned by the core plan; this controller never inspects the Classic cue map or sends a second Classic ACK.
- This file must not contain or call AudioContext, createOscillator, scheduleBeeps, stopCue, speechSynthesis, vibrate, HTMLMediaElement, or any cue-node API.

- [ ] **Step 1: Write failing controller tests**

Create kingshoter/test/delivery-shadow-client.test.cjs:

~~~js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const source = fs.readFileSync(path.join(__dirname, '../public/kvk-delivery-shadow.js'), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window, globalThis: window, URLSearchParams, Map, Set, Object, Number, String, Math });
  return { api: window.KvkDeliveryShadow, source };
}

function fixture(overrides = {}) {
  const sent = [];
  const events = [];
  let nowMs = 1_000_000;
  let identity = {
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001', view: 'player', audioArmed: true
  };
  const { api, source } = load();
  const controller = api.create({
    room: 'qa-kvk-client-a',
    enabled: true,
    send(message) { sent.push(structuredClone(message)); return true; },
    now() { return nowMs; },
    getIdentity() { return { ...identity }; },
    observe(event) { events.push(structuredClone(event)); },
    ...overrides
  });
  return {
    controller, sent, events, source,
    setNow(value) { nowMs = value; },
    setIdentity(value) { identity = { ...identity, ...value }; }
  };
}

test('controller source has no sound-producing or cue-scheduling dependency', () => {
  const { source } = load();
  assert.doesNotMatch(source, /AudioContext|createOscillator|scheduleBeeps|stopCue|speechSynthesis|vibrate|HTMLMediaElement/);
});

test('non-QA or disabled controllers never introduce the candidate protocol', () => {
  for (const room of ['operation-room', 'demo', '_', 'qa-kvk-']) {
    const { api } = load();
    const sent = [];
    const controller = api.create({
      room, enabled: true, send: (message) => sent.push(message),
      now: () => 1, getIdentity: () => ({
        pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001', view: 'player', audioArmed: true
      })
    });
    assert.equal(controller.enabled, false, room);
    assert.equal(controller.onOpen(), false, room);
    assert.deepEqual(sent, [], room);
  }
});

test('open and probe send versioned identity and a current armed observation', () => {
  const f = fixture();
  assert.equal(f.controller.onOpen(), true);
  assert.deepEqual(f.sent.shift(), {
    t: 'deliveryShadowHello', v: 1, shadow: true,
    pid: '700001', deviceId: '00000000-0000-4000-8000-000000000001', view: 'player', audioArmed: true
  });
  f.setIdentity({ audioArmed: false });
  f.controller.handleMessage({
    t: 'deliveryShadowProbe', v: 1, probeId: 'probe-a',
    sentAtMs: 999_900, expiresAtMs: 1_001_900
  });
  assert.deepEqual(f.sent.shift(), {
    t: 'deliveryShadowProbeAck', v: 1, probeId: 'probe-a', audioArmed: false
  });
});

test('candidate computes future cues once, retry is duplicate, and neither path schedules sound', () => {
  const f = fixture();
  const message = {
    t: 'deliveryShadowCommand', v: 1, shadow: true, commandId: 'cmd-a',
    pid: '700001', role: 'weak', kingdom: 1, issuedAtMs: 1_000_000,
    fireAtMs: 1_010_000, audioExpiresAtMs: 1_010_150,
    marchSeconds: 31, leadSeconds: 10
  };
  f.controller.handleMessage(message);
  assert.deepEqual(f.sent.shift(), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-a',
    result: 'would_schedule', futureCueCount: 11
  });
  f.controller.handleMessage(structuredClone(message));
  assert.deepEqual(f.sent.shift(), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-a',
    result: 'duplicate', futureCueCount: 11
  });
  assert.deepEqual(f.controller.state(), {
    seenCandidate: ['cmd-a'], cancelled: []
  });
});

test('candidate mirrors the frozen 10/15/30/60 personal-start cue matrix', () => {
  for (const leadSeconds of [10, 15, 30, 60]) {
    const f = fixture();
    f.controller.handleMessage({
      t: 'deliveryShadowCommand', v: 1, shadow: true, commandId: `lead-${leadSeconds}`,
      pid: '700001', role: 'weak', kingdom: 1, issuedAtMs: 1_000_000,
      fireAtMs: 1_000_000 + leadSeconds * 1000,
      audioExpiresAtMs: 1_000_150 + leadSeconds * 1000,
      marchSeconds: 31, leadSeconds
    });
    assert.deepEqual(f.sent.shift(), {
      t: 'deliveryShadowAck', v: 1, commandId: `lead-${leadSeconds}`,
      result: 'would_schedule', futureCueCount: leadSeconds === 10 ? 11 : 12
    });
  }
});

test('unarmed, cancelled, and expired deliveries remain silent facts', () => {
  const f = fixture();
  f.setIdentity({ audioArmed: false });
  const unarmed = {
    t: 'deliveryShadowCommand', v: 1, shadow: true, commandId: 'cmd-unarmed',
    fireAtMs: 1_010_000, audioExpiresAtMs: 1_010_150
  };
  f.controller.handleMessage(unarmed);
  assert.equal(f.sent.shift().result, 'audio_unarmed');
  f.controller.handleMessage(structuredClone(unarmed));
  assert.deepEqual(f.sent.shift(), {
    t: 'deliveryShadowAck', v: 1, commandId: 'cmd-unarmed',
    result: 'duplicate', futureCueCount: 0
  });

  f.controller.handleMessage({
    t: 'deliveryShadowCancel', v: 1, shadow: true,
    commandId: 'cmd-cancelled', cancelledAtMs: 1_000_010
  });
  f.controller.handleMessage({
    t: 'deliveryShadowCommand', v: 1, shadow: true, commandId: 'cmd-cancelled',
    fireAtMs: 1_010_000, audioExpiresAtMs: 1_010_150
  });
  assert.equal(f.sent.shift().result, 'expired');

  f.setNow(1_020_000);
  f.controller.handleMessage({
    t: 'deliveryShadowCommand', v: 1, shadow: true, commandId: 'cmd-expired',
    fireAtMs: 1_010_000, audioExpiresAtMs: 1_010_150
  });
  assert.equal(f.sent.shift().result, 'expired');
});

~~~

- [ ] **Step 2: Run the controller tests and verify the file is absent**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/delivery-shadow-client.test.cjs

Expected: FAIL with ENOENT for public/kvk-delivery-shadow.js.

- [ ] **Step 3: Implement the complete controller**

Create kingshoter/public/kvk-delivery-shadow.js:

~~~js
(function (root) {
  'use strict';

  var VERSION = 1;
  var QA_ROOM_RE = /^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/;
  var COUNTDOWN_OFFSETS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  var LEADS = [10, 15, 30, 60];

  function cueOffsets(leadSeconds) {
    var lead = Number(leadSeconds);
    if (LEADS.indexOf(lead) < 0) lead = 10;
    return (lead > 10 ? [lead] : []).concat(COUNTDOWN_OFFSETS);
  }

  function isQaRoomName(room) {
    return typeof room === 'string' && room.length <= 48 && QA_ROOM_RE.test(room);
  }

  function create(options) {
    options = options || {};
    var enabled = options.enabled === true && isQaRoomName(options.room);
    var send = typeof options.send === 'function' ? options.send : function () { return false; };
    var now = typeof options.now === 'function' ? options.now : Date.now;
    var getIdentity = typeof options.getIdentity === 'function'
      ? options.getIdentity
      : function () { return { pid: '', deviceId: '', view: 'player', audioArmed: false }; };
    var observe = typeof options.observe === 'function' ? options.observe : function () {};
    var candidate = new Map();
    var cancelled = new Set();

    function identity() {
      var value = getIdentity() || {};
      return {
        pid: String(value.pid || '').slice(0, 24),
        deviceId: String(value.deviceId || '').slice(0, 64),
        view: value.view === 'commander' ? 'commander' : 'player',
        audioArmed: value.audioArmed === true
      };
    }

    function emit(message) {
      return enabled ? send(message) === true : false;
    }

    function ack(commandId, result, futureCueCount) {
      return emit({
        t: 'deliveryShadowAck', v: VERSION, commandId: String(commandId || '').slice(0, 64),
        result: result,
        futureCueCount: Math.max(0, Math.min(12, Math.trunc(Number(futureCueCount) || 0)))
      });
    }

    function onOpen() {
      if (!enabled) return false;
      var current = identity();
      if (!current.deviceId) return false;
      return emit({
        t: 'deliveryShadowHello', v: VERSION, shadow: true,
        pid: current.pid, deviceId: current.deviceId,
        view: current.view, audioArmed: current.audioArmed
      });
    }

    function handleCommand(message) {
      var commandId = String(message.commandId || '').slice(0, 64);
      if (!commandId) return false;
      if (candidate.has(commandId)) {
        var previous = candidate.get(commandId);
        ack(commandId, 'duplicate', previous.result === 'would_schedule' ? previous.futureCueCount : 0);
        observe({ kind: 'candidate-duplicate', commandId: commandId });
        return true;
      }
      var nowMs = now();
      var fireAtMs = Number(message.fireAtMs);
      var audioExpiresAtMs = Number(message.audioExpiresAtMs);
      var futureCueCount = Number.isFinite(fireAtMs)
        ? cueOffsets(message.leadSeconds).filter(function (offset) {
            return fireAtMs - offset * 1000 > nowMs - 150;
          }).length
        : 0;
      var current = identity();
      var result = 'expired';
      if (!cancelled.has(commandId) && Number.isFinite(audioExpiresAtMs) && nowMs <= audioExpiresAtMs) {
        if (!current.audioArmed) result = 'audio_unarmed';
        else if (futureCueCount > 0) result = 'would_schedule';
      }
      candidate.set(commandId, { result: result, futureCueCount: futureCueCount });
      ack(commandId, result, futureCueCount);
      observe({
        kind: 'candidate', commandId: commandId, result: result,
        futureCueCount: futureCueCount, fireAtMs: fireAtMs
      });
      return true;
    }

    function handleMessage(message) {
      if (!enabled || !message || message.v !== VERSION) return false;
      if (message.t === 'deliveryShadowProbe') {
        emit({
          t: 'deliveryShadowProbeAck', v: VERSION,
          probeId: String(message.probeId || '').slice(0, 64),
          audioArmed: identity().audioArmed
        });
        return true;
      }
      if (message.t === 'deliveryShadowCommand' && message.shadow === true) return handleCommand(message);
      if (message.t === 'deliveryShadowCancel' && message.shadow === true) {
        var commandId = String(message.commandId || '').slice(0, 64);
        if (commandId) cancelled.add(commandId);
        observe({ kind: 'candidate-cancel', commandId: commandId });
        return true;
      }
      return false;
    }

    function state() {
      return {
        seenCandidate: Array.from(candidate.keys()),
        cancelled: Array.from(cancelled)
      };
    }

    return Object.freeze({
      enabled: enabled,
      onOpen: onOpen,
      handleMessage: handleMessage,
      state: state
    });
  }

  root.KvkDeliveryShadow = Object.freeze({
    isQaRoomName: isQaRoomName,
    create: create
  });
})(typeof window !== 'undefined' ? window : globalThis);
~~~

- [ ] **Step 4: Run controller and model tests**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/delivery-shadow-client.test.cjs test/delivery-model.test.cjs

Expected: all controller and model subtests pass, the source dependency assertion is green, and output ends with # fail 0.

- [ ] **Step 5: Detect scope and commit**

Call gitnexus_detect_changes({scope:"staged", repo:"$GITNEXUS_REPO"}). Expected output contains only the new isolated browser module and its tests.

~~~bash
git add kingshoter/public/kvk-delivery-shadow.js kingshoter/test/delivery-shadow-client.test.cjs
git commit -m "feat: add no-audio reliable shadow controller"
~~~

---

### Task 6: Browser Wiring That Leaves Core Audio and ACK Untouched

**Files:**
- Create: kingshoter/test/delivery-browser-wiring.test.cjs
- Modify: kingshoter/public/kvk.html
- Modify: kingshoter/public/kvk.js

**Interfaces:**
- Consumes: window.KvkDeliveryShadow, window.getRoomDeviceId(room), RoomSocket.onMessage, myPid, and audioAlive().
- Produces: initDeliveryShadow(), deliveryIdentity(), and QA-only window.__kvkDeliveryQa = { events, controller, getSocket() }.
- The adapter is active only for isQaRoomName(ROOM) && qp.get('deliveryShadow') === '1'.
- The core plan's scheduleAllCues(), scheduledBeeps, acknowledgeClassicCommand(), production deliveryAck, and Received UI are not edited.

- [ ] **Step 1: Run impact analysis for the one existing browser function**

~~~text
gitnexus_context({name:"connect"})
gitnexus_impact({target:"connect",direction:"upstream"})
~~~

Expected: connect is LOW risk in the current graph. Report any new HIGH/CRITICAL result before editing.

- [ ] **Step 2: Write failing source-wiring tests**

Create kingshoter/test/delivery-browser-wiring.test.cjs:

~~~js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('shadow adapter loads after app and before kvk without adding visible controls', () => {
  const html = read('public/kvk.html');
  const appAt = html.indexOf('src="app.js');
  const shadowAt = html.indexOf('src="kvk-delivery-shadow.js?v=1"');
  const kvkAt = html.indexOf('src="kvk.js');
  assert.ok(appAt >= 0 && appAt < shadowAt && shadowAt < kvkAt);
  assert.equal((html.match(/kvk-delivery-shadow\.js/g) || []).length, 1);
  assert.doesNotMatch(html, /Reliable mode|delivery engine|deliveryShadowButton|classicMode/);
});

test('kvk uses the shared device id and generic RoomSocket message callback behind both gates', () => {
  const app = read('public/app.js');
  const kvk = read('public/kvk.js');
  assert.match(app, /this\.onMessage/);
  assert.match(kvk, /KvkDeliveryShadow\.isQaRoomName\(ROOM\)/);
  assert.match(kvk, /qp\.get\('deliveryShadow'\) === '1'/);
  assert.match(kvk, /window\.getRoomDeviceId\(ROOM\)/);
  assert.match(kvk, /sock\.onMessage = function \(message\)/);
  assert.match(kvk, /try \{ deliveryShadow\.onOpen\(\); \} catch \(error\)/);
  assert.match(kvk, /try \{ deliveryShadow\.handleMessage\(message\); \} catch \(error\)/);
});

test('Reliable wiring does not enter the core scheduler or create a second Classic ACK', () => {
  const kvk = read('public/kvk.js');
  const scheduler = kvk.slice(kvk.indexOf('function scheduleAllCues'), kvk.indexOf('function beepCancelled'));
  assert.doesNotMatch(scheduler, /deliveryShadow|deliveryShadowAck/);
  assert.equal((kvk.match(/t:\s*['"]deliveryAck['"]/g) || []).length, 1);
});

test('the isolated candidate remains free of every Classic sound primitive', () => {
  const source = read('public/kvk-delivery-shadow.js');
  assert.doesNotMatch(source, /AudioContext|createOscillator|scheduleBeeps|schedulePrepareCue|beep\(|stopCue|speechSynthesis|vibrate/);
});
~~~

- [ ] **Step 3: Run the wiring tests and verify script/controller wiring is absent**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/delivery-browser-wiring.test.cjs

Expected: FAIL because kvk-delivery-shadow.js is not loaded by kvk.html and initDeliveryShadow is absent.

- [ ] **Step 4: Load the isolated adapter**

In kingshoter/public/kvk.html, insert this exact line after the existing app.js script and before the existing kvk.js script:

~~~html
<script src="kvk-delivery-shadow.js?v=1"></script>
~~~

Do not add markup, copy, styles, buttons, badges, or a mode selector.

- [ ] **Step 5: Add the double-gated controller and shared device identity**

After the primary state-variable declarations near the top of kingshoter/public/kvk.js, add:

~~~js
var deliveryShadow = null, deliveryEvents = [];
var deliveryShadowEnabled = !!(
  window.KvkDeliveryShadow &&
  window.KvkDeliveryShadow.isQaRoomName(ROOM) &&
  qp.get('deliveryShadow') === '1'
);
~~~

Add these functions immediately before connect():

~~~js
function deliveryIdentity() {
  var pid = myPid;
  if (!pid) {
    try {
      var saved = JSON.parse(localStorage.getItem(LS('me')) || 'null');
      if (saved && saved.pid) pid = saved.pid;
    } catch (error) {}
  }
  return {
    pid: pid || '',
    deviceId: window.getRoomDeviceId(ROOM),
    view: document.body.classList.contains('cmdmode') ? 'commander' : 'player',
    audioArmed: audioAlive()
  };
}

function initDeliveryShadow() {
  if (!deliveryShadowEnabled || deliveryShadow) return deliveryShadow;
  try {
    deliveryShadow = window.KvkDeliveryShadow.create({
      room: ROOM,
      enabled: true,
      send: function (message) { return !!(sock && sock.send(message)); },
      now: function () { return window.serverNow(); },
      getIdentity: deliveryIdentity,
      observe: function (event) {
        deliveryEvents.push(event);
        if (deliveryEvents.length > 200) deliveryEvents.shift();
      }
    });
    window.__kvkDeliveryQa = {
      events: deliveryEvents,
      controller: deliveryShadow,
      getSocket: function () { return sock; }
    };
  } catch (error) {
    deliveryShadow = null;
    deliveryShadowEnabled = false;
  }
  return deliveryShadow;
}
~~~

This consumes the core plan's getRoomDeviceId implementation. Do not create a second device key or generator.

- [ ] **Step 6: Forward additive protocol messages and hello on every reconnect**

Make three surgical additions inside the core plan's existing connect(); do not replace its identity, reconnect, error, or UI branches.

Add initDeliveryShadow() as the first statement:

~~~js
initDeliveryShadow();
~~~

Add this as the final statement of the existing sock.onOpen callback, after its existing setMarch/identity work:

~~~js
if (deliveryShadow) {
  try { deliveryShadow.onOpen(); } catch (error) { deliveryShadow = null; }
}
~~~

Immediately after assigning sock.onOpen, add:

~~~js
sock.onMessage = function (message) {
  if (!deliveryShadow) return;
  try { deliveryShadow.handleMessage(message); } catch (error) { deliveryShadow = null; }
};
~~~

Do not alter the existing sock.onClose, sock.onError, scheduleAllCues, acknowledgeClassicCommand, or UI callbacks.

- [ ] **Step 7: Run browser wiring and countdown regressions**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/delivery-shadow-client.test.cjs test/delivery-browser-wiring.test.cjs test/command-scope.test.cjs

Expected: all tests pass, including the candidate source ban and the existing 10-second/no-counter scope assertions; output ends with # fail 0.

Run: cd $KVK_WORKTREE/kingshoter && npm test

Expected: all unit tests pass, ending with # fail 0.

- [ ] **Step 8: Detect scope and commit**

Call gitnexus_detect_changes({scope:"staged", repo:"$GITNEXUS_REPO"}). The only expected existing browser symbol is connect. No scheduleAllCues, acknowledgeClassicCommand, scheduleBeeps, schedulePrepareCue, beep, stopCue, paintHero, identity UI, roster UI, status UI, or command timing formula may be reported as modified.

~~~bash
git add kingshoter/public/kvk.html kingshoter/public/kvk.js kingshoter/test/delivery-browser-wiring.test.cjs
git commit -m "feat: wire reliable shadow protocol"
~~~

---

### Task 7: Universal QA Guard, Three-Browser Config, and Multi-Context Orchestration

**Files:**
- Create: kingshoter/test/qa-kvk-delivery-guard.test.cjs
- Create: kingshoter/playwright.qa-kvk.config.cjs
- Create: kingshoter/test/qa-kvk-delivery.spec.cjs
- Modify: kingshoter/package.json
- Consume unchanged: kingshoter/test/support/qa-kvk.cjs

**Interfaces:**
- Consumes: assertQaRoomName, makeQaRoom, qaRoomUrl, installQaWebSocketGuard, Playwright browser/context/page/request fixtures, and QA-only window.__kvkDeliveryQa.
- Produces: local/explicit-production Playwright projects chromium, firefox, and webkit; test:delivery, test:qa:delivery, and test:qa:delivery:chromium scripts.
- Minimum topology is eight distinct BrowserContexts: commander-only; Captain A device 1; Captain B; ordinary member; Captain A device 2 with the same numeric pid; same-nickname opaque identity 1; same-nickname opaque identity 2; and commander-selected-as-captain.
- Multiple pages in one context do not count as multiple devices.

- [ ] **Step 1: Write the failing cross-layer guard tests**

Create kingshoter/test/qa-kvk-delivery-guard.test.cjs:

~~~js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-kvk.cjs');

test('helper and production predicate agree for generated and representative rooms', async () => {
  const { isQaRoomName } = await import(
    pathToFileURL(path.join(__dirname, '../src/delivery.js')).href + '?t=' + Date.now()
  );
  const rejected = ['operation-room', 'demo', '_', '', 'qa-kvk-', 'qa-kvk-bad_', 'QA-KVK-UPPER'];
  for (const room of rejected) {
    assert.equal(isQaRoomName(room), false, room);
    assert.throws(
      () => assertQaRoomName(room),
      (error) => /^Refusing non-QA KvK room:/.test(error.message),
      room
    );
  }
  for (const room of ['qa-kvk-a', 'qa-kvk-20260713-7f3a']) {
    assert.equal(assertQaRoomName(room), room);
    assert.equal(isQaRoomName(room), true);
  }
});

test('guard aborts before route installation for every operation room', async () => {
  for (const room of ['operation-room', 'demo', '_']) {
    let routes = 0;
    const context = { async routeWebSocket() { routes += 1; } };
    await assert.rejects(
      Promise.resolve().then(() => installQaWebSocketGuard(context, room)),
      (error) => /^Refusing non-QA KvK room:/.test(error.message)
    );
    assert.equal(routes, 0, room);
  }
});

test('generated rooms and URLs are unique, bounded, and always QA-scoped', () => {
  const input = {
    title: 'reliable shadow topology',
    project: { name: 'chromium' },
    workerIndex: 0, retry: 0, repeatEachIndex: 0
  };
  const a = makeQaRoom(input);
  const b = makeQaRoom(input);
  assert.notEqual(a, b);
  for (const room of [a, b]) {
    assert.equal(assertQaRoomName(room), room);
    assert.ok(room.length <= 48);
    const url = new URL(qaRoomUrl('http://127.0.0.1:8799', room, { deliveryShadow: '1' }));
    assert.equal(url.searchParams.get('room'), room);
    assert.equal(url.searchParams.get('deliveryShadow'), '1');
  }
});

test('production source has no hard-coded named-room equality branch', () => {
  for (const file of ['src/delivery.js', 'src/room.js', 'public/kvk-delivery-shadow.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /\b(?:room|roomName)\s*===\s*['"][a-z0-9-]+['"]/i);
  }
});
~~~

- [ ] **Step 2: Run guard tests against the core helper contract**

Run: cd $KVK_WORKTREE/kingshoter && node --test test/qa-kvk-delivery-guard.test.cjs

Expected: PASS for all four subtests, ending with # fail 0. If it fails because the core helper does not yet implement the agreed double-predicate options or pre-connect rejection, finish the core-plan prerequisite; do not create a second helper.

- [ ] **Step 3: Create the exact Playwright configuration**

Create kingshoter/playwright.qa-kvk.config.cjs:

~~~js
const { defineConfig, devices } = require('playwright/test');

const remote = String(process.env.QA_BASE_URL || '').trim();
const baseURL = remote || 'http://127.0.0.1:8799';
const production = /^https:\/\/(?:www\.)?kingshoter\.com(?:\/|$)/i.test(baseURL);

if (production && process.env.ALLOW_PRODUCTION_QA !== '1') {
  throw new Error('production_qa_requires_ALLOW_PRODUCTION_QA_1');
}

module.exports = defineConfig({
  testDir: './test',
  testMatch: /qa-kvk-delivery\.spec\.cjs/,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  webServer: remote ? undefined : {
    command: 'npx wrangler dev --local --port 8799',
    url: 'http://127.0.0.1:8799/api/time',
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ]
});
~~~

No build or version interface is added by this config. Any later QA suite must preserve these delivery projects, webServer settings, and production gate.

- [ ] **Step 4: Write the complete multi-context delivery spec**

Create kingshoter/test/qa-kvk-delivery.spec.cjs:

~~~js
const { test, expect } = require('playwright/test');
const crypto = require('node:crypto');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-kvk.cjs');

const PASSWORD = () => 'qa-' + crypto.randomBytes(12).toString('hex');
const meKey = (room) => 'kingshoter_r_' + room + '_me';
const pwKey = (room) => 'kingshoter_r_' + room + '_pw';

function parseFrame(data) {
  try { return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); }
  catch (error) { return null; }
}

async function openDevice(browser, baseURL, room, profile, faults = {}) {
  assertQaRoomName(room);
  const context = await browser.newContext();
  await installQaWebSocketGuard(context, room, faults);
  await context.addInitScript(({ roomName, profileValue, meStorageKey, pwStorageKey }) => {
    if (profileValue.pid) {
      localStorage.setItem(meStorageKey, JSON.stringify({
        pid: profileValue.pid,
        name: profileValue.name,
        march: profileValue.march
      }));
    }
    if (profileValue.commander) localStorage.setItem(pwStorageKey, profileValue.password);
  }, {
    roomName: room,
    profileValue: profile,
    meStorageKey: meKey(room),
    pwStorageKey: pwKey(room)
  });
  const page = await context.newPage();
  await page.goto(qaRoomUrl(baseURL, room, { deliveryShadow: '1' }));
  await expect.poll(() => page.evaluate(() => !!window.__kvkDeliveryQa)).toBe(true);
  if (profile.sound !== false) {
    await page.locator('#soundGate').click();
    await page.evaluate(() => window.__kvkDeliveryQa.controller.onOpen());
  }
  return { context, page, profile };
}

async function mutate(page, room, payload) {
  assertQaRoomName(room);
  return page.evaluate(({ roomName, message }) => new Promise((resolve, reject) => {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(scheme + '//' + location.host + '/api/ws?room=' + encodeURIComponent(roomName));
    let sent = false;
    const timer = setTimeout(() => {
      try { ws.close(); } catch (error) {}
      reject(new Error('mutation_timeout'));
    }, 8_000);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('mutation_socket_error'));
    };
    ws.onmessage = (event) => {
      let parsed;
      try { parsed = JSON.parse(event.data); } catch (error) { return; }
      if (parsed.t === 'error') {
        clearTimeout(timer); ws.close(); reject(new Error(parsed.error)); return;
      }
      if (parsed.t !== 'state') return;
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify(message));
        return;
      }
      const roomState = parsed.room;
      if (message.t === 'setConfig' && roomState.updatedBy === message.by) {
        clearTimeout(timer); ws.close(); resolve(roomState); return;
      }
      if (message.t === 'cmd') {
        const kingdom = Number(message.cmd.kingdom || 1);
        const command = roomState.live.commands[kingdom];
        if (message.cmd.type === 'cancel' && !command) {
          clearTimeout(timer); ws.close(); resolve(null); return;
        }
        if (command && command.type === message.cmd.type) {
          clearTimeout(timer); ws.close(); resolve(command);
        }
      }
    };
  }), { roomName: room, message: payload });
}

async function claimRoom(page, room, password) {
  const token = 'claim-' + crypto.randomBytes(8).toString('hex');
  await mutate(page, room, {
    t: 'setConfig', password,
    config: { castleName: '', rallyAllies: [], enemyWhales: [] },
    by: token
  });
}

async function roomSnapshot(request, baseURL, room) {
  assertQaRoomName(room);
  const url = new URL('/api/ws', baseURL);
  url.searchParams.set('room', room);
  const response = await request.get(url.toString());
  expect(response.ok()).toBe(true);
  const body = await response.json();
  return body.room;
}

async function waitForPlayers(request, baseURL, room, count) {
  await expect.poll(async () => {
    const snapshot = await roomSnapshot(request, baseURL, room);
    return Object.keys(snapshot.players || {}).length;
  }).toBeGreaterThanOrEqual(count);
}

async function cueBases(page, commandId) {
  return page.evaluate((id) => {
    const nowMs = window.serverNow();
    return Array.from(new Set(Object.values(window.__cues || {})
      .filter((entry) => entry.base.indexOf(id) === 0 && entry.t > nowMs)
      .map((entry) => entry.base))).sort();
  }, commandId);
}

async function deliverySummary(request, baseURL, room, commandId) {
  const snapshot = await roomSnapshot(request, baseURL, room);
  const commands = snapshot.deliveryShadow ? snapshot.deliveryShadow.commands : [];
  return commands.find((item) => item.commandId === commandId) || null;
}

test('eight isolated devices preserve Classic authority and shadow ACK truth', async ({
  browser, baseURL, request
}, testInfo) => {
  test.slow();
  const room = assertQaRoomName(makeQaRoom(testInfo));
  const password = PASSWORD();
  const retryFrames = [];
  let dropped = false;
  const profiles = [
    { key: 'commander-only', pid: '', name: 'Commander', march: 30, commander: true, password },
    { key: 'captain-a-1', pid: '700001', name: 'Captain A', march: 31 },
    { key: 'captain-b', pid: '700002', name: 'Captain B', march: 30 },
    { key: 'member', pid: '700003', name: 'Member', march: 25 },
    { key: 'captain-a-2', pid: '700001', name: 'Captain A', march: 31 },
    { key: 'same-name-1', pid: 'n-qa-alpha', name: 'Same Name', march: 28 },
    { key: 'same-name-2', pid: 'n-qa-beta', name: 'Same Name', march: 29 },
    { key: 'selected-commander', pid: '700004', name: 'Commander Captain', march: 32, commander: true, password }
  ];
  const devices = [];
  try {
    for (const profile of profiles) {
      const faults = profile.key === 'captain-a-1' ? {
        shouldDropServerMessage({ data }) {
          const message = parseFrame(data);
          if (!message || message.t !== 'deliveryShadowCommand') return false;
          retryFrames.push(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
          if (!dropped) { dropped = true; return true; }
          return false;
        }
      } : {};
      devices.push(await openDevice(browser, baseURL, room, profile, faults));
    }
    const byKey = Object.fromEntries(devices.map((device) => [device.profile.key, device]));
    await claimRoom(byKey['commander-only'].page, room, password);
    await waitForPlayers(request, baseURL, room, 6);
    const roster = (await roomSnapshot(request, baseURL, room)).players;
    expect(roster['n-qa-alpha'].name).toBe('Same Name');
    expect(roster['n-qa-beta'].name).toBe('Same Name');
    expect('n-qa-alpha').not.toBe('n-qa-beta');

    const firstPress = Math.ceil(Date.now() / 1000) + 12;
    const first = await mutate(byKey['commander-only'].page, room, {
      t: 'cmd', password,
      cmd: {
        type: 'double_rally', kingdom: 1, anchorUTC: firstPress,
        payload: {
          leadSeconds: 10, firstPress, kingdom: 1,
          pairs: [
            { pid: '700001', name: 'Captain A', role: 'weak', march: 31, pressUTC: firstPress },
            { pid: '700002', name: 'Captain B', role: 'main', march: 30, pressUTC: firstPress + 1 }
          ]
        }
      }
    });

    await expect.poll(async () => deliverySummary(request, baseURL, room, first.id)).toMatchObject({
      commandId: first.id,
      expectedDevices: 3,
      classicScheduled: 3,
      candidateAcked: 3,
      expired: 0,
      cancelled: false
    });
    await expect.poll(() => retryFrames.length).toBeGreaterThanOrEqual(2);
    expect(new Set(retryFrames).size).toBe(1);
    expect(parseFrame(retryFrames[0]).commandId).toBe(first.id);

    expect(await cueBases(byKey['captain-a-1'].page, first.id)).toEqual([first.id + '-me']);
    expect(await cueBases(byKey['captain-a-2'].page, first.id)).toEqual([first.id + '-me']);
    expect(await cueBases(byKey['captain-b'].page, first.id)).toEqual([first.id + '-me']);
    expect(await cueBases(byKey['member'].page, first.id)).toEqual([first.id + '-join']);
    expect(await cueBases(byKey['commander-only'].page, first.id)).toEqual([]);

    const secondPress = Math.ceil(Date.now() / 1000) + 12;
    const second = await mutate(byKey['commander-only'].page, room, {
      t: 'cmd', password,
      cmd: {
        type: 'double_rally', kingdom: 2, anchorUTC: secondPress,
        payload: {
          leadSeconds: 10, firstPress: secondPress, kingdom: 2,
          pairs: [
            { pid: '700004', name: 'Commander Captain', role: 'weak', march: 32, pressUTC: secondPress },
            { pid: '700002', name: 'Captain B', role: 'main', march: 30, pressUTC: secondPress + 2 }
          ]
        }
      }
    });
    await expect.poll(() => cueBases(byKey['selected-commander'].page, second.id))
      .toEqual([second.id + '-me']);

    await mutate(byKey['commander-only'].page, room, {
      t: 'cmd', password, cmd: { type: 'cancel', kingdom: 2 }
    });
    await expect.poll(() => cueBases(byKey['selected-commander'].page, second.id)).toEqual([]);
    await expect.poll(async () => deliverySummary(request, baseURL, room, second.id))
      .toMatchObject({ commandId: second.id, cancelled: true });
  } finally {
    await Promise.all(devices.map((device) => device.context.close()));
  }
});

test('offline selected device reconnects before cutoff without replaying or moving GO', async ({
  browser, baseURL, request
}, testInfo) => {
  const room = assertQaRoomName(makeQaRoom(testInfo));
  const password = PASSWORD();
  const a = await openDevice(browser, baseURL, room, {
    key: 'captain-a', pid: '710001', name: 'A', march: 31
  });
  const b = await openDevice(browser, baseURL, room, {
    key: 'captain-b', pid: '710002', name: 'B', march: 30
  });
  try {
    await claimRoom(b.page, room, password);
    await waitForPlayers(request, baseURL, room, 2);
    await a.context.setOffline(true);
    await a.page.evaluate(() => window.__kvkDeliveryQa.getSocket().ws.close());

    const press = Math.ceil(Date.now() / 1000) + 15;
    const command = await mutate(b.page, room, {
      t: 'cmd', password,
      cmd: {
        type: 'double_rally', kingdom: 1, anchorUTC: press,
        payload: {
          leadSeconds: 10, firstPress: press, kingdom: 1,
          pairs: [
            { pid: '710001', name: 'A', role: 'weak', march: 31, pressUTC: press },
            { pid: '710002', name: 'B', role: 'main', march: 30, pressUTC: press + 1 }
          ]
        }
      }
    });
    await a.context.setOffline(false);
    await a.page.evaluate(() => window.__kvkDeliveryQa.getSocket().kick());

    await expect.poll(async () => deliverySummary(request, baseURL, room, command.id)).toMatchObject({
      commandId: command.id, expectedDevices: 2,
      classicScheduled: 2, candidateAcked: 2, expired: 0
    });
    expect(await cueBases(a.page, command.id)).toEqual([command.id + '-me']);
    const candidateState = await a.page.evaluate(() => window.__kvkDeliveryQa.controller.state());
    expect(candidateState.seenCandidate).toEqual([command.id]);
  } finally {
    await Promise.all([a.context.close(), b.context.close()]);
  }
});
~~~

- [ ] **Step 5: Add focused scripts without removing core scripts**

Add these keys to the scripts object in kingshoter/package.json:

~~~json
"test:delivery": "node --test test/delivery-model.test.cjs test/room-delivery.test.cjs test/delivery-shadow-client.test.cjs test/delivery-browser-wiring.test.cjs test/qa-kvk-delivery-guard.test.cjs",
"test:qa:delivery": "playwright test -c playwright.qa-kvk.config.cjs",
"test:qa:delivery:chromium": "playwright test -c playwright.qa-kvk.config.cjs --project=chromium"
~~~

Do not alter type=module, test, deploy, dev, dependencies, or devDependencies.

- [ ] **Step 6: Run guard and focused unit tests**

Run: cd $KVK_WORKTREE/kingshoter && npm run test:delivery

Expected: all five focused test files pass, candidate source contains no audio primitive, helper-side operation-room attempts abort with Refusing non-QA KvK room:, direct server shadow messages return qa_room_required, and output ends with # fail 0.

- [ ] **Step 7: Install the declared browser engines**

Run: cd $KVK_WORKTREE/kingshoter && npx playwright install chromium firefox webkit

Expected: command exits 0 and Chromium, Firefox, and WebKit browser binaries are present. This installs test browsers only and does not change package.json or package-lock.json.

- [ ] **Step 8: Run the isolated local acceptance topology**

Run: cd $KVK_WORKTREE/kingshoter && npm run test:qa:delivery

Expected at the end of Task 7: six passing tests total, two specs in each of chromium, firefox, and webkit. Each project creates unique qa-kvk-* rooms; the first spec uses eight BrowserContexts; the dropped first deliveryShadowCommand is retried byte-for-byte with the same ID; candidate and Classic ACK counts reach 3/3; unselected commander is silent; selected commander has one personal base; cancel removes future bases; reconnect reaches 2/2; no test is described as physical iOS/Android evidence. Task 8 adds the third rollback spec and raises the final total to nine.

- [ ] **Step 9: Run the entire local unit suite**

Run: cd $KVK_WORKTREE/kingshoter && npm test

Expected: all tests pass, ending with # fail 0.

- [ ] **Step 10: Detect scope and commit**

Call gitnexus_detect_changes({scope:"staged", repo:"$GITNEXUS_REPO"}). Expected additions are QA test/config/scripts only. The helper itself must remain owned by the core plan, and no operation-room mutation or 1406 branch may appear.

~~~bash
git add kingshoter/test/qa-kvk-delivery-guard.test.cjs kingshoter/playwright.qa-kvk.config.cjs kingshoter/test/qa-kvk-delivery.spec.cjs kingshoter/package.json
git commit -m "test: orchestrate guarded reliable delivery QA"
~~~

---

### Task 8: Classic Rollback Proof and Honest Physical-Device Runbook

**Files:**
- Modify: kingshoter/test/qa-kvk-delivery.spec.cjs
- Create: kingshoter/docs/qa/kvk-reliable-shadow.md

**Interfaces:**
- Consumes: the same QA guard and Classic page without the deliveryShadow query.
- Produces: a rollback E2E that proves zero candidate frames/summary while Classic personal and join cues still exist, plus a physical-device evidence schema.
- This task records procedures and evidence; it does not promote Reliable or claim a mobile reliability improvement.

- [ ] **Step 1: Append the failing Classic-only rollback test**

Append to kingshoter/test/qa-kvk-delivery.spec.cjs:

~~~js
test('omitting the shadow flag is a zero-candidate Classic rollback', async ({
  browser, baseURL, request
}, testInfo) => {
  const room = assertQaRoomName(makeQaRoom(testInfo));
  const password = PASSWORD();
  const frames = [];
  const profiles = [
    { key: 'a', pid: '720001', name: 'A', march: 31 },
    { key: 'b', pid: '720002', name: 'B', march: 30 },
    { key: 'member', pid: '720003', name: 'Member', march: 25 }
  ];
  const devices = [];
  try {
    for (const profile of profiles) {
      devices.push(await openClassicDevice(browser, baseURL, room, profile, {
        shouldDropClientMessage({ data }) {
          const message = parseFrame(data);
          if (message && String(message.t || '').startsWith('deliveryShadow')) frames.push(message);
          return false;
        },
        shouldDropServerMessage({ data }) {
          const message = parseFrame(data);
          if (message && String(message.t || '').startsWith('deliveryShadow')) frames.push(message);
          return false;
        }
      }));
    }
    const byKey = Object.fromEntries(devices.map((device) => [device.profile.key, device]));
    await claimRoom(byKey.b.page, room, password);
    await waitForPlayers(request, baseURL, room, 3);
    const press = Math.ceil(Date.now() / 1000) + 12;
    const command = await mutate(byKey.b.page, room, {
      t: 'cmd', password,
      cmd: {
        type: 'double_rally', kingdom: 1, anchorUTC: press,
        payload: {
          leadSeconds: 10, firstPress: press, kingdom: 1,
          pairs: [
            { pid: '720001', name: 'A', role: 'weak', march: 31, pressUTC: press },
            { pid: '720002', name: 'B', role: 'main', march: 30, pressUTC: press + 1 }
          ]
        }
      }
    });
    await expect.poll(() => cueBases(byKey.a.page, command.id)).toEqual([command.id + '-me']);
    await expect.poll(() => cueBases(byKey.b.page, command.id)).toEqual([command.id + '-me']);
    await expect.poll(() => cueBases(byKey.member.page, command.id)).toEqual([command.id + '-join']);
    expect(frames).toEqual([]);
    expect((await roomSnapshot(request, baseURL, room)).deliveryShadow).toBeUndefined();
    for (const device of devices) {
      expect(await device.page.evaluate(() => window.__kvkDeliveryQa)).toBeUndefined();
    }
  } finally {
    await Promise.all(devices.map((device) => device.context.close()));
  }
});
~~~

- [ ] **Step 2: Run rollback test and verify its helper is intentionally absent**

Run: cd $KVK_WORKTREE/kingshoter && npx playwright test -c playwright.qa-kvk.config.cjs --project=chromium --grep="zero-candidate Classic rollback"

Expected: FAIL with ReferenceError: openClassicDevice is not defined; the guard must create a qa-kvk-* room before that failure.

- [ ] **Step 3: Add the explicit Classic-only context helper**

Add this function immediately after openDevice() in kingshoter/test/qa-kvk-delivery.spec.cjs:

~~~js
async function openClassicDevice(browser, baseURL, room, profile, faults = {}) {
  assertQaRoomName(room);
  const context = await browser.newContext();
  await installQaWebSocketGuard(context, room, faults);
  await context.addInitScript(({ profileValue, storageKey }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      pid: profileValue.pid,
      name: profileValue.name,
      march: profileValue.march
    }));
  }, { profileValue: profile, storageKey: meKey(room) });
  const page = await context.newPage();
  await page.goto(qaRoomUrl(baseURL, room));
  await expect(page.locator('#soundGate')).toBeVisible();
  await page.locator('#soundGate').click();
  expect(await page.evaluate(() => window.__kvkDeliveryQa)).toBeUndefined();
  return { context, page, profile };
}
~~~

This helper still installs the universal QA WebSocket guard before the page is created. The only difference is omission of deliveryShadow=1.

- [ ] **Step 4: Run the rollback test**

Run: cd $KVK_WORKTREE/kingshoter && npx playwright test -c playwright.qa-kvk.config.cjs --project=chromium --grep="zero-candidate Classic rollback"

Expected: one passing Chromium test. It observes personal Classic bases for both selected captains, one join base for the member, no deliveryShadow frame, no deliveryShadow snapshot, and no QA candidate controller. The production Classic deliveryAck remains expected and untouched.

- [ ] **Step 5: Write the exact QA and evidence runbook**

Create kingshoter/docs/qa/kvk-reliable-shadow.md:

~~~~markdown
# KvK Reliable Shadow QA

Reliable is a hidden QA candidate. Classic is the only audio authority. A candidate ACK is not proof that a person heard a sound, and Playwright WebKit is not an iPhone or iPad test.

## Hard room boundary

Every mutation in this runbook uses a newly generated room beginning with qa-kvk-. Do not replace it with an alliance, kingdom, demo, or operation room. There is no exception for any named room.

Generate a room:

~~~bash
cd $KVK_WORKTREE/kingshoter
node -e "const h=require('./test/support/qa-kvk.cjs'); console.log(h.makeQaRoom({title:'manual-reliable',project:{name:'manual'},workerIndex:0,retry:0,repeatEachIndex:0}))"
~~~

The command must print one lowercase qa-kvk-* value no longer than 48 characters. Generate a new value for every run.

## Local automated gate

~~~bash
cd $KVK_WORKTREE/kingshoter
npm test
npm run test:delivery
npx playwright install chromium firefox webkit
npm run test:qa:delivery
~~~

Required result: every command exits 0; the Playwright run reports nine passing tests, three per browser project. This proves routing, immutable retry, device isolation, cancellation, reconnect, aggregate privacy, and Classic rollback. It does not prove mobile background survival.

## Explicit production-connected QA gate

Do not run this command as part of normal implementation. Run it only with operator authorization after every local gate is green:

~~~bash
cd $KVK_WORKTREE/kingshoter
QA_BASE_URL=https://kingshoter.com ALLOW_PRODUCTION_QA=1 npm run test:qa:delivery
~~~

The harness generates a new qa-kvk-* room and random QA-only password. The config refuses the production origin unless ALLOW_PRODUCTION_QA=1.

## Frozen-lead physical wiring check

1. Generate a new qa-kvk-* room and a random password used only for that room.
2. On each physical device open https://kingshoter.com/kvk.html?room={generated-room}&deliveryShadow=1.
3. Enable sound with the existing user gesture and leave one device in commander view only, two selected captain devices, and one ordinary member.
4. From the commander browser send separate Double orders using the supported lead values 10, 15, 30, and 60 seconds; never invent an unsupported lead for evidence.
5. Record the immutable command ID and intended press times.
6. Confirm the unselected commander has no rally audio, each selected captain has one personal countdown, and the ordinary member has one generic join countdown.
7. Cancel a second 15-second order before GO and confirm no future cue remains.
8. Disconnect one selected device, send a 15-second order, reconnect before the retry cutoff, and record whether its original command ID is acknowledged without moving GO.
9. Repeat with deliveryShadow omitted and verify Classic still works with no candidate traffic.

Do not use a locally pre-scheduled timer as the server-driven command. The command must be created after the device is backgrounded or moved behind Kingshot.

## Background survival runs

Run separate 5-, 15-, 60-, and 180-minute trials for each physical capability group. Test foreground, background tab, Kingshot foreground, screen lock, offline/online transition, phone/audio interruption, Bluetooth route change, process restart, battery saver, and whole-device sleep where available.

Whole-device sleep and operating-system process termination are recorded as unsupported for live timing when delivery does not occur. They are not converted into a success claim.

## Evidence record

Record one row per device and command:

| Field | Required value |
|---|---|
| runId | random QA run identifier |
| room | generated qa-kvk-* room |
| commandId | exact server command ID |
| platform | OS name and exact version |
| browser | browser name and exact version |
| deviceId | random QA device ID; do not record a full user agent |
| view | player or commander |
| selectedRole | weak, main, or none |
| visibility | foreground, background, locked, Kingshot foreground, or restarted |
| interruption | none, offline/online, call, Bluetooth, battery saver, memory pressure, or sleep |
| issuedAtMs | server issue timestamp |
| fireAtMs | immutable target timestamp |
| classicScheduledAtMs | timestamp or absent |
| classicFutureCueCount | integer 0–12 |
| candidateResult | would_schedule, audio_unarmed, expired, duplicate, or absent |
| candidateAckAtMs | timestamp or absent |
| retryCount | integer |
| humanObserved | yes, no, or unknown |
| observedGoDeltaMs | measured delta or unknown |
| notes | battery, heat, data, audio focus, and anomalies |

## Promotion and rollback

Classic remains default. Do not call Reliable better based on desktop automation or one device. Promotion requires a material receipt improvement, timing no worse than Classic, no duplicate/stale GO, acceptable battery/data/maintenance, a simple workflow, and independently passing physical capability groups.

Rollback is omission of deliveryShadow=1. It requires no room migration and must retain the shared commander-audience and identity corrections from the core plan. The shared server foundation—`src/delivery.js`, merge-safe socket attachments, private state, alarm multiplexing, and `dispatchDeliveryForCommand()`—is a frozen dependency of Triple and must remain unless Triple is first refactored away from it. A failed candidate may remove only the browser shadow adapter, its script tag, and candidate-specific evidence tests; it must not delete the shared foundation. Never leave a permanent player-facing selector.
~~~~

- [ ] **Step 6: Run the complete local verification**

Run: cd $KVK_WORKTREE/kingshoter && npm test

Expected: every unit test passes with # fail 0.

Run: cd $KVK_WORKTREE/kingshoter && npm run test:delivery

Expected: every Reliable unit/guard test passes with # fail 0.

Run: cd $KVK_WORKTREE/kingshoter && npm run test:qa:delivery

Expected: nine passing tests total: topology, reconnect, and rollback in each of chromium, firefox, and webkit.

Run: cd $KVK_WORKTREE/kingshoter && rg -n "AudioContext|createOscillator|scheduleBeeps|schedulePrepareCue|speechSynthesis|vibrate" public/kvk-delivery-shadow.js

Expected: no output and exit status 1.

Run: cd $KVK_WORKTREE/kingshoter && rg -n "\\b(room|roomName)\\s*===\\s*['\\\"][a-z0-9-]+['\\\"]" src/delivery.js src/room.js public/kvk-delivery-shadow.js test/support/qa-kvk.cjs

Expected: no output and exit status 1.

- [ ] **Step 7: Run final change detection and commit evidence**

Call gitnexus_detect_changes({scope:"staged", repo:"$GITNEXUS_REPO"}). Expected final scope is the Classic rollback QA spec and the runbook only. Review the cumulative report: Classic command timing and audio-authority flows are unchanged; Reliable changes are additive QA-only flows.

~~~bash
git add kingshoter/test/qa-kvk-delivery.spec.cjs kingshoter/docs/qa/kvk-reliable-shadow.md
git commit -m "docs: add reliable shadow QA and rollback gate"
~~~

---

## Completion Gate

- [ ] All Task 1–8 focused tests pass.
- [ ] npm test ends with # fail 0.
- [ ] Chromium, Firefox, and WebKit each pass topology, reconnect, and rollback.
- [ ] The first dropped candidate frame is retried with the same serialized envelope and commandId.
- [ ] Candidate source has no sound-producing or cue-scheduling primitive.
- [ ] Classic without deliveryShadow=1 creates personal/join cues and zero deliveryShadow candidate traffic; the production Classic deliveryAck remains active.
- [ ] Every test room is unique and qa-kvk-*; helper-side operation-room inputs abort with Refusing non-QA KvK room: before connection, while direct server shadow messages are rejected before mutation with qa_room_required.
- [ ] Public snapshots contain only commandId and aggregate counts; no pid, deviceId, attachment, probe, or ACK timestamp is public.
- [ ] Alarm tests prove Classic expiry, challenge leases, retries, cancellation, and expiry share one alarm.
- [ ] Reconnect tests prove an unexpired command may be resent unchanged and an expired command remains silent.
- [ ] No core player UI, nickname UI, roster UI, out-of-scope mode or transport, build pipeline, or build/version interface was added.
- [ ] Physical-device evidence, if absent, is explicitly recorded as absent and Classic remains default.
