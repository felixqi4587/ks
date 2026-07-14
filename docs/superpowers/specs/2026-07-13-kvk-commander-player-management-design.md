# KvK Commander Player Management and Canonical March Time

**Date:** 2026-07-13
**Status:** Approved during brainstorming; awaiting review of this written specification
**Scope:** `kingshoter.com/kvk` commander roster, player march-time synchronization, and player removal

## Supersession

This design supersedes the conflicting removal rules in `2026-07-13-kvk-player-removal-design.md` while preserving that document as implementation history.

- A staged or locally selected player no longer blocks removal. Removal clears every staged reference atomically and then deletes the player.
- A player referenced by an active, already-fired command still cannot be removed until that command is canceled or expires.
- Removal remains roster cleanup rather than a permanent ban. A fully offline device that later presents a missing profile may register again.

It does not supersede the personal countdown contract in `2026-07-13-kvk-command-simplification-design.md`.

## Problem

The current commander roster combines three problems:

1. The commander console forces player chips into one non-wrapping horizontal row. At a 390px viewport, the roster has about 330px of visible width while the current room-1406 rows for Kimchi, Strategy, and HmL occupy about 673px. A commander sees roughly one and a half players and must swipe almost a full screen to reach HmL.
2. A commander can read a player's march time but cannot correct it. The player's browser owns the only editing controls.
3. A player's browser automatically submits its locally cached march time after every WebSocket reconnect. A commander-side server update would therefore be vulnerable to being silently reverted by an old device cache.

The selected-captain model also keeps local march snapshots. A server update can make the roster show a new value while the Sacrifice/Main slots still show the old value, even though Fire reads the current room value immediately before calculating the command. That inconsistency is unacceptable during live coordination.

## Goals

- Let an unlocked commander update any existing player's march time.
- Let a player continue to update their own march time through an explicit Save action.
- Make the room's server state the only current authority and show successful updates on every connected device immediately.
- Prevent automatic reconnects and stale concurrent requests from overwriting a newer value.
- Replace horizontal roster scrolling with a clear, full-width vertical list.
- Make selecting, replacing, editing, and removing players explicit and touch-safe.
- Let a commander remove selected or staged players while protecting active commands.
- Preserve the current personal countdown, lead-time, voice, Fire, Defense, and multi-kingdom behavior.

## Non-goals

- Ingesting real-time state from the Kingshot game.
- Tracking which ordinary member joins which in-game rally.
- Adding player accounts, device authentication, bans, or a roster audit log.
- Changing countdown formulas, selected lead behavior, voice-cue scheduling, or active-command expiry.
- Reintroducing a counter-rally calculator or separate anti-rally command path.
- Rewriting the frontend in a new framework or broadly refactoring unrelated KvK features.

## Product decisions

### Authority

`room.players[pid].march` is the single current march time.

- A commander may explicitly save a new value after password authentication.
- A player may explicitly save a new value for their own stored PID under the room's existing trust model.
- Either successful operation increments that player's `marchRevision`, persists the room once, and broadcasts one full room snapshot.
- Every connected roster, role slot, player card, local cache, and dependent calculation reconciles from that snapshot.
- Opening or reconnecting a socket never submits a cached march time for an existing player.

### Active commands

Staging references the current player record, but firing creates an immutable command snapshot.

- Local selections and server staging store only `pid` and `role` for each captain.
- Roster and role-slot rendering derive name and march time from the current `room.players[pid]` record.
- At Fire, the client reads the latest canonical march time and freezes `march` and `pressUTC` into the live command.
- Any later player or commander edit affects staging and the next Fire only. A countdown already running keeps its original visible timer and audio targets.
- For removal protection, an active command is a stored command whose `expiresUTC` is strictly later than the current server time. An expired command waiting for its alarm cleanup does not block removal.

### Removal

- Removal is available only in an unlocked commander console and requires the room password on the server operation.
- A selected or staged player may be removed after confirmation.
- Removal clears the PID from every kingdom's staged captain list and deletes the player in one server transaction, followed by one persist and one broadcast.
- A PID referenced by an active command cannot be removed. The server returns `player_in_live_command` without making a partial change.
- Each client prunes the missing PID from its local selections when it receives the new room snapshot.
- If the removed PID belongs to an online device, that device clears its stored room identity and returns to the registration state.
- A fully offline device may register again later. Permanent exclusion is outside this design.

