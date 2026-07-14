# Optional Triple Rally and Forced Client Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a room-synchronized, per-kingdom Triple Rally mode with two simultaneous Sacrifice landings, Main one second later, automatic stale-client updates, and no regression to default Double Rally.

**Architecture:** Keep canonical `double_rally` storage and its existing target formula unchanged. Add small pure modules for mode transitions, Triple target construction, and client-build projection; integrate them at the Durable Object boundary, then extend the existing UI and shared personal-cue engine to recognize `triple_rally`. A global gate stays off through updater bootstrap and QA, while old sockets receive a per-socket compatibility projection without changing canonical room state.

**Tech Stack:** Cloudflare Workers and Durable Objects, browser JavaScript, WebSocket Hibernation attachments, Node.js `node:test`, Playwright, HTML/CSS.

## Global Constraints

- Complete `docs/superpowers/plans/2026-07-13-kvk-core-player-control.md` and `docs/superpowers/plans/2026-07-13-kvk-reliable-delivery-qa.md` before this plan.
- Double is the default for missing, malformed, new, and existing room mode state.
- Kingdom 1 and Kingdom 2 modes persist and synchronize independently.
- Triple roles are exactly `weak`, `weak2`, and `main`; all PIDs are unique and canonical.
- Sacrifice 1 and Sacrifice 2 land at the same time; Main lands exactly one second later.
- Each captain's countdown begins at exactly the selected 10, 15, 30, or 60 seconds before that captain's own `pressUTC`.
- Ordinary members receive one generic JOIN cue; an unselected commander receives no rally audio; a selected commander receives their personal cue.
- Do not change `fireDouble()` target arithmetic.
- Do not assign ordinary members to rally vehicles or add configurable rally counts/gaps.
- All automated tests use unique `qa-kvk-*` rooms. Every non-QA room is an operation room; no code may special-case `1406`.
- `TRIPLE_RALLY_ENABLED` stays `"0"` until the local, multi-browser, and physical-device gates pass. `TRIPLE_RALLY_QA_ENABLED="1"` may expose Triple only to generated `qa-kvk-*` rooms while the global gate is off.
- Run GitNexus upstream impact before editing every existing function/method. Report HIGH or CRITICAL results to the user before editing.
- Before every commit, stage only that task and run `gitnexus_detect_changes({repo:"kingshot", scope:"staged"})`; review all affected flows before committing.
- Preserve all unrelated dirty-worktree content. Stage only files named by the current task.

## File and Interface Map

**Create:**

- `kingshoter/src/rally-mode.js` — pure rally-mode normalization, transitions, and staged-pair validation.
- `kingshoter/src/rally-targets.js` — canonical Triple target and command construction.
- `kingshoter/src/client-build.js` — build metadata parsing and per-socket legacy projection.
- `kingshoter/public/kvk-rally.js` — browser/Node shared rally predicates, personal target lookup, role order, and selection reconciliation.
- `kingshoter/public/kvk-update.js` — testable forced-update controller.
- `kingshoter/test/rally-mode.test.cjs`
- `kingshoter/test/rally-targets.test.cjs`
- `kingshoter/test/client-build.test.cjs`
- `kingshoter/test/kvk-rally-client.test.cjs`
- `kingshoter/test/kvk-update.test.cjs`
- `kingshoter/test/triple-room.test.cjs`
- `kingshoter/test/fixtures/kvk-legacy-target.cjs`
- `kingshoter/test/qa-kvk-triple.spec.cjs`
- `kingshoter/playwright.qa-kvk-triple.config.cjs`
- `docs/operations/kvk-triple-rollout.md`

**Modify:**

- `kingshoter/src/worker.js` — serve uncached build metadata.
- `kingshoter/src/room.js` — persist modes, validate mode revisions, create Triple commands, and project state by socket build.
- `kingshoter/public/app.js` — add the current build to WebSocket URLs while preserving the core plan's generic message callback.
- `kingshoter/public/kvk.html` — load the shared modules and add mode/update controls.
- `kingshoter/public/kvk.js` — reconcile canonical mode, render/select three roles, Fire Triple, and route both types through one cue engine.
- `kingshoter/public/app.css` — mode switch, update gate, and three vertical role rows.
- `kingshoter/wrangler.toml` — merge `TRIPLE_RALLY_ENABLED = "0"` and `TRIPLE_RALLY_QA_ENABLED = "1"` into one bootstrap `[vars]` section.
- `kingshoter/package.json` — add focused Triple unit and QA commands.
- `kingshoter/test/command-scope.test.cjs` — preserve removed counter-rally scope while accepting optional Triple.
- `kingshoter/test/lead-timing.cjs` — retain the complete Double lead matrix.

---

### Task 1: Pure Per-Kingdom Rally Mode State

**Files:**
- Create: `kingshoter/src/rally-mode.js`
- Create: `kingshoter/test/rally-mode.test.cjs`

**Interfaces:**
- Consumes: plain room `players`, `live.staged`, serialized `rallyModes` values, core `normalizeRoutingKey(value)`, and Reliable `isQaRoomName(room)`.
- Produces: `newRallyModes()`, `normalizeRallyModes(value)`, `transitionRallyMode(state, input)`, `disableTripleModes(state)`, `validateStagedPairs(input)`, and `isTripleAllowed(env, roomName)`.

- [ ] **Step 1: Write the failing mode-domain tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function load() {
  return import(`${pathToFileURL(path.join(__dirname, '../src/rally-mode.js')).href}?t=${Date.now()}`);
}

test('missing state defaults both kingdoms to independent Double revision zero', async () => {
  const { normalizeRallyModes } = await load();
  assert.deepEqual(normalizeRallyModes(null), {
    1: { mode: 'double', revision: 0 },
    2: { mode: 'double', revision: 0 }
  });
});

test('Triple to Double atomically drops only weak2 from that kingdom', async () => {
  const { transitionRallyMode } = await load();
  const result = transitionRallyMode({
    rallyModes: { 1: { mode: 'triple', revision: 4 }, 2: { mode: 'double', revision: 2 } },
    staged: {
      1: { kingdom: 1, pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }] },
      2: { kingdom: 2, pairs: [{ pid: 'd', role: 'weak' }] }
    }
  }, { kingdom: 1, mode: 'double', baseRevision: 4 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rallyModes[1], { mode: 'double', revision: 5 });
  assert.deepEqual(result.staged[1].pairs, [{ pid: 'a', role: 'weak' }, { pid: 'c', role: 'main' }]);
  assert.deepEqual(result.staged[2].pairs, [{ pid: 'd', role: 'weak' }]);
});

test('a stale mode or stage revision never overwrites current state', async () => {
  const { transitionRallyMode, validateStagedPairs } = await load();
  const modes = { 1: { mode: 'triple', revision: 7 }, 2: { mode: 'double', revision: 0 } };
  assert.deepEqual(transitionRallyMode({ rallyModes: modes, staged: { 1: null, 2: null } }, {
    kingdom: 1, mode: 'double', baseRevision: 6
  }), { ok: false, error: 'rally_mode_conflict', record: { mode: 'triple', revision: 7 } });
  assert.equal(validateStagedPairs({
    modeRecord: modes[1], modeRevision: 6, pairs: [], players: {}
  }).error, 'rally_mode_conflict');
});

test('the emergency gate normalizes both modes and staged weak2 without touching commands', async () => {
  const { disableTripleModes } = await load();
  const result = disableTripleModes({
    rallyModes: { 1: { mode: 'triple', revision: 2 }, 2: { mode: 'triple', revision: 9 } },
    staged: {
      1: { kingdom: 1, pairs: [{ pid: 'a', role: 'weak2' }, { pid: 'b', role: 'main' }] },
      2: null
    }
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.rallyModes, {
    1: { mode: 'double', revision: 3 }, 2: { mode: 'double', revision: 10 }
  });
  assert.deepEqual(result.staged[1].pairs, [{ pid: 'b', role: 'main' }]);
});

test('partial Triple staging accepts unique allowed roles and rejects duplicates', async () => {
  const { validateStagedPairs } = await load();
  const players = { a: {}, b: {}, c: {} };
  assert.deepEqual(validateStagedPairs({
    modeRecord: { mode: 'triple', revision: 3 }, modeRevision: 3,
    pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }], players
  }), { ok: true, pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }] });
  assert.equal(validateStagedPairs({
    modeRecord: { mode: 'triple', revision: 3 }, modeRevision: 3,
    pairs: [{ pid: 'a', role: 'weak' }, { pid: 'a', role: 'main' }], players
  }).error, 'invalid_rally_roster');
});

test('staging uses the core routing-key policy and rejects reserved or malformed PIDs', async () => {
  const { validateStagedPairs } = await load();
  const players = Object.create(null);
  players.valid_1 = {};
  for (const pid of ['__proto__', 'constructor', 'has space', 'bad!']) {
    assert.equal(validateStagedPairs({
      modeRecord: { mode: 'triple', revision: 1 }, modeRevision: 1,
      pairs: [{ pid, role: 'weak' }], players
    }).error, 'invalid_rally_roster', pid);
  }
  assert.deepEqual(validateStagedPairs({
    modeRecord: { mode: 'triple', revision: 1 }, modeRevision: 1,
    pairs: [{ pid: ' valid_1 ', role: 'weak' }], players
  }), { ok: true, pairs: [{ pid: 'valid_1', role: 'weak' }] });
});

test('QA gate never enables an operation room and the global gate enables all rooms', async () => {
  const { isTripleAllowed } = await load();
  const qaOnly = { TRIPLE_RALLY_ENABLED: '0', TRIPLE_RALLY_QA_ENABLED: '1' };
  assert.equal(isTripleAllowed(qaOnly, 'qa-kvk-chromium-42'), true);
  assert.equal(isTripleAllowed(qaOnly, 'operation-room'), false);
  assert.equal(isTripleAllowed(qaOnly, 'practice-room'), false);
  assert.equal(isTripleAllowed({ TRIPLE_RALLY_ENABLED: '1' }, 'operation-room'), true);
});
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/rally-mode.test.cjs`

Expected: FAIL with `ENOENT` for `src/rally-mode.js`.

- [ ] **Step 3: Implement the complete pure mode module**

```js
import { normalizeRoutingKey } from './room-player.js';
import { isQaRoomName } from './delivery.js';

const MODE_SET = new Set(['double', 'triple']);
const ROLES = {
  double: new Set(['weak', 'main']),
  triple: new Set(['weak', 'weak2', 'main'])
};

const record = (value) => ({
  mode: MODE_SET.has(value && value.mode) ? value.mode : 'double',
  revision: Number.isInteger(value && value.revision) && value.revision >= 0 ? value.revision : 0
});

export function newRallyModes() {
  return { 1: { mode: 'double', revision: 0 }, 2: { mode: 'double', revision: 0 } };
}

export function isTripleAllowed(env, roomName) {
  if (env && env.TRIPLE_RALLY_ENABLED === '1') return true;
  return Boolean(
    env && env.TRIPLE_RALLY_QA_ENABLED === '1' &&
    isQaRoomName(roomName)
  );
}

export function normalizeRallyModes(value) {
  return { 1: record(value && value[1]), 2: record(value && value[2]) };
}

export function transitionRallyMode(state, input) {
  const kingdom = Number(input && input.kingdom);
  const mode = input && input.mode;
  const rallyModes = normalizeRallyModes(state && state.rallyModes);
  if ((kingdom !== 1 && kingdom !== 2) || !MODE_SET.has(mode)) {
    return { ok: false, error: 'invalid_rally_mode' };
  }
  const current = rallyModes[kingdom];
  if (input.baseRevision !== current.revision) {
    return { ok: false, error: 'rally_mode_conflict', record: current };
  }
  const nextModes = { 1: { ...rallyModes[1] }, 2: { ...rallyModes[2] } };
  nextModes[kingdom] = { mode, revision: current.revision + 1 };
  const staged = { 1: state.staged && state.staged[1] || null, 2: state.staged && state.staged[2] || null };
  if (mode === 'double' && staged[kingdom]) {
    const pairs = (staged[kingdom].pairs || []).filter((pair) => pair && pair.role !== 'weak2');
    staged[kingdom] = pairs.length ? { kingdom, pairs } : null;
  }
  return { ok: true, rallyModes: nextModes, staged, record: nextModes[kingdom] };
}

export function disableTripleModes(state) {
  const rallyModes = normalizeRallyModes(state && state.rallyModes);
  const nextModes = { 1: { ...rallyModes[1] }, 2: { ...rallyModes[2] } };
  const staged = { 1: state.staged && state.staged[1] || null, 2: state.staged && state.staged[2] || null };
  let changed = false;
  for (const kingdom of [1, 2]) {
    if (nextModes[kingdom].mode !== 'triple') continue;
    nextModes[kingdom] = { mode: 'double', revision: nextModes[kingdom].revision + 1 };
    if (staged[kingdom]) {
      const pairs = (staged[kingdom].pairs || []).filter((pair) => pair && pair.role !== 'weak2');
      staged[kingdom] = pairs.length ? { kingdom, pairs } : null;
    }
    changed = true;
  }
  return { changed, rallyModes: nextModes, staged };
}

export function validateStagedPairs(input) {
  const modeRecord = record(input && input.modeRecord);
  if (input.modeRevision !== modeRecord.revision) {
    return { ok: false, error: 'rally_mode_conflict', record: modeRecord };
  }
  const source = Array.isArray(input && input.pairs) ? input.pairs : [];
  const max = modeRecord.mode === 'triple' ? 3 : 2;
  if (source.length > max) return { ok: false, error: 'invalid_rally_roster' };
  const seenPids = new Set();
  const seenRoles = new Set();
  const pairs = [];
  for (const sourcePair of source) {
    const pid = normalizeRoutingKey(sourcePair && sourcePair.pid);
    const role = sourcePair && sourcePair.role;
    if (!pid || !ROLES[modeRecord.mode].has(role) || seenPids.has(pid) || seenRoles.has(role)) {
      return { ok: false, error: 'invalid_rally_roster' };
    }
    if (!Object.prototype.hasOwnProperty.call(input.players || {}, pid)) {
      return { ok: false, error: 'player_missing', pid };
    }
    seenPids.add(pid);
    seenRoles.add(role);
    pairs.push({ pid, role });
  }
  return { ok: true, pairs };
}
```

- [ ] **Step 4: Run focused and full unit tests**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/rally-mode.test.cjs && npm test`

Expected: rally-mode tests PASS and the existing suite reports zero failures.

- [ ] **Step 5: Commit the pure domain**

