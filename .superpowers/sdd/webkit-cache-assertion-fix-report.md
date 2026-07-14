# WebKit tap-fix review remediation: stale cache assertions

Date: 2026-07-14

## Scope

- Updated only the exact KvK stylesheet locator from `app.css?v=29` to `app.css?v=30` in the four approved legacy E2E scripts.
- Did not change production files, JavaScript cache versions, test behavior, package scripts, the QA guard, or the consolidated core suite.

## Pre-edit impact

After refreshing the stale worktree index, upstream GitNexus impact was LOW for each approved test file: 0 direct callers, 0 affected processes, and 0 affected modules. No HIGH or CRITICAL symbol was involved.

## TDD RED

Before editing:

```sh
cd kingshoter
BASE=http://127.0.0.1:8791 node test/march-sync.e2e.cjs
```

Result: exit 1 in `test/march-sync.e2e.cjs:172`, where the stale `link[href="app.css?v=29"]` locator returned 0 instead of the expected 1.

- QA room: `qa-kvk-march-sync-mrkttk8p-ab3549`

## GREEN verification

The four affected scripts passed sequentially against `127.0.0.1:8791`:

- `march-sync.e2e.cjs`: exit 0, `qa-kvk-march-sync-mrktucct-8dabce`
- `identity-input.e2e.cjs`: exit 0, `qa-kvk-identity-input-mrktur2c-9a404f`
- `roster-control.e2e.cjs`: exit 0, `qa-kvk-roster-control-mrktv0ty-8b98d4`
- `player-removal.e2e.cjs`: exit 0, `qa-kvk-player-removal-e2e-mrktv720-16888a`

Additional gates:

- `npm test`: exit 0, 67 passed and 0 failed.
- `node --check` for all four affected scripts: exit 0.
- `rg -n 'app\\.css\\?v=29' kingshoter/test kingshoter/public`: no matches (expected exit 1).
- The stylesheet `v=30` reference is present in `public/kvk.html`, the static cache-version unit assertion, and all four affected scripts.
- `git diff --check`: exit 0.

No browser run connected to room 1406. All runs used script-generated `qa-kvk-*` rooms. No deployment or push was performed.

## GitNexus staged scope

The staged check reported LOW risk across the expected five files, with 0 changed indexed symbols and 0 affected execution flows.
