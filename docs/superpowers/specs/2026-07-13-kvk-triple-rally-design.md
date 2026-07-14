# Optional Triple Rally for the KvK Command Console

**Date:** 2026-07-13
**Status:** Approved during brainstorming; awaiting review of this written specification
**Scope:** `kingshoter.com/kvk` per-kingdom rally mode, three-captain staging and Fire, personal timing, forced client updates, and QA promotion

## Relationship to existing designs

This design supplements:

- `2026-07-13-kvk-command-simplification-design.md`, which remains authoritative for the selected lead and each captain's personal countdown;
- `2026-07-13-kvk-commander-player-management-design.md`, which remains authoritative for canonical march time, roster editing, explicit replacement, and removal;
- `2026-07-13-kvk-alert-delivery-reliability-design.md`, which remains authoritative for commander silence, ordinary-member audio, delivery truth, QA isolation, and cross-platform promotion.

Double Rally remains the default and its existing two-captain timing contract does not change. This document adds an optional Triple Rally mode; it does not restore the removed counter-rally calculator or anti-rally command path.

## Problem

The command console currently supports exactly one Sacrifice captain and one Main captain per kingdom. Some KvK operations use three coordinated rallies. Treating the third captain as an informal voice-only exception would lose the product's core value: each selected captain receiving a precise personal countdown derived from canonical march time.

The feature must not turn the stable Double Rally path into a generic, higher-risk rewrite. It also must not create a mobile layout that is harder to operate, introduce a stale third selection after returning to Double, or let a page opened before the rollout silently miss an unfamiliar command type.

## Goals

- Keep Double Rally as the default for every existing and new room.
- Let an unlocked commander choose Double or Triple independently for Kingdom 1 and Kingdom 2.
- Persist the selected mode in the room and synchronize it immediately to every connected commander.
- Coordinate two Sacrifice rallies to land together and the Main rally to land one second later.
- Give all three selected captains their existing full personal countdown and advance warning.
- Preserve one generic JOIN alert for ordinary members and silence an unselected commander.
- Force supported stale clients to update automatically without asking the commander to chase individual players.
- Preserve a temporary audio-compatible projection for pages older than the updater bootstrap.
- Validate only in isolated `qa-kvk-*` rooms, then enable the approved build for all operation rooms together.

## Non-goals

- Assigning ordinary members to any of the three in-game rallies.
- Importing live game state.
- Allowing four or an arbitrary number of rallies.
- Letting a commander configure custom landing gaps.
- Changing the Double Rally landing formula, lead choices, cue sequence, or double-tap Fire gesture.
- Adding a separate Triple permission, account system, or alliance role model.
- Reintroducing counter-rally calculations, enemy timers, or a special anti-rally Fire action.
- Testing in any operation room.

## Product decisions

### Per-kingdom persistent mode

The room stores independent mode records:

```js
rallyModes: {
  1: { mode: "double", revision: 0 },
  2: { mode: "double", revision: 0 }
}
```

- A missing, malformed, or unsupported value is read as `double` with revision `0`.
- Changing Kingdom 1 never changes Kingdom 2.
- The mode survives Fire, Cancel, reconnect, browser refresh, and commander handoff until an unlocked commander changes it.
- The server is authoritative. A client does not present a local toggle as saved until it receives the matching acknowledgement and a room snapshot containing that revision.

An authenticated mode change uses an opaque mutation ID and optimistic revision:

```js
{
  t: "setRallyMode",
  mutationId,
  password,
  kingdom: 1,
  mode: "triple",
  baseRevision: 4
}
```

A successful update increments only that kingdom's mode revision, persists once, sends the initiating socket:

```js
{
  t: "rallyModeSaved",
  mutationId,
  kingdom: 1,
  mode: "triple",
  revision: 5
}
```

and broadcasts once. A stale update returns `rally_mode_conflict` with the same mutation ID and the latest canonical mode and revision; it does not silently overwrite a newer commander's choice.

### Explicit command types

- `double_rally` remains valid only with two unique existing captains in the existing `weak` and `main` roles.
- `triple_rally` is valid only with three unique existing captains in the `weak`, `weak2`, and `main` roles.
- Double keeps the production labels `Sacrifice` and `Main`. Triple displays `Sacrifice 1`, `Sacrifice 2`, and `Main`, with equivalent Chinese localization.
- Both command types use the same personal-target, countdown, cue-deduplication, cancel, expiry, map, and delivery-ack engines. Type-specific code is limited to roster cardinality, role validation, target construction, and presentation labels.

The server validates command cardinality, unique PIDs, exact role coverage, player existence, and canonical march range before storing a command. A client-supplied name, cached march, or computed target is not authoritative.