```bash
git add kingshoter/src/rally-mode.js kingshoter/test/rally-mode.test.cjs
git commit -m "feat: model per-kingdom rally modes"
```

### Task 2: Canonical Triple Target Construction

**Files:**
- Create: `kingshoter/src/rally-targets.js`
- Create: `kingshoter/test/rally-targets.test.cjs`

**Interfaces:**
- Consumes: core plan exports `parseMarchSeconds(value): number | null` and `normalizeRoutingKey(value): string` from `kingshoter/src/room-player.js`, plus own-property canonical player records.
- Produces: `buildTripleRallyCommand(input): { ok: true, command } | { ok: false, error, pid? }`.

- [ ] **Step 1: Write failing timing and validation tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function load() {
  return import(`${pathToFileURL(path.join(__dirname, '../src/rally-targets.js')).href}?t=${Date.now()}`);
}

test('two sacrifices land together and Main lands one second later', async () => {
  const { buildTripleRallyCommand } = await load();
  const result = buildTripleRallyCommand({
    players: {
      a: { name: 'A', march: 22 },
      b: { name: 'B', march: 47 },
      c: { name: 'C', march: 31 }
    },
    pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }],
    kingdom: 2, leadSeconds: 10, serverNowSec: 1000,
    commandId: 'cmd-1', atISO: '2026-07-13T00:00:00.000Z'
  });
  assert.equal(result.ok, true);
  const byRole = Object.fromEntries(result.command.payload.pairs.map((pair) => [pair.role, pair]));
  assert.equal(Math.min(...result.command.payload.pairs.map((pair) => pair.pressUTC)), 1010);
  assert.equal(byRole.weak.pressUTC + byRole.weak.march, byRole.weak2.pressUTC + byRole.weak2.march);
  assert.equal(byRole.main.pressUTC + byRole.main.march, byRole.weak.pressUTC + byRole.weak.march + 1);
});

test('all supported leads preserve exact personal lead and invalid rosters fail', async () => {
  const { buildTripleRallyCommand } = await load();
  const players = { a: { march: 5 }, b: { march: 180 }, c: { march: 90 } };
  for (const leadSeconds of [10, 15, 30, 60]) {
    const result = buildTripleRallyCommand({
      players, pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }],
      kingdom: 1, leadSeconds, serverNowSec: 500, commandId: `c-${leadSeconds}`, atISO: 'now'
    });
    assert.equal(Math.min(...result.command.payload.pairs.map((pair) => pair.pressUTC)), 500 + leadSeconds);
  }
  assert.equal(buildTripleRallyCommand({
    players, pairs: [{ pid: 'a', role: 'weak' }, { pid: 'a', role: 'weak2' }, { pid: 'c', role: 'main' }],
    kingdom: 1, leadSeconds: 10, serverNowSec: 500, commandId: 'bad', atISO: 'now'
  }).error, 'invalid_rally_roster');
});

test('target construction rejects reserved, malformed, and inherited player keys', async () => {
  const { buildTripleRallyCommand } = await load();
  const players = Object.create({ inherited: { march: 20 } });
  Object.assign(players, { a: { march: 20 }, b: { march: 30 }, c: { march: 40 } });
  for (const pid of ['__proto__', 'constructor', 'has space', 'bad!', 'inherited']) {
    const result = buildTripleRallyCommand({
      players,
      pairs: [{ pid, role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }],
      kingdom: 1, leadSeconds: 10, serverNowSec: 500, commandId: 'invalid', atISO: 'now'
    });
    assert.equal(result.ok, false, pid);
  }
});
```

- [ ] **Step 2: Run the test and verify the import fails**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/rally-targets.test.cjs`

Expected: FAIL because `src/rally-targets.js` does not exist.

- [ ] **Step 3: Implement canonical Triple construction**

```js
import { normalizeRoutingKey, parseMarchSeconds } from './room-player.js';

const ROLE_OFFSETS = { weak: 0, weak2: 0, main: 1 };
const LEADS = new Set([10, 15, 30, 60]);

export function buildTripleRallyCommand(input) {
  const pairs = Array.isArray(input && input.pairs) ? input.pairs : [];
  if (pairs.length !== 3 || !LEADS.has(input.leadSeconds) || ![1, 2].includes(input.kingdom)) {
    return { ok: false, error: 'invalid_rally_roster' };
  }
  const canonicalPids = pairs.map((pair) => normalizeRoutingKey(pair && pair.pid));
  const pidSet = new Set(canonicalPids);
  const roleSet = new Set(pairs.map((pair) => pair && pair.role));
  if (canonicalPids.some((pid) => !pid) || pidSet.size !== 3 || roleSet.size !== 3 ||
      !Object.keys(ROLE_OFFSETS).every((role) => roleSet.has(role))) {
    return { ok: false, error: 'invalid_rally_roster' };
  }
  const canonical = [];
  for (const pair of pairs) {
    const pid = normalizeRoutingKey(pair.pid);
    if (!Object.prototype.hasOwnProperty.call(input.players || {}, pid)) {
      return { ok: false, error: 'player_missing', pid };
    }
    const player = input.players && input.players[pid];
    if (!player) return { ok: false, error: 'player_missing', pid };
    const march = parseMarchSeconds(player.march);
    if (march === null) return { ok: false, error: 'invalid_march', pid };
    canonical.push({ pid, name: String(player.name || pid).slice(0, 24), role: pair.role, march });
  }
  const raw = canonical.map((pair) => ROLE_OFFSETS[pair.role] - pair.march);
  const firstRaw = Math.min(...raw);
  const commandPairs = canonical.map((pair, index) => ({
    ...pair,
    pressUTC: input.serverNowSec + input.leadSeconds + raw[index] - firstRaw
  }));
  const anchorUTC = Math.min(...commandPairs.map((pair) => pair.pressUTC));
  const expiresUTC = Math.max(...commandPairs.map((pair) => pair.pressUTC + 300 + pair.march)) + 30;
  return {
    ok: true,
    command: {
      id: input.commandId,
      type: 'triple_rally',
      kingdom: input.kingdom,
      anchorUTC,
      expiresUTC,
      payload: {
        pairs: commandPairs,
        firstPress: anchorUTC,
        kingdom: input.kingdom,
        leadSeconds: input.leadSeconds
      },
      text: '',
      at: input.atISO
    }
  };
}
```

- [ ] **Step 4: Run the full target matrix**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/rally-targets.test.cjs`

Expected: PASS for all leads, march extremes, landing equality, and invalid-roster cases.

- [ ] **Step 5: Commit target construction**

```bash
git add kingshoter/src/rally-targets.js kingshoter/test/rally-targets.test.cjs
git commit -m "feat: calculate canonical triple rally targets"
```

### Task 3: Build Metadata and Legacy Projection

**Files:**
- Create: `kingshoter/src/client-build.js`
- Create: `kingshoter/test/client-build.test.cjs`
- Create: `kingshoter/test/fixtures/kvk-legacy-target.cjs`

**Interfaces:**
- Produces: `CURRENT_KVK_BUILD`, `MIN_KVK_BUILD`, `MIN_TRIPLE_BUILD`, `parseClientBuild(value)`, `buildMetadata(tripleEnabled, tripleQaEnabled)`, and `projectRoomForClient(room, clientBuild)`.
- The legacy fixture exports `legacyTarget(command, pid)` and remains frozen until the compatibility bridge is removed.

- [ ] **Step 1: Write failing build/projection tests and the frozen legacy target**

```js
// test/fixtures/kvk-legacy-target.cjs
exports.legacyTarget = function legacyTarget(command, pid) {
  if (command.type === 'double_rally' && command.payload && Array.isArray(command.payload.pairs)) {
    const mine = command.payload.pairs.find((pair) => pair.pid === pid);
    if (mine) return { anchor: mine.pressUTC, mine: true, role: mine.role };
    return { anchor: command.payload.firstPress ?? command.anchorUTC, mine: false };
  }
  return { anchor: command.anchorUTC, mine: false };
};
```

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { legacyTarget } = require('./fixtures/kvk-legacy-target.cjs');

async function load() {
  return import(`${pathToFileURL(path.join(__dirname, '../src/client-build.js')).href}?t=${Date.now()}`);
}

test('legacy projection preserves canonical state and all three personal targets', async () => {
  const mod = await load();
  const room = { live: { commands: { 1: { id: 'x', type: 'triple_rally', anchorUTC: 10, payload: {
    firstPress: 10,
    pairs: [{ pid: 'a', role: 'weak', pressUTC: 10 }, { pid: 'b', role: 'weak2', pressUTC: 11 }, { pid: 'c', role: 'main', pressUTC: 12 }]
  } }, 2: null } } };
  const projected = mod.projectRoomForClient(room, 0);
  assert.equal(room.live.commands[1].type, 'triple_rally');
  assert.equal(projected.live.commands[1].type, 'double_rally');
  assert.equal(projected.live.commands[1].payload.rallySize, 3);
  for (const pid of ['a', 'b', 'c']) assert.equal(legacyTarget(projected.live.commands[1], pid).mine, true);
  assert.equal(mod.projectRoomForClient(room, mod.MIN_TRIPLE_BUILD).live.commands[1].type, 'triple_rally');
});

test('build metadata contains monotonic numeric versions and no secrets', async () => {
  const mod = await load();
  assert.deepEqual(mod.buildMetadata(false, true), {
    currentBuild: 2026071302,
    minKvkBuild: 2026071301,
    minTripleBuild: 2026071302,
    tripleEnabled: false,
    tripleQaEnabled: true
  });
  assert.equal(mod.parseClientBuild('2026071302'), 2026071302);
  assert.equal(mod.parseClientBuild('bad'), 0);
});
```

- [ ] **Step 2: Run and verify the missing module failure**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/client-build.test.cjs`

Expected: FAIL because `src/client-build.js` is missing.

- [ ] **Step 3: Implement immutable per-socket projection**

```js
export const CURRENT_KVK_BUILD = 2026071302;
export const MIN_KVK_BUILD = 2026071301;
export const MIN_TRIPLE_BUILD = 2026071302;

export function parseClientBuild(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function buildMetadata(tripleEnabled, tripleQaEnabled = false) {
  return {
    currentBuild: CURRENT_KVK_BUILD,
    minKvkBuild: MIN_KVK_BUILD,
    minTripleBuild: MIN_TRIPLE_BUILD,
    tripleEnabled: tripleEnabled === true,
    tripleQaEnabled: tripleQaEnabled === true
  };
}

export function projectRoomForClient(room, clientBuild) {
  if (parseClientBuild(clientBuild) >= MIN_TRIPLE_BUILD) return room;
  const sourceCommands = room && room.live && room.live.commands || { 1: null, 2: null };
  const commands = { 1: sourceCommands[1], 2: sourceCommands[2] };
  let changed = false;
  for (const kingdom of [1, 2]) {
    const command = commands[kingdom];
    if (command && command.type === 'triple_rally') {
      commands[kingdom] = {
        ...command,
        type: 'double_rally',
        payload: { ...command.payload, rallySize: 3 }
      };
      changed = true;
    }
  }
  return changed ? { ...room, live: { ...room.live, commands } } : room;
}
```

- [ ] **Step 4: Run projection and immutability tests**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/client-build.test.cjs`

Expected: PASS; canonical `triple_rally` remains unchanged and all three legacy PIDs resolve.

- [ ] **Step 5: Commit build compatibility**

```bash
git add kingshoter/src/client-build.js kingshoter/test/client-build.test.cjs kingshoter/test/fixtures/kvk-legacy-target.cjs
git commit -m "feat: project triple commands for legacy clients"
```

### Task 4: Durable Object Mode, Stage, Command, and Per-Socket State

**Files:**
- Modify: `kingshoter/src/room.js:6-16,44-110,118-218`
- Modify: `kingshoter/src/delivery.js`
- Create: `kingshoter/test/triple-room.test.cjs`
- Modify: `kingshoter/test/delivery-model.test.cjs`
- Test: `kingshoter/test/player-protocol.test.cjs`
- Test: `kingshoter/test/delivery-domain.test.cjs`
- Test: `kingshoter/test/classic-delivery.e2e.cjs`

**Interfaces:**
- Consumes: `normalizeRallyModes`, `transitionRallyMode`, `validateStagedPairs`, `isTripleAllowed`, `buildTripleRallyCommand`, `parseClientBuild`, `MIN_TRIPLE_BUILD`, `projectRoomForClient`, core `startCommandDelivery`, and Reliable `dispatchDeliveryForCommand`.
- Extends the Reliable plan's merge-safe `readSocketAttachment(ws)` and `writeSocketAttachment(ws, patch)` methods; no Triple step may replace the whole WebSocket attachment.
- Consumes core harness exports `loadRoom()`, `createRoomHarness(Room, options)`, and `claimRoom(harness, password)`.
- Produces WebSocket success `{t:"rallyModeSaved", mutationId, kingdom, mode, revision}` and errors `invalid_rally_mode`, `rally_mode_conflict`, `invalid_rally_roster`, `invalid_march`, and `triple_disabled`.

- [ ] **Step 1: Run and report required upstream impact analysis**

Use GitNexus MCP once for each existing symbol before editing:

```text
gitnexus_impact({repo:"kingshot", target:"defaultRoom", file_path:"kingshoter/src/room.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"normalizeLive", file_path:"kingshoter/src/room.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"fetch", file_path:"kingshoter/src/room.js", kind:"Method", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"stateMsg", file_path:"kingshoter/src/room.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"broadcast", file_path:"kingshoter/src/room.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"webSocketMessage", file_path:"kingshoter/src/room.js", kind:"Method", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"createDeliveryRecord", file_path:"kingshoter/src/delivery.js", direction:"upstream", includeTests:true})
```

Expected: a recorded blast-radius note. If any result is HIGH or CRITICAL, send that warning to the user before editing and include the affected flows in the task report.

- [ ] **Step 2: Write failing Durable Object tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRoom, createRoomHarness, claimRoom } = require('./room-harness.cjs');

test('mode updates authenticate, revision, persist once, ack, and broadcast once', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { env: { TRIPLE_RALLY_ENABLED: '1' } });
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-1', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));
  assert.deepEqual(h.room.room.rallyModes[1], { mode: 'triple', revision: 1 });
  assert.deepEqual(h.sent.at(-1), {
    t: 'rallyModeSaved', mutationId: 'm-1', kingdom: 1, mode: 'triple', revision: 1
  });
  assert.deepEqual(h.calls, ['persist', 'broadcast']);
});

