# KvK Direct Remove and Two-Minute March Design

**Date:** 2026-07-15  
**Status:** Approved for implementation  
**Scope:** Commander roster actions, march-time validation and migration, the idle tactical scale, and the march-measurement hint

## Context

The commander roster already makes each player's displayed march time a direct edit button. The adjacent overflow menu repeats that edit action before offering removal, so it adds a tap without adding a distinct capability.

The player form and server currently accept march times from 5 through 180 seconds. The idle tactical panel derives its scale from the current room maximum, so identical times can appear at different positions in different rooms. The approved operating range is now 5 through 120 seconds, with one fixed two-minute comparison scale.

## Decisions

### Direct roster removal

Each commander roster row contains exactly four controls:

1. player selection;
2. current rally role;
3. march time, which opens the existing commander march editor;
4. a localized `Remove` / `删除` button.

The overflow trigger and its menu are removed completely. This includes the duplicated `Edit march time` item, menu positioning, roving focus, outside-click dismissal, and menu-only status text.

The direct Remove button retains a minimum 44-pixel touch target and uses the existing coral destructive styling. It never deletes immediately. A permitted click opens the existing confirmation dialog, whose staged-position impact, active-command protection, retry behavior, persistence semantics, and room-wide synchronization remain unchanged.

When removal is temporarily unavailable because the player is in an active rally or another player's removal has an unresolved outcome, the control exposes `aria-disabled="true"` but remains capable of explaining the reason through the existing localized toast. It does not open the confirmation dialog. Closing the dialog or recovering from an error restores focus to the same player's direct Remove button when that row still exists, otherwise to the existing roster fallback.

### One march-time domain

`MARCH_MIN` remains 5 seconds. `MARCH_MAX` becomes 120 seconds and is the single server authority used by registration, player profile updates, commander overrides, Double construction, and Triple construction.

The browser uses the same inclusive 5–120 second domain for:

- the player slider (`max="120"`);
- the `−1` and `+1` controls;
- commander `MM:SS` parsing and adjustment buttons;
- validation copy (`0:05–2:00`);
- local draft restoration;
- roster and profile rendering.

New or stale clients cannot submit a value above 120. A client-build bump forces older updater-capable pages onto the coherent asset generation before they can continue normal operation.

### Existing values above two minutes

At room-state normalization, every stored integer march value above 120 is changed to exactly 120. The player's identity, ownership, presence, staging, and other profile fields remain intact. The march revision advances once and the migrated room is persisted so all connected and reconnecting clients converge on the same canonical value.

Values at or below 120 are unchanged. The migration does not rewrite already-fired commands: their frozen march and personal press times remain immutable. Any later Fire uses the migrated canonical value.

Room-local browser profiles accept the next canonical room snapshot and replace a stale local value with 120. They never recreate the old value on reconnect.

### Fixed idle tactical scale

The idle tactical timeline and radar use a fixed 120-second domain. A 30-second march therefore occupies one quarter of the scale, 60 seconds one half, and 120 seconds the endpoint in every room. The scale no longer expands or contracts according to the longest currently registered player.

The live post-Fire timeline is not converted into a two-minute scale. It continues to show the real sequence from captain press through the five-minute in-game rally-gather period, march, and landing. That live axis represents the full command timeline rather than only march distance.

### Pet-buff reminder

The English march hint is exactly one sentence:

> Battle tip: if you will use a pet march-speed buff, activate it before measuring.

The Chinese march hint is exactly one equivalent sentence:

> 实战提示：如果你会使用宠物行军速度增益，请在测量前先开启。

Neither locale shows an additional instruction. The reminder does not add a setting, store whether a buff was used, change validation, or prevent test players from entering an unbuffed measurement.

## Data and protocol behavior

No new public protocol message is introduced. Existing registration, own-profile update, commander march update, removal, staging, and Fire messages keep their current shapes.

The server remains canonical. March migration happens before snapshots and new command construction use room players. The removal button continues to call the existing confirmation flow and sends the existing authenticated `removePlayer` mutation only after confirmation.

## Accessibility and responsive behavior

- Time and Remove remain separate native buttons with distinct localized accessible names.
- Remove is text, not an icon-only control.
- The row allocates enough width for `Remove` and `删除` without horizontal scrolling; the player-name column remains the flexible column.
- Focus-visible styling remains available on every row control.
- The confirmation dialog keeps its initial Cancel focus and current focus trap.
- An unavailable direct Remove control announces its reason through a toast instead of relying on a removed menu description.

## Error handling

- Active rally: no dialog and no mutation; explain that the rally must be cancelled first.
- Another unresolved removal: no dialog and no target replacement; explain which removal is still pending.
- Player disappears between click and dialog: close safely and restore roster fallback focus.
- Persistence, reconnect, wrong-password, conflict, retry, and unknown-result behavior stays in the existing removal state machine.
- March above 120 from any mutation path returns `invalid_march` without partial state changes.
- A stale client conflict returns canonical 120-second data where migration applied.

## Test requirements

1. Domain tests prove 5 and 120 are accepted while 4 and 121 are rejected in registration, self-edit, commander edit, Double, and Triple paths.
2. Migration tests prove values above 120 become 120, revisions advance once, storage persists the result, unrelated fields remain intact, and frozen active commands do not change.
3. Client tests prove the slider and commander editor stop at 2:00, stale local profiles reconcile to 120, and the validation copy contains no 3:00/180-second wording.
4. Tactical-view tests prove the idle scale is fixed at 120 and the live five-minute gather timeline remains unchanged.
5. Copy tests prove the English hint is exactly the approved sentence and the Chinese locale contains one equivalent sentence.
6. Removal browser tests prove there is no overflow menu, the direct Remove target is at least 44 pixels, blocked removal explains itself, a permitted click opens confirmation, and cancel/error focus restoration is correct.
7. Existing roster click-convergence, player removal, march synchronization, Double/Triple timing, delivery, updater, and three-browser QA suites remain green in generated `qa-kvk-*` rooms only.

## Non-goals

- No pet-buff state, selector, or enforcement.
- No change to rally lead-time semantics, personal countdowns, audio delivery, gathering duration, or landing offsets.
- No immediate one-tap destructive deletion.
- No special room behavior, including for room 1406.
- No production deployment before isolated QA passes.
