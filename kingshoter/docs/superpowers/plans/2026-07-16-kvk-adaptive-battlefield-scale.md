# KvK Adaptive Battlefield Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the unchanged castle battlefield use an adaptive 30/60/90/120-second idle spatial scale.

**Architecture:** Keep the existing `mapData() → domainFor() → ringR() → renderRadar()` pipeline. Change only `domainFor()` for idle actors; all coordinates, clocks, live-command behavior, and UI dimensions remain untouched.

**Tech Stack:** Vanilla JavaScript, Node test runner, Playwright.

## Global Constraints

- Idle spatial distance remains proportional to canonical march time.
- Empty rooms default to 120 seconds; populated idle rooms round the longest time up to 30/60/90/120 and clamp at 120.
- Live command timing and the fixed two-minute timeline do not change.

---

### Task 1: Adaptive idle domain

**Files:**
- Modify: `public/kvk.js`
- Test: `test/kvk-home-layout.test.cjs`

**Interfaces:**
- Consumes: `domainFor(ms: number[], live: boolean)` and `MARCH_MAX_SECONDS`.
- Produces: an idle domain of `30 | 60 | 90 | 120` when actors exist, otherwise `120`.

- [x] **Step 1: Add failing boundary tests**
- [x] **Step 2: Run the focused test and confirm the old fixed-domain assertion fails**
- [x] **Step 3: Implement the minimal adaptive idle-domain calculation**
- [x] **Step 4: Re-run the focused test and confirm it passes**
- [x] **Step 5: Run complete source and mobile tactical verification**
- [ ] **Step 6: Review affected flows, commit, deploy to QA, visually verify, then promote the same artifact to production**
