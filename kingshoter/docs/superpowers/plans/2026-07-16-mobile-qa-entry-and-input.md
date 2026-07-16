# Mobile QA Entry And Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep production untouched while making the isolated `/kvk` page a stable phone entry for room `qa` and preventing mobile focus zoom on all KvK text-entry controls.

**Architecture:** Reuse the existing no-query room gate and fixed `qa` Durable Object; no room-routing code changes are needed. Add a mobile-only text-control font floor in the shared stylesheet, cover the actual CSS cascade with a Chromium computed-style regression test, and bump the KvK build coherently so stale clients refresh. Deploy only with `wrangler.qa.toml`.

**Tech Stack:** HTML/CSS, Node.js test runner, Playwright Chromium, Cloudflare Workers/Durable Objects.

## Global Constraints

- User-facing QA entry is exactly `https://kingshoter-qa.kingshot1406.workers.dev/kvk`.
- Room name is exactly `qa`; commander password is exactly `qa`.
- Production routes, bindings, rooms, data, and deployment commands must not be opened or changed.
- User pinch zoom remains enabled; do not add `user-scalable=no` or `maximum-scale=1`.
- Existing page typography and layout remain unchanged outside mobile editable controls.
- Required KvK client build becomes exactly `2026071507`.

---

### Task 1: Lock mobile input sizing with a failing computed-style test

**Files:**
- Create: `test/mobile-input-font.test.cjs`
- Read: `public/app.css`
- Read: `public/kvk.html`

**Interfaces:**
- Consumes: the real `app.css` cascade and representative KvK controls.
- Produces: an automated contract for mobile text-entry sizes and preserved prominent march inputs.

- [ ] **Step 1: Write the failing test**

Create a Node test that launches Chromium, injects the real stylesheet into representative KvK markup, and reads `getComputedStyle(element).fontSize` at a 390px viewport. Assert that `#jr`, `#pid`, `#pwInput`, `#rosterSearch`, a roster `.nm`, `textarea`, and `select` are at least 16px; assert `.mmss input` and `.commander-march input` stay 20px. Also assert the viewport meta does not contain `user-scalable=no` or `maximum-scale`.

- [ ] **Step 2: Run the test to verify the current bug**

Run:

```bash
node --test test/mobile-input-font.test.cjs
```

Expected: FAIL because the current room/identity/password inputs compute to 15px.

### Task 2: Apply the smallest mobile-only CSS fix

**Files:**
- Modify: `public/app.css`
- Test: `test/mobile-input-font.test.cjs`

**Interfaces:**
- Consumes: the regression contract from Task 1.
- Produces: text-entry controls that do not trigger iOS focus zoom without changing normal page text.

- [ ] **Step 1: Add the mobile rule**

Append a max-width 820px media query that sets text-entry `input`, `select`, and `textarea` controls to 16px, excludes `range`, `checkbox`, and `radio`, and then explicitly retains 20px for `.mmss input` and `.commander-march input`.

- [ ] **Step 2: Run the focused test**

Run:

```bash
node --test test/mobile-input-font.test.cjs
```

Expected: PASS with all mobile fields at least 16px and march editors exactly 20px.

### Task 3: Advance the enforced build coherently

**Files:**
- Modify: `src/client-build.js`
- Modify: `public/kvk.html`
- Modify: `public/kvk-update.js`
- Modify: `public/kvk-rally.js`
- Modify: build-sensitive `test/*.test.cjs` and `test/*.e2e.cjs` assertions that currently require `2026071506`

**Interfaces:**
- Consumes: existing build enforcement and cache-busted asset tags.
- Produces: exact build `2026071507` across Worker policy, browser modules, HTML assets, and tests.

- [ ] **Step 1: Update all active build constants and cache tags**

Replace active `2026071506` build references with `2026071507`, excluding historical design/plan documents that describe already completed QA work.

- [ ] **Step 2: Verify no active stale build reference remains**

Run:

```bash
rg -n '2026071506' src public test
```

Expected: no output.

### Task 4: Run local regression and QA deployment checks

**Files:**
- Verify: `wrangler.qa.toml`
- Verify: all changed source and test files

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: evidence that identity, rally, triple, delivery, and room behavior remain intact.

- [ ] **Step 1: Run focused and broad regression suites**

Run:

```bash
node --test test/mobile-input-font.test.cjs
npm test
npm run test:triple
npm run test:delivery
npm run test:kvk-core
```

Expected: all commands exit `0`.

- [ ] **Step 2: Validate the QA-only deployment artifact**

Run:

```bash
npx wrangler deploy -c wrangler.qa.toml --dry-run
```

Expected: exit `0`, Worker name `kingshoter-qa`, and no production route.

- [ ] **Step 3: Run GitNexus scope detection and commit**

Run exact-worktree change detection before committing. Expected scope: stylesheet, computed-style test, build constants/tags, and their exact-version assertions only.

### Task 5: Deploy and verify the stable phone flow in isolated QA

**Files:**
- Read: `wrangler.qa.toml`
- Read: live QA `/kvk` and room `qa`

**Interfaces:**
- Consumes: the reviewed commit from Task 4.
- Produces: a stable phone test link that needs no query string.

- [ ] **Step 1: Deploy only the isolated QA Worker**

Run:

```bash
npx wrangler deploy -c wrangler.qa.toml --tag git-<commit> --message 'Mobile QA entry and input zoom fix'
```

Expected: a successful `kingshoter-qa` deployment. Do not run the production `npm run deploy` command.

- [ ] **Step 2: Verify the live entry flow**

At a 390px mobile viewport, open `https://kingshoter-qa.kingshot1406.workers.dev/kvk`, enter `qa`, and submit. Expected: navigation to the existing room `qa`, no horizontal overflow, and a computed font size of at least 16px for the room and identity inputs.

- [ ] **Step 3: Verify commander access and persistent room state**

Unlock with password `qa`; verify the password input is at least 16px and the existing Double staging/players are unchanged after reload and in a second page.

- [ ] **Step 4: Hand off one short link**

Keep one browser page at the no-query `/kvk` entry and provide only the short QA URL plus room/password `qa`.