test('Triple stage and Fire require the current mode revision and freeze canonical players', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '1' },
    roomName: 'qa-kvk-triple-dispatch',
    players: {
      a: { name: 'A', march: 20, marchRevision: 1 },
      b: { name: 'B', march: 40, marchRevision: 2 },
      c: { name: 'C', march: 30, marchRevision: 3 }
    },
    nowMs: 1_000_000
  });
  await claimRoom(h);
  h.room.delivery = { v: 1, roomName: h.roomName, commands: [] };
  h.room.persistDelivery = async () => { h.calls.push('delivery-persist'); };
  h.room.devices = [
    { pid: 'a', deviceId: '00000000-0000-4000-8000-000000000001', soundReady: true, lastSeenMs: 1_000_000 },
    { pid: 'b', deviceId: '00000000-0000-4000-8000-000000000002', soundReady: true, lastSeenMs: 1_000_000 },
    { pid: 'c', deviceId: '00000000-0000-4000-8000-000000000003', soundReady: true, lastSeenMs: 1_000_000 }
  ];
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-2', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));
  h.reset();
  const pairs = [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }];
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'stage', password: 'commander-secret', staged: { kingdom: 1, modeRevision: 1, pairs }
  }));
  assert.deepEqual(h.room.room.live.staged[1].pairs, pairs);
  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'triple_rally', kingdom: 1, modeRevision: 1,
      payload: { leadSeconds: 10, pairs }
    }
  }));
  const command = h.room.room.live.commands[1];
  assert.equal(command.type, 'triple_rally');
  assert.deepEqual(command.payload.pairs.map((pair) => pair.march), [20, 40, 30]);
  assert.equal(command.payload.pairs[0].pressUTC + 20, command.payload.pairs[1].pressUTC + 40);
  assert.equal(command.payload.pairs[2].pressUTC + 30, command.payload.pairs[0].pressUTC + 21);
  assert.deepEqual(command.delivery.map((entry) => [entry.pid, entry.expected]), [['a', 1], ['b', 1], ['c', 1]]);
  assert.deepEqual(h.room.delivery.commands.at(-1).audiences.map((audience) => [audience.pid, audience.role]), [
    ['a', 'weak'], ['b', 'weak2'], ['c', 'main']
  ]);
  assert.equal(h.room.room.live.staged[1], null);
  assert.deepEqual(h.calls, ['persistAll', 'alarm', 'broadcast', 'delivery-persist', 'alarm']);
});

test('Triple disabled and stale revisions make no mutation', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { env: { TRIPLE_RALLY_ENABLED: '0' } });
  await claimRoom(h);
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-3', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));
  assert.equal(h.sent.at(-1).error, 'triple_disabled');
  assert.deepEqual(h.room.room.rallyModes[1], { mode: 'double', revision: 0 });
  assert.deepEqual(h.calls, []);
});

test('QA-only gate permits generated QA rooms but never an operation room', async () => {
  const { Room } = await loadRoom();
  const env = { TRIPLE_RALLY_ENABLED: '0', TRIPLE_RALLY_QA_ENABLED: '1' };
  const qa = createRoomHarness(Room, { env, roomName: 'qa-kvk-unit-gate' });
  await claimRoom(qa);
  await qa.room.webSocketMessage(qa.ws, JSON.stringify({
    t: 'setRallyMode', mutationId: 'm-qa', password: 'commander-secret',
    kingdom: 1, mode: 'triple', baseRevision: 0
  }));
  assert.equal(qa.room.room.rallyModes[1].mode, 'triple');

  const operation = createRoomHarness(Room, { env, roomName: 'qa-kvk-unit-operation-simulation' });
  operation.room.room.rallyModes[1] = { mode: 'triple', revision: 2 };
  await operation.room.applyTripleGate('operation-room');
  assert.equal(operation.room.room.rallyModes[1].mode, 'double');
});

test('real broadcast projects by socket build and merge-safe attachments retain room identity', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, { env: { TRIPLE_RALLY_ENABLED: '1' }, roomName: 'qa-kvk-build-broadcast' });
  function socket(build, deviceId) {
    const messages = [];
    let attachment = null;
    const ws = {
      send(value) { messages.push(JSON.parse(value)); },
      serializeAttachment(value) { attachment = structuredClone(value); },
      deserializeAttachment() { return attachment == null ? null : structuredClone(attachment); }
    };
    h.room.attachSocket(ws, h.roomName);
    h.room.writeSocketAttachment(ws, { clientBuild: build, deviceId, pid: 'a' });
    h.room.writeSocketAttachment(ws, { lastProbeId: 'probe-1' });
    return { ws, messages };
  }
  const legacy = socket(0, '00000000-0000-4000-8000-000000000010');
  const current = socket(2026071302, '00000000-0000-4000-8000-000000000011');
  h.room.room.live.commands[1] = {
    id: 'c', type: 'triple_rally', kingdom: 1,
    payload: { pairs: [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }] }
  };
  Room.prototype.broadcast.call(h.room);
  assert.equal(legacy.messages.at(-1).room.live.commands[1].type, 'double_rally');
  assert.equal(current.messages.at(-1).room.live.commands[1].type, 'triple_rally');
  assert.equal(current.messages.at(-1).room.capabilities.tripleRally, true);
  const attachment = h.room.readSocketAttachment(current.ws);
  assert.equal(attachment.roomName, h.roomName);
  assert.equal(attachment.clientBuild, 2026071302);
  assert.equal(attachment.lastProbeId, 'probe-1');
  assert.equal(attachment.deviceId, '00000000-0000-4000-8000-000000000011');
});

test('rollback normalizes future mode without mutating an active Triple command', async () => {
  const { Room } = await loadRoom();
  const h = createRoomHarness(Room, {
    env: { TRIPLE_RALLY_ENABLED: '0', TRIPLE_RALLY_QA_ENABLED: '0' },
    roomName: 'qa-kvk-rollback'
  });
  const active = { id: 'live-triple', type: 'triple_rally', expiresUTC: 2_000_000_000, payload: { pairs: [] } };
  h.room.room.rallyModes[1] = { mode: 'triple', revision: 4 };
  h.room.room.live.staged[1] = { kingdom: 1, pairs: [{ pid: 'a', role: 'weak2' }] };
  h.room.room.live.commands[1] = active;
  await h.room.applyTripleGate('qa-kvk-rollback');
  assert.deepEqual(h.room.room.rallyModes[1], { mode: 'double', revision: 5 });
  assert.deepEqual(h.room.room.live.staged[1], null);
  assert.equal(h.room.room.live.commands[1], active);
  await claimRoom(h);
  h.reset();
  await h.room.webSocketMessage(h.ws, JSON.stringify({
    t: 'cmd', password: 'commander-secret', cmd: {
      type: 'double_rally', kingdom: 1, modeRevision: 5,
      payload: { leadSeconds: 10, pairs: [] }
    }
  }));
  assert.equal(h.sent.at(-1).error, 'rally_live');
  assert.equal(h.room.room.live.commands[1], active);
});
```

- [ ] **Step 3: Run tests and verify missing mode/command behavior**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/triple-room.test.cjs`

Expected: FAIL because `Room` has no `rallyModes`, `setRallyMode`, Triple branch, or client-build projection.

- [ ] **Step 4: Import modules and normalize stored mode state**

Add these imports and exact state fields to `src/room.js`:

```js
import { newRallyModes, normalizeRallyModes, transitionRallyMode, disableTripleModes, validateStagedPairs, isTripleAllowed } from './rally-mode.js';
import { buildTripleRallyCommand } from './rally-targets.js';
import { MIN_TRIPLE_BUILD, parseClientBuild, projectRoomForClient } from './client-build.js';
```

```js
function defaultRoom() {
  return {
    pwHash: null,
    config: { castleName: '', rallyAllies: [], enemyWhales: [] },
    players: {},
    rallyModes: newRallyModes(),
    live: { mode: 'idle', commands: { 1: null, 2: null }, staged: { 1: null, 2: null }, sim: null },
    updatedAt: null,
    updatedBy: null
  };
}
```

At the end of `normalizeLive()` add:

```js
this.room.rallyModes = normalizeRallyModes(this.room.rallyModes);
```

Add a new method that never changes active commands:

```js
async applyTripleGate(roomName) {
  if (isTripleAllowed(this.env, roomName)) return false;
  const result = disableTripleModes({
    rallyModes: this.room.rallyModes,
    staged: this.room.live.staged
  });
  if (!result.changed) return false;
  this.room.rallyModes = result.rallyModes;
  this.room.live.staged = result.staged;
  await this.persist();
  this.broadcast();
  return true;
}
```

- [ ] **Step 5: Make state messages build-aware without modifying `snapshot()`**

Extend the Reliable plan's `fetch`, `stateMsg`, and `broadcast` implementations with build projection. Keep `attachSocket()`, delivery probes, and delivery message routing intact. The exact merge-safe integration is:

```js
async fetch(request) {
  const roomName = new URL(request.url).searchParams.get('room') || '';
  this.roomName = roomName.slice(0, 48);
  await this.applyTripleGate(this.roomName);
  if (request.headers.get('Upgrade') === 'websocket') {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const build = parseClientBuild(new URL(request.url).searchParams.get('clientBuild'));
    this.attachSocket(server, this.roomName);
    this.writeSocketAttachment(server, { clientBuild: build });
    server.send(this.stateMsg(build, isTripleAllowed(this.env, this.roomName)));
    return new Response(null, { status: 101, webSocket: client });
  }
  return Response.json(JSON.parse(this.stateMsg(
    MIN_TRIPLE_BUILD,
    isTripleAllowed(this.env, this.roomName)
  )));
}

stateMsg(clientBuild = MIN_TRIPLE_BUILD, tripleAllowed = false) {
  const snapshot = this.snapshot();
  const withCapabilities = {
    ...snapshot,
    capabilities: { ...(snapshot.capabilities || {}), tripleRally: tripleAllowed }
  };
  const projected = projectRoomForClient(withCapabilities, clientBuild);
  return JSON.stringify({ t: 'state', room: projected });
}

broadcast() {
  for (const ws of this.state.getWebSockets()) {
    try {
      const attachment = this.readSocketAttachment(ws);
      ws.send(this.stateMsg(
        attachment.clientBuild,
        isTripleAllowed(this.env, attachment.roomName)
      ));
    } catch (error) {}
  }
}
```

Call `await this.applyTripleGate(this.readSocketAttachment(ws).roomName)` immediately after parsing a valid WebSocket message. This makes the first new connection or mutation after rollback converge stored modes to Double while leaving an active Triple command frozen until cancel or expiry. `writeSocketAttachment()` must shallow-merge `clientBuild`; all later delivery hello/probe updates must preserve it.

- [ ] **Step 6: Add authenticated mode mutation**

Insert this branch after JSON parsing and before player mutations in `webSocketMessage`:

```js
if (m.t === 'setRallyMode') {
  if (!(await this.authOK(m.password))) {
    return ws.send(JSON.stringify({ t: 'error', error: 'bad_password', mutationId: clampStr(m.mutationId, 64) }));
  }
  const mutationId = clampStr(m.mutationId, 64);
  if (!mutationId) return ws.send(JSON.stringify({ t: 'error', error: 'invalid_mutation' }));
  if (m.mode === 'triple' && !isTripleAllowed(this.env, this.readSocketAttachment(ws).roomName)) {
    return ws.send(JSON.stringify({ t: 'error', error: 'triple_disabled', mutationId }));
  }
  const result = transitionRallyMode({
    rallyModes: this.room.rallyModes,
    staged: this.room.live.staged
  }, {
    kingdom: m.kingdom,
    mode: m.mode,
    baseRevision: m.baseRevision
  });
  if (!result.ok) {
    return ws.send(JSON.stringify({
      t: 'error', error: result.error, mutationId,
      kingdom: Number(m.kingdom), record: result.record || null
    }));
  }
  this.room.rallyModes = result.rallyModes;
  this.room.live.staged = result.staged;
  await this.persist();
  ws.send(JSON.stringify({
    t: 'rallyModeSaved', mutationId, kingdom: Number(m.kingdom),
    mode: result.record.mode, revision: result.record.revision
  }));
  this.broadcast();
  return;
}
```

- [ ] **Step 7: Validate staged pairs against canonical mode and revision**

Replace the current stage normalization with this block while retaining the existing authentication, ready reset, single persist, and single broadcast:

```js
const s = m.staged || {};
const kd = clampInt(s.kingdom, 1, 2);
const modeRecord = this.room.rallyModes[kd];
const modeRevision = Number.isInteger(s.modeRevision)
  ? s.modeRevision
  : (modeRecord.mode === 'double' ? modeRecord.revision : -1);
const validated = validateStagedPairs({
  modeRecord,
  modeRevision,
  pairs: s.pairs,
  players: this.room.players
});
if (!validated.ok) {
  return ws.send(JSON.stringify({
    t: 'error', error: validated.error, kingdom: kd, record: validated.record || modeRecord
  }));
}
const pairs = validated.pairs;
```

- [ ] **Step 8: Add the Triple command branch and preserve Double arithmetic**

Immediately after command authentication and kingdom normalization, reject mode mismatches and build Triple from canonical state:

```js
const modeRecord = this.room.rallyModes[kd];
const requestedMode = c.type === 'triple_rally' ? 'triple' : 'double';
const requestRevision = Number.isInteger(c.modeRevision)
  ? c.modeRevision
  : (requestedMode === 'double' ? modeRecord.revision : -1);

if ((c.type === 'double_rally' || c.type === 'triple_rally') &&
    (requestedMode !== modeRecord.mode || requestRevision !== modeRecord.revision)) {
  return ws.send(JSON.stringify({
    t: 'error', error: 'rally_mode_conflict', kingdom: kd, record: modeRecord
  }));
}

if (c.type === 'triple_rally') {
  if (!isTripleAllowed(this.env, this.readSocketAttachment(ws).roomName)) {
    return ws.send(JSON.stringify({ t: 'error', error: 'triple_disabled' }));
  }
  const validated = validateStagedPairs({
    modeRecord,
    modeRevision: requestRevision,
    pairs: c.payload && c.payload.pairs,
    players: this.room.players
  });
  if (!validated.ok || validated.pairs.length !== 3) {
    return ws.send(JSON.stringify({ t: 'error', error: validated.error || 'invalid_rally_roster' }));
  }
  const built = buildTripleRallyCommand({
    players: this.room.players,
    pairs: validated.pairs,
    kingdom: kd,
    leadSeconds: c.payload && c.payload.leadSeconds,
    serverNowSec: this.nowMs() / 1000,
    commandId: crypto.randomUUID(),
    atISO: this.now()
  });
  if (!built.ok) return ws.send(JSON.stringify({ t: 'error', error: built.error, pid: built.pid }));
  built.command.delivery = startCommandDelivery(built.command, this.devices, this.nowMs());
  this.room.live.commands[kd] = built.command;
  this.room.live.staged[kd] = null;
  this.room.live.mode = 'live';
  await this.persistAll();
  await this.scheduleExpiry();
  this.broadcast();
  try { await this.dispatchDeliveryForCommand(built.command, this._deliveryNow()); }
  catch (error) {}
  return;
}
```

