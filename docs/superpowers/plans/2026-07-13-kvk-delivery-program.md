# KvK Coordinated Delivery Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved KvK player-control, exact personal countdown, reliable-delivery QA, optional Triple Rally, and isolated backup-channel experiments as one dependency-safe program without regressing the current Classic audio path.

**Architecture:** Treat Classic browser audio as the production sound authority. First make player identity, march time, deletion, role selection, commander silence, and device ACK facts canonical. Add a no-audio Reliable shadow on that base, then add per-kingdom Triple using the same player snapshots and pair-length-agnostic delivery facts. Keep Web Push and audio-stream work in QA-only lab surfaces. Ship one disabled-first bootstrap, test only generated `qa-kvk-*` rooms, and promote only the portions that meet their own evidence gates.

**Tech Stack:** Cloudflare Workers and Durable Objects, WebSocket hibernation attachments, browser JavaScript/Web Audio, Node.js `node:test`, Playwright Chromium/Firefox/WebKit, Web Push/service workers for the isolated lab.

## Program Invariants

- The game sends no real-time rally data to the site. Commanders explicitly stage and Fire; the server never infers in-game state.
- Ordinary members are never assigned to vehicles on the website. They only receive one generic JOIN cue when eligible.
- An unselected commander device is silent. A commander selected as a captain receives only that captain's personal countdown.
- The selected lead is the captain's personal countdown lead. `10` means that captain's sequence starts at their own `pressUTC - 10`, never at an unrelated 60-second offset.
- `double_rally` timing remains unchanged. `triple_rally` adds a second Sacrifice, gives both Sacrifices equal landing time, and lands Main one second later.
- Automated and production-connected QA creates its own `qa-kvk-*` room. Every other room is an operation room. No code, test, deploy command, or runbook special-cases `1406`.
- No experiment may become a second audio owner beside Classic. Push and stream experiments remain invisible to ordinary KvK users and never display commander warnings.
- Preserve all unrelated dirty-worktree files. Each task stages only its listed paths.
- Before editing any existing function, class, or method, run GitNexus upstream impact and report the blast radius. Warn before every HIGH or CRITICAL edit, then proceed under the user's standing approval.
- Before every commit, run `gitnexus_detect_changes({repo:"kingshot", scope:"staged"})` and compare the affected symbols/flows with the leaf task.

## Dependency and Promotion Map

| Order | Plan | Hard dependency | Initial production state | Promotion rule |
|---|---|---|---|---|
| 1 | `2026-07-13-kvk-core-player-control.md` | None | Visible after QA | Unit + isolated browser QA + exact 10/15/30/60 leads pass |
| 2 | `2026-07-13-kvk-reliable-delivery-qa.md` | Core device ID, ACK, Room harness | QA-only, no audio | Remains shadow evidence; never replaces Classic in this program |
| 3 | `2026-07-13-kvk-triple-rally.md` | Core + Reliable attachment helpers | Global off, QA-only on | Global on only after automated and physical matrix pass |
| 4 | `2026-07-13-kvk-backup-push-lab.md` | QA guard + Reliable facts | Lab off | Keep only if measured delivery is clearly better; otherwise delete |
| 5 | `2026-07-13-kvk-battle-audio-stream-lab.md` | QA guard + Reliable facts | Lab off | Keep only if measured delivery is clearly better; otherwise delete |

The code order is serial where files overlap. Push and stream research may be reviewed in parallel, but edits to `src/worker.js`, `src/room.js`, `public/kvk.js`, `package.json`, or `wrangler.toml` are never applied concurrently.

---

### Task 1: Freeze Baseline Evidence and an Exact File Ledger

**Files:**
- Create: `docs/operations/kvk-program-rollout.md`
- Read only: all five leaf plans and three approved design specs

- [ ] **Step 1: Record the current repository and deployment baseline**

Run:

```bash
cd /Users/ff/Documents/kingshot
git status --short
git rev-parse HEAD
cd kingshoter
npx wrangler deployments status
npm test
```

Expected: save the Git commit, current Worker version ID, exact dirty-file list, test pass/fail count, and UTC timestamp in `docs/operations/kvk-program-rollout.md`. A failing baseline is investigated before feature work; it is not relabeled as caused by this program.