Partial staging remains valid so captains can be selected and pre-warned one at a time. A stage request carries the current `modeRevision`; Double accepts zero through two unique `weak`/`main` pairs, while Triple accepts zero through three unique `weak`/`weak2`/`main` pairs. A stage or Fire request whose mode or revision no longer matches the room returns `rally_mode_conflict` and cannot restore a removed `weak2` role.

### Triple landing formula

For Triple Rally, assign a landing offset to each role:

```text
Sacrifice 1 landing offset = 0 seconds
Sacrifice 2 landing offset = 0 seconds
Main        landing offset = 1 second
```

For each captain `i`, define:

```text
rawPress[i] = landingOffset[i] - canonicalMarch[i]
firstRaw    = minimum rawPress across all three captains
pressUTC[i] = serverNow + selectedLead + rawPress[i] - firstRaw
```

The common five-minute gather duration cancels out of the relative calculation. Therefore:

- the earliest captain's `pressUTC` is exactly `serverNow + selectedLead`;
- both Sacrifice rallies have the same final landing time;
- Main lands exactly one second later;
- different march times produce different personal press times without changing the landing order.

Each captain's numeric and audible countdown remains hidden until their own `pressUTC - selectedLead`, then starts at exactly the selected value: 10, 15, 30, or 60. A captain whose press is later receives the existing staged/prepare warning before their personal countdown, not an artificially extended countdown.

### Immutable Fire snapshot

Triple Fire sends only the selected PID/role pairs, lead, kingdom, and current mode revision:

```js
{
  t: "cmd",
  password,
  cmd: {
    type: "triple_rally",
    kingdom: 1,
    modeRevision: 5,
    payload: {
      leadSeconds: 15,
      pairs: [
        { pid: "1001", role: "weak" },
        { pid: "1002", role: "weak2" },
        { pid: "1003", role: "main" }
      ]
    }
  }
}
```

On acceptance, the server records its current time, reads all three canonical player records, calculates the targets, and freezes:

- PID;
- display name;
- role;
- march seconds;
- personal `pressUTC`;
- common lead and kingdom;
- command type and command ID.

It stores `anchorUTC` and `payload.firstPress` as the minimum computed `pressUTC`, and derives expiry from the latest `pressUTC + 300 + march + 30` seconds. The existing Double request and calculation remain unchanged.

Later march edits, mode changes, role changes, removal attempts, or reconnects cannot move an already-issued target. Mode changes affect the next command only. Active-command removal protection covers every PID in either a Double or Triple snapshot.

## Staging and mode transitions

### Double to Triple

- Preserve the current `weak` captain as Sacrifice 1.
- Preserve the current `main` captain as Main.
- Add an empty `weak2` slot.
- The next valid unselected player fills Sacrifice 2.
- Broadcast the canonical Triple mode and staged roles so all commanders converge immediately.

### Triple to Double

If Sacrifice 2 is filled, the commander receives one concise confirmation naming the player who will be removed from staging. On confirmation, one authenticated server mutation:

1. changes the kingdom mode to Double;
2. removes `weak2` from that kingdom's staged pairs;
3. preserves `weak` and `main`;
4. increments the mode revision;
5. persists once;
6. acknowledges once and broadcasts once.

No client keeps a hidden third selection for later restoration. Cancel and Fire do not automatically reset Triple to Double.

## Commander experience

### Mode control

The current kingdom selector and command setup show a `Triple Rally` switch scoped to the visible kingdom.

- Off means Double; on means Triple.
- The label names the current kingdom so a commander cannot mistake Kingdom 1's mode for Kingdom 2's.
- Only an unlocked commander can change it.
- A pending change is visibly pending and cannot be toggled again until it succeeds, conflicts, or fails.
- The switch follows room broadcasts on every commander device.

### Role presentation and selection

Double retains the approved Sacrifice/Main presentation and behavior.

Triple shows three compact vertical role rows above the vertical player roster:

1. Sacrifice 1;
2. Sacrifice 2;
3. Main.

The vertical layout avoids squeezing three names, march times, roles, and remove controls into a narrow horizontal strip. It never adds horizontal scrolling at 375px or 390px.

Selection rules:

- an empty required role is filled before replacement is offered;
- with all three roles filled, tapping a fourth player opens an explicit chooser naming the captain in each replaceable role;
- no selection is silently shifted or dropped;
- selecting a player already used by the other kingdom remains prohibited by the existing rule;
- a separate role button opens `Sacrifice 1`, `Sacrifice 2`, and `Main`; choosing an occupied role swaps the two captains;
- Triple has no ambiguous global swap button because two Sacrifice roles share one landing time.

Rows and slots render name and march from canonical `room.players[pid]`, not from stale selection snapshots.

### Fire and status