Replace the existing refill guard so neither Refill nor a new Double/Triple command can clobber any unexpired rally. Cancel remains the explicit way to replace an active command:

```js
const isStoredRally = (command) => command && (command.type === 'double_rally' || command.type === 'triple_rally');
const existing = this.room.live.commands[kd];
const incomingRally = c.type === 'double_rally' || c.type === 'triple_rally';
if ((type === 'refill' || incomingRally) && isStoredRally(existing) &&
    existing.expiresUTC && Math.floor(this.nowMs() / 1000) <= existing.expiresUTC) {
  return ws.send(JSON.stringify({ t: 'error', error: 'rally_live' }));
}
```

- [ ] **Step 9: Make the no-audio Reliable shadow pair-length aware**

Append this failing `delivery-model.test.cjs` case and retain the existing Double expectation:

```js
test('Reliable shadow records all three immutable Triple audiences', async () => {
  const { createDeliveryRecord } = await load();
  const command = {
    id: 'triple-shadow', type: 'triple_rally', kingdom: 2,
    payload: {
      leadSeconds: 15,
      pairs: [
        { pid: 'a', role: 'weak', pressUTC: 1015, march: 20 },
        { pid: 'b', role: 'weak2', pressUTC: 1035, march: 40 },
        { pid: 'c', role: 'main', pressUTC: 1026, march: 30 }
      ]
    }
  };
  const record = createDeliveryRecord(command, 1_000_000);
  assert.deepEqual(record.audiences.map((item) => ({
    pid: item.pid, role: item.role, fireAtMs: item.fireAtMs, leadSeconds: item.leadSeconds
  })), [
    { pid: 'a', role: 'weak', fireAtMs: 1_015_000, leadSeconds: 15 },
    { pid: 'b', role: 'weak2', fireAtMs: 1_035_000, leadSeconds: 15 },
    { pid: 'c', role: 'main', fireAtMs: 1_026_000, leadSeconds: 15 }
  ]);
});
```

Replace Reliable's two-target-only `role()` and `createDeliveryRecord()` with:

```js
const RALLY_SIZES = { double_rally: 2, triple_rally: 3 };

const role = (value) => value === 'main' ? 'main' : value === 'weak2' ? 'weak2' : 'weak';

export function createDeliveryRecord(command, nowMs) {
  const expected = command && RALLY_SIZES[command.type];
  if (!expected || !text(command.id, 64)) return null;
  const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
  const leadSeconds = Math.max(1, Math.min(120, int(payload.leadSeconds, 10)));
  const sourcePairs = Array.isArray(payload.pairs) ? payload.pairs : [];
  if (sourcePairs.length !== expected) return null;
  const audiences = sourcePairs.map((pair) => {
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
  if (audiences.length !== expected || new Set(audiences.map((item) => item.pid)).size !== expected) return null;
  return {
    commandId: text(command.id, 64),
    kingdom: command.kingdom === 2 ? 2 : 1,
    issuedAtMs: Math.max(0, int(nowMs, Date.now())),
    cancelledAtMs: null,
    audiences,
    targets: []
  };
}
```

Keep the existing three-audience normalization cap and 24-device target cap.

- [ ] **Step 10: Run server, player, ACK, expiry, and Double regressions**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test test/triple-room.test.cjs test/rally-mode.test.cjs test/rally-targets.test.cjs test/client-build.test.cjs test/delivery-model.test.cjs
npm test
node --check src/room.js
```

Expected: every command exits 0; existing Double tests retain their original `pressUTC` expectations.

- [ ] **Step 11: Commit the server integration**

```bash
git add kingshoter/src/room.js kingshoter/src/delivery.js kingshoter/test/triple-room.test.cjs kingshoter/test/delivery-model.test.cjs
git commit -m "feat: persist and dispatch triple rally commands"
```

### Task 5: Uncached Build Endpoint and Forced Update Controller

**Files:**
- Modify: `kingshoter/src/worker.js:7-47`
- Create: `kingshoter/public/kvk-update.js`
- Create: `kingshoter/test/kvk-update.test.cjs`
- Modify: `kingshoter/public/app.js:128-144`
- Modify: `kingshoter/public/kvk.html`
- Modify: `kingshoter/public/app.css`
- Modify: `kingshoter/wrangler.toml`

**Interfaces:**
- Produces `GET /api/build` JSON from `buildMetadata()` with `Cache-Control: no-store`.
- Produces `window.KvkUpdate` with `BUILD`, `shouldReload(meta)`, `reloadURL(href, build)`, and `createController(options)`.
- Extends `RoomSocket` URLs with `clientBuild=<window.KvkUpdate.BUILD>` without changing the core plan's `onMessage` contract, and adds an optional `onClose` notification before the existing reconnect path.

- [ ] **Step 1: Run upstream impact analysis for existing entry points**

```text
gitnexus_impact({repo:"kingshot", target:"fetch", file_path:"kingshoter/src/worker.js", kind:"Method", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"constructor", file_path:"kingshoter/public/app.js", kind:"Method", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"connect", file_path:"kingshoter/public/app.js", kind:"Method", direction:"upstream", includeTests:true})
```

Expected: blast-radius notes are reported before edits; HIGH/CRITICAL results are explicitly warned to the user.

- [ ] **Step 2: Write failing controller tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUpdate() {
  const source = fs.readFileSync(path.join(__dirname, '../public/kvk-update.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, URL, globalThis: {} });
  return module.exports;
}

test('stale clients replace the page with a cache-busting build URL', async () => {
  const update = loadUpdate();
  const calls = [];
  const controller = update.createController({
    fetcher: async () => ({ ok: true, json: async () => ({ minKvkBuild: update.BUILD + 1 }) }),
    location: { href: 'https://kingshoter.com/kvk?room=qa-kvk-a', replace: (url) => calls.push(url) },
    document: { hidden: false, getElementById: () => ({ hidden: true }), addEventListener() {} },
    hasActivePersonalCommand: () => false,
    setIntervalFn: () => 1
  });
  await controller.check();
  assert.match(calls[0], /__kvk_build=2026071303/);
});

test('an active personal countdown defers but does not forget the update', async () => {
  const update = loadUpdate();
  let active = true;
  const calls = [];
  const gate = { hidden: true };
  const controller = update.createController({
    fetcher: async () => ({ ok: true, json: async () => ({ minKvkBuild: update.BUILD + 1 }) }),
    location: { href: 'https://kingshoter.com/kvk?room=qa-kvk-a', replace: (url) => calls.push(url) },
    document: { hidden: false, getElementById: () => gate, addEventListener() {} },
    hasActivePersonalCommand: () => active,
    setIntervalFn: () => 1
  });
  await controller.check();
  assert.deepEqual(calls, []);
  assert.equal(gate.hidden, true, 'the update overlay must not cover an active personal countdown');
  active = false;
  controller.flush();
  assert.equal(calls.length, 1);
  assert.equal(gate.hidden, false);
});
```

- [ ] **Step 3: Run and verify the missing controller failure**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/kvk-update.test.cjs`

Expected: FAIL because `public/kvk-update.js` is missing.

- [ ] **Step 4: Implement the UMD update controller**

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KvkUpdate = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BUILD = 2026071302;

  function shouldReload(meta) {
    return Number.isInteger(meta && meta.minKvkBuild) && BUILD < meta.minKvkBuild;
  }

  function reloadURL(href, build) {
    const url = new URL(href);
    url.searchParams.set('__kvk_build', String(build));
    return url.toString();
  }

  function createController(options) {
    let pendingBuild = 0;
    const gate = options.document.getElementById('updateGate');

    function flush() {
      if (!pendingBuild || options.hasActivePersonalCommand()) return false;
      if (gate) gate.hidden = false;
      options.location.replace(reloadURL(options.location.href, pendingBuild));
      return true;
    }

    async function check() {
      try {
        const response = await options.fetcher('/api/build', { cache: 'no-store' });
        if (!response.ok) return false;
        const meta = await response.json();
        if (!shouldReload(meta)) return false;
        pendingBuild = meta.minKvkBuild;
        return flush();
      } catch (error) {
        return false;
      }
    }

    function start() {
      options.document.addEventListener('visibilitychange', function () {
        if (!options.document.hidden) check();
      });
      options.setIntervalFn(check, 60_000);
      check();
    }

    return { check, flush, start };
  }

  return { BUILD, shouldReload, reloadURL, createController };
}));
```

- [ ] **Step 5: Add the build endpoint and disabled platform gate**

Import metadata in `src/worker.js`:

```js
import { buildMetadata } from './client-build.js';
```

Add before `/api/ws` routing:

```js
if (url.pathname === '/api/build') {
  return new Response(JSON.stringify(buildMetadata(
    env.TRIPLE_RALLY_ENABLED === '1',
    env.TRIPLE_RALLY_QA_ENABLED === '1'
  )), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
```

The existing `wrangler.toml` has no `[vars]` section. Create exactly one section and keep both gates together:

```toml
[vars]
TRIPLE_RALLY_ENABLED = "0"
TRIPLE_RALLY_QA_ENABLED = "1"
```

- [ ] **Step 6: Load the controller, add the blocking overlay, and version sockets**

Add before `app.js` in `public/kvk.html`:

```html
<div id="updateGate" class="update-gate" role="status" aria-live="assertive" hidden>
  <div class="update-card">Updating…</div>
</div>
<script src="/kvk-update.js?v=2026071302"></script>
```

Use the same build on all KvK runtime scripts so the cache-busting reload cannot mix generations:

```html
<script src="/kvk-update.js?v=2026071302"></script>
<script src="/app.js?v=2026071302"></script>
<script src="/kvk.js?v=2026071302"></script>
```

Add to `public/app.css`:

```css
.update-gate{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:rgba(251,247,236,.96)}
.update-gate[hidden]{display:none}
.update-card{padding:18px 24px;border:2px solid var(--ink);border-radius:16px;background:var(--cream);font-weight:800}
```

Change only the WebSocket URL construction in `RoomSocket.connect()`:

```js
const build = window.KvkUpdate ? window.KvkUpdate.BUILD : 0;
const ws = new WebSocket(`${proto}://${location.host}/api/ws?room=${encodeURIComponent(this.room)}&clientBuild=${build}`);
```

Initialize `this.onClose = null` beside the core `onMessage` callback. Inside the existing WebSocket close handler, invoke `if (this.onClose) this.onClose();` before the unchanged reconnect timer. Do not replace or duplicate the reconnect logic.

- [ ] **Step 7: Start updates with active-personal-command deferral**

After `liveCommands`, `myTarget`, and the room socket are available in `public/kvk.js`, initialize through a fail-closed no-op fallback. A missing, partially cached, or throwing updater must not stop default Double initialization:

```js
function noUpdateController() { return { start: function () {}, flush: function () { return false; } }; }

function makeUpdateController() {
  try {
    if (!window.KvkUpdate || typeof window.KvkUpdate.createController !== 'function') return noUpdateController();
    return window.KvkUpdate.createController({
      fetcher: window.fetch.bind(window),
      location: window.location,
      document: document,
      hasActivePersonalCommand: function () {
        var now = window.serverNow() / 1000;
        return liveCommands(room).some(function (command) {
          var target = myTarget(command);
          return target.mine && target.anchor > now - 1;
        });
      },
      setIntervalFn: window.setInterval.bind(window)
    });
  } catch (error) {
    return noUpdateController();
  }
}

var updateController = makeUpdateController();
updateController.start();
```

Call `updateController.flush()` after every `onState()` reconciliation and after Cancel removes future cues.

- [ ] **Step 8: Verify endpoint, controller, static syntax, and disabled gate**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test test/kvk-update.test.cjs test/client-build.test.cjs
node --check src/worker.js
node --check public/app.js
node --check public/kvk-update.js
npx wrangler deploy --dry-run
```

Expected: all tests pass, syntax checks exit 0, dry run succeeds, and output retains global `TRIPLE_RALLY_ENABLED = "0"` plus QA-only `TRIPLE_RALLY_QA_ENABLED = "1"`.

- [ ] **Step 9: Commit updater bootstrap**

```bash
git add kingshoter/src/worker.js kingshoter/public/kvk-update.js kingshoter/test/kvk-update.test.cjs kingshoter/public/app.js kingshoter/public/kvk.html kingshoter/public/app.css kingshoter/wrangler.toml
git commit -m "feat: force stale kvk clients to update"
```

### Task 6: Shared Browser Rally Semantics

**Files:**
- Create: `kingshoter/public/kvk-rally.js`
- Create: `kingshoter/test/kvk-rally-client.test.cjs`
- Modify: `kingshoter/public/kvk.html`
- Modify: `kingshoter/public/kvk.js:294-413,455-545,858-909`
- Modify: `kingshoter/test/mineaudio.cjs`
- Modify: `kingshoter/test/alert-truth.cjs`
- Modify: `kingshoter/test/delivery-browser-wiring.test.cjs`

**Interfaces:**
- Produces `window.KvkRally` and CommonJS exports `isRallyCommand(command)`, `targetFor(command, pid)`, `rolesForMode(mode)`, and `reconcilePicks(picks, mode)`.
- Preserves the existing local `myTarget(command)` function as a wrapper so callers and GitNexus flows do not require a rename.

- [ ] **Step 1: Run upstream impact analysis for the shared cue path**

```text
gitnexus_impact({repo:"kingshot", target:"myTarget", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"scheduleAllCues", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"activeCommand", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"syncMap", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"tick", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
```

Expected: blast radius reported before editing. Treat `scheduleAllCues` as audio-critical even if the graph underestimates dynamic browser callbacks.

