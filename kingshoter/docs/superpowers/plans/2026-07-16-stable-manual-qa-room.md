# Stable Manual QA Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the current Cancel Rally manual review to the stable isolated QA room `qa` with commander password `qa` and hand off one permanent short link.

**Architecture:** Keep the deployed `kingshoter-qa` Worker and its isolated Durable Object namespace unchanged. Prepare only the `qa` room through the existing one-shot WebSocket seeder, then verify the restored canonical lineup through HTTP and two visible browser pages. Automated regression continues using generated `qa-kvk-*` rooms.

**Tech Stack:** Cloudflare Worker/Durable Objects, WebSocket protocol, Node.js, in-app Chromium browser.

## Global Constraints

- User-facing manual room is exactly `qa`.
- Commander password is exactly `qa`.
- Origin is exactly `https://kingshoter-qa.kingshot1406.workers.dev`.
- Production routes, bindings, rooms, and data must not be opened or changed.
- Automated tests retain generated room isolation and their source files remain unchanged.

---

### Task 1: Prepare the fixed manual room

**Files:**
- Modify (ignored operational helper): `.superpowers/sdd/seed-cancel-qa.mjs`
- Verify: `wrangler.qa.toml`

**Interfaces:**
- Consumes: deployed client build `2026071506` and the existing Cancel Rally WebSocket sequence.
- Produces: room `qa`, password `qa`, three QA players, and an editable Double lineup restored after Fire → Cancel.

- [ ] **Step 1: Confirm the room is safe to initialize**

Run:

```bash
curl -fsS 'https://kingshoter-qa.kingshot1406.workers.dev/api/ws?room=qa&clientBuild=2026071506'
```

Expected: `hasPw` is `false`, `players` is `{}`, both commands are `null`, and both staged values are `null`.

- [ ] **Step 2: Lock the operational helper to the stable room**

Replace only the helper's generated room/password block with:

```js
const ROOM_PATTERN = /^qa$/;
const room = 'qa';
const password = 'qa';

assert.equal(room, 'qa');
assert.equal(password, 'qa');
assert.match(room, ROOM_PATTERN);
assert.equal(new URL(ORIGIN).hostname, 'kingshoter-qa.kingshot1406.workers.dev');
```

Leave the existing registration, Stage, Fire, Cancel, restored-pair, and duplicate-Cancel assertions unchanged.

- [ ] **Step 3: Verify the helper syntax**

Run:

```bash
node --check .superpowers/sdd/seed-cancel-qa.mjs
```

Expected: exit `0` with no output.

- [ ] **Step 4: Seed the stable room**

Run:

```bash
node .superpowers/sdd/seed-cancel-qa.mjs
```

Expected: `status` is `PASS`, `room` is `qa`, `password` is `qa`, two exact `{pid, role}` pairs are restored, and `duplicateCancelIdempotent` is `true`.

### Task 2: Verify canonical room state

**Files:**
- Read: `.superpowers/sdd/seed-cancel-qa.mjs`
- Read: `src/room.js`

**Interfaces:**
- Consumes: the seeded `qa` Durable Object.
- Produces: proof that the fixed room contains the expected editable restored staging and no live command.

- [ ] **Step 1: Fetch the stable room snapshot**

Run:

```bash
curl -fsS 'https://kingshoter-qa.kingshot1406.workers.dev/api/ws?room=qa&clientBuild=2026071506'
```

Expected:

```js
room.hasPw === true
room.live.commands['1'] === null
room.live.staged['1'].pairs.length === 2
room.live.staged['1'].pairs.map(({ pid, role }) => ({ pid, role }))
// exactly equals the seeder's restoredPairs
```

- [ ] **Step 2: Verify duplicate Cancel remains inert**

Use the helper's existing second Cancel and final HTTP assertion. Expected: serialized restored staging remains byte-for-byte unchanged.

### Task 3: Verify the permanent browser handoff

**Files:**
- Read: `public/kvk.html`
- Read: `public/kvk.js`

**Interfaces:**
- Consumes: `https://kingshoter-qa.kingshot1406.workers.dev/kvk?room=qa&notour=1&lang=en&__kvk_build=2026071506` and password `qa`.
- Produces: one user-facing deliverable tab on the stable URL.

- [ ] **Step 1: Open and unlock the stable room**

Open the exact URL above, enable page alerts, unlock Commander with `qa`, and verify the console shows `2/2`.

- [ ] **Step 2: Verify exact restored UI state**

Assert:

```js
document.querySelectorAll('#pickSlots .slot.filled').length === 2
document.querySelectorAll('#pickSlots .slot.frozen').length === 0
document.querySelector('#pickSlots .slot.weak.filled').dataset.pid === restoredPairs[0].pid
document.querySelector('#pickSlots .slot.main.filled').dataset.pid === restoredPairs[1].pid
document.querySelector('#fireDouble').disabled === false
```

- [ ] **Step 3: Verify reload and synchronization**

Reload the first page and open a second page on the same stable URL. Expected: both pages show the same exact two PIDs/roles, zero frozen slots, enabled Fire, and no browser errors.

- [ ] **Step 4: Finalize the browser handoff**

Keep one `qa` page as `deliverable` and close duplicate or older temporary QA tabs. Give the user only the stable URL and password `qa`.