## Commander user experience

### Roster layout

The commander roster becomes a full-width vertical list.

Each row contains, from left to right:

- a primary selection button containing the readiness/presence indicator and player name;
- a separate role button when selected;
- an editable `MM:SS` time button;
- a `⋯` player-actions button.

Behavior:

- The row is a non-interactive list item. Its primary selection button fills the remaining row width and selects or unselects the player.
- Role, time, and `⋯` are sibling buttons, never buttons nested inside the selection button. They do not trigger row selection.
- Selected players remain sorted first and retain the existing distinct selected state.
- The list's maximum visible height is four 44px rows plus three 8px gaps (200px); additional rows use vertical scrolling.
- Search appears only when the room has more than six players.
- The roster itself never requires horizontal scrolling at 375px or 390px viewport widths.

### Selection and replacement

The existing Sacrifice and Main role slots remain above the roster.

- With no captains selected, the first tap fills Sacrifice. The second tap fills Main. If one role is missing after a manual removal, the next tap fills that missing role.
- With two captains selected, tapping a third player no longer silently removes the earliest selection.
- Instead, the UI opens a compact choice that asks whether the new player should replace Sacrifice or Main and names the affected captain.
- Clicking the selected player's separate role button or the existing swap control continues to swap roles explicitly.
- A player used by the other kingdom remains unavailable and retains a clear explanation.

### March-time editor

Tapping the time button expands an editor next to that player.

- It identifies the player by name.
- It accepts `MM:SS` and offers `-5`, `-1`, `+1`, and `+5` second controls.
- The client and server enforce the same inclusive range: 5–180 seconds.
- Cancel discards the draft. Save sends the draft with the current `marchRevision`.
- The UI remains pending until it receives both the matching success acknowledgement and the room broadcast containing the new value; it does not optimistically present an unconfirmed value as canonical.
- A successful update refreshes every visible copy of the time, including both role slots and the player's own page.
- After both confirmations arrive, the editor closes and a localized message names the player and confirmed time.
- The editor states that an active countdown will not change.
- Soft-keyboard handling must preserve the existing behavior that prevents the sticky Fire dock from obscuring inputs.

### Player actions and delete confirmation

The persistent 44px delete button is removed from the row and moved into the `⋯` menu. The menu contains:

- Edit march time;
- Remove player.

The destructive confirmation names the player and lists the staged roles that will be cleared, for example: `K1 · Sacrifice`. If the player is in an active command, Remove is disabled with an explanation and the server still enforces the restriction.

All interactive controls use semantic buttons, visible keyboard focus, localized accessible names, and at least a 44px touch target. The list item itself has no click handler, preventing nested-button and keyboard-semantics conflicts. Closing an editor, menu, or confirmation returns focus to the control that opened it.

## Canonical player data

Each player record gains a monotonic revision:

```js
players[pid] = {
  name: "Kimchi",
  march: 34,
  marchRevision: 8,
  alliance: "",
  ready: false,
  lastSeen: "2026-07-14T01:01:49.216Z"
}
```

Migration is lazy and non-destructive:

- An existing record with a missing, negative, non-integer, or non-finite `marchRevision` is read as revision `0`.
- A new registration starts at revision `0`.
- The first successful march update changes the revision to `1`.
- No existing room, player PID, staging selection, or live command is reset during deployment.

## WebSocket responsibilities

The protocol retains the existing presence-only `hb` heartbeat and uses distinct `registerPlayer`, `updateOwnMarch`, and `setPlayerMarch` message types so reconnecting cannot mutate march time accidentally.

### Initial state and presence

On socket open, the client waits for the first room snapshot before sending any player mutation.

1. If the locally stored PID exists in `room.players`, the client adopts the server's march and revision, updates its controls and local storage, and sends one immediate `hb`. The existing 25-second client `hb` schedule and server-side 20-second persistence/broadcast throttle then continue to update `lastSeen` without touching march, name, role, or readiness.
2. If the PID does not exist, the client sends `registerPlayer` with its locally stored identity and march time. The operation creates the record only when the PID is still absent.
3. A create-only registration must not overwrite an existing record if another operation creates that PID first.
4. The create-only rule applies only to the first snapshot after a new connection. If a PID was present in a previous snapshot and disappears in a later broadcast, the online device treats that transition as commander removal, clears its local room identity, and does not auto-register.