- [ ] **Step 2: Write failing browser-domain tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRally() {
  const source = fs.readFileSync(path.join(__dirname, '../public/kvk-rally.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, globalThis: {} });
  return module.exports;
}

const rally = loadRally();
const plain = (value) => JSON.parse(JSON.stringify(value));

test('Double, Triple, and projected legacy Triple are rally commands', () => {
  assert.equal(rally.isRallyCommand({ type: 'double_rally' }), true);
  assert.equal(rally.isRallyCommand({ type: 'triple_rally' }), true);
  assert.equal(rally.isRallyCommand({ type: 'refill' }), false);
});

test('the third captain resolves only their own immutable target', () => {
  const command = { type: 'triple_rally', anchorUTC: 10, payload: {
    firstPress: 10,
    pairs: [{ pid: 'a', role: 'weak', pressUTC: 10 }, { pid: 'b', role: 'weak2', pressUTC: 12 }, { pid: 'c', role: 'main', pressUTC: 11 }]
  } };
  assert.deepEqual(plain(rally.targetFor(command, 'b')), { anchor: 12, mine: true, role: 'weak2' });
  assert.deepEqual(plain(rally.targetFor(command, 'z')), { anchor: 10, mine: false });
});

test('mode reconciliation never keeps a hidden weak2 in Double', () => {
  const picks = [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }];
  assert.deepEqual(plain(rally.reconcilePicks(picks, 'double')), [{ pid: 'a', role: 'weak' }, { pid: 'c', role: 'main' }]);
  assert.deepEqual(plain(rally.rolesForMode('triple')), ['weak', 'weak2', 'main']);
});
```

- [ ] **Step 3: Run and verify the missing module failure**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/kvk-rally-client.test.cjs`

Expected: FAIL because `public/kvk-rally.js` is missing.

- [ ] **Step 4: Implement the shared UMD rally module**

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KvkRally = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isRallyCommand(command) {
    return !!command && (command.type === 'double_rally' || command.type === 'triple_rally');
  }

  function targetFor(command, pid) {
    if (isRallyCommand(command) && command.payload && Array.isArray(command.payload.pairs)) {
      const mine = command.payload.pairs.find((pair) => pair.pid === pid);
      if (mine) return { anchor: mine.pressUTC, mine: true, role: mine.role };
      return { anchor: command.payload.firstPress != null ? command.payload.firstPress : command.anchorUTC, mine: false };
    }
    return { anchor: command.anchorUTC, mine: false };
  }

  function rolesForMode(mode) {
    return mode === 'triple' ? ['weak', 'weak2', 'main'] : ['weak', 'main'];
  }

  function reconcilePicks(picks, mode) {
    const allowed = new Set(rolesForMode(mode));
    const seenPids = new Set();
    const seenRoles = new Set();
    return (Array.isArray(picks) ? picks : []).filter((pick) => {
      if (!pick || !pick.pid || !allowed.has(pick.role) || seenPids.has(pick.pid) || seenRoles.has(pick.role)) return false;
      seenPids.add(pick.pid);
      seenRoles.add(pick.role);
      return true;
    }).map((pick) => ({ pid: pick.pid, role: pick.role }));
  }

  return { isRallyCommand, targetFor, rolesForMode, reconcilePicks };
}));
```

- [ ] **Step 5: Load the module and replace every protocol predicate explicitly**

Load before `kvk.js` in `public/kvk.html`:

```html
<script src="/kvk-rally.js?v=2026071302"></script>
```

Create one guarded adapter before the existing symbol. The fallback deliberately exposes Double semantics only, so optional-script failure cannot reveal Triple or stop page initialization:

```js
var tripleClientAvailable = !!(window.KvkRally &&
  typeof window.KvkRally.isRallyCommand === 'function' &&
  typeof window.KvkRally.targetFor === 'function' &&
  typeof window.KvkRally.rolesForMode === 'function' &&
  typeof window.KvkRally.reconcilePicks === 'function');

var rallyApi = tripleClientAvailable ? window.KvkRally : {
  isRallyCommand: function (command) { return !!command && command.type === 'double_rally'; },
  targetFor: function (command, pid) {
    var pairs = command && command.payload && Array.isArray(command.payload.pairs) ? command.payload.pairs : [];
    var mine = pairs.find(function (pair) { return pair.pid === pid; });
    return mine
      ? { anchor: mine.pressUTC, mine: true, role: mine.role }
      : { anchor: command && (command.payload && command.payload.firstPress || command.anchorUTC), mine: false };
  },
  rolesForMode: function () { return ['weak', 'main']; },
  reconcilePicks: function (picks) {
    var seenPid = Object.create(null), seenRole = Object.create(null);
    return (Array.isArray(picks) ? picks : []).filter(function (pick) {
      if (!pick || (pick.role !== 'weak' && pick.role !== 'main') || seenPid[pick.pid] || seenRole[pick.role]) return false;
      seenPid[pick.pid] = true; seenRole[pick.role] = true; return true;
    }).map(function (pick) { return { pid: pick.pid, role: pick.role }; });
  }
};

function isRallyCommand(command) { return rallyApi.isRallyCommand(command); }
function myTarget(command) { return rallyApi.targetFor(command, myPid); }
```

Apply this exact predicate table; do not change control flow, cue keys, or arithmetic:

| Function | Existing expression | Replacement |
|---|---|---|
| `scheduleAllCues` prepare branch | `c.type === "double_rally"` | `isRallyCommand(c)` |
| `scheduleAllCues` generic JOIN branch | `join && join.type === "double_rally"` | `join && isRallyCommand(join)` |
| `announceCmd` | `c.type === "double_rally"` | `isRallyCommand(c)` |
| `paintHero` one-time announcement | `c.type === "double_rally"` | `isRallyCommand(c)` |
| `mapData` | `c && c.type === "double_rally"` | `c && isRallyCommand(c)` |
| Reliable `observeClassicDelivery` | `command.type !== 'double_rally'` | `!isRallyCommand(command)` |

Replace `myTarget()` with the one-line shared-module wrapper shown above. Preserve the core plan's `if (!personal && shouldBookJoinAudio())` audience guard around the generic JOIN branch, so an unselected commander remains silent while an ordinary registered member hears JOIN. Keep `simCommand()` returning `double_rally`, and keep `fireDouble()` untouched. Confirm the exact remaining intentional occurrences with:

Run: `cd /Users/ff/Documents/kingshot && rg -n 'type === "double_rally"|type !== "double_rally"' kingshoter/public/kvk.js`

Expected: only `simCommand()` and `fireDouble()` protocol construction remain direct Double-only code; no predicate branch remains Double-only.

- [ ] **Step 6: Verify audience and duplicate-cue behavior for three pairs**

In each fixture command, append `{ pid: weak2Pid, name: 'Weak Two', role: 'weak2', march: 47, pressUTC: firstPress }`, open a browser context with that exact PID, and retain the core plan's separate ordinary-member and unselected-commander contexts. In `delivery-browser-wiring.test.cjs`, add `assert.match(kvk, /if \(!isRallyCommand\(command\)\) return;/)` so the no-audio shadow observes all three Classic-scheduled personal targets. Assert:

```js
const personal = cues.filter((cue) => cue.key.includes(commandId + '-me:'));
const personalBases = [...new Set(personal.map((cue) => cue.base))];
assert.deepEqual(personalBases, [commandId + '-me'], 'selected captain books exactly one personal sequence');
assert.equal(joinCues.length, 0, 'unselected commander remains silent');
assert.equal(new Set(personal.map((cue) => cue.key)).size, personal.length, 'duplicate states do not duplicate cue keys');
```

- [ ] **Step 7: Run shared semantics and Classic audio regression**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test test/kvk-rally-client.test.cjs
node test/mineaudio.cjs http://127.0.0.1:8791
node test/alert-truth.cjs http://127.0.0.1:8791
```

Expected: the unit test passes; with the local server running, each browser script exits 0 and an unselected commander has no cue.

- [ ] **Step 8: Commit shared client semantics**

```bash
git add kingshoter/public/kvk-rally.js kingshoter/test/kvk-rally-client.test.cjs kingshoter/public/kvk.html kingshoter/public/kvk.js kingshoter/test/mineaudio.cjs kingshoter/test/alert-truth.cjs kingshoter/test/delivery-browser-wiring.test.cjs
git commit -m "feat: route triple rallies through personal cues"
```

### Task 7: Per-Kingdom Mode Control and Three-Role Selection UX

**Files:**
- Modify: `kingshoter/public/kvk-rally.js`
- Modify: `kingshoter/test/kvk-rally-client.test.cjs`
- Modify: `kingshoter/public/kvk.html`
- Modify: `kingshoter/public/kvk.js:19,45-110,375-385,739-833,858-909,980-1000`
- Modify: `kingshoter/public/app.css`

**Interfaces:**
- Extends `window.KvkRally` with `selectPlayer(picks, pid, mode, replaceRole)` and `movePlayerToRole(picks, pid, role, mode)`.
- Consumes core `canonicalPick(pid, role, players)`, `selectOrReplacePlayer(pid)`, `openReplacement(pid, availableRoles)`, `applyReplacement(pid, role)`, `renderSlots(kingdom = fireKingdom)`, and dialog hooks `#replaceOvl`, `#replaceTitle`, `#replaceWeak`, `#replaceMain`, and `#replaceCancel`.
- Produces client mutation state `{mutationId, kingdom, mode, ackRevision}`; settlement requires both the ACK revision and a room snapshot carrying that same revision.

- [ ] **Step 1: Run and warn on roster/slot blast radius**

```text
gitnexus_impact({repo:"kingshot", target:"renderRoster", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"renderSlots", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"stageBroadcast", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"onState", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"canonicalPick", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
```

Expected: `renderRoster` and `renderSlots` are treated as CRITICAL based on the prior map. Warn the user with direct callers and affected flows before editing, then proceed under the existing authorization.

- [ ] **Step 2: Extend the failing selection tests**

Append:

```js
test('Triple fills weak, weak2, main and never silently replaces a fourth player', () => {
  let result = rally.selectPlayer([], 'a', 'triple');
  result = rally.selectPlayer(result.picks, 'b', 'triple');
  result = rally.selectPlayer(result.picks, 'c', 'triple');
  assert.deepEqual(plain(result.picks), [
    { pid: 'a', role: 'weak' },
    { pid: 'b', role: 'weak2' },
    { pid: 'c', role: 'main' }
  ]);
  const fourth = rally.selectPlayer(result.picks, 'd', 'triple');
  assert.equal(fourth.needsReplacement, true);
  assert.deepEqual(plain(fourth.picks), plain(result.picks));
  assert.deepEqual(plain(fourth.roles), ['weak', 'weak2', 'main']);
});

test('moving to an occupied role swaps captains without loss', () => {
  const picks = [{ pid: 'a', role: 'weak' }, { pid: 'b', role: 'weak2' }, { pid: 'c', role: 'main' }];
  assert.deepEqual(plain(rally.movePlayerToRole(picks, 'a', 'main', 'triple')), [
    { pid: 'a', role: 'main' },
    { pid: 'b', role: 'weak2' },
    { pid: 'c', role: 'weak' }
  ]);
});
```

- [ ] **Step 3: Run and verify the new functions are missing**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/kvk-rally-client.test.cjs`

Expected: FAIL with `rally.selectPlayer is not a function`.

- [ ] **Step 4: Implement deterministic selection and role swaps**

First extend the core `canonicalPick()` role normalization without changing its player lookup or march fields:

```js
var canonicalRole = role === 'main' ? 'main' : role === 'weak2' ? 'weak2' : 'weak';
return {
  pid: pid,
  role: canonicalRole,
  name: player.name || pid,
  march: player.march,
  marchRevision: Number.isInteger(player.marchRevision) ? player.marchRevision : 0
};
```

Then add inside the UMD factory and include both names in its return object:

```js
function selectPlayer(picks, pid, mode, replaceRole) {
  const current = reconcilePicks(picks, mode);
  const existing = current.find((pick) => pick.pid === pid);
  if (existing) return { picks: current.filter((pick) => pick.pid !== pid), needsReplacement: false };
  const roles = rolesForMode(mode);
  const used = new Set(current.map((pick) => pick.role));
  const emptyRole = roles.find((role) => !used.has(role));
  if (emptyRole) return { picks: current.concat({ pid, role: emptyRole }), needsReplacement: false };
  if (!roles.includes(replaceRole)) return { picks: current, needsReplacement: true, roles };
  return {
    picks: current.filter((pick) => pick.role !== replaceRole).concat({ pid, role: replaceRole }),
    needsReplacement: false
  };
}

function movePlayerToRole(picks, pid, targetRole, mode) {
  const current = reconcilePicks(picks, mode);
  const roles = rolesForMode(mode);
  if (!roles.includes(targetRole)) return current;
  const moving = current.find((pick) => pick.pid === pid);
  if (!moving || moving.role === targetRole) return current;
  const occupied = current.find((pick) => pick.role === targetRole);
  return current.map((pick) => {
    if (pick.pid === pid) return { pid: pick.pid, role: targetRole };
    if (occupied && pick.pid === occupied.pid) return { pid: pick.pid, role: moving.role };
    return pick;
  });
}
```

- [ ] **Step 5: Add mode switch markup and accessible styles**

Place beside `#kingdomPick`:

```html
<section id="rallyModeControl" class="rally-mode" aria-labelledby="rallyModeScope">
  <span id="rallyModeScope"></span>
  <label class="switch-row" for="tripleMode">
    <input id="tripleMode" type="checkbox" role="switch" aria-describedby="rallyModeStatus">
    <span id="tripleModeLabel">Triple Rally</span>
  </label>
  <span id="rallyModeStatus" class="hint" aria-live="polite"></span>
</section>
```

Add:

```css
.rally-mode{display:flex;align-items:center;gap:10px;min-height:44px;margin:8px 0}
.switch-row{display:inline-flex;align-items:center;gap:8px;min-height:44px;cursor:pointer}
.switch-row input{inline-size:44px;block-size:24px}
.pickslots.triple{display:grid;grid-template-columns:1fr;gap:8px}
.pickslots.triple .slot{display:grid;grid-template-columns:minmax(92px,auto) 1fr auto;align-items:center;min-height:44px}
.pickslots.triple .swapbtn{display:none}
```

- [ ] **Step 6: Add canonical mode state and two-confirmation settlement**

Add state and helpers near `pickedByK`:

