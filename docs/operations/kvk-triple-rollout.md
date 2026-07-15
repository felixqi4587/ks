# KvK Triple Rally Rollout Record

## Current decision

**HOLD — global Triple remains disabled.** All local automated gates recorded below pass, but local browser runs validate browser logic only; they do not prove that a physical phone or computer will deliver audio while backgrounded, locked, interrupted, or reconnecting.

## Immutable safety rules

- Automated KvK tests create a new generated `qa-kvk-*` room for each run.
- Automation must never connect to room `1406` or any other non-QA room. Every non-QA room is an operation room and receives no test-only exception.
- All 43 retained unsafe legacy KvK network scripts stop before browser or WebSocket launch and direct operators to the generated-room QA commands. The five retained manual QA runners accept only a clean loopback origin, generate a new `qa-kvk-*` room, and enforce that exact WebSocket origin.
- Double Rally remains available and is the default for every kingdom.
- `TRIPLE_RALLY_ENABLED="0"` remains the global setting until every enablement gate in this record passes.
- `TRIPLE_RALLY_QA_ENABLED="1"` is permitted only because the server validates the generated `qa-kvk-*` room prefix.
- This candidate is Phase A (updater bootstrap) only. It must not be described or deployed as the later minimum-build raise.
- No deployment or push is permitted in this implementation session. A dry run is allowed because it does not publish code.
- Rollback blocks new Triple commands and normalizes future mode/staging state; it must not interrupt or rewrite an already-active Triple command.
- Test output is recorded only after it is observed. Missing devices or unavailable evidence remain `Not run`/`Pending`, never inferred as passing.

## Release candidate

| Item | Proposed value | Verification |
|---|---:|---|
| Current KvK build | `2026071401` | **PASS locally** — atomic metadata/module/asset wiring |
| Phase A minimum KvK build | `2026071301` | **PASS locally** — retains the pre-bootstrap minimum |
| Minimum Triple-capable build | `2026071401` | **PASS locally** — legacy clients retain the safe projection |
| Global Triple gate | `0` | Must remain off |
| QA-only Triple gate | `1` | Required for generated QA rooms only |
| Default rally mode | Double | Must remain unchanged |

`2026071401` is verified as one atomic local cache/build generation: the same current value appears in server metadata, updater/rally scripts, all first-party KvK asset URLs, and their tests. Phase A intentionally reports `minKvkBuild:2026071301`, so updater-capable `2026071302` and `2026071303` pages are not forced to reload during bootstrap. A synthetic Phase B regression proves that a later, separate `1301 → 1401` minimum-only change reloads those stale updater pages while an active personal countdown still defers the refresh. This is local evidence, not evidence that either phase has been deployed.

Pages currently open from the production baseline may advertise build `0` and do not contain the updater. No minimum value can remotely force those already-open pages to reload. Phase B and global Triple therefore remain blocked until a real battle-window inventory proves build `0` is absent; if that inventory is unavailable, the decision stays **HOLD**.

## Local automated evidence

Run all commands from `kingshoter/`. Every QA runner must retain its generated-room guard.

