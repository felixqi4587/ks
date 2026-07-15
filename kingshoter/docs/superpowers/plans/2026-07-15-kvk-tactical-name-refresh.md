# KvK Tactical Name Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every already-open idle tactical panel immediately adopt a player's canonical new display name without changing an already-fired rally snapshot.

**Architecture:** Add a pure render-key helper that signs every field rendered by the idle tactical view and retains the existing command-ID key for live views. Prove the cache behavior in a focused unit test, reproduce the user-visible rename in two browsers, then publish a coherent forced-refresh client generation.

**Tech Stack:** Browser JavaScript, Cloudflare Workers/Durable Objects, WebSocket room snapshots, Node `node:test`, Playwright Chromium, GitNexus.

## Global Constraints

- Follow the approved A behavior in `docs/superpowers/specs/2026-07-15-kvk-tactical-name-refresh-design.md`.
- All ordinary rooms use identical behavior; no room name may appear in product logic.
- Automated browser mutations use a freshly generated `qa-kvk-*` room so runs are isolated and repeatable.
- Keep already-fired Double and Triple Rally payload names, march times, roles, targets, countdowns, audio, and delivery acknowledgements frozen.
- Do not change server identity, ownership, persistence, or WebSocket protocols.
- Advance the complete first-party client generation from `2026071503` to `2026071504` so older open pages are forced to refresh.
- Run GitNexus impact analysis before changing every existing function, method, class, or build symbol; the known `syncMap` impact is HIGH and requires idle/live regression coverage.
- Run GitNexus staged change detection before every commit.

---

### Task 1: Name-only cache regression tests

**Files:**
- Create: `test/map-render-key.test.cjs`
- Modify: `test/identity-input.e2e.cjs`

**Interfaces:**
- Consumes future helper: `mapRenderKey(data): string`.
- Browser invariant: after canonical settlement, both already-open pages render the new name in `#lanes .lname` without changing march time.

- [ ] **Step 1: Create the focused render-key unit test**

