# KvK Roster Tap Reliability and Editable Identity Design

**Status:** Approved for direct implementation under the existing user instruction to execute without another review gate.

## Goal

Make captain selection reliable during live room updates, remove the testing label from Nickname, and let a registered player switch between Player ID and Nickname without changing the internal identity used by staging, countdowns, acknowledgements, or audio delivery.

## Confirmed causes

### Lost roster taps

Every room snapshot calls `renderRoster()`. The current renderer first clears `#roster` and creates new buttons. If a snapshot arrives after pointer-down but before pointer-up, the pressed button is detached and the browser does not synthesize a click. This was reproduced in a generated `qa-kvk-*` room by closing an observer WebSocket between pointer-down and pointer-up.

Cross-kingdom exclusion and full-slot replacement are separate, intentional paths. They already show visible feedback and are not the source of the silent failure.

### Locked identity

The first-registration form already switches in both directions. After registration, the current client deliberately disables both identity buttons, makes the input read-only, and ignores identity values when Save is pressed. Merely unlocking the controls would be incorrect because the existing `pid` is also the room routing key and the bound audio-delivery identity.

## Chosen design

### 1. Keyed roster reconciliation

`renderRoster()` will reuse one `.roster-row` and its child controls for each routing PID. A snapshot updates text, classes, accessibility attributes, handlers, visibility, and order in place. It creates a node only for a new player and removes a node only when that player no longer exists.

This preserves the original button between pointer-down and pointer-up. It keeps native click, keyboard, focus, and mobile scrolling behavior; no synthetic pointer gesture is introduced.

### 2. Immutable routing identity, editable profile identity

`room.players` remains keyed by an immutable routing PID. That key continues to drive:

- staged and live rally targets;
- WebSocket/device binding;
- Classic and Reliable Shadow delivery;
- acknowledgements and personal countdown selection.

The player record gains optional `playerId` profile metadata. `identityMode` determines which editable identity is shown:

- `playerId`: the form shows `player.playerId`, falling back to the legacy numeric routing PID;
- `nickname`: the form shows `player.name`.

Changing modes or values never changes the routing PID. Existing selected slots, active delivery identities, and room-local device IDs therefore remain valid.

### 3. Atomic own-profile update

The client sends one `updateOwnProfile` mutation containing:

- immutable routing `pid`;
- `identityMode`;
- normalized nickname or numeric `playerId`;
- resolved display name;
- march seconds;
- current revision and mutation ID.

The server authorizes the mutation against the PID bound to that WebSocket. It validates all fields and rejects a Player ID already claimed by another player record. It then applies identity and march in one mutation, increments the existing revision, persists, acknowledges the sender, and broadcasts one canonical room snapshot. No optimistic identity change is shown before canonical state arrives.

Legacy records remain readable. New Player ID registrations store `playerId`; nickname records omit it. Registration also checks profile-level Player ID uniqueness so a player whose immutable routing key differs from an edited Player ID cannot be duplicated.

### 4. Bidirectional draft behavior

Edit mode keeps separate drafts for Player ID and Nickname. Switching modes preserves what the user typed in each mode. A restored Player ID draft is looked up again; an obsolete lookup is aborted and cannot populate the current mode. The Nickname button and placeholder contain no “For testing” or Chinese equivalent.

Save is disabled while a profile mutation is pending. On success, the local profile adopts the canonical room player and the form closes. On validation, conflict, disconnect, or unknown outcome, the canonical old profile remains authoritative and the user can retry after reconciliation.

### 5. Audio-delivery invariants

This change does not alter cue timing or audience rules. Because the routing PID is immutable:

- a selected captain remains selected after a profile edit;
- an unselected commander still receives no rally cue;
- the same device binding continues to report readiness;
- Classic and QA Reliable Shadow acknowledgements remain attached to the same target.

## Audio persistence implementation status

The current sound-producing path is Classic: a user gesture starts Web Audio plus a looping media carrier; rally cues are scheduled against the Web Audio clock from server-synchronized target times; visibility/resume handlers reconnect, resynchronize, and reschedule. Device readiness is heartbeated to the server.

Reliable Shadow is QA-only and does not play sound. Web Push, a service-worker backup alert, and a continuous server audio stream are not implemented. Code has no fixed expiry while the page process and audio session remain alive, but a web page cannot guarantee survival after operating-system suspension, discard, process termination, whole-device sleep, or audio-focus takeover. “Received” proves that the exact command reached the bound browser and future cue nodes were scheduled; it does not prove that the speaker later emitted sound or that a person heard it.

## Error handling

- Invalid Player ID, nickname, march, mutation ID, or revision: reject without mutation.
- Player ID owned by another routing PID: reject as a profile conflict and keep the old identity.
- Socket PID does not match the requested routing PID: reject as `core_identity_mismatch`.
- Persistence failure: restore the prior player record and return an error; do not broadcast partial state.
- Disconnect after send: reconnect, compare the canonical player/revision, and either settle the mutation or present retry without duplicating it.

## Verification

1. A trusted pointer-down, intervening room broadcast, and pointer-up still selects the player and persists staging.
2. Normal click, keyboard activation, search, sort, role swap, full-slot replacement, cross-kingdom exclusion, march edit, and removal remain intact.
3. New and existing profiles switch Player ID → Nickname → Player ID and Nickname → Player ID → Nickname while preserving both drafts.
4. Two browser pages in one generated QA room immediately receive a successful identity/march update and show only the canonical profile.
5. Duplicate Player ID, stale revision, spoofed socket PID, disconnect, and persistence failure leave the old canonical profile intact.
6. A selected captain's audio/device routing key remains unchanged across profile edits.
7. All existing unit, protocol, roster, multi-browser, Triple Rally, and QA delivery tests remain green.

## Out of scope

- No production deployment or non-QA room test.
- No change to rally timing, lead-time semantics, audience rules, or countdown audio.
- No promise of indefinite browser audio delivery under OS suspension.
- No Push, service worker, native app, or continuous audio-stream implementation in this change.