The connection and registration messages have these contracts:

```js
{ t: "hb", pid }

{
  t: "registerPlayer",
  pid,
  name,
  march,
  alliance: ""
}
```

The existing heartbeat throttle remains unchanged. `registerPlayer` creates revision `0`, applies the existing 150-player roster cap, and never evicts unexpired active-command or staged PIDs. It then persists once and broadcasts once. If the PID already exists, it returns the current state without changing the record.

### Explicit player update

Each edit attempt receives a fresh client-generated `mutationId` from `crypto.randomUUID()`. The ID is an opaque, non-empty string of at most 64 characters, is echoed in edit success/error responses, and is never persisted in the room.

An explicit player Save sends:

```js
{
  t: "updateOwnMarch",
  mutationId,
  pid,
  march,
  baseRevision
}
```

The production UI always takes `pid` from the locally registered profile and does not expose editable PID or name fields after registration. This retains the room's existing lightweight PID trust model: a hand-crafted client can still impersonate a PID because there is no player credential. Adding real player authentication is out of scope.

### Authenticated commander update

An explicit commander Save sends:

```js
{
  t: "setPlayerMarch",
  mutationId,
  password,
  pid,
  march,
  baseRevision
}
```

The server authenticates before revealing player existence or applying validation that could leak room data. A successful commander operation changes only `march` and `marchRevision`; it does not rewrite `name`, `alliance`, `ready`, or `lastSeen`.

### Successful update

For either explicit update path, the server:

1. validates `mutationId`, normalizes the PID, and strictly parses march as an integer number of seconds;
2. checks the player exists;
3. checks `baseRevision` equals the current revision;
4. writes the new march and increments the revision; an `updateOwnMarch` also refreshes `lastSeen`, while `setPlayerMarch` does not;
5. persists once;
6. sends the initiating socket a `playerMarchSaved` acknowledgement containing the same `mutationId`, PID, march, and new revision;
7. broadcasts one full state snapshot.

All other clients use the room snapshot as their update signal. The initiating editor closes only after it has received both the matching `playerMarchSaved` acknowledgement and a room snapshot containing the acknowledged PID, march, and revision. The client handles either arrival order. A broadcast caused by another device can therefore never be mistaken for success of the local pending request.

## Conflict handling

The Durable Object serializes mutations, and `marchRevision` prevents stale requests from silently winning.

If two devices edit revision `8`:

- the first accepted save writes revision `9` and broadcasts it;
- the second save receives `player_conflict` with its `mutationId` and the latest player march and revision;
- the editor retains the unsaved draft and displays the canonical value that arrived from the room;
- the user may adopt the latest value or explicitly confirm another save using the new revision.

A remote broadcast never erases an actively edited, unsaved field or resolves a pending operation without a matching acknowledgement. Outside an active editor, all UI and local storage reconcile immediately.

Ordering rules for other races:

- **Edit before Fire:** Fire snapshots the new march.
- **Fire before edit:** the active command keeps its old snapshot; the edit becomes the value for the next Fire.
- **Remove before edit:** the later edit receives `player_missing`.
- **Edit before remove:** the removal deletes the newly revised record.
- **Remove before stage:** the late stage operation is rejected because the PID no longer exists.
- **Stage before remove:** removal clears that stage atomically.
- **Fire before remove:** the active-command reference blocks removal without clearing staging or deleting the player.

## Client state reconciliation

On every room snapshot, the client must update all canonical consumers together:

- vertical roster rows;
- Sacrifice/Main role slots in every kingdom view;
- staged summaries and Fire enablement;
- the current player's displayed time and edit controls;
- the current player's per-room local storage;
- Defense calculations that read the current player's march;
- local `pickedByK` arrays, pruning missing PIDs while preserving valid PID/role choices.

Name and march snapshots must not remain embedded in local selections as independent render sources. If retaining compatibility fields temporarily is necessary, they must be refreshed from `room.players` before every render and cannot be treated as authoritative.

