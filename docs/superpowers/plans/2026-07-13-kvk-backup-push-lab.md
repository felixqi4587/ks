# KvK Backup Web Push Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hidden, opt-in Backup Web Push lab that can deliver short-lived QA rally notifications without changing Classic countdown behavior or exposing controls to ordinary users.

**Architecture:** Add one isolated `DeliveryLab` Durable Object behind fail-closed `/api/lab/delivery/*` routes and a separately scoped `/lab/push.html` PWA. The lab owns private sessions, Push subscriptions, delayed QA jobs, A/B assignment, diagnostic receipts, and bounded evidence; it never writes `Room`, never imports Classic audio code, and can be disabled or deleted independently.

**Tech Stack:** Cloudflare Workers, SQLite-backed Durable Objects, Worker alarms and hibernatable WebSockets, `web-push@3.6.7`, VAPID, vanilla JavaScript, service workers, IndexedDB, Node `node:test`, Playwright, Wrangler 4.110.0.

## Global Constraints

- Prerequisite: the core delivery change has landed `kingshoter/test/support/qa-kvk.cjs` with the four shared exports shown below and has migrated every production-capable Classic QA script used here to that guard. If the helper or migration is absent, stop; do not recreate it or fall back to a literal room.
- Classic remains the production default and rollback path; do not modify `kingshoter/src/room.js`, `kingshoter/public/kvk.js`, `kingshoter/public/kvk.html`, `kingshoter/public/app.js`, or `kingshoter/public/app.css` in this plan.
- Do not add a link, badge, prompt, manifest, service-worker registration, warning, or mode selector to any ordinary-user page.
- Disabled Backup never blocks Fire, warns a commander, lowers normal status, or asks again for permission.
- Every lab mutation requires `DELIVERY_LAB_ENABLED === "1"`, `DELIVERY_LAB_PUSH_ENABLED === "1"`, and a room matching `^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$` with total length at most 48. `POST /session` additionally requires the QA-only room password; every later mutation requires the resulting valid private lab session.
- Every non-`qa-kvk-*` room is rejected by the same validator before Durable Object lookup, WebSocket connection, service-worker registration, subscription creation, or HTTP mutation. There is no exact-room exception or branch.
- Production-connected tests create a fresh `qa-kvk-*` room and random QA-only password; local integration runs first.
- Push payloads contain an immutable `commandId`, absolute `eventAtMs`, `role`, and `expiresAtMs`; a payload handled at or after expiry produces no notification.
- Push uses high urgency and a provider TTL no longer than the remaining useful lifetime.
- Provider acceptance and service-worker handling are diagnostic states, never proof that a human saw or heard the notification and never Classic `Received ✓`.
- Do not send a custom sound: Web Push supplies the platform notification channel only.
- Subscription endpoints, `p256dh`, `auth`, session tokens, room-password hashes, and VAPID private material stay out of public snapshots and logs.
- Every POST/DELETE, including session bootstrap, checks that the `Origin` header equals the request URL origin; responses use `Cache-Control: no-store` and never add permissive CORS headers.
- `VAPID_PRIVATE_KEY` remains a Cloudflare secret; `.dev.vars` remains ignored by Git.
- Device and command identifiers are validated and length-limited; records use `Map`, arrays, or exact storage keys rather than attacker-controlled object properties.
- Private state is bounded: at most 12 devices, 32 pending operations, and 256 evidence events per QA room; stale records are removed by the lab alarm.
- No retry may create a duplicate notification. Ambiguous Push-service failures are recorded and not retried after the short useful window.
- No promotion or reliability claim is allowed from headless tests, Playwright WebKit, Push-provider acceptance, or service-worker receipt alone; physical-device evidence is mandatory.
- Before modifying an existing function, class, or method, run `gitnexus_impact` upstream and report direct callers, affected processes, and risk. Warn on HIGH or CRITICAL risk, then proceed under the user's standing approval.
- Before every implementation commit, verify the index is current, confirm there are no pre-existing staged files, stage only that task's listed paths, then run `gitnexus_detect_changes(scope="staged")`; confirm Classic Fire, state, countdown, and audio flows are unchanged. Never unstage or absorb user-owned changes to make this check pass.
- Preserve all unrelated dirty-worktree changes.

---

## File Structure

### Existing files modified

- `kingshoter/src/worker.js` — one fail-closed lab route branch and `DeliveryLab` export only.
- `kingshoter/wrangler.toml` — `nodejs_compat`, `DELIVERY_LAB` binding, and uniquely tagged SQLite class migration.
- `kingshoter/package.json` — exact `web-push` dependency and focused lab scripts.
- `kingshoter/package-lock.json` — lockfile generated by npm.

### New server files

- `kingshoter/src/lab/qa-room.mjs` — canonical QA-room validation shared by Worker routing and the DO.
- `kingshoter/src/lab/push-policy.mjs` — immutable timing, bounds, and event-name constants.
- `kingshoter/src/lab/router.mjs` — kill-switch and QA-room gate before DO lookup.
- `kingshoter/src/lab/push.mjs` — VAPID configuration, payload construction, TTL/urgency/topic, and Push-service result normalization.
- `kingshoter/src/lab/push-ab.mjs` — pure target filtering, operation planning, exact-ACK matching, and at-most-once claim rules.
- `kingshoter/src/lab/delivery-lab.mjs` — private sessions, subscriptions, QA jobs, hibernatable lab socket, alarm dispatch, A/B behavior, receipts, observations, and cleanup.

### New hidden client files

- `kingshoter/public/lab/push.html` — unlinked, no-index lab UI.
- `kingshoter/public/lab/push.css` — lab-only styles.
- `kingshoter/public/lab/push.js` — inert bootstrap, private session, opt-in subscription, delayed test controls, status, and human observation.
- `kingshoter/public/lab/push-shared.js` — browser/service-worker payload and QA-room validation without network side effects.
- `kingshoter/public/lab/push-sw.js` — Push handling, IndexedDB dedupe, stale suppression, notification display, and diagnostic receipt.
- `kingshoter/public/lab/push.webmanifest` — scope `/lab/`, standalone start page, lab-only icons.
- `kingshoter/public/lab/icons/push-192.png` — generated from the existing fish favicon.
- `kingshoter/public/lab/icons/push-512.png` — generated from the existing fish favicon.

### New tests and evidence documentation

- `kingshoter/test/support/qa-kvk.cjs` — pre-existing shared production-test guard supplied by the core delivery plan; this plan consumes it unchanged.
- `kingshoter/test/delivery-lab-guard.test.cjs` — route and protected-room tests.
- `kingshoter/test/support/delivery-lab-fakes.cjs` — deterministic in-memory DO storage/state and Push spies used only by lab tests.
- `kingshoter/test/delivery-lab-storage.test.cjs` — private state, bounds, expiry, and session tests.
- `kingshoter/test/delivery-lab-push.test.cjs` — TTL, urgency, stale suppression, invalid-subscription cleanup, and no-retry tests.
- `kingshoter/test/delivery-lab-ab.test.cjs` — immediate/no-ACK assignment, exact lab ACK, and alarm idempotency tests.
- `kingshoter/test/delivery-lab-pwa.test.cjs` — manifest, scope, dedupe, privacy, and invisibility source tests.
- `kingshoter/test/delivery-lab-push.e2e.cjs` — isolated-context local integration harness.
- `docs/labs/kvk-backup-push-lab.md` — physical-device procedure, evidence table, decision thresholds, kill, and deletion commands.

### Shared interfaces

```js
// kingshoter/test/support/qa-kvk.cjs — owned by the core delivery plan
module.exports = {
  assertQaRoomName(room),         // -> validated qa-kvk-* string; throws before network/browser setup
  makeQaRoom(testInfo),           // -> unique lowercase qa-kvk-* string, <= 48 chars
  qaRoomUrl(baseURL, room, params = {}),
  installQaWebSocketGuard(context, room, options = {})
};

// installQaWebSocketGuard() accepts an optional asynchronous
// options.installFaults(context, room) hook; its default behavior adds no faults.

// Core Classic ACK remains separate and is never sent to DeliveryLab:
// {t:'deliveryAck', commandId, pid, deviceId,
//  outcome:'scheduled'|'expired', targetUTC, scheduledAtMs}

// DeliveryLab live-channel diagnostic ACK:
// {t:'pushLabAck', commandId, deviceId,
//  outcome:'scheduled'|'expired', eventAtMs, handledAtMs}

// DeliveryLab Push payload and live command use an explicit directed field:
// {commandId, issuedAtMs, eventAtMs, expiresAtMs,
//  role:'main'|'weak', targetDeviceId}
```

---

### Task 1: Lock the QA-room and Worker routing boundary

**Files:**
- Create: `kingshoter/src/lab/qa-room.mjs`
- Create: `kingshoter/src/lab/router.mjs`
- Create: `kingshoter/test/delivery-lab-guard.test.cjs`
- Modify: `kingshoter/src/worker.js:7-47`

**Interfaces:**
- Consumes: `env.DELIVERY_LAB_ENABLED`, `env.DELIVERY_LAB_PUSH_ENABLED`, `env.DELIVERY_LAB`, and `Request`.
- Produces: `normalizeQaRoom(value): string | null`, `requireQaRoom(value): string`, and `routeDeliveryLab(request, env): Promise<Response>`.
- Guarantees: invalid/protected rooms return before `env.DELIVERY_LAB.idFromName()`; disabled route returns 404; non-lab routes retain their exact current branches.

- [ ] **Step 1: Record the existing entry-point impact before editing**

Run GitNexus:

```text
gitnexus_impact({
  target: "fetch",
  file_path: "kingshoter/src/worker.js",
  kind: "Method",
  direction: "upstream",
  includeTests: true,
  repo: "kingshot"
})
```

Expected: current index reports LOW, 0 direct callers, 0 affected processes. Record that manual risk is broader because `fetch` is the sole HTTP/static entry point. If a refreshed index reports HIGH or CRITICAL, warn the user before proceeding.

- [ ] **Step 2: Write the failing room and route tests**

Create `kingshoter/test/delivery-lab-guard.test.cjs` with these cases:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const load = (file) => import(pathToFileURL(path.join(root, file)).href + `?v=${Date.now()}-${Math.random()}`);

test('QA-room validator accepts only bounded qa-kvk names', async () => {
  const { normalizeQaRoom, requireQaRoom } = await load('src/lab/qa-room.mjs');
  assert.equal(normalizeQaRoom('qa-kvk-20260713-7f3a'), 'qa-kvk-20260713-7f3a');
  for (const room of ['operation-room', '', 'qa-kvk-', 'QA-KVK-x', 'qa-kvk-x_', '__proto__', `qa-kvk-${'x'.repeat(42)}`]) {
    assert.equal(normalizeQaRoom(room), null, room);
    assert.throws(() => requireQaRoom(room), /invalid_qa_room/);
  }
});

test('route rejects protected and malformed rooms before DO lookup', async () => {
  const { routeDeliveryLab } = await load('src/lab/router.mjs');
  let lookups = 0;
  const env = {
    DELIVERY_LAB_ENABLED: '1',
    DELIVERY_LAB_PUSH_ENABLED: '1',
    DELIVERY_LAB: {
      idFromName() { lookups++; return 'id'; },
      get() { throw new Error('must not get a stub'); }
    }
  };
  for (const room of ['operation-room', 'prod', 'qa-kvk-']) {
    const response = await routeDeliveryLab(new Request(`https://kingshoter.test/api/lab/delivery/status?room=${room}`), env);
    assert.ok(response.status === 400 || response.status === 403);
  }
  assert.equal(lookups, 0);
});

