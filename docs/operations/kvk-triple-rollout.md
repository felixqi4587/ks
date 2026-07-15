# KvK Triple Rally Rollout Record

## Current decision

**HOLD — global Triple remains disabled.** All local automated gates recorded below pass, but local browser runs validate browser logic only; they do not prove that a physical phone or computer will deliver audio while backgrounded, locked, interrupted, or reconnecting.

## Immutable safety rules

- Automated KvK tests create a new generated `qa-kvk-*` room for each run.
- Automation must never connect to room `1406` or any other non-QA room. Every non-QA room is an operation room and receives no test-only exception.
- Double Rally remains available and is the default for every kingdom.
- `TRIPLE_RALLY_ENABLED="0"` remains the global setting until every enablement gate in this record passes.
- `TRIPLE_RALLY_QA_ENABLED="1"` is permitted only because the server validates the generated `qa-kvk-*` room prefix.
- No deployment or push is permitted in this implementation session. A dry run is allowed because it does not publish code.
- Rollback blocks new Triple commands and normalizes future mode/staging state; it must not interrupt or rewrite an already-active Triple command.
- Test output is recorded only after it is observed. Missing devices or unavailable evidence remain `Not run`/`Pending`, never inferred as passing.

## Release candidate

| Item | Proposed value | Verification |
|---|---:|---|
| KvK build generation | `2026071401` | **PASS locally** — atomic metadata/module/asset wiring and `1303 → 1401` refresh regression |
| Global Triple gate | `0` | Must remain off |
| QA-only Triple gate | `1` | Required for generated QA rooms only |
| Default rally mode | Double | Must remain unchanged |

`2026071401` is verified as one atomic local cache/build generation: the same value appears in server build metadata, updater/rally scripts, all first-party KvK asset URLs, and their tests. The updater regression proves that the immediately previous `2026071303` page requests a refresh to this release; existing tests also prove that a valid refresh waits until an active personal countdown finishes. This is local evidence, not evidence that the build has been deployed.

## Local automated evidence

Run all commands from `kingshoter/`. Every QA runner must retain its generated-room guard.

| Gate | Exact command | Status | Observed evidence (UTC, counts/details) |
|---|---|---|---|
| Full unit/regression suite | `npm test` | PASS | `2026-07-15T03:16:57Z`; 268/268, exit 0 |
| Focused Triple suite | `npm run test:triple` | PASS | `2026-07-15T03:17:00Z`; 80/80, exit 0 |
| Reliable-delivery browser QA | `npm run test:qa:delivery` | PASS | `2026-07-15T03:16:59Z` recorded; Chromium/Firefox/WebKit 9/9, exit 0; generated `qa-kvk-*` only |
| Triple browser QA | `npm run test:qa:triple` | PASS | `2026-07-15T03:16:59Z` recorded; Chromium/Firefox/WebKit 9/9, exit 0; generated `qa-kvk-*` only |
| Double lead 10 | `node test/lead-timing.cjs http://127.0.0.1:8791 10` | PASS | `2026-07-15T03:16:59Z` recorded; 17/17, exit 0 |
| Double lead 15 | `node test/lead-timing.cjs http://127.0.0.1:8791 15` | PASS | `2026-07-15T03:16:59Z` recorded; 16/16, exit 0 |
| Double lead 30 | `node test/lead-timing.cjs http://127.0.0.1:8791 30` | PASS | `2026-07-15T03:16:59Z` recorded; 17/17, exit 0 |
| Double lead 60 | `node test/lead-timing.cjs http://127.0.0.1:8791 60` | PASS | `2026-07-15T03:16:59Z` recorded; 17/17, exit 0 |
| Worker syntax | `node --check src/worker.js && node --check src/room.js` | PASS | `2026-07-15T03:16:59Z` recorded; 2/2, exit 0 |
| Browser-source syntax | `node --check public/app.js && node --check public/kvk.js && node --check public/kvk-rally.js && node --check public/kvk-update.js` | PASS | `2026-07-15T03:16:59Z` recorded; 4/4, exit 0 |
| Rollback semantics | `node --test --test-name-pattern="rollback normalizes future mode" test/triple-room.test.cjs` | PASS | `2026-07-15T03:17:00Z` recorded; 1/1, exit 0 |
| Non-publishing Worker build | `npx wrangler deploy --dry-run` | PASS | `2026-07-15T03:16:59Z` recorded; 27 assets, 118.91 KiB / gzip 25.42 KiB, exit 0; global `0`, QA `1` |

The Double lead matrix requires a separate local Worker. Start it in another terminal with an isolated temporary state directory:

```bash
cd kingshoter
QA_STATE="$(mktemp -d)"
npx wrangler dev --local --ip 127.0.0.1 --port 8791 \
  --persist-to "$QA_STATE" \
  --var TRIPLE_RALLY_ENABLED:0 \
  --var TRIPLE_RALLY_QA_ENABLED:1 \
  --log-level warn
```

Then run the four lead values:

```bash
cd kingshoter
for lead in 10 15 30 60; do
  node test/lead-timing.cjs http://127.0.0.1:8791 "$lead"
done
```

