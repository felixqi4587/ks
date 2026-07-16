# KvK Compact Ready Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the redundant idle-ready sentence and keep the healthy audio status to one line on phones, then publish only a Cloudflare preview version for QA.

**Architecture:** Leave all audio and tactical functions unchanged. Apply the UX adjustment entirely through the static HTML target, translation literals, and `.astat` CSS, then validate a unique Cloudflare Version preview alias in a generated QA room.

**Tech Stack:** Static HTML/CSS/JavaScript, Node test runner, Cloudflare Workers Versions, Durable Objects.

## Global Constraints

- Do not edit `paintAudioStatus` or `paintHero`.
- Do not alter audio readiness, countdown, Fire, Defense, commander, WebSocket, or room-state behavior.
- Do not deploy traffic to `kingshoter.com`; upload a preview version only.
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

### Task 2: Publish an isolated online QA preview

**Files:**
- No tracked source changes.

**Interfaces:**
- Consumes: committed Worker bundle and Cloudflare `versions upload --preview-alias`.
- Produces: a public preview origin and a unique `qa-kvk-*` phone-test URL.

- [ ] **Step 1: Upload without production traffic**

Run `npx wrangler versions upload --preview-alias <unique-alias> --message "KvK compact ready copy phone QA" --strict`.

Expected: Wrangler returns a Version ID and preview URL; no production deployment is created.

- [ ] **Step 2: Generate and verify a QA room**

Generate a new room with `test/support/qa-kvk.cjs`, open `/kvk?room=<room>&notour=1&lang=en&__kvk_build=2026071505` on the preview origin, and verify HTTP 200 plus the new HTML/JS/CSS content.

- [ ] **Step 3: Hand off the phone URL**

Provide the preview QA link and state explicitly that `kingshoter.com` production traffic was not changed.
