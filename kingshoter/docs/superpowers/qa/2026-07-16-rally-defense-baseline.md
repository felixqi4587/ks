# Rally / Defense Pre-change Baseline

Date: 2026-07-16  
Worker: `kingshoter`  
Branch: `codex/kvk-delivery-program`

## Restore and deployment identity

- Pre-change worktree Git SHA: `0e97ade77500cf25fb93c1e49bea124136776c16`
- Current production source identity reported by Wrangler: `6653e2f` (`git-6653e2f`)
- Previous/current production Worker version ID: `42101b01-fe1d-4639-9c1f-be7ab234bc84`
- Production version creation time: `2026-07-16T22:47:57.270Z`
- Production deployment creation time: `2026-07-16T22:47:58.455Z`
- Production deployment message: `KvK silent commander launch monitor build 2026071602`
- Ancestry check: `6653e2f` is an ancestor of the pre-change worktree SHA.
- Source delta from `6653e2f` to the pre-change worktree SHA is documentation only: the Rally / Defense implementation plan and two approved design specifications.

The legacy name `online-prod-2026-07-15` is intentionally left unchanged. Locally it is ambiguous because both a branch and an annotated tag exist; both peel to `eccc2b31c0c79be366869e7a5bd64b35e5b6508c`. The remote has only the annotated tag, and `git ls-remote --heads origin online-prod-2026-07-15` returned no matching branch. This baseline does not move, recreate, or otherwise mutate either legacy ref.

## Identity command evidence

| Command | Exit | Evidence |
|---|---:|---|
| `git status --short` | 0 | Existing unrelated untracked planning/agent assets only: `../.claude/`, `../AGENTS.md`, `../CLAUDE.md`, `.superpowers/`. |
| `git branch -vv` | 0 | `codex/kvk-delivery-program` at `0e97ade`, ahead of `origin/codex/kvk-delivery-program` by five documentation commits. |
| `git ls-remote --heads origin online-prod-2026-07-15` | 0 | No matching remote branch. |
| `npx wrangler deployments list --name kingshoter` | 0 | Latest deployment is 100% version `42101b01-fe1d-4639-9c1f-be7ab234bc84`, created `2026-07-16T22:47:58.455Z`, tagged `git-6653e2f`. |
| `npx wrangler versions list --name kingshoter` | 0 | Latest version is `42101b01-fe1d-4639-9c1f-be7ab234bc84`, created `2026-07-16T22:47:57.270Z`, tagged `git-6653e2f`. |

No credentials, tokens, account identifiers, or secret values are recorded here.

## Source restore tag

- Annotated tag: `rally-defense-prechange-20260716`
- Annotation: `Pre Rally Defense source restore point`
- Tag object: `76a0389f2289fea6115bedff960b067955559034`
- Peeled commit: `0e97ade77500cf25fb93c1e49bea124136776c16`
- `git push origin rally-defense-prechange-20260716`: exit 0 (`[new tag]`).
- Remote verification: `refs/tags/rally-defense-prechange-20260716^{}` resolves to the same peeled commit.

## Characterization gate

- Focused Rally characterization command: exit 0.
- Result: 42 tests, 42 passed, 0 failed.
- The focused gate covers existing Rally timing, audio/readiness, cancellation, reconnect, Double/Triple behavior, and room-device delivery semantics.
- New characterization tests are deliberately read-only locks around the pre-change behavior; they do not alter runtime code.

## Full baseline gates

| Gate | Exit | Result |
|---|---:|---|
| `npm test` | 0 | 380 tests passed, 0 failed. |
| `npm run test:delivery` | 0 | 120 tests passed, 0 failed. |
| `npm run test:triple` | 0 | 183 tests passed, 0 failed. |

All four baseline gates completed successfully before any production runtime symbol was edited.

## Frozen Rally behavior

- Double and Triple selected captains receive their own press-time countdown and audio.
- Ordinary members receive the shared JOIN visual/audio only when the current Rally targeting policy includes them.
- An unselected commander receives the silent all-captain launch monitor.
- Cancellation stops outstanding cues while preserving the staged captain selection.
- Reconnect and clock-drift recovery replan only future cues, and one command never produces duplicate GO audio.
- The selected lead time is the actual start of the personal countdown.