## Atomic player removal

The server-side remove operation follows this exact transaction boundary:

1. normalize the requested PID;
2. authenticate the commander password;
3. return a benign `player_missing` result without mutation if the player is already absent;
4. build active-command PIDs from unexpired commands only; if referenced, return `player_in_live_command`;
5. remove the PID from every kingdom's staged selections;
6. delete `room.players[pid]`;
7. persist once;
8. broadcast once.

No error path may leave a stage cleared while the player remains, or delete the player while a live command still references them.

Player march updates and removal do not change `room.updatedAt` or `room.updatedBy`; those fields remain the optimistic-concurrency version for configuration publishing only.

## Error behavior

| Error | Client behavior |
|---|---|
| `bad_password` | Clear the cached commander password, close or lock privileged controls, and show the localized password error. |
| `invalid_march` | Keep the editor open and show the 5–180 second requirement inline. |
| `player_missing` | Close stale player controls, reconcile the latest room state, and make no unrelated change. |
| `player_conflict` | Keep the draft, show the latest canonical value and revision, and require adoption or an explicit retry. |
| `player_in_live_command` | Keep the player and all stages unchanged; explain that the active command must finish or be canceled. |
| socket closed / send failure | Keep the draft or confirmation open, mark the operation unsaved, and allow retry after reconnect. |

The client does not interpret an outbound `send()` as success.

Every march-edit success or error response echoes the request's `mutationId`, allowing the client to associate the response with exactly one pending editor.

## Code organization

Implementation must make focused improvements along the changed path without a broad rewrite.

### Server

The room message handler must delegate to small, testable units for:

- march normalization and range validation;
- versioned player-march updates;
- unexpired active-command PID detection, separate from staged PID detection;
- staged-reference removal;
- the atomic removal mutation.

These units must return explicit results rather than mutating UI-oriented state or broadcasting independently. Persistence and broadcast remain controlled at the message-handler boundary so each successful operation performs them once.

### Client

The current large KvK module must separate the responsibilities touched by this feature:

- roster row rendering;
- selection/replacement behavior;
- march editor lifecycle;
- player actions menu and removal confirmation;
- reconciliation of the current player's canonical room record;
- synchronization of PID/role selections with canonical player data.

Existing DOM hooks used by tests must be preserved where they still describe the same element. New controls receive stable `data-pid` and action selectors. No framework migration is part of this work.

### Styling and localization

- Replace the commander's `flex-wrap: nowrap` horizontal roster override with a bounded vertical list.
- Preserve the established KvK visual language and selected/other-kingdom states.
- Add English and Chinese strings for edit, replacement, removal impact, conflicts, validation, pending, and live-command protection.
- Avoid inline production styles and keep component states explicit in CSS classes.

## Security and privacy

- Commander updates and removal are authorized only by the server using the existing room password/master override path.
- Authentication occurs before existence-sensitive commander errors.
- PID and player name are length-normalized according to the room's defensive patterns. March time and revision are strictly parsed and rejected when malformed or outside their allowed ranges; they are never silently clamped into a valid value.
- Ordinary player editing keeps the current PID-based trust level; this design does not claim stronger identity guarantees.
- No new third-party service, game API ingestion, analytics payload, or personal data store is introduced.

## Verification strategy

### Durable Object and protocol tests

- Existing records lazily normalize to revision `0` without data loss.
- Create-only registration cannot overwrite an existing player's march and preserves the 150-player cap plus active/staged eviction protection.
- The existing throttled heartbeat/reconnect path updates `lastSeen` without changing march.
- Explicit player Save changes march, increments revision, persists once, and broadcasts once.
- Authenticated commander Save changes only march/revision and broadcasts to all sockets.
- A successful edit acknowledgement echoes the initiating `mutationId`; unrelated broadcasts cannot resolve another pending editor.
- Wrong-password commander Save reveals no player-specific result and performs no mutation.
- Out-of-range and malformed server values are rejected consistently at 4, 181, non-numeric, fractional, and non-finite boundaries.
- A stale `baseRevision` returns the latest canonical record and does not persist or broadcast.
- Edit-before-Fire and Fire-before-edit produce the required snapshot behavior.
- Removing a staged player clears all kingdom stages and deletes the profile in one persist/broadcast.
- Removing an active-command player performs no mutation.
- An expired command that has not yet been cleared by its alarm does not block removal.
- March updates and removal do not change configuration `updatedAt` or create false configuration conflicts.
- Remove/edit/stage races follow the ordering rules above.
- Inherited-property and normalized-PID protections remain covered.

