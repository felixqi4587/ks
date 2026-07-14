# KvK Alert Delivery Reliability, Device Identity, and Background Experiments

**Date:** 2026-07-13
**Status:** Approved during brainstorming; awaiting review of this written specification
**Scope:** `kingshoter.com/kvk` identity entry, rally-audio audience, delivery truth, cross-platform backup experiments, background-audio experiments, and validation

## Relationship to existing designs

This document complements `2026-07-13-kvk-commander-player-management-design.md`. That design remains authoritative for canonical march time, commander overrides, vertical roster selection, and player removal.

The later `2026-07-13-kvk-triple-rally-design.md` adds an optional three-captain command while preserving the delivery and audio-audience rules in this document.

This document preserves the personal-countdown contract in `2026-07-13-kvk-command-simplification-design.md`:

- a selected lead time of 10 seconds means the selected captain's personal countdown starts at 10;
- Main and Sacrifice each receive their own countdown based on their own frozen command timing;
- ordinary members receive one generic join alert and are not assigned to a rally by the website;
- the removed counter-rally calculator and anti-rally command path stay removed.

This document supersedes any earlier wording that implies a browser page can guarantee six hours, or any other fixed duration, of background execution. A browser may keep working for an entire battle, but the product must report observed health rather than promise a duration the operating system does not contractually provide.

## Executive decision

The current Classic alert path remains the production default and the rollback baseline.

Three newer ideas are candidates, not promised production features:

1. Reliable delivery metadata and direct command acknowledgement.
2. Optional Web Push backup alerts.
3. A server-injected continuous Battle Audio Stream.

The candidates are first implemented in a hidden lab or shadow mode and tested against Classic. They do not automatically become visible website features. A candidate graduates only when real-device evidence shows a clear reliability improvement without making countdown timing, usability, battery use, data use, or maintenance materially worse. A candidate that is unstable, redundant, or not clearly better is removed rather than preserved behind a permanent flag.

Promotion may be capability-scoped. A candidate that is clearly better on a verified Android configuration, for example, may remain disabled everywhere else. Platforms outside the promoted scope continue using Classic and must not inherit extra setup or risk. A platform-specific branch is still rejected when the branching and maintenance cost outweigh its measured benefit.

This is the project's less-is-more rule: production exposes the smallest proven solution, not every experiment that was built.

## QA isolation rule

Every room whose name does not begin with `qa-kvk-` is an operation room. No automated or manual development test may use an operation room to:

- create, update, or remove players;
- stage captains;
- send Fire, Cancel, practice, sound-test, or delivery-test commands;
- register Push subscriptions;
- run background-audio experiments;
- change room configuration or march times.

Automated production smoke tests must create a unique room whose name begins with `qa-kvk-`, for example `qa-kvk-20260713-7f3a`. Test harnesses must abort before connecting or mutating when the room name does not match the QA prefix. No individual operation room receives a special-case branch. Local development remains the first validation environment; an isolated production QA room is used only after local tests pass.

## Problem statement

### Commander hears audio when not participating

The current client deliberately gives every registered non-captain a generic join countdown. Commander mode is not excluded, and the browser test explicitly asserts that an unselected commander receives the shared JOIN countdown. The result conflicts with the approved operating rule: a commander device must be silent unless that same identity is selected as a captain.

### Existing green and red indicators describe different facts

The current page has multiple unrelated indicators:

- the top connection dot reflects a WebSocket open/close event;
- roster presence reflects a persisted heartbeat timestamp;
- the audio indicator reflects `soundReady` and a running `AudioContext`.

None proves that a particular device received a particular Fire command. A device can receive and pre-schedule audio, then later turn red when its heartbeat becomes stale; the already-scheduled audio can still play. The inverse is also possible: an indicator can remain green while a network path, media carrier, or operating-system audio output has failed.

### Player ID is currently the only identity input

The current form strips non-digits, queries the official Kingshot endpoint by numeric Player ID, and uses that ID as the routing key throughout players, staging, commands, removal, readiness, and personal audio matching. The official endpoint cannot reverse-lookup a nickname.

Using a nickname directly as the routing key would merge duplicate names, break renames, enable incorrect removal, and risk sending personal audio to the wrong device.

### Background duration has no fixed cross-platform contract