- [ ] **Step 2: Create a source-control checkpoint if the current deployed site is still untracked**

Run:

```bash
cd /Users/ff/Documents/kingshot
git ls-files --error-unmatch kingshoter/src/room.js
```

If this exits 0, do not create a redundant checkpoint. If it exits nonzero, the deployed `kingshoter/` runtime has no Git rollback base. Before changing any business code, stage exactly the current runtime, dependencies, static audio, and executable tests; exclude diagnostic screenshots and generated browser output:

```bash
git add kingshoter/package.json kingshoter/package-lock.json kingshoter/wrangler.toml
git add kingshoter/src
git add kingshoter/public/*.html kingshoter/public/*.js kingshoter/public/*.css kingshoter/public/*.json kingshoter/public/*.svg kingshoter/public/sfx
git add kingshoter/test/*.cjs kingshoter/test/*.mjs
```

Run `gitnexus_detect_changes({repo:"kingshot", scope:"staged"})`, verify the staged set contains no `.dev.vars`, `.wrangler`, `node_modules`, PNG screenshot, or unrelated root file, then commit:

```bash
git commit -m "chore: checkpoint current kingshoter runtime"
```

Expected: this add-only checkpoint preserves the exact pre-program runtime so later task commits and Cloudflare rollback have a real local source baseline. It does not claim that the pre-existing files were authored by this program.

- [ ] **Step 3: Create the rollout record with immutable gates**

Create these sections:

```markdown
# KvK Coordinated Delivery Rollout

## Baseline

## Per-task commits and GitNexus scope

## Local unit and browser evidence

## Production-connected QA evidence

## Physical-device evidence

## Enabled feature gates

## Candidate keep-or-delete decisions

## Deployment and rollback version IDs
```

Every evidence row stores an ISO-8601 UTC time, exact command, observed count/result, generated QA room, and browser/device version where applicable. Never pre-fill PASS.

- [ ] **Step 4: Verify the plan dependency files exist**

Run:

```bash
cd /Users/ff/Documents/kingshot
test -f docs/superpowers/plans/2026-07-13-kvk-core-player-control.md
test -f docs/superpowers/plans/2026-07-13-kvk-reliable-delivery-qa.md
test -f docs/superpowers/plans/2026-07-13-kvk-triple-rally.md
test -f docs/superpowers/plans/2026-07-13-kvk-backup-push-lab.md
test -f docs/superpowers/plans/2026-07-13-kvk-battle-audio-stream-lab.md
```

Expected: all commands exit 0.

---

### Task 2: Execute the Canonical Player-Control Foundation

**Files:** All files listed by `2026-07-13-kvk-core-player-control.md`.

- [ ] **Step 1: Execute Core Tasks 1–6 in order**

Use RED/GREEN commits from the leaf plan to create the QA guard/harness, pure player domain, Room mutations, generic socket events/device ID, snapshot identity reconciliation, and Player ID/Nickname onboarding.

Required interface checkpoint:

```text
parseMarchSeconds(value) -> number|null, strict 5..180
getRoomDeviceId(room) -> stable room-local UUID
RoomSocket.onMessage(message) -> every additive non-state/non-error message
createRoomHarness(Room,{env,players,nowMs,roomName}) -> QA-only harness
```

Run after Task 6:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test test/player-domain.test.cjs test/player-protocol.test.cjs test/room-socket.test.cjs
npm test
```

Expected: zero failures; the harness rejects any room outside `qa-kvk-*`.

- [ ] **Step 2: Execute Core Tasks 7–10 in order**

Implement the vertical roster, explicit replacement UI, commander march edit, staged-aware player removal, and unselected-commander silence. Run every GitNexus warning required by the leaf plan before touching roster, slots, state, or audio scheduling.

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm test
node test/mineaudio.cjs http://127.0.0.1:8791
node test/alert-truth.cjs http://127.0.0.1:8791
for lead in 10 15 30 60; do node test/lead-timing.cjs http://127.0.0.1:8791 "$lead"; done
```

