# Rally / Defense Separation + Apple-Inspired UI Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Every implementation task also uses `superpowers:test-driven-development`; use `superpowers:systematic-debugging` for any unexpected failure and `superpowers:verification-before-completion` before release claims. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/rally` and `/defense` as two isolated, mobile-first coordination products with one shared battle foundation, an Apple-inspired interaction hierarchy, and a Durable Objects write budget that remains stable with one hundred idle clients.

**Architecture:** First stop duplicate readiness and heartbeat messages from rewriting canonical Durable Object rows. Keep one room-scoped Durable Object (`r:<room>`) so both products share the existing room password, but attach an explicit `rally` or `defense` surface to every socket and persist operational data in separate namespaces. Extract narrow connection, clock, audio, readiness, identity, delivery, status, and drawer modules; adapt Rally to them before building Defense. Both surfaces use the same mobile shell and three-detent manager drawer, while their controllers, rosters, presence, orders, acknowledgements, and audio audiences remain isolated. Clients schedule absolute-time cues locally; the server broadcasts canonical transitions and acknowledgements, never per-second countdown frames or animation state.

**Tech Stack:** Cloudflare Workers and Durable Objects, vanilla JavaScript UMD/CommonJS-compatible browser modules, HTML/CSS, Node's built-in test runner, Playwright 1.61, Wrangler 4.110, Web Audio, MediaSession, Wake Lock, WebSockets.

## Global Constraints

- Scope is only Rally and Defense. Do not create an Admin page, room registry, cleanup API, retention system, or project-wide administrator protocol.
- Do not integrate `/Users/ff/Documents/gameauto`, OCR, AI vision, emulator control, or automatic Defense triggering in this release.
- The website receives no live game state. UI and metrics may say Targeted, Delivered / scheduled, Audio-ready, Red / unconfirmed, Offline roster, and Too late; they must never say a player responded, joined, sent, defended, arrived, or acted in the game.
- Preserve the current room-password behavior. Rally and Defense in the same room share one `pwHash`; do not add password changing.
- Operational data is strictly isolated by surface: roster, presence, commands/orders, devices, acknowledgements, audio routing, and manager snapshots must not cross between Rally and Defense.
- Ordinary Defense pages never render the room roster. A manager-only Defense device remains silent unless its own registered defender profile is in the immutable order audience.
- Defense has exactly one live order. The next order is blocked until the active order completes or a canonical cancellation is received.
- Defense uses the existing media assets and cue grammar: preparation at T-15, beeps at T-10 through T-6, spoken 5 through 1, and `Now` at T0. Do not create Defense-specific audio files or say `Defend now`.
- Browser audio still requires the explicit user gesture. Do not simulate or auto-click **Enable page alerts**.
- Keep the ordinary-player typography and mobile reading order visually consistent with current Rally. All text inputs remain at least 16px on iOS to prevent focus zoom.
- Preserve the rounded Kingshoter font stack, mint/cream/warm-brown identity, every selected captain's precise progress bar, and the castle metaphor. This is an information-architecture and interaction redesign, not an iOS visual imitation.
- Mobile is canonical. At 320, 375, 390, and 430 CSS pixels there is no horizontal page scroll; all interactive hit regions are at least 44 by 44 CSS pixels; critical supporting text is at least 11px; ordinary decision text is never shrunk to fit.
- The ordinary Rally page shows both kingdoms and at most six selected captains together. The ordinary Defense page has constant rendered height regardless of whether the roster contains eight or one hundred defenders.
- Information priority is fixed: time and alert truth, then the current player's action, then team tactical state, then manager operations, then motion and decoration.
- The Rally spatial field derives its scale from the actual largest selected march time with roughly 5--10% headroom, capped at 120 seconds. Gathering markers remain at their departure radius until march begins; only the march phase moves linearly toward the castle.
- Manager consoles have exactly three interruptible states: `closed`, `command`, and `manage`. Dragging is 1:1 from the handle/header, each gesture has a visible button alternative, collapse retains page-session authentication, and collapse is not logout.
- Glass/blur is limited to floating connection chrome, the drawer header, and the sticky fire dock. Forms, progress bars, maps, player lists, and confirmations remain opaque and have reduced-transparency fallbacks.
- `prefers-reduced-motion` stops decorative loops and replaces drawer spring travel with a short non-spatial transition. Precise countdown and map positions remain clock-derived rather than animation-derived.
- Manager-only devices are silent. An unselected Rally commander sees all selected captains in a silent launch monitor; a Defense manager receives personal audio only when its own registered profile is captured in the active Defense order.
- The visible readiness strip is one canonical projection. Green requires explicit enablement, running audio, live carrier, connected socket, and a fresh synchronized clock; it never implies speaker volume, attention, or any game action.
- Idle drawer animation, readiness repainting, heartbeats, and identical device-status observations must produce zero periodic canonical Durable Object writes. A 100-idle-socket test is a release gate.
- Fixed QA room and password are both `qa`. Do not expose generated, timestamped QA room names to the user. Automated local suites may reuse `qa` because each Wrangler run uses an isolated temporary persistence directory. Remote QA suites run serially: cancel a leftover Defense order first, remove only their stable `qa-test-*` profiles through the normal confirmed manager flow, and never add a reset/Admin protocol.
- Do not open, mutate, or issue commands in any production operation room during tests. Production smoke checks are route/build/readiness checks only.
- Before editing any existing function, class, or method, run GitNexus upstream impact analysis for that exact symbol. Report the blast radius before editing; stop and warn on HIGH or CRITICAL risk. Before every commit, run `gitnexus_detect_changes(scope: "all", repo: "ks")` and review affected flows.
- Known risk anchors from planning: `audioAlive` and `saveProfile` are CRITICAL; `scheduleBeeps`, `snapshot`, `stateMsg`, `broadcast`, `writeSocketAttachment`, and `scheduleExpiry` are HIGH/CRITICAL; `renderDefense` is CRITICAL; `setView` and `persistAll` are HIGH. Their characterization tests must pass before and after each adapter change.
- Keep commits independently revertible. A task's focused tests and the required Rally regression gate must pass before its commit.
- The Task 2 write-amplification incident fix may ship independently after its own QA gate so daily Durable Object consumption stops immediately. All Rally/Defense separation, static-Defense removal, and UI work after that uses one atomic production release; never remove the old Rally Defense UI before the new Defense page and routing are ready in the same deployable commit.

## Execution Contracts

| Task | Consumes | Produces |
|---|---|---|
| 1 | Current production-equivalent Rally source | Restore tag, baseline evidence, Rally characterization tests |
| 2 | Task 1 baseline plus current readiness/presence traffic | Duplicate status no-op, transient heartbeat presence, stable client coalescing, zero-write idle budget |
| 3 | Characterized and write-stable socket behavior | `BattleConnection` API including surface, generation, and synchronized time |
| 4 | Task 3 clock API and current Rally audio | Shared audio, readiness, and cue APIs with cancellation/future-cue inspection |
| 5 | Tasks 3–4 APIs and current Rally profile/ACK code | Shared surface-aware identity store and generation-scoped ACK queue |
| 6 | Tasks 3–5 browser foundations and approved UI spec | Semantic battle tokens, canonical status projection, three-detent manager drawer |
| 7 | Existing room-player validation | Pure Defense config/order/delivery lifecycle with frozen roster/audience |
| 8 | Task 7 state plus existing Room authority | Surface attachments, isolated namespaces, filtered presence/snapshots/broadcasts |
| 9 | Tasks 3, 7, and 8 | Authenticated Defense protocol, manager clock status, one-order authority, bounded deltas |
| 10 | Tasks 3–6 and 9 | Ordinary Defense page, personal projection, shared audio scheduling, ACKs |
| 11 | Tasks 6 and 9–10 | Defense `Status`/`Players` manager drawer and virtualized large roster |
| 12 | Tasks 3–6 and characterized Rally | Mobile Rally shell, six-captain tactical view, meaningful map, silent manager monitor |
| 13 | Working Rally and Defense surfaces | Canonical routing, legacy redirect, independent build gates, homepage entries |
| 14 | Tasks 3–6, 12, and 13 | Rally-named assets/tests with the old static Defense implementation removed |
| 15 | Task 6 tokens and canonical routes | Codes/Guide accessibility, reduced-motion behavior, consistent supporting UI |
| 16 | Complete local product | Isolation, concurrency, zero-write idle load, accessibility, mobile-browser evidence |
| 17 | Task 16 green local commit | Exact QA deployment and device/audio matrix in fixed room `qa` |
| 18 | Exact QA-tested commit and rollback ID | Atomic production deployment, read-only smoke evidence, documented rollback |

---

### Task 1: Create the pre-change restore point and lock current Rally behavior

**Files:**
- Create: `test/rally-behavior-characterization.test.cjs`
- Create: `test/rally-audio-characterization.test.cjs`
- Create: `docs/superpowers/qa/2026-07-16-rally-defense-baseline.md`
- Read: `public/kvk.js`
- Read: `public/kvk-rally.js`
- Read: `src/room.js`
- Test: `test/kvk-rally-wiring.test.cjs`
- Test: `test/audio-readiness.test.cjs`
- Test: `test/cancel-rally-client.test.cjs`
- Test: `test/cancel-rally-selection.test.cjs`
- Test: `test/commander-launch-monitor.test.cjs`

**Behavior to freeze:**

```text
Double/Triple captain -> personal press-time countdown and audio
ordinary member       -> shared JOIN visual/audio only when current Rally policy targets it
unselected commander  -> silent all-captain launch monitor
cancel                 -> outstanding cues stop; staged captain selection remains
reconnect/clock drift  -> future cues replan; one command never produces duplicate GO
lead time              -> selected value is the actual start of personal countdown
```

- [x] **Step 1: Verify the existing source restore point and record deployment identity.** Run `git status --short`, `git branch -vv`, `git ls-remote --heads origin online-prod-2026-07-15`, `npx wrangler deployments list --name kingshoter`, and `npx wrangler versions list --name kingshoter`; write the current Git SHA and previous production version ID to the baseline document without secrets.
- [x] **Step 2: Create and push an annotated source tag before implementation.** Run `git tag -a rally-defense-prechange-20260716 HEAD -m "Pre Rally Defense source restore point"` and `git push origin rally-defense-prechange-20260716`. If the tag already exists, verify it resolves to this pre-change source before continuing; do not move it.
- [x] **Step 3: Add pure characterization assertions.** Require the current UMD modules and assert 10/15/30/60-second lead targets, Double/Triple role routing, cancel/restage behavior, commander silence, profile recovery, cue ID idempotency, and future-only rescheduling. These tests describe current correct behavior; they must pass before extraction.
- [x] **Step 4: Add source-wiring assertions for the current audio pipeline.** Assert exactly one beep phase, the same five spoken files, one GO file, the 40Hz keep-alive path, MediaSession metadata, AudioContext running/carrier truth, and no audio for an unselected commander.
- [x] **Step 5: Run the baseline gate.** Run `node --test test/rally-behavior-characterization.test.cjs test/rally-audio-characterization.test.cjs test/kvk-rally-wiring.test.cjs test/audio-readiness.test.cjs test/cancel-rally-client.test.cjs test/cancel-rally-selection.test.cjs test/commander-launch-monitor.test.cjs`; expect all tests to pass with no production-code change.
- [x] **Step 6: Record baseline payload and timing evidence.** Run `npm test`, `npm run test:delivery`, and `npm run test:triple`; paste command, exit code, and test counts into the baseline document.
- [x] **Step 7: Run GitNexus change detection and commit only the characterization assets.** Commit with `test: lock rally behavior before defense separation`.