The existing media bed, Media Session, Web Audio clock, periodic resume attempt, heartbeat, and clock synchronization improve survival. They do not prevent browser freezing, page discard, process termination, operating-system memory pressure, whole-device sleep, network loss, phone-call interruption, or another app taking audio focus.

An iOS Dynamic Island or lock-screen media indicator proves that the operating system still recognizes a media session. It does not prove that page JavaScript, a WebSocket, or a future command handler remains alive.

## Goals

- Preserve current countdown timing and the current Classic engine as the production baseline.
- Silence rally audio on a commander-mode device unless that device's player identity is a selected captain.
- Keep the selected captain's personal countdown and the ordinary member's single generic join alert.
- Offer Player ID as the default, recommended identity and nickname as a convenient browser-local testing identity.
- Make `Received` mean that the target device acknowledged the exact command and successfully scheduled its personal cues.
- Separate current live-channel health from historical receipt of a command.
- Test Reliable delivery, Web Push, and Battle Audio Stream candidates without exposing unproven complexity to normal users.
- Validate multiple isolated browser sessions and multiple devices without touching any operation room.
- Retain a fast rollback to Classic if a promoted candidate regresses.
- Keep private device and Push data out of public room snapshots.

## Non-goals

- Claiming that a website, PWA, Push provider, SMS provider, or native notification can guarantee human hearing.
- Claiming a fixed background lifetime such as six hours.
- Building an iOS, Android, Windows, or macOS native companion in this iteration.
- Adding SMS, automated calls, WhatsApp, Telegram, or Discord command delivery in this iteration.
- Adding accounts, nickname recovery, automatic nickname merging, or identity verification.
- Tracking which ordinary member joins which in-game rally.
- Blocking Fire merely because optional Backup alerts are disabled.
- Showing a four-mode selector or an engineering diagnostics dashboard to normal players.
- Rewriting the frontend framework or broadly restructuring unrelated KvK code.

## User-visible invariants

These rules hold regardless of which candidates survive testing:

1. Selecting a 10-second lead produces a 10-second personal countdown.
2. Main and Sacrifice retain their current individual timing behavior.
3. No candidate may add a second countdown, duplicate GO, or delayed stale GO.
4. A commander-mode device that is not selected is silent during rally orders.
5. A commander-mode device that is selected receives its personal captain countdown.
6. An ordinary member receives only the existing generic join alert.
7. Test Sound remains user-initiated and may play regardless of battle role.
8. Optional Backup alerts never block Fire and never create a commander warning when disabled.
9. Current behavior remains the fallback whenever a candidate is unavailable or disabled.
10. Normal players are not asked to understand delivery engines or choose among experiments.

## Identity design

### Entry mode

`Your info (just once)` gains a simple two-option selector:

- `Player ID — Recommended`, selected by default;
- `Nickname — For testing`.

Player ID mode keeps the numeric input and the official Player ID-to-name lookup. Nickname mode accepts a display nickname and does not call the official lookup.

### Player ID lookup correctness

The lookup is draft-bound:

- changing the input or switching modes clears any prior resolved name;
- an in-flight lookup is aborted or superseded by a monotonically increasing request sequence;
- a result is accepted only when it matches the current numeric input;
- Save cannot bind a name returned for an older Player ID.

### Nickname routing identity

Nickname is a display value, never a map key.

The browser generates a cryptographically random room-local routing key and stores it with the nickname. Two browsers entering the same nickname create two different players. Duplicate display names are allowed; the commander roster adds a short, non-sensitive key suffix only when needed to distinguish duplicates.

Nickname normalization trims and collapses whitespace, removes control and bidirectional-control characters, and applies a short Unicode code-point limit. A purely numeric nickname remains valid when the user explicitly chose Nickname mode.

### Cross-device meaning

- The same numeric Player ID may be used on multiple devices and represents one player.
- Each browser has an independent random `deviceId`.
- All online, sound-enabled devices for a selected Player ID may receive and acknowledge that player's personal command.
- Nickname identities do not merge across devices. A player who needs a shared cross-device identity uses Player ID.

The first implementation may preserve the protocol field name `pid` as the routing key to avoid a high-risk migration, while documenting that nickname-mode values are opaque routing keys rather than game IDs.

### Removal and canonical march integration

The prior player-management specification remains authoritative:

- server state is the canonical march value;
- player and commander updates broadcast immediately to every connected browser;
- reconnect does not overwrite a newer server value with stale local storage;
- removal clears the player's online room identity and disables private delivery bindings for that room;
- an offline removed browser may register again later because removal is cleanup, not a ban.

