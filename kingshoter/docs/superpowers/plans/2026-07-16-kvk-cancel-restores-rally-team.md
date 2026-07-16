# KvK Cancel Restores Rally Team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and synchronize a Double or Triple rally lineup after Cancel, while retaining one cancellation cue and preventing an immediate duplicate standby alert.

**Architecture:** Keep Fire’s existing single-use staging behavior. Add one server-side projection that converts the cancelled command’s frozen pairs back into valid current staging, and make Cancel idempotent. Add one pure client transition helper that carries a captain’s `kingdom:role` assignment key across Stage → Fire → Cancel so restored staging is silent on devices that already knew the assignment.

**Tech Stack:** Cloudflare Workers Durable Objects, browser JavaScript, WebSockets, Node test runner, Playwright, GitNexus, Wrangler.

## Global Constraints

- Fire must continue clearing canonical staging while a rally is live.
- Cancel restoration must be server-authoritative and visible to every commander and reconnecting client.
- Restored staging contains only `{ pid, role }`; next Fire reads current canonical march times.
- Duplicate or late Cancel with no active command is a no-op and must preserve existing staging.
- Cancel never changes the other kingdom’s staging, command, or mode.
- Refill and Ping cancellation must not synthesize a rally lineup.
- Captains hear the existing Cancel cue but no immediate second standby alert for the restored assignment.
- Do not add a new protocol message or persisted room schema field.
- Run online mutation only in a newly generated lowercase `qa-kvk-*` room on the isolated `kingshoter-qa` Worker.
- Do not deploy this candidate to the production `kingshoter` Worker or `kingshoter.com`.
- Advance the coherent KvK build generation from `2026071505` to `2026071506` before reusing the QA origin.

---

### Task 1: Restore canonical rally staging on Cancel

**Files:**
- Create: `test/cancel-rally-selection.test.cjs`
- Modify: `src/room.js`

**Interfaces:**
- Consumes: `normalizeRoutingKey`, `activeCommandPids`, `validateStagedPairs`, `room.players`, `room.rallyModes`, and the cancelled command’s immutable `payload.pairs`.
- Produces: `cancelledRallyStage(room, kingdom, command, nowSec) -> undefined | null | { kingdom, pairs }`; `undefined` means non-rally, `null` means a rally with no currently valid pair, and an object is canonical restored staging.

- [ ] **Step 1: Write failing server lifecycle tests**

Create `test/cancel-rally-selection.test.cjs` with Room-harness helpers and these exact lifecycle assertions:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadRoom, createRoomHarness, claimRoom } = require('./room-harness.cjs');

async function send(h, message) {
  await h.room.webSocketMessage(h.ws, JSON.stringify(message));
}

async function register(h, pid, march = 30) {
  await send(h, {
    t: 'registerPlayer', registrationId: `register-${pid}`,
    pid, playerId: pid, identityMode: 'playerId', name: `Captain ${pid}`,
    march, profileKey: crypto.randomUUID()
  });
}

function command(type, kingdom, pairs, modeRevision) {
  return {
    t: 'cmd', password: 'commander-secret', cmd: {
      type, kingdom, modeRevision, anchorUTC: 1010,
      payload: { kingdom, leadSeconds: 10, firstPress: 1010, pairs }
    }
  };
}

function cancel(kingdom) {
  return { t: 'cmd', password: 'commander-secret', cmd: { type: 'cancel', kingdom } };
}

function stagePairs(h, kingdom) {
  return h.room.room.live.staged[kingdom] && h.room.room.live.staged[kingdom].pairs;
}
```

Add tests that prove:

```js
assert.deepEqual(stagePairs(h, 1), [
  { pid: '930000001', role: 'weak' },
  { pid: '930000002', role: 'main' }
]);
assert.equal(h.room.room.live.commands[1], null);
```

after Double Fire → Cancel; equivalent three-pair restoration after Triple Fire → Cancel; Triple→Double drops only `weak2`; Double→Triple restores two and leaves Fire incomplete; a second Cancel leaves the first restored array byte-for-byte unchanged; Cancel in kingdom 1 preserves kingdom 2 staging; non-rally/empty Cancel does not create or clear staging; missing players and cross-kingdom conflicts preserve only valid non-conflicting pairs.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/cancel-rally-selection.test.cjs`

