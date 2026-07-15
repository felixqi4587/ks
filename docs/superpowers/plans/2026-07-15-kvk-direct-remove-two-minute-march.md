# KvK Direct Remove and Two-Minute March Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the redundant commander overflow menu with a confirmed direct Remove action and make 5–120 seconds the canonical march-time domain with one fixed two-minute idle scale.

**Architecture:** Keep the existing room protocol, commander march editor, removal state machine, command timing, and Classic audio authority. Add one server normalization result that reports and persists legacy march clamping, simplify only the roster action surface, then publish the client changes as one coherent forced-refresh build. Existing live commands remain immutable while future commands consume the migrated canonical player values.

**Tech Stack:** Cloudflare Workers and Durable Objects, vanilla browser JavaScript, HTML/CSS, Node.js `node:test`, Playwright Chromium/Firefox/WebKit, GitNexus impact/diff analysis.

## Global Constraints

- March time is inclusive `5–120` seconds everywhere; `MARCH_MIN = 5` and `MARCH_MAX = 120` are the server authority.
- Every stored integer march above 120 migrates to exactly 120, advances its revision once, and persists; identity, ownership, presence, staging, and unrelated fields stay unchanged.
- Already-fired command payloads remain byte-equivalent; only later Fire uses migrated player values.
- The idle tactical timeline and radar use a fixed 120-second domain. The live press → five-minute gather → march → landing timeline stays truthful and unchanged.
- The English hint is exactly `Battle tip: if you will use a pet march-speed buff, activate it before measuring.`
- The Chinese hint is exactly `实战提示：如果你会使用宠物行军速度增益，请在测量前先开启。`
- The roster time button remains the sole march-edit entry. The final row control is direct localized Remove and always opens the existing confirmation dialog before mutation.
- No pet-buff field, selector, validation, or enforcement is added.
- No audio, lead-time, landing-offset, Double/Triple role, or removal-protocol behavior changes.
- All browser and network tests use newly generated `qa-kvk-*` rooms. Never access or mutate room 1406.
- Do not deploy production in this plan. Leave the local QA page running for user verification.
- Before editing every existing function/class/method, run GitNexus upstream impact and report risk. Before every commit, stage only listed paths and run GitNexus staged change detection.

## File Structure

### Server domain and migration

- `kingshoter/src/room-player.js` — owns `MARCH_MIN`, `MARCH_MAX`, strict mutation parsing, and the legacy player-record migration result.
- `kingshoter/src/room.js` — persists a detected player march migration during the Durable Object constructor gate without changing live commands.
- `kingshoter/src/rally-targets.js` — consumes strict canonical march parsing for Triple; implementation should not need a second limit.
- `kingshoter/test/player-domain.test.cjs` — unit boundary and idempotent migration coverage.
- `kingshoter/test/player-protocol.test.cjs` — Durable Object persistence and frozen-command migration coverage.
- `kingshoter/test/rally-targets.test.cjs` — Triple permutations at the new upper boundary.

### Direct roster removal

- `kingshoter/public/kvk.html` — removes the detached overflow-menu markup.
- `kingshoter/public/app.css` — turns the existing `.roster-actions` cell into a localized destructive text control and removes menu-only CSS.
- `kingshoter/public/kvk.js` — renders direct Remove, reuses the confirmation state machine, and deletes menu-only state/wiring.
- `kingshoter/test/player-removal.e2e.cjs` — primary direct-control, confirmation, focus, retry, and unavailable-state coverage.
- `kingshoter/test/player-removal-multimanager.e2e.cjs` — canonical cross-manager deletion behavior through the direct button.
- `kingshoter/test/player-removal-own-device.e2e.cjs` — own-device cleanup and re-registration through the direct button.
- `kingshoter/test/kvk-core-multibrowser.e2e.cjs` — shared cross-browser helper and protected-active-player assertions.
- `kingshoter/test/roster-control.e2e.cjs` — sibling-control and trusted-click convergence with the new direct action.

### Client march domain and coherent build

- `kingshoter/public/kvk.html` — slider maximum 120 and one new asset build generation.
- `kingshoter/public/kvk.js` — client limit, fixed scale, exact localized hints, and 2:00 validation copy.
- `kingshoter/public/kvk-rally.js` — shared build generation only; rally semantics remain unchanged.
- `kingshoter/public/kvk-update.js` — updater build generation.
- `kingshoter/src/client-build.js` — current/minimum KvK and Triple build metadata.
- `kingshoter/test/march-domain.e2e.cjs` — focused browser validation for slider, hint, commander editor, and fixed idle scale.
- Existing build and wiring tests containing the old exact build number — mechanically updated to the new generation without changing assertions.