```js
var pendingRallyMode = null;

function rallyModeRecord(kingdom) {
  var fallback = { mode: 'double', revision: 0 };
  var record = room && room.rallyModes && room.rallyModes[kingdom] || fallback;
  return !tripleClientAvailable && record.mode === 'triple'
    ? { mode: 'double', revision: record.revision }
    : record;
}

function rallyMode(kingdom) { return rallyModeRecord(kingdom).mode; }

function clearPendingRallyMode() {
  if (pendingRallyMode && pendingRallyMode.timeoutId) window.clearTimeout(pendingRallyMode.timeoutId);
  pendingRallyMode = null;
  renderRallyMode();
}

function settleRallyModeMutation() {
  if (!pendingRallyMode || !room) return;
  var current = rallyModeRecord(pendingRallyMode.kingdom);
  if (pendingRallyMode.ackRevision === current.revision && current.mode === pendingRallyMode.mode) {
    clearPendingRallyMode();
    window.toast(tk('rally_mode_saved'));
  }
}

function handleRallyModeMessage(message) {
  if (message.t !== 'rallyModeSaved') return false;
  if (pendingRallyMode && message.mutationId === pendingRallyMode.mutationId) {
    pendingRallyMode.ackRevision = message.revision;
    settleRallyModeMutation();
  }
  return true;
}

function handleRallyModeError(message) {
  if (!pendingRallyMode || message.mutationId !== pendingRallyMode.mutationId) return false;
  if (message.error === 'bad_password') {
    clearPendingRallyMode();
    return false;
  }
  if (!['rally_mode_conflict', 'invalid_rally_mode', 'triple_disabled'].includes(message.error)) return false;
  clearPendingRallyMode();
  window.toast(tk(message.error === 'rally_mode_conflict' ? 'mode_changed_elsewhere' : 'mode_unavailable'));
  return true;
}

function handleRallyStageConflict(message) {
  if (message.mutationId || message.error !== 'rally_mode_conflict') return false;
  window.toast(tk('mode_changed_elsewhere'));
  return true;
}
```

Add `handleRallyModeMessage(message)` as the first specialized case inside the core plan's `handleSocketMessage(message)`; do not replace its player-save or Reliable shadow cases. Add `if (handleRallyModeError(m) || handleRallyStageConflict(m)) return;` as the first line of the core `sock.onError` callback. A conflict only reports that a newer snapshot is required; it never writes `room.rallyModes` locally. Call `settleRallyModeMutation()` after `room = r` in `onState()`.

- [ ] **Step 7: Implement synchronized switch behavior**

```js
function renderRallyMode() {
  var control = $('rallyModeControl');
  var input = $('tripleMode');
  var scope = $('rallyModeScope');
  var status = $('rallyModeStatus');
  if (!control || !input || !scope || !status) return;
  var current = rallyModeRecord(fireKingdom);
  var allowed = !!(tripleClientAvailable && room && room.capabilities && room.capabilities.tripleRally);
  control.hidden = !allowed;
  scope.textContent = (L() ? 'Kingdom ' : '王国 ') + fireKingdom;
  input.checked = current.mode === 'triple';
  input.disabled = !!pendingRallyMode || !roomPw || !allowed;
  status.textContent = pendingRallyMode ? tk('saving') : tk(current.mode === 'triple' ? 'mode_triple' : 'mode_double');
}

function requestRallyMode(mode) {
  var current = rallyModeRecord(fireKingdom);
  var allowed = !!(tripleClientAvailable && room && room.capabilities && room.capabilities.tripleRally);
  if (!sock || !allowed || pendingRallyMode || mode === current.mode) return;
  if (mode === 'double') {
    var weak2 = pickedByK[fireKingdom].find(function (pick) { return pick.role === 'weak2'; });
    var player = weak2 && room.players[weak2.pid];
    var name = player && player.name || weak2 && weak2.pid || '';
    if (weak2 && !window.confirm(tkf('confirm_drop_weak2', { n: name }))) {
      renderRallyMode();
      return;
    }
  }
  var mutationId = crypto.randomUUID();
  pendingRallyMode = {
    mutationId: mutationId, kingdom: fireKingdom, mode: mode, ackRevision: null,
    timeoutId: window.setTimeout(function () {
      if (pendingRallyMode && pendingRallyMode.mutationId === mutationId) {
        clearPendingRallyMode();
        window.toast(tk('notconn'));
      }
    }, 8000)
  };
  if (!sock.send({
    t: 'setRallyMode', mutationId: mutationId, password: roomPw,
    kingdom: fireKingdom, mode: mode, baseRevision: current.revision
  })) {
    clearPendingRallyMode();
    window.toast(tk('notconn'));
  }
  renderRallyMode();
}

function wireRallyMode() {
  var input = $('tripleMode');
  input.onchange = function () { requestRallyMode(input.checked ? 'triple' : 'double'); };
  renderRallyMode();
}
```

Call `wireRallyMode()` exactly once from the existing `wireRoom()` function after the kingdom controls are bound. Set `sock.onClose = clearPendingRallyMode` after constructing the socket so a closed connection cannot leave the switch disabled; the eight-second timeout covers a silent socket. Call `renderRallyMode()` whenever `fireKingdom` or room state changes.

- [ ] **Step 8: Render three canonical role rows and explicit replacement**

Add one role-label helper and use it in the staged line, personal hero subtitle, roster badge, removal-impact summary, and slots. For active commands pass `command.type === 'triple_rally'`; for staged/removal rows pass `rallyMode(kingdom) === 'triple'`:

```js
function rallyRoleLabel(role, triple) {
  return tk(role === 'main' ? 'main' : role === 'weak2' ? 'slot_weak2' : triple ? 'slot_weak1' : 'weak');
}
```

Extend `renderSlots(kingdom = fireKingdom)`; do not replace its completed Core Double body. At the first line, branch to a new `renderTripleSlots(kingdom)` only when the canonical mode is Triple. The Double branch, including its unpick/swap controls and `deliveryForPlayer()` status markup, remains byte-for-byte unchanged. The new helper must use its `kingdom` argument everywhere—never the global `fireKingdom`—and renders all three delivery statuses:

```js
function renderTripleSlots(kingdom) {
var box = $('pickSlots');
if (!box) return;
var mode = rallyMode(kingdom);
var roles = rallyApi.rolesForMode(mode);
var cur = rallyApi.reconcilePicks(pickedByK[kingdom], mode);
var command = room && room.live && room.live.commands && room.live.commands[kingdom];
pickedByK[kingdom] = cur;
box.classList.add('triple');
box.innerHTML = roles.map(function (role) {
  var pick = cur.find(function (item) { return item.role === role; });
  var canonical = pick && canonicalPick(pick.pid, pick.role, room.players);
  var label = rallyRoleLabel(role, mode === 'triple');
  var delivery = canonical && deliveryForPlayer(command, canonical.pid);
  var deliveryHTML = delivery
    ? '<span class="delivery ' + delivery.kind + '">' + window.esc(delivery.text) + '</span>'
    : '';
  var value = canonical
    ? window.esc(canonical.name.slice(0, 14)) + ' <small>' + window.mmss(canonical.march) + '</small>' + deliveryHTML
    : '<span class="empty">' + tk('slot_empty') + '</span>';
  return '<div class="slot ' + role + (canonical ? ' filled' : '') + '" data-role="' + role + '" data-pid="' +
    (canonical ? window.esc(canonical.pid) : '') + '">' +
    '<button type="button" class="rolebtn" data-pid="' + (canonical ? window.esc(canonical.pid) : '') + '">' + label + '</button>' +
    '<div class="sv">' + value + '</div></div>';
}).join('');
}
```

At the top of the existing renderer add only:

```js
function renderSlots(kingdom = fireKingdom) {
  if (rallyMode(kingdom) === 'triple') return renderTripleSlots(kingdom);
  // the complete Core Double renderer continues unchanged here
}
```

Add a sibling button `#replaceWeak2` to the core `#replaceOvl`. Extend `openReplacement(pid, availableRoles)` so `#replaceWeak`, `#replaceWeak2`, and `#replaceMain` are visible only when their role is present in `availableRoles`.

When `tripleClientAvailable` is false, retain the completed Core `selectOrReplacePlayer()` and `applyReplacement()` Double bodies unchanged. Otherwise use `rallyApi.selectPlayer()` inside `selectOrReplacePlayer(pid)`. When it returns `needsReplacement`, call `openReplacement(pid, result.roles)` without mutating picks. Extend `applyReplacement(pid, role)` to rerun `rallyApi.selectPlayer(cur, pid, mode, role)`, close `#replaceOvl`, render, and call `stageBroadcast()`. Bind `#replaceWeak2` to `applyReplacement(pendingReplacementPid, 'weak2')`. Role buttons call `rallyApi.movePlayerToRole()` and then render/stage. Double keeps its existing two-role swap control; Triple never renders it.

Remove every remaining `role === 'main' ? ... : 'weak'` display fallback for live/staged rally roles. Sacrifice 2 must never be mislabeled as Sacrifice 1, while both may retain the existing Sacrifice color family on the radar.

- [ ] **Step 9: Make staging mode-aware and reconcile every kingdom snapshot**

Replace `stageBroadcast()` with:

```js
function stageBroadcast() {
  if (!roomPw || !sock) return;
  var record = rallyModeRecord(fireKingdom);
  var cur = rallyApi.reconcilePicks(pickedByK[fireKingdom], record.mode);
  sock.send({
    t: 'stage', password: roomPw,
    staged: {
      kingdom: fireKingdom,
      modeRevision: record.revision,
      pairs: cur.map(function (pick) { return { pid: pick.pid, role: pick.role }; })
    }
  });
}
```

In `onState()`, make the server's staged pairs authoritative for both kingdoms before rendering. Remove the core plan's conditional `if (roomPw && !picksTouched)` rehydration block, the `picksTouched` declaration, and its assignments; no commander keeps a private stale staging copy:

```js
[1, 2].forEach(function (kingdom) {
  var mode = r.rallyModes && r.rallyModes[kingdom] && r.rallyModes[kingdom].mode || 'double';
  var staged = r.live && r.live.staged && r.live.staged[kingdom];
  var canonicalPairs = staged && Array.isArray(staged.pairs) ? staged.pairs : [];
  pickedByK[kingdom] = rallyApi.reconcilePicks(canonicalPairs, mode)
    .filter(function (pick) { return !!nextPlayers[pick.pid]; });
});
```

- [ ] **Step 10: Add exact bilingual copy**

Add these keys to both dictionaries:

```js
// Chinese
mode_double: '双集结', mode_triple: '三集结', slot_weak1: '消耗 1', slot_weak2: '消耗 2',
rally_mode_saved: '集结模式已同步', confirm_drop_weak2: '切回双集结会移除 {n} 的消耗 2 位置。继续？',
mode_changed_elsewhere: '另一位指挥已更改集结模式，已同步最新状态', mode_unavailable: '当前房间暂不支持三集结',
firetri: '⚔️ 点两下发三集结', need3: '请选择消耗 1、消耗 2 和主力三名车头',

// English
mode_double: 'Double Rally', mode_triple: 'Triple Rally', slot_weak1: 'Sacrifice 1', slot_weak2: 'Sacrifice 2',
rally_mode_saved: 'Rally mode synced', confirm_drop_weak2: 'Switching to Double removes {n} from Sacrifice 2. Continue?',
mode_changed_elsewhere: 'Another commander changed the rally mode; latest state synced', mode_unavailable: 'Triple Rally is unavailable in this room',
firetri: '⚔️ Double-tap for Triple Rally', need3: 'Select Sacrifice 1, Sacrifice 2, and Main'
```

- [ ] **Step 11: Run focused selection and full unit regressions**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test test/kvk-rally-client.test.cjs
npm test
```

Expected: all tests pass; pure selection fills roles in order, never silently replaces a fourth player, and swaps occupied roles without loss. Mobile overflow and two-commander convergence are verified by Task 9 after the complete browser surface exists.

- [ ] **Step 12: Commit mode and selection UX**

```bash
git add kingshoter/public/kvk-rally.js kingshoter/test/kvk-rally-client.test.cjs kingshoter/public/kvk.html kingshoter/public/kvk.js kingshoter/public/app.css
git commit -m "feat: select triple rally captains by kingdom"
```

### Task 8: Triple Fire, Dynamic Status, and Exact Personal Lead

**Files:**
- Modify: `kingshoter/public/kvk.js:375-413,739-841,980-1000`
- Create: `kingshoter/test/triple-client-source.test.cjs`
- Modify: `kingshoter/test/lead-timing.cjs`
- Modify: `kingshoter/test/command-scope.test.cjs`

**Interfaces:**
- Produces `fireTriple()` and `fireCurrentRally()` while preserving `fireDouble()` unchanged.
- The existing `#fireDouble` DOM ID and double-tap gesture remain stable for old tests and bookmarks.

- [ ] **Step 1: Run impact analysis for Fire/status symbols**

```text
gitnexus_impact({repo:"kingshot", target:"fireDouble", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"refreshSyncPill", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
gitnexus_impact({repo:"kingshot", target:"tapFire", file_path:"kingshoter/public/kvk.js", direction:"upstream", includeTests:true})
```

Expected: report the timing/status blast radius. Do not edit the `fireDouble()` body.

- [ ] **Step 2: Write failing source-contract tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('client ships an explicit Triple request and retains Double Fire', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');
  assert.match(source, /function fireDouble\(\)/);
  assert.match(source, /function fireTriple\(\)/);
  assert.match(source, /type:\s*["']triple_rally["']/);
  assert.match(source, /function fireCurrentRally\(\)/);
  assert.doesNotMatch(source, /counter_rally|anti_rally/);
});

test('server remains the Triple timing authority', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/kvk.js'), 'utf8');
  const triple = source.slice(source.indexOf('function fireTriple'), source.indexOf('function fireCurrentRally'));
  assert.doesNotMatch(triple, /pressUTC|march\s*:/);
  assert.match(triple, /modeRevision/);
  assert.match(triple, /leadSeconds/);
});
```

- [ ] **Step 3: Run and verify Triple Fire is absent**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && node --test test/triple-client-source.test.cjs`

Expected: FAIL because `fireTriple()` and `fireCurrentRally()` do not exist.

- [ ] **Step 4: Add Triple Fire without client timing arithmetic**

