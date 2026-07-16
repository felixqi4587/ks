# KvK Mobile Homepage Conservative Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved mobile Attack homepage so it shows only the two kingdoms' canonical selected captains, preserves every current timeline font and progress bar, and gives the lower castle battlefield meaningful space without enlarging the castle.

**Architecture:** Keep the existing `onState() → syncMap()` rendering pipeline and immutable live-command behavior. Change only the idle tactical projection, idle render signature, grouped lane markup, radar geometry, and KvK-specific responsive CSS/HTML; use canonical staged state already broadcast to every room device. Protect the high-frequency map chain with source-level unit tests and an isolated multi-device Playwright scenario before advancing the complete client build generation.

**Tech Stack:** Browser JavaScript, HTML/CSS/SVG, Cloudflare Workers/Durable Objects, WebSocket room snapshots, Node `node:test`, Playwright Chromium/Firefox/WebKit, GitNexus.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-15-kvk-mobile-homepage-conservative-layout-design.md` exactly.
- Scope is only the ordinary-player Attack homepage and the same homepage while Commander Console is closed.
- Preserve `var(--font)` and `var(--mono)`; player name `13px/800`, current player `13px/900`, time `15px/900`, track `30px`, idle dot `16px`, travelling dot `17px` at every supported width.
- Show only server-confirmed staged captains in idle state, grouped Kingdom 1 then Kingdom 2, canonical role order, at most three per kingdom and six total.
- Keep the idle domain exactly 120 seconds with four 30-second regions.
- Keep `activeCommand()` selection and every fired command field immutable; do not combine two live commands.
- Keep `window.ksCastle()` unchanged; enlarge battlefield space and distance geometry, not the castle.
- Do not change status-light meaning, audio, countdown, lead time, Fire, delivery, WebSocket, persistence, password, Defense, Commander drawer, Players, Room, or kingdom-name editing.
- Use only generated `qa-kvk-*` rooms for browser mutation tests.
- Do not deploy; produce a locally verified branch and test page.
- Before editing each existing JavaScript function, run GitNexus upstream impact. The known map chain risk is HIGH, while `ringR` is CRITICAL; do not expand edits beyond the listed functions.
- Before every commit, run `gitnexus_detect_changes(scope: "all")` and inspect the affected processes.

---

### Task 1: Lock the approved tactical behavior with failing tests

**Files:**
- Create: `test/kvk-home-layout.test.cjs`
- Modify: `test/map-render-key.test.cjs`
- Modify: `test/qa-kvk-triple.spec.cjs`
- Modify: `test/march-domain.e2e.cjs`

**Interfaces:**
- Consumes future `mapData(): { live, actors, groups }` where each group is `{ kingdom, mode, required, actors }`.
- Consumes future idle `mapRenderKey(data)` signature containing kingdom, rally mode, role, canonical display name, march, and `mine`.
- Browser invariant: `#lanes` contains exactly two non-empty `.lane-group` elements and no more than six `.lane` elements.

- [ ] **Step 1: Create the focused source-level projection tests**

Create `test/kvk-home-layout.test.cjs` with the repository's existing brace-aware `extractFunction(name)` helper. Evaluate `mapData`, `domainFor`, and `ringR` in a VM harness containing:

```js
const room = {
  players: Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
    const pid = `captain-${index + 1}`;
    return [pid, { name: `Captain ${index + 1}`, march: 20 * (index + 1) }];
  })),
  rallyModes: {
    1: { mode: 'triple', revision: 1 },
    2: { mode: 'triple', revision: 1 }
  },
  live: { commands: { 1: null, 2: null }, staged: { 1: null, 2: null } }
};

const serverStagedByK = {
  1: [
    { pid: 'captain-1', name: 'Captain 1', march: 20, role: 'weak' },
    { pid: 'captain-2', name: 'Captain 2', march: 40, role: 'weak2' },
    { pid: 'captain-3', name: 'Captain 3', march: 60, role: 'main' }
  ],
  2: [
    { pid: 'captain-4', name: 'Captain 4', march: 80, role: 'weak' },
    { pid: 'captain-5', name: 'Captain 5', march: 100, role: 'weak2' },
    { pid: 'captain-6', name: 'Captain 6', march: 120, role: 'main' }
  ]
};
```

Assert:

```js
assert.deepEqual(plain(data.groups.map(group => ({
  kingdom: group.kingdom,
  mode: group.mode,
  required: group.required,
  pids: group.actors.map(actor => actor.pid),
  roles: group.actors.map(actor => actor.role)
}))), [
  { kingdom: 1, mode: 'triple', required: 3,
    pids: ['captain-1', 'captain-2', 'captain-3'], roles: ['weak', 'weak2', 'main'] },
  { kingdom: 2, mode: 'triple', required: 3,
    pids: ['captain-4', 'captain-5', 'captain-6'], roles: ['weak', 'weak2', 'main'] }
]);
assert.deepEqual(plain(data.actors.map(actor => actor.pid)), [
  'captain-1', 'captain-2', 'captain-3', 'captain-4', 'captain-5', 'captain-6'
]);
assert.equal(data.actors.some(actor => actor.pid === 'captain-7' || actor.pid === 'captain-8'), false);
assert.equal(domainFor([20, 120], false), 120);
assert.equal(ringR(120, 120), 180);
assert.ok(ringR(5, 120) >= 48);
```

Add a live characterization using a frozen Triple command and assert the result still contains only the command pairs, their original names/marches/roles, and a single group for the command kingdom.

- [ ] **Step 2: Extend the idle render-key regression**

Change the idle fixtures in `test/map-render-key.test.cjs` to include one group and assert that changing only the group kingdom or mode changes the key, while the existing live command-ID assertions remain unchanged:

```js
const base = {
  live: false,
  actors: [{ pid: 'route-a', name: 'Ff', march: 34, role: 'weak', mine: true, kingdom: 1 }],
  groups: [{
    kingdom: 1, mode: 'double', required: 2,
    actors: [{ pid: 'route-a', name: 'Ff', march: 34, role: 'weak', mine: true, kingdom: 1 }]
  }]
};
assert.notEqual(key(base), key({ ...base, groups: [{ ...base.groups[0], mode: 'triple', required: 3 }] }));
assert.notEqual(key(base), key({ ...base, groups: [{ ...base.groups[0], kingdom: 2 }] }));
```

- [ ] **Step 3: Add the isolated ordinary-player homepage browser test**

Add a Playwright test named `ordinary-player homepage preserves typography while showing six selected captains` to `test/qa-kvk-triple.spec.cjs`. Reuse `ensureCanonicalProfile`, `openActor`, `unlock`, `roomState`, and `expectNoHorizontalOverflow`.

The test must:

1. Seed eight profiles with marches `[20, 40, 60, 80, 100, 120, 30, 50]`.
2. Open one commander device and one ordinary viewer device that never unlocks Commander Console.
3. Set Kingdom 1 and Kingdom 2 to Triple and stage three unique captains in each.
4. Wait for both canonical staged records.
5. Assert exactly six `.lane` rows, two `.lane-group` sections, selected names only, no `+N`, six `.ltrack` elements, and six right-side times.
6. Assert idle marker positions `[16.67, 33.33, 50, 66.67, 83.33, 96]` within `0.2%`.
7. Assert `#cmdGate` is visible and `#console` is hidden on the viewer.
8. At widths `320`, `375`, `390`, and `430`, call `expectNoHorizontalOverflow` for `#roomView`, `#situation`, `#lanes`, `.lane-group`, `.lane`, and `.pond`.
9. At widths `320` and `390`, assert computed `.lname` is `13px/800`, `.ltimev` is `15px/900`, `.ltrack` is `30px`, and `--font` still contains `ui-rounded`.
10. Assert the battlefield is `258 ± 2px` at 320px and `270 ± 2px` at 390px.
11. Assert the castle body's SVG attributes remain `width="40" height="32"` and six `.rally-dot` groups are present.
12. Assert every rally dot center is farther than 48 SVG units from `(180,68)` and all page errors remain empty.

- [ ] **Step 4: Update the existing march-domain setup, not its assertions**

After registering the three existing march-domain profiles, send canonical staged frames before waiting for lanes:

```js
{ t: 'stage', password, staged: { kingdom: 1, modeRevision: 0, pairs: [
  { pid: players[0].pid, role: 'weak' },
  { pid: players[1].pid, role: 'main' }
] } },
{ t: 'stage', password, staged: { kingdom: 2, modeRevision: 0, pairs: [
  { pid: players[2].pid, role: 'weak' }
] } }
```

Keep its existing fixed-scale and live-command assertions intact.

- [ ] **Step 5: Run the focused tests and verify RED**

Run:

```bash
node --test test/kvk-home-layout.test.cjs test/map-render-key.test.cjs
npm run test:qa:triple -- --project=chromium -g "ordinary-player homepage"
```