Expected: player edits/removals synchronize across manager contexts; the selected captain receives personal cues; the ordinary member receives one JOIN sequence; the unselected commander has no rally cue keys; all four lead values match exactly.

- [ ] **Step 3: Execute Core Tasks 11–12 and freeze the shared contracts**

Add pair-length-agnostic device aggregation and Classic scheduled-cue ACK, then run the consolidated multi-browser QA. Do not let later plans invent a second device ID or room harness.

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm test
npm run test:kvk-core:all
```

Expected: Chromium, Firefox, and WebKit pass only generated QA rooms. Update the rollout record with the core commit IDs and GitNexus flows.

---

### Task 3: Execute Reliable Delivery as a No-Audio Shadow

**Files:** All files listed by `2026-07-13-kvk-reliable-delivery-qa.md`.

- [ ] **Step 1: Execute Reliable Tasks 1–4 in order**

Implement the pure delivery model, private merge-safe socket attachments, Classic-first targeted facts, retry/cancel/expiry, and reconnect. Preserve unknown attachment fields so Triple can later add `clientBuild`.

Required interface checkpoint:

```text
readSocketAttachment(ws) -> normalized delivery fields plus unknown fields
writeSocketAttachment(ws, patch) -> shallow merge, normalize, serialize, return merged value
attachment includes roomName, qa, pid, deviceId, view, shadow, audioArmed, armedUntilMs
```

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test test/delivery-model.test.cjs test/room-delivery.test.cjs
npm test
```

Expected: immutable command IDs, exact target facts, one alarm schedule, bounded retries, cancellation, expiry, and late hello tests all pass.

- [ ] **Step 2: Execute Reliable Tasks 5–8 in order**

Wire the no-audio shadow only behind both the QA-room predicate and `deliveryShadow=1`. It may observe Classic's already-scheduled cues; it may not call Web Audio, TTS, vibration, or Classic scheduler primitives.

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm run test:delivery
npm run test:qa:delivery
```

Expected: three browser engines pass reconnect, retry, ACK, cancellation, commander silence, and rollback invariants. This proves transport/control logic only; it is not physical background-audio evidence.

---

### Task 4: Execute Optional Triple Rally on the Shared Foundation

**Files:** All files listed by `2026-07-13-kvk-triple-rally.md`.

- [ ] **Step 1: Execute Triple Tasks 1–4**

Build pure per-kingdom mode state, Triple timing, build projection, and Durable Object integration. Consume `parseMarchSeconds`, `nowMs`, `readSocketAttachment`, and `writeSocketAttachment`; do not replace their implementations.

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
node --test test/rally-mode.test.cjs test/rally-targets.test.cjs test/client-build.test.cjs test/triple-room.test.cjs
npm test
```

Expected: Double defaults; K1/K2 persist independently; QA-only gate cannot enable an operation room; both Sacrifices land together; Main lands one second later; rollback leaves an active command immutable.

- [ ] **Step 2: Execute Triple Tasks 5–9**

Deploy the stale-client updater controller in code, add shared rally semantics, vertical three-role selection, explicit replacement, Fire Triple, and isolated browser QA. Keep the existing `#fireDouble` gesture and `fireDouble()` body.

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm run test:triple
npm run test:qa:delivery
npm run test:qa:triple
```

Expected: all unit suites and all three browser engines pass; a selected Triple captain gets one personal sequence; an ordinary member gets one JOIN sequence; an unselected commander is silent; Double regressions pass.

- [ ] **Step 3: Leave the disabled-first gate values**

Before any deployment, `wrangler.toml` must contain one `[vars]` section with:

```toml
TRIPLE_RALLY_ENABLED = "0"
TRIPLE_RALLY_QA_ENABLED = "1"
```

Expected: generated production QA rooms may exercise Triple; all operation rooms remain Double until the physical gate is satisfied.

---

### Task 5: Execute the Backup-Channel Labs Without Main-Page Exposure

**Files:** All files listed by the Push and audio-stream leaf plans.

- [ ] **Step 1: Execute the Push lab plan serially**

Complete `2026-07-13-kvk-backup-push-lab.md` task by task. Its routes must reject non-QA room names before any Durable Object lookup, its service worker scope must remain under `/lab/`, and its flags remain disabled by default.

Run the exact Push leaf commands, then:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm test
npm run test:push-lab
npx wrangler deploy --dry-run
```