```js
function fireTriple() {
  var record = rallyModeRecord(fireKingdom);
  var cur = rallyApi.reconcilePicks(pickedByK[fireKingdom], 'triple');
  var roles = new Set(cur.map(function (pick) { return pick.role; }));
  if (cur.length !== 3 || !['weak', 'weak2', 'main'].every(function (role) { return roles.has(role); })) {
    window.toast(tk('need3'));
    return;
  }
  var canonical = cur.map(function (pick) { return canonicalPick(pick.pid, pick.role, room.players); });
  if (canonical.some(function (pick) { return !pick || !pick.march; })) {
    window.toast(tk('nomarch'));
    return;
  }
  gateSync(function () {
    if (canonical.some(function (pick) { return !isReady(room.players[pick.pid]); })) window.toast(tk('cap_absent'));
    var ok = sock.send({
      t: 'cmd', password: roomPw,
      cmd: {
        type: 'triple_rally', kingdom: fireKingdom, modeRevision: record.revision,
        payload: {
          leadSeconds: lead,
          pairs: canonical.map(function (pick) { return { pid: pick.pid, role: pick.role }; })
        }
      }
    });
    window.toast(ok ? tk('fired') : tk('notconn'));
  });
}

function fireCurrentRally() {
  if (rallyMode(fireKingdom) === 'triple') fireTriple();
  else fireDouble();
}
```

- [ ] **Step 5: Make Fire label, enablement, and status cardinality dynamic**

Use one required-count helper:

```js
function requiredCaptains(kingdom) { return rallyMode(kingdom) === 'triple' ? 3 : 2; }

function updateFireControl() {
  var button = $('fireDouble');
  var label = $('t_firedbl');
  var required = requiredCaptains(fireKingdom);
  var valid = rallyApi.reconcilePicks(pickedByK[fireKingdom], rallyMode(fireKingdom));
  button.disabled = valid.length !== required;
  label.textContent = tk(required === 3 ? 'firetri' : 'firedbl');
  $('pickCnt').textContent = valid.length + '/' + required;
}
```

Call `updateFireControl()` from `renderRoster()`, `renderSlots()`, `renderRallyMode()`, and `onState()`. In `refreshSyncPill()`, replace only the literal cardinality expression with:

```js
var required = requiredCaptains(fireKingdom);
el.textContent = tkf('syncp', { n: rn, m: required });
el.className = 'syncpill' + (n === required && rn === required ? ' allgo' : '');
```

Let `tapFire` resolve a dynamic label key while preserving the same three-second double-tap gesture:

```js
function tapFire(btn, labelEl, labelKey, fn) {
  var armed = 0;
  function currentLabelKey() { return typeof labelKey === 'function' ? labelKey() : labelKey; }
  btn.onclick = function () {
    updateFireControl();
    var now = Date.now();
    if (armed && now - armed < 3000) {
      armed = 0;
      labelEl.textContent = tk(currentLabelKey());
      btn.classList.remove('armed');
      try { if (navigator.vibrate) navigator.vibrate(40); } catch (error) {}
      fn();
      return;
    }
    armed = now;
    var token = now;
    labelEl.textContent = tk('tapagain');
    btn.classList.add('armed');
    setTimeout(function () {
      if (armed === token) {
        armed = 0;
        labelEl.textContent = tk(currentLabelKey());
        btn.classList.remove('armed');
      }
    }, 3000);
  };
}

tapFire($('fireDouble'), $('t_firedbl'), function () {
  return rallyMode(fireKingdom) === 'triple' ? 'firetri' : 'firedbl';
}, fireCurrentRally);
```

Calling `updateFireControl()` before arming ensures a remote mode change cannot leave a stale label during the confirmation window.

- [ ] **Step 6: Preserve the full Double timing matrix and scope tests**

Add `triple_rally` to the allowed launch types in `command-scope.test.cjs`, while retaining assertions that no counter-rally artifacts exist. Do not change any expected `pressUTC`, T-10, T-5, or GO value in `lead-timing.cjs`.

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test test/triple-client-source.test.cjs test/command-scope.test.cjs
for lead in 10 15 30 60; do node test/lead-timing.cjs http://127.0.0.1:8791 "$lead"; done
```

Expected: source and scope tests pass; each Double lead run exits 0 with the original formula.

- [ ] **Step 7: Commit Triple Fire**

```bash
git add kingshoter/public/kvk.js kingshoter/test/triple-client-source.test.cjs kingshoter/test/lead-timing.cjs kingshoter/test/command-scope.test.cjs
git commit -m "feat: fire triple rallies without changing double timing"
```

### Task 9: Isolated Multi-Browser Triple QA

**Files:**
- Create: `kingshoter/test/qa-kvk-triple.spec.cjs`
- Create: `kingshoter/playwright.qa-kvk-triple.config.cjs`
- Modify: `kingshoter/package.json`

**Interfaces:**
- Consumes `makeQaRoom(testInfo)`, `qaRoomUrl(baseURL, room, params)`, and `installQaWebSocketGuard(context, room, options)` from `test/support/qa-kvk.cjs`.
- Mirrors the Reliable plan's Chromium, Firefox, WebKit, production opt-in, timeouts, and diagnostics in a separate Triple config so neither plan overwrites the other's `testMatch` or web server.
- Local Triple QA defaults its QA-only Worker gate on and its global gate off. Remote Triple QA relies on the deployed QA-only gate.

- [ ] **Step 1: Create a separate Triple Playwright config with the same safety boundary**

Create `playwright.qa-kvk-triple.config.cjs` exactly:

```js
const { defineConfig, devices } = require('playwright/test');

const remote = String(process.env.QA_BASE_URL || '').trim();
const baseURL = remote || 'http://127.0.0.1:8799';
const production = /^https:\/\/(?:www\.)?kingshoter\.com(?:\/|$)/i.test(baseURL);

if (production && process.env.ALLOW_PRODUCTION_QA !== '1') {
  throw new Error('production_qa_requires_ALLOW_PRODUCTION_QA_1');
}

const tripleQa = process.env.QA_TRIPLE_ENABLED === '0' ? '0' : '1';

module.exports = defineConfig({
  testDir: './test',
  testMatch: /qa-kvk-triple\.spec\.cjs/,
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
    command: `npx wrangler dev --local --port 8799 --var TRIPLE_RALLY_ENABLED:0 --var TRIPLE_RALLY_QA_ENABLED:${tripleQa}`,
    url: 'http://127.0.0.1:8799/api/time',
    reuseExistingServer: false,
    timeout: 120000
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ]
});
```

- [ ] **Step 2: Write the complete failing multi-context test**

```js
const { test, expect } = require('playwright/test');
const {
  makeQaRoom,
  qaRoomUrl,
  installQaWebSocketGuard
} = require('./support/qa-kvk.cjs');

const PASSWORD = 'qa-triple-password';

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/build');
  expect(response.ok()).toBe(true);
  const metadata = await response.json();
  expect(metadata.tripleQaEnabled).toBe(true);
  const expectedGlobal = process.env.EXPECT_TRIPLE_GLOBAL ?? (process.env.QA_BASE_URL ? '' : '0');
  if (expectedGlobal !== '') expect(metadata.tripleEnabled).toBe(expectedGlobal === '1');
});

async function openActor(browser, baseURL, room, player, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 1100 }, locale: 'en-US' });
  await installQaWebSocketGuard(context, room, options.guard || {});
  for (const script of options.blockScripts || []) {
    await context.route(`**/${script}*`, (route) => route.abort());
  }
  if (player) {
    await context.addInitScript(({ roomName, profile }) => {
      localStorage.setItem(`kingshoter_r_${roomName}_me`, JSON.stringify(profile));
    }, { roomName: room, profile: { ...player, marchRevision: 0, identityMode: 'playerId' } });
  }
  const page = await context.newPage();
  await page.goto(qaRoomUrl(baseURL, room, { notour: '1' }));
  await page.locator('#soundGate').click({ force: true }).catch(() => {});
  return { context, page };
}

async function unlock(page, password) {
  await page.locator('#cmdUnlock').click();
  await page.locator('#pwInput').fill(password);
  await page.locator('#pwGo').click();
  await expect(page.locator('#console')).toBeVisible();
}

async function clickCaptain(page, pid) {
  await page.locator(`#roster .rp[data-pid="${pid}"]`).click();
}

async function roomState(page, room) {
  return page.evaluate(async (roomName) => {
    const response = await fetch(`/api/ws?room=${encodeURIComponent(roomName)}`);
    return (await response.json()).room;
  }, room);
}