Expected: Double and Triple restoration assertions fail because `live.staged[kingdom]` is `null`; the duplicate-Cancel assertion also demonstrates the current destructive stale Cancel.

- [ ] **Step 3: Add the minimal current-truth projection**

Add this top-level helper beside `crossKingdomLiveCaptain` in `src/room.js`:

```js
function cancelledRallyStage(room, kingdom, command, nowSec) {
  if (!command || !['double_rally', 'triple_rally'].includes(command.type)) return undefined;
  const modeRecord = room.rallyModes[kingdom];
  const allowedRoles = new Set(modeRecord.mode === 'triple'
    ? ['weak', 'weak2', 'main'] : ['weak', 'main']);
  const otherKingdom = kingdom === 1 ? 2 : 1;
  const otherStaged = new Set((((room.live.staged[otherKingdom] || {}).pairs) || [])
    .map(pair => normalizeRoutingKey(pair && pair.pid)).filter(Boolean));
  const otherLive = activeCommandPids({
    commands: { [otherKingdom]: room.live.commands[otherKingdom] }
  }, nowSec);
  const seenPids = new Set();
  const seenRoles = new Set();
  const pairs = [];

  for (const sourcePair of ((command.payload && command.payload.pairs) || [])) {
    const pid = normalizeRoutingKey(sourcePair && sourcePair.pid);
    const role = sourcePair && sourcePair.role;
    if (!pid || !allowedRoles.has(role) || seenPids.has(pid) || seenRoles.has(role)) continue;
    if (!Object.prototype.hasOwnProperty.call(room.players, pid)) continue;
    if (otherStaged.has(pid) || otherLive.has(pid)) continue;
    seenPids.add(pid);
    seenRoles.add(role);
    pairs.push({ pid, role });
  }

  const validated = validateStagedPairs({
    modeRecord, modeRevision: modeRecord.revision, pairs, players: room.players
  });
  return validated.ok && validated.pairs.length
    ? { kingdom, pairs: validated.pairs }
    : null;
}
```

- [ ] **Step 4: Make Cancel atomic and idempotent**

In `Room.webSocketMessage`, replace the existing Cancel branch with the following complete branch:

```js
if (type === 'cancel') {
  const cancelledCommand = this.room.live.commands[kd];
  if (!cancelledCommand) return;
  cancelledCommandId = typeof cancelledCommand.id === 'string' ? cancelledCommand.id : '';
  const restoredStage = cancelledRallyStage(
    this.room, kd, cancelledCommand, Math.floor(this.nowMs() / 1000)
  );
  this.room.live.commands[kd] = null;
  if (restoredStage !== undefined) this.room.live.staged[kd] = restoredStage;
} else {
  let payload = (c.payload && typeof c.payload === 'object') ? c.payload : {};
  if (type === 'double_rally') {
    const frozen = freezeDoubleRally(
      this.room.players, payload.pairs,
      payload.firstPress != null ? payload.firstPress : c.anchorUTC
    );
    if (!frozen.ok) return ws.send(JSON.stringify({ t: 'error', error: frozen.error }));
    const liveConflict = crossKingdomLiveCaptain(
      this.room.live, kd, frozen.pairs, Math.floor(this.nowMs() / 1000)
    );
    if (liveConflict) {
      return ws.send(JSON.stringify({ t: 'error', error: 'rally_live', ...liveConflict }));
    }
    payload = Object.assign({}, payload, {
      pairs: frozen.pairs,
      firstPress: Math.min(...frozen.pairs.map(pair => pair.pressUTC))
    });
  }
  const anchorUTC = clampInt(c.anchorUTC, 0, 4102444800);
  const GATHER = 300;
  let expiresUTC = anchorUTC + 30;
  if (type === 'ping') expiresUTC = anchorUTC + 6;
  else if (type === 'double_rally' && Array.isArray(payload.pairs) && payload.pairs.length) {
    expiresUTC = Math.max(...payload.pairs.map(pair =>
      (+pair.pressUTC || anchorUTC) + GATHER + (+pair.march || 0))) + 30;
  }
  const command = {
    id: crypto.randomUUID(), type, kingdom: kd, anchorUTC, expiresUTC, payload,
    text: clampStr(c.text, 200), at: this.now()
  };
  command.delivery = startCommandDelivery(command, this.devices, this.nowMs());
  this.room.live.commands[kd] = command;
}
```