These local tests may prove target calculations, personal countdown scheduling, silence for an unselected commander, browser compatibility, responsive layout, state synchronization, and UI delivery acknowledgements. They cannot prove operating-system background survival or physical audio delivery.

## Deferred deployed evidence

Deployment and production-connected QA are outside this implementation session. Leave these rows unchanged until an explicitly authorized release session observes them.

| Gate | Requirement | Status | Observed evidence (UTC, counts/details) |
|---|---|---|---|
| Updater bootstrap deployment | Global `0`, QA `1`; record immutable deployment identifier | Not run | — |
| Build endpoint | HTTP 200, `Cache-Control: no-store, max-age=0`, candidate build, global `false`, QA `true` | Not run | — |
| Deployed browser QA | Generated `qa-kvk-*` only; `EXPECT_TRIPLE_GLOBAL=0` | Not run | — |
| Battle-window build inventory | Aggregate build `0`, below-minimum, and Triple-capable socket counts; no user or room identifiers | Not run | — |
| Separate minimum-build deployment | Global stays `0`; updater-capable stale clients refresh after any active cue | Not run | — |
| Final global enablement deployment | Separate deployment only after every gate passes | Not run | — |

The authorized deployed-QA command is:

```bash
cd kingshoter
QA_BASE_URL=https://kingshoter.com \
ALLOW_PRODUCTION_QA=1 \
EXPECT_TRIPLE_GLOBAL=0 \
npm run test:qa:triple
```

The spec must generate its own room and reject every WebSocket target outside that exact `qa-kvk-*` room. This command is documented for a later authorized release session and must not be run in the current session.

## Physical-device delivery evidence

| Platform | Foreground | Switch to Kingshot | Background | Lock screen | Reconnect | Audio interruption | Correct `Received` UI | Result |
|---|---|---|---|---|---|---|---|---|
| iOS | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Pending |
| Android | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Pending |
| macOS | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Pending |
| Windows | Not run | Not run | Not run | Not run | Not run | Not run | Not run | Pending |

For each physical run, append:

- UTC timestamp, platform, device model, browser, and browser version;
- generated QA room name, selected lead, and all three canonical march values;
- each captain's observed personal countdown start and GO time;
- whether the commander was selected as a captain and whether an unselected commander stayed silent;
- ordinary member's single JOIN cue;
- the exact slot `Received` state; and
- any missed, duplicate, late, or stale cue, reconnect, audio interruption, or status-light mismatch.

A green/`Received` status is accepted only when it represents the same command and scheduled personal cue observed by that device. Browser automation can verify this protocol contract, but only a physical run can establish delivery under the device operating system's lifecycle restrictions.

## Enablement decision gate

The global gate may change from `0` to `1` only when all of the following are true:

1. Every local automated row is `PASS`, including unchanged Double leads 10/15/30/60. **Satisfied locally.**
2. The candidate build is verified atomically and stale-client refresh behavior passes without interrupting an active cue.
3. The updater bootstrap and generated-room deployed QA rows are `PASS` while global Triple is still off.
4. Every physical platform row is `PASS`; no selected captain misses or duplicates a cue, and every unselected commander remains silent.
5. At least one complete real battle-window inventory contains no build-0 or below-minimum operation-room sockets. If inventory is unavailable, the gate remains off.
6. Global enablement is a separate deployment from the minimum-build raise and applies to all operation rooms together; it is never tested as a named-room canary.

Current decision: **HOLD**. Local rows pass, but deployed and physical-device rows remain unrecorded, so `TRIPLE_RALLY_ENABLED` must remain `0`.

## Rollback procedure

Rollback is global and configuration-driven; it never automates or opens an operation room.

1. Set the single `[vars]` section to:

   ```toml
   TRIPLE_RALLY_ENABLED = "0"
   TRIPLE_RALLY_QA_ENABLED = "1"
   ```

2. Before any authorized production rollback, run locally:

   ```bash
   cd kingshoter
   node --test --test-name-pattern="rollback normalizes future mode" test/triple-room.test.cjs
   npx wrangler deploy --dry-run
   ```

3. Confirm the focused regression proves that future mode/staging state returns to Double while an active Triple command remains byte-for-byte unchanged until completion or cancellation.
4. In a separately authorized release session, deploy with `npx wrangler deploy`. Do not deploy during the current implementation session.
5. Verify `/api/build` reports `tripleEnabled:false` and `tripleQaEnabled:true`, then run generated-room QA only. Do not connect automation to room `1406` or any other non-QA room.
6. Keep the per-socket legacy projection bridge in place. Re-enable global Triple only after every decision gate is still recorded as passing.

## Evidence log

Append observations; never overwrite a failure or convert an unavailable test into a pass.

| UTC timestamp | Scope | Generated QA room / build | Result | Evidence or failure |
|---|---|---|---|---|
| `2026-07-15T03:17:00Z` | Local release gate | Build `2026071401`; generated `qa-kvk-*` rooms only | PASS locally / HOLD globally | Unit 268/268; focused 80/80; browser QA 9/9 + 9/9; Double leads 17/17, 16/16, 17/17, 17/17; syntax, rollback, and dry-run pass. No deployment or physical-device evidence. |