## Device model

A private device record may contain:

- room routing key / Player ID;
- random `deviceId`;
- coarse platform and browser capability flags;
- last live-channel round trip;
- current audio-armed observation;
- continuous stable-since time;
- optional Push subscription and last test result;
- recent per-command acknowledgement status.

Private device details are not copied into the public `room.players` object. Public state contains only the minimal aggregate needed by the user interface, such as device count or per-command `Received 1/2`. Push endpoints, authorization secrets, VAPID material, and full user-agent strings are never broadcast.

## Audio audience contract

| Device situation | Rally audio behavior |
|---|---|
| Selected captain, normal player view | Personal captain countdown |
| Selected captain, commander mode unlocked | Personal captain countdown |
| Ordinary registered member | One generic join countdown |
| Commander mode unlocked, identity not selected | No rally countdown or join countdown |
| Unregistered commander-only browser | No rally audio |
| Explicit Test Sound | Plays because the user requested it |

Audience is evaluated per device. This matters when one Player ID is open on two devices and only one is in commander mode.

## Delivery truth model

The normal UI uses plain language; the underlying model keeps facts separate.

### Before Fire

`Armed` means the device recently demonstrated a working live round trip and reported a usable audio engine. It predicts current readiness but does not claim receipt of a future order.

An Armed observation is a short lease, not a permanent flag. Candidate testing may use a roughly three-second check interval for selected captains and expire the observation after roughly eight seconds, but final timing is chosen from measured battery and reliability data.

### After Fire

- `Sent`: the server created the command.
- `Received ✓`: at least one target device received this exact `commandId` and successfully scheduled its personal future cues.
- `Received 1/2`: one of two currently associated devices acknowledged.
- `No confirmation`: no target device acknowledged within the tested response window.
- `Expired`: the command arrived after its useful audio window and no stale GO was played.

`Received` remains true for that command's lifetime even if the live channel later disconnects. Current connectivity is then shown separately, because “this command was received” and “the device is online now” are different facts.

WebSocket readyState, Media Session presence, Push-provider acceptance, and AudioContext state alone never produce `Received ✓`.

## Classic baseline

Classic is the current state-snapshot WebSocket broadcast plus the current personal AudioContext scheduling model. It remains production default while candidates are evaluated.

Necessary shared corrections may apply to Classic without changing its timing engine:

- commander audience suppression;
- identity-mode support;
- exact command acknowledgement for truthful status;
- tests that protect the selected lead-time contract.

Classic does not need a visible mode selector. Its rollback availability is operational, not another decision imposed on players.

## Reliable delivery candidate

Reliable delivery initially runs in shadow mode and does not control production sound.

Its candidate protocol is additive:

1. A browser introduces its routing key and `deviceId` on the room connection.
2. Selected captain devices perform a short live-channel challenge and response.
3. Fire still persists and broadcasts the current room command for Classic compatibility.
4. The server may additionally send a small target-specific command containing `commandId`, absolute server timestamps, role, frozen march timing, lead, and expiry.
5. The client deduplicates by `commandId`, schedules only future cues, and acknowledges the result.
6. The server may retransmit the same immutable command ID while unconfirmed. A retry never changes `fireAt` and never creates a second countdown.

No acknowledgement automatically cancels, delays, or re-fires the order. Automatic schedule changes are unsafe because another device may already have received and scheduled the original command.

Cancel references the same command ID and removes scheduled nodes where still possible. A late or expired command stays silent.

In shadow mode, Reliable records what it would have done while Classic remains the only audio authority. It can graduate only after its measured receipt rate and timing are clearly better without duplicates or regressions.

## Backup alerts candidate

Backup alerts are player opt-in and remain invisible unless the candidate survives testing.

If promoted, the player sees at most one simple action such as `Enable backup alerts`. Disabled Backup:

- does not block Fire;
- does not warn the commander;
- does not reduce the player's normal status;
- creates no repeated setup prompt.

Enabled Backup may show a neutral positive badge such as `Backup on`. It is never counted as exact voice receipt merely because a Push provider accepted a message.

### Platform-aware setup

- iOS/iPadOS: explain the Home Screen web-app requirement before requesting permission.
- Android: use runtime capability detection and a real notification test; installation may improve launch behavior but does not create permanent JavaScript execution.
- macOS and Windows: use supported browser notifications while acknowledging that whole-device sleep cannot deliver a live countdown.
- Unsupported or denied environments: exit cleanly and preserve Classic without nagging.