Then replace the shared cleanup with this exact conditional cleanup:

```js
if (type !== 'cancel') {
  this.room.live.staged[kd] = null;
}
```

Keep the existing `persistAll → scheduleExpiry → broadcast → cancelDeliveryCommand` ordering unchanged.

- [ ] **Step 5: Confirm GREEN and protect delivery ordering**

Run:

```bash
node --test test/cancel-rally-selection.test.cjs
node --test test/triple-room.test.cjs test/reliable-room-delivery.test.cjs test/player-protocol.test.cjs
node --check src/room.js
git diff --check
```

Expected: all commands exit 0; cancel restoration passes without changing the Reliable Classic-first ordering tests.

- [ ] **Step 6: Audit and commit Task 1**

Run GitNexus change detection against the exact worktree, inspect the `Room.webSocketMessage` impact set, stage only `src/room.js` and `test/cancel-rally-selection.test.cjs`, and commit as `fix: restore rally team after cancel`.

### Task 2: Suppress only the duplicate standby alert

**Files:**
- Create: `test/cancel-rally-client.test.cjs`
- Modify: `public/kvk.js`

**Interfaces:**
- Consumes: a canonical room snapshot, the current player PID, and the prior assignment key.
- Produces: `stageAlertTransition(room, pid, previousKey) -> { key: string, alert: boolean }`.

- [ ] **Step 1: Write the failing pure client transition test**

Create a source-extraction test that evaluates `stageAlertTransition` and drives these exact snapshots:

```js
const staged = { live: { staged: { 1: { kingdom: 1, pairs: [
  { pid: '930000001', role: 'weak' }
] }, 2: null }, commands: { 1: null, 2: null } } };
const fired = { live: { staged: { 1: null, 2: null }, commands: { 1: {
  type: 'double_rally', kingdom: 1,
  payload: { pairs: [{ pid: '930000001', role: 'weak', pressUTC: 1010 }] }
}, 2: null } } };
const empty = { live: { staged: { 1: null, 2: null }, commands: { 1: null, 2: null } } };

const first = transition(staged, '930000001', '');
assert.deepEqual(first, { key: '1:weak', alert: true });
assert.deepEqual(transition(fired, '930000001', first.key), {
  key: '1:weak', alert: false
});
assert.deepEqual(transition(staged, '930000001', first.key), {
  key: '1:weak', alert: false
});
assert.deepEqual(transition(empty, '930000001', first.key), {
  key: '', alert: false
});
assert.deepEqual(transition(staged, '930000001', ''), {
  key: '1:weak', alert: true
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/cancel-rally-client.test.cjs`

Expected: FAIL because `stageAlertTransition` does not exist.

- [ ] **Step 3: Implement the pure assignment transition**

Add this function near `stagedForMe`:

```js
function stageAlertTransition(sourceRoom, pid, previousKey) {
  var live = sourceRoom && sourceRoom.live || {}, staged = live.staged || {};
  var key = '', hasStage = false, k, pairs, pair;
  for (k = 1; k <= 2 && !key; k += 1) {
    pairs = staged[k] && Array.isArray(staged[k].pairs) ? staged[k].pairs : [];
    pair = pairs.filter(function (item) { return item && item.pid === pid; })[0];
    if (pair) { key = k + ':' + pair.role; hasStage = true; }
  }
  for (k = 1; k <= 2 && !key; k += 1) {
    pairs = live.commands && live.commands[k] && live.commands[k].payload &&
      Array.isArray(live.commands[k].payload.pairs) ? live.commands[k].payload.pairs : [];
    pair = pairs.filter(function (item) { return item && item.pid === pid; })[0];
    if (pair) key = k + ':' + pair.role;
  }
  return { key: key, alert: !!(hasStage && key !== previousKey) };
}
```

In `onState`, replace the direct `sk !== lastStagedKey` bookkeeping with:

```js
var stageTransition = stageAlertTransition(r, myPid, lastStagedKey);
if (stageTransition.alert) {
  if (viewMode === 'defense') setView('attack');
  fireAlert();
  try { navigator.vibrate && navigator.vibrate([80, 40, 80]); } catch (e) {}
}
lastStagedKey = stageTransition.key;
```

Do not change `beepCancelled`, cancellation toast logic, countdown scheduling, or `fireAlert` itself.

- [ ] **Step 4: Confirm GREEN and run client regressions**

Run:

```bash
node --test test/cancel-rally-client.test.cjs
node --test test/audio-readiness.test.cjs test/kvk-rally-client.test.cjs test/triple-client-source.test.cjs
node --check public/kvk.js
git diff --check
```

Expected: all tests pass, including the full Stage → Fire → restored Stage lifecycle with only the initial standby alert requested.

- [ ] **Step 5: Audit and commit Task 2**

Run GitNexus change detection against the exact worktree, stage only `public/kvk.js` and `test/cancel-rally-client.test.cjs`, and commit as `fix: keep cancel restage audio silent`.

### Task 3: Prove multi-commander recovery and advance the build

**Files:**
- Modify: `test/kvk-core-multibrowser.e2e.cjs`
- Modify: `public/kvk-rally.js`
- Modify: `public/kvk-update.js`
- Modify: `public/kvk.html`
- Modify: `src/client-build.js`
- Modify exact build assertions in: `test/classic-delivery-client.test.cjs`, `test/client-build.test.cjs`, `test/delivery-browser-wiring.test.cjs`, `test/identity-input.e2e.cjs`, `test/kvk-rally-client.test.cjs`, `test/kvk-rally-wiring.test.cjs`, `test/kvk-update-wiring.test.cjs`, `test/kvk-update.test.cjs`, `test/march-sync.e2e.cjs`, `test/player-removal.e2e.cjs`, `test/roster-control.e2e.cjs`, `test/triple-room.test.cjs`, `test/worker-build.test.cjs`.

**Interfaces:**
- Consumes: canonical restored staging from Task 1 and silent client assignment continuity from Task 2.
- Produces: two live commander pages showing the same editable lineup after Cancel, reload recovery, enabled Fire when the current mode is complete, and coherent build `2026071506`.

- [ ] **Step 1: Add failing multi-browser assertions after the existing Cancel**

Immediately after the first `cancelCommand(commander.page, room)` in the core scenario, assert:

```js
const restored = await readSnapshot(commander.page, room);
assert.deepEqual(restored.room.live.staged['1'].pairs,
  liveCommand.payload.pairs.map(({ pid, role }) => ({ pid, role })),
  'Cancel restores the exact frozen captain roles as editable canonical staging');
for (const role of [commander, selectedCommander]) {
  await role.page.locator('#pickSlots .slot').nth(1).waitFor({ timeout: 8_000 });
  assert.equal(await role.page.locator('#pickSlots .slot.frozen').count(), 0,
    'both commanders receive editable restored slots');
  assert.equal(await role.page.locator('#pickSlots .slot').count(), 2,
    'both commanders receive the complete Double lineup');
  assert.equal(await role.page.locator('#fireDouble').isDisabled(), false,
    'both commanders can Fire the restored complete lineup');
}
await selectedCommander.page.reload({ waitUntil: 'networkidle' });
if (await selectedCommander.page.locator('#console').isHidden()) {
  await unlockCommander(selectedCommander.page);
}
assert.equal(await selectedCommander.page.locator('#pickSlots .slot').count(), 2,
  'a refreshed commander rebuilds the lineup from canonical staging');
```

