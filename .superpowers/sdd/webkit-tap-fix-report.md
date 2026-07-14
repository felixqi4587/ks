# WebKit commander march Adopt tap fix report

Date: 2026-07-14

## Scope

- Replaced the conflict-path keyboard activation with a trusted `page.mouse` pointer sequence.
- Kept `#fireDock` static for the complete visible lifetime of `#commanderMarchEditor` while preserving the existing `.nofix` focus rule.
- Bumped only the KvK stylesheet cache URL from `app.css?v=29` to `app.css?v=30` and aligned its exact unit assertion.
- Did not change JavaScript, countdown, audio, delivery/protocol, server, or room behavior.

## TDD RED

Before any production edit:

```sh
cd kingshoter
node test/kvk-core-multibrowser.e2e.cjs --project=webkit
```

Result: exit 1 at `Fire dock stays yielded while the pointer is down` with `'sticky' !== 'static'`.

Captured evidence:

```json
{
  "afterDown": { "hit": "syncPill", "position": "sticky", "nofix": false },
  "trace": [
    { "type": "pointerdown", "target": "commanderMarchAdopt", "trusted": true },
    { "type": "mousedown", "target": "commanderMarchAdopt", "trusted": true },
    { "type": "pointerup", "target": "syncPill", "trusted": true },
    { "type": "mouseup", "target": "syncPill", "trusted": true },
    { "type": "click", "target": "console", "trusted": true }
  ]
}
```

This is the intended regression: the trusted down began on Adopt, then focus loss removed `.nofix`, the dock became sticky, Sync Pill replaced Adopt in the hit-test stack, and the click missed Adopt.

## Minimal fix

```css
.firedock.nofix,#commanderMarchEditor:not(.hide) ~ #fireDock{position:static}
```

The general-sibling visibility invariant prevents the dock from moving over editor controls in the middle of a gesture. The existing focus-based rule remains intact.

## GREEN verification

Focused WebKit:

```sh
node test/kvk-core-multibrowser.e2e.cjs --project=webkit
```

Result: exit 0, 1/1 browser project passed. The trusted pointer assertions confirmed static dock position, Adopt as the post-down hit target, trusted click on Adopt, and the existing editor-hidden outcome.

- Core: `qa-kvk-kvk-core-multibrowser-e2-mrks8co6-e2d399`
- Compatibility: `qa-kvk-kvk-core-multibrowser-e2-mrks8mey-007c0f`

All browser engines:

```sh
npm run test:kvk-core:all
```

Result: exit 0, 3/3 browser projects passed in generated `qa-kvk-*` rooms.

- Chromium core: `qa-kvk-kvk-core-multibrowser-e2-mrks970q-3c536b`
- Chromium compatibility: `qa-kvk-kvk-core-multibrowser-e2-mrks9fpr-3a626c`
- Firefox core: `qa-kvk-kvk-core-multibrowser-e2-mrks9h1t-c62dfb`
- Firefox compatibility: `qa-kvk-kvk-core-multibrowser-e2-mrks9s4k-0ef3d8`
- WebKit core: `qa-kvk-kvk-core-multibrowser-e2-mrks9uer-ca46c7`
- WebKit compatibility: `qa-kvk-kvk-core-multibrowser-e2-mrksa4b6-03ab7a`

Additional gates:

- `npm test`: exit 0, 66 tests passed, 0 failed.
- `node --check test/kvk-core-multibrowser.e2e.cjs`: exit 0.
- `git diff --check`: exit 0.

No browser run connected to room 1406. This is desktop Playwright WebKit engine coverage, not real-iPhone validation.

## GitNexus

Pre-edit impact was LOW for all four approved files: 0 direct callers, 0 affected processes, and 0 affected modules. The edited `runCoreScenario` symbol was also LOW: 1 direct caller (`runProject`), 0 affected processes, and 1 Test module. No HIGH or CRITICAL symbol was edited.

Staged `gitnexus_detect_changes` reported LOW risk across the expected 5 staged files, 11 indexed test-file symbols marked touched, and 0 affected execution flows. The additional touched test symbols are line-offset mappings after inserting the new helper; the staged diff remains limited to the helper/call-site, CSS rule, stylesheet cache URL/assertion, and this report.