Expected: projection/group/render-key tests fail because idle `mapData()` still emits all room players without groups; browser assertions fail because the page has no kingdom groups and the radar remains approximately 140–200px high.

- [ ] **Step 6: Commit the failing regression tests**

Run GitNexus change detection, then commit only the four Task 1 test files:

```bash
git add test/kvk-home-layout.test.cjs test/map-render-key.test.cjs test/qa-kvk-triple.spec.cjs test/march-domain.e2e.cjs
git commit -m "test: lock conservative KvK mobile homepage"
```

---

### Task 2: Project canonical staged captains and render kingdom groups

**Files:**
- Modify: `public/kvk.js`
- Test: `test/kvk-home-layout.test.cjs`
- Test: `test/map-render-key.test.cjs`

**Interfaces:**
- Produces `mapData().groups` in stable kingdom order.
- Produces a deterministic idle `mapRenderKey(data)` from group and actor display fields.
- Produces `.lane-group.kingdom-1` and `.lane-group.kingdom-2` markup with no overflow row.

- [ ] **Step 1: Re-run GitNexus impact for the exact production symbols**

Run upstream impact with tests for `mapData`, `renderLanes`, and `mapRenderKey`. Confirm direct callers remain limited to `syncMap`/`renderLanes` and do not edit `tick`, `onState`, `wireRoom`, `activeCommand`, or `laneRow`.

- [ ] **Step 2: Implement the minimal idle projection**

In `mapData()`:

- Preserve the existing active-command branch and add only `kingdom` plus one matching group to its return value.
- Replace the idle `Object.keys(room.players)` projection with `[1, 2]` mapped from `serverStagedByK`.
- Normalize each staged group to the current mode, canonical role order `weak`, `weak2`, `main`, and a maximum of the mode's required count.
- Flatten the groups into `actors` without global march sorting.
- Copy canonical `pid`, `name`, `march`, `role`, `mine`, and `kingdom` into every actor.

The return shape must be:

```js
{
  live: false,
  actors: groups.reduce(function (all, group) { return all.concat(group.actors); }, []),
  groups: groups
}
```

- [ ] **Step 3: Render compact kingdom headers around existing lane rows**

In `renderLanes(data)`, iterate `data.groups` and wrap each non-empty group:

```html
<section class="lane-group kingdom-1">
  <div class="lane-group-head">
    <span>Kingdom ①</span>
    <small>Triple Rally · 3/3</small>
  </div>
  <!-- existing laneRow() output -->
</section>
```

Use `tk("kw" + kingdom)` and the existing `mode_double` / `mode_triple` translations. Pass one monotonically increasing actor index to the unchanged `laneRow()` so live `mapS.lanes` indexes remain aligned with `data.actors`. Delete the `+N` overflow-row branch.

- [ ] **Step 4: Sign every displayed idle group field**

Change only the idle branch of `mapRenderKey(data)`:

```js
var groups = data.groups && data.groups.length ? data.groups : [{ kingdom: 0, mode: "", actors: data.actors || [] }];
return "idle-" + JSON.stringify(groups.map(function (group) {
  return [group.kingdom, group.mode, group.required, group.actors.map(function (actor) {
    return [actor.pid, actor.name || actor.pid, actor.march, actor.role, !!actor.mine, actor.kingdom];
  })];
}));
```

Keep `if (data.live) return "live-" + data.id;` unchanged.

- [ ] **Step 5: Run the focused unit tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern="tactical projection|render key" test/kvk-home-layout.test.cjs test/map-render-key.test.cjs
```

Expected: PASS; idle state contains only the six selected captains in stable kingdom/role order and live state remains frozen to the command. The separately named battlefield-geometry test remains RED until Task 3 and is intentionally excluded at this checkpoint.

- [ ] **Step 6: Commit the projection and grouping implementation**

Run GitNexus change detection, then:

```bash
git add public/kvk.js
git commit -m "feat: group selected captains on KvK homepage"
```

---

### Task 3: Enlarge the battlefield without changing typography or castle scale

**Files:**
- Modify: `public/kvk.html`
- Modify: `public/app.css`
- Modify: `public/kvk.js`
- Test: `test/kvk-home-layout.test.cjs`
- Test: `test/qa-kvk-triple.spec.cjs`

**Interfaces:**
- `#radar` view box becomes `0 0 360 270`.
- `ringR(120, 120) === 180` and `ringR(5, 120) >= 48`.
- Ordinary closed homepage battlefield is 270px, or 258px at widths up to 360px.
- Commander mode retains the existing compact battlefield height.

