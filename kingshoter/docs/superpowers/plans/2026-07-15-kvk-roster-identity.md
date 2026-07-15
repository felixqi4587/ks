# KvK Roster Tap Reliability and Editable Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve native captain-name clicks across room broadcasts and let a registered player switch between Player ID and Nickname while keeping the same rally/audio routing identity.

**Architecture:** Reconcile roster rows by immutable routing PID instead of destroying the list on every snapshot. Treat Player ID and Nickname as mutable profile metadata, update identity plus march through one socket-authorized revisioned mutation, and keep the routing PID/device binding unchanged.

**Tech Stack:** Cloudflare Workers Durable Objects, browser JavaScript, WebSocket room snapshots, Node `node:test`, Playwright Chromium/Firefox/WebKit.

## Global Constraints

- Test and mutate only generated `qa-kvk-*` rooms; never use room `1406`.
- Do not deploy or push the feature branch as part of this plan.
- Preserve Classic countdown timing, audience rules, device IDs, acknowledgements, and QA Reliable Shadow behavior.
- Keep old `updateOwnMarch` server support so an older connected client fails safely during a rolling update.
- Use `2026071501` as the coherent first-party KvK asset/build generation and minimum accepted KvK build.
- Run GitNexus impact analysis before changing every existing function, method, class, or build symbol; stop and warn on HIGH/CRITICAL risk.
- Run GitNexus change detection before each commit.

---

### Task 1: Domain model for editable profile identity

**Files:**
- Modify: `src/room-player.js`
- Test: `test/player-domain.test.cjs`

**Interfaces:**
- Produces: `normalizeProfilePlayerId(value): string`
- Produces: `profilePlayerId(pid, player): string`
- Produces: `applyOwnProfileUpdate(players, input, options): ProfileMutationResult`
- Extends: `registerPlayer` to persist explicit numeric `playerId` and reject profile-level collisions.

- [ ] **Step 1: Write failing domain tests**

Add cases equivalent to:

```js
const players = {
  routeA: { name: 'Alpha', march: 30, marchRevision: 0, identityMode: 'nickname' }
};
const updated = applyOwnProfileUpdate(players, {
  mutationId: 'profile-1', pid: 'routeA', identityMode: 'playerId',
  playerId: '900000001', name: 'Resolved Alpha', march: 31, baseRevision: 0
}, { touchLastSeen: true, nowISO });
assert.deepEqual(updated.profile, {
  pid: 'routeA', identityMode: 'playerId', playerId: '900000001',
  name: 'Resolved Alpha', march: 31, revision: 1
});
assert.equal(players.routeA.playerId, '900000001');
```

Also assert nickname conversion removes `playerId`, invalid values do not mutate, stale revisions return the canonical profile, and another routing PID cannot claim the same numeric Player ID.

- [ ] **Step 2: Run the focused domain test and verify RED**

Run: `node --test test/player-domain.test.cjs`

Expected: FAIL because the profile helpers and update function do not exist.

- [ ] **Step 3: Implement strict profile metadata and one atomic mutation**

Use these rules:

```js
normalizeProfilePlayerId(value) // digits only, 1..16 characters
profilePlayerId(pid, player)    // explicit playerId, else numeric legacy pid in playerId mode
applyOwnProfileUpdate(...)      // validate all fields before assigning one new player record
```

Keep `pid` unchanged. Reuse the existing march revision for concurrent whole-profile edits. Return `player_id_conflict`, `invalid_player_id`, `invalid_nickname`, `invalid_march`, `player_missing`, or `player_conflict` without partial mutation.

- [ ] **Step 4: Run the focused domain test and verify GREEN**

Run: `node --test test/player-domain.test.cjs`

Expected: PASS.

---

### Task 2: Socket-authorized profile update protocol

**Files:**
- Modify: `src/room.js`
- Test: `test/player-protocol.test.cjs`

**Interfaces:**
- Consumes: `applyOwnProfileUpdate` from Task 1.
- Consumes message: `{t:'updateOwnProfile', mutationId, pid, identityMode, playerId, name, march, baseRevision}`.
- Produces ACK: `{t:'playerProfileSaved', mutationId, pid, identityMode, playerId, name, march, revision}`.

- [ ] **Step 1: Write failing protocol tests**

Cover a socket-bound nickname → Player ID update, Player ID → nickname update, spoofed PID, duplicate Player ID, stale revision, all-room broadcast, and persistence rollback. The success assertion must prove the attachment still contains the original routing PID and device ID:

```js
await bindPlayerSocket(h, '001', deviceId);
await h.room.webSocketMessage(h.ws, JSON.stringify({
  t: 'updateOwnProfile', mutationId: 'profile-1', pid: '001',
  identityMode: 'nickname', name: 'New Nick', march: 33, baseRevision: 0
}));
assert.equal(h.room.readSocketAttachment(h.ws).pid, '001');
assert.equal(h.room.room.players['001'].name, 'New Nick');
assert.deepEqual(h.calls, ['persist', 'broadcast']);
```

- [ ] **Step 2: Run the focused protocol test and verify RED**

Run: `node --test test/player-protocol.test.cjs`

Expected: FAIL because `updateOwnProfile` is unsupported.

- [ ] **Step 3: Implement the new message branch**

Authorize with the canonical socket attachment before looking up or mutating a player. Copy the previous player record, apply the domain mutation, persist, send `playerProfileSaved`, and broadcast. If persistence throws, restore the previous record and send `profile_persist_failed`. Leave `updateOwnMarch` untouched for rolling compatibility.

- [ ] **Step 4: Run domain and protocol tests and verify GREEN**

Run: `node --test test/player-domain.test.cjs test/player-protocol.test.cjs`

Expected: PASS.

---

### Task 3: Bidirectional Player ID/Nickname editor

**Files:**
- Modify: `public/kvk.html`
- Modify: `public/kvk.js`
- Modify: `test/player-protocol-client.test.cjs`
- Modify: `test/identity-input.e2e.cjs`

**Interfaces:**
- Consumes/produces the Task 2 message and ACK.
- Keeps local profile shape `{pid, playerId?, name, march, marchRevision, identityMode}`.
- Keeps two UI drafts: `{playerId: string, nickname: string}`.

- [ ] **Step 1: Update identity tests first**

Replace the old assertion that saved identity controls are disabled with these requirements:

```js
await page.locator('#editBtn').click();
await page.locator('#identityPlayerId').click();
await page.locator('#pid').fill('900000777');
await page.locator('#identityNickname').click();
await page.locator('#pid').fill('Tester Two');
await page.locator('#identityPlayerId').click();
assert.equal(await page.locator('#pid').inputValue(), '900000777');
await page.locator('#identityNickname').click();
assert.equal(await page.locator('#pid').inputValue(), 'Tester Two');
```

Assert that visible and fallback copy contain neither `For testing` nor `测试用`, that stale lookup replies cannot cross modes, and that another page sees the canonical identity/march immediately after Save.

- [ ] **Step 2: Run client/unit and identity E2E tests and verify RED**

Run:

```bash
node --test test/player-protocol-client.test.cjs
node test/identity-input.e2e.cjs
```

Expected: FAIL on locked controls, cleared drafts, old copy, and missing `updateOwnProfile` handling.

- [ ] **Step 3: Implement independent drafts and canonical reconciliation**

Make `setIdentityMode` save the outgoing input and restore the incoming draft. Abort any obsolete lookup, clear resolved-name state, and restart lookup only for a restored numeric Player ID. `showExistingIdentity` seeds the canonical mode draft but does not expose the opaque routing PID.

Existing-profile Save sends one `updateOwnProfile` mutation and stays on the old canonical profile until both matching ACK and room state are seen. Match all requested fields, not march alone. `adoptCanonicalPlayer`, registration retry, local storage, and language rerender must carry `playerId` metadata.

- [ ] **Step 4: Remove testing copy**

Render the second option as only `Nickname`/`昵称`. Remove testing wording from the HTML fallback, translation data, and nickname placeholder.

- [ ] **Step 5: Run client/unit and identity E2E tests and verify GREEN**

Run:

```bash
node --test test/player-domain.test.cjs test/player-protocol.test.cjs test/player-protocol-client.test.cjs
node test/identity-input.e2e.cjs
```

Expected: PASS.

---

### Task 4: Stable keyed roster DOM

**Files:**
- Modify: `public/kvk.js`
- Modify: `test/roster-control.e2e.cjs`

**Interfaces:**
- Preserves `.roster-row[data-pid]` and its `.rp`, role, time, and actions controls while that PID exists.
- Keeps `selectOrReplacePlayer(pid)` as the only name-button selection action.

- [ ] **Step 1: Add the trusted interrupted-click regression**

Use a generated QA room and a real mouse sequence:

```js
const target = primary('900000004');
const original = await target.elementHandle();
const box = await target.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await sendMessages(page, []); // observer close causes a room broadcast
assert.equal(await original.evaluate(node => node.isConnected), true);
await page.mouse.up();
await expectStage('900000004');
```

Also retain the existing assertions for full-slot replacement and cross-kingdom rejection.

- [ ] **Step 2: Run roster E2E and verify RED**

Run: `node test/roster-control.e2e.cjs`

Expected: FAIL because the original button is detached and the player is not selected.

- [ ] **Step 3: Reconcile rows by routing PID**

Create a fixed child structure only for a new PID. For every render, update classes, text, accessibility attributes, visibility, and current handlers on the existing controls. Move a row only if its sorted position changed. Remove only PIDs absent from the canonical snapshot. Keep duplicate suffix as a stable hidden/text span so name-button descendants are not replaced during a gesture.

- [ ] **Step 4: Run roster E2E and verify GREEN**

Run: `node test/roster-control.e2e.cjs`

Expected: PASS, including trusted interrupted click, keyboard/focus, search, role swap, replacement, remote march update, and removal.

---

### Task 5: Coherent client build and forced refresh floor

**Files:**
- Modify: `public/kvk.html`
- Modify: `public/kvk-update.js`
- Modify: `public/kvk-rally.js`
- Modify: `src/client-build.js`
- Modify: exact build assertions under `test/`

**Interfaces:**
- Produces one coherent build: `2026071501`.
- Produces metadata with `currentBuild = minKvkBuild = minTripleBuild = 2026071501`.

- [ ] **Step 1: Change tests to the new generation and verify RED**

Update exact asset/build assertions from `2026071401` to `2026071501`, including updater, worker metadata, rally adapter, delivery wiring, and browser E2E checks.

Run: `npm test`

Expected: FAIL because source constants and HTML asset URLs are still the previous generation.

- [ ] **Step 2: Update all first-party build constants and asset URLs atomically**

Set:

```js
CURRENT_KVK_BUILD = 2026071501
MIN_KVK_BUILD = 2026071501
MIN_TRIPLE_BUILD = 2026071501
```

Use the same value for `KvkUpdate.BUILD`, `KvkRally.BUILD`, and every first-party `?v=` in `kvk.html`.

- [ ] **Step 3: Run build/update suites and verify GREEN**

Run:

```bash
node --test test/client-build.test.cjs test/worker-build.test.cjs test/kvk-update.test.cjs test/kvk-update-wiring.test.cjs test/kvk-rally-client.test.cjs test/kvk-rally-wiring.test.cjs test/delivery-browser-wiring.test.cjs test/classic-delivery-client.test.cjs
```

Expected: PASS with no mixed-cache generation.

---

### Task 6: Full QA verification and local handoff

**Files:**
- Modify only if a test reveals a scoped defect.

**Interfaces:**
- Consumes all prior tasks.
- Produces a clean local commit and a working `http://127.0.0.1:8791/kvk?room=<generated-qa-room>&notour=1` handoff.

- [ ] **Step 1: Run static and unit suites**

Run:

```bash
npm test
npm run test:triple
npm run test:delivery
```

Expected: all tests pass.

- [ ] **Step 2: Run focused browser suites against generated QA rooms**

Run:

```bash
node test/identity-input.e2e.cjs
node test/roster-control.e2e.cjs
npm run test:kvk-core
npm run test:qa:delivery:chromium
```

Expected: all tests pass; output room names all begin with `qa-kvk-`.

- [ ] **Step 3: Run cross-engine browser suites**

Run:

```bash
npm run test:kvk-core:all
npm run test:qa:delivery
```

Expected: Chromium, Firefox, and desktop WebKit pass. Record that these are not physical iOS/Android lock-screen evidence.

- [ ] **Step 4: Inspect the local page**

Use a newly generated manual QA room. Verify no horizontal roster scroll, stable player-name taps during repeated observer connects/disconnects, bidirectional identity edits, immediate second-page sync, unchanged routing PID/device green state, and absence of testing copy.

- [ ] **Step 5: Review scope and commit**

Run GitNexus `detect_changes`, `git diff --check`, `git status --short`, and inspect the complete diff. Stage only intended files, excluding workspace metadata. Commit with:

```bash
git commit -m "fix: stabilize kvk roster taps and editable identity"
```

- [ ] **Step 6: Handoff without deployment**

Keep the local server available, provide the generated QA URL, state which test suites passed, explain the actual Classic/green/Received semantics, and explicitly state that no production deploy or room `1406` mutation occurred.