test('either disabled switch is indistinguishable from a missing route', async () => {
  const { routeDeliveryLab } = await load('src/lab/router.mjs');
  for (const flags of [
    { DELIVERY_LAB_ENABLED: '0', DELIVERY_LAB_PUSH_ENABLED: '1' },
    { DELIVERY_LAB_ENABLED: '1', DELIVERY_LAB_PUSH_ENABLED: '0' },
    { DELIVERY_LAB_ENABLED: undefined, DELIVERY_LAB_PUSH_ENABLED: undefined }
  ]) {
    let lookups = 0;
    const response = await routeDeliveryLab(
      new Request('https://kingshoter.test/api/lab/delivery/status?room=qa-kvk-disabled'),
      { ...flags, DELIVERY_LAB: { idFromName() { lookups++; } } }
    );
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.equal(response.status, 404);
    assert.equal(lookups, 0);
  }
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test test/delivery-lab-guard.test.cjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lab/qa-room.mjs` or `src/lab/router.mjs`.

- [ ] **Step 4: Implement the exact QA validator**

Create `kingshoter/src/lab/qa-room.mjs`:

```js
const QA_ROOM = /^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/;

export function normalizeQaRoom(value) {
  const room = typeof value === 'string' ? value : '';
  if (room.length > 48 || !QA_ROOM.test(room)) return null;
  return room;
}

export function requireQaRoom(value) {
  const room = normalizeQaRoom(value);
  if (!room) throw new Error('invalid_qa_room');
  return room;
}
```

- [ ] **Step 5: Implement the fail-closed router**

Create `kingshoter/src/lab/router.mjs`:

```js
import { requireQaRoom } from './qa-room.mjs';

const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export async function routeDeliveryLab(request, env) {
  if (env.DELIVERY_LAB_ENABLED !== '1' || env.DELIVERY_LAB_PUSH_ENABLED !== '1') {
    return json({ error: 'not_found' }, 404);
  }
  const url = new URL(request.url);
  let room;
  try { room = requireQaRoom(url.searchParams.get('room')); }
  catch (error) {
    return json({ error: error.message }, 400);
  }
  if (!env.DELIVERY_LAB || typeof env.DELIVERY_LAB.idFromName !== 'function') {
    return json({ error: 'lab_unavailable' }, 503);
  }
  const id = env.DELIVERY_LAB.idFromName(`delivery:${room}`);
  const headers = new Headers(request.headers);
  headers.delete('x-kvk-lab-room');
  headers.set('x-kvk-lab-room', room);
  return env.DELIVERY_LAB.get(id).fetch(new Request(request, { headers }));
}
```

- [ ] **Step 6: Add only the isolated branch to the Worker entry**

Modify `kingshoter/src/worker.js`:

```js
export { Room } from './room.js';
import { routeDeliveryLab } from './lab/router.mjs';

// Inside fetch(), after `const url = new URL(request.url);` and before ASSETS fallback:
if (url.pathname.startsWith('/api/lab/delivery/')) {
  return routeDeliveryLab(request, env);
}
```

Do not change the existing `/api/ws`, `/api/g/*`, `/api/lookup`, `/api/time`, `/api/codes`, scheduled handler, or `env.ASSETS.fetch(request)` bodies.

- [ ] **Step 7: Run guard and existing unit tests**

Run:

```bash
node --test test/delivery-lab-guard.test.cjs
npm test
```

Expected: guard tests PASS and `npm test` has zero failures with no loss from the then-current core baseline (18/18 at plan-authoring time, before the core prerequisite adds tests). Task 1 does not import or export the not-yet-created `delivery-lab.mjs`, so its commit is independently runnable.

- [ ] **Step 8: Detect changes and commit the boundary**

```bash
git diff --cached --quiet
git add kingshoter/src/worker.js kingshoter/src/lab/qa-room.mjs kingshoter/src/lab/router.mjs kingshoter/test/delivery-lab-guard.test.cjs
```

If the first command reports pre-existing staged work, stop without unstaging it. Otherwise run `gitnexus_detect_changes(scope="staged", repo="kingshot")` and verify the only existing symbol touched is `worker.fetch`; no Classic browser process is affected. Then run:

```bash
git commit -m "test: protect delivery lab room boundary"
```

Expected: commit succeeds with no Classic files staged.

---

### Task 2: Add the private DeliveryLab session and bounded storage substrate

**Files:**
- Create: `kingshoter/src/lab/push-policy.mjs`
- Create: `kingshoter/src/lab/delivery-lab.mjs`
- Create: `kingshoter/test/support/delivery-lab-fakes.cjs`
- Create: `kingshoter/test/delivery-lab-storage.test.cjs`
- Modify: `kingshoter/src/worker.js:7-10`
- Modify: `kingshoter/wrangler.toml:1-24`

**Interfaces:**
- Consumes: internal `x-kvk-lab-room`, Worker environment flags, DO storage, and WebSocket Hibernation APIs.
- Produces: `DeliveryLab.fetch(request)`, `DeliveryLab.alarm()`, `DeliveryLab.webSocketMessage(ws, raw)`, private cookie `ks_delivery_lab`, and bounded storage records.
- Session endpoint: `POST /api/lab/delivery/session?room=...` body `{password, deviceId, platform, role, pushVariant}`.
- Session response: `{ok:true, deviceId, pushEnabled, vapidPublicKey}` plus HttpOnly cookie.

- [ ] **Step 1: Create the deterministic DO fake and write failing private-state tests**

Create `kingshoter/test/support/delivery-lab-fakes.cjs`:

```js
class MemoryStorage {
  constructor(entries = []) { this.rows = new Map(entries); this.alarmAt = null; }
  async get(key) { return this.rows.get(key); }
  async put(key, value) { this.rows.set(key, structuredClone(value)); }
  async delete(key) { this.rows.delete(key); }
  async list(options = {}) {
    const prefix = options.prefix || '';
    return new Map([...this.rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]));
  }
  async setAlarm(atMs) { this.alarmAt = atMs; }
  async deleteAlarm() { this.alarmAt = null; }
  async getAlarm() { return this.alarmAt; }
  async transaction(fn) { return fn(this); }
}

function makeState(entries = []) {
  const storage = new MemoryStorage(entries);
  const sockets = new Map();
  return {
    storage,
    sockets,
    blockConcurrencyWhile(fn) { return fn(); },
    acceptWebSocket(socket, tags = []) { for (const tag of tags) sockets.set(tag, [...(sockets.get(tag) || []), socket]); },
    getWebSockets(tag) { return tag ? (sockets.get(tag) || []) : [...sockets.values()].flat(); }
  };
}

module.exports = { MemoryStorage, makeState };
```

Create `kingshoter/test/delivery-lab-storage.test.cjs` with assertions for:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const load = (file) => import(pathToFileURL(path.join(root, file)).href + `?v=${Date.now()}-${Math.random()}`);

test('lab policy fixes bounds and approved test durations', async () => {
  const { PUSH_POLICY } = await load('src/lab/push-policy.mjs');
  assert.deepEqual(PUSH_POLICY.allowedDelayMinutes, [5, 15, 60, 180]);
  assert.equal(PUSH_POLICY.maxDevices, 12);
  assert.equal(PUSH_POLICY.maxOperations, 32);
  assert.equal(PUSH_POLICY.maxEvents, 256);
  assert.equal(PUSH_POLICY.maxCommands, 64);
  assert.equal(PUSH_POLICY.noAckDelayMs, 1500);
  assert.equal(PUSH_POLICY.eventLeadMs, 10000);
});

test('public lab status cannot contain Push secrets', async () => {
  const { publicDeviceStatus } = await load('src/lab/delivery-lab.mjs');
  const result = publicDeviceStatus({
    deviceId: 'd1234567890', platform: 'ios-home', role: 'main', pushVariant: 'immediate',
    subscription: { endpoint: 'https://secret', keys: { p256dh: 'p', auth: 'a' } },
    sessionHash: 'secret', passwordHash: 'secret', lastPushResult: 'handled'
  });
  assert.deepEqual(result, {
    deviceId: 'd1234567890', platform: 'ios-home', role: 'main', pushVariant: 'immediate',
    subscribed: true, lastPushResult: 'handled', lastCommandId: null
  });
  assert.doesNotMatch(JSON.stringify(result), /endpoint|p256dh|auth|sessionHash|passwordHash/);
});

test('identifier validators reject prototype keys and oversized values', async () => {
  const { cleanDeviceId, cleanPlatform } = await load('src/lab/delivery-lab.mjs');
  assert.equal(cleanDeviceId('d-1234567890abcdef'), 'd-1234567890abcdef');
  for (const value of ['', '__proto__', 'constructor', 'x'.repeat(65), 'bad space']) {
    assert.throws(() => cleanDeviceId(value), /invalid_device_id/);
  }
  assert.equal(cleanPlatform('android-chrome'), 'android-chrome');
  assert.equal(cleanPlatform('full user agent must never be retained'), 'other');
});

test('both kill switches gate the DO before storage mutation', async () => {
  const { makeState } = require('./support/delivery-lab-fakes.cjs');
  const { DeliveryLab } = await load('src/lab/delivery-lab.mjs');
  for (const env of [
    { DELIVERY_LAB_ENABLED: '0', DELIVERY_LAB_PUSH_ENABLED: '1' },
    { DELIVERY_LAB_ENABLED: '1', DELIVERY_LAB_PUSH_ENABLED: '0' }
  ]) {
    const state = makeState();
    const response = await new DeliveryLab(state, env).fetch(new Request('https://local/api/lab/delivery/session', {
      method: 'POST', headers: { 'x-kvk-lab-room': 'qa-kvk-disabled' }, body: '{}'
    }));
    assert.equal(response.status, 404);
    assert.equal((await state.storage.list()).size, 0);
  }
});

test('session stays private, enforces one room password, and expires', async () => {
  const { makeState } = require('./support/delivery-lab-fakes.cjs');
  const { DeliveryLab } = await load('src/lab/delivery-lab.mjs');
  const state = makeState();
  const lab = new DeliveryLab(state, {
    DELIVERY_LAB_ENABLED: '1', DELIVERY_LAB_PUSH_ENABLED: '1', VAPID_PUBLIC_KEY: 'public-test-key'
  });
  const join = (password, deviceId) => lab.fetch(new Request('https://local/api/lab/delivery/session', {
    method: 'POST', headers: { Origin: 'https://local', 'x-kvk-lab-room': 'qa-kvk-storage' },
    body: JSON.stringify({ password, deviceId, platform: 'ios-home', role: 'main', pushVariant: 'immediate' })
  }));
  const accepted = await join('qa-only-password', 'device-00000001');
  assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get('set-cookie');
  assert.match(cookie, /^ks_delivery_lab=/);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(await accepted.text(), /qa-only-password|session:|passwordHash/);
  assert.equal((await join('wrong-password', 'device-00000002')).status, 403);
  const unauthorized = await lab.fetch(new Request('https://local/api/lab/delivery/status', {
    headers: { 'x-kvk-lab-room': 'qa-kvk-storage' }
  }));
  assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' });
  assert.equal(unauthorized.status, 401);
});

test('device, event, and alarm state are bounded and expiry-driven', async () => {
  const { makeState } = require('./support/delivery-lab-fakes.cjs');
  const { DeliveryLab } = await load('src/lab/delivery-lab.mjs');
  const { PUSH_POLICY } = await load('src/lab/push-policy.mjs');
  const now = 5_000;
  const entries = Array.from({ length: PUSH_POLICY.maxEvents }, (_, index) => [
    `event:${String(index).padStart(13, '0')}:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    { atMs: index, expiresAtMs: now + 100 + index }
  ]);
  entries.push(['session:expired', { deviceId: 'device-expired', room: 'qa-kvk-storage', expiresAtMs: now }]);
  entries.push(['operation:soon', { dueAtMs: now + 50, expiresAtMs: now + 1_000 }]);
  const state = makeState(entries);
  const lab = new DeliveryLab(state, { DELIVERY_LAB_ENABLED: '1', DELIVERY_LAB_PUSH_ENABLED: '1' });
  await lab.cleanup(now);
  assert.equal(await state.storage.get('session:expired'), undefined);
  await lab.appendEvent({ atMs: now, outcome: 'handled' });
  assert.equal((await state.storage.list({ prefix: 'event:' })).size, PUSH_POLICY.maxEvents);
  await lab.scheduleNextAlarm();
  assert.equal(await state.storage.getAlarm(), now + 50);
});

test('a QA room stores at most twelve devices', async () => {
  const { makeState } = require('./support/delivery-lab-fakes.cjs');
  const { DeliveryLab } = await load('src/lab/delivery-lab.mjs');
  const { PUSH_POLICY } = await load('src/lab/push-policy.mjs');
  const lab = new DeliveryLab(makeState(), { DELIVERY_LAB_ENABLED: '1', DELIVERY_LAB_PUSH_ENABLED: '1' });
  const join = (index) => lab.fetch(new Request('https://local/api/lab/delivery/session', {
    method: 'POST', headers: { Origin: 'https://local', 'x-kvk-lab-room': 'qa-kvk-device-cap' },
    body: JSON.stringify({ password: 'qa-device-password', deviceId: `device-${String(index).padStart(8, '0')}`, role: 'member' })
  }));
  for (let index = 0; index < PUSH_POLICY.maxDevices; index++) assert.equal((await join(index)).status, 200);
  assert.equal((await join(PUSH_POLICY.maxDevices)).status, 409);
});
```

- [ ] **Step 2: Run storage tests and verify RED**

Run:

```bash
node --test test/delivery-lab-storage.test.cjs
```

Expected: FAIL with missing `push-policy.mjs` or `delivery-lab.mjs`.

- [ ] **Step 3: Create the immutable lab policy**

Create `kingshoter/src/lab/push-policy.mjs`:

```js
export const PUSH_POLICY = Object.freeze({
  allowedDelayMinutes: Object.freeze([5, 15, 60, 180]),
  eventLeadMs: 10_000,
  noAckDelayMs: 1_500,
  minDelayedRemainingMs: 5_000,
  maxDevices: 12,
  maxOperations: 32,
  maxEvents: 256,
  maxCommands: 64,
  sessionTtlMs: 6 * 60 * 60 * 1000,
  deviceTtlMs: 7 * 24 * 60 * 60 * 1000,
  eventTtlMs: 24 * 60 * 60 * 1000,
  maxJsonBytes: 16 * 1024
});

export const PUSH_VARIANTS = Object.freeze(['immediate', 'no_ack']);
export const DEVICE_ROLES = Object.freeze(['main', 'weak', 'commander', 'member']);
```

- [ ] **Step 4: Implement the minimal private session class**

Create `kingshoter/src/lab/delivery-lab.mjs` with these exact exported helpers and class responsibilities:

```js
import { requireQaRoom } from './qa-room.mjs';
import { DEVICE_ROLES, PUSH_POLICY, PUSH_VARIANTS } from './push-policy.mjs';

const enc = new TextEncoder();
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
});

const sha256 = async (value) => {
  const bytes = await crypto.subtle.digest('SHA-256', enc.encode(String(value)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export function cleanDeviceId(value) {
  const id = typeof value === 'string' ? value : '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id) || id === '__proto__' || id === 'constructor') {
    throw new Error('invalid_device_id');
  }
  return id;
}

export function cleanPlatform(value) {
  return ['ios-home', 'android-chrome', 'mac-safari', 'desktop-chrome', 'desktop-edge', 'desktop-firefox'].includes(value)
    ? value : 'other';
}

export function publicDeviceStatus(device) {
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    role: device.role,
    pushVariant: device.pushVariant,
    subscribed: !!device.subscription,
    lastPushResult: device.lastPushResult || null,
    lastCommandId: device.lastCommandId || null
  };
}

export class DeliveryLab {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (this.env.DELIVERY_LAB_ENABLED !== '1' || this.env.DELIVERY_LAB_PUSH_ENABLED !== '1') {
      return json({ error: 'not_found' }, 404);
    }
    try {
      const url = new URL(request.url);
      if (['POST', 'DELETE'].includes(request.method) && request.headers.get('Origin') !== url.origin) {
        return json({ error: 'bad_origin' }, 403);
      }
      const room = requireQaRoom(request.headers.get('x-kvk-lab-room'));
      if (url.pathname.endsWith('/session') && request.method === 'POST') {
        return await this.createSession(request, room);
      }
      if (url.pathname.endsWith('/status') && request.method === 'GET') {
        const session = await this.requireSession(request, room);
        const device = await this.state.storage.get(`device:${session.deviceId}`);
        const devices = device && device.role === 'commander'
          ? [...(await this.state.storage.list({ prefix: 'device:' })).values()].map(publicDeviceStatus)
          : undefined;
        return json({ ok: true, device: publicDeviceStatus(device), devices, pushEnabled: true });
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error && error.message === 'unauthorized') return json({ error: 'unauthorized' }, 401);
      if (error && /^(invalid_|weak_password)/.test(error.message)) return json({ error: error.message }, 400);
      throw error;
    }
  }

  async createSession(request, room) {
    const raw = await request.text();
    if (enc.encode(raw).byteLength > PUSH_POLICY.maxJsonBytes) return json({ error: 'body_too_large' }, 413);
    let body; try { body = JSON.parse(raw); } catch { return json({ error: 'bad_json' }, 400); }
    const now = Date.now();
    const deviceId = cleanDeviceId(body.deviceId);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 12 || password.length > 128) return json({ error: 'weak_password' }, 400);
    const passwordHash = await sha256(password);
    const role = DEVICE_ROLES.includes(body.role) ? body.role : 'member';
    const pushVariant = PUSH_VARIANTS.includes(body.pushVariant) ? body.pushVariant : 'immediate';
    const device = { deviceId, platform: cleanPlatform(body.platform), role, pushVariant, room, updatedAtMs: now, expiresAtMs: now + PUSH_POLICY.deviceTtlMs };
    let sessionError = null;
    await this.state.storage.transaction(async (txn) => {
      const passwordRecord = await txn.get('lab:password');
      if (passwordRecord && passwordRecord.expiresAtMs > now && passwordRecord.hash !== passwordHash) {
        sessionError = ['bad_password', 403]; return;
      }
      const devices = await txn.list({ prefix: 'device:' });
      if (!devices.has(`device:${deviceId}`) && devices.size >= PUSH_POLICY.maxDevices) {
        sessionError = ['device_limit', 409]; return;
      }
      await txn.put('lab:password', { hash: passwordHash, expiresAtMs: now + PUSH_POLICY.deviceTtlMs });
      await txn.put(`device:${deviceId}`, device);
    });
    if (sessionError) return json({ error: sessionError[0] }, sessionError[1]);
    const token = crypto.randomUUID() + crypto.randomUUID();
    const tokenHash = await sha256(token);
    await this.state.storage.put(`session:${tokenHash}`, { deviceId, room, expiresAtMs: now + PUSH_POLICY.sessionTtlMs });
    await this.scheduleNextAlarm();
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return json({ ok: true, deviceId, pushEnabled: this.env.DELIVERY_LAB_PUSH_ENABLED === '1', vapidPublicKey: this.env.VAPID_PUBLIC_KEY || null }, 200, {
      'Set-Cookie': `ks_delivery_lab=${token}; Max-Age=${PUSH_POLICY.sessionTtlMs / 1000}; HttpOnly; SameSite=Strict; Path=/api/lab/delivery${secure}`
    });
  }

  async requireSession(request, room) {
    const match = /(?:^|;\s*)ks_delivery_lab=([^;]+)/.exec(request.headers.get('Cookie') || '');
    if (!match) throw new Error('unauthorized');
    const record = await this.state.storage.get(`session:${await sha256(match[1])}`);
    if (!record || record.room !== room || record.expiresAtMs <= Date.now()) throw new Error('unauthorized');
    return record;
  }

  async alarm() {
    await this.cleanup(Date.now());
    await this.scheduleNextAlarm();
  }

  async cleanup(now) {
    for (const prefix of ['lab:', 'session:', 'device:', 'operation:', 'command:', 'ack:', 'event:']) {
      const rows = await this.state.storage.list({ prefix });
      for (const [key, value] of rows) {
        const deleteAtMs = prefix === 'operation:' ? value.deleteAtMs : value.expiresAtMs;
        if (Number.isFinite(deleteAtMs) && deleteAtMs <= now) await this.state.storage.delete(key);
      }
    }
  }

  async appendEvent(event) {
    const rows = await this.state.storage.list({ prefix: 'event:' });
    const overflow = Math.max(0, rows.size - PUSH_POLICY.maxEvents + 1);
    for (const key of [...rows.keys()].sort().slice(0, overflow)) await this.state.storage.delete(key);
    const atMs = Number(event.atMs);
    const key = `event:${String(atMs).padStart(13, '0')}:${crypto.randomUUID()}`;
    await this.state.storage.put(key, { ...event, atMs, expiresAtMs: atMs + PUSH_POLICY.eventTtlMs });
    await this.scheduleNextAlarm();
  }

  async scheduleNextAlarm() {
    const rows = await this.state.storage.list();
    const due = [];
    for (const [key, value] of rows) {
      if (key.startsWith('operation:') && !value.doneAtMs && Number.isFinite(value.dueAtMs)) due.push(value.dueAtMs);
      const deleteAtMs = key.startsWith('operation:') ? value.deleteAtMs : value.expiresAtMs;
      if (Number.isFinite(deleteAtMs)) due.push(deleteAtMs);
    }
    if (due.length) await this.state.storage.setAlarm(Math.min(...due));
    else await this.state.storage.deleteAlarm();
  }
}
```

When adding later route handlers, wrap `requireSession` failures and return `{error:'unauthorized'}` with status 401; never serialize the thrown object or cookie.

- [ ] **Step 5: Add the dedicated binding and migration**

Modify `kingshoter/wrangler.toml`:

```toml
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "DELIVERY_LAB"
class_name = "DeliveryLab"

[[migrations]]
tag = "deliverylab-add-20260713"
new_sqlite_classes = ["DeliveryLab"]
```

Keep the existing `ROOM` binding and `v1` migration unchanged and ordered before `deliverylab-add-20260713`.

- [ ] **Step 6: Complete the Worker export and run RED/GREEN checks**

Ensure `kingshoter/src/worker.js` contains:

```js
export { DeliveryLab } from './lab/delivery-lab.mjs';
```

Run:

```bash
node --test test/delivery-lab-storage.test.cjs test/delivery-lab-guard.test.cjs
npx wrangler deploy --dry-run
```

Expected: focused tests PASS; Wrangler lists both `ROOM (Room)` and `DELIVERY_LAB (DeliveryLab)` and exits on `--dry-run` without upload.

- [ ] **Step 7: Detect changes and commit the private substrate**

```bash
git diff --cached --quiet
git add kingshoter/src/worker.js kingshoter/src/lab/push-policy.mjs kingshoter/src/lab/delivery-lab.mjs kingshoter/wrangler.toml kingshoter/test/support/delivery-lab-fakes.cjs kingshoter/test/delivery-lab-storage.test.cjs
```

Stop on pre-existing staged work. Otherwise run `gitnexus_detect_changes(scope="staged", repo="kingshot")` and confirm no `Room`, `fireDouble`, `onState`, `scheduleAllCues`, or `enableSound` changes. Then run:

```bash
git commit -m "feat: add private backup push lab object"
npx gitnexus analyze
```

Expected: commit succeeds, then GitNexus refreshes the index so Task 3 can impact-check the newly added `DeliveryLab` symbols before editing them.

---

### Task 3: Add VAPID Push sending with expiry and invalid-subscription cleanup

**Files:**
- Create: `kingshoter/src/lab/push.mjs`
- Create: `kingshoter/test/delivery-lab-push.test.cjs`
- Create: `kingshoter/.dev.vars.example`
- Modify: `kingshoter/package.json`
- Modify: `kingshoter/package-lock.json`
- Modify: `kingshoter/src/lab/delivery-lab.mjs`

**Interfaces:**
- Consumes: `web-push.sendNotification`, VAPID bindings, private Push subscription, and immutable command payload.
- Produces: `buildBackupPayload(command, device)`, `pushOptions(command, now)`, `cleanSubscription(value)`, `applyPushResult(device, result, now)`, and `sendBackupPush({command, device, vapid, sendNotification, now})` returning `{outcome, statusCode}`.
- Outcomes: `provider_accepted`, `expired`, `subscription_gone`, or `provider_failed`. None maps to Classic `Received ✓`.

- [ ] **Step 1: Install the exact runtime dependency**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm install --save-exact web-push@3.6.7
```

Expected: `package.json` contains `"web-push": "3.6.7"`; npm updates `package-lock.json`; no `agents` or additional framework is installed.

- [ ] **Step 2: Write failing Push-policy tests with a fake sender**

Create `kingshoter/test/delivery-lab-push.test.cjs` covering:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const load = (file) => import(pathToFileURL(path.join(root, file)).href + `?v=${Date.now()}-${Math.random()}`);

const command = {
  commandId: '11111111-1111-4111-8111-111111111111', room: 'qa-kvk-push',
  issuedAtMs: 1_000, eventAtMs: 11_000, expiresAtMs: 11_000, role: 'main'
};
const device = {
  deviceId: 'device-12345678', role: 'main',
  subscription: { endpoint: 'https://push.example/sub', keys: { p256dh: 'p', auth: 'a' } }
};
const vapid = { subject: 'mailto:ops@example.com', publicKey: 'pub', privateKey: 'priv' };

test('Push uses immutable absolute fields, high urgency, and remaining TTL', async () => {
  const calls = [];
  const { sendBackupPush } = await load('src/lab/push.mjs');
  const result = await sendBackupPush({
    command, device, vapid, now: 2_100,
    sendNotification: async (...args) => { calls.push(args); return { statusCode: 201 }; }
  });
  assert.equal(result.outcome, 'provider_accepted');
  const [subscription, raw, options] = calls[0];
  assert.equal(subscription.endpoint, device.subscription.endpoint);
  assert.deepEqual(JSON.parse(raw), {
    v: 1, commandId: command.commandId, room: command.room,
    issuedAtMs: command.issuedAtMs,
    eventAtMs: command.eventAtMs, expiresAtMs: command.expiresAtMs,
    role: 'main', targetDeviceId: device.deviceId
  });
  assert.equal(options.urgency, 'high');
  assert.equal(options.TTL, 8);
  assert.equal(options.timeout, 3_000);
  assert.ok(options.TTL * 1000 <= command.expiresAtMs - 2_100);
  assert.equal(options.topic.length, 32);
  assert.deepEqual(options.vapidDetails, vapid);
});

test('expired Push is suppressed before provider contact', async () => {
  let calls = 0;
  const { sendBackupPush } = await load('src/lab/push.mjs');
  const result = await sendBackupPush({ command, device, vapid, now: 11_000, sendNotification: async () => { calls++; } });
  assert.deepEqual(result, { outcome: 'expired', statusCode: 0 });
  assert.equal(calls, 0);
});

test('404 and 410 are normalized for private subscription deletion', async () => {
  const { sendBackupPush } = await load('src/lab/push.mjs');
  for (const statusCode of [404, 410]) {
    const result = await sendBackupPush({
      command, device, vapid, now: 2_000,
      sendNotification: async () => { const error = new Error('gone'); error.statusCode = statusCode; throw error; }
    });
    assert.deepEqual(result, { outcome: 'subscription_gone', statusCode });
  }
});

test('temporary provider failure is recorded without automatic retry', async () => {
  const { sendBackupPush } = await load('src/lab/push.mjs');
  let calls = 0;
  const result = await sendBackupPush({
    command, device, vapid, now: 2_000,
    sendNotification: async () => { calls++; const error = new Error('unavailable'); error.statusCode = 503; throw error; }
  });
  assert.deepEqual(result, { outcome: 'provider_failed', statusCode: 503 });
  assert.equal(calls, 1);
});

test('subscription normalization is bounded and a gone result removes it privately', async () => {
  const { cleanSubscription, applyPushResult } = await load('src/lab/delivery-lab.mjs');
  const subscription = cleanSubscription({
    endpoint: 'https://push.example/subscription', expirationTime: null,
    keys: { p256dh: 'public-client-key', auth: 'client-auth-secret' }
  });
  assert.equal(subscription.endpoint, 'https://push.example/subscription');
  assert.throws(() => cleanSubscription({ endpoint: 'http://push.example', keys: { p256dh: 'p', auth: 'a' } }), /invalid_subscription/);
  const updated = applyPushResult({ ...device, subscription }, { outcome: 'subscription_gone', statusCode: 410 }, 3_000);
  assert.equal(updated.subscription, undefined);
  assert.equal(updated.lastPushResult, 'subscription_gone');
  assert.equal(updated.lastPushAtMs, 3_000);
});
```

- [ ] **Step 3: Run Push tests and verify RED**

Run:

```bash
node --test test/delivery-lab-push.test.cjs
```

Expected: FAIL with missing `src/lab/push.mjs`.

- [ ] **Step 4: Implement the Push adapter**

Create `kingshoter/src/lab/push.mjs`:

```js
import webpush from 'web-push';

export function buildBackupPayload(command, device) {
  return Object.freeze({
    v: 1,
    commandId: command.commandId,
    room: command.room,
    issuedAtMs: command.issuedAtMs,
    eventAtMs: command.eventAtMs,
    expiresAtMs: command.expiresAtMs,
    role: command.role,
    targetDeviceId: device.deviceId
  });
}

export function pushOptions(command, now, vapid) {
  const remainingMs = command.expiresAtMs - now;
  if (remainingMs <= 0) return null;
  return {
    TTL: Math.max(0, Math.floor(remainingMs / 1000)),
    timeout: Math.max(250, Math.min(3_000, remainingMs)),
    urgency: 'high',
    topic: command.commandId.replace(/-/g, '').slice(0, 32),
    vapidDetails: vapid
  };
}

export async function sendBackupPush({ command, device, vapid, now = Date.now(), sendNotification = webpush.sendNotification.bind(webpush) }) {
  const options = pushOptions(command, now, vapid);
  if (!options) return { outcome: 'expired', statusCode: 0 };
  try {
    const response = await sendNotification(device.subscription, JSON.stringify(buildBackupPayload(command, device)), options);
    return { outcome: 'provider_accepted', statusCode: Number(response && response.statusCode) || 201 };
  } catch (error) {
    const statusCode = Number(error && error.statusCode) || 0;
    if (statusCode === 404 || statusCode === 410) return { outcome: 'subscription_gone', statusCode };
    return { outcome: 'provider_failed', statusCode };
  }
}
```

- [ ] **Step 5: Impact-check the indexed DeliveryLab symbols before editing them**

Run:

```text
gitnexus_impact({
  target: "DeliveryLab",
  file_path: "kingshoter/src/lab/delivery-lab.mjs",
  direction: "upstream",
  includeTests: true,
  repo: "kingshot"
})
```

Report the risk, direct callers, and affected processes. The expected result is LOW with only the Worker export/new lab tests. If the refreshed index reports HIGH or CRITICAL, warn the user before proceeding.

- [ ] **Step 6: Add subscription registration and private deletion to the DO**

Extend `DeliveryLab.fetch()` with authenticated `POST` and `DELETE` handling for `/push/subscription`. Validate exactly:

```js
export function cleanSubscription(value) {
  const endpoint = value && typeof value.endpoint === 'string' ? value.endpoint : '';
  const keys = value && value.keys;
  if (!endpoint.startsWith('https://') || endpoint.length > 2048) throw new Error('invalid_subscription');
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') throw new Error('invalid_subscription');
  if (keys.p256dh.length > 256 || keys.auth.length > 128) throw new Error('invalid_subscription');
  return { endpoint, expirationTime: Number.isFinite(value.expirationTime) ? value.expirationTime : null, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export function applyPushResult(device, result, now) {
  const next = { ...device, lastPushResult: result.outcome, lastPushAtMs: now };
  if (result.outcome === 'subscription_gone') delete next.subscription;
  return next;
}
```

On POST, require `DELIVERY_LAB_PUSH_ENABLED === '1'`, save the normalized subscription only inside `device:<deviceId>`, and return `{ok:true, subscribed:true}`. On DELETE, delete only `device.subscription`, persist, and return `{ok:true, subscribed:false}`. Neither response includes subscription fields.

- [ ] **Step 7: Document local and production bindings without values**

Create `kingshoter/.dev.vars.example`:

```dotenv
DELIVERY_LAB_ENABLED=0
DELIVERY_LAB_PUSH_ENABLED=0
DELIVERY_LAB_ALLOW_SHORT_DELAYS=0
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:ops@kingshoter.com
```

Generate and install real keys interactively; do not redirect or print private values into tracked files:

```bash
npx web-push generate-vapid-keys --json
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put DELIVERY_LAB_ENABLED
npx wrangler secret put DELIVERY_LAB_PUSH_ENABLED
```

Expected: Wrangler confirms each secret upload without writing values to `wrangler.toml`.

- [ ] **Step 8: Run Push, storage, security, and dry-run checks**

Run:

```bash
node --test test/delivery-lab-push.test.cjs test/delivery-lab-storage.test.cjs
npm test
npx wrangler deploy --dry-run
git check-ignore -q .dev.vars
rg -n 'VAPID_PRIVATE_KEY\s*=\s*\S+|https://.*(?:fcm|push\.apple|mozilla).*auth' . --glob '!node_modules/**' --glob '!.dev.vars'
```

Expected: all tests PASS; dry run bundles `web-push`; `git check-ignore` exits 0; the final `rg` returns no tracked secret assignment or stored subscription fixture outside focused tests.

- [ ] **Step 9: Detect changes and commit Push sending**

```bash
git diff --cached --quiet
git add kingshoter/package.json kingshoter/package-lock.json kingshoter/.dev.vars.example kingshoter/src/lab/push.mjs kingshoter/src/lab/delivery-lab.mjs kingshoter/test/delivery-lab-push.test.cjs
```

Stop on pre-existing staged work. Otherwise run `gitnexus_detect_changes(scope="staged", repo="kingshot")` and verify only new lab symbols and the already-reviewed Worker entry/config are affected. Then run:

```bash
git commit -m "feat: send expiring backup push alerts"
npx gitnexus analyze
```

---

### Task 4: Implement server-driven QA jobs and immediate versus no-ACK behavior

**Files:**
- Create: `kingshoter/src/lab/push-ab.mjs`
- Create: `kingshoter/test/delivery-lab-ab.test.cjs`
- Modify: `kingshoter/src/lab/delivery-lab.mjs`

**Interfaces:**
- Arm request: `POST /api/lab/delivery/push/arm?room=...` body `{delayMinutes, targetDeviceIds}`; local-only body `{delaySeconds:5, targetDeviceIds}` is accepted only when `DELIVERY_LAB_ALLOW_SHORT_DELAYS === "1"`.
- Directed lab command: `{t:'pushLabCommand', commandId, issuedAtMs, eventAtMs, expiresAtMs, targetDeviceId, role}`.
- Candidate ACK: `{t:'pushLabAck', commandId, deviceId, outcome:'scheduled'|'expired', eventAtMs, handledAtMs}`.
- Operation record: `{operationId, kind:'issue'|'push_send', variant:null|'immediate'|'no_ack', dueAtMs, commandId, targetDeviceId, claimedAtMs, doneAtMs, outcome, expiresAtMs, deleteAtMs, reservedSlots}`; `expiresAtMs` is the action deadline and `deleteAtMs` is bounded-storage cleanup.
- Private diagnostics: authenticated `POST /push/receipt`, `POST /observation`, commander-only `POST /classic-baseline`, and commander-only `GET /evidence`; none writes Classic room state.

- [ ] **Step 1: Write concrete failing A/B and at-most-once tests**

Create `kingshoter/test/delivery-lab-ab.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { makeState } = require('./support/delivery-lab-fakes.cjs');
const root = path.join(__dirname, '..');
const load = (file) => import(pathToFileURL(path.join(root, file)).href + `?v=${Date.now()}-${Math.random()}`);

const commandId = '11111111-1111-4111-8111-111111111111';
const now = 1_000;
const operation = {
  operationId: '22222222-2222-4222-8222-222222222222', kind: 'issue',
  room: 'qa-kvk-ab', dueAtMs: now, expiresAtMs: 61_000,
  targetDeviceIds: ['device-main-0001', 'device-weak-0001', 'device-command-1', 'device-member-01']
};
const devices = [
  { deviceId: 'device-main-0001', role: 'main', pushVariant: 'immediate', subscription: { endpoint: 'https://push.example/main' } },
  { deviceId: 'device-weak-0001', role: 'weak', pushVariant: 'no_ack', subscription: { endpoint: 'https://push.example/weak' } },
  { deviceId: 'device-command-1', role: 'commander', pushVariant: 'immediate', subscription: { endpoint: 'https://push.example/commander' } },
  { deviceId: 'device-member-01', role: 'member', pushVariant: 'immediate', subscription: { endpoint: 'https://push.example/member' } }
];

test('issue planning targets only main/weak and delays only no-ACK', async () => {
  const { planIssue } = await load('src/lab/push-ab.mjs');
  const plan = planIssue({ operation, devices, now, commandId });
  assert.deepEqual(plan.command, {
    commandId, room: 'qa-kvk-ab', issuedAtMs: 1_000,
    eventAtMs: 11_000, expiresAtMs: 11_000
  });
  assert.deepEqual(plan.pushOperations.map((item) => ({
    targetDeviceId: item.targetDeviceId, role: item.role, variant: item.variant, dueAtMs: item.dueAtMs
  })), [
    { targetDeviceId: 'device-main-0001', role: 'main', variant: 'immediate', dueAtMs: 1_000 },
    { targetDeviceId: 'device-weak-0001', role: 'weak', variant: 'no_ack', dueAtMs: 2_500 }
  ]);
  assert.deepEqual(plan.liveMessages.map((message) => message.targetDeviceId), ['device-main-0001', 'device-weak-0001']);
});

test('only an exact scheduled pushLabAck suppresses the matching no-ACK operation', async () => {
  const { pushDecision } = await load('src/lab/push-ab.mjs');
  const pending = {
    kind: 'push_send', variant: 'no_ack', commandId,
    targetDeviceId: 'device-weak-0001', eventAtMs: 11_000, expiresAtMs: 11_000
  };
  const matching = { commandId, deviceId: 'device-weak-0001', outcome: 'scheduled', eventAtMs: 11_000 };
  assert.equal(pushDecision(pending, matching, 2_500), 'ack_suppressed');
  assert.equal(pushDecision(pending, { ...matching, commandId: '33333333-3333-4333-8333-333333333333' }, 2_500), 'send');
  assert.equal(pushDecision(pending, { ...matching, deviceId: 'device-main-0001' }, 2_500), 'send');
  assert.equal(pushDecision(pending, { ...matching, outcome: 'expired' }, 2_500), 'send');
  assert.equal(pushDecision(pending, { ...matching, eventAtMs: 11_001 }, 2_500), 'send');
});

test('no-ACK fallback with less than five seconds remaining expires without send', async () => {
  const { pushDecision } = await load('src/lab/push-ab.mjs');
  const pending = {
    kind: 'push_send', variant: 'no_ack', commandId,
    targetDeviceId: 'device-weak-0001', eventAtMs: 11_000, expiresAtMs: 11_000
  };
  assert.equal(pushDecision(pending, null, 6_001), 'expired');
  assert.equal(pushDecision(pending, null, 6_000), 'send');
});

test('operation is claimed before the provider call and alarm redelivery cannot send twice', async () => {
  const { executePushOperation } = await load('src/lab/push-ab.mjs');
  const state = makeState();
  const key = 'operation:44444444-4444-4444-8444-444444444444';
  await state.storage.put(key, {
    operationId: key.slice(10), kind: 'push_send', variant: 'immediate',
    commandId, targetDeviceId: 'device-main-0001', role: 'main',
    dueAtMs: 1_000, eventAtMs: 11_000, expiresAtMs: 11_000
  });
  let providerCalls = 0;
  let doneWasPersistedBeforeSend = false;
  const sendPush = async () => {
    providerCalls++;
    doneWasPersistedBeforeSend = !!(await state.storage.get(key)).doneAtMs;
    return { outcome: 'provider_accepted', statusCode: 201 };
  };
  assert.equal((await executePushOperation({ storage: state.storage, key, now: 1_000, sendPush })).outcome, 'provider_accepted');
  assert.equal((await executePushOperation({ storage: state.storage, key, now: 1_001, sendPush })).outcome, 'already_done');
  assert.equal(providerCalls, 1);
  assert.equal(doneWasPersistedBeforeSend, true);
});

test('matching ACK produces no provider call and a terminal operation outcome', async () => {
  const { executePushOperation } = await load('src/lab/push-ab.mjs');
  const state = makeState();
  const key = 'operation:55555555-5555-4555-8555-555555555555';
  await state.storage.put(key, {
    operationId: key.slice(10), kind: 'push_send', variant: 'no_ack',
    commandId, targetDeviceId: 'device-weak-0001', role: 'weak',
    dueAtMs: 2_500, eventAtMs: 11_000, expiresAtMs: 11_000
  });
  await state.storage.put(`ack:${commandId}:device-weak-0001`, {
    commandId, deviceId: 'device-weak-0001', outcome: 'scheduled', eventAtMs: 11_000, expiresAtMs: 86_411_000
  });
  let providerCalls = 0;
  const result = await executePushOperation({ storage: state.storage, key, now: 2_500, sendPush: async () => { providerCalls++; } });
  assert.equal(result.outcome, 'ack_suppressed');
  assert.equal(providerCalls, 0);
  assert.equal((await state.storage.get(key)).doneAtMs, 2_500);
});
```

- [ ] **Step 2: Run A/B tests and verify RED**

Run:

```bash
node --test test/delivery-lab-ab.test.cjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lab/push-ab.mjs`.

- [ ] **Step 3: Implement the pure target, decision, and claim rules**

Create `kingshoter/src/lab/push-ab.mjs`:

```js
import { PUSH_POLICY } from './push-policy.mjs';

const PUSH_ROLES = new Set(['main', 'weak']);

export function selectPushTargets(devices, targetDeviceIds) {
  const byId = new Map(devices.map((device) => [device.deviceId, device]));
  return [...new Set(targetDeviceIds)]
    .map((deviceId) => byId.get(deviceId))
    .filter((device) => device && device.subscription && PUSH_ROLES.has(device.role));
}

export function planIssue({ operation, devices, now, commandId }) {
  const command = {
    commandId, room: operation.room, issuedAtMs: now,
    eventAtMs: now + PUSH_POLICY.eventLeadMs,
    expiresAtMs: now + PUSH_POLICY.eventLeadMs
  };
  const targets = selectPushTargets(devices, operation.targetDeviceIds);
  const pushOperations = targets.map((device) => ({
    kind: 'push_send', variant: device.pushVariant,
    dueAtMs: now + (device.pushVariant === 'no_ack' ? PUSH_POLICY.noAckDelayMs : 0),
    commandId, targetDeviceId: device.deviceId, role: device.role,
    eventAtMs: command.eventAtMs, expiresAtMs: command.expiresAtMs,
    deleteAtMs: command.expiresAtMs + PUSH_POLICY.eventTtlMs
  }));
  const liveMessages = pushOperations.map((item) => ({
    t: 'pushLabCommand', ...command, targetDeviceId: item.targetDeviceId, role: item.role
  }));
  return { command, pushOperations, liveMessages };
}

export function pushDecision(operation, ack, now) {
  if (operation.doneAtMs || operation.claimedAtMs) return 'already_done';
  if (now >= operation.expiresAtMs) return 'expired';
  if (operation.variant === 'no_ack' && operation.expiresAtMs - now < PUSH_POLICY.minDelayedRemainingMs) return 'expired';
  if (operation.variant === 'no_ack' && ack &&
      ack.commandId === operation.commandId &&
      ack.deviceId === operation.targetDeviceId &&
      ack.eventAtMs === operation.eventAtMs &&
      ack.outcome === 'scheduled') return 'ack_suppressed';
  return 'send';
}

export async function executePushOperation({ storage, key, now, sendPush }) {
  let claimed = null;
  let terminal = 'already_done';
  await storage.transaction(async (txn) => {
    const current = await txn.get(key);
    if (!current) { terminal = 'missing'; return; }
    const ack = current.variant === 'no_ack'
      ? await txn.get(`ack:${current.commandId}:${current.targetDeviceId}`)
      : null;
    const decision = pushDecision(current, ack, now);
    if (decision === 'already_done') { terminal = decision; return; }
    const completed = { ...current, claimedAtMs: now, doneAtMs: now, outcome: decision === 'send' ? 'claimed' : decision };
    await txn.put(key, completed);
    terminal = decision;
    if (decision === 'send') claimed = completed;
  });
  if (!claimed) return { outcome: terminal, statusCode: 0 };
  const result = await sendPush(claimed);
  const latest = await storage.get(key);
  await storage.put(key, { ...latest, outcome: result.outcome, statusCode: result.statusCode });
  return result;
}
```

Claiming before the external call intentionally chooses at-most-once delivery: a crash after claim may miss one experimental Push, but alarm redelivery cannot duplicate it.

- [ ] **Step 4: Impact-check DeliveryLab before adding routes and alarm behavior**

Run:

```text
gitnexus_impact({
  target: "DeliveryLab",
  file_path: "kingshoter/src/lab/delivery-lab.mjs",
  direction: "upstream",
  includeTests: true,
  repo: "kingshot"
})
```

Also impact-check `DeliveryLab.fetch` and `DeliveryLab.alarm` if GitNexus indexes them separately. Report direct callers/processes and warn before proceeding on HIGH or CRITICAL risk.

- [ ] **Step 5: Add authenticated WebSocket, arm, receipt, observation, and evidence routes**

In `DeliveryLab.fetch()`, add `GET /ws` only after cookie authentication:

```js
if (url.pathname.endsWith('/ws') && request.headers.get('Upgrade') === 'websocket') {
  const session = await this.requireSession(request, room);
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.serializeAttachment({ room, deviceId: session.deviceId });
  this.state.acceptWebSocket(server, [session.deviceId]);
  return new Response(null, { status: 101, webSocket: client });
}
```

Implement `webSocketMessage` so it accepts only `pushLabAck`; validates UUID, finite integer timestamps, and `scheduled|expired`; requires attachment device ID to equal `message.deviceId`; loads `command:<commandId>` and requires `record.command.eventAtMs === message.eventAtMs`; then stores `ack:<commandId>:<deviceId>` with `expiresAtMs = record.command.expiresAtMs + PUSH_POLICY.eventTtlMs`. Ignore every other message type, including core `deliveryAck`.

All JSON routes reuse one reader that rejects bodies over `PUSH_POLICY.maxJsonBytes` before parsing. The authenticated `POST /push/arm` route must require the current device role `commander`, validate 1–12 unique registered target IDs through `cleanDeviceId`, accept only 5/15/60/180 minutes (or exact local `delaySeconds:5` under `DELIVERY_LAB_ALLOW_SHORT_DELAYS === '1'`), and reserve `1 + targetDeviceIds.length` pending slots. Sum `reservedSlots || 1` across unfinished operations and reject with 409 if the total would exceed 32. Store only the `issue` operation at arm time with `expiresAtMs = dueAtMs + 60_000` and `deleteAtMs = expiresAtMs + PUSH_POLICY.eventTtlMs`; do not create a command or browser timer. Return `{ok:true,operationId,dueAtMs}` after `scheduleNextAlarm()`.

Add these private endpoints:

- `POST /push/receipt`: body `{commandId,targetDeviceId,eventAtMs,outcome,handledAtMs}`; require session device equals `targetDeviceId`, exact stored command time, and outcome `handled|expired|duplicate_suppressed|invalid_payload`; append a bounded `channel:'service_worker'` event.
- `POST /observation`: body `{commandId,observed,atMs,visibility,interruption}`; require a stored command targeting the session device; append a bounded `channel:'human'` event with boolean `observed` and strings clamped to 40 characters.
- `POST /classic-baseline`: commander-only body `{commandId,targetUTC,classicAckAtMs,classicOutcome}` copied from a separate Classic QA command/`deliveryAck` aggregate; validate UUID and integer times, accept only `scheduled|expired|no_confirmation`, and append `channel:'classic_baseline'`. This endpoint records a comparison and never sends or mutates a Classic command.
- `GET /evidence`: require current device role `commander`; return `{ok:true,events:[...]}` sorted by `atMs` and containing only room, randomized device ID, coarse platform, command/timing/variant/outcome/observation fields. Assert in tests that serialized evidence never contains `endpoint`, `p256dh`, `auth`, `passwordHash`, `session:`, or a cookie token.

The status route sets `lastCommandId` per target and gives the commander the scrubbed device list; it never includes subscription material.

- [ ] **Step 6: Expand issue operations atomically and dispatch each Push at most once**

At `alarm()` time, run cleanup, then repeatedly process sorted due operations until no due item remains or 32 items have been handled. For an `issue` operation:

1. Load registered devices and call `planIssue` with a fresh UUID and `now`.
2. Refuse/finish with `command_limit` if 64 unexpired command records exist.
3. In one storage transaction, re-read the still-unfinished issue operation, mark it claimed/done, store `command:<id>` as `{command, targetDeviceIds, expiresAtMs: command.expiresAtMs + eventTtlMs}`, store one `push_send` operation per planned eligible target with a fresh UUID, and set `lastCommandId` only on those eligible target device records.
4. After the transaction, send each `pushLabCommand` to only `state.getWebSockets(targetDeviceId)`. A socket send failure is diagnostic and does not reopen the completed issue operation.
5. For every due `push_send`, call `executePushOperation`. Its injected `sendPush` callback loads the command and current private device, calls `sendBackupPush`, applies `applyPushResult`, stores the scrubbed provider event, and never throws the subscription endpoint into logs. Append a terminal private event for `ack_suppressed`, `expired`, `provider_accepted`, `subscription_gone`, or `provider_failed` so evidence never equates silence with success.

Call `scheduleNextAlarm()` after processing. Provider acceptance remains `provider_accepted`; it never becomes Classic receipt or human observation.

- [ ] **Step 7: Run A/B and complete unit suites**

Run:

```bash
node --test test/delivery-lab-ab.test.cjs test/delivery-lab-push.test.cjs test/delivery-lab-storage.test.cjs test/delivery-lab-guard.test.cjs
npm test
```

Expected: all focused tests PASS; existing suite remains fully PASS. The at-most-once test proves `doneAtMs` exists before the fake provider is called and exactly one provider call occurs across two deliveries of the same alarm.

- [ ] **Step 8: Detect changes and commit A/B behavior**

```bash
git diff --cached --quiet
git add kingshoter/src/lab/push-ab.mjs kingshoter/src/lab/delivery-lab.mjs kingshoter/test/delivery-lab-ab.test.cjs
```

Stop on pre-existing staged work. Otherwise run `gitnexus_detect_changes(scope="staged", repo="kingshot")` and verify no Classic command, state, or audio process appears. Then run:

```bash
git commit -m "feat: compare immediate and no-ack backup push"
npx gitnexus analyze
```

---

### Task 5: Build the scoped PWA and stale-safe service worker

**Files:**
- Create: `kingshoter/public/lab/push-shared.js`
- Create: `kingshoter/public/lab/push-sw.js`
- Create: `kingshoter/public/lab/push.webmanifest`
- Create: `kingshoter/public/lab/icons/push-192.png`
- Create: `kingshoter/public/lab/icons/push-512.png`
- Create: `kingshoter/test/delivery-lab-pwa.test.cjs`

**Interfaces:**
- Produces: `self.KvkPushLab.validatePayload(value, now)`, IndexedDB database `kvk-push-lab-v1`, notification tag `kvk-lab-<commandId>`, and receipt outcomes `handled`, `expired`, `duplicate_suppressed`, or `invalid_payload`.
- Service-worker scope is exactly `/lab/`; there is no `fetch` listener.

- [ ] **Step 1: Write failing PWA scope and privacy tests**

Create `kingshoter/test/delivery-lab-pwa.test.cjs` that reads source files and asserts:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('ordinary pages contain no lab entry or service-worker registration', () => {
  const classic = ['public/index.html', 'public/kvk.html', 'public/kvk.js', 'public/app.js'].map(read).join('\n');
  assert.doesNotMatch(classic, /push\.html|push-sw\.js|push\.webmanifest|Enable backup alerts|DELIVERY_LAB/);
});

test('manifest is confined to the hidden lab scope', () => {
  const manifest = JSON.parse(read('public/lab/push.webmanifest'));
  assert.equal(manifest.id, '/lab/push');
  assert.equal(manifest.start_url, '/lab/push.html');
  assert.equal(manifest.scope, '/lab/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
});

test('service worker has Push handlers but no request interception or custom sound', () => {
  const sw = read('public/lab/push-sw.js');
  assert.match(sw, /addEventListener\(['"]push['"]/);
  assert.match(sw, /addEventListener\(['"]notificationclick['"]/);
  assert.doesNotMatch(sw, /addEventListener\(['"]fetch['"]/);
  assert.doesNotMatch(sw, /sound\s*:|audio\//);
  assert.match(sw, /Date\.now\(\)\s*>=\s*payload\.expiresAtMs/);
  assert.match(sw, /getNotifications\(\{\s*tag:/);
  assert.match(sw, /notification\.close\(\)/);
});

test('shared validator rejects stale or misdirected payloads', () => {
  const sandbox = { self: {} };
  vm.runInNewContext(read('public/lab/push-shared.js'), sandbox);
  const payload = {
    v: 1, commandId: '11111111-1111-4111-8111-111111111111',
    room: 'qa-kvk-pwa', issuedAtMs: 1_000, eventAtMs: 11_000, expiresAtMs: 11_000,
    role: 'main', targetDeviceId: 'device-12345678'
  };
  assert.equal(sandbox.self.KvkPushLab.validatePayload(payload, 10_999).ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.self.KvkPushLab.validatePayload(payload, 11_000))),
    { ok: false, reason: 'expired', payload }
  );
  assert.equal(sandbox.self.KvkPushLab.validatePayload({ ...payload, targetDeviceId: '__proto__' }, 2_000).reason, 'invalid_payload');
  assert.equal(sandbox.self.KvkPushLab.validatePayload({ ...payload, expiresAtMs: 11_001 }, 2_000).reason, 'invalid_payload');
});
```

- [ ] **Step 2: Run PWA tests and verify RED**

Run:

```bash
node --test test/delivery-lab-pwa.test.cjs
```

Expected: FAIL with `ENOENT` for the manifest or service worker.

- [ ] **Step 3: Implement the shared validation module**

Create `kingshoter/public/lab/push-shared.js` as a side-effect-free IIFE:

```js
(function (root) {
  'use strict';
  var QA_ROOM = /^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/;
  function validatePayload(value, now) {
    if (!value || value.v !== 1) return { ok: false, reason: 'invalid_payload' };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value.commandId || ''))) return { ok: false, reason: 'invalid_payload' };
    if (!QA_ROOM.test(String(value.room || ''))) return { ok: false, reason: 'invalid_payload' };
    if (!['main', 'weak'].includes(value.role)) return { ok: false, reason: 'invalid_payload' };
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(value.targetDeviceId || ''))) return { ok: false, reason: 'invalid_payload' };
    if (!Number.isSafeInteger(value.issuedAtMs) || !Number.isSafeInteger(value.eventAtMs) || !Number.isSafeInteger(value.expiresAtMs)) return { ok: false, reason: 'invalid_payload' };
    if (value.issuedAtMs >= value.eventAtMs || value.expiresAtMs !== value.eventAtMs) return { ok: false, reason: 'invalid_payload' };
    var payload = Object.freeze({
      v: 1, commandId: value.commandId, room: value.room,
      issuedAtMs: value.issuedAtMs, eventAtMs: value.eventAtMs, expiresAtMs: value.expiresAtMs,
      role: value.role, targetDeviceId: value.targetDeviceId
    });
    if (now >= payload.expiresAtMs) return { ok: false, reason: 'expired', payload: payload };
    return { ok: true, payload: payload };
  }
  root.KvkPushLab = Object.freeze({ validatePayload: validatePayload });
})(typeof self !== 'undefined' ? self : window);
```

- [ ] **Step 4: Implement IndexedDB dedupe and stale-safe Push handling**

Create `kingshoter/public/lab/push-sw.js`. It must:

1. Call `importScripts('/lab/push-shared.js')`.
2. Parse `event.data.json()` inside a try/catch.
3. Validate before any notification.
4. Use an IndexedDB `seen` object store keyed by command ID; delete expired rows on each Push, then atomically add `{commandId, deleteAtMs: expiresAtMs + 24h}` before notification display.
5. If the `add` transaction raises `ConstraintError`, POST `duplicate_suppressed` and return without notification display. Marking seen before `showNotification` intentionally favors a possible miss over a duplicate after worker termination.
6. Call `registration.showNotification()` with absolute event time, role, `renotify:false`, and no custom-sound option.
7. POST `{commandId,targetDeviceId,eventAtMs,outcome,handledAtMs:Date.now()}` to `/api/lab/delivery/push/receipt?room=<encoded>` with `credentials:'include'`, `Content-Type: application/json`, and `Cache-Control: no-store`. Invalid untrusted data that lacks a validated QA room, UUID, or target ID is dropped locally and never used to construct a network URL.
8. Keep the Push event promise alive only until `expiresAtMs` (the server lead is 10 seconds), then call `registration.getNotifications({tag})` and `notification.close()` for every matching notification. A platform that still presents it at/after expiry fails the physical stale-notification gate.

The notification call is:

```js
await self.registration.showNotification('KvK backup alert', {
  body: `${payload.role === 'main' ? 'MAIN' : 'SACRIFICE'} · launch ${new Date(payload.eventAtMs).toLocaleTimeString()}`,
  tag: `kvk-lab-${payload.commandId}`,
  renotify: false,
  requireInteraction: false,
  timestamp: payload.eventAtMs,
  icon: '/lab/icons/push-192.png',
  badge: '/lab/icons/push-192.png',
  data: { commandId: payload.commandId, room: payload.room, targetDeviceId: payload.targetDeviceId, eventAtMs: payload.eventAtMs, expiresAtMs: payload.expiresAtMs }
});
```

Immediately before this call, repeat the explicit guard:

```js
if (Date.now() >= payload.expiresAtMs) return postReceipt(payload, 'expired');
```

`notificationclick` closes the notification and opens `/lab/push.html?room=<encoded>&commandId=<encoded>`. Do not focus or open `kvk.html`.

- [ ] **Step 5: Create the lab-only manifest and icons**

Create `kingshoter/public/lab/push.webmanifest`:

```json
{
  "id": "/lab/push",
  "name": "Kingshoter Backup Push Lab",
  "short_name": "KvK Push Lab",
  "start_url": "/lab/push.html",
  "scope": "/lab/",
  "display": "standalone",
  "background_color": "#f8f8f0",
  "theme_color": "#0fa193",
  "prefer_related_applications": false,
  "icons": [
    { "src": "/lab/icons/push-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/lab/icons/push-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

Generate committed PNGs from the existing SVG without changing that SVG:

```bash
mkdir -p public/lab/icons
magick -background '#f8f8f0' public/favicon.svg -gravity center -extent 512x512 -resize 192x192 public/lab/icons/push-192.png
magick -background '#f8f8f0' public/favicon.svg -gravity center -extent 512x512 public/lab/icons/push-512.png
file public/lab/icons/push-192.png public/lab/icons/push-512.png
```

Expected: `file` reports 192x192 and 512x512 PNG images.

- [ ] **Step 6: Run PWA and complete unit tests**

Run:

```bash
node --test test/delivery-lab-pwa.test.cjs
npm test
```

Expected: PWA tests PASS; ordinary-page invisibility assertion PASS; existing tests remain PASS.

- [ ] **Step 7: Detect changes and commit the scoped PWA**

```bash
git diff --cached --quiet
git add kingshoter/public/lab/push-shared.js kingshoter/public/lab/push-sw.js kingshoter/public/lab/push.webmanifest kingshoter/public/lab/icons kingshoter/test/delivery-lab-pwa.test.cjs
```

Stop on pre-existing staged work. Otherwise run `gitnexus_detect_changes(scope="staged", repo="kingshot")`; expect new public lab files only, with no Classic browser symbol changes. Then run:

```bash
git commit -m "feat: add stale-safe backup push service worker"
npx gitnexus analyze
```

---

### Task 6: Add the hidden opt-in UI and local integration harness

**Files:**
- Create: `kingshoter/public/lab/push.html`
- Create: `kingshoter/public/lab/push.css`
- Create: `kingshoter/public/lab/push.js`
- Create: `kingshoter/test/delivery-lab-push.e2e.cjs`
- Modify: `kingshoter/package.json`

**Interfaces:**
- Consumes: shared `assertQaRoomName/makeQaRoom/qaRoomUrl/installQaWebSocketGuard` test helper, session API, VAPID public key, scoped service worker, PushManager, lab WebSocket, arm/status/observation APIs.
- Produces: explicit buttons `#joinLab`, `#enablePush`, `#disablePush`, `#arm5`, `#arm15`, `#arm60`, `#arm180`, `#observedYes`, `#observedNo`, and `#exportEvidence`.
- Guarantees: no valid room means no API/WebSocket/SW activity; denied permission stays neutral and does not re-prompt automatically.

- [ ] **Step 1: Write the failing Playwright harness with a pre-navigation QA assertion**

Create `kingshoter/test/delivery-lab-push.e2e.cjs`. Before launching a browser or calling `page.goto`, it must execute:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const {
  assertQaRoomName,
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-kvk.cjs');

const base = process.argv[2] || 'http://127.0.0.1:8788';
const room = assertQaRoomName(process.env.QA_ROOM || makeQaRoom({
  title: 'backup-push-lab', project: { name: 'chromium' }, workerIndex: 0, retry: 0
}));
const classicUrl = qaRoomUrl(base, room);
const url = new URL('/lab/push.html', base);
url.searchParams.set('room', room);
const qaPassword = crypto.randomBytes(24).toString('base64url');
```

Call `await installQaWebSocketGuard(context, room)` immediately after each context is created and before its first page or socket is opened. This harness uses the helper's fault-free default; ACK suppression is exercised by the real lab socket and no browser fault hook is installed.

Continue the same file with deterministic capability stubs and isolated contexts:

```js
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { if (browser) await browser.close(); });

async function newGuardedContext(permission = 'granted') {
  const context = await browser.newContext();
  await installQaWebSocketGuard(context, room);
  await context.addInitScript((initialPermission) => {
    let permission = initialPermission;
    window.__notificationPermissionCalls = 0;
    class FakeNotification {
      static get permission() { return permission; }
      static async requestPermission() { window.__notificationPermissionCalls++; return permission; }
    }
    const subscription = {
      toJSON() {
        return {
          endpoint: 'https://push.example.test/device', expirationTime: null,
          keys: { p256dh: 'test-client-public-key', auth: 'test-client-auth' }
        };
      },
      async unsubscribe() { return true; }
    };
    const registration = {
      get scope() { return `${location.origin}/lab/`; },
      pushManager: {
        async getSubscription() { return subscription; },
        async subscribe() { return subscription; }
      }
    };
    Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        async register(script, options) {
          if (script !== '/lab/push-sw.js' || options.scope !== '/lab/') throw new Error('wrong_service_worker_scope');
          return registration;
        },
        async getRegistration(scope) { return scope === '/lab/' ? registration : undefined; }
      }
    });
  }, permission);
  return context;
}

async function join(context, role, variant) {
  const requests = [];
  context.on('request', (request) => {
    const parsed = new URL(request.url());
    if (parsed.pathname.startsWith('/api/lab/') || parsed.pathname === '/api/ws') requests.push(`${request.method()} ${parsed.pathname}`);
  });
  const page = await context.newPage();
  await page.goto(url.toString());
  await page.locator('#password').fill(qaPassword);
  await page.locator('#role').selectOption(role);
  await page.locator('#variant').selectOption(variant);
  await page.locator('#joinLab').click();
  await page.locator('#pushPanel').waitFor({ state: 'visible' });
  const deviceId = await page.evaluate(() => localStorage.getItem('kingshoter_push_lab_device'));
  return { context, page, requests, deviceId };
}

async function api(page, pathname, options = {}) {
  return page.evaluate(async ({ pathname, room, options }) => {
    const response = await fetch(`${pathname}?room=${encodeURIComponent(room)}`, {
      credentials: 'include',
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return { status: response.status, body: await response.json() };
  }, { pathname, room, options });
}

test('invalid rooms stay inert and ordinary Classic has no lab entry', async () => {
  for (const invalidRoom of ['operation-room', 'prod']) {
    const context = await browser.newContext();
    const requests = [];
    context.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/lab/') || pathname === '/api/ws') requests.push(pathname);
    });
    const page = await context.newPage();
    await page.goto(`${base}/lab/push.html?room=${invalidRoom}`);
    await page.waitForTimeout(200);
    assert.deepEqual(requests, []);
    await context.close();
  }
  const context = await newGuardedContext();
  const page = await context.newPage();
  await page.goto(classicUrl);
  assert.equal(await page.locator('#enablePush, #joinLab, a[href*="push.html"]').count(), 0);
  await context.close();
});

test('five isolated profiles exercise denial, scoped opt-in, server delay, and role targeting', async () => {
  const commander = await join(await newGuardedContext(), 'commander', 'immediate');
  const mainDenied = await join(await newGuardedContext('denied'), 'main', 'immediate');
  const weak = await join(await newGuardedContext(), 'weak', 'no_ack');
  const member = await join(await newGuardedContext(), 'member', 'immediate');
  const mainTwo = await join(await newGuardedContext(), 'main', 'immediate');
  const clients = [commander, mainDenied, weak, member, mainTwo];
  assert.equal(new Set(clients.map((client) => client.deviceId)).size, 5);

  await mainDenied.page.locator('#enablePush').click();
  await mainDenied.page.waitForFunction(() => /Classic continues|Notifications remain off/.test(document.querySelector('#pushStatus').textContent));
  await mainDenied.page.locator('#enablePush').click();
  assert.equal(await mainDenied.page.evaluate(() => window.__notificationPermissionCalls), 0);
  assert.equal(mainDenied.requests.filter((entry) => entry === 'POST /api/lab/delivery/push/subscription').length, 0);
  const classicAfterDenial = await mainDenied.context.newPage();
  await classicAfterDenial.goto(classicUrl);
  assert.equal(await classicAfterDenial.locator('#soundGate').isDisabled(), false);
  await classicAfterDenial.close();

  for (const client of [commander, weak, member]) {
    await client.page.locator('#enablePush').click();
    await client.page.locator('#pushStatus').filter({ hasText: 'Test notifications on' }).waitFor();
  }
  assert.equal(await weak.page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/lab/')).scope), `${new URL(base).origin}/lab/`);
  assert.deepEqual(await commander.page.locator('#armControls button').allTextContents(), ['5 min', '15 min', '60 min', '180 min']);

  const beforeWeak = await api(weak.page, '/api/lab/delivery/status');
  assert.equal(beforeWeak.body.device.lastCommandId || null, null);
  const armed = await api(commander.page, '/api/lab/delivery/push/arm', {
    method: 'POST',
    body: { delaySeconds: 5, targetDeviceIds: [weak.deviceId, commander.deviceId, member.deviceId] }
  });
  assert.equal(armed.status, 200);
  assert.ok(armed.body.dueAtMs >= Date.now() + 4_000);
  assert.equal((await api(weak.page, '/api/lab/delivery/status')).body.device.lastCommandId || null, null);

  await weak.page.waitForFunction(async (roomName) => {
    const response = await fetch(`/api/lab/delivery/status?room=${encodeURIComponent(roomName)}`, { credentials: 'include' });
    const data = await response.json();
    return /^[0-9a-f-]{36}$/i.test(data.device && data.device.lastCommandId || '');
  }, room, { timeout: 10_000 });
  assert.equal((await api(commander.page, '/api/lab/delivery/status')).body.device.lastCommandId || null, null);
  assert.equal((await api(member.page, '/api/lab/delivery/status')).body.device.lastCommandId || null, null);
  await weak.page.waitForTimeout(2_000);
  const evidence = await api(commander.page, '/api/lab/delivery/evidence');
  assert.equal(evidence.status, 200);
  assert.ok(evidence.body.events.some((event) => event.deviceId === weak.deviceId && event.outcome === 'ack_suppressed'));
  assert.doesNotMatch(JSON.stringify(evidence.body), /endpoint|p256dh|passwordHash|ks_delivery_lab/);

  for (const client of clients) await client.context.close();
});
```

The successful path deliberately targets only the live `no_ack` weak device plus excluded commander/member devices. Its exact lab ACK suppresses the fallback before any fake Push endpoint is contacted; provider behavior remains covered by Task 3's injected unit tests.

- [ ] **Step 2: Run the harness and verify RED**

Start local Wrangler with a local `.dev.vars` containing generated development-only VAPID keys and:

```dotenv
DELIVERY_LAB_ENABLED=1
DELIVERY_LAB_PUSH_ENABLED=1
DELIVERY_LAB_ALLOW_SHORT_DELAYS=1
```

Run:

```bash
npm run dev -- --port 8788
node test/delivery-lab-push.e2e.cjs http://127.0.0.1:8788
```

Expected: FAIL because `/lab/push.html` does not exist. Stop Wrangler before continuing.

- [ ] **Step 3: Create the inert, no-index page shell**

Create `kingshoter/public/lab/push.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="referrer" content="no-referrer">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#0fa193">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; manifest-src 'self'; style-src 'self'; script-src 'self'; worker-src 'self'">
  <link rel="manifest" href="/lab/push.webmanifest">
  <link rel="apple-touch-icon" href="/lab/icons/push-192.png">
  <link rel="stylesheet" href="/lab/push.css">
  <title>KvK Backup Push Lab</title>
</head>
<body>
  <main>
    <h1>Backup Push Lab</h1>
    <p class="warning">QA only. Use a newly generated qa-kvk-* room.</p>
    <section id="joinPanel">
      <label>QA room <input id="room" autocomplete="off"></label>
      <label>QA password <input id="password" type="password" autocomplete="off"></label>
      <label>Role <select id="role"><option value="commander">Commander</option><option value="main">Main</option><option value="weak">Sacrifice</option><option value="member">Member</option></select></label>
      <label>Variant <select id="variant"><option value="immediate">A · immediate</option><option value="no_ack">B · no-ACK delay</option></select></label>
      <button id="joinLab">Join private lab</button>
    </section>
    <section id="pushPanel" hidden>
      <p id="platformHelp"></p><p id="pushStatus" aria-live="polite"></p>
      <button id="enablePush">Enable test notifications</button><button id="disablePush">Disable test notifications</button>
      <section id="commanderControls" hidden>
        <fieldset id="deviceTargets"><legend>Eligible QA devices</legend></fieldset>
        <div id="armControls"><button id="arm5">5 min</button><button id="arm15">15 min</button><button id="arm60">60 min</button><button id="arm180">180 min</button></div>
        <button id="exportEvidence">Export private evidence JSON</button>
      </section>
      <p id="activeCommand">No candidate command yet.</p>
      <label>Visibility <select id="visibility"><option value="foreground">Foreground</option><option value="game">Kingshot foreground</option><option value="locked">Locked</option><option value="background">Background</option></select></label>
      <label>Interruption <input id="interruption" maxlength="40" value="none"></label>
      <button id="observedYes" disabled>I observed it</button><button id="observedNo" disabled>I did not observe it</button>
      <pre id="diagnostics"></pre>
    </section>
  </main>
  <script src="/lab/push-shared.js"></script><script src="/lab/push.js"></script>
</body>
</html>
```

The page is not added to any navigation or sitemap.

- [ ] **Step 4: Implement inert bootstrap and explicit opt-in**

Create `kingshoter/public/lab/push.js` so its first executable decisions are:

```js
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var initialRoom = params.get('room') || '';
  var validRoom = /^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/.test(initialRoom);
  document.getElementById('room').value = validRoom ? initialRoom : '';
  var deviceId = localStorage.getItem('kingshoter_push_lab_device');
  if (!deviceId) { deviceId = 'd-' + crypto.randomUUID(); localStorage.setItem('kingshoter_push_lab_device', deviceId); }
  var sessionReady = false;
  var activeRoom = '';
  var socket = null;
  var vapidPublicKey = '';
  var activeCommandId = /^[0-9a-f-]{36}$/i.test(params.get('commandId') || '') ? params.get('commandId') : '';
  var currentRole = '';

  async function joinLab() {
    var room = document.getElementById('room').value;
    if (!/^qa-kvk-[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/.test(room)) throw new Error('Use a unique qa-kvk-* room');
    var response = await fetch('/api/lab/delivery/session?room=' + encodeURIComponent(room), {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value, deviceId: deviceId, platform: platformLabel(), role: document.getElementById('role').value, pushVariant: document.getElementById('variant').value })
    });
    var data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'session_failed');
    document.getElementById('password').value = '';
    activeRoom = room; sessionReady = true;
    vapidPublicKey = data.vapidPublicKey || '';
    currentRole = document.getElementById('role').value;
    document.getElementById('pushPanel').hidden = !data.pushEnabled;
    if (data.pushEnabled) { await refreshStatus(); connectLabSocket(); }
  }
```

`platformLabel()` returns only `ios-home`, `android-chrome`, `mac-safari`, `desktop-chrome`, `desktop-edge`, `desktop-firefox`, or `other`; never retain the full user agent. On iOS outside standalone display mode, `enablePush()` writes the Home Screen requirement and returns before `Notification.requestPermission()`. Otherwise it runs only from the explicit button click, checks existing `Notification.permission` before requesting, registers `/lab/push-sw.js` with `{scope:'/lab/'}`, converts the VAPID public key to `Uint8Array`, subscribes with `{userVisibleOnly:true,applicationServerKey}`, and POSTs `subscription.toJSON()` privately. If permission is already `denied`, capability is absent, or a call fails, render `Notifications remain off. Classic continues normally.` and return without automatic retry or another permission call.

`disablePush()` attempts the private server DELETE first, then always runs browser `subscription.unsubscribe()` and `registration.unregister()` in a `finally` block so emergency server disablement cannot prevent local cleanup; the page remains otherwise usable.

`connectLabSocket()` opens `/api/lab/delivery/ws?room=...`, handles only `pushLabCommand`, validates it with `KvkPushLab.validatePayload`, requires `message.targetDeviceId === deviceId`, and deduplicates by command ID. For a valid future command it schedules only a silent lab-page marker for `eventAtMs`, then sends `{t:'pushLabAck',commandId,deviceId,outcome:'scheduled',eventAtMs,handledAtMs:Date.now()}`. This marker is created only after the server command arrives; arm never pre-schedules it. If the shared validator returns `expired` with a safe payload, send the same envelope with `outcome:'expired'`; invalid/misdirected data gets no ACK. Set `activeCommandId`, enable the observation buttons, and show absolute times, but never create a notification from the page, schedule/play Classic audio, or send core `deliveryAck`.

`refreshStatus()` GETs `/status`, updates the current device/active command, and for commander sessions renders only subscribed `main|weak` devices as checked inputs inside `#deviceTargets`; commander/member rows may be shown as ineligible text but never as checked targets. Arm buttons POST `{delayMinutes:5|15|60|180,targetDeviceIds:[...checked values]}`. Only a commander session unhides `#commanderControls`; player sessions display their own neutral registration status and cannot arm.

Human observation buttons POST `{commandId:activeCommandId,observed:true|false,atMs:Date.now(),visibility:<selected>,interruption:<clamped input>}`. `#exportEvidence` fetches commander-only `/evidence`, creates a local JSON Blob download named `kvk-push-evidence-<qa-room>.json`, immediately revokes the object URL, and never writes it to a public asset or room snapshot. Every handler checks `sessionReady && activeRoom` before network access.

- [ ] **Step 5: Add restrained lab-only styling**

Create `kingshoter/public/lab/push.css` with a single-column, 44px-minimum-control layout, visible QA warning, neutral disabled/denied copy, and no imports from `app.css`. Do not modify Classic CSS.

- [ ] **Step 6: Add focused npm scripts**

Modify `kingshoter/package.json` scripts:

```json
"test:push-lab": "node --test test/delivery-lab-*.test.cjs",
"test:push-lab:e2e": "node test/delivery-lab-push.e2e.cjs"
```

Keep the existing `test`, `deploy`, and `dev` commands unchanged.

- [ ] **Step 7: Run local integration and Classic regressions**

With local Wrangler running on 8788:

```bash
npm run test:push-lab
npm run test:push-lab:e2e -- http://127.0.0.1:8788
node test/lead-timing.cjs http://127.0.0.1:8788 10
node test/mineaudio.cjs http://127.0.0.1:8788
node test/multikingdom.cjs http://127.0.0.1:8788
node test/alert-truth.cjs http://127.0.0.1:8788
```

Expected: all lab tests PASS; lead timing begins at exactly 10; selected captain and ordinary-member Classic assertions remain PASS; no page errors.

- [ ] **Step 8: Detect changes and commit the hidden UI**

```bash
git diff --cached --quiet
git add kingshoter/public/lab/push.html kingshoter/public/lab/push.css kingshoter/public/lab/push.js kingshoter/test/delivery-lab-push.e2e.cjs kingshoter/package.json
```

Stop on pre-existing staged work. Otherwise run `gitnexus_detect_changes(scope="staged", repo="kingshot")` and verify there is no Classic browser symbol change and no new execution flow begins from `kvk.html`. Then run:

```bash
git commit -m "test: add hidden backup push lab harness"
```

---

### Task 7: Write and execute the physical-device evidence protocol

**Files:**
- Create: `docs/labs/kvk-backup-push-lab.md`
- Modify: `kingshoter/test/delivery-lab-pwa.test.cjs`

**Interfaces:**
- Produces: one timestamped evidence row per device/command/condition, separate diagnostic and human-observed fields, pre-registered promotion/delete thresholds, and exact kill/delete runbook.
- Consumes: only unique `qa-kvk-*` rooms and random QA-only passwords.

- [ ] **Step 1: Impact-check the existing PWA test file before extending it**

Run:

```text
gitnexus_impact({
  target: "kingshoter/test/delivery-lab-pwa.test.cjs",
  direction: "upstream",
  includeTests: true,
  repo: "kingshot"
})
```

Expected: LOW and no production process. Report direct dependents/processes; warn before proceeding on HIGH or CRITICAL.

- [ ] **Step 2: Add a failing documentation-presence test**

Extend `delivery-lab-pwa.test.cjs` to read `../docs/labs/kvk-backup-push-lab.md` and require all of these literal headings:

```text
## Safety Gate
## VAPID Setup
## Device Matrix
## Classic Baseline
## Immediate Versus No-ACK
## Physical Observation Record
## Stop and Delete Rules
## Kill Procedure
## Source Deletion Procedure
```

Also require literal durations `5`, `15`, `60`, and `180 minutes`, prefix `qa-kvk-`, the phrase `every non-QA room is an operation room`, and statement `Service-worker handling is diagnostic, not human observation.`

Add this concrete test:

```js
test('physical runbook contains every safety and decision gate', () => {
  const document = read('../docs/labs/kvk-backup-push-lab.md');
  for (const heading of [
    '## Safety Gate', '## VAPID Setup', '## Device Matrix', '## Classic Baseline',
    '## Immediate Versus No-ACK', '## Physical Observation Record',
    '## Stop and Delete Rules', '## Kill Procedure', '## Source Deletion Procedure'
  ]) assert.match(document, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  for (const literal of ['5 minutes', '15 minutes', '60 minutes', '180 minutes', 'qa-kvk-', 'every non-QA room is an operation room']) assert.match(document, new RegExp(literal));
  assert.match(document, /Service-worker handling is diagnostic, not human observation\./);
  assert.match(document, /at least 40 valid candidate commands per platform scope/);
  assert.match(document, /zero stale notifications and zero duplicate notifications/);
});
```

- [ ] **Step 3: Run documentation test and verify RED**

Run:

```bash
node --test test/delivery-lab-pwa.test.cjs
```

Expected: FAIL with `ENOENT` for `docs/labs/kvk-backup-push-lab.md`.

- [ ] **Step 4: Write the exact physical runbook**

Create `docs/labs/kvk-backup-push-lab.md` with:

- Safety Gate: generate `ROOM="qa-kvk-$(date -u +%Y%m%d)-$(openssl rand -hex 4)"`; call `assertQaRoomName(ROOM)` before opening a URL, browser context, HTTP mutation, or socket; state that every non-QA room is an operation room and abort for any non-prefix room without naming a special case. Generate a random QA-only password with `openssl rand -base64 24`, never reuse an operation-room credential, and use a fresh room for each proposed platform scope so the 256-event cap cannot silently mix scopes.
- VAPID Setup: interactive `wrangler secret put` commands, no values in the document.
- Device Matrix: iOS Home Screen web app, Android Chrome, macOS Safari/Chrome, Windows Edge/Chrome; foreground, Kingshot foreground, lock screen, low-power mode, Wi-Fi/cellular transition, phone/notification interruption, Bluetooth-route change, browser restart, and whole-device sleep recorded as unsupported.
- Durations: 5, 15, 60, and 180 minutes, plus local 5-second wiring only.
- Classic Baseline: for each condition/duration block, first run a separate command on `classicUrl = qaRoomUrl(baseURL, room)`; copy its core aggregate into `POST /classic-baseline` as exactly `{commandId,targetUTC,classicAckAtMs,classicOutcome}`; record physical Classic audio observation separately. Do not reuse that command ID for the candidate and do not have DeliveryLab send a Classic command.
- A/B protocol: balance immediate and no-ACK devices; never assign both variants to one command/device; use at least 40 valid candidate commands per platform scope, exactly five repetitions for each of the 4 durations × 2 variants before adding exploratory trials. Pair each candidate trial with the same device, visibility, network, power, and interruption condition used for its preceding Classic baseline.
- Evidence columns: room, randomized device ID, coarse platform, OS/browser version, Classic command ID/target/ACK outcome/ACK time/human observation, candidate command ID, variant, arm/due/issued/event/expiry times, live-channel ACK outcome/time, provider outcome/time, SW handled/expired/duplicate time, human observed yes/no/time, visibility, interruption, setup actions, battery delta, data delta, and notes.
- Truth statement: `Service-worker handling is diagnostic, not human observation.`
- Stop rules below.

- [ ] **Step 5: Encode strict stop and delete thresholds**

The runbook must stop a platform scope immediately for any:

- notification newly displayed at or after `expiresAtMs`;
- duplicate notification for one command/device;
- commander/member target receiving a rally Push;
- request reaching DeliveryLab for any non-`qa-kvk-*` room;
- subscription/VAPID/session disclosure;
- denied user being prompted again;
- disabled flag allowing subscription or send;
- Classic test regression.

After at least 40 valid candidate commands in a proposed platform scope, delete that scope when human-observed on-time success is less than 10 percentage points better than its paired Classic trials, any one of the 5/15/60/180-minute duration groups is worse than Classic, setup abandonment exceeds 20% across at least 10 opt-in attempts, candidate battery loss is more than 5 percentage points above the paired three-hour Classic run, candidate data use exceeds Classic by more than 5 MB per three-hour run, or either A/B variant adds interruption without a clear observation benefit. The runbook must say `zero stale notifications and zero duplicate notifications`; these are zero-tolerance counts, not percentages.

- [ ] **Step 6: Encode immediate kill and complete source deletion**

Kill without code deployment:

```bash
printf '0' | npx wrangler secret put DELIVERY_LAB_PUSH_ENABLED
printf '0' | npx wrangler secret put DELIVERY_LAB_ENABLED
```

Verify `/api/lab/delivery/status?room=<valid qa room>` returns 404 and the hidden page performs no subscription or arm mutation.

Before source deletion, every reachable enrolled device uses `Disable test notifications`; `disablePush()` must attempt server deletion and always run local `subscription.unsubscribe()` plus `registration.unregister()` in a `finally` block. After an emergency kill, testers clear notification permission/site data manually because the server route is intentionally unavailable.

If the candidate fails, delete its complete source in one reviewed cleanup change. Use `apply_patch` file deletions for all text/source/config/test/runbook files and a reviewed binary deletion patch for both generated icons; do not use recursive shell deletion. The deletion set is exactly:

```text
kingshoter/public/lab/push.html
kingshoter/public/lab/push.css
kingshoter/public/lab/push.js
kingshoter/public/lab/push-shared.js
kingshoter/public/lab/push-sw.js
kingshoter/public/lab/push.webmanifest
kingshoter/public/lab/icons/push-192.png
kingshoter/public/lab/icons/push-512.png
kingshoter/src/lab/qa-room.mjs
kingshoter/src/lab/router.mjs
kingshoter/src/lab/push-policy.mjs
kingshoter/src/lab/push.mjs
kingshoter/src/lab/push-ab.mjs
kingshoter/src/lab/delivery-lab.mjs
kingshoter/test/support/delivery-lab-fakes.cjs
kingshoter/test/delivery-lab-guard.test.cjs
kingshoter/test/delivery-lab-storage.test.cjs
kingshoter/test/delivery-lab-push.test.cjs
kingshoter/test/delivery-lab-ab.test.cjs
kingshoter/test/delivery-lab-pwa.test.cjs
kingshoter/test/delivery-lab-push.e2e.cjs
kingshoter/.dev.vars.example
docs/labs/kvk-backup-push-lab.md
```

Run `cd kingshoter && npm uninstall web-push`, remove only the two `test:push-lab*` scripts, and retain the core-owned `kingshoter/test/support/qa-kvk.cjs`.

Then remove the Worker lab import/export/branch, remove `DELIVERY_LAB` binding, remove `nodejs_compat` if no remaining dependency requires it, retain `v1`, and add:

```toml
[[migrations]]
tag = "deliverylab-delete-20260713"
deleted_classes = ["DeliveryLab"]
```

Before removing the existing Worker branch or `DeliveryLab` class, run upstream `gitnexus_impact` for `worker.fetch` and `DeliveryLab`, report blast radius, and warn on HIGH/CRITICAL exactly as in implementation.

Run `npm test`, `npx wrangler deploy --dry-run`, `gitnexus_detect_changes(scope="all")`, deploy the deletion, and confirm ordinary Classic behavior is unchanged.

After the deletion deploy succeeds, remove the candidate-only secrets interactively:

```bash
npx wrangler secret delete VAPID_PUBLIC_KEY
npx wrangler secret delete VAPID_PRIVATE_KEY
npx wrangler secret delete VAPID_SUBJECT
npx wrangler secret delete DELIVERY_LAB_PUSH_ENABLED
npx wrangler secret delete DELIVERY_LAB_ENABLED
```

Stage only the reviewed deletion, run `gitnexus_detect_changes(scope="staged", repo="kingshot")`, then commit it as `chore: remove failed backup push lab` before deployment. The user has already approved the scoped secret deletion and production deployment in this program; do not ask again.

- [ ] **Step 7: Run the documentation test and commit the protocol**

Run:

```bash
node --test test/delivery-lab-pwa.test.cjs
```

Expected: PASS with all safety, evidence, and deletion headings present.

```bash
git diff --cached --quiet
git add docs/labs/kvk-backup-push-lab.md kingshoter/test/delivery-lab-pwa.test.cjs
```

Stop on pre-existing staged work. Otherwise run `gitnexus_detect_changes(scope="staged", repo="kingshot")`; expect documentation/test-only scope. Then run:

```bash
git commit -m "docs: add backup push physical test protocol"
```

---

### Task 8: Final verification, disabled-first deployment, and evidence gate

**Files:**
- Modify: none unless verification exposes a focused defect; any defect starts a new RED/GREEN cycle in its owning task.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: a deployable lab that is off by default and a verified rollback/deletion path; it does not produce a reliability claim.

- [ ] **Step 1: Run the complete automated suite**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm test
npm run test:push-lab
npx wrangler deploy --dry-run
```

Expected: every Node test PASS; Wrangler bundles both DO classes and all static lab assets without uploading.

- [ ] **Step 2: Run focused local browser regressions**

Run Wrangler locally with lab flags enabled, then:

```bash
npm run test:push-lab:e2e -- http://127.0.0.1:8788
node test/lead-timing.cjs http://127.0.0.1:8788 10
node test/mineaudio.cjs http://127.0.0.1:8788
node test/multikingdom.cjs http://127.0.0.1:8788
node test/alert-truth.cjs http://127.0.0.1:8788
```

Expected: all PASS. Headless results prove only routing, state, expiry, dedupe, and regression behavior.

- [ ] **Step 3: Review GitNexus change scope before deployment**

Run:

```text
gitnexus_detect_changes({scope:"all", repo:"kingshot"})
```

Expected: new DeliveryLab/lab-public flows and the single Worker route entry only. Any changed `Room`, `fireDouble`, `onState`, `scheduleAllCues`, `enableSound`, or Classic public-file symbol blocks deployment.

- [ ] **Step 4: Inspect staged scope and secret hygiene**

Run:

```bash
git status --short
git diff --check
git diff --cached --name-only
git grep -n 'VAPID_PRIVATE_KEY=' -- ':!kingshoter/.dev.vars.example'
```

Expected: no whitespace errors; only intended lab files/config/package changes staged; no private key value tracked.

- [ ] **Step 5: Deploy with both lab switches disabled**

Use the user's standing approval for the scoped disabled-first secret changes and deployment; do not ask again. Stop only if credentials, physical access, or an external platform error actually blocks execution.

Set both production switches to `0`, deploy, and run ordinary Classic smoke tests first:

```bash
printf '0' | npx wrangler secret put DELIVERY_LAB_ENABLED
printf '0' | npx wrangler secret put DELIVERY_LAB_PUSH_ENABLED
npx wrangler deploy
```

Expected: ordinary pages and `/api/ws` work; `/api/lab/delivery/*` returns 404; no user sees Backup UI.

- [ ] **Step 6: Enable only for a fresh QA room and run the physical protocol**

After Classic production smoke is green:

```bash
printf '1' | npx wrangler secret put DELIVERY_LAB_ENABLED
printf '1' | npx wrangler secret put DELIVERY_LAB_PUSH_ENABLED
```

Create a new `qa-kvk-*` room and random password, execute the physical runbook, and record every row. Do not use any operation room or reuse production credentials.

- [ ] **Step 7: Apply the evidence gate**

- If physical evidence satisfies every zero-tolerance rule and the pre-registered improvement threshold, keep the code hidden and open a separate promotion specification; do not expose it from this plan.
- If evidence is absent, mixed, below threshold, stale, duplicate, privacy-unsafe, or operationally costly, execute the kill and source-deletion procedure from Task 7.
- In both cases Classic remains default and no reliability claim is added to user-facing copy.

---

## Execution Order and Parallelization

1. Task 1 and Task 2 are sequential because all later work depends on the QA boundary and private DO substrate.
2. Task 3 may begin after Task 2 commits.
3. Task 5's static manifest/shared-validator work may proceed in parallel with Task 4 after payload fields are frozen, but `push-sw.js` review waits for Task 3's exact payload tests.
4. Task 6 begins after Tasks 3–5 pass independently.
5. Tasks 7–8 are sequential evidence gates and cannot be replaced by automation.

Every task ends with its own RED/GREEN test cycle, GitNexus change detection, and focused commit so the entire candidate can be reviewed, reverted, or deleted without mixing unrelated Classic changes.