The same double-tap Fire control changes its label between Double Rally and Triple Rally.

Triple Fire is disabled until exactly three unique, existing players occupy all three roles and each has a canonical 5–180 second march time. Readiness/presence retains its current warning behavior and does not invent a command time. Sending on an open socket is not success; the UI waits for server acceptance through canonical state.

The live banner, radar/timeline, staged summary, cancel label, and role receipts show all three captains. Ordinary members still see only one actionable JOIN prompt. The website never tells ordinary members which in-game rally to join.

## Audio audience

- Each selected Triple captain schedules only the cues for their own frozen `pressUTC`.
- Both Sacrifice captains may have different press times even though they land together.
- Main receives their own countdown and lands one second later.
- An ordinary registered member receives one generic JOIN alert for the active command, not three alerts.
- A commander-mode browser whose identity is not selected receives no rally or JOIN audio.
- A commander-mode browser whose identity is selected receives the same personal captain audio as any other selected device.
- Duplicate snapshots, reconnects, compatibility projections, and delivery retries cannot schedule a second GO for the same command ID and PID.

## Forced client update and legacy bridge

### Update controller

The platform adds `GET /api/build` with `Cache-Control: no-store` before Triple is enabled. It returns public, non-secret build metadata:

```js
{
  currentBuild: 2026071302,
  minKvkBuild: 2026071301,
  minTripleBuild: 2026071302,
  tripleEnabled: false
}
```

A small update controller checks `minKvkBuild`:

- on initial page load;
- after WebSocket reconnect;
- when the page returns to the foreground;
- every 60 seconds while the page is active.

When the page is stale, it shows a non-interactive `Updating…` overlay and uses `location.replace()` with the target build in a cache-busting URL. The user is not asked to refresh, and the commander is not asked to identify stale captains.

An active personal countdown is never interrupted solely for an update. The controller reloads immediately after that command is canceled or no future personal cue remains. A freshly loaded page includes `clientBuild=<currentBuild>` in the `/api/ws` query; the Durable Object stores that non-secret value only in the socket attachment, not in the public room snapshot.

### Two-phase rollout

1. Deploy and QA the update controller while Triple remains disabled.
2. Deploy the Triple-capable client/server and pass the complete QA gate.
3. Raise the minimum build and enable Triple for all operation rooms together.

Browser security prevents a server from navigating a page that was opened before any update controller existed and has remained running unchanged. During the finite bootstrap transition, any socket with a missing build or a build lower than `minTripleBuild` receives a compatibility projection of a stored `triple_rally` command as `double_rally` with the same three `pairs`, command ID, and personal `pressUTC` values. The current legacy personal-target logic can therefore still select any of the three PIDs and schedule their cue.

The canonical stored command remains `triple_rally`; only the per-socket legacy snapshot is projected. New clients always receive the explicit type. The bridge is removed only in a later verified release after the updater has covered a full KvK weekend and aggregate connection telemetry records no missing or below-minimum builds for seven consecutive days. Until that gate passes, the compatibility test remains mandatory. The UI exposes no compatibility warning or manual override.

## Error behavior

| Condition | Required behavior |
|---|---|
| Bad commander password | Lock privileged controls and make no mode/stage change. |
| Stale mode revision | Adopt the latest room mode, keep devices converged, and allow a new explicit attempt. |
| Socket closed or send failure | Keep the attempted change unsaved and retryable; never display success. |
| Triple feature disabled | Refuse new Triple staging/Fire and present canonical Double mode. |
| Missing/deleted player | Prune that PID from staging and disable Fire until the role is refilled. |
| Duplicate PID or missing role | Reject Fire without partial command storage. |
| Invalid canonical march | Reject Fire and identify the affected roster row for correction. |
| Active command | Preserve its immutable type, roles, targets, audio, and expiry despite later mode changes. |
| Stale compatibility command | Suppress by command ID and expiry; never replay GO after reconnect. |

## Emergency rollback

A platform-level Triple gate remains off during bootstrap and QA.

When disabled after release:

- the server rejects new `triple_rally` staging and Fire;
- the next authoritative interaction normalizes that room's K1/K2 modes to Double and removes `weak2` from staging;
- existing active Triple commands continue through their frozen countdown or Cancel so rollback cannot create silence mid-command;
- Double Rally remains available;
- the update controller and legacy bridge may remain temporarily because they protect compatibility rather than create rally behavior.

A code rollback must preserve recognition of already-stored active `triple_rally` commands until they expire.

## QA isolation and promotion

All local and production-connected development tests generate unique names matching `qa-kvk-*` and random QA-only credentials. The shared test helper rejects every non-QA room before opening a WebSocket, issuing HTTP mutations, registering a service worker, or navigating a browser test.