| Gate | Exact command | Status | Observed evidence (UTC, counts/details) |
|---|---|---|---|
| Full unit/regression suite | `npm test` | PASS | `2026-07-15T04:25:15Z` recorded; 287/287, exit 0 |
| Focused Triple suite | `npm run test:triple` | PASS | `2026-07-15T04:25:15Z` recorded; 142/142, exit 0 |
| Core browser compatibility | `npm run test:kvk-core:all` | PASS | `2026-07-15T04:25:15Z` recorded; Chromium/Firefox/WebKit 3/3 projects and 6/6 core/compatibility scenarios, exit 0; generated `qa-kvk-*` only |
| Reliable-delivery browser QA | `npm run test:qa:delivery` | PASS | `2026-07-15T04:25:15Z` recorded; Chromium/Firefox/WebKit 9/9, exit 0; generated `qa-kvk-*` only |
| Triple browser QA | `npm run test:qa:triple` | PASS | `2026-07-15T04:25:15Z` recorded; Chromium/Firefox/WebKit 9/9, exit 0; generated `qa-kvk-*` only |
| Double lead 10 | `node test/lead-timing.cjs http://127.0.0.1:8791 10` | PASS | `2026-07-15T04:25:15Z` recorded; 17/17, exit 0 |
| Double lead 15 | `node test/lead-timing.cjs http://127.0.0.1:8791 15` | PASS | `2026-07-15T04:25:15Z` recorded; 16/16, exit 0 |
| Double lead 30 | `node test/lead-timing.cjs http://127.0.0.1:8791 30` | PASS | `2026-07-15T04:25:15Z` recorded; 17/17, exit 0 |
| Double lead 60 | `node test/lead-timing.cjs http://127.0.0.1:8791 60` | PASS | `2026-07-15T04:25:15Z` recorded; 17/17, exit 0 |
| Worker syntax | `node --check src/worker.js && node --check src/room.js` | PASS | `2026-07-15T03:16:59Z` recorded; 2/2, exit 0 |
| Browser-source syntax | `node --check public/app.js && node --check public/kvk.js && node --check public/kvk-rally.js && node --check public/kvk-update.js` | PASS | `2026-07-15T03:16:59Z` recorded; 4/4, exit 0 |
| Rollback semantics | `node --test --test-name-pattern="rollback normalizes future mode" test/triple-room.test.cjs` | PASS | `2026-07-15T04:25:15Z` recorded; 1/1, exit 0 |
| Changed-source syntax | `{ git diff --name-only --relative HEAD -- '*.js' '*.cjs' '*.mjs'; git ls-files --others --exclude-standard -- '*.js' '*.cjs' '*.mjs'; } \| sort -u \| while IFS= read -r file; do node --check "$file" \|\| exit 1; done && node -e 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8"))'` | PASS | `2026-07-15T04:25:15Z` recorded; 71/71 files plus `package.json` parse, exit 0 |
| Diff whitespace/errors | `git diff --check` | PASS | `2026-07-15T04:25:15Z` recorded; exit 0 |
| Non-publishing Worker build | `npx wrangler deploy --dry-run` | PASS | `2026-07-15T04:25:15Z` recorded; 27 assets, 120.74 KiB / gzip 25.73 KiB, exit 0; global `0`, QA `1` |

Core browser compatibility and the Double lead matrix require the same separately started local Worker on port `8791`. The core runner refuses non-loopback origins and both runners create only generated `qa-kvk-*` rooms. Start the Worker in another terminal with an isolated temporary state directory:

```bash
cd kingshoter
QA_STATE="$(mktemp -d)"
npx wrangler dev --local --ip 127.0.0.1 --port 8791 \
  --persist-to "$QA_STATE" \
  --var TRIPLE_RALLY_ENABLED:0 \
  --var TRIPLE_RALLY_QA_ENABLED:1 \
  --log-level warn
```

Wait for the Worker, then run core compatibility and the four lead values:

```bash
cd kingshoter
curl --fail --silent --show-error \
  http://127.0.0.1:8791/api/time >/dev/null

BASE=http://127.0.0.1:8791 npm run test:kvk-core:all

for lead in 10 15 30 60; do
  node test/lead-timing.cjs http://127.0.0.1:8791 "$lead"
done
```

`npm run test:qa:delivery` and `npm run test:qa:triple` do not use this Worker by default. Each starts its own isolated Worker on port `8799`; remote origins require their explicit production authorization gate.

These local tests may prove target calculations, personal countdown scheduling, silence for an unselected commander, browser compatibility, responsive layout, state synchronization, and UI delivery acknowledgements. They cannot prove operating-system background survival or physical audio delivery.

## Deferred deployed evidence

Deployment and production-connected QA are outside this implementation session. Leave these rows unchanged until an explicitly authorized release session observes them.

| Gate | Requirement | Status | Observed evidence (UTC, counts/details) |
|---|---|---|---|
| Phase A updater bootstrap deployment | Current `1401`, minimum KvK `1301`, minimum Triple `1401`; global `0`, QA `1`; record immutable deployment identifier | Not run | — |
| Phase A build endpoint | HTTP 200, `Cache-Control: no-store, max-age=0`; exact `1401/1301/1401`; global `false`, QA `true` | Not run | — |
| Deployed browser QA | Generated `qa-kvk-*` only; `EXPECT_TRIPLE_GLOBAL=0` | Not run | — |
| Battle-window build inventory | Aggregate build `0`, below-minimum, and Triple-capable socket counts; no user or room identifiers | Not run | — |
| Separate Phase B minimum-build deployment | Only minimum KvK changes `1301 → 1401`; current/minimum Triple/assets stay `1401`, global stays `0`; updater-capable stale clients refresh after any active cue | Not run | — |
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
2. Phase A is verified as exact build metadata `1401/1301/1401`, and the synthetic Phase B minimum-only regression reloads stale updater pages without interrupting an active cue.
3. The Phase A updater bootstrap and generated-room deployed QA rows are `PASS` while global Triple is still off.
4. Every physical platform row is `PASS`; no selected captain misses or duplicates a cue, and every unselected commander remains silent.
5. Before Phase B, at least one complete real battle-window inventory contains no build-0 operation-room sockets. If inventory is unavailable, Phase B and the global gate remain off.
6. Phase B is a separate deployment that changes only `MIN_KVK_BUILD` from `2026071301` to `2026071401`; global Triple remains off and generated-room QA passes again.
7. Global enablement is a later, separate deployment and applies to all operation rooms together; it is never tested as a named-room canary.

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