---

### Task 2: Stop duplicate device-status and heartbeat Durable Object writes

**Files:**
- Create: `test/room-write-budget.test.cjs`
- Modify: `src/room-delivery.js`
- Modify: `src/room.js`
- Modify: `public/kvk.js`
- Modify: `test/room-harness.cjs`
- Modify: `test/room-delivery.test.cjs`
- Modify: `test/reliable-room-delivery.test.cjs`
- Modify: `test/audio-readiness.test.cjs`
- Modify: `test/classic-delivery-client.test.cjs`
- Create: `test/audio-carrier-longrun.e2e.cjs`
- Modify: `src/client-build.js`
- Modify: `public/kvk-update.js`
- Modify: `public/kvk-rally.js`
- Modify: `public/kvk.html`

**Interfaces:**
- Consumes: existing `normalizeCoreSocketAttachment`, `bindCoreSocketIdentity`, hibernation WebSocket attachments, `audioAlive()`, and `sendDeviceStatus(messageType, force)`.
- Produces:

```js
projectLiveCoreDevices(socketAttachments, nowMs);
// -> [{ pid, deviceId, soundReady, lastSeenMs }]
// same pid/device across tabs is one device; soundReady is true when any live tab is ready

Room.prototype.observeDevice(ws, message);
// -> { ok, changed, attachmentBefore, attachmentAfter, devicesBefore, devicesAfter, error? }

Room.prototype.persistDevices();
// persists only the `devices` key after a real canonical identity/readiness transition
```

An identical `deviceStatus` still receives `deviceStatusSaved`; it produces no storage write, no full-room broadcast, and no alarm change. `hb` is transient presence: it refreshes live attachment/in-memory liveness but never writes `room`, `devices`, `deliveryAcks`, or `profileOwners`. `snapshot()` and command audience construction project live presence/readiness from WebSocket attachments so removing heartbeat persistence cannot make a connected client look offline. A red transition is reported immediately; a green transition is coalesced until stable for 900ms. An unchanged generation/signature is suppressed even when legacy callers pass `force=true`; reconnect and explicit server rejection may reset the signature and retry.

- [x] **Step 1: Run and record GitNexus impact before touching the hot path.** Analyze `Room.persistAll`, `Room.webSocketMessage`, `Room.observeDevice`, `Room.snapshot`, `Room.scheduleExpiry`, `touchDevice`, `sendDeviceStatus`, and `setKeepAliveState` upstream with tests included. Warn that shared status, delivery, and alarm paths are HIGH/CRITICAL before editing, then continue under the characterization gates.
- [x] **Step 2: Write the failing server write-budget tests.** In `test/room-write-budget.test.cjs`, use a storage spy that counts map entries as rows and assert: the first real status transition writes only `devices`; 100 identical status messages each receive an ACK but add zero rows and zero broadcasts; 100 sockets over four heartbeat rounds add zero rows, zero alarms, and zero broadcasts; clearing in-memory throttle fields between rounds does not change that result; `true → false → duplicate false → true` creates exactly two canonical transitions; a failed transition write restores the prior durable registry, keeps the current socket identity, forces that live socket red, and sends no success ACK.

```js
assert.equal(metrics.rowsWrittenAfterSteadyState, 0);
assert.equal(metrics.setAlarmCallsAfterSteadyState, 0);
assert.equal(metrics.broadcastsAfterSteadyState, 0);
assert.equal(savedMessages.length, 100);
```

- [x] **Step 3: Run the new tests and confirm the current implementation fails for the intended reason.** Run `node --test test/room-write-budget.test.cjs`; expect failures showing four rows per duplicate `deviceStatus` and periodic rows from heartbeat.
- [x] **Step 4: Add live attachment projection and transition-aware observation.** Implement `projectLiveCoreDevices` as a pure export in `src/room-delivery.js`. In `Room.observeDevice`, capture before/after canonical identity/readiness, update the hibernation attachment, merge live siblings, and return `changed` without treating `lastSeenMs` as a canonical change. Add `persistDevices()` and roll back the durable registry while keeping the live socket fail-closed if that one-key write fails.
- [x] **Step 5: Make `deviceStatus` idempotent and heartbeat transient.** In `Room.webSocketMessage`, only persist/broadcast a real transition; always ACK a valid duplicate. For `hb`, apply a real readiness transition through the same path, otherwise only refresh transient memory. In `snapshot()` clone player records and project current connected pids as online; in command delivery/ACK checks merge the live attachment registry before deriving expected devices.
- [x] **Step 6: Remove the idle QA alarm loop.** `scheduleExpiry()` may set an alarm for command expiry or an active delivery retry/lease, but a ready idle socket with no active delivery record must not maintain the three-second probe loop. Run the existing reliable-delivery retry, cancellation, and expiry tests to prove active windows still wake.
- [x] **Step 7: Write the failing client coalescing tests.** Simulate repeated `playing/waiting` carrier events and `AudioContext` transitions. Assert local readiness turns red immediately, identical network signatures are coalesced, green is sent once after 900ms stable, a new socket generation retries once, and explicit identity rejection clears the retry guard.
- [x] **Step 8: Implement minimal client coalescing.** Keep the current audio graph, carrier, and local `paintAudioStatus()` behavior. Replace forced duplicate sends from `ac.onstatechange` and `setKeepAliveState` with a single status publisher whose negative edge is immediate and whose positive edge uses one replaceable 900ms timer. Treat the 1-second loop boundary as healthy when `playing` recovers within 80ms, while persistent stalls still turn red.
- [x] **Step 9: Run focused and full hotfix gates.** Run `node --test test/room-write-budget.test.cjs test/room-delivery.test.cjs test/reliable-room-delivery.test.cjs test/audio-readiness.test.cjs test/classic-delivery-client.test.cjs`, then `npm test && npm run test:delivery && npm run test:triple && npm run test:kvk-core:all`; expect all to pass and the budget assertions to remain exactly zero in steady state. Final evidence: `npm test` 412/412, Delivery 125/125, Triple 193/193, Chromium/Firefox/WebKit core and compatibility flows passed, and the two-page carrier long-run passed on build `2026071603`.
- [x] **Step 10: Commit the hotfix and validate it independently in fixed QA.** GitNexus detected the expected CRITICAL shared socket/audio/alarm blast radius before commit `a730f510738fb9092a01c4a135aa40c345fa7faa` (`fix: stop idle durable object write amplification`). Fixed room `qa` then passed a two-device remote readiness smoke on QA version `2c2286d1-65c3-4e52-8d55-fbe796e0f116`: both clients showed two online, each emitted one green status, each received one saved green, and neither flapped red. The exact commit was promoted to production version `d6fdf5bc-9b63-4cec-a3ea-4123fe0d572e`; rollback remains `42101b01-fe1d-4639-9c1f-be7ab234bc84`. Full evidence is in `docs/superpowers/qa/2026-07-16-write-budget-hotfix.md`. The later Rally/Defense/UI release remains atomic.

---

### Task 3: Extract the shared room connection and synchronized clock

**Files:**
- Create: `public/battle-connection.js`
- Create: `test/battle-connection.test.cjs`
- Modify: `public/app.js`
- Modify: `public/kvk.js`
- Modify: `public/kvk.html`
- Modify: `test/room-socket.test.cjs`
- Modify: `test/kvk-rally-wiring.test.cjs`

**Interface:**

```js
var connection = BattleConnection.createRoomConnection({
  room: "qa",
  surface: "rally",             // only "rally" or "defense"
  clientBuild: 2026071603,
  onMessage: function (message) {},
  onConnectionChange: function (state) {},
  onClockChange: function (sample) {}
});

connection.start();
connection.send({ t: "hello" });
connection.serverNowMs();
connection.clockFresh();
connection.generation();        // monotonically increases for each socket generation
connection.stop();
```

For example, Rally room `qa` at this release connects to `/api/ws?room=qa&surface=rally&clientBuild=2026071603`; Defense changes only `surface=defense`. Reconnect timers are generation-scoped so a stale socket cannot update the new page. Clock sync keeps the lowest-RTT sample and refreshes at the existing cadence.

- [x] **Step 1: Run GitNexus impact for `RoomSocket`, `syncClock`, `beginClockSync`, and each current caller to be edited.** `beginClockSync`, `connect`, and `updateSync` were LOW; `RoomSocket` and `syncClock` initially had UNKNOWN graph coverage, so their existing socket and Rally characterization tests were retained as compensating gates. Final change detection was HIGH because the shared connection fans into ten Rally/Delivery/audio flows.
- [x] **Step 2: Write failing module tests.** The first run failed because `public/battle-connection.js` did not exist. The final suite covers browser UMD and CommonJS loading, `http→ws` and `https→wss`, surface rejection, generation-scoped reconnect, callback ordering, explicit stop, adapter compatibility, lowest-RTT clock selection, 359999/360000ms freshness boundaries, failure without false renewal, and 180-second resynchronization.
- [x] **Step 3: Implement `battle-connection.js` in the repository's UMD/CommonJS style.** Connection and clock behavior now live in a DOM-free module with no Rally roles, Defense rules, audio, identity, or profile storage.
- [x] **Step 4: Adapt Rally through a thin compatibility wrapper.** `/battle-connection.js` loads before `app.js`; the legacy `RoomSocket` API delegates to it and Rally explicitly connects with `surface=rally`. Existing callbacks, global clock fields, initial sync, reconnect, and visible behavior remain compatible.
- [x] **Step 5: Run focused tests.** Final focused evidence: 41/41 passed, including the three independent review follow-ups.
- [x] **Step 6: Run the Rally regression gate.** Fresh final evidence: `npm test` 423/423, Delivery 125/125, Triple 193/193, and Chromium Core + Compatibility 1/1. Two independent read-only reviews found zero Critical and zero Important issues.
- [ ] **Step 7: Run GitNexus change detection and commit.** Commit with `refactor: share battle connection and clock`.

---

### Task 4: Extract the shared audio engine, readiness truth, and absolute-time cue scheduler

