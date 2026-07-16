# KvK Commander Launch Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading single-captain hero on non-participating commander devices with a silent, all-captain launch monitor.

**Architecture:** Add a pure projection from immutable live rally pairs to at most six launch rows, then render those rows in a dedicated read-only section. `paintHero()` chooses between the existing personal/member hero and the new commander monitor; existing audio scheduling stays unchanged.

**Tech Stack:** Vanilla JavaScript, HTML/CSS, Node test runner, Playwright.

## Global Constraints

- Selected commanders keep their personal countdown and audio.
- Unselected commanders see every live rally captain but receive no rally audio, vibration, or flash.
- Ordinary members and captains retain current behavior.
- No server protocol, room state, rally timing, tactical timeline, or radar change.

---

### Task 1: Lock the projection and visual states with failing tests

**Files:**
- Create: `test/commander-launch-monitor.test.cjs`
- Read: `public/kvk.js`

**Interfaces:**
- Consumes: live rally commands with `payload.pairs[]`.
- Produces: `commanderLaunchRows(room)` and monitor HTML/state assertions.

- [ ] **Step 1: Add a Node test that expects both kingdoms' valid pairs sorted by `pressUTC`, capped at six, with frozen names and roles.**
- [ ] **Step 2: Add monitor rendering assertions for one `next` row, urgency at ten seconds, launched rows, escaped names, and all captain names.**
- [ ] **Step 3: Run `node --test test/commander-launch-monitor.test.cjs` and confirm it fails because the projection and monitor do not exist.**

### Task 2: Implement the silent commander monitor

**Files:**
- Modify: `public/kvk.html`
- Modify: `public/kvk.js`
- Modify: `public/app.css`
- Test: `test/commander-launch-monitor.test.cjs`

**Interfaces:**
- Produces: `#commanderLaunchMonitor`, `commanderLaunchRows(room)`, `paintCommanderLaunchMonitor(rows)`, and the `paintHero()` audience switch.

- [ ] **Step 1: Add the labelled hidden monitor section next to `#phero`.**
- [ ] **Step 2: Implement the immutable two-kingdom row projection and compact localized renderer.**
- [ ] **Step 3: In `paintHero()`, give any selected captain personal-hero priority; otherwise route Commander mode to the monitor and keep the hero hidden.**
- [ ] **Step 4: Add mobile-first compact row styling, truncation, next/urgent/opened states, and no horizontal overflow.**
- [ ] **Step 5: Run the focused test and confirm it passes.**

### Task 3: Prove audience and audio separation in a browser

**Files:**
- Create: `test/commander-launch-monitor.e2e.cjs`
- Test: `test/kvk-rally-wiring.test.cjs`

**Interfaces:**
- Consumes: a generated isolated QA room and the existing browser cue debug map `window.__cues`.
- Produces: cross-device proof for unselected commander, selected commander, ordinary member, and selected captain.

- [ ] **Step 1: Fire a generated Double rally from an unselected commander and assert the monitor lists both captains, the giant hero is hidden, and no `-me` or `-join` cue exists.**
- [ ] **Step 2: Assert the selected commander keeps the personal hero and `-me` cue, while an ordinary member keeps the shared JOIN hero and `-join` cue.**
- [ ] **Step 3: Check 320/390/430 widths for overflow and page errors.**
- [ ] **Step 4: Run the focused browser test and existing cue-routing test.**

### Task 4: Release one coherent client build

**Files:**
- Modify: `src/client-build.js`
- Modify: `public/kvk-update.js`
- Modify: `public/kvk-rally.js`
- Modify: `public/kvk.html`
- Modify: build-version assertions under `test/`

**Interfaces:**
- Produces: one new `CURRENT_KVK_BUILD`, minimum refresh floor, and matching first-party asset query versions.

- [ ] **Step 1: Advance all active build expectations together and confirm the build tests fail before source constants change.**
- [ ] **Step 2: Update source and asset versions, then run `npm test`.**
- [ ] **Step 3: Run GitNexus change detection, review the diff, and commit only intended files.**
- [ ] **Step 4: Deploy to the isolated QA Worker, verify the stable `qa` page and generated browser room, then promote the same commit to production.**
