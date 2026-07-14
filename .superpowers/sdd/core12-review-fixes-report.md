# Core Task 12 review-remediation report

## Scope and safety

- Changed only `kingshoter/test/support/qa-kvk.cjs`,
  `kingshoter/test/qa-kvk.test.cjs`,
  `kingshoter/test/kvk-core-multibrowser.e2e.cjs`, and this report.
- No production `src/` or `public/` file changed. No deployment or push was
  performed. Every browser run printed only generated `qa-kvk-*` rooms; room
  `1406` was never targeted.
- Preserved the trusted-pointer regression coverage from `2088b5b`, including
  its intentional 50 ms pointer hold. Preserved the intentional 2.3 s ACK
  retry-stability observation window.

## GitNexus impact evidence

- `installQaWebSocketGuard`: treated as **HIGH** because its context graph has
  26 direct test callers, 0 production processes, and only the Test module.
  The implementation is additive and synchronous; absent/default behavior
  passes the original frame object through unchanged.
- `packetGate`: LOW, 3 direct callers; `fireDouble`, `cancelCommand`, and
  `openRole`: LOW, 2 direct callers each; `gateOptions`, `requestedProjects`,
  `stripDeliveryAggregate`, `runCoreScenario`, and
  `runCompatibilityScenario`: LOW, 1 direct caller each (or as reported in the
  brief), with 0 affected execution processes.
- Final staged change detection: **LOW**, 4 changed files, 40 indexed
  symbols, 0 affected execution flows, and no production process impact.

## RED / GREEN evidence

The QA WebSocket guard test was added before the helper edit.

- RED: `node --test test/qa-kvk.test.cjs` exited 1 (2 passed, 1 failed).
  `the transformed server frame reaches the page` received the original raw
  `{"t":"server"}` frame instead of `{"t":"transformed"}`.
- GREEN after the minimal helper edit: the same command exited 0 (3/3).
  The mock proves default client/server frame identity passthrough, optional
  inbound transform, unchanged client forwarding, non-QA refusal, and
  `TypeError` for a non-function transform.

## Acceptance coverage added

- Legacy compatibility now drops outbound delivery protocol and removes
  inbound `delivery` at the Playwright proxy boundary. Exact ignored frames,
  raw inbound states, transformed legacy frames, and page-observed state are
  retained as evidence; no global `JSON.parse` monkeypatch or `__qaLegacy*`
  state remains.
- Both frozen captain pairs are cloned by PID, both captain march values are
  changed after Fire, the complete pairs remain deep-equal, and Captain A,
  Captain A's second device, and Captain B retain their original personal GO
  cue targets.
- Three fresh-socket forged ACK probes cover unbound, mismatched ready binding,
  and `soundReady:false`; each receives `bad_delivery_identity`, receives no
  `deliveryAckSaved`, and leaves the complete delivery aggregate unchanged.
- Player-originated 61 s and commander-originated 63 s march changes are
  verified in raw state and rendered roster for all eight live contexts.
  Both Captain A contexts persist the exact canonical march revision.
- Duplicate `--project` is rejected before browser launch; Fire and Cancel use
  UI conditions instead of fixed confirmation delays; selected-commander cues
  are awaited; rejected live removal preserves both live state and the full
  protected player record.

## Verification

- Focused unit: `node --test test/qa-kvk.test.cjs` — exit 0, 3/3.
- Full unit suite: `npm test` — exit 0, 67/67.
- Focused Chromium: exit 0:
  - core `qa-kvk-kvk-core-multibrowser-e2-mrkt9h4w-c95732`
  - compatibility `qa-kvk-kvk-core-multibrowser-e2-mrkt9q1a-c3c12b`
- Final `npm run test:kvk-core:all` — exit 0, 3/3 projects:
  - Chromium: `qa-kvk-kvk-core-multibrowser-e2-mrktc49t-4d35f5`,
    `qa-kvk-kvk-core-multibrowser-e2-mrktccvt-c4ceb7`
  - Firefox: `qa-kvk-kvk-core-multibrowser-e2-mrktcdyn-df842b`,
    `qa-kvk-kvk-core-multibrowser-e2-mrktco6b-7b1534`
  - WebKit desktop automation:
    `qa-kvk-kvk-core-multibrowser-e2-mrktcq51-4dcd0e`,
    `qa-kvk-kvk-core-multibrowser-e2-mrktczha-dd316d`
- Duplicate parser negative:
  `node test/kvk-core-multibrowser.e2e.cjs --project=chromium --project=firefox`
  — expected exit 1 with `Duplicate --project argument` and no room/browser
  output.
- `node --check` for all three approved test files — exit 0.
- `git diff --check` — exit 0.

## Concern observed and resolved

The first sequential all-engine run passed Chromium and Firefox, then WebKit's
browser process closed while opening contexts. WebKit alone passed both
scenarios, and a fresh full three-engine command subsequently passed 3/3.
No code change was made for that non-reproducing process closure.