### Browser behavior tests

- At 375px and 390px, Kimchi, Strategy, and HmL fit in the vertical roster without horizontal roster scrolling.
- Selected rows are first, role badges are unambiguous, and other-kingdom players remain blocked.
- With two selections, tapping HmL offers explicit Sacrifice/Main replacement and never silently shifts the first player.
- Tapping time or `⋯` does not select/unselect the row.
- The `MM:SS` parser rejects malformed input, and `-5`, `-1`, `+1`, and `+5` controls enforce 5–180 seconds.
- A successful update refreshes the roster, role slots, player view, local storage, and other commander devices.
- A remote update outside an editor reconciles immediately.
- A remote update during editing preserves the draft and shows the conflict state.
- Staged removal confirmation lists the affected kingdom/role and leaves every client at the same selection count.
- An online device that observes its own PID transition from present to missing clears its local identity and does not auto-register; an initially missing offline profile may register again on a later connection.
- Active-command removal is disabled in the UI and still rejected by the server if forced.
- More than six players reveals search; more than four visible rows use vertical scrolling.
- Keyboard focus, accessible names, 44px touch targets, and focus return work in English and Chinese.
- Opening a numeric keyboard does not let the sticky Fire dock cover the editor.

### Regression tests

- Lead values 10, 15, 30, and 60 retain the existing personal countdown contract.
- Each captain still receives only their own visible countdown and audio cues against their own `pressUTC`.
- Ordinary-member join audio, cancel, command expiry, Defense, multi-kingdom staging, password handling, and background audio remain green.
- Fire always reads the canonical current march immediately before creating the live snapshot.
- A later march edit cannot reschedule a running countdown or its audio.

### Manual multi-device acceptance

Use at least two different devices or browser profiles in a disposable room:

1. Register three players with different march times.
2. Unlock two commander consoles.
3. Update a player on one commander and verify every other device changes immediately.
4. Reconnect the player's device with an intentionally stale local cache and verify the server value survives and rewrites the cache.
5. Create a simultaneous-edit conflict and verify no silent overwrite.
6. Stage the player in one kingdom, remove them from the other commander, and verify all stages and local selections clear together.
7. Fire a disposable command, verify removal is blocked, then verify a profile edit affects only the next command.

Production room 1406 is not used for destructive automated verification.

## Acceptance criteria

The design is implemented successfully when all of the following are true:

1. The commander roster has no horizontal scroll at 375px or 390px and room 1406's three current players are directly visible.
2. Player selection, role replacement, time editing, and player actions have distinct controls and cannot trigger one another accidentally.
3. Both commanders and players can explicitly save a march time from 5 through 180 seconds.
4. Every successful save appears on all connected devices through the room broadcast.
5. A reconnect with stale local storage cannot change an existing canonical march time.
6. A stale concurrent save cannot silently overwrite a newer revision.
7. Roster rows, role slots, player UI, local storage, Defense inputs, and Fire use the same canonical value.
8. Fire freezes the latest value into the active command, and later edits cannot change the active countdown or audio.
9. A selected or staged player can be removed after an impact-aware confirmation, clearing every staged reference atomically.
10. An active-command player cannot be removed, and failure leaves both the player and stages unchanged.
11. Long rosters remain bounded, searchable, vertically scrollable, bilingual, keyboard accessible, and touch safe.
12. Existing countdown timing, voice reminders, ordinary-member behavior, Defense, and multi-kingdom coordination pass regression verification.

## Implementation guardrails

Before implementation, the project-required GitNexus impact analysis must be run for every existing symbol that will be edited. Exploration identified the roster renderer and current-march calculation path as high-risk areas, so implementation must report those blast radii before modifying them. The GitNexus index must be refreshed first if it remains behind the current player-removal code.

Before any implementation commit, `gitnexus_detect_changes()` must confirm that affected symbols and execution flows match this design's scope.
