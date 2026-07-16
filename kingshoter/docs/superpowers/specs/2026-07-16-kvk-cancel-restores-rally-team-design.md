# KvK Cancel Restores Rally Team Design

## Goal

Cancelling a live Double or Triple rally must return its selected captains to the editable commander lineup so the commander can correct timing or immediately Fire again without rebuilding the team.

## Confirmed root cause

- Fire correctly consumes `live.staged[kingdom]` and freezes the selected captains in the live command.
- Cancel currently deletes `live.commands[kingdom]` and then runs the shared “real order supersedes staging” cleanup.
- After that transition neither the live command nor canonical staging contains the selected lineup, so every commander client reconciles its local picks to an empty list.
- This behavior predates the current homepage work; it is a missing Cancel state transition rather than a presentation regression.

## Approved behavior

- Fire continues to consume canonical staging. A live order and a standby selection do not coexist during the countdown.
- Cancelling an active `double_rally` or `triple_rally` atomically:
  1. captures that command’s immutable captain pairs;
  2. removes the live command;
  3. restores valid `{ pid, role }` pairs into the same kingdom’s canonical staging;
  4. persists and broadcasts one canonical room snapshot.
- Restored staging contains only routing PID and role. Names, march times, launch times, receipt history, and delivery facts are never copied back from the frozen command.
- A later Fire rebuilds its frozen command from current canonical player records, so march-time edits made while the prior order was live are honored.
- The other kingdom’s command and staged selection are never changed.
- A duplicate or delayed Cancel for a kingdom with no active command is a no-op. It must not clear a lineup restored by an earlier Cancel.
- Cancelling `refill`, `ping`, or an unknown legacy non-rally command does not synthesize a rally lineup.

## Current-state reconciliation

The cancelled command is projected through current room truth before it is restored:

- In unchanged Double mode, valid `weak` and `main` captains are restored.
- In unchanged Triple mode, valid `weak`, `weak2`, and `main` captains are restored.
- If Triple changed to Double while live, `weak2` is dropped and valid `weak`/`main` captains remain.
- If Double changed to Triple while live, the two valid captains remain and the commander selects `weak2` before the next Fire.
- A player no longer present in the room is dropped while the remaining valid captains are preserved.
- A captain now assigned to the other kingdom’s staged or active rally is dropped from the restored selection; the other kingdom remains authoritative.
- Invalid, duplicate, or unsupported legacy pairs are discarded rather than reintroduced into canonical state.

## Audio behavior

- Selected captains retain the existing cancellation cue and cancellation toast.
- Restoring the same captain assignment in the same Cancel snapshot must not immediately play a second standby alert.
- The client therefore carries the assignment key (`kingdom:role`) across the Stage → Fire transition using either canonical staging or the active command’s frozen pairs.
- A normal new stage assignment still produces the existing standby alert.
- A device first joining after cancellation may receive the normal standby alert because it never observed the prior assignment; this is correct and gives that device the current room truth.

## Synchronization and recovery

- The restored selection is server-authoritative, not a browser-only draft.
- All connected commander devices receive it in the same broadcast.
- A refreshed or reconnected commander reconstructs it from canonical staging.
- The Fire button becomes available again when the restored lineup is complete for the current mode.
- No new protocol message or room schema field is introduced.

## Verification

- Server tests cover Double, Triple, both live mode-change directions, removed/invalid players, cross-kingdom isolation, non-rally Cancel, and duplicate/late Cancel idempotency.
- Client tests cover Stage → Fire → Cancel assignment-key continuity and prove the restored state does not request a second standby alert.
- Multi-browser testing proves two commanders see the editable restored lineup, refresh/reconnect preserves it, and Fire can be used again.
- Existing Reliable delivery cancellation ordering and all current unit, Triple, and Delivery suites remain green.
- Online verification uses a newly generated `qa-kvk-*` room in the isolated `kingshoter-qa` Worker. Production traffic and production rooms are not changed.
