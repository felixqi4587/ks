# Rally / Defense Separation and Voice Defense Coordination Design

**Status:** Approved.

## Summary

Kingshoter will expose two separate battle-coordination products:

- `/rally?room=<room>` coordinates Double or Triple Rally captains.
- `/defense?room=<room>` coordinates a large group of castle defenders through personal voice timing.

The existing static Defense calculator will be removed from the Rally product. Rally and Defense will share proven infrastructure and visual language, but their rosters, presence, commands, delivery state, and audio routing will be isolated. A Defense command is created by a human defense manager watching the game. Automation from `gameauto` is explicitly deferred.

The website never receives live game state. It can report that a website order reached a connected device and that the device scheduled its audio; it must never claim that a player actually reacted, clicked in the game, marched, or reached the castle.

## Goals

1. Keep the current Rally workflow stable while removing the unrelated static Defense experience from it.
2. Give defenders the same proven personal countdown and background-audio experience used by Rally captains.
3. Let one defense manager create a shared timing anchor with a single click while every successfully delivered profile derives its own personal GO time.
4. Support rooms with dozens of defenders without putting a room-wide roster on the ordinary-player page.
5. Reuse the existing clock, connection, profile, audio, delivery, typography, and mobile interaction foundations instead of creating a second implementation.
6. Preserve existing shared links through a silent `/kvk` compatibility redirect while making `/rally` the only canonical attack route.

## Non-goals

- Reading or receiving live Kingshot game data.
- Proving that a player responded to an alert or acted in the game.
- Tracking the enemy's second rally. The first version uses only the earliest incoming enemy rally as the tactical anchor.
- Running overlapping Defense orders. The room can have only one live Defense order.
- Repairing a defense manager's missed anchor window. The manager is responsible for clicking when the game shows the configured value.
- Automatically triggering Defense from `gameauto`, OCR, an AI model, or an emulator.
- Adding a third Timing tab to the manager interface.
- Building a global project-administrator page, room registry, retention policy, or project-wide cleanup tooling.

## Product surfaces and routing

### Canonical routes

- `/rally` replaces the current `/kvk` coordination surface.
- `/defense` is the independent Defense surface.
- Both accept the existing room query convention, for example `/rally?room=qa` and `/defense?room=qa`.
- Direct Rally and Defense navigation recognizes `room`, `lang`, `notour`, and the surface's current build-gate parameter.

### Legacy route

`/kvk` and `/kvk.html` become compatibility-only routes. The redirect preserves `room`, `lang`, and `notour`, maps legacy `__kvk_build` to `__rally_build`, drops unknown parameters, and redirects to `/rally`. It does not render an old page, create a third product mode, or appear in generated links, navigation, copy, analytics names, or canonical metadata.

The Rally implementation and user-facing coordination copy are renamed accordingly. Legacy migration tests and the redirect rule are the only intentional places where the old route name remains.

### Homepage entry

The current homepage card structure and typography remain recognizable. The former single KvK coordination card is replaced by two same-level battle-tool cards:

1. **Rally Coordination** — Double or Triple Rally captain synchronization.
2. **Defense Coordination** — personal voice timing for a large defender group.

Selecting a card opens that product's existing-style room entry. The room input component is shared, but it connects to the selected product's isolated data channel. Direct room links bypass this choice.

## Separation and shared foundations

### Isolation boundary

Rally and Defense use the same room name and room-level management password, but they do not share operational state.

The room authority stores separate namespaces:

- Rally keeps its existing player roster, staged captains, rally mode, commands, delivery state, and presence.
- Defense owns a separate defender roster, Defense presence, persistent manager configuration, active Defense order, cancellation revision, and delivery acknowledgements.

Every WebSocket connection identifies its surface as `rally` or `defense`. Initial snapshots and subsequent broadcasts are filtered by surface. A Defense profile, presence change, order, cancellation, or acknowledgement must never appear in a Rally snapshot or cause Rally audio. The same rule applies in the opposite direction.

Keeping the namespaces under the existing room authority allows both products to use the same password hash without duplicating or synchronizing passwords. It does not permit their runtime state to mix.

### Shared modules

The Defense page does not load or fork the large Rally controller. Reusable behavior is extracted into focused shared modules and used by both pages:

- room entry, query parsing, and room normalization;
- WebSocket connection, reconnect, and server-clock synchronization;
- Player ID / nickname identity and march-time validation;
- audio unlock, test sound, AudioContext health, keep-alive, and green-light truth;
- absolute-time cue scheduling, cancellation, rescheduling, and clock-drift handling;
- the existing ten-second beeps, final five-second spoken countdown, and `Now` cue;
- delivery acknowledgement primitives;
- shared mobile cards, form controls, typography, colors, focus behavior, safe areas, and zoom-safe input sizing.

Each product has a small surface-specific controller that converts its own server state into a cue plan. Shared modules do not contain Rally roles or Defense timing policy.

## Removal of the current Defense module

The following behavior is removed from Rally:

- the Attack / Defense view switch;
- the static Defense rehearsal page and radar playback;
- fixed five-minute enemy-gather calculations;
- the commander enemy-whale editor and publish control;
- Defense-specific state, translations, animation, CSS, and client event hooks;
- the visible use of `room.config.enemyWhales`.

The Rally page remains responsible only for staging and launching Double or Triple rallies. The old Defense client code is deleted rather than hidden. Legacy Defense configuration is ignored during migration and removed from the canonical schema after the minimum client-build gate prevents old clients from writing it.

Removal and the new Defense launch occur in the same production release after QA. There is no interval in which the old module is removed before its replacement is ready.

## Defense roles and ordinary-player flow

### Ordinary defender

An ordinary defender performs the same small setup expected on Rally:

1. Enter a Player ID or nickname.
2. Enter the march time from the player's current location to the castle.
3. Enable and test page alerts through the existing browser-required user gesture.
4. Keep the page open and wait.

When the same device already has a valid Rally identity and march time for the room, the shared profile layer prefills those values on Defense. The player may confirm or edit them before Defense registration; the products do not silently create a Defense profile merely because a Rally profile exists.

There is no separate “join this round” button. A valid registered Defense profile is automatically eligible for future Defense orders while its Defense page is connected. After each order completes or is cancelled, the profile automatically returns to waiting for the next round. Identity, march time, and audio state are retained.

A player registered after an order is accepted is not added retroactively. That player waits for the next order. A player who was already captured in the accepted order may refresh or reconnect and restore a still-future cue, because the order contains an immutable audience snapshot.

### Defense-only manager

The Defense console can be unlocked without creating a defender profile. A management-only device receives the silent room overview and never receives personal beeps, countdown speech, vibration, or `Now` solely because it is a manager.

If the same device also has a valid defender profile captured in the order, it behaves as both manager and defender and receives only that profile's personal cue.

## Timing model

### Manager inputs

The defense manager maintains two persistent, room-wide values:

- **Tap anchor:** the enemy gather countdown value at which the manager will click. Default `3:00`; accepted range `0:05–5:00`.
- **Enemy march:** the time from enemy rally launch to castle impact. Accepted range `0:05–2:00`.

Both values use a compact `MM:SS` control, are revisioned, broadcast to all Defense pages, and persist across rounds until a manager changes them. The primary action label includes the configured anchor, for example `Tap when enemy rally shows 3:00`.

### Signal and calculation

When the game countdown reaches the configured anchor, the manager single-taps the primary button. The manager client captures a click timestamp using the same server-synchronized clock used by Rally. The server verifies freshness and clock bounds, accepts one unique mutation, and creates the authoritative Defense order.

For an accepted order:

```text
enemyLaunchUTC = signalUTC + tapAnchorSeconds
enemyImpactUTC = enemyLaunchUTC + enemyMarchSeconds
defenderGoUTC  = enemyImpactUTC - defenderMarchSeconds
```

The system adds no artificial post-impact offset. Scheduling a theoretical same-time arrival lets the defender's natural reaction to the voice cue produce the desired practical arrival roughly `0.5–1.0` seconds after the enemy impact. The UI does not claim subsecond game certainty because the website cannot see the game or measure the user's reaction.

### Immutable order snapshot

The accepted order freezes:

- order ID and revision;
- signal time;
- tap anchor and enemy march values;
- calculated enemy launch and impact times;
- the set of valid registered Defense profiles with a live Defense connection at acceptance;
- each captured profile's Player ID or nickname display record, march time, and profile revision.

Changing a player march time or manager setting during an active order affects the next order only. Active settings are locked in the UI. This prevents countdowns from jumping between devices.