Add a function extractor consistent with existing browser-source tests and these assertions:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let body = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') { depth += 1; body = true; }
    if (source[index] === '}') depth -= 1;
    if (body && depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

function loadMapRenderKey() {
  const sandbox = {};
  vm.runInNewContext(`${extractFunction('mapRenderKey')}\nthis.mapRenderKey = mapRenderKey;`, sandbox);
  return sandbox.mapRenderKey;
}

test('idle tactical render key includes canonical display fields', () => {
  const key = loadMapRenderKey();
  const ff = { live: false, actors: [{ pid: 'route-a', name: 'Ff', march: 34, role: 'joiner', mine: true }] };
  const kimchi = { live: false, actors: [{ ...ff.actors[0], name: 'Kimchi' }] };
  assert.notEqual(key(ff), key(kimchi));
  assert.equal(key(ff), key(structuredClone(ff)));
});

test('live tactical render key remains frozen to the command id', () => {
  const key = loadMapRenderKey();
  assert.equal(
    key({ live: true, id: 'cmd-1', actors: [{ name: 'Ff' }] }),
    key({ live: true, id: 'cmd-1', actors: [{ name: 'Kimchi' }] })
  );
  assert.notEqual(key({ live: true, id: 'cmd-1', actors: [] }), key({ live: true, id: 'cmd-2', actors: [] }));
});
```

- [ ] **Step 2: Add the two-open-page browser regression**

In the existing Player ID/Nickname edit flow, perform one additional name-only edit while preserving the current march. Wait for canonical settlement, then assert both existing pages have repainted:

```js
await racePage.locator('#editBtn').click();
await racePage.locator('#pid').fill('Kimchi');
const unchangedMarch = await racePage.locator('#marchRange').inputValue();
await racePage.locator('#saveBtn').click();
await racePage.locator('#youName').filter({ hasText: 'Kimchi' }).waitFor({ timeout: 8000 });

for (const openPage of [racePage, abortPage]) {
  await openPage.waitForFunction(({ pid, name }) => {
    const row = document.querySelector(`#roster .roster-row[data-pid="${pid}"] .roster-name`);
    const laneNames = Array.from(document.querySelectorAll('#lanes .lname')).map(node => node.textContent);
    return row && row.textContent === name && laneNames.some(value => value.includes(name)) &&
      laneNames.every(value => !value.includes('Race Captain'));
  }, { pid: raceProfile.pid, name: 'Kimchi' }, { timeout: 8000 });
}
assert.equal(await racePage.locator('#marchRange').inputValue(), unchangedMarch);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
node --test test/map-render-key.test.cjs
BASE=http://127.0.0.1:8791 node test/identity-input.e2e.cjs
```

Expected: the unit test fails because `mapRenderKey` does not exist; the browser test reaches canonical `Kimchi` but times out because an already-open idle lane still displays the prior name.

---

### Task 2: Canonical idle tactical invalidation

**Files:**
- Modify: `public/kvk.js`
- Test: `test/map-render-key.test.cjs`
- Test: `test/identity-input.e2e.cjs`

**Interfaces:**
- Produces: `mapRenderKey(data): string`.
- `data.live === true` produces `live-<command id>`.
- Idle data produces a deterministic signature of `[pid, displayedName, march, role, mine]` per actor.

- [ ] **Step 1: Re-run GitNexus impact immediately before the edit**

Run upstream impact for `syncMap` in `public/kvk.js`, include tests, and retain the HIGH-risk warning in the work log. Inspect direct callers `tick` and `onState`; do not expand the change into either caller.

- [ ] **Step 2: Implement the minimal render-key helper**

Add directly before `syncMap()`:

```js
function mapRenderKey(data) {
  if (data.live) return "live-" + data.id;
  return "idle-" + JSON.stringify(data.actors.map(function (actor) {
    return [actor.pid, actor.name || actor.pid, actor.march, actor.role, !!actor.mine];
  }));
}
```

Replace only the existing inline key expression:

```js
var key = mapRenderKey(d);
```

- [ ] **Step 3: Run the focused tests and verify GREEN**

Run:

```bash
node --test test/map-render-key.test.cjs
BASE=http://127.0.0.1:8791 node test/identity-input.e2e.cjs
```

Expected: PASS; both pages show `Kimchi` while the unchanged march remains unchanged, and live keys remain command-ID based.

---

### Task 3: Coherent forced-refresh client generation

**Files:**
- Modify: `public/kvk.html`
- Modify: `public/kvk-update.js`
- Modify: `public/kvk-rally.js`
- Modify: `src/client-build.js`
- Modify: `test/classic-delivery-client.test.cjs`
- Modify: `test/client-build.test.cjs`
- Modify: `test/delivery-browser-wiring.test.cjs`
- Modify: `test/identity-input.e2e.cjs`
- Modify: `test/kvk-rally-client.test.cjs`
- Modify: `test/kvk-rally-wiring.test.cjs`
- Modify: `test/kvk-update-wiring.test.cjs`
- Modify: `test/kvk-update.test.cjs`
- Modify: `test/march-sync.e2e.cjs`
- Modify: `test/player-removal.e2e.cjs`
- Modify: `test/roster-control.e2e.cjs`
- Modify: `test/triple-room.test.cjs`
- Modify: `test/worker-build.test.cjs`

**Interfaces:**
- Produces coherent generation `2026071504` in HTML asset URLs, updater, rally adapter, worker build metadata, minimum accepted KvK build, minimum Triple build, and exact test fixtures.

- [ ] **Step 1: Change exact build expectations first and verify RED**

Replace exact `2026071503` expectations under `test/` with `2026071504`, then run:

```bash
node --test test/client-build.test.cjs test/worker-build.test.cjs test/kvk-update.test.cjs test/kvk-update-wiring.test.cjs test/kvk-rally-client.test.cjs test/kvk-rally-wiring.test.cjs test/classic-delivery-client.test.cjs test/delivery-browser-wiring.test.cjs
```

Expected: FAIL because product constants and HTML URLs still advertise `2026071503`.

- [ ] **Step 2: Advance all product build constants and first-party asset URLs atomically**

Set:

```js
CURRENT_KVK_BUILD = 2026071504
MIN_KVK_BUILD = 2026071504
MIN_TRIPLE_BUILD = 2026071504
KvkUpdate.BUILD = 2026071504
KvkRally.BUILD = 2026071504
```

Use `?v=2026071504` for every first-party CSS/JavaScript asset in `public/kvk.html`. Do not change room-mode feature flags.

- [ ] **Step 3: Run the build/update suites and verify GREEN**

Run the command from Step 1.

Expected: PASS with one coherent generation and a forced-refresh floor of `2026071504`.

---

### Task 4: Full verification, release, and production proof

**Files:**
- Modify only if a test exposes a defect directly caused by Tasks 1–3.

**Interfaces:**
- Consumes all prior tasks.
- Produces committed and pushed source, a Cloudflare deployment, and production evidence from an isolated generated QA room.

- [ ] **Step 1: Run static and unit suites**

Run:

```bash
npm test
npm run test:triple
npm run test:delivery
```

Expected: all tests pass, including the new render-key test.

- [ ] **Step 2: Run focused browser suites against the local Worker**

Run:

```bash
BASE=http://127.0.0.1:8791 node test/identity-input.e2e.cjs
BASE=http://127.0.0.1:8791 node test/roster-control.e2e.cjs
BASE=http://127.0.0.1:8791 node test/march-sync.e2e.cjs
npm run test:kvk-core
```

Expected: all tests pass; identity-name settlement repaints both already-open idle tactical views, while Double/Triple command snapshots remain stable.

- [ ] **Step 3: Inspect and commit the expected scope**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Stage only the tactical refresh, tests, build generation, spec, and plan. Run `gitnexus_detect_changes(scope: "staged")`, review the reported HIGH `syncMap` scope, then commit with:

```bash
git commit -m "fix: refresh kvk tactical player names"
```

- [ ] **Step 4: Deploy and verify production metadata**

Push the verified branch, deploy the Worker, and verify:

```text
/api/build.currentBuild = 2026071504
/api/build.minKvkBuild = 2026071504
/api/build.minTripleBuild = 2026071504
tripleEnabled = true
```

Retain the immediately previous Cloudflare version ID for rollback.

- [ ] **Step 5: Run production multi-page proof**

In a new generated QA room on `https://kingshoter.com`, open an owner and observer before the edit, register `Ff` at 34 seconds, change only the name to `Kimchi`, and assert:

```text
owner chip = Kimchi
owner tactical lane = Kimchi
observer tactical lane = Kimchi
commander roster = Kimchi
march = 34 seconds on every page
no stale Ff remains
```

Also verify Double/Triple mode controls remain visible and an already-fired command continues to use its persisted snapshot.