test('per-kingdom Triple syncs, selects explicitly, lands correctly, and preserves audience', async ({ browser, baseURL }, testInfo) => {
  const room = makeQaRoom(testInfo);
  const profiles = {
    weak1: { pid: '910000001', name: 'Weak One', march: 20 },
    weak2: { pid: '910000002', name: 'Weak Two', march: 47 },
    main: { pid: '910000003', name: 'Main', march: 31 },
    fourth: { pid: '910000004', name: 'Fourth', march: 35 },
    member: { pid: '910000005', name: 'Member', march: 40 }
  };
  const actors = {};
  const commanderFrames = [];
  for (const [name, profile] of Object.entries(profiles)) actors[name] = await openActor(browser, baseURL, room, profile);
  actors.commanderA = await openActor(browser, baseURL, room, profiles.weak1, {
    guard: { shouldDropClientMessage: ({ data }) => {
      try {
        const value = JSON.parse(String(data));
        if (value.t === 'cmd') commanderFrames.push(value);
      } catch (error) {}
      return false;
    } }
  });
  actors.commanderB = await openActor(browser, baseURL, room, null);

  await expect(actors.commanderA.page.locator('#roster .rp')).toHaveCount(5);
  await unlock(actors.commanderA.page, PASSWORD);
  await unlock(actors.commanderB.page, PASSWORD);

  await actors.commanderA.page.locator('#tripleMode').check();
  await expect(actors.commanderB.page.locator('#tripleMode')).toBeChecked();
  let state = await roomState(actors.commanderA.page, room);
  expect(state.rallyModes['1']).toEqual({ mode: 'triple', revision: 1 });
  expect(state.rallyModes['2']).toEqual({ mode: 'double', revision: 0 });

  await clickCaptain(actors.commanderA.page, profiles.weak1.pid);
  await clickCaptain(actors.commanderA.page, profiles.weak2.pid);
  await clickCaptain(actors.commanderA.page, profiles.main.pid);
  await expect(actors.commanderA.page.locator('#pickCnt')).toHaveText('3/3');
  await expect(actors.commanderB.page.locator('#pickSlots')).toContainText('Weak Two');

  await actors.commanderA.page.setViewportSize({ width: 375, height: 1000 });
  expect(await actors.commanderA.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await actors.commanderB.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await clickCaptain(actors.commanderA.page, profiles.fourth.pid);
  await expect(actors.commanderA.page.locator('#replaceOvl')).toBeVisible();
  await expect(actors.commanderA.page.locator('#replaceWeak2')).toBeVisible();
  await expect(actors.commanderA.page.locator('#pickCnt')).toHaveText('3/3');
  await actors.commanderA.page.locator('#replaceCancel').click();

  await actors.commanderA.page.locator('#lead button[data-v="10"]').click();
  await actors.commanderA.page.locator('#fireDouble').click();
  await actors.commanderA.page.locator('#fireDouble').click();

  await expect.poll(() => commanderFrames.filter((frame) => frame.cmd && frame.cmd.type === 'triple_rally').length).toBe(1);
  expect(commanderFrames.find((frame) => frame.cmd && frame.cmd.type === 'triple_rally').cmd.payload.pairs.map((pair) => pair.role))
    .toEqual(['weak', 'weak2', 'main']);

  await expect.poll(async () => (await roomState(actors.commanderA.page, room)).live.commands['1']?.type).toBe('triple_rally');
  state = await roomState(actors.commanderA.page, room);
  const command = state.live.commands['1'];
  const byRole = Object.fromEntries(command.payload.pairs.map((pair) => [pair.role, pair]));
  expect(byRole.weak.pressUTC + byRole.weak.march).toBe(byRole.weak2.pressUTC + byRole.weak2.march);
  expect(byRole.main.pressUTC + byRole.main.march).toBe(byRole.weak.pressUTC + byRole.weak.march + 1);
  expect(Math.min(...command.payload.pairs.map((pair) => pair.pressUTC))).toBe(command.payload.firstPress);
  expect(command.payload.leadSeconds).toBe(10);

  await expect.poll(async () => {
    const latest = await roomState(actors.commanderA.page, room);
    return Object.fromEntries((latest.live.commands['1'].delivery || []).map((entry) => [entry.pid, [entry.expected, entry.received]]));
  }).toEqual({
    [profiles.weak1.pid]: [2, 2],
    [profiles.weak2.pid]: [1, 1],
    [profiles.main.pid]: [1, 1]
  });

  for (const profile of [profiles.weak1, profiles.weak2, profiles.main]) {
    await expect(actors.commanderA.page.locator(`#pickSlots .slot[data-pid="${profile.pid}"] .delivery.received`))
      .toContainText('Received');
  }

  for (const actorName of ['weak1', 'weak2', 'main']) {
    const target = command.payload.pairs.find((pair) => pair.pid === profiles[actorName].pid);
    await expect.poll(async () => actors[actorName].page.evaluate(({ id, at }) => {
      return Object.entries(window.__cues || {}).some(([key, cue]) =>
        key.startsWith(`${id}-me:`) && Math.abs(cue.t - at) < 1);
    }, { id: command.id, at: (target.pressUTC - 10) * 1000 })).toBe(true);
  }

  const cueBases = (page) => page.evaluate((id) =>
    [...new Set(Object.values(window.__cues || {}).filter((cue) => cue.base && cue.base.startsWith(id)).map((cue) => cue.base))], command.id);
  await expect.poll(() => cueBases(actors.commanderB.page)).toEqual([]);
  await expect.poll(() => cueBases(actors.commanderA.page)).toEqual([`${command.id}-me`]);
  await expect.poll(() => cueBases(actors.member.page)).toEqual([`${command.id}-join`]);

  const legacyType = await actors.commanderA.page.evaluate((roomName) => new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/api/ws?room=${encodeURIComponent(roomName)}&clientBuild=0`);
    ws.onerror = () => reject(new Error('legacy socket failed'));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.t === 'state') {
        const type = message.room.live.commands['1'].type;
        ws.close();
        resolve(type);
      }
    };
  }), room);
  expect(legacyType).toBe('double_rally');

  for (const actor of Object.values(actors)) await actor.context.close();
});

test('switching back to Double clears only Sacrifice 2 on every commander', async ({ browser, baseURL }, testInfo) => {
  const room = makeQaRoom(testInfo);
  const players = [
    { pid: '920000001', name: 'Keep Weak', march: 20 },
    { pid: '920000002', name: 'Drop Weak Two', march: 30 },
    { pid: '920000003', name: 'Keep Main', march: 40 }
  ];
  const playerActors = [];
  for (const player of players) playerActors.push(await openActor(browser, baseURL, room, player));
  const commanderA = await openActor(browser, baseURL, room, null);
  const commanderB = await openActor(browser, baseURL, room, null);
  await expect(commanderA.page.locator('#roster .rp')).toHaveCount(3);
  await unlock(commanderA.page, PASSWORD);
  await unlock(commanderB.page, PASSWORD);
  await commanderA.page.locator('#tripleMode').check();
  for (const player of players) await clickCaptain(commanderA.page, player.pid);
  await expect(commanderB.page.locator('#pickSlots')).toContainText('Drop Weak Two');
  await commanderA.page.evaluate(() => window.confirm = () => true);
  await commanderA.page.locator('#tripleMode').uncheck();
  await expect(commanderB.page.locator('#tripleMode')).not.toBeChecked();
  const state = await roomState(commanderA.page, room);
  expect(state.rallyModes['1'].mode).toBe('double');
  expect(state.live.staged['1'].pairs).toEqual([
    { pid: players[0].pid, role: 'weak' },
    { pid: players[2].pid, role: 'main' }
  ]);
  await expect(commanderB.page.locator('#pickSlots')).not.toContainText('Drop Weak Two');
  await expect(commanderB.page.locator('#pickSlots')).toContainText('Keep Weak');
  await expect(commanderB.page.locator('#pickSlots')).toContainText('Keep Main');
  for (const actor of playerActors) await actor.context.close();
  await commanderA.context.close();
  await commanderB.context.close();
});

test('Triple slots show truthful Received and No confirmation states', async ({ browser, baseURL }, testInfo) => {
  const room = makeQaRoom(testInfo);
  const players = [
    { pid: '930000001', name: 'Ack Weak', march: 20 },
    { pid: '930000002', name: 'Dropped Weak Two', march: 30 },
    { pid: '930000003', name: 'Ack Main', march: 40 }
  ];
  const actors = [];
  actors.push(await openActor(browser, baseURL, room, players[0]));
  actors.push(await openActor(browser, baseURL, room, players[1], {
    guard: { shouldDropClientMessage: ({ data }) => {
      try { return JSON.parse(String(data)).t === 'deliveryAck'; } catch (error) { return false; }
    } }
  }));
  actors.push(await openActor(browser, baseURL, room, players[2]));
  const commander = await openActor(browser, baseURL, room, null);
  await expect(commander.page.locator('#roster .rp')).toHaveCount(3);
  await unlock(commander.page, PASSWORD);
  await commander.page.locator('#tripleMode').check();
  for (const player of players) await clickCaptain(commander.page, player.pid);
  await commander.page.locator('#lead button[data-v="10"]').click();
  await commander.page.locator('#fireDouble').click();
  await commander.page.locator('#fireDouble').click();
  await expect(commander.page.locator(`#pickSlots .slot[data-pid="${players[0].pid}"] .delivery.received`)).toContainText('Received');
  await expect(commander.page.locator(`#pickSlots .slot[data-pid="${players[2].pid}"] .delivery.received`)).toContainText('Received');
  await expect(commander.page.locator(`#pickSlots .slot[data-pid="${players[1].pid}"] .delivery.missing`)).toContainText('No confirmation');
  for (const actor of actors) await actor.context.close();
  await commander.context.close();
});

test('missing optional Triple and updater scripts preserve default Double Fire and personal countdown', async ({ browser, baseURL }, testInfo) => {
  const room = makeQaRoom(testInfo);
  const main = await openActor(browser, baseURL, room, { pid: '940000002', name: 'Fallback Main', march: 31 });
  const commander = await openActor(browser, baseURL, room,
    { pid: '940000001', name: 'Fallback Weak', march: 20 },
    { blockScripts: ['kvk-rally.js', 'kvk-update.js'] });
  await expect(commander.page.locator('#roster .rp')).toHaveCount(2);
  await unlock(commander.page, PASSWORD);
  await expect(commander.page.locator('#rallyModeControl')).toBeHidden();
  await clickCaptain(commander.page, '940000001');
  await clickCaptain(commander.page, '940000002');
  await commander.page.locator('#lead button[data-v="10"]').click();
  await commander.page.locator('#fireDouble').click();
  await commander.page.locator('#fireDouble').click();
  await expect.poll(async () => (await roomState(commander.page, room)).live.commands['1']?.type).toBe('double_rally');
  const command = (await roomState(commander.page, room)).live.commands['1'];
  await expect(commander.page.locator('#pickSlots .delivery.received')).toHaveCount(2);
  await expect.poll(() => commander.page.evaluate((id) =>
    Object.keys(window.__cues || {}).some((key) => key.startsWith(`${id}-me:`)), command.id)).toBe(true);
  await main.context.close();
  await commander.context.close();
});
```

- [ ] **Step 3: Run Chromium first and verify RED**

Run: `cd /Users/ff/Documents/kingshot/kingshoter && npx playwright test -c playwright.qa-kvk-triple.config.cjs --project=chromium test/qa-kvk-triple.spec.cjs`

Expected before Tasks 4–8: FAIL on the missing `#tripleMode` or absent `triple_rally`. Expected after Tasks 4–8: PASS.

- [ ] **Step 4: Add focused package commands**

Merge these scripts into `package.json`:

```json
{
  "test:triple": "node --test test/rally-mode.test.cjs test/rally-targets.test.cjs test/client-build.test.cjs test/kvk-rally-client.test.cjs test/kvk-update.test.cjs test/triple-room.test.cjs test/triple-client-source.test.cjs",
  "test:qa:triple": "playwright test -c playwright.qa-kvk-triple.config.cjs test/qa-kvk-triple.spec.cjs"
}
```

- [ ] **Step 5: Run all browser projects**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npx playwright install chromium firefox webkit
npm run test:triple
npm run test:qa:triple
```

Expected: Triple unit tests pass; Chromium, Firefox, and WebKit projects pass. These results prove browser logic, not physical background audio.

- [ ] **Step 6: Commit isolated Triple QA**

```bash
git add kingshoter/test/qa-kvk-triple.spec.cjs kingshoter/playwright.qa-kvk-triple.config.cjs kingshoter/package.json
git commit -m "test: verify triple rally across isolated browsers"
```

### Task 10: Bootstrap Deployment, Physical Gate, Full Enablement, and Rollback

**Files:**
- Create: `docs/operations/kvk-triple-rollout.md`
- Modify after all gates pass: `kingshoter/wrangler.toml`
- Modify after all gates pass: `kingshoter/src/client-build.js`
- Modify after all gates pass: `kingshoter/test/client-build.test.cjs`

**Interfaces:**
- Consumes all prior test commands and the Reliable plan's production-QA runner.
- Produces a durable evidence log and one global enable/disable procedure; it never targets a named operation room.

- [ ] **Step 1: Create the exact rollout record before deploying**

```markdown
# KvK Triple Rally Rollout Record

## Immutable safety rules

- Automated tests use only generated `qa-kvk-*` rooms.
- Every non-QA room is an operation room; no room receives a special branch.
- Double remains available and default.
- `TRIPLE_RALLY_ENABLED` remains `0` until every required row below passes; `TRIPLE_RALLY_QA_ENABLED=1` is allowed only because server-side room validation limits it to `qa-kvk-*`.
- A rollback blocks new Triple commands but does not interrupt an active command.

## Automated evidence

| Gate | Required command | Status |
|---|---|---|
| Unit | `npm test && npm run test:triple` | Not run |
| Browser QA | `npm run test:qa:delivery && npm run test:qa:triple` | Not run |
| Double leads | `lead-timing.cjs` for 10/15/30/60 | Not run |
| Dry deploy | `npx wrangler deploy --dry-run` | Not run |
| QA smoke | generated `qa-kvk-*` against deployed build | Not run |

## Physical-device evidence

| Platform | Foreground | Switch to Kingshot | Background | Lock screen | Reconnect | Audio interruption | Received UI | Result |
|---|---|---|---|---|---|---|---|---|
| iOS | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Pending |
| Android | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Pending |
| macOS | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Pending |
| Windows | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Pending |

For every physical run, append the UTC timestamp, browser/version, generated QA room, selected lead, three march values, observed personal countdown start, observed GO, exact slot `Received` state, and whether any duplicate or stale cue occurred.

## Enablement decision

The gate may change to `1` only when all automated rows are PASS, every platform row is PASS, Double has zero regression, and no selected captain misses or duplicates a cue.

## Rollback command

Set `TRIPLE_RALLY_ENABLED = "0"` and keep `TRIPLE_RALLY_QA_ENABLED = "1"` in `wrangler.toml`, then run `npx wrangler deploy`.

After rollback, run the focused local both-gates-off regression to verify K1/K2 normalize to Double, Double Fire works, and an already-active Triple command remains immutable. In production the QA-only gate intentionally stays on, so deployed `qa-kvk-*` rooms continue to expose Triple for diagnostics; do not use them as evidence of operation-room mode.
```

- [ ] **Step 2: Run the complete local verification gate and record real outputs**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm test
npm run test:triple
npm run test:qa:delivery
npm run test:qa:triple
node --check src/worker.js
node --check src/room.js
node --check public/app.js
node --check public/kvk.js
npx wrangler deploy --dry-run
```

Expected: every command exits 0. Replace each corresponding `Not run` cell with `PASS`, the actual ISO-8601 UTC timestamp, and the observed pass count or Wrangler deployment identifier. Never record a result that was not observed.

- [ ] **Step 3: Deploy the updater bootstrap with global Triple disabled and QA Triple enabled**

Confirm `wrangler.toml` contains exactly these keys in its single `[vars]` section, then deploy the checked-in configuration:

```toml
[vars]
TRIPLE_RALLY_ENABLED = "0"
TRIPLE_RALLY_QA_ENABLED = "1"
```

Run: `cd /Users/ff/Documents/kingshot/kingshoter && npx wrangler deploy`

Expected: Wrangler reports a successful deployment. Then run:

```bash
curl -fsS -D - https://kingshoter.com/api/build
```

Expected response: HTTP 200, `Cache-Control: no-store, max-age=0`, `currentBuild: 2026071302`, `tripleEnabled: false`, and `tripleQaEnabled: true`.

- [ ] **Step 4: Run deployed multi-browser QA only in a generated QA room**

Run `QA_BASE_URL=https://kingshoter.com ALLOW_PRODUCTION_QA=1 EXPECT_TRIPLE_GLOBAL=0 npm run test:qa:triple`. The spec itself calls `makeQaRoom(testInfo)`; do not accept a caller-supplied room name. The remote config never starts a local Worker or changes the deployed gates.

Expected: all browser projects pass against a generated `qa-kvk-*` room. The shared WebSocket guard rejects any URL whose room differs from the generated room before connecting, and `/api/build` proves the deployed bootstrap is global-off/QA-on.

- [ ] **Step 5: Execute and record the physical-device matrix**

For each platform row, use a newly generated QA room and three distinct canonical march times. Exercise 10, 15, 30, and 60 across the matrix, including one commander-selected-as-captain run and one unselected-commander run.

Expected for PASS: all three personal countdowns begin at the selected number; Sacrifice landings are equal; Main is one second later; the ordinary member receives one JOIN; the unselected commander is silent; every selected captain that scheduled a cue appears as `Received` on the commander UI; no duplicate/stale GO occurs. If any required device is unavailable or any cell fails, keep `TRIPLE_RALLY_ENABLED=0`, record the evidence, and continue other independent plans without enabling Triple.

- [ ] **Step 6: Enable all operation rooms together only after every gate passes**

Use two distinct deployments. First raise the updater minimum to the already-deployed Triple-capable build while keeping global Triple off:

```js
export const CURRENT_KVK_BUILD = 2026071302;
export const MIN_KVK_BUILD = 2026071302;
export const MIN_TRIPLE_BUILD = 2026071302;
```

Update the build-metadata unit expectation to `minKvkBuild: 2026071302`, run `node --test test/client-build.test.cjs test/kvk-update.test.cjs`, and confirm a stale-build controller uses `location.replace()` while an active personal countdown defers replacement until its cue is complete. Keep the gates at global `0`, QA `1`, deploy this minimum-build change, and wait at least one complete 60-second update polling interval. Then run deployed QA again with `EXPECT_TRIPLE_GLOBAL=0`; all fresh contexts must report build `2026071302`. Keep the legacy per-socket projection bridge in place until a later release has independent evidence that no old-build sockets remain.

Only after that separate update deployment and QA pass, change the platform gates exactly:

```toml
[vars]
TRIPLE_RALLY_ENABLED = "1"
TRIPLE_RALLY_QA_ENABLED = "1"
```

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npx wrangler deploy --dry-run
npx wrangler deploy
curl -fsS https://kingshoter.com/api/build
```

Expected: tests, dry run, and the second deployment succeed; build metadata returns `minKvkBuild:2026071302`, `tripleEnabled:true`, and `tripleQaEnabled:true`. Run deployed QA once more with `EXPECT_TRIPLE_GLOBAL=1`. This is one full-platform enablement, not an operation-room canary, and it never combines the minimum-build raise with the global gate change.

- [ ] **Step 7: Verify rollback semantics locally, then roll back production without touching an operation room**

Use the focused Durable Object regression added in Task 4; it seeds an active immutable Triple command, disables both gates, and verifies that mode/staging normalize while the active command object stays byte-for-byte unchanged.

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test --test-name-pattern="rollback normalizes future mode" test/triple-room.test.cjs
```

Expected locally: the test passes; mode storage converges to Double, staged `weak2` is removed, and the active `triple_rally` command remains the same object for existing cue completion.

For the production rollback, change only `TRIPLE_RALLY_ENABLED` back to `"0"`, retain `TRIPLE_RALLY_QA_ENABLED="1"`, run `npx wrangler deploy`, and verify `/api/build` reports `tripleEnabled:false` and `tripleQaEnabled:true`. Do not connect an automated test to any non-QA room. Restore the global gate to `1` only if every enablement gate is still recorded PASS.

- [ ] **Step 8: Commit the evidence and final gate value**

Before committing, run staged GitNexus change detection. Then:

```bash
git add docs/operations/kvk-triple-rollout.md kingshoter/wrangler.toml kingshoter/src/client-build.js kingshoter/test/client-build.test.cjs
git commit -m "ops: gate the triple rally rollout"
```

Expected: the commit contains the actual evidence record and the deployed global gate value only.

## Plan Completion Verification

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm test
npm run test:triple
npm run test:qa:delivery
npm run test:qa:triple
npx wrangler deploy --dry-run
```

Expected: all commands exit 0. Confirm from the rollout record that no operation room was used for QA, Double 10/15/30/60 remained unchanged, and the deployed gate matches the recorded evidence.