### Delivery behavior under test

A Push payload contains an immutable command ID, absolute event time, role, and short expiry. It uses a short TTL and high urgency appropriate to a transient visible alert. A stale alert must not appear after the rally moment.

The test compares immediate parallel Push with a short no-ACK delay. The option with the best balance of receipt rate, duplicate interruption, and remaining countdown time wins. Web Push supplies a system notification, not a custom spoken countdown; the web Notifications standard does not provide a portable custom-sound file field.

Where a service worker can report handling, that report is diagnostic. It does not prove that a human heard or read the notification.

## Battle Audio Stream candidate

Battle Audio Stream is a hidden, isolated experiment.

The hypothesis is that an explicit, continuously playing media stream may receive stronger background treatment than a page waiting for a future WebSocket event. The server would inject the selected player's spoken countdown into that player's media stream.

The experiment starts with the lowest-latency viable media approach. A second transport is tried only when the first produces a specific, fixable failure; the project does not accumulate a permanent matrix of streaming technologies.

It must be tested for:

- background survival while Kingshot is foreground;
- lock-screen survival;
- server-to-speaker latency and jitter;
- cross-device GO alignment;
- game audio-focus interruption or ducking;
- duplicate playback alongside Classic;
- data usage, battery use, and device heat;
- stream reconnection and stale-command suppression;
- commander audience silence.

The candidate is cut from a platform scope if that platform cannot maintain useful timing, if it interferes materially with game audio, if its resource cost is unreasonable, or if its background success is not clearly better than Classic. It may graduate only for capability groups that independently pass. The entire candidate is removed when keeping platform-specific branches costs more than the measured benefit.

During experiments, Classic remains the actual production audio. The stream code path is isolated so disabling or deleting it cannot change Classic scheduling.

## Cross-platform truth

### iOS and iPadOS

A Home Screen web app can receive Web Push on supported versions, but Push is a notification channel rather than a persistent page process. Media playback may continue in the background, yet page JavaScript and WebSocket delivery are not thereby guaranteed. Calls, audio-session interruptions, memory pressure, and operating-system process termination remain failure modes.

### Android

Audible media and real-time connections can reduce Chrome throttling, but hidden pages remain subject to operating-system and browser lifecycle decisions. Android Doze restricts ordinary background networking. A game may take audio focus; Android 12 and later can force an existing media app to fade or mute. A high-priority visible Push may wake a device, but the platform describes this as an attempt at immediate delivery, not a delivery SLA.

### macOS and Windows

Browser background tabs can sleep or be discarded, and an entire computer can sleep. Playing media may reduce tab sleeping but does not override extreme memory pressure or whole-system sleep. Push can be a useful notification fallback where supported, but not a precise custom-voice clock.

### Other browsers and devices

The product uses capability detection and observed test results rather than assuming support from a user-agent label. Unknown capability combinations remain on Classic and do not display a false readiness state.

## Player experience

The production page stays intentionally small:

- one identity-mode choice during first-time setup;
- the existing sound enablement and Test Sound;
- the existing personal countdown;
- an optional Backup button only if Push graduates;
- concise current status rather than an engineering dashboard.

The player is never asked to choose Classic, Reliable, Push, or Stream as abstract technologies.

## Commander experience

The commander keeps the existing selection and Fire workflow from the approved player-management design.

For selected captains, concise status may show:

- current live readiness;
- continuous observed duration, such as `Online 47m`;
- command result such as `Received ✓` or `Received 1/2`.

Backup being disabled is not a warning. If Backup graduates and is enabled, the commander may see only a neutral positive indicator. Fire remains permitted even when current live readiness is absent; the system reports risk but does not invent or move the command time.

## End-to-end self-test

The current immediate Test Sound remains useful for volume and initial audio unlock. It does not prove that a later server command can reach a background page.

The hidden validation experience therefore adds a server-driven test:

1. The test device arms a delayed QA command.
2. The user switches to Kingshot or locks the screen.
3. The server sends a new command at the promised time; it is not locally pre-scheduled as a shortcut.
4. Classic and candidate paths record their own receipt and scheduling events.
5. The tester records whether the expected physical sound or notification was actually observed.