---

### Task 1: Enforce and Persist the Canonical Two-Minute Server Domain

**Files:**
- Modify: `kingshoter/src/room-player.js`
- Modify: `kingshoter/src/room.js`
- Modify: `kingshoter/test/player-domain.test.cjs`
- Modify: `kingshoter/test/player-protocol.test.cjs`
- Modify: `kingshoter/test/rally-targets.test.cjs`

**Interfaces:**
- Produces: `MARCH_MAX = 120`.
- Produces: `normalizePlayerRecordsWithMigration(players) -> { players, changed }`.
- Preserves: `normalizePlayerRecords(players) -> null-prototype player map` as a compatibility wrapper.
- Consumes: existing `normalizeMarchRevision(value)` and room storage key `room`.

- [ ] **Step 1: Record symbol impact before editing**

Run GitNexus upstream impact for `parseMarchSeconds`, `normalizePlayerRecords`, and `Room` constructor in the `ks` index. Include tests and report direct callers, affected execution flows, and risk before edits. A HIGH/CRITICAL result is reported before proceeding under the user's standing approval.

- [ ] **Step 2: Write failing strict-boundary and migration tests**

Update `test/player-domain.test.cjs` so the boundary is exact:

```js
assert.equal(parseMarchSeconds(5), 5);
assert.equal(parseMarchSeconds('120'), 120);
for (const value of [4, 121, 180, 6.5, '6.5', 'abc', '', null, Infinity, NaN]) {
  assert.equal(parseMarchSeconds(value), null);
}
```

Add an idempotent migration assertion:

```js
const first = normalizePlayerRecordsWithMigration({
  legacy: { name: 'Legacy', march: 180, marchRevision: 7, identityMode: 'nickname', ready: true },
  current: { name: 'Current', march: 120, marchRevision: 4, identityMode: 'playerId' }
});
assert.equal(first.changed, true);
assert.equal(first.players.legacy.march, 120);
assert.equal(first.players.legacy.marchRevision, 8);
assert.equal(first.players.legacy.ready, true);
assert.equal(first.players.current.marchRevision, 4);
const second = normalizePlayerRecordsWithMigration(first.players);
assert.equal(second.changed, false);
assert.equal(second.players.legacy.marchRevision, 8);
```

Add protocol coverage that seeds a stored player at 180 plus an active command whose frozen pair is 180, constructs `Room`, awaits its concurrency gate, then asserts the stored/current player is 120 with one revision increment while the active command pair remains 180.

Update Triple boundary fixtures from 180 to 120 and assert 121 returns `invalid_march`.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
cd kingshoter
node --test test/player-domain.test.cjs test/player-protocol.test.cjs test/rally-targets.test.cjs
```

Expected: FAIL because 180 is still accepted, the migration interface is absent, and stored records are not durably clamped.

- [ ] **Step 4: Implement the domain and idempotent migration**

In `src/room-player.js`, retain one strict parser and add a metadata-returning normalization core:

```js
export const MARCH_MIN = 5;
export const MARCH_MAX = 120;

export function normalizePlayerRecordsWithMigration(players) {
  const source = players && typeof players === 'object' ? players : {};
  const result = Object.create(null);
  let changed = false;
  for (const pid of Object.keys(source)) {
    const player = source[pid] && typeof source[pid] === 'object' ? source[pid] : {};
    const revision = normalizeMarchRevision(player.marchRevision);
    const legacyOverMax = Number.isInteger(player.march) && player.march > MARCH_MAX;
    result[pid] = Object.assign({}, player, {
      march: legacyOverMax ? MARCH_MAX : player.march,
      marchRevision: revision + (legacyOverMax ? 1 : 0)
    });
    if (legacyOverMax || revision !== player.marchRevision) changed = true;
  }
  return { players: result, changed };
}

