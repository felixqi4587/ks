# KvK Coordinated Delivery Rollout Record

## Safety invariants

- Automated and production-connected QA use newly generated `qa-kvk-*` rooms only.
- Every non-QA room is an operation room; no room receives a named exception.
- Classic is the only production audio authority.
- Double Rally remains the default.
- Triple and both backup-channel labs stay gated until their own evidence passes.
- Physical evidence is never inferred from desktop automation.

## Baseline

| Fact | Observed value |
|---|---|
| Plan commit | `3ec9cde` |
| Runtime source checkpoint | Pending |
| Cloudflare Worker version | `b669b88f-f8f9-480f-88a8-469bb95fb50f` |
| Deployment observed at | `2026-07-13T14:51:19.426Z` |
| Baseline unit test | `npm test`: 18 passed, 0 failed |
| Baseline syntax | `worker.js`, `room.js`, `app.js`, `kvk.js`: PASS |

## Program status

| Area | Status | Evidence |
|---|---|---|
| Core player control | PLANNED | Approved plan committed |
| Reliable no-audio shadow | PLANNED | Approved plan committed |
| Triple Rally | GLOBAL OFF | Approved plan committed |
| Backup Push lab | DEFAULT OFF | Approved plan committed |
| Audio Stream lab | DEFAULT OFF | Approved plan committed |

## Rollback

The pre-program Worker version is `b669b88f-f8f9-480f-88a8-469bb95fb50f`. Do not run rollback unless the deployed Core bootstrap is unhealthy. Record every deployment, QA room prefix, gate value, test count, and actual rollback here as work proceeds.