**Files:**
- Create: `public/battle-audio.js`
- Create: `public/battle-status.js`
- Create: `public/battle-cues.js`
- Create: `test/battle-audio.test.cjs`
- Create: `test/battle-status.test.cjs`
- Create: `test/battle-cues.test.cjs`
- Modify: `public/kvk.js`
- Modify: `public/kvk.html`
- Modify: `test/audio-readiness.test.cjs`
- Modify: `test/delivery-browser-wiring.test.cjs`
- Modify: `test/rally-audio-characterization.test.cjs`

**Interfaces:**

```js
var audio = BattleAudio.createAudioEngine({
  language: function () { return "en"; },
  mediaTitle: "Kingshoter Rally",
  onStateChange: paintReadiness
});

var cues = BattleCues.createCueScheduler({
  audio: audio,
  nowMs: connection.serverNowMs,
  onScheduled: onCueScheduled,
  onError: onCueError
});

cues.reconcile([{
  id: "command-id:revision:pid",
  targetAtMs: 1784239200000,
  events: [
    { offsetMs: -10000, kind: "beep" },
    { offsetMs: -5000, kind: "clip", name: "5" },
    { offsetMs: 0, kind: "clip", name: "go" }
  ]
}]);
cues.cancel("command-id:revision:pid");
cues.cancelScope("command-id:revision");
cues.hasFutureCue("command-id:revision:pid");
cues.snapshot();
```

`BattleAudio` owns Web Audio, keep-alive, MediaSession, Wake Lock, test sound, and media playback. `BattleCues` owns timer IDs, cue IDs, cancellation, reconciliation, future-only reconnect, and clock-drift replanning. Neither module selects an audience, sends an ACK, mutates a profile, or paints DOM.

```js
BattleStatus.deriveReadiness({
  userEnabled: true,
  audioContextRunning: true,
  carrierAlive: true,
  connected: true,
  clockFresh: true
}); // { level: "ready", green: true, reasons: [] }
```

The returned readiness object is the single source for the visible lamp, `deviceStatus` heartbeat, and delivery ACK. A page must never paint red from one calculation while reporting green from another, or paint green before all five measurable conditions are true.

- [ ] **Step 1: Run GitNexus impact for `ensureAudio`, `audioAlive`, `paintAudioStatus`, `keepAwake`, `scheduleBeeps`, `schedulePrepareCue`, `reconcileCues`, and `rebookCuesOnDrift`.** Warn before editing because `audioAlive` is CRITICAL and `scheduleBeeps` is HIGH.
- [ ] **Step 2: Write failing engine tests.** Use fake AudioContext/media/timers to assert explicit enablement, carrier health, status transitions, exact SFX file paths, no duplicate node graph, `cancel`, `cancelScope`, `hasFutureCue`, scheduler `snapshot`, and dispose cleanup. Assert the same derived readiness object drives the lamp, heartbeat, and ACK so the prior “audio is audible but the page remains red” state cannot arise from divergent client calculations. Run the three new tests and expect module-not-found failures.
- [ ] **Step 3: Implement the audio engine and readiness projection.** Preserve the existing 40Hz carrier and `/sfx/{en,zh}_{5,4,3,2,1,go}.mp3` files byte-for-byte; do not add new assets.
- [ ] **Step 4: Implement the generic cue scheduler.** It accepts explicit events. Keep Rally policy in the Rally adapter; do not hard-code T-15 into the shared scheduler.
- [ ] **Step 5: Adapt Rally one function at a time.** After each adapter replacement, run `node --test test/rally-audio-characterization.test.cjs test/audio-readiness.test.cjs test/battle-audio.test.cjs test/battle-status.test.cjs test/battle-cues.test.cjs`. Delete an old implementation only after its adapter passes.
- [ ] **Step 6: Prove commander and participant routing remain unchanged.** Run `node --test test/commander-launch-monitor.test.cjs test/kvk-rally-wiring.test.cjs test/delivery-browser-wiring.test.cjs`.
- [ ] **Step 7: Run all unit and browser-core regressions.** Run `npm test && npm run test:delivery && npm run test:triple && npm run test:kvk-core:all`.
- [ ] **Step 8: Run GitNexus change detection and commit.** Commit with `refactor: share battle audio and cue scheduling`.

---

### Task 5: Extract shared identity, profile persistence, and client acknowledgement retry primitives

**Files:**
- Create: `public/battle-identity.js`
- Create: `public/battle-delivery.js`
- Create: `test/battle-identity.test.cjs`
- Create: `test/battle-delivery.test.cjs`
- Modify: `public/kvk.js`
- Modify: `public/kvk.html`
- Modify: `test/player-protocol-client.test.cjs`
- Modify: `test/identity-input.e2e.cjs`
- Modify: `test/classic-delivery-client.test.cjs`

**Interfaces and storage rules:**

```js
var identity = BattleIdentity.createIdentityStore({
  room: "qa",
  surface: "defense",
  storage: localStorage,
  rallyPrefill: true
});

identity.readConfirmed();       // surface-specific registration only
identity.readRallyPrefill();    // identity + march suggestion, never registration
identity.saveConfirmed(profile);

var queue = BattleDelivery.createAckQueue({
  send: function (message) { connection.send(message); },
  nowMs: connection.serverNowMs,
  generation: function () { return connection.generation(); }
});
queue.enqueue({ key: "order:revision:pid:device", payload: ack, deadlineAtMs: goAtMs });
queue.confirm(key);
queue.cancelScope("order:revision");
```

Rally continues to read its existing profile and device keys. Defense uses independent confirmed-profile/device keys. A Rally profile may prefill the Defense form, but Defense does not send registration until the player confirms the Defense form.

- [ ] **Step 1: Run GitNexus impact for `saveProfile`, profile read/recovery functions, `getRoomDeviceId`, `sendDeviceStatus`, `deliveryAckKey`, `enqueueDeliveryAck`, `retryPendingDeliveryAcks`, and their callers.** Warn because `saveProfile` is CRITICAL.
- [ ] **Step 2: Write failing identity tests.** Cover Player ID and nickname switching both ways, nickname escaping/length, march range 5–120, per-room/per-surface keys, legacy Rally key compatibility, Defense prefill without silent registration, and 16px input class wiring.
- [ ] **Step 3: Write failing ACK queue tests.** Cover device/profile/order/revision keying, retry backoff, generation changes, deadline cutoff, confirmation, cancellation, reconnect, and duplicate enqueue.
- [ ] **Step 4: Implement both pure UMD modules.** Do not include DOM rendering, Rally role logic, or Defense order calculations.
- [ ] **Step 5: Replace Rally profile and ACK helpers with adapters.** Preserve current server messages and localStorage compatibility. Run focused tests after each replacement.
- [ ] **Step 6: Run `node --test test/battle-identity.test.cjs test/battle-delivery.test.cjs test/player-protocol-client.test.cjs test/classic-delivery-client.test.cjs test/mobile-input-font.test.cjs`; expect all pass.**
- [ ] **Step 7: Run `npm test && npm run test:delivery && npm run test:triple`; then run GitNexus change detection and commit.** Commit with `refactor: share battle identity and delivery client`.

---

### Task 6: Build the shared Apple-inspired battle shell, status strip, and manager drawer

**Files:**
- Create: `public/battle-ui.css`
- Create: `public/battle-drawer.js`
- Create: `test/battle-ui-contract.test.cjs`
- Create: `test/battle-drawer.test.cjs`
- Create: `test/battle-drawer.e2e.cjs`
- Modify: `public/battle-status.js`
- Modify: `test/battle-status.test.cjs`
- Modify: `public/app.css`
- Modify: `public/kvk.html`
- Modify: `public/kvk.js`
- Modify: `test/mobile-input-font.test.cjs`

**Interfaces:**

```js
BattleStatus.project(readiness, {
  managerOnly: false,
  connectedCount: 0,
  language: "en"
});
// -> { level, label, detail, action, managerMeta }

var drawer = BattleDrawer.create({
  root: drawerElement,
  handle: handleElement,
  background: battleMainElement,
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)"),
  onStateChange: function (state) {}
});
drawer.state();          // "closed" | "command" | "manage"
drawer.openCommand();
drawer.openManage();
drawer.backToCommand();
drawer.close();
drawer.destroy();
```

`BattleDrawer` knows no Rally or Defense messages and performs no socket, storage, or status writes. Authentication remains in each surface controller and is independent from drawer state. Command detent is non-modal and preserves the live tactical view above it; Manage detent marks the background inert, traps/restores focus, and exposes a visible `Back to command` control. Pointer drag begins only on the handle/header after a 10px intent threshold, follows the finger 1:1 from its grab offset, applies bounded rubber-band beyond detents, and settles from projected position plus velocity. Every gesture has button and keyboard equivalents.

- [ ] **Step 1: Write failing semantic-token tests.** Parse computed styles in a minimal fixture and assert: primary/secondary text and status foregrounds meet AA contrast; critical text is at least 11px; text inputs are at least 16px at mobile widths; interactive hit regions are at least 44px; one safe-area inset is consumed; forms/progress/maps/lists are opaque; translucent material appears only on the allowed status/drawer/fire layers; reduced-transparency has a solid fallback.
- [ ] **Step 2: Write failing status-projection tests.** Assert `ready` only when enablement, AudioContext, carrier, socket, and clock are all healthy; audio recovery is amber/actionable; disconnection is red; manager-only projects `Manager connected · clock synced` without a personal audio warning; ordinary projections contain no online count; `managerMeta` may contain connected count; labels never claim game response, march, defense, or arrival.
- [ ] **Step 3: Write failing pure drawer tests.** Cover all legal transitions, 10px intent, 1:1 delta, grab-offset preservation, velocity projection, rubber-band bounds, interruption/reversal, no drag from a scrolling player list, idempotent programmatic calls, destroy cleanup, and reduced-motion settling without spring travel.
- [ ] **Step 4: Run the new tests and confirm module/style failures.** Run `node --test test/battle-ui-contract.test.cjs test/battle-status.test.cjs test/battle-drawer.test.cjs`; expect missing module/token failures.
- [ ] **Step 5: Implement semantic battle tokens and shared component styles.** Layer `battle-ui.css` as tokens, base accessibility, shared cards/status, drawer, then responsive overrides. Preserve existing font and brand variables through semantic aliases; do not restyle non-battle pages yet.
- [ ] **Step 6: Implement the pure status projector.** Render text plus icon/shape for every state. The same readiness input object remains the source for visible status, `deviceStatus`, and ACK; the projector adds copy and manager metadata only.
- [ ] **Step 7: Implement the drawer state machine and pointer controller.** Use Pointer Events and pointer capture; update one transform custom property during drag; animate only transform/opacity; allow a new pointerdown to interrupt the current settle; never write storage, send messages, or recalculate page data during motion.
- [ ] **Step 8: Adapt the current Rally console as a compatibility proof.** Add a handle, visible close/back controls, and the three detents around the existing console without changing selection, Fire, Cancel, audio, or password validation. A successful password remains in page memory after `close()`; only an explicit invalidation/logout path clears it.
- [ ] **Step 9: Run the browser interaction matrix.** Run `node test/battle-drawer.e2e.cjs`; assert pointer/touch/mouse/keyboard paths, live background repaint while command is open, inert/focus behavior in manage, 320/375/390/430 widths, no horizontal overflow, and reduced-motion/reduced-transparency fallbacks.
- [ ] **Step 10: Run `node --test test/battle-ui-contract.test.cjs test/battle-status.test.cjs test/battle-drawer.test.cjs test/mobile-input-font.test.cjs test/cancel-rally-selection.test.cjs test/commander-launch-monitor.test.cjs`, then `npm test && npm run test:triple`.** Expect all pass.
- [ ] **Step 11: Run GitNexus change detection and commit.** Commit with `feat: add shared battle shell and manager drawer`.