export function normalizePlayerRecords(players) {
  return normalizePlayerRecordsWithMigration(players).players;
}
```

Do not coerce malformed non-integer values into valid march values. New writes continue through `parseMarchSeconds` and fail closed.

- [ ] **Step 5: Persist migration in the constructor gate**

Import `normalizePlayerRecordsWithMigration` in `src/room.js`. Inside `state.blockConcurrencyWhile`, normalize only `this.room.players`, preserve `this.room.live` command payloads, run existing live normalization, and `await state.storage.put('room', this.room)` only when the player migration result reports `changed`.

Storage failure must reject the constructor gate rather than expose an unpersisted canonical value. No broadcast is needed because new sockets receive the post-gate snapshot.

- [ ] **Step 6: Run focused and full server tests**

Run:

```bash
cd kingshoter
node --test test/player-domain.test.cjs test/player-protocol.test.cjs test/rally-targets.test.cjs test/triple-room.test.cjs test/fire-double-snapshot.test.cjs
npm test
```

Expected: all tests pass; 121/180 are rejected as new values, one stored legacy value migrates exactly once, and active command payloads stay unchanged.

- [ ] **Step 7: Detect scope and commit**

Stage only the five Task 1 paths. Run GitNexus staged change detection and confirm affected flows are limited to player normalization, profile/march mutations, and rally construction. Commit:

```bash
git commit -m "feat: enforce two-minute kvk march times"
```

---

### Task 2: Replace the Overflow Menu with Direct Confirmed Remove

**Files:**
- Modify: `kingshoter/public/kvk.html`
- Modify: `kingshoter/public/app.css`
- Modify: `kingshoter/public/kvk.js`
- Modify: `kingshoter/test/player-removal.e2e.cjs`
- Modify: `kingshoter/test/player-removal-multimanager.e2e.cjs`
- Modify: `kingshoter/test/player-removal-own-device.e2e.cjs`
- Modify: `kingshoter/test/kvk-core-multibrowser.e2e.cjs`
- Modify: `kingshoter/test/roster-control.e2e.cjs`

**Interfaces:**
- Preserves: `.roster-actions[data-pid]` as the stable final row-control selector, now a direct Remove button.
- Preserves: `openRemovalDialog(pid)`, `submitRemoval()`, and the existing `removePlayer` protocol.
- Removes: `#rosterActionsMenu`, menu items, menu positioning, roving focus, outside-click dismissal, and menu-only explanation state.

- [ ] **Step 1: Record symbol impact before editing**

Run GitNexus upstream impact for `renderRoster`, `openRemovalDialog`, `closeRemovalDialog`, and `wireRoom`. Report direct callers and affected roster/removal processes. Warn before HIGH/CRITICAL edits.

- [ ] **Step 2: Rewrite browser tests to describe the approved direct interaction and verify RED**

Change every removal helper from two clicks to one:

```js
async function openRemove(page, pid) {
  await page.locator(`#roster .roster-actions[data-pid="${pid}"]`).click();
  await page.locator('#removePlayerOvl').waitFor({ state: 'visible', timeout: 5_000 });
}
```

In the primary removal E2E assert:

```js
assert.equal(await manager.locator('#rosterActionsMenu').count(), 0);
assert.match(await actions.textContent(), /Remove/i);
assert.equal(await actions.getAttribute('aria-haspopup'), null);
assert.equal(await actions.getAttribute('aria-controls'), null);
assert.ok(actionBox.width >= 44 && actionBox.height >= 44);
await actions.click();
await dialog.waitFor({ state: 'visible' });
```

Move duplicate march-editor coverage to `.roster-time[data-pid]`. For an active captain, click direct Remove, assert no dialog, assert `aria-disabled="true"`, and assert the existing localized active-rally toast appears. Keep all confirmation, staged-impact change, retry, unknown-outcome, bad-password, focus-trap, and cross-manager assertions.

Run:

```bash
cd kingshoter
node test/player-removal.e2e.cjs
```

Expected: FAIL because the product still renders `⋯` and requires the detached menu.

- [ ] **Step 3: Remove menu markup, state, and wiring**

Delete `#rosterActionsMenu` and its children from `public/kvk.html`. In `public/kvk.js`, remove `rosterActionsPid` and the four menu-only functions, menu render calls, resize/scroll handlers, menu click/keydown handlers, and outside-pointer dismissal.

Keep `restorePlayerActionsFocus(pid)` because it remains the focus-restoration helper for `.roster-actions[data-pid]`.

- [ ] **Step 4: Render direct localized Remove**

In `renderRoster`, configure the existing final button without replacing the row node:

```js
const snapshot = removalSnapshot(p.pid);
const removalBusy = !!(removalState && ['pending', 'unknown'].includes(removalState.status) && removalState.pid !== p.pid);
del.textContent = tk('action_remove');
del.setAttribute('aria-label', tkf('remove_aria', { n: playerDisplayText(p.pid, room.players) }));
del.setAttribute('aria-disabled', snapshot.active || removalBusy ? 'true' : 'false');
del.removeAttribute('aria-haspopup');
del.removeAttribute('aria-controls');
del.removeAttribute('aria-expanded');
del.onclick = function (event) {
  event.preventDefault();
  event.stopPropagation();
  openRemovalDialog(p.pid);
};
```

Use the repository's existing ES5-style `var` syntax in `public/kvk.js` even when the plan snippet uses `const` for readability.

Update `openRemovalDialog(pid)` so active and unrelated-pending cases call the existing localized toast and return without opening the dialog. Remove references to the deleted menu explanation and menu close helper. Preserve the rest of the state machine exactly.

- [ ] **Step 5: Update only focused row CSS**

Keep the four-column grid and 44-pixel minimum. Increase the last column enough for localized text without horizontal scroll, reduce the old ellipsis font size, apply coral text, and retain the rounded right edge and focus-visible ring. Remove `.roster-menu` and `.roster-actions-explanation` rules.

Verify at 375px and 390px that the page and roster have no horizontal overflow and the player-name column remains flexible.

- [ ] **Step 6: Run direct-removal and roster regression tests**

Run:

```bash
cd kingshoter
node test/player-removal.e2e.cjs
node test/player-removal-multimanager.e2e.cjs
node test/player-removal-own-device.e2e.cjs
node test/roster-control.e2e.cjs
```

Expected: all pass in newly generated QA rooms; no menu exists, direct Remove never toggles captain selection, and confirmation remains mandatory.

- [ ] **Step 7: Detect scope and commit**

Stage only the eight Task 2 paths. Run GitNexus staged change detection and confirm only roster rendering/removal/focus flows and their tests are affected. Commit:

```bash
git commit -m "refactor: make kvk player removal direct"
```

---

### Task 3: Align the Client Limit, Fixed Scale, Exact Hint, and Build Generation

**Files:**
- Create: `kingshoter/test/march-domain.e2e.cjs`
- Modify: `kingshoter/public/kvk.html`
- Modify: `kingshoter/public/kvk.js`
- Modify: `kingshoter/public/kvk-rally.js`
- Modify: `kingshoter/public/kvk-update.js`
- Modify: `kingshoter/src/client-build.js`
- Modify: exact-build assertions under `kingshoter/test/` that still name `2026071502`

**Interfaces:**
- Produces: coherent build generation `2026071503` for HTML assets, updater, shared rally module, WebSocket advertisement, and `/api/build` metadata.
- Preserves: live timeline calculation from command `pressUTC`, gather end, and landing.
- Changes: idle march domain to constant 120.

- [ ] **Step 1: Record symbol impact before editing**

Run GitNexus upstream impact for `parseMMSS`, `setMarchUI`, `mapData`, `domainFor`, `syncMap`, and the exported build constants. Report affected UI/timing/updater flows and warn before HIGH/CRITICAL edits.

- [ ] **Step 2: Add the focused browser test and verify RED**

Create `test/march-domain.e2e.cjs` with a generated QA room and guarded WebSocket. Assert before any registration:

```js
assert.equal(await page.locator('#marchRange').getAttribute('max'), '120');
assert.equal((await page.locator('#marchTip').textContent()).trim(),
  'Battle tip: if you will use a pet march-speed buff, activate it before measuring.');
```

Register players at 30, 60, and 120 seconds, unlock the commander, and assert idle `.ldot` left positions are approximately 25%, 50%, and the bounded visual endpoint. Click each roster time to prove `2:00` saves and `2:01` produces the localized invalid message without sending a successful mutation. Switch to Chinese and assert exactly one Chinese hint sentence.

Fire a separate valid command and assert the live lane still has a five-minute gather band and canonical landing clock; do not compare it to the idle 120-second domain.

Run:

```bash
cd kingshoter
node test/march-domain.e2e.cjs
```

Expected: FAIL because the slider is 180, the hint contains the old rally-measurement instruction, and idle scaling is dynamic.

- [ ] **Step 3: Implement the client 120-second domain and exact copy**

In `public/kvk.html`, set `#marchRange max="120"`.

In `public/kvk.js`:

```js
var MARCH_MIN_SECONDS = 5, MARCH_MAX_SECONDS = 120;
```