### Personal audio

Each captured device that receives and accepts the order derives and attempts to schedule its cue locally from `defenderGoUTC` through the shared audio scheduler:

- at `GO − 15s`, play the existing preparation warning;
- beginning at `GO − 10s`, play the existing beep sequence;
- during the final five seconds, play the existing spoken countdown;
- at `GO`, play only `Now`.

Defense does not introduce `Defend now` or a second set of media assets. The cue files, playback graph, background keep-alive, cancellation path, and scheduling implementation are the same ones used by Rally.

If `defenderGoUTC` is already past when the order is accepted, that captured profile is marked `Too late` for the website order and receives no partial countdown. There is no missed-anchor recovery control for the manager and no retroactive cue for a new defender.

## Defense order lifecycle

### Accepting an order

The primary button is available only when:

- the manager session is authenticated;
- the Defense connection is live;
- server-clock synchronization is fresh;
- both timing inputs are valid;
- no Defense order is active.

On the first valid click, the client disables the action immediately and sends a unique mutation ID. The server accepts at most one active order. If two managers click concurrently, the first accepted mutation wins; every manager receives the canonical active order, and later attempts are rejected idempotently without creating a second cue set. No manager can create the next order while any captured profile still has a future `Now` cue. To replace a live order, a manager must cancel it, receive the canonical cancellation, and then create a new order.

### Delivery acknowledgement

A captured client that receives an order attempts local scheduling and then reports an acknowledgement containing the order ID, profile ID, calculated GO time, current audio readiness, clock freshness, and whether the cue was successfully scheduled. Absence of an acknowledgement remains unconfirmed; the server does not infer success. A profile can have more than one connected delivery device. Manager headline counts deduplicate by profile: a profile is Delivered / scheduled when at least one of its captured devices acknowledges successful scheduling. Device-level details may be inspected without inflating the profile total.

Manager labels use only website-verifiable terms:

- **Targeted profiles** — connected profiles captured in the order snapshot;
- **Delivered / scheduled profiles** — targeted profiles for which at least one device acknowledged receipt and local cue scheduling;
- **Audio-ready profiles** — delivered profiles with at least one acknowledged green device;
- **Red / unconfirmed profiles** — targeted profiles for which reliable website delivery cannot be asserted;
- **Offline roster profiles** — saved profiles that were not connected and therefore were not targeted by this order;
- **Too late** — captured profiles whose calculated GO time had already passed.

The interface never calls these numbers “participants,” “responded,” “sent,” “defending,” or “arrived.” It explicitly states that website delivery is not game-action confirmation.

### Cancellation and completion

An authenticated manager can cancel an active Defense order. Cancellation creates a higher revision and is broadcast immediately. Clients cancel every not-yet-played cue associated with the earlier revision. Player profiles, march times, audio state, manager settings, and next-round readiness remain intact.

The room deliberately accepts one live Defense order at a time. The order automatically completes one second after the latest non-Too-late `defenderGoUTC` in its frozen audience; if no profile has a future GO, it completes three seconds after acceptance. All profiles then return to waiting for the next order without additional input. A completed or canonically cancelled order releases the fire lock and cannot be resurrected by stale reconnect messages. Overlapping Defense cycles are out of scope.

## Player interface

The Defense player page deliberately does not render the room roster.

### Waiting state

The mobile page preserves Rally's reading order and visual language:

1. compact room connection and clock status;
2. the player's identity and march-time card;
3. the existing one-line audio-ready state;
4. a personal timing card with the player's progress bar;
5. a waiting area explaining that the next order will create the personal countdown;
6. the collapsed Defense console entry.

Only the current player's progress bar is rendered. Whether the room has eight or eighty registered profiles does not change the ordinary page height.

### Active state

When a captured order is active, the personal waiting region becomes the same type of large personal countdown used by Rally. It shows the current phase, remaining personal time, beeps, final spoken countdown, and `Now`. It does not show or speak other defenders' times.

## Manager interface and large rosters

The Defense console uses the same card, type, spacing, input, drawer, and mobile conventions as the Rally console. It has only two tabs.

### Status tab

Before an order, Status shows:

- registered-profile count;
- current audio-ready, red, offline, and invalid-time counts;
- an exception-first list rather than the complete roster;
- march-time distribution bands.