---

### Task 7: Add the pure Defense timing, lifecycle, and delivery domains

**Files:**
- Create: `src/defense-domain.js`
- Create: `src/defense-delivery.js`
- Create: `test/defense-domain.test.cjs`
- Create: `test/defense-delivery.test.cjs`
- Modify: `src/room-player.js`
- Modify: `test/player-domain.test.cjs`

**Persistent Defense state:**

```js
{
  version: 1,
  config: {
    tapAnchorSeconds: 180,
    enemyMarchSeconds: null,
    revision: 0,
    updatedAt: null
  },
  players: {},
  pendingRemovalPids: [],
  orderRevision: 0,
  activeOrder: null,
  lastTerminal: null,
  recentMutations: []
}
```

**Immutable order:**

```js
{
  id: "uuid",
  revision: 12,
  mutationId: "client-uuid",
  signalAtMs: 1784239200000,
  acceptedAtMs: 1784239200040,
  tapAnchorSeconds: 180,
  enemyMarchSeconds: 30,
  enemyLaunchAtMs: 1784239380000,
  enemyImpactAtMs: 1784239410000,
  rosterAtAcceptance: [{
    pid: "stable-routing-key-offline",
    displayName: "Brandon",
    identityMode: "nickname",
    playerId: "",
    march: 13,
    marchRevision: 1,
    connectedAtAcceptance: false,
    validAtAcceptance: true
  }, {
    pid: "stable-routing-key-kimchi",
    displayName: "Kimchi",
    identityMode: "nickname",
    playerId: "",
    march: 34,
    marchRevision: 3,
    connectedAtAcceptance: true,
    validAtAcceptance: true
  }],
  audience: [{
    pid: "stable-routing-key-kimchi",
    displayName: "Kimchi",
    identityMode: "nickname",
    playerId: "",
    march: 34,
    marchRevision: 3,
    goAtMs: 1784239376000,
    tooLate: false
  }],
  completeAtMs: 1784239377000
}
```

`rosterAtAcceptance` contains every registered Defense profile at acceptance; `audience` is its connected-and-valid subset. `pid` is the public stable routing key. The secret browser `profileKey` and its hash never enter either snapshot.

The calculation is exact and adds no offset:

```js
enemyLaunchAtMs = signalAtMs + tapAnchorSeconds * 1000;
enemyImpactAtMs = enemyLaunchAtMs + enemyMarchSeconds * 1000;
goAtMs = enemyImpactAtMs - defenderMarchSeconds * 1000;
```

- [ ] **Step 1: Run GitNexus impact for `parseMarchSeconds`, `applyOwnProfileUpdate`, `applyPlayerMarchUpdate`, and the room-player export surface before adding any shared Defense guard.**
- [ ] **Step 2: Write failing timing/config tests.** Cover default 3:00, anchor 0:05–5:00, enemy march 0:05–2:00, defender march 0:05–2:00, both endpoints, invalid MM:SS, exact launch/impact/GO equations, and zero artificial offset.
- [ ] **Step 3: Write failing lifecycle tests.** Cover immutable `rosterAtAcceptance`, audience/profile revisions, only connected valid profiles, frozen offline/invalid metrics, a new mid-order profile not changing this round's counts, late profiles, no future GO fallback completion at acceptance +3s, latest future GO +1s, one active order, 64-entry mutation ledger, duplicate mutation idempotency, two-manager first-writer wins, cancellation tombstone, stale revision rejection, queued active-order removal, and completion.
- [ ] **Step 4: Write failing delivery tests.** Cover `(orderId, revision, pid, deviceId)` deduplication, outcomes `scheduled`, `audio_unready`, `clock_stale`, `schedule_failed`, and `too_late`; aggregate multiple devices into one profile result.
- [ ] **Step 5: Implement pure functions only.** Export `defaultDefenseState`, `normalizeDefenseState`, `updateDefenseConfig`, `createDefenseOrder`, `cancelDefenseOrder`, `completeDefenseOrder`, `nextDefenseWakeAt`, `publicDefenseSummary`, `normalizeDefenseDevice`, `recordDefenseAck`, and `aggregateDefenseDelivery`.
- [ ] **Step 6: Add Defense removal projection helpers to `room-player.js`.** Reuse existing identity/march validators; do not copy them into the Defense domain. If a captured player is removed during an active order, add the pid to `pendingRemovalPids`: the frozen audience and ownership recovery remain valid through that order, the card says removal applies next round, and completion/cancellation atomically purges the canonical profile, owner binding, and devices. Removing a non-captured player remains immediate and confirmed.
- [ ] **Step 7: Run `node --test test/defense-domain.test.cjs test/defense-delivery.test.cjs test/player-domain.test.cjs`; expect all pass.**
- [ ] **Step 8: Run GitNexus change detection and commit.** Commit with `feat: add defense timing and delivery domains`.

---

### Task 8: Add surface-aware socket attachments and isolated persistence without changing Rally

**Files:**
- Create: `src/room-surface.js`
- Create: `test/room-surface.test.cjs`
- Create: `test/surface-isolation.test.cjs`
- Create: `test/support/qa-coordination.cjs`
- Modify: `src/room.js`
- Modify: `src/room-delivery.js`
- Modify: `src/delivery.js`
- Modify: `src/rally-mode.js`
- Modify: `public/kvk-delivery-shadow.js`
- Modify: `test/room-harness.cjs`
- Modify: `test/support/qa-kvk.cjs`
- Modify: `test/support/legacy-kvk-script-guard.cjs`
- Modify: `test/delivery-browser-wiring.test.cjs`
- Modify: `test/delivery-model.test.cjs`
- Modify: `test/delivery-shadow-client.test.cjs`
- Modify: `test/qa-kvk-delivery-guard.test.cjs`
- Modify: `test/qa-kvk.test.cjs`
- Modify: `test/legacy-kvk-script-guard.test.cjs`
- Modify: `test/kvk-core-multibrowser.e2e.cjs`
- Modify: `test/rally-mode.test.cjs`
- Modify: `test/room-delivery.test.cjs`
- Modify: `test/reliable-room-delivery.test.cjs`
- Modify: `test/triple-room.test.cjs`

**Storage keys:**

```js
"room"                       // Rally only, existing key
"defense:v1"                 // Defense config, roster, order lifecycle
"defenseProfileOwners:v1"    // Defense profile ownership hashes
"defenseDevices:v1"          // Defense device observations
"defenseAcks:v1"             // Defense order acknowledgements
```

**Socket attachment:**

```js
{
  roomName: "qa",
  surface: "rally",          // missing is accepted as Rally only during migration
  pid: "",
  deviceId: "",
  soundReady: false,
  clockFresh: false,
  managerStatusAtMs: 0,
  managerAuthorized: false,
  clientBuild: 2026071603
}
```

The QA predicate becomes exact, not prefix-based:

```js
export function isQaRoomName(room) {
  return String(room || "") === "qa";
}
```

- [ ] **Step 1: Run GitNexus impact for `Room`, `snapshot`, `stateMsg`, `broadcast`, `persistAll`, `attachSocket`, `readSocketAttachment`, `writeSocketAttachment`, `webSocketMessage`, `scheduleExpiry`, `alarm`, `webSocketClose`, `webSocketError`, `isQaRoomName`, and `isTripleAllowed`.** Also inspect the browser delivery-shadow callers before changing its QA predicate. Warn before editing all HIGH/CRITICAL symbols.
- [ ] **Step 2: Extend the room harness first.** Add `test/support/qa-coordination.cjs` with fixed room `qa`, exact-origin protection, Rally/Defense URL builders, and the WebSocket guard. Make `test/support/qa-kvk.cjs` a temporary API-compatible re-export whose `makeQaRoom()` always returns `qa`; update the legacy-script guard copy and tests accordingly. Support `surface`, multiple sockets, per-socket attachments, manager/ordinary sockets, a mutable fake clock, storage maps, sent-frame inspection, and normal manager cleanup between scenarios. No executable test may open a generated remote room after this step.
- [ ] **Step 3: Write failing surface tests.** Connect Rally and Defense sockets to the same Room instance; assert missing surface maps to Rally, invalid surface is rejected, Rally snapshots never include Defense keys, Defense ordinary snapshots never include Rally keys or full roster, and surface broadcasts reach only matching sockets. Open 100 Defense sockets and prove Rally presence does not change; open Rally sockets and prove Defense profile/device presence does not change.
- [ ] **Step 4: Implement `normalizeSurface` and attachment persistence.** Preserve the same DO key and existing Rally device binding. Surface becomes immutable once attached; a message cannot change it.
- [ ] **Step 5: Load and persist the five namespaces independently.** Existing `persist()` and `persistAll()` remain Rally-only; add focused Defense persistence methods so a Defense failure cannot roll back Rally state or vice versa.
- [ ] **Step 6: Split state projection and broadcasting.** Keep `snapshot()/stateMsg()/broadcast()` as Rally adapters during migration, add `rallySnapshot`, `defensePlayerSnapshot`, `defenseManagerSnapshot`, `stateMsgForSocket`, `broadcastSurface`, and bounded `sendDefenseDelta`.
- [ ] **Step 7: Migrate the QA predicate to fixed room `qa`.** Change both `src/delivery.js` and the current Rally delivery-shadow adapter to accept exactly `qa` and reject every generated `qa-kvk-*` name. Verify `src/rally-mode.js` enables the QA Triple gate for `qa` through that shared predicate; update delivery/Triple/core-browser tests and add explicit cancel/remove cleanup between fixed-room scenarios before continuing.
- [ ] **Step 8: Restrict protocol families with explicit allowlists.** Rally allows only `setRallyMode`, `deviceStatus`, `deliveryAck`, `registerPlayer`, `updateOwnProfile`, `updateOwnMarch`, `setPlayerMarch`, `removePlayer`, `setConfig`, `cmd`, `stage`, `ready`, `sim`, `hb`, `hello`, and the existing reliable-delivery ingress messages `deliveryShadowHello`, `deliveryShadowProbeAck`, and `deliveryShadowAck`; its server may still emit `deliveryShadowProbe`, `deliveryShadowCommand`, and `deliveryShadowCancel`. Defense allows only `registerPlayer`, `updateOwnProfile`, `updateOwnMarch`, `setPlayerMarch`, `removePlayer`, `defenseDeviceStatus`, `defenseManagerStatus`, `defenseUnlock`, `setDefenseConfig`, `fireDefense`, `cancelDefense`, `defenseOrderAck`, `hb`, and `hello`. Any `deliveryShadow*` frame on Defense, or any other cross-surface operational message, receives `wrong_surface` and cannot mutate storage. Preserve the current Rally response for unknown/future `deliveryShadow*` versions and add focused regression assertions.
- [ ] **Step 9: Run `node --test test/room-surface.test.cjs test/surface-isolation.test.cjs test/room-delivery.test.cjs test/reliable-room-delivery.test.cjs test/player-protocol.test.cjs test/delivery-model.test.cjs test/delivery-shadow-client.test.cjs test/rally-mode.test.cjs test/triple-room.test.cjs`; expect all pass.**
- [ ] **Step 10: Run `npm test && npm run test:delivery && npm run test:triple && npm run test:kvk-core:all`; then run GitNexus change detection and commit.** Commit with `refactor: isolate room traffic by battle surface`.