Quick tests validate basic wiring. Longer 5-, 15-, 60-, and 180-minute tests measure survival. A past test is evidence with a timestamp, not a permanent guarantee.

## Multi-browser QA topology

Automated tests use isolated browser contexts so each has separate local storage, audio state, and `deviceId`.

The minimum simulated room contains:

- one commander-only browser;
- Captain A;
- Captain B;
- one ordinary member;
- a second device using Captain A's numeric Player ID;
- two separate browsers using the same test nickname;
- a commander browser that is also selected in a separate scenario.

The suite runs supported Playwright Chromium, Firefox, and WebKit projects where practical. Multiple tabs in one context are not a substitute for multiple devices because they share storage. Browser visibility simulation is useful for regression coverage but is not accepted as proof of real iOS or Android background survival.

Every production-connected run uses a newly generated `qa-kvk-*` room and random QA-only credentials. The harness must reject every non-QA room before any socket connection or HTTP mutation, without a room-name-specific exception or branch.

## Test matrix

### Functional regression

- 10-second lead begins at 10 for both roles.
- Main and Sacrifice use their own frozen timings.
- selected captain receives personal audio;
- unselected commander receives no rally audio;
- ordinary member receives one generic join alert;
- commander-selected-as-captain receives personal audio;
- duplicate command ID produces one countdown;
- Cancel removes future scheduled cues;
- expired commands remain silent;
- reconnect does not replay GO;
- room and player updates remain immediate across all contexts.

### Identity and roster

- Player ID remains the default and performs a correctly bound lookup;
- lookup results cannot race across inputs or modes;
- Nickname mode creates an opaque key and performs no official lookup;
- equal nicknames create separate players and do not share personal audio;
- equal numeric Player IDs on separate devices share the player and report device-level receipt;
- canonical march edits and removal follow the prior approved specification.

### Background and interruption

- foreground;
- background tab;
- switch into Kingshot;
- screen lock;
- low-power / battery-saver modes where available;
- Wi-Fi to cellular or offline/online transition;
- phone or audio interruption;
- Bluetooth route change;
- browser process restart;
- desktop tab sleeping / memory saver;
- whole-device sleep, recorded as unsupported for live timing rather than misreported as success.

### Candidate comparison

Each candidate is measured alone in the lab and in only the combinations that reflect a plausible production design. The test suite does not produce a public four-way mode picker.

Metrics include:

- command received and scheduled rate;
- acknowledgement latency distribution;
- intended versus observed cue and GO timing;
- cross-device timing spread;
- duplicate and stale alert rate;
- uninterrupted observed duration;
- reconnect recovery;
- Push notification handling and human-confirmed observation;
- data use, battery impact, heat, and game-audio interference;
- required user actions and setup abandonment.

## Promotion and cut rules

Classic remains default unless a candidate is clearly better on real devices.

A candidate may graduate only when:

- existing countdown behavior has no regression;
- target platforms within the proposed promotion scope show a material reliability improvement;
- timing is at least as accurate as Classic;
- duplicate and stale playback remain absent;
- the required player workflow stays simple;
- rollback is proven;
- privacy and operational cost are acceptable.

A candidate is removed when:

- improvement is small or inconsistent;
- one or more platforms inside the proposed promotion scope regress;
- it requires repeated permissions or confusing controls;
- it consumes disproportionate battery or data;
- it creates significant maintenance complexity;
- it cannot be tested honestly.

If more than one candidate graduates, each must have a distinct user benefit. Reliable internal metadata may remain invisible; optional Push may justify one player-facing button; a stream is exposed only if it independently solves a measured background failure.

## Rollback design

Rollback is layered but not user-facing clutter.

- Classic remains a separable audio authority.
- Reliable, Push, and Stream candidates have independent internal gates during testing.
- An operational server/client kill switch can stop a promoted candidate without changing room data.
- New protocol messages and fields are additive; Classic clients ignore them.
- No destructive state migration is required to disable a candidate.
- Cloudflare deployment version rollback remains a final operational fallback.

Shared correctness fixes are not rolled back:

- unselected commander silence;
- Player ID / nickname input correctness;
- canonical march-time behavior;
- truthful distinction between live readiness and command receipt.

## Error handling