Run: `npm run test:kvk-core`

Expected: FAIL before Task 1/2 are present; after those tasks the new assertions pass.

- [ ] **Step 2: Advance every coherent build reference**

Replace exact build generation `2026071505` with `2026071506` only in the files listed for this task. Do not change unrelated site asset versions or Wrangler feature gates.

- [ ] **Step 3: Verify the integration and build gate**

Run:

```bash
npm run test:kvk-core
node --test test/client-build.test.cjs test/worker-build.test.cjs test/kvk-update.test.cjs test/kvk-update-wiring.test.cjs test/kvk-rally-client.test.cjs test/kvk-rally-wiring.test.cjs test/delivery-browser-wiring.test.cjs test/classic-delivery-client.test.cjs
git diff --check
```

Expected: the Chromium multi-browser scenario and all build-generation assertions pass with `2026071506`.

- [ ] **Step 4: Audit and commit Task 3**

Run GitNexus change detection against the exact worktree, verify the broad build-file diff is only the exact numeric generation replacement plus the Cancel assertions, and commit as `chore: advance cancel recovery build`.

### Task 4: Full verification and isolated QA deployment

**Files:**
- No additional tracked source files.
- Update ignored ledger: `.superpowers/sdd/progress.md`.

**Interfaces:**
- Consumes: Tasks 1–3 at build `2026071506` and `wrangler.qa.toml`.
- Produces: a verified isolated QA Worker deployment and one newly generated phone-test room.

- [ ] **Step 1: Run the complete local matrix**

Run:

```bash
npm test
npm run test:triple
npm run test:delivery
npm run test:kvk-core
npx wrangler deploy -c wrangler.qa.toml --dry-run
node --check public/kvk.js
node --check src/room.js
git diff --check
```

Expected: every test and syntax command exits 0; the dry-run lists only the isolated `ROOM` Durable Object, static assets, and Triple variables.

- [ ] **Step 2: Run final change and code review**

Run `gitnexus_detect_changes` against the exact worktree and generate a whole-branch review package from the implementation base through HEAD. The reviewer must confirm server-authoritative restoration, duplicate-Cancel idempotency, current-mode filtering, cross-kingdom isolation, one cancellation cue, no second standby alert, and no production binding change.

- [ ] **Step 3: Deploy only the isolated QA Worker**

Run:

```bash
npx wrangler deploy -c wrangler.qa.toml --tag git-$(git rev-parse --short=12 HEAD) --message "KvK cancel restores rally team QA"
```

Expected: deployment target is `kingshoter-qa.kingshot1406.workers.dev`; output contains no `kingshoter.com` route and no production KV/cron bindings.

- [ ] **Step 4: Generate and seed a fresh online room**

Create an ignored QA seeding script that uses WebSockets to:

1. generate a unique `qa-kvk-cancel-<time>-<random>` room;
2. claim it with a random password;
3. register at least three captains;
4. stage and Fire a Double rally;
5. Cancel it;
6. assert the online snapshot has `commands[1] === null` and the original two `{ pid, role }` pairs in `staged[1]`;
7. send a duplicate Cancel and assert staging is unchanged.

Use `clientBuild=2026071506`, print the room, password, and viewer profiles, and fail non-zero on any mismatch.

- [ ] **Step 5: Perform browser smoke verification and hand off**

Open the generated URL on the QA origin, unlock two independent commander browser contexts, and verify both show two editable restored slots and enabled Fire. Confirm no page errors. Provide the phone URL and password, explicitly stating production traffic and production rooms were untouched.