Use those constants in `parseMMSS`, `setMarchUI`, commander adjustment buttons, and idle player normalization. Change `march_invalid` to `0:05–2:00 (5–120 seconds)` and its Chinese equivalent.

Set the two hint translations to exactly the approved one-sentence strings. Do not retain `in-game: open a rally...` or append a testing exception.

Make `domainFor()` return 120 for march-distance rendering. Leave live lane `t0`, `span`, gather band, and landing calculations unchanged.

- [ ] **Step 4: Move every first-party KvK asset to one build generation**

Change `2026071502` to `2026071503` only in the canonical build constants, `kvk.html` first-party query strings, and exact-generation test fixtures/assertions. Do not change unrelated timestamps or duration values.

Set all three exports in `src/client-build.js` to `2026071503` so stale updater-capable clients must reload before normal operation. Keep the updater's deferral during a personal command unchanged.

- [ ] **Step 5: Run focused client, build, and timing tests**

Run:

```bash
cd kingshoter
node test/march-domain.e2e.cjs
node --test test/client-build.test.cjs test/worker-build.test.cjs test/kvk-update.test.cjs test/kvk-update-wiring.test.cjs test/kvk-rally-client.test.cjs test/kvk-rally-wiring.test.cjs test/delivery-browser-wiring.test.cjs test/classic-delivery-client.test.cjs
node test/march-sync.e2e.cjs
node test/lead-timing.cjs http://127.0.0.1:8791 10
```

Expected: all pass; every shipped asset advertises `2026071503`, 2:00 is the exact maximum, idle placement is fixed, and personal countdown timing is unchanged.

- [ ] **Step 6: Detect scope and commit**

Stage only the Task 3 files and mechanically updated exact-build tests. Run GitNexus staged change detection. Expected risk includes client build/updater and march rendering paths but no audio-scheduling semantic change. Commit:

```bash
git commit -m "feat: align kvk march scale to two minutes"
```

---

### Task 4: Full Regression, Review, and Local QA Handoff

**Files:**
- Modify only if a verified regression requires a scoped correction.
- Update: `docs/operations/kvk-program-rollout.md` only if recording new local evidence is consistent with the existing rollout ledger; do not mark production or physical-device evidence as passed.

**Interfaces:**
- Verifies the completed product; introduces no feature surface.

- [ ] **Step 1: Run syntax, whitespace, and complete unit gates**

Run:

```bash
cd kingshoter
node --check public/kvk.js
node --check test/march-domain.e2e.cjs
git diff --check
npm test
npm run test:triple
npm run test:delivery
```

Expected: zero syntax/whitespace failures and every suite reports zero failed tests.

- [ ] **Step 2: Run focused browser workflows**

Run the direct-removal, roster-control, march-domain, march-sync, identity, registration, reconnect, and removal workflows. Every script must print a newly generated `qa-kvk-*` room and exit successfully. Do not run any retained legacy script that lacks the QA guard.

- [ ] **Step 3: Run the supported three-browser gates**

Run:

```bash
cd kingshoter
npm run test:kvk-core:all
npm run test:qa:delivery
npm run test:qa:triple
```

Expected: Chromium, Firefox, and WebKit all pass. These are desktop browser gates and are not relabeled as physical mobile evidence.

- [ ] **Step 4: Request an independent code review**

Dispatch a read-only reviewer to compare the implementation with the approved spec, focusing on migration idempotence, frozen command immutability, direct-removal confirmation, focus behavior, fixed idle scale, exact copy, and absence of audio/timing regressions. Resolve only verified findings.

- [ ] **Step 5: Verify in a fresh visible local QA room**

Keep the local server on `127.0.0.1:8791`. Open a new `qa-kvk-*` room with build `2026071503`, confirm the exact hint, slider maximum, direct Remove text and confirmation dialog, 375px layout, and fixed idle scale. Leave that tab visible and deliverable to the user.

- [ ] **Step 6: Final staged change analysis and implementation commit if needed**

If Task 4 produced corrections or evidence-record changes, stage only those files, run GitNexus staged change detection, and commit them with a focused message. Otherwise leave the three implementation commits as the complete change set.

- [ ] **Step 7: Final handoff**

Report:

- local QA URL;
- exact implementation commit IDs;
- test counts and browser projects;
- legacy >120 migration behavior;
- confirmation that no room 1406 or production deployment was used;
- production restore tag remains unchanged.