Expected: core/Triple suites still pass, Push unit/integration tests pass, and ordinary `/kvk` contains no Push button, warning, service-worker registration, or candidate audio owner.

- [ ] **Step 2: Execute the audio-stream lab plan serially after Push**

Complete Stream Tasks 1–6, the Task 7 runbook/contract, and the automated/default-off portions of Task 8 from `2026-07-13-kvk-battle-audio-stream-lab.md`. Keep its route, credentials, session state, media elements, and measurements confined to generated QA rooms and `/lab/` pages. The physical trials and final evidence decision execute later in this master plan; missing physical devices do not create a dependency cycle or block the independent Core/Reliable/Triple work.

Run the exact Stream leaf commands, then:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm test
npm run test:audio-stream-lab
npm run test:audio-stream-e2e
npx wrangler deploy --dry-run
```

Expected: stream lab tests pass or produce an honest stop result; ordinary `/kvk` has no Stream control, warning, autoplay request, or extra audio owner.

- [ ] **Step 3: Make evidence-based keep-or-delete decisions**

For each candidate, record one of:

```text
KEEP_DISABLED_FOR_PHYSICAL_QA
DELETE_SOURCE_AND_BINDINGS
```

`KEEP_DISABLED_FOR_PHYSICAL_QA` is the preliminary automated-gate result: it requires all automated safety gates and a plausible measurable benefit, then defers physical evidence to Task 7. `DELETE_SOURCE_AND_BINDINGS` is mandatory for an automated security leak, duplicate/stale delivery, or a structurally invalid candidate; later physical platform incompatibility or no clear advantage also triggers deletion in Task 7. Neither decision enables the candidate on the main KvK page.

---

### Task 6: Run One Consolidated Local and Production-Connected QA Gate

**Files:**
- Modify: `docs/operations/kvk-program-rollout.md`
- Test only: all `kingshoter/test/` suites

- [ ] **Step 1: Run the complete local gate from a clean server start**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm test
npm run test:delivery
npm run test:triple
npm run test:push-lab
npm run test:audio-stream-lab
npm run test:audio-stream-e2e
npm run test:qa:delivery
npm run test:qa:triple
node --check src/worker.js
node --check src/room.js
node --check public/app.js
node --check public/kvk.js
npx wrangler deploy --dry-run
```

Expected: every applicable command exits 0. If a lab was deleted by its stop rule, record `DELETED_BY_GATE` and run its source-absence test instead of pretending it passed.

- [ ] **Step 2: Scan for forbidden room and feature leakage**

Run:

```bash
cd /Users/ff/Documents/kingshot
rg -n "room=1406|room%3D1406|===\\s*[\"']1406[\"']|!==\\s*[\"']1406[\"']" kingshoter/src kingshoter/public kingshoter/test
rg -n 'pushManager|serviceWorker\.register|battle stream|Backup alert' kingshoter/public/kvk.html kingshoter/public/kvk.js
```

Expected: both commands return no matches. Documentation may mention the prohibition; runtime and tests may not target or branch on that room.

- [ ] **Step 3: Deploy the disabled-first bootstrap**