- [ ] **Step 1: Re-run GitNexus impact for radar geometry**

Run upstream impact with tests for `renderRadar` and `ringR`. Record the CRITICAL `ringR` warning, verify `renderRadar` is its only direct caller, and do not edit `mapFrame` or `window.ksCastle`.

- [ ] **Step 2: Update only the KvK wrapper and radar view box**

In `public/kvk.html`:

```html
<div class="wrap kvk-wrap">
```

and:

```html
<svg viewBox="0 0 360 270" id="radar"></svg>
```

Do not change any font or castle markup.

- [ ] **Step 3: Add the conservative responsive layout rules**

In `public/app.css`:

```css
.lane-group{margin:0 0 8px}
.lane-group:last-child{margin-bottom:2px}
.lane-group-head{display:flex;align-items:center;gap:6px;min-height:28px;padding:0 8px;border-radius:9px;font:900 10px/1 var(--font)}
.lane-group-head small{margin-left:auto;font:800 9px/1 var(--font)}
.lane-group.kingdom-1 .lane-group-head{background:var(--mint-bg);color:var(--mint-deep)}
.lane-group.kingdom-2 .lane-group-head{background:#eef0fb;color:#5963a6}
.lane .ltrack.idle{background:repeating-linear-gradient(90deg,#eafaf7 0 calc(25% - 1px),#cfeae3 calc(25% - 1px) 25%)}
.situation{padding:10px}
.situation .pond{flex:0 0 270px;height:270px;min-height:270px;margin-top:10px}
.situation .pond svg{width:100%;height:270px;max-height:none}
body.cmdmode .situation .pond{flex-basis:200px;height:200px;min-height:140px}
body.cmdmode .situation .pond svg{height:200px;max-height:200px}
@media(max-width:430px){.kvk-wrap{padding-left:10px;padding-right:10px}}
@media(max-width:360px){
  .kvk-wrap{padding-left:7px;padding-right:7px}
  .lane{grid-template-columns:76px minmax(0,1fr) 48px;gap:6px}
  .situation .pond{flex-basis:258px;height:258px;min-height:258px}
  .situation .pond svg{height:258px}
}
```

Preserve the existing `.lname`, `.ltimev`, `.ltrack`, and `.ldot` font/size declarations unchanged. Consolidate the existing `.lane .ltrack.idle` rule rather than adding a competing duplicate.

- [ ] **Step 4: Give radar distance the approved meaning**

Keep `CX = 180`, set `CY = 68`, and change only `ringR()` to:

```js
function ringR(seconds, domain) {
  return 48 + Math.min(seconds, domain) / domain * 132;
}
```

Add a pure stable angle helper:

```js
function radarAngle(actor, index, count) {
  var roleIndex = actor.role === "weak2" ? 1 : actor.role === "main" ? 2 : 0;
  var degrees = actor.kingdom === 1 ? [135, 120, 105][roleIndex]
    : actor.kingdom === 2 ? [45, 60, 75][roleIndex]
      : count > 1 ? 45 + 90 * index / (count - 1) : 90;
  return degrees * Math.PI / 180;
}
```

In `renderRadar()`:

- Use `radarAngle(actor, index, count)`.
- Add one dashed SVG route from `(CX, CY)` to each actor's initial position.
- Give every actor group class `rally-dot kingdom-<n>`.
- Use mint for Kingdom 1 and muted violet `#6571ba` for Kingdom 2 while retaining filled Main versus outlined Sacrifice dots.
- Append `window.ksCastle(svg, CX, CY, "neutral")` after routes/dots so travelling dots naturally disappear behind the unchanged castle at landing.
- Move empty text and legend down within the 270-unit view box; use a legend baseline near `258`.

Do not change the `mapFrame()` distance formula; it continues to move every dot inward along the same angle using the same `r0` and command clock.

- [ ] **Step 5: Change only the truthful empty-state wording**

Update the two `mapempty` translations to indicate that the commander has not selected rally captains yet. Keep the existing copy-room-link action and all other copy unchanged.

- [ ] **Step 6: Run focused unit and browser tests and verify GREEN**

Run:

```bash
node --test test/kvk-home-layout.test.cjs test/map-render-key.test.cjs
npm run test:qa:triple -- --project=chromium -g "ordinary-player homepage"
```

Expected: PASS with two groups, six rows, exact current typography, four scale regions, a 270/258px battlefield, unchanged castle attributes, meaningful dot distances, and no horizontal overflow.

- [ ] **Step 7: Commit the conservative layout**

Run GitNexus change detection, then:

```bash
git add public/kvk.html public/app.css public/kvk.js
git commit -m "feat: enlarge KvK mobile tactical battlefield"
```

---

### Task 4: Advance one coherent forced-refresh build

**Files:**
- Modify: `public/kvk.html`
- Modify: `public/kvk-update.js`
- Modify: `public/kvk-rally.js`
- Modify: `src/client-build.js`
- Modify all exact `2026071504` expectations under `test/`

**Interfaces:**
- Produces coherent generation `2026071505` in HTML asset URLs, updater, rally adapter, worker current/minimum build metadata, Triple floor, WebSocket fixtures, and exact tests.

- [ ] **Step 1: Change exact build expectations first and verify RED**

Replace exact `2026071504` test expectations with `2026071505`, then run:

```bash
node --test test/client-build.test.cjs test/worker-build.test.cjs test/kvk-update.test.cjs test/kvk-update-wiring.test.cjs test/kvk-rally-client.test.cjs test/kvk-rally-wiring.test.cjs test/classic-delivery-client.test.cjs test/delivery-browser-wiring.test.cjs
```

Expected: FAIL because product constants and HTML first-party asset URLs still advertise `2026071504`.

- [ ] **Step 2: Advance product constants and first-party URLs atomically**

Set:

```js
CURRENT_KVK_BUILD = 2026071505
MIN_KVK_BUILD = 2026071505
MIN_TRIPLE_BUILD = 2026071505
KvkUpdate.BUILD = 2026071505
KvkRally.BUILD = 2026071505
```

Use `?v=2026071505` for every first-party CSS/JavaScript asset in `public/kvk.html`. Do not change feature flags or room selection.

- [ ] **Step 3: Run build/update tests and verify GREEN**

Re-run the Step 1 command.

Expected: PASS with one coherent current/minimum generation.

- [ ] **Step 4: Commit the build generation**

Run GitNexus change detection, then stage only files containing the intentional exact build replacement and commit:

```bash
git commit -m "chore: advance KvK client build to 2026071505"
```

---

### Task 5: Full local verification and review

**Files:**
- Modify only if a failing test exposes a defect caused by Tasks 1–4.

**Interfaces:**
- Produces a reviewed local branch and a local test URL in a generated QA room.

- [ ] **Step 1: Run all static and focused suites**

Run:

```bash
npm test
npm run test:triple
npm run test:delivery
```

Expected: all Node tests pass with no warnings or failures.

- [ ] **Step 2: Run browser coverage**

Run:

```bash
npm run test:qa:triple -- --project=chromium
npm run test:qa:triple
```

Expected: the complete Triple QA suite passes first in Chromium and then Chromium/Firefox/WebKit. Every room name is generated `qa-kvk-*`.

- [ ] **Step 3: Run focused existing regressions against the local Worker**

With a local Worker on `http://127.0.0.1:8791`, run:

```bash
BASE=http://127.0.0.1:8791 node test/march-domain.e2e.cjs
BASE=http://127.0.0.1:8791 node test/roster-control.e2e.cjs
BASE=http://127.0.0.1:8791 node test/march-sync.e2e.cjs
npm run test:kvk-core
```

Expected: fixed 120-second idle positions, live landing geometry, staged selection convergence, commander controls, personal countdowns, audio, and delivery behavior all remain unchanged.

- [ ] **Step 4: Inspect graph and diff scope**

Run `gitnexus_detect_changes(scope: "compare", base_ref: "67d7c2a")`. Confirm only the tactical homepage projection/rendering, its tests, documentation, and coherent build-generation files are affected. Inspect `git diff --check`, `git status --short`, and the complete branch diff while leaving `.superpowers/` and parent user-owned files untracked.

- [ ] **Step 5: Request task and whole-branch code review**

Review against the approved spec with particular attention to:

- no font shrink at 320px;
- no registered unselected players on idle homepage;
- no seventh `+N` row;
- no mutation of live command selection or payload;
- no castle enlargement;
- no audio, countdown, Fire, delivery, or protocol changes;
- no horizontal overflow;
- no production-room browser mutation.

Fix every Critical or Important finding and rerun its covering tests.

- [ ] **Step 6: Start a local review page**

Start the Worker locally and create a generated QA room containing two staged Triple groups. Open the ordinary-player viewer at:

```text
http://127.0.0.1:8791/kvk?room=<generated-qa-kvk-room>&notour=1&lang=en&__kvk_build=2026071505
```

Leave production undeployed and hand the local URL to the user for visual review.