- If candidate initialization throws or capability checks fail, Classic continues.
- Denied Push permission returns quietly to Classic and does not nag.
- Expired Push subscriptions are removed privately when the push service reports them invalid.
- A failed stream stops without replaying queued stale audio.
- Network recovery reloads current room truth and deduplicates by command ID.
- A late command never synthesizes an immediate stale GO.
- Missing acknowledgement reports `No confirmation`; it does not alter the order.
- A candidate cannot write a permanent success state solely from browser API state.

## Privacy and security

- Push subscriptions and device tokens are private server data, omitted from snapshots and logs.
- Logs use coarse platform labels and random device IDs rather than full fingerprinting.
- Delivery-test and command-ack history is bounded and expires automatically.
- VAPID private material remains a Cloudflare secret.
- Nicknames are treated as untrusted text and rendered safely.
- Device and command identifiers are validated, length-limited, and stored in prototype-safe structures.
- Existing room-password authorization remains required for commander mutations.
- Test rooms use random QA-only passwords and never reuse production credentials.

## Code-quality constraints

- Do not broadly rewrite the working countdown engine.
- Preserve the no-build deployment model unless a separately justified change is required.
- Put shared time and targeting rules in small testable functions rather than copying formulas between candidates.
- Isolate experimental transports from Classic scheduling.
- Keep public room state small; private delivery state has explicit expiry and bounds.
- Add schema/version normalization for additive fields.
- Remove failed experiment code instead of accumulating dead flags.
- Preserve unrelated user changes in the working tree.
- Run GitNexus impact analysis before editing every function, class, or method; warn before high- or critical-risk edits.
- Run GitNexus change detection before every implementation commit.

## Validation evidence required before any reliability claim

Desktop automation can prove routing, deduplication, state transitions, rollback, and timing calculations. It cannot prove that a physical iPhone or Android device will retain audio while Kingshot is foreground.

Therefore:

- no candidate is described as more reliable based only on headless tests;
- Playwright WebKit is not called an iOS device test;
- physical-device results record OS/browser, duration, visibility state, interruption scenario, command timestamps, ACK, and human-observed sound/notification;
- absence of available physical-device evidence means Classic stays default.

## Primary source basis

- Hidden pages can be frozen or discarded without a final observable event: [Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).
- Audible pages and WebRTC receive useful Chrome heuristics but remain discardable under extreme pressure: [Chrome background tabs](https://developer.chrome.com/blog/background_tabs).
- Web Push is an event-driven background notification mechanism with TTL and urgency, not a permanent page process: [RFC 8030](https://www.rfc-editor.org/info/rfc8030/) and [Web Push overview](https://web.dev/articles/push-notifications-overview).
- The Web Notifications standard has no portable custom audio-file option: [WHATWG Notifications](https://notifications.spec.whatwg.org/).
- iOS/iPadOS Web Push requires a Home Screen web app on supported releases: [Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
- Android Doze affects ordinary background networking and recommends FCM for real-time downstream messages: [Optimize for Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby).
- Android can force existing playback to fade or mute when another app obtains audio focus: [Manage audio focus](https://developer.android.com/media/optimize/audio-focus).
- High-priority FCM attempts immediate delivery but remains conditional and user-visible: [FCM message priority](https://firebase.google.com/docs/cloud-messaging/android-message-priority).
- Edge avoids sleeping useful audio/notification tabs heuristically but can still freeze under memory pressure: [SleepingTabsEnabled](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/sleepingtabsenabled).
- The existing Cloudflare architecture supports hibernatable room WebSockets and standard Web Push without using an operation room as a test target: [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) and [Cloudflare Push notifications](https://developers.cloudflare.com/agents/communication-channels/webhooks/push-notifications/).

## Acceptance criteria

The design is successfully implemented only when all of the following are true:

1. Current Classic countdown behavior remains the production default until evidence promotes a candidate.
2. Lead selection and personal countdown timing have regression tests and remain exact.
3. An unselected commander device is silent; a selected commander receives personal audio.
4. Player ID is recommended and nickname testing creates a browser-local independent identity.
5. Canonical march updates and removal remain consistent with the prior approved design.
6. Green `Received` requires an exact command acknowledgement and successful cue scheduling.
7. Disabled Backup produces no commander warning and no player nagging.
8. Candidates are invisible to ordinary users until promoted by evidence.
9. Failed candidates are removed.
10. Classic rollback is tested and does not restore known audience or identity bugs.
11. Automated multi-browser tests use isolated `qa-kvk-*` rooms and hard-fail on every non-QA room.
12. No claim of superior mobile background reliability is made without physical-device evidence.