After an order, the same tab shows:

- the website's expected enemy-impact time and the inputs used to derive it;
- delivered / scheduled, audio-ready, red, offline, unconfirmed, and Too-late counts;
- the next website alert wave and its local countdown;
- compact upcoming alert-wave groups;
- the persistent disclaimer that this is a website schedule, not live game confirmation;
- the Cancel Defense Order action.

### Players tab

Players provides the complete management roster through:

- two-column compact cards on supported mobile widths;
- search by Player ID or nickname;
- filters for ready, red, offline, invalid, unconfirmed, and Too late;
- sorting by march time while waiting and by scheduled GO time during an active order;
- virtualized rendering so off-screen cards do not consume layout work;
- click-to-open details rather than permanent action buttons on every card;
- manager edit-march and confirmed remove-player controls using the same revision/conflict rules as Rally.

During an active order, a card may display the frozen order march time and scheduled GO time. Editing the canonical profile clearly states that the change applies next round.

## Connection, audio, and truth rules

The existing measurable green-light model is reused rather than redefined. A Defense device can be green only when its browser has completed the required user gesture, audio is running, the keep-alive path is healthy, the WebSocket is connected, and clock synchronization is fresh according to the shared readiness implementation.

The browser cannot prove speaker volume, operating-system delivery, human attention, or game action. The UI therefore treats green as the strongest website-verifiable readiness state, not a claim about the game.

If a captured device reconnects before its personal GO:

- it receives the canonical order snapshot;
- it verifies that its profile was captured;
- it cancels stale local scheduling for that order ID;
- it schedules only still-future cues;
- it sends a fresh delivery acknowledgement.

If clock synchronization changes materially, the shared scheduler performs the same cancel-and-replan operation. Order and cue IDs make the process idempotent so `Now` cannot be played twice for one revision.

## Scale and performance

Defense is designed and tested for at least 100 simultaneous connected devices in one room.

- The server broadcasts an accepted order and state changes, never a per-second room countdown.
- Each browser calculates and paints its own countdown from absolute server time.
- Initial Defense state must be a Defense-only snapshot containing no Rally roster, presence, staged roles, commands, or acknowledgements; frequent presence, acknowledgement, and profile changes use bounded incremental messages rather than rebroadcasting unrelated state.
- Manager aggregates are maintained from website connection and acknowledgement state.
- The complete roster is rendered only in the manager Players tab and is virtualized.
- The ordinary player page performs constant-size rendering independent of room size.
- Delivery acknowledgements are deduplicated by order ID, revision, and profile/device identity.
- Heartbeats are rate-limited and never trigger room-wide per-second payloads.

The capacity test measures connection stability, accepted-order fan-out, acknowledgement convergence, reconnect behavior, memory, payload size, and manager-list responsiveness. Passing requires no duplicate order or duplicate `Now` cue.

## Validation and error behavior

- Invalid Player ID, nickname, or march time prevents Defense registration.
- Missing march time appears as an issue and cannot produce a personal order.
- Invalid manager time inputs prevent save and fire.
- A stale config revision preserves the manager's draft and requires an explicit retry against the latest canonical values.
- A disconnected or unsynchronized manager cannot fire.
- A manager who misses the configured game countdown receives no alternate correction workflow.
- An active order locks the captured inputs. A mistaken order is cancelled, not edited in place.
- Red, offline, unconfirmed, and Too-late profiles remain visible to the manager with precise website-state wording.
- Names are escaped, long names truncate, duplicate nicknames retain distinguishing markers, and status is never conveyed by color alone.

## Migration and rollout

1. Create a Git/GitHub restore point for the current production source and deployed behavior.
2. Add focused tests around the current Rally timing and audio behavior before extraction.
3. Extract shared connection, clock, identity, audio, and cue-scheduler modules without changing Rally output or cue timing.
4. Move the canonical attack surface and assets to Rally naming and add parameter-preserving legacy redirects.
5. Add the isolated Defense namespace, protocol, page, and manager console.
6. Remove the old static Defense client, styles, copy, view switch, and configuration editor.
7. Advance the minimum client build so stale pages refresh into the canonical routes and protocols.
8. Validate only in room `qa` first, using the existing QA room/password convention and multiple real browsers/devices.
9. Run the full local, integration, browser, scale, and device matrix.
10. Deploy all ordinary rooms only after QA passes; run production smoke checks that do not issue real battle orders in operational rooms.