---

### Task 9: Implement the Defense room protocol, one-order lock, and bounded deltas

**Files:**
- Create: `test/defense-room.test.cjs`
- Create: `test/defense-order-concurrency.test.cjs`
- Modify: `src/room.js`
- Modify: `src/defense-domain.js`
- Modify: `src/defense-delivery.js`
- Modify: `test/room-harness.cjs`

**Client-to-server protocol:**

```js
{ t: "registerPlayer", registrationId, profileKey, pid, identityMode, playerId, name, march }
{ t: "updateOwnProfile", mutationId, profileKey, pid, baseRevision, identityMode, playerId, name, march }
{ t: "updateOwnMarch", mutationId, profileKey, pid, baseRevision, march }
{ t: "defenseDeviceStatus", pid, deviceId, soundReady, clockFresh }
{ t: "defenseUnlock", password }
{ t: "defenseManagerStatus", deviceId, clockFresh, clockSampleAtMs, clockOffsetMs }
{ t: "setDefenseConfig", password, mutationId, baseRevision, tapAnchorSeconds, enemyMarchSeconds }
{ t: "fireDefense", password, mutationId, configRevision, signalAtMs }
{ t: "cancelDefense", password, mutationId, orderId, orderRevision }
{ t: "defenseOrderAck", orderId, orderRevision, pid, deviceId, goAtMs, outcome, audioReady, clockFresh }
{ t: "hb", pid, deviceId, soundReady, clockFresh }
```

`defenseManagerStatus` is accepted only after `defenseUnlock` and has a fixed 70,000ms lease. It carries no pid and cannot register or target the manager as a defender.

**Server messages:**

```js
{ t: "defenseState", config, ownProfile, activeOrderForOwnProfile, readiness, orderRevision }
{ t: "defenseManagerState", config, counts, issues, distribution, activeOrder, playersPage }
{ t: "defenseProfileDelta", profile }
{ t: "defensePresenceDelta", pid, connectedDevices, audioReadyDevices }
{ t: "defenseOrderAccepted", order }
{ t: "defenseOrderCancelled", orderId, revision }
{ t: "defenseOrderCompleted", orderId, revision }
{ t: "defenseAckSaved", orderId, revision, pid, deviceId, outcome }
{ t: "error", source, mutationId, error, canonicalRevision }
```

- [ ] **Step 1: Run fresh GitNexus impact for every `Room` method touched in this task.** The earlier report does not substitute for a fresh check after Task 8.
- [ ] **Step 2: Write failing registration/privacy tests.** Reuse `room-player.js` against the Defense roster; assert Player ID/nickname registration, profile ownership, march edit revision, immediate non-captured removal, queued captured removal, 150-profile cap, no full roster for ordinary sockets, and manager roster only after successful `defenseUnlock`.
- [ ] **Step 3: Write failing order tests.** Assert config persistence/revision conflict, identity-free `defenseManagerStatus`, manager clock freshness, exact signal bounds of 5s past/1s future, immutable connected-profile audience, frozen roster/offline/invalid counts, new player waits next round without changing this round's metrics, multi-device audience dedupe, Too late, single active order, next-order blocking, concurrent-manager first writer, duplicate mutation idempotency, and manager-only silence projection.
- [ ] **Step 4: Write failing cancel/complete/reconnect tests.** Assert cancellation revision and tombstone, future cue restoration for captured reconnect, no restoration for new profile, automatic completion, next-round automatic waiting, and no stale-message resurrection.
- [ ] **Step 5: Implement `handleDefenseMessage`.** Branch from immutable socket `surface` before parsing operational messages. First successful Defense unlock on an unclaimed room sets the shared `pwHash`; later unlocks use the existing `authOK` path. Never store the plaintext password. `defenseManagerStatus` binds clock freshness to the authenticated manager socket without requiring a defender pid and expires after exactly 70,000ms. Accept `signalAtMs` only in `[serverNowMs - 5000, serverNowMs + 1000]`, require that fresh manager status, and preserve the accepted client click timestamp rather than replacing it with receive time.
- [ ] **Step 6: Implement bounded updates.** Registration, profile, presence, device, and ACK changes send deltas to Defense sockets; they do not call a full-room per-second broadcast. Manager aggregates dedupe by profile.
- [ ] **Step 7: Extend `scheduleExpiry()` and `alarm()`.** Include `activeOrder.completeAtMs`; completion persists a terminal revision and sends one canonical completion. Do not introduce a countdown interval in the Durable Object.
- [ ] **Step 8: Run focused backend tests.** Run `node --test test/defense-room.test.cjs test/defense-order-concurrency.test.cjs test/surface-isolation.test.cjs test/reliable-room-delivery.test.cjs`; expect all pass.
- [ ] **Step 9: Run the full backend/Rally gate.** Run `npm test && npm run test:delivery && npm run test:triple`; then run GitNexus change detection and commit with `feat: add isolated defense room protocol`.

---

### Task 10: Build the ordinary Defense page and personal countdown

**Files:**
- Create: `public/defense.html`
- Create: `public/defense-domain.js`
- Create: `public/defense-controller.js`
- Create: `public/defense.css`
- Create: `test/defense-client-domain.test.cjs`
- Create: `test/defense-client.test.cjs`
- Create: `test/defense-audio.test.cjs`
- Modify: `public/app.css`
- Modify: `public/app.js`
- Test: `test/mobile-input-font.test.cjs`

**Client timing projection:**

```js
DefenseDomain.personalOrder(order, pid, nowMs);
// -> { captured, tooLate, goAtMs, phase, remainingMs }

DefenseDomain.cuePlan(personalOrder);
// -> [{ T-15 prepare }, { T-10..6 beep }, { 5..1 clips }, { T0 go }]
```

**Ordinary mobile reading order:**

```text
compact connection + local clock
identity / march-time card
one-line audio readiness
personal march progress bar
waiting or personal countdown card
collapsed Defense console entry
```

- [ ] **Step 1: Write failing pure client tests.** Cover server-order projection, exact personal GO, T-15/T-10/T-5/T0 events, Too late with no partial cue, future-only reconnect, cancel scope, completion, one GO per revision, and clock-drift replan.
- [ ] **Step 2: Write failing controller tests.** Cover Rally identity prefill but explicit Defense confirmation, Defense-only registration key, audio gesture requirement, status/ACK only after local scheduling, manager-only no schedule, captured manager+defender one personal schedule, and next-round automatic waiting.
- [ ] **Step 3: Add `defense.html` using existing mobile card classes and shared modules.** Include no roster, Attack/Defense switch, enemy-whale calculator, castle radar, or manager metrics on the ordinary surface.
- [ ] **Step 4: Implement the Defense controller.** Connect with `surface=defense`, render only the current profile, derive time locally from absolute UTC, reconcile cue scope on every canonical order/cancel/complete, and ACK only after successful scheduling.
- [ ] **Step 5: Implement waiting and active UI.** Keep the player's progress bar. In active state show only that player's phase/countdown and `Now`; never display or speak other defenders' personal times.
- [ ] **Step 6: Add English and Chinese strings.** Use precise website-state wording and the existing test-alert language. The T0 visible/spoken copy is exactly `Now` / the existing GO asset.
- [ ] **Step 7: Run `node --test test/defense-client-domain.test.cjs test/defense-client.test.cjs test/defense-audio.test.cjs test/battle-audio.test.cjs test/battle-cues.test.cjs test/mobile-input-font.test.cjs`; expect all pass.**
- [ ] **Step 8: Check 320/375/390/430 widths with Playwright component fixtures.** Assert no horizontal overflow, no focus zoom, status not conveyed by color alone, reduced-motion fallback, long-name truncation, and constant ordinary-page height with an injected 100-player manager snapshot.
- [ ] **Step 9: Run GitNexus change detection and commit.** Commit with `feat: add personal voice defense page`.

---

### Task 11: Build the two-tab Defense manager console for large rosters

**Files:**
- Create: `public/defense-manager.js`
- Create: `public/virtual-list.js`
- Create: `test/defense-manager.test.cjs`
- Create: `test/virtual-list.test.cjs`
- Create: `test/defense-manager-ui.e2e.cjs`
- Modify: `public/defense.html`
- Modify: `public/defense-controller.js`
- Modify: `public/defense.css`

**Manager tabs:**

```text
Status
  waiting: registered, audio-ready, red, offline, invalid, exception-first list,
           march distribution, anchor, enemy march, primary signal action
  active:  expected impact, inputs, targeted, delivered/scheduled, audio-ready,
           red/unconfirmed, offline roster, too late, next alert wave, wave groups,
           disclaimer, Cancel Defense Order

Players
  two-column virtual list, search, filters, sort, details, edit march, remove confirm
```

**Virtual list interface:**

```js
var list = VirtualList.create({
  container: element,
  rowHeight: 76,
  columns: function (width) { return width >= 360 ? 2 : 1; },
  overscanRows: 3,
  renderItem: renderPlayerCard
});
list.setItems(projectedPlayers);
list.scrollToKey(pid);
```

