# KvK Compact Ready Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the redundant idle-ready sentence and keep the healthy audio status to one line on phones, then publish it only to an isolated Cloudflare QA Worker.

**Architecture:** Leave all audio and tactical functions unchanged. Apply the UX adjustment entirely through the static HTML target, translation literals, and `.astat` CSS. Deploy through a dedicated `kingshoter-qa` configuration with its own Durable Object namespace and no production bindings.

**Tech Stack:** Static HTML/CSS/JavaScript, Node test runner, Cloudflare Workers, Durable Objects.

## Global Constraints

- Do not edit `paintAudioStatus` or `paintHero`.
- Do not alter audio readiness, countdown, Fire, Defense, commander, WebSocket, or room-state behavior.
- Do not upload or deploy this candidate to the production `kingshoter` Worker or `kingshoter.com`.
- The QA Worker must not bind production routes, cron triggers, `GIFT_KV`, `MASTER`, or another Worker's Durable Object.
- Use only a newly generated lowercase `qa-kvk-*` room for online mutation.
- Keep build `2026071505` for the unique preview origin.

---

### Task 1: Compact idle and audio-ready copy

**Files:**
- Modify: `test/kvk-home-layout.test.cjs`
- Modify: `test/coldux.cjs`
- Modify: `public/kvk.html`
- Modify: `public/kvk.js`
- Modify: `public/app.css`

**Interfaces:**
- Consumes: existing `#youChip`, `#audioStatus`, `tk("as_on")`, and `.astat` rendering.
- Produces: no idle-ready DOM line and a one-line healthy status chip.

- [ ] **Step 1: Write the failing regression test**

Add a test that reads the HTML, JavaScript, and CSS and asserts:

```js
assert.doesNotMatch(html, /id="idleWait"/);
assert.doesNotMatch(source, /idle_wait:/);
assert.match(source, /as_on: "🔊 提醒已开启 · 可切回游戏"/);
assert.match(source, /as_on: "🔊 Alerts on · switch to game"/);
assert.match(css, /\.astat\{[^}]*white-space:nowrap[^}]*overflow:hidden[^}]*text-overflow:ellipsis/);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/kvk-home-layout.test.cjs`

Expected: the new compact-copy test fails because the idle element and long/wrapping status still exist.

- [ ] **Step 3: Apply the minimal static implementation**

Remove the `#idleWait` element from `public/kvk.html`, remove the two now-unused `idle_wait` literals, change only the two `as_on` translation literals in `public/kvk.js`, update the legacy audit to expect no `#idleWait`, and add `white-space:nowrap;overflow:hidden;text-overflow:ellipsis` to `.astat` in `public/app.css`.

- [ ] **Step 4: Confirm GREEN and run full verification**

Run:

```bash
node --test test/kvk-home-layout.test.cjs
npm test
npm run test:triple
npm run test:delivery
node --check public/kvk.js
git diff --check
```

Expected: every command exits 0 with no failures.

- [ ] **Step 5: Audit and commit**

Run GitNexus change detection and confirm only static presentation plus the regression test are affected. Commit the scoped files.

### Task 2: Define the isolated online QA Worker

**Files:**
- Create: `wrangler.qa.toml`
- Create: `test/qa-worker-config.test.cjs`

**Interfaces:**
- Consumes: committed Worker bundle and the existing `Room` class.
- Produces: a reviewed `kingshoter-qa` configuration with an isolated Durable Object namespace and no production bindings.

- [ ] **Step 1: Write the failing QA-config safety test**

Create a Node test that asserts the future config uses `name = "kingshoter-qa"`, `workers_dev = true`, the local `Room` binding and `v1` migration, and contains none of `routes`, `triggers`, `kv_namespaces`, `GIFT_KV`, `MASTER`, or `script_name`.

Run: `node --test test/qa-worker-config.test.cjs`

Expected: FAIL because `wrangler.qa.toml` does not exist.

- [ ] **Step 2: Add the isolated Wrangler config and confirm GREEN**

Create `wrangler.qa.toml` with `name`, `main`, `compatibility_date`, `workers_dev`, `preview_urls`, Triple vars, static assets, `ROOM`, and the `v1` `Room` migration only. Run the focused test and `npx wrangler deploy -c wrangler.qa.toml --dry-run`.

- [ ] **Step 3: Audit and commit the QA boundary**

Run GitNexus change detection, inspect the dry-run bindings, and commit only `wrangler.qa.toml` and `test/qa-worker-config.test.cjs` after confirming the production route, cron, KV, secrets, and cross-Worker bindings are absent.

### Task 3: Deploy and seed the isolated QA Worker

**Files:**
- No tracked source changes.

**Interfaces:**
- Consumes: the reviewed `wrangler.qa.toml` from Task 2 and the generated-room helper in `test/support/qa-kvk.cjs`.
- Produces: a public `kingshoter-qa` workers.dev origin and a unique `qa-kvk-*` phone-test URL.

- [ ] **Step 1: Deploy without production traffic**

Run `npx wrangler deploy -c wrangler.qa.toml --tag git-$(git rev-parse --short=12 HEAD) --message "KvK compact ready copy phone QA"`.

Expected: Wrangler deploys only `kingshoter-qa` and returns its workers.dev URL.

- [ ] **Step 2: Generate and verify a QA room**

Generate a new room with `test/support/qa-kvk.cjs`, open `/kvk?room=<room>&notour=1&lang=en&__kvk_build=2026071505` on the preview origin, and verify HTTP 200 plus the new HTML/JS/CSS content.

- [ ] **Step 3: Hand off the phone URL**

Provide the QA Worker link and state explicitly that `kingshoter.com` production traffic and production room storage were not changed.