If Phase B itself must be rolled back, change only `MIN_KVK_BUILD` from `2026071401` back to `2026071301`, keep current/minimum Triple and all static asset builds at `2026071401`, and keep global Triple off. Never combine this rollback with a Triple enablement deployment.

## Evidence log

Append observations; never overwrite a failure or convert an unavailable test into a pass.

| UTC timestamp | Scope | Generated QA room / build | Result | Evidence or failure |
|---|---|---|---|---|
| `2026-07-15T03:17:00Z` | Local release gate | Build `2026071401`; generated `qa-kvk-*` rooms only | PASS locally / HOLD globally | Unit 268/268; focused 80/80; browser QA 9/9 + 9/9; Double leads 17/17, 16/16, 17/17, 17/17; syntax, rollback, and dry-run pass. No deployment or physical-device evidence. |
| `2026-07-15T03:43:09Z` | Post-review local release gate | Build `2026071401`; generated `qa-kvk-*` rooms only | PASS locally / HOLD globally | Closed cross-player march mutation, cross-kingdom live-captain reuse, weak2 shadow delivery, keep-alive status, and mutable Double-fire snapshot gaps. Unit 279/279; focused 127/127; core browser projects 3/3 with 6/6 scenarios; browser QA 9/9 + 9/9; Double leads 17/17, 16/16, 17/17, 17/17; changed-source syntax, diff check, and dry-run pass. No deployment or physical-device evidence. |
| `2026-07-15T04:00:53Z` | Core browser first attempt | Phase A `1401/1301/1401`; generated `qa-kvk-*` rooms only | FAIL (transient) | Chromium core/compatibility passed; Firefox timed out waiting 7 seconds for its AudioContext to enter `running`. No production connection or state mutation. |
| `2026-07-15T04:00:53Z` | Phase A gate before legacy-script quarantine | Phase A `1401/1301/1401`; generated `qa-kvk-*` rooms only | PASS locally / HOLD globally | Targeted Firefox passed, then clean core rerun passed 3/3 projects and 6/6 scenarios. Unit 283/283; focused 138/138; browser QA 9/9 + 9/9; Double leads 17/17, 16/16, 17/17, 17/17; 21/21 then-changed source files, diff check, and dry-run passed. No deployment, build inventory, or physical-device evidence. |
| `2026-07-15T04:11:24Z` | Final local Phase A gate | Phase A `1401/1301/1401`; generated `qa-kvk-*` rooms only | PASS locally / HOLD globally | Retained 39 legacy production KvK scripts now stop before Playwright import. Unit 285/285; focused 140/140; clean core 3/3 projects and 6/6 scenarios; browser QA 9/9 + 9/9; Double leads 17/17, 16/16, 17/17, 17/17; rollback 1/1; 62/62 changed-source syntax, diff check, and dry-run pass. No deployment, build inventory, or physical-device evidence. |
| `2026-07-15T04:25:15Z` | Final repository-wide local Phase A gate | Phase A `1401/1301/1401`; generated `qa-kvk-*` rooms only | PASS locally / HOLD globally | Inventory now classifies every manual KvK network script: 43 unsafe legacy scripts stop before browser/WebSocket launch; five useful runners require loopback + generated room + exact origin. Unit 287/287; focused 142/142; clean core 3/3 projects and 6/6 scenarios; browser QA 9/9 + 9/9; Double leads 17/17, 16/16, 17/17, 17/17; rollback 1/1; 71/71 changed-source syntax, diff check, and dry-run pass. No deployment, build inventory, or physical-device evidence. |