- [ ] **Step 1: Write failing status tests.** Assert pre-order issue counts/distribution and active-order delivery aggregates, website-expected impact wording, next wave grouping, frozen values, disclaimer, and manager-only silent behavior.
- [ ] **Step 2: Write failing Players tests.** Generate 150 profiles and cover case-insensitive Player ID/nickname search; ready/red/offline/invalid/unconfirmed/Too-late filters; march sort while waiting; GO sort while active; duplicate-nickname distinguishing marker; escaping; detail opening; revision conflict; next-round edit label; immediate non-captured removal; and captured removal queued until the active order terminates.
- [ ] **Step 3: Write failing virtualization tests.** Assert a bounded DOM node count, two columns at supported mobile widths, one column below the threshold, stable scroll anchoring after delta updates, keyboard focus retention, and no layout work for off-screen cards.
- [ ] **Step 4: Implement the collapsed console and authentication.** Unlocking does not register a defender. Retain successful unlock for the current page/session so collapsing and reopening does not ask for the password again. After unlock, send `defenseManagerStatus` immediately and every 20s from the shared clock state even when the device has no defender pid; stop the loop on disconnect or console session teardown.
- [ ] **Step 5: Implement Status.** Default anchor is 3:00; accepted anchor is 0:05–5:00 and enemy march is 0:05–2:00. Enemy march starts empty and fire remains disabled until the manager saves a valid value. The primary label is `Tap when enemy rally shows M:SS`. Disable immediately on click and remain locked until canonical acceptance/rejection. Lock both timing inputs during an active order. On a stale config revision, retain the manager's draft and require an explicit retry against the latest canonical revision.
- [ ] **Step 6: Implement Players with virtual rendering and bounded deltas.** During an active order show frozen march/GO and clearly label canonical edits or a captured-player removal as next-round changes.
- [ ] **Step 7: Implement cancellation.** Require manager confirmation, cancel all future cue scopes only after the canonical cancellation frame, preserve profiles/config/audio readiness, and return all profiles to automatic waiting.
- [ ] **Step 8: Run `node --test test/defense-manager.test.cjs test/virtual-list.test.cjs test/defense-client.test.cjs`; expect all pass.**
- [ ] **Step 9: Run `node test/defense-manager-ui.e2e.cjs`; expect Status/Players, 150-profile scrolling, edit/remove confirmation, manager silence, and mobile-width assertions to pass.**
- [ ] **Step 10: Run GitNexus change detection and commit.** Commit with `feat: add scalable defense manager console`.

---

### Task 12: Modernize the ordinary Rally page and make the tactical field truthful

**Files:**
- Create: `public/rally.css`
- Create: `public/rally-tactical.js`
- Create: `test/rally-tactical.test.cjs`
- Create: `test/rally-player-layout.test.cjs`
- Create: `test/rally-tactical.e2e.cjs`
- Modify: `public/kvk.html`
- Modify: `public/kvk.js`
- Modify: `public/app.css`
- Modify: `test/map-render-key.test.cjs`
- Modify: `test/kvk-home-layout.test.cjs`
- Modify: `test/march-domain.e2e.cjs`
- Modify: `test/commander-launch-monitor.test.cjs`
- Modify: `test/commander-launch-monitor.e2e.cjs`
- Modify: `test/cancel-rally-selection.test.cjs`

**Interfaces:**

```js
RallyTactical.scaleMax(selectedMarchSeconds);
// min(120, max(5, max(selectedMarchSeconds) * 1.08))

RallyTactical.actorProjection({
  marchSeconds,
  pressAtMs,
  gatherEndsAtMs,
  nowMs,
  scaleMaxSeconds,
  departureRadius
});
// idle/staged or gathering -> progress 0 and full departure radius
// marching -> progress clamp((nowMs - gatherEndsAtMs) / (marchSeconds * 1000), 0, 1)
// radius -> departureRadius * (1 - progress)

RallyTactical.selectedGroups(room);
// both kingdoms, canonical Double/Triple order, at most six selected captains
```

The upper role bars retain a fixed 120-second scale and exact `M:SS` text so cross-player timing remains comparable. The lower castle field uses actual current maximum march with 8% visual headroom and the full usable radius. It does not round to a 30-second bucket. The castle field is explanatory; progress bars and exact time labels remain authoritative.

- [ ] **Step 1: Run GitNexus impact for `mapData`, `domainFor`, `ringR`, `renderRadar`, `laneRow`, `renderLanes`, `mapRenderKey`, `mapFrame`, `paintChrome`, `paintHero`, `commanderLaunchRows`, and `paintCommanderLaunchMonitor`.** Warn before modifying any HIGH/CRITICAL renderer or routing function.
- [ ] **Step 2: Write failing tactical projection tests.** Assert `[13,34,36,40]` yields scale `43.2`, the 40-second actor uses about 92.6% of the usable radius, all values cap at 120, empty state is safe, staged actors stay at departure radius, gathering actors do not move, marching actors move linearly, landing actors reach the castle, and render keys change only for canonical tactical changes.
- [ ] **Step 3: Write failing layout tests.** Assert ordinary Rally contains no full roster or online count; both kingdoms are visible; Double shows up to four and Triple up to six full captain rows; every row retains role/name/progress/exact time; five/six rows use compact spacing without shrinking decision text below 11px or requiring horizontal scroll.
- [ ] **Step 4: Run the new tests and confirm current bucket/gather behavior fails.** Run `node --test test/rally-tactical.test.cjs test/rally-player-layout.test.cjs`; expect current 30-second bucket and gathering-motion assertions to fail.
- [ ] **Step 5: Implement the pure tactical projector.** Keep all calculations independent from DOM and requestAnimationFrame. Use the same immutable active command snapshot for names, march times, roles, press times, and kingdom; use canonical staged records while idle.
- [ ] **Step 6: Rebuild the ordinary Rally reading order.** Render compact readiness/clock, collapsed `You · Name · march · Edit`, two selected-captain groups, all precise bars, the larger meaningful castle field, then the collapsed Commander Console entry. Move full roster and room-wide counts into Manage only. Preserve current approximate font sizes and the two-minute upper scale.
- [ ] **Step 7: Adapt the castle field.** Use the full existing frame, distribute up to six actors by kingdom/role angle so equal distances remain distinguishable, show the current scale in readable text, and keep paths/markers clock-derived. Do not enlarge the castle into the main content or add decorative looping motion.
- [ ] **Step 8: Keep personal and commander semantics exact.** Only a selected captain gets a large personal countdown/audio. An ordinary unselected member keeps the existing generic JOIN policy. An unselected commander sees every selected captain in a silent launch monitor, not only the first departure; a commander who is a selected captain receives only that captain's personal audio.
- [ ] **Step 9: Prove Cancel and profile changes are stable.** Cancel stops future cues and active visuals but preserves staged teams. Identity/nickname/march edits repaint idle canonical rows; an active command remains frozen and cannot rename or retime mid-flight.
- [ ] **Step 10: Run `node --test test/rally-tactical.test.cjs test/rally-player-layout.test.cjs test/map-render-key.test.cjs test/commander-launch-monitor.test.cjs test/cancel-rally-selection.test.cjs`, then `node test/rally-tactical.e2e.cjs` and `node test/commander-launch-monitor.e2e.cjs`.** Expect all pass at 320/375/390/430 widths.
- [ ] **Step 11: Run `npm test && npm run test:delivery && npm run test:triple && npm run test:kvk-core:all`, then GitNexus change detection and commit.** Commit with `feat: modernize rally tactical view`.

---

### Task 13: Make `/rally` and `/defense` canonical, preserve legacy links, and split build gates

**Files:**
- Create: `public/rally.html`
- Create: `public/rally-update.js`
- Create: `public/defense-update.js`
- Create: `test/coordination-routing.test.cjs`
- Create: `test/rally-update.test.cjs`
- Create: `test/rally-update-wiring.test.cjs`
- Create: `test/defense-update.test.cjs`
- Modify: `src/worker.js`
- Modify: `src/client-build.js`
- Modify: `wrangler.toml`
- Modify: `wrangler.qa.toml`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `package.json`
- Modify: `test/client-build.test.cjs`
- Modify: `test/worker-build.test.cjs`
- Modify: `test/worker-security.test.cjs`
- Modify: `test/qa-worker-config.test.cjs`

**Build metadata for this release:**

```js
{
  currentBuild: 2026071603,
  minKvkBuild: 2026071603,     // one migration cycle for already-open legacy pages
  minRallyBuild: 2026071603,
  minDefenseBuild: 2026071603,
  minTripleBuild: 2026071603,
  tripleEnabled: true,
  tripleQaEnabled: true
}
```

**Legacy redirect:**

```text
/kvk?room=qa&lang=en&notour=1&__kvk_build=2026071603&junk=x
  -> 302 /rally?room=qa&lang=en&notour=1&__rally_build=2026071603
Cache-Control: no-store
```

**Package scripts:**

```json
{
  "test:rally-core": "node test/rally-core-multibrowser.e2e.cjs --project=chromium",
  "test:rally-core:all": "node test/rally-core-multibrowser.e2e.cjs --project=all",
  "test:kvk-core": "npm run test:rally-core",
  "test:kvk-core:all": "npm run test:rally-core:all",
  "test:rally-defense": "node --test test/rally-*.test.cjs test/defense-*.test.cjs test/coordination-*.test.cjs",
  "test:load:defense": "node test/defense-load.e2e.mjs",
  "test:qa:rally-defense": "playwright test -c playwright.qa-rally-defense.config.cjs"
}
```

- [ ] **Step 1: Run GitNexus API impact for `src/worker.js` and symbol impact for `buildMetadata`, `projectRoomForClient`, and the existing update controller.**
- [ ] **Step 2: Write failing route tests.** Cover GET/HEAD `/rally` and `/defense`; GET `/kvk` and `/kvk.html`; whitelist `room`, `lang`, and `notour`; map `__kvk_build`; drop unknown/duplicate unsafe parameters; preserve no hash; send no-store 302; and return 405 for unsupported methods.
- [ ] **Step 3: Write failing build tests.** Cover independent Rally/Defense floors, delayed refresh while a personal future cue exists, immediate refresh when idle, correct query key, bad metadata, timeout, and old `minKvkBuild` compatibility.
- [ ] **Step 4: Implement deterministic worker routing.** Internally serve `rally.html` and `defense.html`; add `run_worker_first = ["/kvk", "/kvk.html"]` to both Wrangler asset configs so the existing legacy file cannot bypass the Worker redirect.
- [ ] **Step 5: Add the two homepage cards.** Reuse the current card typography and room-entry conventions. Generated/direct links use `/rally?room=...` and `/defense?room=...`; no new left/right desktop-first layout.
- [ ] **Step 6: Implement one generic update-controller implementation with two thin surface wrappers.** Rally uses `__rally_build`/`minRallyBuild`; Defense uses `__defense_build`/`minDefenseBuild`; both delay refresh while a personal cue is future.
- [ ] **Step 7: Advance every first-party coordination asset query and test expectation to `2026071603` together.** Do not mix build numbers in HTML, UMD constants, or `/api/build`.
- [ ] **Step 8: Add scripts.** Set `test:rally-defense`, `test:load:defense`, and `test:qa:rally-defense`; add `test:rally-core` and `test:rally-core:all`; keep `test:kvk-core` and `test:kvk-core:all` as unconditional one-release aliases that invoke their Rally-named replacements.
- [ ] **Step 9: Run `node --test test/coordination-routing.test.cjs test/rally-update.test.cjs test/defense-update.test.cjs test/client-build.test.cjs test/worker-build.test.cjs test/worker-security.test.cjs test/qa-worker-config.test.cjs`; expect all pass.**
- [ ] **Step 10: Run `npm test && npm run test:delivery && npm run test:triple`; then run GitNexus change detection and commit.** Commit with `feat: make rally and defense canonical surfaces`.