There is no room-name-specific `1406` branch. Room `1406`, like every other non-QA room, is an operation room protected by the general QA-only test rule.

After local automation, isolated multi-browser QA, and required physical-device checks pass, the approved build is enabled for all operation rooms together. Triple is not canaried in an operation room and is not promoted platform by platform.

## Test design

### Pure timing and validation

- Missing mode state normalizes to Double without resetting players, staging, or commands.
- Kingdom 1 and Kingdom 2 modes and revisions change independently.
- Triple requires exactly `weak`, `weak2`, and `main`, three unique existing PIDs, and valid canonical march values.
- Multiple unequal march combinations always produce equal Sacrifice landing times and Main exactly one second later.
- The earliest press is exactly `serverNow + lead` for 10, 15, 30, and 60.
- Every personal countdown begins at its own selected lead rather than at the march-difference offset.
- Double target fixtures remain byte-for-byte or value-for-value unchanged.

### Server state and concurrency

- Two commanders receive a successful mode change immediately.
- Concurrent edits from the same base revision accept one and reject the stale one without split state.
- Double-to-Triple preserves `weak` and `main` and creates no hidden player.
- Triple-to-Double removes `weak2` from staged state in the same persist/broadcast transaction.
- Fire snapshots the latest canonical march values; later edits do not change the live command.
- Removing a staged Triple captain clears their role; removing an active Triple captain remains blocked until cancel or expiry.
- Cancel and expiry handle `double_rally` and `triple_rally` without stale state.

### Isolated multi-browser QA

At minimum, independent browser contexts represent:

- commander A;
- commander B;
- Sacrifice 1;
- Sacrifice 2;
- Main;
- an ordinary member;
- an unselected commander-only device;
- a commander who is also a selected captain;
- a second device using one selected captain's numeric Player ID.

The suite verifies:

- real-time per-kingdom mode synchronization;
- explicit fourth-player replacement and role swaps;
- three personal countdowns and one generic JOIN alert;
- unselected commander silence and selected commander personal audio;
- duplicate command/state suppression;
- disconnect, reconnect, cancel, expiry, stale revision, player removal, and active-command immutability;
- three-captain banner, radar/timeline, staged summary, and receipt rendering;
- no horizontal roster or role overflow at 375px and 390px;
- automatic build update and legacy projection without duplicate GO;
- a frozen copy of the pre-updater client still receives all three personal targets through the compatibility projection;
- all existing Double, Defense, multi-kingdom, canonical march, identity, and removal regressions.

### Real-device gate

The complete Triple path is tested in a unique QA room on current supported iOS, Android, macOS, and Windows configurations, including foreground, switching into Kingshot, backgrounding, lock screen where available, reconnect, and audio-route interruption. Browser automation is useful regression evidence but is not a substitute for physical-device audio observation.

## Acceptance criteria

1. Every room defaults to Double unless an unlocked commander explicitly changes that kingdom.
2. K1 and K2 may simultaneously use different modes and every connected commander sees the same canonical state.
3. Double behavior and timing remain unchanged.
4. Triple cannot Fire without three unique canonical players in Sacrifice 1, Sacrifice 2, and Main.
5. The two Sacrifice rallies land together and Main lands exactly one second later for all valid march combinations.
6. Each selected captain's personal countdown starts at exactly the selected lead value.
7. Ordinary members receive one JOIN alert and an unselected commander receives none.
8. Double-to-Triple and Triple-to-Double preserve and clear roles exactly as specified, without hidden selections.
9. Mode, stage, player, and command changes converge across multiple commander devices without silent stale overwrites.
10. An active command remains immutable after mode, role, player, or march changes.
11. Supported stale clients update automatically; the temporary legacy bridge protects pre-bootstrap pages without duplicate audio.
12. All automated tests use `qa-kvk-*`; no test helper contains a special `1406` branch.
13. Local, multi-browser, and physical-device QA pass before one full-platform enablement for all operation rooms.
14. The emergency gate prevents new Triple commands without interrupting an active countdown or disabling Double.

## Implementation guardrails

- Keep target construction in a pure tested helper whose inputs are canonical `{pid, role, march}` records, `serverNow`, and lead.
- Keep Double and Triple protocol validation explicit; do not disguise three captains inside canonical `double_rally` storage.
- Reuse one personal-target/audio engine for both command types and key deduplication by immutable command ID plus target PID.
- Keep per-socket legacy projection outside canonical room storage.
- Do not add another horizontal roster, a fourth role, configurable landing gaps, or ordinary-member vehicle assignment.
- Before editing any existing symbol, run the project-required upstream GitNexus impact analysis and report HIGH or CRITICAL blast radius.
- Before every implementation commit, run `gitnexus_detect_changes()` and verify that affected execution flows match this specification.