Implementation commits keep shared-module extraction, route migration, Defense protocol/UI, and old-module removal separable so a regression can be reverted without discarding unrelated work. A critical Rally timing, audio, routing, or delivery regression triggers rollback to the restore point.

## Test plan

### Unit tests

- anchor, enemy-launch, impact, and personal-GO formulas;
- minimum and maximum accepted times;
- same-time theoretical arrival with no added offset;
- Too-late calculation;
- immutable audience and march snapshots;
- config and order revisions;
- duplicate mutation and concurrent-manager idempotency;
- cancellation, completion, stale message rejection, and reconnect planning;
- equivalence of the shared media assets and scheduler/cancel/reschedule primitives while keeping Rally and Defense cue policies surface-specific;
- escaping, duplicate-nickname labels, filters, sorting, and time grouping.

### Integration tests

- same room name and management password across both surfaces;
- separate Rally and Defense rosters, presence, commands, and acknowledgements;
- no cross-surface visual update or sound;
- persistent Defense settings and next-round readiness;
- active-order edits affecting only the next round;
- a new profile waiting for the next order;
- a captured reconnecting profile restoring only future cues;
- cancellation stopping outstanding audio without clearing profiles or settings;
- parameter-preserving `/kvk` to `/rally` redirects.

### Browser and UI tests

- ordinary waiting, personal active countdown, manager-only silent view, and manager-plus-defender view;
- Status before and after an order;
- Players search, filters, sort, edit, remove confirmation, and virtual scrolling;
- 320, 375, 390, and 430 pixel mobile widths;
- no horizontal overflow or input-focus zoom;
- long names, duplicate names, English and Chinese copy, reduced motion, and accessible text status;
- no legacy Defense controls or KvK coordination links remain visible.

### Scale tests

- at least 100 simultaneous Defense WebSocket clients;
- one accepted manager order fanned out to the captured audience;
- acknowledgement convergence and manager aggregates;
- staggered disconnects and reconnects;
- two concurrent managers;
- no per-second server countdown fan-out;
- no duplicate accepted order, scheduled cue, or `Now` event.

### Device and audio tests

- iOS Safari and Android Chrome with the game foregrounded after audio enablement;
- macOS and Windows desktop browsers;
- foreground, background/tab switch, reconnect, clock correction, cancellation, and repeated rounds;
- exact reuse of the fifteen-second warning, ten-second beep phase, final five-second spoken countdown, and `Now`;
- visible readiness and acknowledgement state consistent with measurable device state.

## Acceptance criteria

The design is complete when all of the following are true:

- Rally is canonical at `/rally`; old `/kvk` links silently redirect with parameters preserved.
- Rally contains no static Defense UI or behavior.
- Defense is available at `/defense` with an isolated roster, presence, order, and delivery protocol.
- Ordinary defenders enter identity and march time once, enable alerts, and automatically wait for every future round.
- A manager can configure the anchor and enemy march, click once at the game countdown, see website delivery/scheduling results, and cancel without clearing setup.
- Every successfully delivered / scheduled profile derives its personal cue from the same canonical impact time and shared audio scheduler; red or unconfirmed profiles remain explicitly visible to the manager.
- Manager-only devices remain silent.
- No label or metric claims knowledge of real game participation or response.
- The manager UI remains usable with at least 100 connected devices, while the ordinary page remains constant-size.
- Rally and Defense pass the complete isolation, timing, audio, browser, scale, and real-device QA matrix before production rollout.

## Deferred automation

`/Users/ff/Documents/gameauto` contains useful foundations: ADB screen capture, continuous frames, deterministic OCR, countdown parsing, template recognition, and input control. It does not yet contain validated KVK incoming-rally regions, a production Kingshoter event client, robust observer recovery, or real-battle timing evidence.

Future automation receives a separate design. It should first run in shadow mode on a dedicated emulator, compare its predicted signal to the human manager, and never fire. Deterministic OCR should read the countdown; an AI model is not used for exact timing. Automatic triggering is considered only after real or recorded KVK trials demonstrate zero false triggers and misses at the agreed sample size, acceptable timing error, duplicate suppression, observer heartbeats, signed narrow-scope events, and immediate human fallback.