---

### Task 14: Remove the static Defense implementation from Rally and finish Rally naming

**Files:**
- Create: `public/rally-controller.js`
- Create: `public/rally-domain.js`
- Create: `public/rally-delivery-shadow.js`
- Create: `test/rally-core-multibrowser.e2e.cjs`
- Create: `test/coordination-home-layout.test.cjs`
- Create: `test/rally-client.test.cjs`
- Create: `test/rally-wiring.test.cjs`
- Create: `test/rally-triple-selection-ui.test.cjs`
- Create: `test/qa-rally-delivery-guard.test.cjs`
- Create: `test/qa-rally-delivery.spec.cjs`
- Create: `test/qa-rally-triple.spec.cjs`
- Create: `test/qa-coordination.test.cjs`
- Create: `playwright.qa-rally-defense.config.cjs`
- Modify: `public/rally.html`
- Modify: `public/app.css`
- Modify: `public/app.js`
- Modify: `src/room.js`
- Modify: `test/legacy-kvk-script-guard.test.cjs`
- Modify: `test/alert-truth.cjs`
- Modify: `test/bg.cjs`
- Modify: `test/classic-delivery.e2e.cjs`
- Modify: `test/commander-launch-monitor.e2e.cjs`
- Modify: `test/defense.cjs`
- Modify: `test/delivery-browser-wiring.test.cjs`
- Modify: `test/delivery-domain.test.cjs`
- Modify: `test/delivery-model.test.cjs`
- Modify: `test/delivery-shadow-client.test.cjs`
- Modify: `test/fixes.cjs`
- Modify: `test/identity-input.e2e.cjs`
- Modify: `test/lead-timing.cjs`
- Modify: `test/march-domain.e2e.cjs`
- Modify: `test/march-sync.e2e.cjs`
- Modify: `test/mineaudio.cjs`
- Modify: `test/multikingdom.cjs`
- Modify: `test/player-reconnect.e2e.cjs`
- Modify: `test/player-registration-multidevice.e2e.cjs`
- Modify: `test/player-registration-recovery.e2e.cjs`
- Modify: `test/player-removal-multimanager.e2e.cjs`
- Modify: `test/player-removal-own-device.e2e.cjs`
- Modify: `test/player-removal.e2e.cjs`
- Modify: `test/player-protocol-client.test.cjs`
- Modify: `test/rally-mode.test.cjs`
- Modify: `test/reliable-room-delivery.test.cjs`
- Modify: `test/room-harness.cjs`
- Modify: `test/room-socket.test.cjs`
- Modify: `test/roster-control.e2e.cjs`
- Modify: `test/stage-convergence.e2e.cjs`
- Modify: `test/triple-room.test.cjs`
- Modify: `test/worker-build.test.cjs`
- Delete: `public/kvk.html`
- Delete: `public/kvk.js`
- Delete: `public/kvk-rally.js`
- Delete: `public/kvk-delivery-shadow.js`
- Delete: `public/kvk-update.js`
- Delete: `test/kvk-core-multibrowser.e2e.cjs`
- Delete: `test/kvk-home-layout.test.cjs`
- Delete: `test/kvk-rally-client.test.cjs`
- Delete: `test/kvk-rally-wiring.test.cjs`
- Delete: `test/kvk-triple-selection-ui.test.cjs`
- Delete: `test/kvk-update-wiring.test.cjs`
- Delete: `test/kvk-update.test.cjs`
- Delete: `test/qa-kvk-delivery-guard.test.cjs`
- Delete: `test/qa-kvk-delivery.spec.cjs`
- Delete: `test/qa-kvk-triple.spec.cjs`
- Delete: `test/qa-kvk.test.cjs`
- Delete: `test/support/qa-kvk.cjs`
- Delete: `playwright.qa-kvk.config.cjs`
- Delete: `playwright.qa-kvk-triple.config.cjs`

**Static Defense deletion boundary:**

```text
delete Attack / Defense view switch
delete #defenseView, demo radar, scrubber, whale chips, defense strips
delete #cdefense, enemy-whale editor, publish button
delete client defense state, dCalc/dBuildBase/dRebuild/dFrame/renderDefense/setView
delete sendWhales/publishWhales and enemyWhales translations/styles
remove room.config.enemyWhales from the canonical Rally schema
ignore legacy stored enemyWhales during migration; do not expose it to clients
```

- [ ] **Step 1: Run GitNexus impact for `renderDefense`, `setView`, `dCalc`, `dBuildBase`, `dRebuild`, `dFrame`, `sendWhales`, `publishWhales`, `sanitizeConfig`, and every call site to be removed.** Warn because `renderDefense` is CRITICAL and `setView` is HIGH.
- [ ] **Step 2: Write failing absence tests before deletion.** Assert canonical Rally HTML has no Defense toggle, static Defense DOM, enemy-whale manager UI, Defense translation keys, Defense event handlers, or `enemyWhales` public config; assert `/defense` still contains the new voice workflow.
- [ ] **Step 3: Move active Rally assets to Rally names using add/delete patches.** Change UMD globals from `KvkRally/KvkUpdate` to `RallyDomain/RallyUpdate`, script URLs, CSS body hooks, storage labels where migration-safe, diagnostics, and visible coordination copy. Preserve legacy Rally profile/device keys through the shared identity adapter.
- [ ] **Step 4: Remove static Defense call sites first, running focused Rally tests after each group.** Only then delete the now-unreachable functions, DOM, translations, and CSS.
- [ ] **Step 5: Remove `enemyWhales` from new Rally config writes/projections.** During this release tolerate the stored key on read so a rollback remains possible; never serialize it to canonical clients.
- [ ] **Step 6: Recreate the listed active tests under Rally/coordination names, update every listed helper import and package script, and delete their old files.** `test/rally-update.test.cjs` and `test/rally-update-wiring.test.cjs` already come from Task 13, so delete the two old update tests without creating duplicates. Make `test/support/qa-coordination.cjs` accept only fixed room `qa`; update all local suites to isolate state through a temporary Wrangler persistence directory and all remote suites to serialize/clean their own stable `qa-test-*` profiles. Fold both old QA Playwright configurations into the new `playwright.qa-rally-defense.config.cjs`. Keep `legacy-kvk-script-guard.test.cjs`, `test/support/legacy-kvk-script-guard.cjs`, and `test/fixtures/kvk-legacy-target.cjs` as intentional legacy-route coverage. The game term KvK may remain in gameplay guide content; generated URLs and product assets may not use `/kvk`.
- [ ] **Step 7: Add a source guard.** Fail if public Rally HTML/JS/CSS contains the deleted Defense IDs/functions, if homepage/generated links point to `/kvk`, or if an executable test helper creates/opens a generated `qa-kvk-*` room. Whitelist only Worker redirects, migration build fields, legacy localStorage reads, legacy-route tests, and negative guard fixtures that prove non-`qa` rooms are refused.
- [ ] **Step 8: Run the focused absence/naming tests and `npm test && npm run test:delivery && npm run test:triple && npm run test:rally-core:all`; expect all pass.**
- [ ] **Step 9: Run GitNexus change detection and commit.** Commit with `refactor: remove static defense from rally`.

---

### Task 15: Unify Home, Codes, and Guide with the battle interaction system

**Files:**
- Create: `test/supporting-pages-ui.test.cjs`
- Create: `test/supporting-pages-ui.e2e.cjs`
- Modify: `public/index.html`
- Modify: `public/codes.html`
- Modify: `public/guide.html`
- Modify: `public/app.css`
- Modify: `public/app.js`
- Modify: `test/codes-toggle.cjs`
- Modify: `test/guide-toggle.cjs`
- Modify: `test/coordination-home-layout.test.cjs`

**Interfaces:**
- Consumes: semantic colors, control sizes, focus behavior, material limits, and reduced-motion rules from `battle-ui.css`; canonical `/rally` and `/defense` routes from Task 13.
- Produces: a consistent mobile entry flow and accessible supporting pages without importing room sockets, battle state, or manager logic.

- [ ] **Step 1: Run GitNexus impact for shared `setLang`, `applyI18n`, `renderLangToggle`, `ksActor`, `ksCastle`, the home room-entry handler, Codes copy/filter handlers, and Guide animation initializer.** Record blast radius before editing shared `app.js` symbols.
- [ ] **Step 2: Write failing local UI contract tests.** Assert Home has equal Rally and Defense room cards above secondary content, no `LIVE` wording that implies game telemetry, no KvK product route, 44px language/enter/copy/tab controls, accessible headings and `<main>`, visible focus, text+icon status, and no critical 8--10px copy.
- [ ] **Step 3: Write failing reduced-motion/transparency tests.** Emulate both media queries. Assert fish/guide decorative loops are stopped in a stable final pose, no GSAP infinite timeline remains active, content remains readable with solid surfaces, and no information disappears when animation is disabled.
- [ ] **Step 4: Run `node --test test/supporting-pages-ui.test.cjs`; expect current route/control/animation assertions to fail.**
- [ ] **Step 5: Reorder Home without changing its brand.** Keep the fish, rounded type, and warm palette, shorten decorative hero height on mobile, place Rally and Defense as equal cards using one room input convention, and move full navigation below the primary coordination choice.
- [ ] **Step 6: Upgrade Codes.** Give copy/filter/retry controls 44px hit regions, add `aria-live` for loading/empty/error/copy state, keep destructive/error information textual, and avoid relying on toast or color alone.
- [ ] **Step 7: Upgrade Guide.** Point actions to Rally/Defense, reuse shared actor/castle artwork, mark decoration `aria-hidden`, keep explanatory text outside SVG, and stop rather than merely hide GSAP/rAF loops under reduced motion.
- [ ] **Step 8: Run `node test/supporting-pages-ui.e2e.cjs` at 320/375/390/430 and desktop widths.** Assert no horizontal overflow, 200% text usability, keyboard order, focus visibility, long English/Chinese labels, reduced motion, reduced transparency, and high-contrast mode.
- [ ] **Step 9: Run `node --test test/supporting-pages-ui.test.cjs test/codes-toggle.cjs test/guide-toggle.cjs test/coordination-home-layout.test.cjs && npm test`; then GitNexus change detection and commit.** Commit with `feat: unify coordination supporting pages`.

---

### Task 16: Prove isolation, concurrency, reconnect behavior, accessibility, and 100-client scale

**Files:**
- Create: `test/rally-defense-isolation.e2e.cjs`
- Create: `test/defense-multibrowser.e2e.cjs`
- Create: `test/defense-load.e2e.mjs`
- Create: `test/coordination-accessibility.e2e.cjs`
- Create: `test/qa-rally-defense.spec.cjs`
- Modify: `playwright.qa-rally-defense.config.cjs`
- Modify: `test/support/qa-coordination.cjs`
- Modify: `test/room-write-budget.test.cjs`
- Modify: `package.json`