Record the current Worker version from `npx wrangler deployments status`, then run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npx wrangler deploy
curl -fsS -D - https://kingshoter.com/api/build
```

Expected: deployment succeeds; `/api/build` is uncached, global Triple is false, QA Triple is true, and all candidate lab gates are false.

- [ ] **Step 4: Run production-connected QA with generated rooms only**

Run the Reliable and Triple leaf production commands with:

```bash
QA_BASE_URL=https://kingshoter.com ALLOW_PRODUCTION_QA=1 npm run test:qa:delivery
QA_BASE_URL=https://kingshoter.com ALLOW_PRODUCTION_QA=1 EXPECT_TRIPLE_GLOBAL=0 npm run test:qa:triple
```

Expected: the specs create their own `qa-kvk-*` rooms; Chromium/Firefox/WebKit pass; the test guard rejects a non-QA mutation before connection; no operation-room identifier is supplied by the caller.

---

### Task 7: Run Physical Gates and Promote Only Qualified Features

**Files:**
- Modify: `docs/operations/kvk-program-rollout.md`
- Modify conditionally: `kingshoter/wrangler.toml`
- Modify conditionally: `kingshoter/src/client-build.js`
- Modify conditionally: candidate lab files according to their delete rules

- [ ] **Step 1: Execute the physical Classic/Triple matrix**

Use new generated QA rooms on iOS, Android, macOS, and Windows. Record foreground, game switch, background, lock screen, reconnect, audio interruption, 10/15/30/60 personal leads, selected commander, unselected commander, ordinary member, duplicate/stale cues, and actual device/browser versions.

Expected: missing devices or incomplete rows are recorded as unavailable/Pending, never PASS. Until every required Triple row passes, keep `TRIPLE_RALLY_ENABLED="0"`.

- [ ] **Step 2: Execute candidate physical matrices only if retained**

Run each retained lab's exact physical protocol against Classic in the same device conditions. A candidate qualifies only if its measured successful-delivery/latency result is clearly better and it introduces no duplicate or stale alert. Otherwise execute the leaf deletion procedure and rerun the consolidated gate.

- [ ] **Step 3: Promote Core and updater after their gates**

Core player control and the updater are part of the disabled-first bootstrap. If production-connected QA passes, leave them deployed for all operation rooms. Reliable remains a QA-only no-audio shadow; Push and Stream remain disabled lab routes or are deleted.

- [ ] **Step 4: Promote Triple globally only when every Triple gate is PASS**

Follow Triple Task 10 exactly as two deployments: first set `MIN_KVK_BUILD` to the current Triple-capable build while global Triple remains `0`, deploy, wait one full 60-second update polling interval, and rerun deployed QA; only then change `TRIPLE_RALLY_ENABLED` to `"1"`, keep the QA gate on, dry-run, deploy, and verify `/api/build`. Keep legacy socket projection until independent evidence says old builds are gone.

Expected: all operation rooms gain the same optional per-kingdom Triple switch at once; Double remains the default. If any physical row is Pending or failed, skip this step and leave global Triple off without asking the user for another approval.

---

### Task 8: Verify Rollback and Close the Program

**Files:**
- Modify: `docs/operations/kvk-program-rollout.md`

- [ ] **Step 1: Verify feature-gate rollback**

Run the focused Triple rollback unit, Reliable Classic rollback proof, and each retained lab kill-switch test. Confirm that global Triple off blocks new Triple commands without mutating an active immutable command, and that Classic remains the sole audio owner.

- [ ] **Step 2: Record the Worker version rollback command**

Using the baseline version ID captured in Task 1, export that observed value and record but do not run the rollback unless the deployed core is actually unhealthy:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
export BASELINE_VERSION_ID
npx wrangler rollback "$BASELINE_VERSION_ID" --message "Rollback KvK coordinated delivery" --yes
```

Set the exported value from the exact Cloudflare version recorded before deployment; never guess it. A required rollback is authorized by this plan because it restores the pre-program production version.

- [ ] **Step 3: Run final verification and change detection**

Run:

```bash
cd /Users/ff/Documents/kingshot/kingshoter
npm test
npm run test:qa:delivery
npm run test:qa:triple
npx wrangler deployments status
```

Stage only the completed rollout record and any final gate changes, call `gitnexus_detect_changes({repo:"kingshot", scope:"staged"})`, and commit with:

```bash
git add docs/operations/kvk-program-rollout.md
git commit -m "ops: record kvk delivery rollout evidence"
```

Expected: the record says exactly which features are deployed, QA-only, disabled, deleted, Pending, or rolled back; it contains no claimed physical evidence that was not performed.

## Completion Definition

The program is complete when Core is verified and deployed, the updater bootstrap is active, Reliable has honest QA-only evidence, Triple is either globally enabled after every gate or safely left globally disabled, each backup candidate is either retained disabled with evidence or deleted, all operation rooms share one production configuration, and the rollback version is recorded.