**Load shape:**

```text
room: qa (isolated local Wrangler persistence)
100 Defense defender sockets
2 Defense manager sockets
2 Rally sockets in the same room name
20 defender disconnect/reconnect cycles
2 concurrent fire mutations
1 accepted order revision
0 per-second server broadcasts
0 cross-surface frames
0 duplicate scheduled cue or Now per profile/device/revision
```

- [ ] **Step 1: Write the isolation browser test.** Register different profiles on Rally and Defense using the same room name/password; fire a Rally and assert Defense has no visual/audio/state change; fire Defense and assert Rally has no visual/audio/state change; inspect socket URLs and frames for the correct surface.
- [ ] **Step 2: Write the multibrowser Defense test.** Cover ordinary waiting, manager-only silence, manager+defender personal cue, new player waiting next round, captured reconnect restoring only future cues, cancellation stopping outstanding cues, config persistence, repeated round auto-readiness, and exact delivery wording.
- [ ] **Step 3: Write the 100-client load test against a fresh local Wrangler instance whose only room name is `qa`.** Use a unique temporary `--persist-to` directory, serialize the suite, and remove the temporary directory after process exit. Never point this load test at production or the remote QA Worker.
- [ ] **Step 4: Instrument bounded-message assertions.** Count server frames and payload bytes from acceptance through completion; fail on a per-second broadcast pattern, a Rally field in Defense state, a Defense field in Rally state, an audience overcount from multi-device profiles, or unbounded full-roster ACK broadcasts. Enforce: ordinary initial state at most 8 KiB, personal accepted-order frame at most 4 KiB, individual presence/ACK delta at most 2 KiB, and a 150-profile manager snapshot at most 96 KiB.
- [ ] **Step 5: Add the QA Playwright config.** Allow only loopback by default. Remote execution requires the exact QA Worker origin plus `ALLOW_REMOTE_QA=1`; it always uses room/password `qa`, one worker, no parallelism, and never accepts `kingshoter.com` as a test origin.
- [ ] **Step 6: Run `npm run test:rally-defense`; expect all unit/integration tests pass.**
- [ ] **Step 7: Run `npm run test:load:defense`; expect one accepted order, 100 targeted profiles, ACK convergence, successful 20-profile reconnect, bounded frames, and no duplicates.**
- [ ] **Step 8: Run the steady-state storage budget inside the load test.** After all sockets are initialized, hold the 104 sockets across repeated heartbeats/readiness repaints and assert zero canonical `put` rows, zero idle `setAlarm` calls, and zero periodic full-state frames. Report website messages and storage rows only; do not invent a real-game participation count.
- [ ] **Step 9: Add and run the accessibility/mobile matrix.** At 320/375/390/430px and 200% text, assert no horizontal page overflow, 44px hit targets, 16px text inputs, non-color-only state, non-duplicating live regions, focus restore across drawer detents, virtual-list focus retention, reduced motion/transparency, and manager-only silence. Run it in Chromium, Firefox, and WebKit.
- [ ] **Step 10: Run local `npm run test:qa:rally-defense`; expect Chromium, Firefox, and WebKit to pass at 320/375/390/430 widths.**
- [ ] **Step 11: Run `npm test && npm run test:delivery && npm run test:triple && npm run test:rally-core:all`; then run GitNexus change detection and commit.** Commit with `test: prove rally defense isolation ui and scale`.

---

### Task 17: Deploy to the isolated QA Worker and perform the device/audio gate

**Files:**
- Create: `docs/superpowers/qa/2026-07-16-rally-defense-device-matrix.md`
- Modify: none in the planned happy path

**QA URLs:**

Use the exact HTTPS origin printed by the successful QA deploy in Step 3. Append `/rally?room=qa&lang=en` for Rally and `/defense?room=qa&lang=en` for Defense; the room password is `qa`. Copy that exact origin into the device-matrix document before running remote tests.

- [ ] **Step 1: Run the complete local release gate from a clean tree.** Run `npm ci`, `npm test`, `npm run test:delivery`, `npm run test:triple`, `npm run test:rally-core:all`, `npm run test:rally-defense`, `npm run test:load:defense`, and `npm run test:qa:rally-defense`; record exit codes and test counts.
- [ ] **Step 2: Build the QA artifact without publishing.** Run `npx wrangler deploy -c wrangler.qa.toml --dry-run`; inspect that `/rally`, `/defense`, shared modules, SFX, Worker routes, and no Admin files are present.
- [ ] **Step 3: Deploy the exact tested commit to QA.** Run `npx wrangler deploy -c wrangler.qa.toml --tag git-$(git rev-parse --short=12 HEAD) --message "Rally Defense QA"`; record the version ID.
- [ ] **Step 4: Run the remote serialized QA suite only in fixed room `qa`.** Set the exact QA origin and `ALLOW_REMOTE_QA=1`; run `npm run test:qa:rally-defense`. Clear/cancel any QA Defense order at the end while preserving the room password `qa`.
- [ ] **Step 5: Verify Rally on multiple real browser engines.** Test Double and Triple, selected captain personal audio, unselected commander silence, cancel preserving team, lead-time accuracy, reconnect, clock correction, and no old Defense UI.
- [ ] **Step 6: Verify Defense audio on iOS Safari and Android Chrome.** On each device: register, enable/test alerts, switch to the game/background, fire a QA order whose GO is safely future, observe T-15/T-10/5..1/Now, cancel, reconnect, repeat a round, and verify green/red truth matches measurable audio/connection/clock state.
- [ ] **Step 7: Verify desktop behavior on macOS and Windows browsers.** Repeat foreground/background, reconnect, clock correction, cancel, and manager-only silence. Do not mark an unavailable device as passed; record it as unverified and do not claim guaranteed delivery for that platform.
- [ ] **Step 8: Record website-only truth.** For each run capture Targeted, Delivered/scheduled, Audio-ready, Red/unconfirmed, Offline, and Too late values; explicitly note that game response and arrival were not observed by the website.
- [ ] **Step 9: If any defect is found, use systematic debugging, add a reproducing test to the owning task, patch only that layer, rerun its focused gate and the complete release gate, then redeploy a new QA version.** Do not bypass a failed audio or Rally regression.
- [ ] **Step 10: Run GitNexus change detection for any QA-driven fix and commit it separately.** Commit message starts with `fix:` and names the verified defect.

---

### Task 18: Promote the tested commit atomically and preserve rollback

**Files:**
- Create: `docs/superpowers/qa/2026-07-16-rally-defense-release.md`
- Modify: none unless a smoke check exposes a reproducible defect

- [ ] **Step 1: Confirm the production candidate equals the QA-tested commit.** Record `git rev-parse HEAD`, QA version ID, full gate results, and device-matrix results. Require a clean tracked tree; ignore only the known unrelated untracked workspace metadata.
- [ ] **Step 2: Run GitNexus final change detection against the pre-change tag.** Use compare scope from `rally-defense-prechange-20260716`; confirm affected flows are limited to the documented connection/audio/profile refactors, Rally naming/removal, Defense protocol/UI, routing, build gates, and tests.
- [ ] **Step 3: Run a production dry run.** Run `npx wrangler deploy -c wrangler.toml --dry-run`; compare bindings and migrations with QA. There must be no new Durable Object class, KV namespace, Admin route, gameauto integration, or password-changing endpoint.
- [ ] **Step 4: Record the current production version ID immediately before promotion.** Save it as `PREVIOUS_VERSION_ID` in the release document; never commit shell environment or secrets.
- [ ] **Step 5: Deploy the exact tested commit once.** Run `npx wrangler deploy -c wrangler.toml --tag git-$(git rev-parse --short=12 HEAD) --message "Rally Defense production"`.
- [ ] **Step 6: Run read-only production smoke checks.** Verify `/api/build`, `/rally`, `/defense`, `/kvk` redirect parameter mapping, static assets, and homepage links. Do not enter or mutate any production room and do not send a Rally or Defense command.
- [ ] **Step 7: Roll back immediately on a critical Rally timing/audio/routing/delivery regression.** Run `npx wrangler rollback "$PREVIOUS_VERSION_ID" --name kingshoter --message "Rollback Rally Defense"`, verify the previous `/api/build` and legacy surface, and open a systematic-debugging task from the failed test. Do not patch production interactively.
- [ ] **Step 8: Commit the release evidence.** Run GitNexus change detection, then commit with `docs: record rally defense release verification`.

---

## Final Acceptance Gate

- [ ] `/rally` is canonical; `/kvk` and `/kvk.html` silently redirect with only approved parameters preserved.
- [ ] Rally has no static Defense UI, enemy-whale editor, Defense event hooks, or public `enemyWhales` config.
- [ ] `/defense` has an isolated roster, presence, config, active order, cancellation revision, device state, and ACK state.
- [ ] Same room name/password works on both surfaces without sharing operational data.
- [ ] Ordinary defenders confirm identity/march once, explicitly enable audio, and automatically wait every round.
- [ ] Manager anchor defaults to 3:00, enemy march is required, timing uses the approved exact equation, and only one order can be active.
- [ ] Captured audience/march values are immutable; new or offline players wait for the next round; captured reconnects restore only future cues.
- [ ] Defense reuses the current preparation/beep/5..1/Now media and scheduler; manager-only devices are silent.
- [ ] One canonical readiness projection drives the visible strip, network status, and ACK; green requires audio, carrier, socket, and fresh clock and never claims game action.
- [ ] Rally preserves both kingdoms, at most six selected captain rows, every precise progress bar, fixed 120-second upper bars, and a full-field castle projection based on actual maximum march plus 8% headroom.
- [ ] Gathering markers remain at their departure radius; only the march phase moves them toward the castle from absolute synchronized time.
- [ ] Rally and Defense manager consoles use the shared `closed`/`command`/`manage` drawer, 1:1 interruptible gestures, visible button/keyboard alternatives, and collapse without password re-entry.
- [ ] At 320/375/390/430px there is no horizontal page overflow; text inputs are at least 16px, hit regions at least 44px, critical text at least 11px, and reduced motion/transparency leave all information usable.
- [ ] One hundred idle sockets and repeated carrier/readiness transitions produce zero periodic canonical Durable Object rows, zero idle alarm writes, and zero full-state heartbeat broadcasts.
- [ ] Manager Status and Players remain usable with at least 100 connected devices; ordinary-player rendering stays constant-size.
- [ ] All manager metrics use website-verifiable wording and make no claim about actual game response.
- [ ] Fixed QA room/password are `qa`; no production operation room was used for testing.
- [ ] No Admin page or Admin protocol was built.
- [ ] Full unit, integration, Playwright, load, Rally regression, QA, and documented device gates pass before production promotion.
